/**
 * Shared Postgres connection pool.
 */

require('dotenv').config();
const { Pool } = require('pg');

let _pool = null;

function pool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on('error', (err) => console.error('[db] unexpected pool error:', err.message));
  }
  return _pool;
}

async function query(sql, params = []) {
  return pool().query(sql, params);
}

async function end() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

module.exports = { pool, query, end };
