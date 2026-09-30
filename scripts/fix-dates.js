#!/usr/bin/env node
/**
 * One-off repair pass for the mailparser "now" fallback bug (see
 * lib/parseDate.js): finds emails whose email_date suspiciously matches
 * their own created_at (a dead giveaway the real header date was never
 * captured), re-fetches each from Bridge, and re-derives the date using the
 * fixed header-parsing logic. Falls back to NULL (not a fabricated date) if
 * no Date header on the message actually parses.
 *
 * Safe to re-run — only touches rows still matching the suspicious pattern.
 */

require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('../lib/db');
const { extractRealDate } = require('../lib/parseDate');

const HOST   = process.env.IMAP_HOST || '127.0.0.1';
const PORT   = parseInt(process.env.IMAP_PORT || '1143', 10);
const SECURE = /^true$/i.test(process.env.IMAP_SECURE || 'false');
const USER   = process.env.IMAP_USER;
const PASS   = process.env.IMAP_PASSWORD;

async function findSuspicious() {
  const { rows } = await db.query(`
    SELECT id, message_id, labels
    FROM emails
    WHERE email_date IS NOT NULL
      AND abs(extract(epoch FROM (email_date - created_at))) < 300
  `);
  return rows;
}

async function main() {
  const suspicious = await findSuspicious();
  if (suspicious.length === 0) {
    console.log('nothing to fix');
    await db.end();
    return;
  }
  console.log(`${suspicious.length} email(s) with a suspicious date — re-fetching to repair`);

  const client = new ImapFlow({
    host: HOST, port: PORT, secure: SECURE,
    auth: { user: USER, pass: PASS },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  await client.connect();

  let fixed = 0, nulled = 0, notFound = 0;

  for (const row of suspicious) {
    let found = false;
    for (const mailbox of row.labels || []) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const uids = await client.search({ header: { 'message-id': row.message_id.replace(/^<|>$/g, '') } }, { uid: true });
        if (uids.length === 0) continue;

        for await (const message of client.fetch([uids[0]], { uid: true, source: true })) {
          const parsed = await simpleParser(message.source);
          const realDate = extractRealDate(parsed);
          await db.query('UPDATE emails SET email_date = $1 WHERE id = $2', [realDate, row.id]);
          if (realDate) {
            console.log(`  [${row.id}] fixed -> ${realDate.toISOString()}`);
            fixed++;
          } else {
            console.log(`  [${row.id}] no parseable Date header found on the message itself — set to NULL`);
            nulled++;
          }
          found = true;
        }
      } finally {
        lock.release();
      }
      if (found) break;
    }
    if (!found) {
      console.log(`  [${row.id}] not found in any recorded mailbox — skipped`);
      notFound++;
    }
  }

  await client.logout();
  console.log(`done. fixed=${fixed} nulled=${nulled} notFound=${notFound}`);
  await db.end();
}

main().catch(err => { console.error(err); process.exit(1); });
