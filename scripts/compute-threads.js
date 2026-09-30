#!/usr/bin/env node
/**
 * Groups emails into conversations by connecting message_id <->
 * in_reply_to/thread_references edges with an in-memory Union-Find, then
 * writes each email's thread_key: the message_id of the earliest real email
 * in its connected component. See db/schema.sql's thread_key comment for why
 * this is a full recompute every run rather than an incremental job.
 *
 * Union-Find runs over ALL message_id strings it ever sees, including ones
 * referenced by in_reply_to/thread_references that don't correspond to any
 * email actually in this mailbox (a message that arrived, was replied to by
 * two people, but was itself never synced here) — those still correctly
 * bridge two real emails into the same thread even though the bridging
 * message itself has no row.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const BATCH_SIZE = parseInt(process.env.THREADS_BATCH_SIZE || '2000', 10);

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logFile = path.join(LOG_DIR, `compute-threads-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
}

// ─── Union-Find over message_id strings, path compression + union by size ──

const parent = new Map();
const size = new Map();

function makeSet(x) {
  if (!parent.has(x)) {
    parent.set(x, x);
    size.set(x, 1);
  }
}

function find(x) {
  let root = x;
  while (parent.get(root) !== root) root = parent.get(root);
  // Path compression: repoint every visited node straight at the root.
  let cur = x;
  while (parent.get(cur) !== root) {
    const next = parent.get(cur);
    parent.set(cur, root);
    cur = next;
  }
  return root;
}

function union(a, b) {
  const ra = find(a);
  const rb = find(b);
  if (ra === rb) return;
  const [small, big] = size.get(ra) <= size.get(rb) ? [ra, rb] : [rb, ra];
  parent.set(small, big);
  size.set(big, size.get(big) + size.get(small));
}

async function main() {
  log('loading emails...');
  const { rows } = await db.query(`
    SELECT id, message_id, in_reply_to, thread_references, email_date
    FROM emails
  `);
  log(`${rows.length} emails loaded`);

  for (const row of rows) {
    makeSet(row.message_id);
    const refs = [row.in_reply_to, ...(row.thread_references || [])].filter(Boolean);
    for (const ref of refs) {
      makeSet(ref);
      union(row.message_id, ref);
    }
  }
  log(`${parent.size} distinct message-id nodes (including references never synced as their own row)`);

  // Pick each component's canonical key: the earliest-dated real email's own
  // message_id. NULL email_date sorts last (Infinity), so a dated email
  // always wins over an undated one when both exist in the same component;
  // if every member is undated, the first one seen just wins — thread_key
  // still needs to be *some* real message_id, and which one is arbitrary
  // there since there's no date to order by.
  const earliestInComponent = new Map(); // component root -> { messageId, time }
  for (const row of rows) {
    const root = find(row.message_id);
    const time = row.email_date ? new Date(row.email_date).getTime() : Infinity;
    const cur = earliestInComponent.get(root);
    if (!cur || time < cur.time) {
      earliestInComponent.set(root, { messageId: row.message_id, time });
    }
  }

  const threadCounts = new Map(); // component root -> member count, for the summary log
  for (const row of rows) {
    const root = find(row.message_id);
    threadCounts.set(root, (threadCounts.get(root) || 0) + 1);
  }
  const multiMessage = [...threadCounts.values()].filter((n) => n > 1).length;
  log(`${threadCounts.size} threads total, ${multiMessage} of them have more than one message`);

  log('writing thread_key back to emails...');
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const ids = batch.map((r) => r.id);
    const keys = batch.map((r) => earliestInComponent.get(find(r.message_id)).messageId);
    await db.query(
      `UPDATE emails SET thread_key = v.key
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS key) v
       WHERE emails.id = v.id`,
      [ids, keys]
    );
    written += batch.length;
    log(`  ${written}/${rows.length} written`);
  }

  log('done.');
  await db.end();
  logStream.end();
}

main().catch((err) => {
  log('failed:', err.message);
  process.exitCode = 1;
});
