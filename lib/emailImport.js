/**
 * Shared IMAP scan/fetch/insert/ghost-handling machinery, used by both
 * scripts/import.js (incremental, UID-watermark-based) and
 * scripts/catchup-recent.js (stateless, re-checks the last N messages by
 * position every run — see that file for why UID watermarks alone aren't
 * fully trustworthy on this Bridge instance: confirmed the UID-to-content
 * mapping can shift without a UIDVALIDITY change, which the IMAP spec says
 * should never happen).
 *
 * Extracted rather than duplicated so both scripts share one, already-tested
 * ghost-UID-retry-window implementation and Message-ID correlation — the
 * hard-won resilience from this project's Bridge-quirk history lives in
 * exactly one place.
 */

const { simpleParser } = require('mailparser');
const db = require('./db');
const { extractRealDate } = require('./parseDate');

const MAX_BODY_CHARS = parseInt(process.env.IMPORT_MAX_BODY_CHARS || '200000', 10);
const MAX_HTML_CHARS = parseInt(process.env.IMPORT_MAX_HTML_CHARS || '300000', 10);
const ENVELOPE_SCAN_CHUNK = 3000;
const MAX_ENVELOPE_BISECTIONS = 12;

// See db/schema.sql's ghost_uids comment: a ghost UID gets retried for up to
// this long before we give up on it. Long enough for Bridge's own indexing
// lag to resolve; short enough not to get stuck forever on a genuinely,
// permanently corrupted UID.
const GHOST_RETRY_WINDOW_MS = 60 * 60 * 1000;

// ─── Small parsing helpers ───────────────────────────────────────────────────

function stripNulls(str) {
  if (typeof str !== 'string') return str;
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x00/g, '');
}

