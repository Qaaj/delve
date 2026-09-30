#!/usr/bin/env node
/**
 * One-time backfill: re-fetches every already-imported email (by Message-ID,
 * across whichever mailboxes it's labeled under) to extract the header
 * fields added 2026-09-29 that scripts/import.js didn't originally capture —
 * threading (In-Reply-To/References), List-Unsubscribe, List-Id, Reply-To,
 * and Importance/X-Priority. See db/schema.sql's headers_backfilled_at
 * comment for why that column (not just NULL fields) tracks "already checked".
 *
 * Driven by emails.headers_backfilled_at rather than an IMAP UID watermark —
 * same reasoning as import-attachments.js: this is "everything in Postgres
 * still missing this data", not "everything new in a mailbox", so it's safe
 * to just re-run anytime and it resumes wherever it left off.
 *
 * Deliberately reuses lib/emailImport.js's fetchAndInsertChunk unchanged
 * rather than writing custom update logic: insertEmail()'s ON CONFLICT
 * clause already fills in these new columns via COALESCE without disturbing
 * anything else on rows that already exist, so "re-import" and "backfill
 * headers onto an existing row" are the same operation as far as that
 * function is concerned.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const db = require('../lib/db');
const { createEmailImporter, ENVELOPE_SCAN_CHUNK } = require('../lib/emailImport');

const HOST   = process.env.IMAP_HOST || '127.0.0.1';
const PORT   = parseInt(process.env.IMAP_PORT || '1143', 10);
const SECURE = /^true$/i.test(process.env.IMAP_SECURE || 'false');
const USER   = process.env.IMAP_USER;
const PASS   = process.env.IMAP_PASSWORD;

const CHUNK_SIZE   = parseInt(process.env.IMPORT_CHUNK_SIZE || '150', 10);
const MAX_ATTEMPTS = parseInt(process.env.IMPORT_MAX_ATTEMPTS || '5', 10);
const PROGRESS_EVERY = parseInt(process.env.BACKFILL_PROGRESS_EVERY || '200', 10);

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `backfill-headers-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const { scanEnvelopeRange, fetchAndInsertChunk } = createEmailImporter({ log });

// ─── Progress tracking ───────────────────────────────────────────────────────
// Same "rolling window rate, not lifetime cumulative average" fix applied to
// scripts/categorize.js after the cumulative rate was caught looking
// misleadingly frozen (e.g. stuck at "0.2/s" despite real per-item timing
// varying a lot) — track a window that resets every PROGRESS_EVERY items
// alongside the overall total, and log both.

function createProgress(totalPending) {
  const startedAt = Date.now();
  let windowStartedAt = startedAt;
  let processed = 0;
  let windowProcessed = 0;

  return {
    add(n) {
      processed += n;
      windowProcessed += n;
      if (windowProcessed >= PROGRESS_EVERY) {
        const now = Date.now();
        const overallRate = processed / ((now - startedAt) / 1000);
        const windowRate = windowProcessed / ((now - windowStartedAt) / 1000);
        const remaining = Math.max(totalPending - processed, 0);
        const etaMin = windowRate > 0 ? (remaining / windowRate / 60).toFixed(1) : '?';
        log(`  progress: ${processed}/${totalPending} backfilled ` +
          `(recent ${windowRate.toFixed(2)}/s, overall ${overallRate.toFixed(2)}/s, ETA ~${etaMin}m)`);
        windowStartedAt = now;
        windowProcessed = 0;
      }
    },
  };
}

// ─── DB access ───────────────────────────────────────────────────────────────

async function getPendingEmails() {
  const { rows } = await db.query(`
    SELECT id, message_id, labels FROM emails WHERE headers_backfilled_at IS NULL
  `);
  return rows;
}

// ─── Per-mailbox processing ───────────────────────────────────────────────────
// Same shape as import-attachments.js's processMailbox: scan the whole
// mailbox's envelopes looking for our specific pending Message-IDs, then
// full-fetch+insert only the matches — via the shared, ghost-tolerant
// fetchAndInsertChunk, so this gets the same resilience as every other
// import path for free.

async function processMailbox(client, mailboxPath, pendingByMessageId, progress) {
  if (pendingByMessageId.size === 0) return { seen: 0, inserted: 0, labeled: 0, skipped: 0, failed: 0 };

  const lock = await client.getMailboxLock(mailboxPath);
  const stats = { seen: 0, inserted: 0, labeled: 0, skipped: 0, failed: 0 };

  try {
    const mailbox = client.mailbox;
    if (!mailbox.exists || mailbox.exists === 0) return stats;

    const uidNext = mailbox.uidNext || (mailbox.exists + 1);
    const toFetch = new Map(); // uid -> { messageId, pmInternalId } for candidates found in THIS mailbox
    for (let start = 1; start < uidNext; start += ENVELOPE_SCAN_CHUNK) {
      const end = Math.min(start + ENVELOPE_SCAN_CHUNK - 1, uidNext - 1);
      const { envelopes } = await scanEnvelopeRange(client, mailboxPath, start, end);
      for (const e of envelopes) {
        if (e.messageId && pendingByMessageId.has(e.messageId)) {
          toFetch.set(e.uid, { messageId: e.messageId, pmInternalId: e.pmInternalId });
        }
      }
    }

    if (toFetch.size === 0) {
      log(`  [${mailboxPath}] none of the pending messages found here`);
      return stats;
    }
    log(`  [${mailboxPath}] found ${toFetch.size} pending message(s) here`);
    stats.seen = toFetch.size;

    const succeededUids = new Set();
    const failedUids = new Set();
    const toFetchUids = [...toFetch.keys()];
    for (let i = 0; i < toFetchUids.length; i += CHUNK_SIZE) {
      const chunk = toFetchUids.slice(i, i + CHUNK_SIZE);
      await fetchAndInsertChunk(client, mailboxPath, mailbox.uidValidity, chunk, toFetch, stats, succeededUids, failedUids);
      progress.add(chunk.length);
    }

    // Whichever of THIS mailbox's candidates actually resolved don't need
    // checking again under a different label — mutates the shared pending
    // set so later mailboxes in this same run skip them too.
    for (const uid of succeededUids) {
      const messageId = toFetch.get(uid)?.messageId;
      if (messageId) pendingByMessageId.delete(messageId);
    }
  } finally {
    lock.release();
  }

  return stats;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runOnce() {
  if (!USER || !PASS) {
    throw new Error('IMAP_USER / IMAP_PASSWORD are not set.');
  }

  const pending = await getPendingEmails();
  if (pending.length === 0) {
    log('nothing pending — every email already has its headers backfilled');
    return { seen: 0, inserted: 0, labeled: 0, skipped: 0, failed: 0 };
  }
  log(`${pending.length} email(s) still need header backfill`);

  const byMailbox = new Map(); // mailbox path -> the shared pending map
  const globalPending = new Map(); // messageId -> id, mutated as mailboxes resolve candidates
  for (const row of pending) {
    globalPending.set(row.message_id, row.id);
    for (const label of row.labels || []) {
      if (!byMailbox.has(label)) byMailbox.set(label, globalPending);
    }
  }

  const client = new ImapFlow({
    host: HOST, port: PORT, secure: SECURE,
    auth: { user: USER, pass: PASS },
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });

  await client.connect();
  log(`connected to ${HOST}:${PORT} as ${USER}`);

  const progress = createProgress(pending.length);
  const totals = { seen: 0, inserted: 0, labeled: 0, skipped: 0, failed: 0 };
  for (const mailboxPath of byMailbox.keys()) {
    if (globalPending.size === 0) break; // everything found already
    log(`processing "${mailboxPath}"...`);
    try {
      const stats = await processMailbox(client, mailboxPath, globalPending, progress);
      for (const k of Object.keys(totals)) totals[k] += stats[k];
    } catch (err) {
      log(`  [${mailboxPath}] mailbox-level failure: ${err.message} — skipping to next mailbox`);
    }
  }

  await client.logout();

  if (globalPending.size > 0) {
    log(`${globalPending.size} pending message(s) were not found in any of their recorded mailboxes (moved/deleted since import?) — left pending for a future run`);
  }

  // "labeled" here really means "backfilled" (every one of these rows
  // already existed — see this file's header comment) — renamed only in
  // the summary line, not the shared stats object, to avoid touching
  // fetchAndInsertChunk's field names used elsewhere.
  log(`logged out. TOTAL: checked=${totals.seen} backfilled=${totals.labeled} failed=${totals.failed}`);
  return totals;
}

async function main() {
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      await runOnce();
      break;
    } catch (err) {
      log(`run failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`);
      if (attempt >= MAX_ATTEMPTS) {
        log('giving up — re-run later; already-backfilled rows are preserved.');
        process.exitCode = 1;
        break;
      }
      const backoff = Math.min(60_000, 5000 * attempt);
      log(`retrying in ${Math.round(backoff / 1000)}s...`);
      await sleep(backoff);
    }
  }
  await db.end();
  logStream.end();
}

main();
