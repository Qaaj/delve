#!/usr/bin/env node
/**
 * Stateless safety-net sync: re-checks the last CATCHUP_WINDOW messages (by
 * position, default 1000) in every mailbox and imports whatever isn't
 * already in Postgres by Message-ID. No UID watermark, no import_state row,
 * nothing persisted about "where it left off" — every run just looks at the
 * current tail again from scratch.
 *
 * Why this exists alongside scripts/import.js's incremental UID-watermark
 * approach, not instead of it: confirmed 2026-09-29 that this Bridge
 * instance's UID-to-content mapping can shift without a UIDVALIDITY change
 * (which the IMAP spec says should never happen) — the same UID number
 * pointed at different message content minutes apart, on the same
 * connection. A watermark that trusts "I've already handled everything up to
 * UID N" is vulnerable to exactly that: if N briefly pointed at the wrong
 * message when the watermark advanced, whatever N *should* have been never
 * gets looked at again. This script has no such blind spot — it always
 * re-examines the same tail window and decides purely from what's actually
 * in Postgres right now (by Message-ID, not by trusting any UID persists
 * meaning across runs), so a shift like that gets caught on the very next
 * run regardless of what any watermark believes.
 *
 * The trade-off is exactly why this ISN'T the primary importer: re-scanning
 * a fixed window every run is fine for "did we miss anything recent" at an
 * hourly/daily/weekly cadence, but re-scanning the ENTIRE 20-year archive
 * this way on every run would be wasteful — that's what the UID watermark in
 * import.js is for. Belt and suspenders: import.js efficiently covers the
 * bulk case, this covers the "what if the belt slipped" case for recent mail.
 *
 * Shares envelope-scanning with import.js via lib/emailImport.js, and both
 * scripts' ghost UIDs live in the same ghost_uids table — but this script
 * uses a deliberately LOOSER fetch/insert path (recoverByContent, not
 * fetchAndInsertChunk) and NEVER gives up on a ghost (triageGhostUids'
 * neverExpire option), for two related reasons confirmed 2026-09-29:
 *
 *  1. A ghost UID outside the CATCHUP_WINDOW at the time it first ghosted
 *     would otherwise never get looked at again as the window slides forward
 *     with uidNext — so every mailbox is ALSO explicitly re-checked against
 *     its own backlog of previously-recorded ghost_uids rows each run
 *     (capped by GHOST_RETRY_BATCH_LIMIT), not just the current window.
 *
 *  2. Even a FRESH envelope scan's "this UID should be message X" can
 *     disagree with what a SEPARATE full-source fetch for that same UID
 *     actually returns — verified directly: a single-UID fetch for UID N
 *     came back honestly labeled as UID N+1's content, and a small batch
 *     fetch silently dropped one requested UID while substituting an
 *     entirely unrequested one. This is a live Bridge/gluon protocol bug for
 *     certain UIDs (SEARCH confirms the UID exists; every FETCH variant for
 *     it — flags, bodystructure, envelope, source — returns a NEIGHBOR's
 *     data instead), not something any client-side retry strategy or request
 *     shape can route around. So recoverByContent doesn't try to verify a
 *     response against a pre-scanned expectation at all: it just inserts
 *     whatever real message_id comes back that isn't already in Postgres,
 *     gated purely on that fact — same principle as this whole script, just
 *     applied per-fetch-response too. Safe here specifically because nothing
 *     is stateful: import.js keeps fetchAndInsertChunk's stricter
 *     expected-identity correlation, because ITS watermark can't safely
 *     trust an unverified response the way this script can.
 *
 * Never giving up means a UID stuck on Bridge's side (like the one above)
 * just gets silently retried forever at near-zero cost until Bridge's own
 * state changes — no permanent "we tried, giving up" data loss, ever.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const db = require('../lib/db');
const {
  findExistingMessageIds,
  appendLabelToExisting,
  triageGhostUids,
  GHOST_RETRY_WINDOW_MS,
  ENVELOPE_SCAN_CHUNK,
  createEmailImporter,
} = require('../lib/emailImport');

const HOST   = process.env.IMAP_HOST || '127.0.0.1';
const PORT   = parseInt(process.env.IMAP_PORT || '1143', 10);
const SECURE = /^true$/i.test(process.env.IMAP_SECURE || 'false');
const USER   = process.env.IMAP_USER;
const PASS   = process.env.IMAP_PASSWORD;

const MAX_ATTEMPTS = parseInt(process.env.IMPORT_MAX_ATTEMPTS || '5', 10);
// How far back (by position, not date) each mailbox's tail gets re-checked
// every run. 1000 comfortably covers "how much mail could plausibly have
// arrived since the last catch-up run" for any hourly/daily/weekly cadence
// without re-scanning whole mailboxes.
const CATCHUP_WINDOW = parseInt(process.env.CATCHUP_WINDOW || '1000', 10);
// A ghost UID outside this run's window would otherwise sit in ghost_uids
// forever — shouldGiveUpOnGhost/triageGhostUids only ever run on a UID that
// gets re-attempted, and the window slides forward as uidNext grows, so
// anything that fell behind it was never being re-attempted at all (neither
// resolving nor expiring). Capped per run/mailbox so a large backlog (e.g.
// Proton's virtual "All Mail" folder, whose UID space spans the entire
// mailbox) can't blow out one 5-minute sync cycle — it just works through
// the backlog gradually across runs instead.
const GHOST_RETRY_BATCH_LIMIT = parseInt(process.env.GHOST_RETRY_BATCH_LIMIT || '300', 10);

const EXCLUDE_MAILBOXES = (process.env.IMPORT_EXCLUDE_MAILBOXES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `catchup-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const { scanEnvelopeRange, recoverByContent } = createEmailImporter({ log });

// ─── Per-mailbox catch-up ────────────────────────────────────────────────────

async function catchUpMailbox(client, mailboxPath) {
  const lock = await client.getMailboxLock(mailboxPath);
  const stats = { seen: 0, inserted: 0, labeled: 0, skipped: 0, failed: 0 };

  try {
    const mailbox = client.mailbox;
    if (!mailbox.exists || mailbox.exists === 0) {
      log(`  [${mailboxPath}] empty, nothing to do`);
      return stats;
    }

    const rangeEnd = mailbox.uidNext - 1;
    const rangeStart = Math.max(1, rangeEnd - CATCHUP_WINDOW + 1);
    if (rangeStart > rangeEnd) {
      log(`  [${mailboxPath}] nothing in range`);
      return stats;
    }

    // Same chunked, ghost-tolerant envelope scan import.js uses — ghosts here
    // just mean "still can't read this one right now", tracked in the same
    // ghost_uids table/retry window either script would use.
    const envelopes = [];
    const ghostUids = [];
    for (let chunkStart = rangeStart; chunkStart <= rangeEnd; chunkStart += ENVELOPE_SCAN_CHUNK) {
      const chunkEnd = Math.min(chunkStart + ENVELOPE_SCAN_CHUNK - 1, rangeEnd);
      const result = await scanEnvelopeRange(client, mailboxPath, chunkStart, chunkEnd);
      envelopes.push(...result.envelopes);
      ghostUids.push(...result.ghostUids);
      // unresolvedRanges deliberately ignored — this script has nothing to
      // "not advance", it just tries again in full next run regardless.
    }

    stats.seen = envelopes.length;

    const { pending: pendingGhostUids } = await triageGhostUids(mailboxPath, mailbox.uidValidity, ghostUids, envelopes.map(e => e.uid), { neverExpire: true });
    if (pendingGhostUids.length) {
      log(`  [${mailboxPath}] ${pendingGhostUids.length} ghost UID(s) in this window, will naturally retry next catch-up run: ${pendingGhostUids.join(', ')}`);
    }

    // Ghosts that fell OUTSIDE this run's window (rangeStart moved past them
    // as uidNext grew) never get touched by the scan above at all — retry
    // them explicitly here, or they're stuck forever. Goes straight through
    // recoverByContent (see its comment for why) rather than re-scanning
    // envelopes first — no separate "expected identity" to establish.
    const { rows: orphanedGhostRows } = await db.query(
      `SELECT uid FROM ghost_uids WHERE mailbox = $1 AND uid_validity = $2 AND (uid < $3 OR uid > $4)
       ORDER BY first_seen_at ASC LIMIT $5`,
      [mailboxPath, String(mailbox.uidValidity), rangeStart, rangeEnd, GHOST_RETRY_BATCH_LIMIT]
    );
    const orphanedUids = orphanedGhostRows.map(r => r.uid);
    if (orphanedUids.length > 0) {
      log(`  [${mailboxPath}] retrying ${orphanedUids.length} ghost UID(s) that previously fell outside this run's window...`);
      const recovery = await recoverByContent(client, mailboxPath, orphanedUids);
      stats.inserted += recovery.inserted;
      stats.labeled += recovery.labeled;
      stats.failed += recovery.failed;
      const { pending: stillPending } = await triageGhostUids(mailboxPath, mailbox.uidValidity, recovery.stillGhost, [], { neverExpire: true });
      const resolvedCount = orphanedUids.length - recovery.stillGhost.length;
      if (resolvedCount) log(`  [${mailboxPath}] ${resolvedCount} orphaned ghost(s) resolved on retry`);
      if (stillPending.length) log(`  [${mailboxPath}] ${stillPending.length} orphaned ghost(s) still unresolved, will retry again next run`);
    }

    if (envelopes.length === 0) {
      log(`  [${mailboxPath}] nothing in range (UIDs ${rangeStart}-${rangeEnd})${ghostUids.length ? `, ${ghostUids.length} ghost(s)` : ''}`);
      return stats;
    }

    // The only gate that matters here: is this Message-ID already in
    // Postgres? Not a date comparison — dates on real-world mail can be
    // missing/wrong/spoofed (see lib/parseDate.js's whole reason for
    // existing), while "do we already have this exact message" is a simple,
    // robust fact. This naturally covers "import anything newer than what we
    // have" without ever trusting a date to decide what to skip.
    const knownIds = new Set();
    for (const e of envelopes) if (e.messageId) knownIds.add(e.messageId);
    const existing = await findExistingMessageIds([...knownIds]);

    const toFetchUids = [];
    const labelOnlyEntries = [];

    for (const e of envelopes) {
      if (e.messageId && existing.has(e.messageId)) {
        labelOnlyEntries.push({ messageId: e.messageId, pmInternalId: e.pmInternalId });
      } else {
        toFetchUids.push(e.uid);
      }
    }

    if (labelOnlyEntries.length > 0) {
      try {
        await appendLabelToExisting(labelOnlyEntries, mailboxPath);
        stats.labeled += labelOnlyEntries.length;
      } catch (err) {
        log(`  [${mailboxPath}] label-append failed: ${err.message}`);
      }
    }

    if (toFetchUids.length > 0) {
      log(`  [${mailboxPath}] ${toFetchUids.length} message(s) in the last ${CATCHUP_WINDOW} not yet in Postgres — fetching`);
      // recoverByContent, not the stricter fetchAndInsertChunk: confirmed
      // 2026-09-29 that even a fresh envelope scan's own "this UID should be
      // message X" can disagree with what a SEPARATE full-source fetch call
      // for the same UID actually returns (Bridge's own cross-call
      // consistency issue, not a stale-watermark one) — verifying against
      // that expectation was producing false-negative "ghosts" for mail that
      // was genuinely, easily fetchable a different way. Safe to skip that
      // verification here specifically because this script is stateless.
      const recovery = await recoverByContent(client, mailboxPath, toFetchUids);
      stats.inserted += recovery.inserted;
      stats.labeled += recovery.labeled;
      stats.failed += recovery.failed;
      if (recovery.stillGhost.length) {
        const { pending } = await triageGhostUids(mailboxPath, mailbox.uidValidity, recovery.stillGhost, [], { neverExpire: true });
        log(`  [${mailboxPath}] ${pending.length} of this window's candidate(s) still unresolved, will retry next run: ${recovery.stillGhost.join(', ')}`);
      }
    }

    log(`  [${mailboxPath}] done — checked ${envelopes.length}, inserted ${stats.inserted}, labeled ${stats.labeled}, failed ${stats.failed}`);
  } finally {
    lock.release();
  }

  return stats;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runOnce() {
  if (!USER || !PASS) {
    throw new Error('IMAP_USER / IMAP_PASSWORD are not set — copy .env.example to .env and fill in your Proton Bridge credentials.');
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
  log(`connected to ${HOST}:${PORT} as ${USER}, checking last ${CATCHUP_WINDOW} message(s) per mailbox`);

  const mailboxes = [];
  const list = await client.list();
  for (const mbox of list) {
    if (mbox.flags?.has('\\Noselect')) continue;
    if (EXCLUDE_MAILBOXES.includes(mbox.path)) continue;
    mailboxes.push(mbox.path);
  }
  log(`found ${mailboxes.length} mailbox(es): ${mailboxes.join(', ')}`);

  const totals = { seen: 0, inserted: 0, labeled: 0, skipped: 0, failed: 0 };
  for (const mailboxPath of mailboxes) {
    log(`processing "${mailboxPath}"...`);
    try {
      const stats = await catchUpMailbox(client, mailboxPath);
      for (const k of Object.keys(totals)) totals[k] += stats[k];
    } catch (err) {
      log(`  [${mailboxPath}] mailbox-level failure: ${err.message} — skipping to next mailbox`);
    }
  }

  await client.logout();
  log(`logged out. TOTAL: seen=${totals.seen} inserted=${totals.inserted} labeled=${totals.labeled} skipped=${totals.skipped} failed=${totals.failed}`);
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
        log('giving up — re-run this script later; already-imported mail is preserved (nothing here is stateful anyway).');
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