function formatAddress(addressObj) {
  if (!addressObj) return '';
  if (Array.isArray(addressObj)) return addressObj.map(formatAddress).filter(Boolean).join(', ');
  if (addressObj.text) return addressObj.text;
  if (addressObj.value) return addressObj.value.map(v => v.name ? `${v.name} <${v.address}>` : v.address).join(', ');
  return '';
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Extracts a single header field's value from an ImapFlow headers Buffer
 * (raw "Name: value\r\n" block for just the fields we asked for). */
function extractHeader(headersBuffer, name) {
  if (!headersBuffer) return null;
  const match = headersBuffer.toString('utf8').match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : null;
}

/** Parses a `List-Unsubscribe` header's `<...>, <...>` entries, picking out
 * the http(s) link and the mailto address separately — a real sender can
 * (and often does) provide both. */
function parseListUnsubscribe(raw) {
  if (!raw) return { url: null, mailto: null };
  const matches = [...String(raw).matchAll(/<([^>]+)>/g)].map(m => m[1]);
  const url = matches.find(m => /^https?:/i.test(m)) || null;
  const mailtoRaw = matches.find(m => /^mailto:/i.test(m)) || null;
  return { url, mailto: mailtoRaw ? mailtoRaw.replace(/^mailto:/i, '').split('?')[0] : null };
}

/** Importance/priority isn't one consistent header across senders — checks
 * the modern `Importance` header first, falls back to the older numeric
 * `X-Priority` (1-2=high, 3=normal, 4-5=low) many clients still send instead. */
function parseImportance(parsed) {
  const importance = parsed.headers.get('importance');
  if (importance) {
    const v = String(importance).toLowerCase();
    if (v.includes('high')) return 'high';
    if (v.includes('low')) return 'low';
    if (v.includes('normal')) return 'normal';
  }
  const xPriority = parsed.headers.get('x-priority');
  if (xPriority) {
    const n = parseInt(String(xPriority).trim()[0], 10);
    if (n === 1 || n === 2) return 'high';
    if (n === 4 || n === 5) return 'low';
    if (n === 3) return 'normal';
  }
  return null;
}

/** Everything from the "high value" list that isn't already covered by
 * normalize()'s core fields — threading, unsubscribe, list-id, reply-to,
 * importance. Shared between normalize() (new mail) and
 * scripts/backfill-headers.js (the 116k+ already-imported emails that
 * predate this — see db/schema.sql's headers_backfilled_at comment). */
function parseExtraHeaders(parsed) {
  const { url: unsubscribeUrl, mailto: unsubscribeMailto } = parseListUnsubscribe(parsed.headers.get('list-unsubscribe'));
  const replyToEntry = parsed.replyTo?.value?.[0];
  let references = parsed.references || [];
  if (typeof references === 'string') references = references.split(/\s+/).filter(Boolean);

  return {
    inReplyTo: parsed.inReplyTo || null,
    references,
    replyToAddress: replyToEntry?.address || null,
    replyToName: replyToEntry?.name || null,
    listId: parsed.headers.get('list-id') ? String(parsed.headers.get('list-id')) : null,
    unsubscribeUrl,
    unsubscribeMailto,
    unsubscribeOneClick: /one-click/i.test(parsed.headers.get('list-unsubscribe-post') || ''),
    importance: parseImportance(parsed),
  };
}

function normalize(parsed, mailboxPath, uid, sizeBytes, pmInternalId) {
  const bodyText = (parsed.text || stripHtml(parsed.html) || '').trim().slice(0, MAX_BODY_CHARS);

  let bodyHtml = typeof parsed.html === 'string' ? parsed.html : null;
  if (bodyHtml) {
    // Strip base64 data: URI images — can be megabytes each, no search value.
    bodyHtml = bodyHtml.replace(/src\s*=\s*["']data:[^"']{0,20};base64,[^"']*["']/gi,
      'src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="');
    bodyHtml = bodyHtml.slice(0, MAX_HTML_CHARS);
  }

  const fromEntry = parsed.from?.value?.[0];
  const attachments = (parsed.attachments || []).map(a => ({
    filename: a.filename || null,
    contentType: a.contentType || null,
    size: a.size || null,
  }));

  return {
    messageId: parsed.messageId || `bridge:${mailboxPath}#${uid}`,
    subject: parsed.subject || '(no subject)',
    fromAddress: fromEntry?.address || '',
    fromName: fromEntry?.name || '',
    toAddress: formatAddress(parsed.to),
    cc: formatAddress(parsed.cc),
    date: extractRealDate(parsed),
    bodyText,
    bodyHtml,
    ...parseExtraHeaders(parsed),
    attachments,
    labels: [mailboxPath],
    sizeBytes,
    pmInternalId: pmInternalId || parsed.headers.get('x-pm-internal-id') || null,
  };
}

// ─── DB access ───────────────────────────────────────────────────────────────

async function findExistingMessageIds(messageIds) {
  if (messageIds.length === 0) return new Set();
  const { rows } = await db.query(
    'SELECT message_id FROM emails WHERE message_id = ANY($1)',
    [messageIds]
  );
  return new Set(rows.map(r => r.message_id));
}

async function appendLabelToExisting(entries, label) {
  // entries: [{ messageId, pmInternalId }]
  if (entries.length === 0) return;
  await db.query(`
    UPDATE emails e
    SET
      labels = ARRAY(SELECT DISTINCT unnest(e.labels || ARRAY[$1])),
      pm_internal_id = COALESCE(e.pm_internal_id, u.pm_internal_id)
    FROM (SELECT * FROM unnest($2::text[], $3::text[]) AS t(message_id, pm_internal_id)) u
    WHERE e.message_id = u.message_id
      AND (NOT ($1 = ANY(e.labels)) OR (e.pm_internal_id IS NULL AND u.pm_internal_id IS NOT NULL))
  `, [label, entries.map(e => e.messageId), entries.map(e => e.pmInternalId || null)]);
}

/** Returns true iff this call actually created a new row (as opposed to
 * hitting ON CONFLICT DO UPDATE for a message_id that already existed) — the
 * standard `xmax = 0` trick, since a plain rowCount/success check can't tell
 * the two apart. */
async function insertEmail(email) {
  const { rows } = await db.query(`
    INSERT INTO emails
      (message_id, subject, from_address, from_name, to_address, cc, email_date,
       body_text, body_html, attachments, labels, size_bytes, pm_internal_id,
       in_reply_to, thread_references, reply_to_address, reply_to_name, list_id,
       unsubscribe_url, unsubscribe_mailto, unsubscribe_one_click, importance,
       headers_backfilled_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
            $14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
    ON CONFLICT (message_id) DO UPDATE SET
      labels = ARRAY(SELECT DISTINCT unnest(emails.labels || EXCLUDED.labels)),
      pm_internal_id = COALESCE(emails.pm_internal_id, EXCLUDED.pm_internal_id),
      in_reply_to = COALESCE(emails.in_reply_to, EXCLUDED.in_reply_to),
      thread_references = CASE WHEN cardinality(emails.thread_references) = 0 THEN EXCLUDED.thread_references ELSE emails.thread_references END,
      reply_to_address = COALESCE(emails.reply_to_address, EXCLUDED.reply_to_address),
      reply_to_name = COALESCE(emails.reply_to_name, EXCLUDED.reply_to_name),
      list_id = COALESCE(emails.list_id, EXCLUDED.list_id),
      unsubscribe_url = COALESCE(emails.unsubscribe_url, EXCLUDED.unsubscribe_url),
      unsubscribe_mailto = COALESCE(emails.unsubscribe_mailto, EXCLUDED.unsubscribe_mailto),
      unsubscribe_one_click = emails.unsubscribe_one_click OR EXCLUDED.unsubscribe_one_click,
      importance = COALESCE(emails.importance, EXCLUDED.importance),
      headers_backfilled_at = COALESCE(emails.headers_backfilled_at, EXCLUDED.headers_backfilled_at)
    RETURNING (xmax = 0) AS is_new
  `, [
    stripNulls(email.messageId),
    stripNulls(email.subject),
    stripNulls(email.fromAddress),
    stripNulls(email.fromName),
    stripNulls(email.toAddress),
    stripNulls(email.cc),
    email.date,
    stripNulls(email.bodyText),
    stripNulls(email.bodyHtml),
    JSON.stringify(email.attachments),
    email.labels,
    email.sizeBytes,
    stripNulls(email.pmInternalId || null),
    stripNulls(email.inReplyTo || null),
    (email.references || []).map(stripNulls),
    stripNulls(email.replyToAddress || null),
    stripNulls(email.replyToName || null),
    stripNulls(email.listId || null),
    stripNulls(email.unsubscribeUrl || null),
    stripNulls(email.unsubscribeMailto || null),
    !!email.unsubscribeOneClick,
    email.importance || null,
  ]);
  return rows[0].is_new;
}

// ─── Ghost-UID retry-window bookkeeping ─────────────────────────────────────

async function ghostUidFirstSeen(mailbox, uidValidity, uid) {
  const { rows } = await db.query(
    'SELECT first_seen_at FROM ghost_uids WHERE mailbox = $1 AND uid_validity = $2 AND uid = $3',
    [mailbox, String(uidValidity), uid]
  );
  return rows[0]?.first_seen_at || null;
}

async function recordGhostUid(mailbox, uidValidity, uid) {
  await db.query(`
    INSERT INTO ghost_uids (mailbox, uid_validity, uid) VALUES ($1, $2, $3)
    ON CONFLICT (mailbox, uid_validity, uid) DO UPDATE SET attempts = ghost_uids.attempts + 1
  `, [mailbox, String(uidValidity), uid]);
}

async function clearGhostUid(mailbox, uidValidity, uid) {
  await db.query('DELETE FROM ghost_uids WHERE mailbox = $1 AND uid_validity = $2 AND uid = $3', [mailbox, String(uidValidity), uid]);
}

/** Records this occurrence and returns whether it's now been a ghost long
 * enough to give up on (true) or should still be retried next run (false). */
async function shouldGiveUpOnGhost(mailbox, uidValidity, uid) {
  const firstSeen = await ghostUidFirstSeen(mailbox, uidValidity, uid);
  const pastWindow = !!firstSeen && (Date.now() - new Date(firstSeen).getTime()) >= GHOST_RETRY_WINDOW_MS;
  if (pastWindow) await clearGhostUid(mailbox, uidValidity, uid);
  else await recordGhostUid(mailbox, uidValidity, uid);
  return pastWindow;
}

/** Splits scan-discovered ghost UIDs into "given up on" vs "still pending".
 * Also clears ghost_uids bookkeeping for UIDs that resolved normally this run.
 *
 * `neverExpire` skips the give-up entirely — every ghost comes back pending,
 * forever, no matter its age. import.js needs the normal 1-hour expiry
 * because its UID watermark can't advance past an unresolved UID, so one
 * genuinely-dead historical UID would otherwise freeze ALL future import
 * progress for that mailbox; catchup-recent.js is stateless (nothing is
 * ever blocked on a ghost resolving), so for it there's no upside to ever
 * giving up — only the downside of silently dropping real, recoverable mail
 * that just happens to be taking Bridge longer than an hour to stabilize
 * (confirmed 2026-09-29: some UIDs took several hours, and DID eventually
 * resolve once retried). Retrying forever costs one extra fetch attempt per
 * sync cycle for whatever's still stuck — cheap, and never wrong. */
async function triageGhostUids(mailboxPath, uidValidity, ghostUids, resolvedUids, { neverExpire = false } = {}) {
  const expired = [];
  const pending = [];
  for (const uid of ghostUids) {
    const firstSeen = await ghostUidFirstSeen(mailboxPath, uidValidity, uid);
    const pastWindow = !neverExpire && firstSeen && (Date.now() - new Date(firstSeen).getTime()) >= GHOST_RETRY_WINDOW_MS;
    if (pastWindow) {
      expired.push(uid);
      await clearGhostUid(mailboxPath, uidValidity, uid);
    } else {
      pending.push(uid);
      await recordGhostUid(mailboxPath, uidValidity, uid);
    }
  }
  for (const uid of resolvedUids) await clearGhostUid(mailboxPath, uidValidity, uid);
  return { expired, pending };
}

// ─── Scan / fetch (need a caller-supplied `log`, so wrapped in a factory) ────

/** `log` is injected so each script keeps writing to its own log file/prefix
 * while sharing this exact scanning/fetching/inserting logic. */
function createEmailImporter({ log }) {
  /** Scans [rangeStart, rangeEnd] for envelopes, bisecting on failure to skip
   * individual ghost UIDs. Returns { envelopes, ghostUids, unresolvedRanges } —
   * unresolvedRanges is only non-empty if bisection depth was exhausted (rare),
   * and those UIDs are neither in envelopes nor ghostUids: not covered, so the
   * caller must not advance any watermark past them. */
  async function scanEnvelopeRange(client, mailboxPath, rangeStart, rangeEnd) {
    const envelopes = [];
    const ghostUids = [];
    const unresolvedRanges = [];
    const work = [[rangeStart, rangeEnd, 0]];

    while (work.length > 0) {
      const [start, end, depth] = work.shift();
      const range = start === end ? `${start}` : `${start}:${end}`;
      try {
        for await (const message of client.fetch(range, { uid: true, envelope: true, headers: ['x-pm-internal-id'] })) {
          if (!message.uid || message.uid < start || message.uid > end) continue;
          envelopes.push({
            uid: message.uid,
            messageId: message.envelope?.messageId || null,
            date: message.envelope?.date || null,
            pmInternalId: extractHeader(message.headers, 'x-pm-internal-id'),
          });
        }
      } catch (err) {
        if (start === end) {
          log(`  [${mailboxPath}] UID ${start} is a ghost during envelope scan (${err.message}) — skipping`);
          ghostUids.push(start);
          continue;
        }
        if (depth >= MAX_ENVELOPE_BISECTIONS) {
          log(`  [${mailboxPath}] envelope scan ${range} failed repeatedly (${err.message}) — leaving unresolved for a future run`);
          unresolvedRanges.push([start, end]);
          continue;
        }
        const mid = start + Math.floor((end - start) / 2);
        work.push([start, mid, depth + 1], [mid + 1, end, depth + 1]);
      }
    }

    return { envelopes, ghostUids, unresolvedRanges };
  }

  /** Fetches full source for a possibly-sparse list of UIDs and inserts
   * whatever real content comes back, gated PURELY on "is this message_id
   * already in Postgres" — no pre-captured "expected identity" to verify
   * against. This exists because that verification step is exactly what
   * produces false-negative ghosts: confirmed empirically (2026-09-29) that
   * a single-UID fetch for UID N can come back labeled as a NEIGHBORING
   * UID's content, and a batch fetch across a small UID list can silently
   * drop one of the requested UIDs and substitute an unrequested one —
   * Bridge's own uid<->content pairing is internally consistent WITHIN one
   * fetch call (verified: a batch fetch's several simultaneous responses
   * each carry the right content for whichever uid they claim), just not
   * reliably reproducible ACROSS two separate calls (an earlier envelope
   * scan's "this is what UID N should be" vs a later source fetch's actual
   * answer). So: stop trying to verify a prediction, just trust each
   * response's own self-consistent uid+content pairing and check reality
   * (Postgres) directly — the same principle catchup-recent.js already
   * applies at the whole-script level, just used to correlate individual
   * fetch responses too, not on ANY pre-scanned envelope for the caller's
   * REQUESTED uid specifically.
   *
   * Safe here specifically because callers of this function (catchup-recent.js)
   * are stateless — nothing advances a watermark based on "this uid is now
   * handled", so there's no risk of silently skipping a genuinely-different
   * message that a stricter, watermark-safe caller (import.js) would need to
   * protect against. import.js keeps using fetchAndInsertChunk's stricter
   * correlation for exactly that reason. */
  async function recoverByContent(client, mailboxPath, uids) {
    const respondedUids = new Set(); // every uid Bridge actually attached a message to, this call
    let inserted = 0;
    let labeled = 0;
    let failed = 0;

    async function handle(message) {
      respondedUids.add(message.uid);
      let parsed;
      try {
        parsed = await simpleParser(message.source);
      } catch (err) {
        log(`  [${mailboxPath}] UID ${message.uid} failed to parse during content-based recovery: ${err.message}`);
        failed++;
        return;
      }
      if (!parsed.messageId) return;
      try {
        const email = normalize(parsed, mailboxPath, message.uid, message.source.length, extractHeader(message.headers, 'x-pm-internal-id'));
        const isNew = await insertEmail(email);
        if (isNew) inserted++; else labeled++;
      } catch (err) {
        log(`  [${mailboxPath}] UID ${message.uid} failed to insert during content-based recovery: ${err.message}`);
        failed++;
      }
    }

    for (let i = 0; i < uids.length; i += ENVELOPE_SCAN_CHUNK) {
      const chunk = uids.slice(i, i + ENVELOPE_SCAN_CHUNK);
      try {
        for await (const message of client.fetch(chunk, { uid: true, source: true, headers: ['x-pm-internal-id'] })) {
          await handle(message);
        }
      } catch (err) {
        // Whole batch failed outright — retry one UID at a time so a single
        // bad one can't take the rest down with it.
        for (const uid of chunk) {
          try {
            for await (const message of client.fetch([uid], { uid: true, source: true, headers: ['x-pm-internal-id'] })) {
              await handle(message);
            }
          } catch (err2) {
            // Genuinely nothing came back for this uid this attempt — leave
            // it as still-ghost, caller's triageGhostUids handles the retry
            // window / eventual give-up from here.
          }
        }
      }
    }

    const stillGhost = uids.filter(u => !respondedUids.has(u));
    return { inserted, labeled, failed, stillGhost };
  }

  /** Fetches a chunk's full source + parses + inserts. Falls back to one-by-one
   * on a whole-chunk failure so a single bad UID can't sink the rest.
   *
   * Correlates each delivered message back to the ORIGINAL requested UID by
   * Message-ID, not by trusting that message.uid matches what was asked for —
   * confirmed empirically that Bridge can silently substitute a different
   * nearby UID's content for a sparse/large explicit UID-list fetch. */
  async function fetchAndInsertChunk(client, mailboxPath, uidValidity, uids, toFetch, stats, succeededUids, failedUids) {
    const messageIdToUid = new Map();
    for (const uid of uids) {
      const entry = toFetch.get(uid);
      if (entry?.messageId) messageIdToUid.set(entry.messageId, uid);
    }
    const resolved = new Set();

    try {
      for await (const message of client.fetch(uids, { uid: true, source: true })) {
        await parseAndInsertOne(mailboxPath, message, uids, toFetch, messageIdToUid, resolved, stats, succeededUids, failedUids);
      }
    } catch (err) {
      log(`  [${mailboxPath}] chunk fetch failed (${err.message}) — retrying unresolved UID(s) individually`);
    }

    const missed = uids.filter(u => !resolved.has(u));
    for (const uid of missed) {
      try {
        let found = false;
        for await (const message of client.fetch([uid], { uid: true, source: true })) {
          found = true;
          await parseAndInsertOne(mailboxPath, message, uids, toFetch, messageIdToUid, resolved, stats, succeededUids, failedUids);
        }
        if (!found) {
          const giveUp = await shouldGiveUpOnGhost(mailboxPath, uidValidity, uid);
          if (giveUp) {
            log(`  [${mailboxPath}] UID ${uid} not deliverable (ghost UID) after retry window — giving up, skipping`);
            stats.skipped++;
            succeededUids.add(uid);
          } else {
            log(`  [${mailboxPath}] UID ${uid} not deliverable (ghost UID) — still within retry window, will retry next run`);
            failedUids.add(uid);
          }
          resolved.add(uid);
        } else if (!resolved.has(uid)) {
          const giveUp = await shouldGiveUpOnGhost(mailboxPath, uidValidity, uid);
          if (giveUp) {
            log(`  [${mailboxPath}] UID ${uid} content never matched its expected identity after retry window — giving up, skipping`);
            stats.skipped++;
            succeededUids.add(uid);
          } else {
            log(`  [${mailboxPath}] UID ${uid} content never matched its expected identity — still within retry window, will retry next run`);
            failedUids.add(uid);
          }
          resolved.add(uid);
        }
      } catch (err) {
        const giveUp = await shouldGiveUpOnGhost(mailboxPath, uidValidity, uid);
        if (giveUp) {
          log(`  [${mailboxPath}] UID ${uid} permanently undeliverable (${err.message}) after retry window — giving up, skipping`);
          stats.skipped++;
          succeededUids.add(uid);
        } else {
          log(`  [${mailboxPath}] UID ${uid} undeliverable (${err.message}) — still within retry window, will retry next run`);
          failedUids.add(uid);
        }
        resolved.add(uid);
      }
    }
  }

  async function parseAndInsertOne(mailboxPath, message, requestedUids, toFetch, messageIdToUid, resolved, stats, succeededUids, failedUids) {
    let parsed;
    try {
      parsed = await simpleParser(message.source);
    } catch (err) {
      log(`  [${mailboxPath}] UID ${message.uid} failed to parse: ${err.message}`);
      stats.failed++;
      failedUids.add(message.uid);
      resolved.add(message.uid);
      return;
    }

    let originalUid = parsed.messageId ? messageIdToUid.get(parsed.messageId) : undefined;
    if (originalUid === undefined && requestedUids.includes(message.uid) && toFetch.has(message.uid)) {
      originalUid = message.uid;
    }
    if (originalUid === undefined || resolved.has(originalUid)) return;

    resolved.add(originalUid);
    try {
      const entry = toFetch.get(originalUid);
      const email = normalize(parsed, mailboxPath, message.uid, message.source.length, entry?.pmInternalId);
      const isNew = await insertEmail(email);
      if (isNew) stats.inserted++; else stats.labeled++;
      succeededUids.add(originalUid);
    } catch (err) {
      log(`  [${mailboxPath}] UID ${originalUid} failed to insert: ${err.message}`);
      stats.failed++;
      failedUids.add(originalUid);
    }
  }

  return { scanEnvelopeRange, recoverByContent, fetchAndInsertChunk, parseAndInsertOne };
}

module.exports = {
  GHOST_RETRY_WINDOW_MS,
  ENVELOPE_SCAN_CHUNK,
  MAX_ENVELOPE_BISECTIONS,
  stripNulls,
  formatAddress,
  stripHtml,
  extractHeader,
  normalize,
  findExistingMessageIds,
  appendLabelToExisting,
  insertEmail,
  ghostUidFirstSeen,
  recordGhostUid,
  clearGhostUid,
  shouldGiveUpOnGhost,
  triageGhostUids,
  createEmailImporter,
};
