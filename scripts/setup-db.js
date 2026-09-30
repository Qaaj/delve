#!/usr/bin/env node
/**
 * Applies db/schema.sql. Safe to run repeatedly (everything is
 * CREATE ... IF NOT EXISTS), so it doubles as a "make sure the schema is
 * current" step before an import run.
 */

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('[setup-db] schema applied OK');
  await db.end();
}

main().catch((err) => {
  console.error('[setup-db] failed:', err.message);
  process.exit(1);
});
