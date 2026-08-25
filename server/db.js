/**
 * One query interface over two engines.
 *
 * SQLite is the default so the app runs with no setup at all.
 * Set DATABASE_URL to a Postgres connection string (Supabase, Neon,
 * a local server) and the same queries run there instead.
 *
 * Queries are written with ? placeholders; the Postgres path rewrites
 * them to $1, $2, ... on the way through.
 */
const path = require('path');
const fs = require('fs');

const PG_URL = process.env.DATABASE_URL;
const isPg = !!PG_URL;

let sqlite = null;
let pgPool = null;

if (isPg) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: PG_URL,
    ssl: PG_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });
} else {
  const Database = require('better-sqlite3');
  const dir = path.join(__dirname, '..', 'db');
  fs.mkdirSync(dir, { recursive: true });
  sqlite = new Database(path.join(dir, 'veridict.sqlite'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
}

/** ? -> $1, $2, ... for Postgres */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function all(sql, params = []) {
  if (isPg) {
    const r = await pgPool.query(toPg(sql), params);
    return r.rows;
  }
  return sqlite.prepare(sql).all(params);
}

async function get(sql, params = []) {
  if (isPg) {
    const r = await pgPool.query(toPg(sql), params);
    return r.rows[0] || null;
  }
  return sqlite.prepare(sql).get(params) || null;
}

async function run(sql, params = []) {
  if (isPg) {
    const r = await pgPool.query(toPg(sql), params);
    return { changes: r.rowCount };
  }
  const r = sqlite.prepare(sql).run(params);
  return { changes: r.changes };
}

/** Run several statements as a unit. fn receives nothing; use await. */
async function tx(fn) {
  if (isPg) {
    const c = await pgPool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn();
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  sqlite.exec('BEGIN');
  try {
    const out = await fn();
    sqlite.exec('COMMIT');
    return out;
  } catch (e) {
    sqlite.exec('ROLLBACK');
    throw e;
  }
}

async function exec(sqlText) {
  if (isPg) {
    await pgPool.query(sqlText);
  } else {
    sqlite.exec(sqlText);
  }
}

module.exports = { all, get, run, tx, exec, isPg };
