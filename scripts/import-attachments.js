#!/usr/bin/env node
/**
 * Second pass: extracts real attachment files (not just the filename/size
 * metadata the main import already captured) for every email that has them,
 * and stores them in the content-addressed blob store (see lib/attachments.js).
 *
 * Driven by emails.attachments_stored_at rather than an IMAP UID watermark —
 * simpler because this pass isn't "everything new in a mailbox", it's
 * "everything in Postgres still missing its attachment blobs". That also
 * makes it safe to just re-run this anytime after the main import adds more
 * emails; it always picks up wherever it left off.
 *
 * Avoids a blind second full-mailbox re-download: it does the same cheap
 * envelope-only scan the main importer uses, then only pulls full source for
 * messages that are actually on our "still pending" list.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');
const blobs = require('../lib/attachments');

const HOST   = process.env.IMAP_HOST || '127.0.0.1';
const PORT   = parseInt(process.env.IMAP_PORT || '1143', 10);
const SECURE = /^true$/i.test(process.env.IMAP_SECURE || 'false');
const USER   = process.env.IMAP_USER;
const PASS   = process.env.IMAP_PASSWORD;
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', 'attachments');

// Deliberately smaller than the main importer's chunk size: this script fetches
// sparse, non-contiguous UIDs (only the ones with pending attachments), and
// Bridge has been observed silently substituting a different nearby UID's
// content when a large sparse UID list is fetched in one command — a known
// weak spot for explicit (non-range) UID lists. Smaller batches reduce how
// often that's hit; correlating by Message-ID (below) makes it harmless even
// when it is.
const CHUNK_SIZE   = parseInt(process.env.ATTACH_CHUNK_SIZE || '25', 10);
const MAX_ATTEMPTS = parseInt(process.env.IMPORT_MAX_ATTEMPTS || '5', 10);

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `import-attachments-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function stripNulls(str) {
  if (typeof str !== 'string') return str;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x00/g, '');
}

// ─── DB access ───────────────────────────────────────────────────────────────

async function getPendingEmails() {
  const { rows } = await db.query(`
    SELECT id, message_id, labels
    FROM emails
    WHERE attachments_stored_at IS NULL
      AND jsonb_array_length(attachments) > 0
  `);
  return rows;
}

/** Stores every non-noise attachment for one email and marks it done, all in
 * one transaction — so a crash mid-way never leaves duplicate rows behind. */
