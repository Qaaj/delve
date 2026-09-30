#!/usr/bin/env node
/**
 * Standalone categorization job — deliberately NOT wired into server.js's
 * auto-sync. Run it by hand (`npm run categorize`) whenever you want to
 * (re-)categorize whatever's pending; it's independent of the IMAP
 * import/sync process and only touches Postgres + the LM Studio server.
 *
 * Resumable the same way scripts/import-attachments.js is: driven by a
 * "what's still pending" column (categorized_at / categorize_version) rather
 * than its own progress cursor, so Ctrl+C at any point loses nothing —
 * a row's columns are only written after that row's LM Studio calls succeed,
 * and re-running just picks up wherever it left off.
 *
 * Requires LM Studio's local server running (Developer tab -> Start Server)
 * with the configured model already loaded — see lib/categorize.js.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const {
  CATEGORY_VERSION,
  LMSTUDIO_URL,
  LMSTUDIO_MODEL,
  categorizeEmail,
} = require('../lib/categorize');

// Default is 0 ("no concurrency" — fully serial), not higher, because
// concurrency measurably hurt in earlier testing on this setup: 1 worker ran
// at ~1090ms/email, 3 workers at ~1429ms/email, and 8 failed outright (0/8,
// llama.cpp decode errors — almost certainly more concurrent requests than
// LM Studio's "Max Concurrent Predictions" slot count for however the model
// was loaded, see the CONCURRENCY>1 note further down). 0 and 1 run
// identically (both fully serial) — 0 is just the more honest label for the
// default, since "1" implies a pool that happens to have one slot, not "no
// concurrency by design." Configurable via CATEGORIZE_CONCURRENCY; only go
// above 1 after confirming LM Studio's Max Concurrent Predictions is set
// high enough for whatever you pass here — see lmstudio.ai/docs/app/advanced/parallel-requests.
const CONCURRENCY   = parseInt(process.env.CATEGORIZE_CONCURRENCY || '0', 10);
const MAX_ATTEMPTS   = parseInt(process.env.CATEGORIZE_MAX_ATTEMPTS || '3', 10);
const PROGRESS_EVERY = parseInt(process.env.CATEGORIZE_PROGRESS_EVERY || '200', 10);
// Caps how many pending rows this run picks up — handy for a quick test
// batch (CATEGORIZE_LIMIT=200 npm run categorize) before letting it loose on
// the whole mailbox. Unset/0 means no cap.
const LIMIT = parseInt(process.env.CATEGORIZE_LIMIT || '0', 10);
// "id" (default) processes in import order, oldest first. "latest" processes
// newest-by-email_date first — useful for a real-but-bounded first batch
// (CATEGORIZE_ORDER=latest CATEGORIZE_LIMIT=500) that covers the mail
// you'll actually look at soonest, rather than starting from 20-year-old
// backlog.
const ORDER = process.env.CATEGORIZE_ORDER === 'latest' ? 'latest' : 'id';

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `categorize-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─── LM Studio reachability check ─────────────────────────────────────────────

async function checkLmStudio() {
  let res;
  try {
    res = await fetch(`${LMSTUDIO_URL}/v1/models`);
  } catch (err) {
    throw new Error(`can't reach LM Studio at ${LMSTUDIO_URL} (${err.message}) — is its local server running (Developer tab -> Start Server)?`);
  }
  if (!res.ok) throw new Error(`LM Studio at ${LMSTUDIO_URL} returned ${res.status} for /v1/models`);

  let names = [];
  try {
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.models || body.data || []);
    names = list.map(m => (typeof m === 'string' ? m : m.name || m.model || m.id)).filter(Boolean);
  } catch {
    // Unexpected shape — not worth failing the run over, just skip the check.
    return;
  }
  if (names.length && !names.includes(LMSTUDIO_MODEL)) {
    log(`WARNING: model "${LMSTUDIO_MODEL}" not found in LM Studio's loaded models (${names.join(', ')}). Load it in LM Studio first if calls start failing.`);
  }
}

// ─── DB access ───────────────────────────────────────────────────────────────

async function getPendingIds() {
  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : '';
  const orderClause = ORDER === 'latest' ? 'email_date DESC NULLS LAST' : 'id';
  const { rows } = await db.query(`
    SELECT id FROM emails
    WHERE categorized_at IS NULL OR categorize_version IS DISTINCT FROM $1
    ORDER BY ${orderClause}
    ${limitClause}
  `, [CATEGORY_VERSION]);
  return rows.map(r => r.id);
}

async function getEmail(id) {
  const { rows } = await db.query(`
    SELECT id, subject, from_address, from_name, body_text, body_html, attachments
    FROM emails WHERE id = $1
  `, [id]);
  return rows[0];
}

async function saveResult(id, result) {
  await db.query(`
    UPDATE emails SET
      domain = $1, domain_confidence = $2,
      subcategory = $3, subcategory_confidence = $4,
      is_automated = $5,
      unsubscribe_candidate = $6, attachment_worth_keeping = $7,
      summary = $8,
      amount = $9, currency = $10, reference_number = $11,
      company = $12, secondary_domains = $13,
      categorize_version = $14, categorized_at = NOW()
    WHERE id = $15
  `, [
    result.domain, result.domainConfidence,
    result.subcategory, result.subcategoryConfidence,
    result.isAutomated,
    result.unsubscribeCandidate, result.attachmentWorthKeeping,
    result.summary,
    result.amount, result.currency, result.referenceNumber,
    result.company, result.secondaryDomains,
    result.categorizeVersion, id,
  ]);
}

// ─── Worker pool ─────────────────────────────────────────────────────────────

async function runWithConcurrency(items, limit, worker) {
  // 0 (or any value <1) means "no concurrency" — one real serial worker, not
  // zero workers. Math.min(0, items.length) would silently process nothing.
  const workerCount = Math.min(Math.max(limit, 1), items.length);
  let idx = 0;
  const runners = new Array(workerCount).fill(0).map(async () => {
    while (idx < items.length) {
      const item = items[idx++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function processOne(id, stats, total) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const email = await getEmail(id);
      if (!email) return; // deleted since the id list was fetched
      const result = await categorizeEmail(email);
      await saveResult(id, result);
      stats.succeeded++;
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt);
    }
  }
  stats.failed++;
  log(`  id=${id} failed after ${MAX_ATTEMPTS} attempts: ${lastErr.message} — left pending for next run`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`LM Studio at ${LMSTUDIO_URL}, model "${LMSTUDIO_MODEL}", taxonomy version ${CATEGORY_VERSION}, concurrency ${CONCURRENCY}, order ${ORDER}${LIMIT > 0 ? `, limit ${LIMIT}` : ''}`);
  await checkLmStudio();

  const ids = await getPendingIds();
  if (ids.length === 0) {
    log('nothing pending — every email already categorized at the current taxonomy version');
    await db.end();
    logStream.end();
    return;
  }
  log(`${ids.length} email(s) need categorization`);

  const stats = { succeeded: 0, failed: 0 };
  const startedAt = Date.now();
  let processed = 0;
  // Tracked separately from startedAt so the logged rate reflects recent
  // throughput, not a cumulative average since job start — a cumulative
  // average barely moves once thousands of rows are in, which made the
  // progress log look like a suspiciously fixed rate even when the real
  // per-email time was genuinely varying (confirmed: 41.5-50.7s per 10 rows
  // in one real run, despite the displayed rate showing "0.2/s" the whole time).
  let windowStartedAt = startedAt;
  let windowProcessed = 0;

  await runWithConcurrency(ids, CONCURRENCY, async (id) => {
    await processOne(id, stats, ids.length);
    processed++;
    windowProcessed++;
    if (processed % PROGRESS_EVERY === 0 || processed === ids.length) {
      const now = Date.now();
      const windowRate = windowProcessed / ((now - windowStartedAt) / 1000);
      const overallRate = processed / ((now - startedAt) / 1000);
      const remaining = ids.length - processed;
      const etaS = windowRate > 0 ? Math.round(remaining / windowRate) : 0;
      log(`progress: ${processed}/${ids.length} (${stats.succeeded} ok, ${stats.failed} failed) — ${windowRate.toFixed(2)}/s recent (${overallRate.toFixed(2)}/s overall), ETA ${etaS}s`);
      windowStartedAt = now;
      windowProcessed = 0;
    }
  });

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`TOTAL: succeeded=${stats.succeeded} failed=${stats.failed} elapsed=${elapsedS}s`);

  await db.end();
  logStream.end();
}

main().catch(async (err) => {
  log(`fatal: ${err.message}`);
  process.exitCode = 1;
  await db.end();
  logStream.end();
});
