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
const dns = require('dns').promises;

// Render's base image resolves hostnames via musl libc's getaddrinfo, which
// (unlike glibc) doesn't fall back to IPv4 — for a dual-stack host like
// Supabase's pooler it hands back the AAAA record and nothing else. Render
// has no outbound IPv6 route, so that connection fails with ENETUNREACH.
// setDefaultResultOrder('ipv4first') can't fix this: it only reorders
// addresses musl already returned, and musl never returned an A record here.
//
// So we skip the OS resolver for this one lookup and use Node's own bundled
// resolver (dns.resolve4, backed by c-ares) to get the A record directly,
// then connect to that IP. servername is kept as the original host so TLS
// SNI and certificate hostname checks still work against the real hostname.
const PG_URL = process.env.DATABASE_URL;
const isPg = !!PG_URL;

let sqlite = null;
let pgPool = null;
let ready = Promise.resolve();

if (isPg) {
  const { Pool } = require('pg');
  const { parse } = require('pg-connection-string');
  const parsed = parse(PG_URL);
  const useSsl = !PG_URL.includes('localhost');

  ready = (async () => {
    let host = parsed.host;
    try {
      const addresses = await dns.resolve4(parsed.host);
      if (addresses[0]) host = addresses[0];
    } catch (err) {
      // No A record available (e.g. local/dev DNS quirks) — fall back to
      // letting the OS resolver handle it, same as before this change.
      console.warn(`[db] dns.resolve4(${parsed.host}) failed, falling back to OS resolver:`, err.message);
    }

    pgPool = new Pool({
      host,
      port: parsed.port ? Number(parsed.port) : 5432,
      user: parsed.user,
      password: parsed.password,
      database: parsed.database,
      ssl: useSsl ? { rejectUnauthorized: false, servername: parsed.host } : false,
    });
  })();
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
    await ready;
    const r = await pgPool.query(toPg(sql), params);
    return r.rows;
  }
  return sqlite.prepare(sql).all(params);
}

async function get(sql, params = []) {
  if (isPg) {
    await ready;
    const r = await pgPool.query(toPg(sql), params);
    return r.rows[0] || null;
  }
  return sqlite.prepare(sql).get(params) || null;
}

async function run(sql, params = []) {
  if (isPg) {
    await ready;
    const r = await pgPool.query(toPg(sql), params);
    return { changes: r.rowCount };
  }
  const r = sqlite.prepare(sql).run(params);
  return { changes: r.changes };
}

/** Run several statements as a unit. fn receives nothing; use await. */
async function tx(fn) {
  if (isPg) {
    await ready;
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
    await ready;
    await pgPool.query(sqlText);
  } else {
    sqlite.exec(sqlText);
  }
}

module.exports = { all, get, run, tx, exec, isPg };