async function storeEmailAttachments(emailId, attachments) {
  const client = await db.pool().connect();
  try {
    await client.query('BEGIN');

    for (const att of attachments) {
      const stored = blobs.store(ATTACHMENTS_DIR, att.content, att.filename, att.contentType);

      await client.query(`
        INSERT INTO attachment_blobs (md5, ext, content_type, size_bytes)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (md5) DO NOTHING
      `, [stored.md5, stored.ext, stored.contentType, stored.sizeBytes]);

      await client.query(`
        INSERT INTO email_attachments (email_id, blob_md5, filename, content_type, size_bytes)
        VALUES ($1, $2, $3, $4, $5)
      `, [emailId, stored.md5, stripNulls(att.filename || ''), stored.contentType, stored.sizeBytes]);
    }

    await client.query('UPDATE emails SET attachments_stored_at = NOW() WHERE id = $1', [emailId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** An email whose real attachments were all noise (tiny inline images) still
 * needs to be marked done, or it'd be re-checked forever. */
async function markDoneNoAttachments(emailId) {
  await db.query('UPDATE emails SET attachments_stored_at = NOW() WHERE id = $1', [emailId]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function processMailbox(client, mailboxPath, pendingByMessageId) {
  if (pendingByMessageId.size === 0) return { checked: 0, stored: 0, failed: 0 };

  const lock = await client.getMailboxLock(mailboxPath);
  const stats = { checked: 0, stored: 0, failed: 0 };

  try {
    const mailbox = client.mailbox;
    if (!mailbox.exists || mailbox.exists === 0) return stats;

    // Scanning the whole mailbox in ONE unchunked '1:*' fetch turned out to
    // silently miss messages in large mailboxes (confirmed: a message IMAP
    // SEARCH finds instantly by Message-ID was absent from this scan's
    // results in a 93k-message INBOX) — the same "Bridge doesn't reliably
    // handle one giant command" pattern hit everywhere else this project has
    // touched large ranges. Scanning in bounded contiguous chunks instead.
    const ENVELOPE_SCAN_CHUNK = 5000;
    const uidNext = client.mailbox.uidNext || (client.mailbox.exists + 1);
    const candidateUids = []; // uids worth fetching — actual correlation happens post-fetch, by Message-ID
    for (let start = 1; start < uidNext; start += ENVELOPE_SCAN_CHUNK) {
      const end = Math.min(start + ENVELOPE_SCAN_CHUNK - 1, uidNext - 1);
      try {
        for await (const message of client.fetch(`${start}:${end}`, { uid: true, envelope: true })) {
          const messageId = message.envelope?.messageId;
          if (messageId && pendingByMessageId.has(messageId)) candidateUids.push(message.uid);
        }
      } catch (err) {
        log(`  [${mailboxPath}] envelope scan ${start}:${end} failed: ${err.message} — continuing with next chunk`);
      }
    }

    if (candidateUids.length === 0) {
      log(`  [${mailboxPath}] none of the pending messages found here`);
      return stats;
    }

    log(`  [${mailboxPath}] found ${candidateUids.length} pending message(s) here`);

    for (let i = 0; i < candidateUids.length; i += CHUNK_SIZE) {
      const chunk = candidateUids.slice(i, i + CHUNK_SIZE);
      await fetchChunk(client, mailboxPath, chunk, pendingByMessageId, stats);
    }

    // Cleanup pass: anything still unresolved from this mailbox's candidates
    // gets one more try, one UID at a time — a single-UID fetch is much less
    // likely to trip the sparse-list substitution quirk than a batch is.
    for (const uid of candidateUids) {
      if (pendingByMessageId.size === 0) break;
      try {
        for await (const message of client.fetch([uid], { uid: true, source: true })) {
          await handleOne(mailboxPath, message, pendingByMessageId, stats);
        }
      } catch (err) {
        log(`  [${mailboxPath}] cleanup fetch of UID ${uid} failed: ${err.message}`);
      }
    }
  } finally {
    lock.release();
  }

  return stats;
}

async function fetchChunk(client, mailboxPath, uids, pendingByMessageId, stats) {
  try {
    for await (const message of client.fetch(uids, { uid: true, source: true })) {
      await handleOne(mailboxPath, message, pendingByMessageId, stats);
    }
  } catch (err) {
    log(`  [${mailboxPath}] chunk fetch failed (${err.message}) — will retry unresolved UIDs individually`);
  }
}

/** Looks up which pending email this message actually is by parsing it and
 * reading its real Message-ID — never by trusting the UID we asked for came
 * back unchanged (Bridge doesn't always honor that for sparse UID lists). */
async function handleOne(mailboxPath, message, pendingByMessageId, stats) {
  stats.checked++;
  let parsed;
  try {
    parsed = await simpleParser(message.source);
  } catch (err) {
    log(`  [${mailboxPath}] UID ${message.uid} failed to parse: ${err.message}`);
    stats.failed++;
    return;
  }

  const messageId = parsed.messageId;
  const emailId = messageId ? pendingByMessageId.get(messageId) : undefined;
  if (emailId === undefined) return; // not one of ours (substituted/irrelevant message) — silently skip, no crash, no misattribution

  try {
    const real = (parsed.attachments || []).filter(a => a.filename && a.content && !blobs.isNoise(a));

    if (real.length > 0) {
      await storeEmailAttachments(emailId, real);
      stats.stored += real.length;
      log(`  [${mailboxPath}] UID ${message.uid}: stored ${real.length} attachment(s)`);
    } else {
      await markDoneNoAttachments(emailId);
    }

    pendingByMessageId.delete(messageId); // don't re-check this message in a later mailbox or the cleanup pass
  } catch (err) {
    log(`  [${mailboxPath}] UID ${message.uid} (${messageId}) failed: ${err.message}`);
    stats.failed++;
    // Leave it pending — retried on the next run.
  }
}

async function runOnce() {
  if (!USER || !PASS) {
    throw new Error('IMAP_USER / IMAP_PASSWORD are not set.');
  }

  const pending = await getPendingEmails();
  if (pending.length === 0) {
    log('nothing pending — every email with attachments already has its blobs stored');
    return { checked: 0, stored: 0, failed: 0 };
  }
  log(`${pending.length} email(s) still need attachment extraction`);

  // mailbox path -> Map<messageId, emailId>, seeded from every label an email has
  const byMailbox = new Map();
  const globalPending = new Map(); // messageId -> emailId, shared/mutated across mailboxes
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

  const totals = { checked: 0, stored: 0, failed: 0 };
  for (const mailboxPath of byMailbox.keys()) {
    if (globalPending.size === 0) break; // everything found already
    log(`processing "${mailboxPath}"...`);
    try {
      const stats = await processMailbox(client, mailboxPath, globalPending);
      for (const k of Object.keys(totals)) totals[k] += stats[k];
    } catch (err) {
      log(`  [${mailboxPath}] mailbox-level failure: ${err.message} — skipping to next mailbox`);
    }
  }

  await client.logout();

  if (globalPending.size > 0) {
    log(`${globalPending.size} pending message(s) were not found in any of their recorded mailboxes (moved/deleted since import?) — left pending for a future run`);
  }

  log(`logged out. TOTAL: checked=${totals.checked} attachments_stored=${totals.stored} failed=${totals.failed}`);
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
        log('giving up — re-run later; already-stored attachments and progress are preserved.');
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
