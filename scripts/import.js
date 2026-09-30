#!/usr/bin/env node
/**
 * Bulk-imports every email from every Proton Bridge mailbox (Inbox, Sent,
 * Archive, Trash, Spam, custom folders/labels — whatever Bridge exposes over
 * IMAP) into Postgres.
 *
 * Approach, per mailbox:
 *   1. Cheap envelope-only fetch (UID + Message-ID, no body) for every UID
 *      above this mailbox's last_seen_uid (tracked in import_state).
 *   2. Message-IDs already in the `emails` table just get this mailbox name
 *      appended to their `labels` array (a message can carry several Proton
 *      labels/folders and IMAP surfaces each as a separate mailbox).
 *   3. Message-IDs not seen before get a full source fetch + parse + insert.
 *
 * This means the (expensive) full-body fetch happens once per unique email
 * no matter how many folders/labels it appears under.
 *
 * Resumable: last_seen_uid only advances for a mailbox once every UID in
 * that run's range was successfully accounted for (inserted, or already
 * present). If anything fails, the watermark stays put and the whole range
 * is cheaply re-checked (envelope-only) on the next run.
 *
 * The actual scan/fetch/insert/ghost-retry machinery lives in
 * lib/emailImport.js, shared with scripts/catchup-recent.js — see that
 * file's header for why a pure UID-watermark approach turned out not to be
 * fully trustworthy on this Bridge instance (confirmed 2026-09-29: the
 * UID-to-content mapping can shift without a UIDVALIDITY change).
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

const CHUNK_SIZE   = parseInt(process.env.IMPORT_CHUNK_SIZE || '150', 10);
const MAX_ATTEMPTS = parseInt(process.env.IMPORT_MAX_ATTEMPTS || '5', 10);

const EXCLUDE_MAILBOXES = (process.env.IMPORT_EXCLUDE_MAILBOXES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── Logging (console + a timestamped file under logs/) ────────────────────

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `import-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const { scanEnvelopeRange, fetchAndInsertChunk } = createEmailImporter({ log });

// ─── Import-state (per-mailbox UID watermark) ───────────────────────────────

async function getImportState(mailbox) {
  const { rows } = await db.query('SELECT * FROM import_state WHERE mailbox = $1', [mailbox]);
  return rows[0] || { mailbox, uid_validity: null, last_seen_uid: 0 };
}

async function setImportState(mailbox, { uidValidity, lastSeenUid }) {
  await db.query(`
    INSERT INTO import_state (mailbox, uid_validity, last_seen_uid, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (mailbox) DO UPDATE SET
      uid_validity  = EXCLUDED.uid_validity,
      last_seen_uid = EXCLUDED.last_seen_uid,
      updated_at    = NOW()
  `, [mailbox, String(uidValidity), lastSeenUid]);
}

// ─── Per-mailbox processing ───────────────────────────────────────────────────

async function processMailbox(client, mailboxPath) {
  const state = await getImportState(mailboxPath);
  const lock = await client.getMailboxLock(mailboxPath);
  const stats = { seen: 0, inserted: 0, labeled: 0, skipped: 0, failed: 0 };

  try {
    const mailbox = client.mailbox;
    const uidValidityChanged = state.uid_validity && String(mailbox.uidValidity) !== state.uid_validity;
    const startUid = uidValidityChanged ? 1 : (state.last_seen_uid || 0) + 1;

    if (uidValidityChanged) {
      log(`  [${mailboxPath}] UIDVALIDITY changed — re-scanning from UID 1`);
    }

    if (!mailbox.exists || mailbox.exists === 0) {
      log(`  [${mailboxPath}] empty, nothing to do`);
      await setImportState(mailboxPath, { uidValidity: mailbox.uidValidity, lastSeenUid: state.last_seen_uid || 0 });
      return stats;
    }

    // Bridge responds BAD "no such message" for `FETCH startUid:*` when
    // startUid is past the highest UID that actually exists — i.e. exactly
    // the fully-caught-up case, which should be a normal "nothing new", not
    // an error. uidNext is guaranteed to exceed every assigned UID, so this
    // check avoids ever sending that fetch when there's genuinely nothing to see.
    if (startUid >= mailbox.uidNext) {
      log(`  [${mailboxPath}] nothing new`);
      await setImportState(mailboxPath, { uidValidity: mailbox.uidValidity, lastSeenUid: state.last_seen_uid || 0 });
      return stats;
    }

    // Phase 1: cheap envelope-only fetch to see what's new, chunked + resilient.
    const scanEnd = mailbox.uidNext - 1;
    const envelopes = [];
    const ghostUids = [];
    const unresolvedRanges = [];
    for (let chunkStart = startUid; chunkStart <= scanEnd; chunkStart += ENVELOPE_SCAN_CHUNK) {
      const chunkEnd = Math.min(chunkStart + ENVELOPE_SCAN_CHUNK - 1, scanEnd);
      const result = await scanEnvelopeRange(client, mailboxPath, chunkStart, chunkEnd);
      envelopes.push(...result.envelopes);
      ghostUids.push(...result.ghostUids);
      unresolvedRanges.push(...result.unresolvedRanges);
    }

    // Ghost UIDs get a retry grace period, not an instant, permanent skip —
    // see db/schema.sql's ghost_uids comment. Only ones that have stayed a
    // ghost past GHOST_RETRY_WINDOW_MS are given up on and folded into the
    // watermark; anything still within the window blocks the watermark from
    // advancing past it, exactly like an unresolved envelope-scan range, so
    // the next run's scan naturally retries it.
    const { expired: expiredGhostUids, pending: pendingGhostUids } =
      await triageGhostUids(mailboxPath, mailbox.uidValidity, ghostUids, envelopes.map(e => e.uid));
    if (pendingGhostUids.length) {
      log(`  [${mailboxPath}] ${pendingGhostUids.length} ghost UID(s) still within retry window, will retry next run: ${pendingGhostUids.join(', ')}`);
    }
    if (expiredGhostUids.length) {
      log(`  [${mailboxPath}] giving up on ${expiredGhostUids.length} ghost UID(s) after ${GHOST_RETRY_WINDOW_MS / 60000}min of retries: ${expiredGhostUids.join(', ')}`);
    }

    // Plain loop, not Math.max(...bigArray) — spreading tens of thousands of
    // args into a function call blows V8's call-stack limit (hit this for
    // real on a 117k-message mailbox).
    let maxHandledUid = state.last_seen_uid || 0;
    for (const e of envelopes) if (e.uid > maxHandledUid) maxHandledUid = e.uid;
    for (const uid of expiredGhostUids) if (uid > maxHandledUid) maxHandledUid = uid;
    const noPendingWork = unresolvedRanges.length === 0 && pendingGhostUids.length === 0;

    stats.seen = envelopes.length;
    if (envelopes.length === 0) {
      log(`  [${mailboxPath}] nothing new${ghostUids.length ? ` (${ghostUids.length} ghost UID(s) seen)` : ''}`);
      if (noPendingWork) {
        await setImportState(mailboxPath, { uidValidity: mailbox.uidValidity, lastSeenUid: maxHandledUid });
      }
      return stats;
    }

    log(`  [${mailboxPath}] ${envelopes.length} new message(s) to check (UIDs ${startUid}+)`);

    // Split into: already-in-DB (just needs this label appended) vs new.
    const knownIds = new Set();
    for (const e of envelopes) if (e.messageId) knownIds.add(e.messageId);
    const existing = await findExistingMessageIds([...knownIds]);

    const toFetch = new Map(); // uid -> { pmInternalId, messageId } — messageId is what we EXPECT to find there
    const labelOnlyEntries = [];
    const succeededUids = new Set();
    const failedUids = new Set();

    for (const e of envelopes) {
      if (e.messageId && existing.has(e.messageId)) {
        labelOnlyEntries.push({ messageId: e.messageId, pmInternalId: e.pmInternalId });
        succeededUids.add(e.uid);
      } else {
        toFetch.set(e.uid, { pmInternalId: e.pmInternalId, messageId: e.messageId });
      }
    }

    if (labelOnlyEntries.length > 0) {
      try {
        await appendLabelToExisting(labelOnlyEntries, mailboxPath);
        stats.labeled = labelOnlyEntries.length;
      } catch (err) {
        log(`  [${mailboxPath}] label-append failed: ${err.message}`);
        // Those UIDs didn't actually get accounted for — undo the optimistic success mark.
        const labelOnlyIds = new Set(labelOnlyEntries.map(e => e.messageId));
        for (const e of envelopes) {
          if (e.messageId && labelOnlyIds.has(e.messageId)) {
            succeededUids.delete(e.uid);
            failedUids.add(e.uid);
          }
        }
      }
    }

    // Phase 2: full fetch + parse + insert for genuinely new messages, chunked.
    const toFetchUids = [...toFetch.keys()];
    for (let i = 0; i < toFetchUids.length; i += CHUNK_SIZE) {
      const chunk = toFetchUids.slice(i, i + CHUNK_SIZE);
      await fetchAndInsertChunk(client, mailboxPath, mailbox.uidValidity, chunk, toFetch, stats, succeededUids, failedUids);
    }

    const fullyCovered = failedUids.size === 0 && noPendingWork && succeededUids.size === envelopes.length;
    if (fullyCovered) {
      await setImportState(mailboxPath, { uidValidity: mailbox.uidValidity, lastSeenUid: maxHandledUid });
      log(`  [${mailboxPath}] done — inserted ${stats.inserted}, labeled ${stats.labeled}, failed ${stats.failed}${expiredGhostUids.length ? `, ${expiredGhostUids.length} ghost(s) given up on` : ''}. Watermark advanced to ${maxHandledUid}.`);
    } else {
      log(`  [${mailboxPath}] incomplete (${succeededUids.size}/${envelopes.length} accounted for) — watermark NOT advanced, will retry next run.`);
    }
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
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: { user: USER, pass: PASS },
    logger: false,
    tls: { rejectUnauthorized: false }, // Bridge uses a local self-signed cert
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });

  await client.connect();
  log(`connected to ${HOST}:${PORT} as ${USER}`);

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
      const stats = await processMailbox(client, mailboxPath);
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
        log('giving up — re-run this script later; already-imported mail and per-mailbox progress are preserved.');
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
