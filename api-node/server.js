/**
 * Tier 2b - Node/Express service.
 *
 * Mirrors the FastAPI service but owns its own table (`node_heartbeat`), so the
 * two backends are fully independent: either one can be stopped, moved to
 * another host or pointed at another DB without touching the other.
 *
 * Browsable in a plain browser:
 *   /            human-readable HTML status page (auto-refreshes)
 *   /health      liveness JSON, never touches the DB
 *   /admin/ready flips the in-memory readiness flag /health reports on
 *   /api/info    service metadata JSON
 *   /api/db      DB clock + heartbeat rows JSON
 */
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import os from 'node:os';
import 'dotenv/config';

// Load configuration from environment variables, with defaults for local dev.
const {
  SERVICE_NAME = 'node-service',
  APP_PORT = '8002',
  HEARTBEAT_SECONDS = '10',
  CORS_ORIGINS = '*',
  DB_HOST = 'localhost',
  DB_PORT = '5432',
  DB_NAME = 'testdb',
  DB_USER = 'testuser',
  DB_PASSWORD = '1234',
  DB_SSL = 'false',
  DB_CONNECT_TIMEOUT = '3',
} = process.env;

// The table that this service owns in Postgres. The FastAPI service has its own
const TABLE = 'node_heartbeat';

// The port to listen on, and the heartbeat interval in milliseconds.
const PORT = Number(APP_PORT);
const TICK_MS = Number(HEARTBEAT_SECONDS) * 1000;

// Redacted target string, safe to render in the UI.
const DB_TARGET = `${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} (ssl=${DB_SSL})`;

// Create a Postgres connection pool with the configured parameters. The pool will manage up to 5 concurrent connections and will use SSL if specified. The connection timeout is set based on the environment variable, converted to milliseconds.
const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  ssl: DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: Number(DB_CONNECT_TIMEOUT) * 1000,
  max: 5,
});

/** Node wraps multi-address connect failures in an AggregateError with an
 *  empty message - unwrap it so the UI shows the real reason. */
function describe(err) {
  if (err?.errors?.length) {
    return err.errors.map((e) => `${e.code || e.name}: ${e.message}`).join(' | ');
  }
  return `${err.code || err.name}: ${err.message}`;
}

const state = {
  ready: true,
  dbOk: false,
  dbError: null,
  tableReady: false,
  writesOk: 0,
  writesFailed: 0,
  lastWriteAt: null,
  lastFailAt: 0, // Date.now() of the last failed connect
  startedAt: new Date().toISOString(),
};

// A pool with no live DB emits errors on idle clients - swallow them so the
// process does not exit while Postgres is still being provisioned.
// The heartbeat loop will notice the failure and update the state accordingly.
pool.on('error', (err) => {
  state.dbError = describe(err);
});

/**
 * Circuit breaker for the request path. If the background heartbeat just failed
 * to reach Postgres, do not make HTTP clients sit through another connect
 * timeout - a firewalled host burns the full timeout per attempt, which is what
 * makes a healthy API look hung. The loop retries every HEARTBEAT_SECONDS.
 */
function breakerOpen() {
  if (state.dbOk) return false;
  return Date.now() - state.lastFailAt < TICK_MS;
}

// Ensure the heartbeat table exists. If it does not, create it. This function is called before each heartbeat attempt to guarantee that the table is ready for inserts.
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id          BIGSERIAL PRIMARY KEY,
      service     TEXT        NOT NULL,
      host        TEXT        NOT NULL,
      message     TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  state.tableReady = true;
}

// Write a heartbeat row to the database. If the table is not ready, ensure it exists first. Update the state based on the success or failure of the insert operation.
async function heartbeat() {
  try {
    if (!state.tableReady) await ensureTable();
    const { rows } = await pool.query(
      `INSERT INTO ${TABLE} (service, host, message) VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [SERVICE_NAME, os.hostname(), `tick from ${SERVICE_NAME}`],
    );
    state.dbOk = true;
    state.dbError = null;
    state.writesOk += 1;
    state.lastWriteAt = rows[0].created_at.toISOString();
  } catch (err) {
    state.dbOk = false;
    state.tableReady = false;
    state.writesFailed += 1;
    state.dbError = describe(err);
    state.lastFailAt = Date.now();
  }
}

// Build a JSON object containing service metadata, including the service name, stack information, host, port, table name, database target, heartbeat interval, and the timestamp when the service started. This information is used for the /api/info endpoint and the status page.
function buildInfo() {
  return {
    service: SERVICE_NAME,
    stack: `Express / Node ${process.version}`,
    host: os.hostname(),
    port: PORT,
    table: TABLE,
    db_target: DB_TARGET,
    heartbeat_seconds: Number(HEARTBEAT_SECONDS),
    started_at: state.startedAt,
  };
}

// Build a JSON object containing the current state of the database connection, including the service name, table name, database target, status, time, version, row count, last write timestamp, number of successful and failed writes, recent heartbeat rows, any error messages, and the probe type. This information is used for the /api/db endpoint and the status page.
async function buildDb() {
  const payload = {
    service: SERVICE_NAME,
    table: TABLE,
    db_target: DB_TARGET,
    db_status: 'down',
    db_time: null,
    db_version: null,
    row_count: null,
    last_write_at: state.lastWriteAt,
    writes_ok: state.writesOk,
    writes_failed: state.writesFailed,
    recent: [],
    error: state.dbError,
    probe: 'live',
  };

  if (breakerOpen()) {
    // Known-down: answer instantly from what the heartbeat loop learned.
    payload.probe = 'cached (last connect failed, retrying in background)';
    return payload;
  }

  try {
    const meta = await pool.query('SELECT NOW() AS now, version() AS version');
    payload.db_time = meta.rows[0].now.toISOString();
    payload.db_version = meta.rows[0].version.split(',')[0];
    payload.db_status = 'up';
    payload.error = null;
    state.dbOk = true;

    try {
      const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM ${TABLE}`);
      payload.row_count = cnt.rows[0].c;
      const recent = await pool.query(
        `SELECT id, service, host, message, created_at FROM ${TABLE}
         ORDER BY id DESC LIMIT 5`,
      );
      payload.recent = recent.rows.map((r) => ({
        ...r,
        created_at: r.created_at.toISOString(),
      }));
    } catch {
      // Connected, but the heartbeat table has not been created yet.
      payload.row_count = 0;
    }
  } catch (err) {
    payload.error = describe(err);
    state.dbOk = false;
    state.lastFailAt = Date.now();
  }

  return payload;
}

// ------------------------------------------------------------- html page ----
const PAGE_CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e9ef;--muted:#8b93a7;
--good:#35c46b;--bad:#e5534b;--accent:#58a6ff;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:32px 20px 60px}
h1{font-size:20px;margin:0 0 4px}
.mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:13px}
.muted{color:var(--muted)}.small{font-size:12px}
.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);
border-radius:20px;padding:4px 12px;font-size:13px;margin:10px 0 18px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block}
.up{background:var(--good);box-shadow:0 0 8px var(--good)}
.down{background:var(--bad);box-shadow:0 0 8px var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:18px;margin-bottom:18px}
.card h2{font-size:12px;margin:0 0 12px;text-transform:uppercase;
letter-spacing:.08em;color:var(--muted)}
.row{display:flex;gap:14px;justify-content:space-between;padding:6px 0;
border-bottom:1px dashed var(--line)}
.row:last-child{border-bottom:0}
.row .k{color:var(--muted);font-size:13px;flex:none}
.row .v{text-align:right;word-break:break-all}
.clock{background:#0d1420;border:1px solid var(--line);border-radius:8px;
padding:14px;margin-bottom:14px}
.clock .lbl{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.clock .val{font-size:19px;color:var(--good);display:block;margin-top:3px}
.alert{border-radius:8px;padding:13px;background:rgba(227,179,65,.08);
border:1px solid rgba(227,179,65,.35);margin-bottom:12px}
.alert .err{color:var(--bad);margin-top:8px;word-break:break-all}
.tw{overflow-x:auto;margin-top:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:500}
nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
nav a{color:var(--accent);text-decoration:none;border:1px solid var(--line);
border-radius:6px;padding:6px 11px;font-size:13px}
nav a:hover{border-color:var(--accent)}
`;

// Escape HTML special characters to prevent XSS in the status page.
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// Render a list of key-value pairs as HTML rows for the status page.
const rows = (pairs) =>
  pairs
    .map(
      ([k, v]) =>
        `<div class="row"><span class="k">${esc(k)}</span><span class="v mono">${esc(v)}</span></div>`,
    )
    .join('');

  // Render the database section of the status page, including the Postgres clock, row count, last write timestamp, and recent heartbeat rows. If the database is down, display an alert with instructions to configure the connection.
function dbBlock(db) {
  if (db.db_status === 'up') {
    const recent = db.recent
      .map(
        (r) =>
          `<tr><td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.host)}</td>` +
          `<td>${esc(r.message)}</td><td class="mono">${esc(r.created_at)}</td></tr>`,
      )
      .join('');
    return (
      `<div class="clock"><span class="lbl">Postgres NOW()</span>` +
      `<span class="val mono">${esc(db.db_time)}</span></div>` +
      rows([
        ['Server', db.db_version],
        [`Rows in ${db.table}`, db.row_count],
        ['Writes this run', `${db.writes_ok} ok / ${db.writes_failed} failed`],
        ['Last write', db.last_write_at || '--'],
      ]) +
      `<div class="tw"><table><thead><tr><th>id</th><th>host</th>` +
      `<th>message</th><th>created_at</th></tr></thead><tbody>${recent}</tbody></table></div>`
    );
  }

  const err = db.error ? `<div class="err mono small">${esc(db.error)}</div>` : '';
  return (
    `<div class="alert"><strong>Database not connected yet.</strong>` +
    `<div class="small muted">Set DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD in ` +
    `<span class="mono">api-node/.env</span> and restart. Then this box shows the live ` +
    `Postgres clock, the row count of <span class="mono">${esc(db.table)}</span>, and the ` +
    `last rows written.</div>${err}</div>` +
    rows([['Failed write attempts', db.writes_failed]])
  );
}

// Render the full HTML status page, including the service name, stack information, database status, and links to the API endpoints. The page auto-refreshes every 5 seconds to show the latest state of the service and database.
function renderPage(info, db) {
  const up = db.db_status === 'up';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>${esc(info.service)}</title>
<style>${PAGE_CSS}</style></head><body><div class="wrap">
<h1>${esc(info.service)}</h1>
<div class="muted small">${esc(info.stack)} &middot; tier 2 of 3</div>
<div class="pill"><span class="dot ${up ? 'up' : 'down'}"></span>API up &middot; database ${up ? 'up' : 'down'}</div>
<div class="card"><h2>Database</h2>${dbBlock(db)}</div>
<div class="card"><h2>Service</h2>${rows([
    ['Serving from', `${info.host}:${info.port}`],
    ['DB target', info.db_target],
    ['Owns table', info.table],
    ['Heartbeat every', `${info.heartbeat_seconds}s`],
    ['Started at', info.started_at],
  ])}</div>
<nav>
  <a href="/api/db">/api/db</a>
  <a href="/api/info">/api/info</a>
  <a href="/health">/health</a>
</nav>
<p class="muted small">This page refreshes every 5s.</p>
</div></body></html>`;
}

// ------------------------------------------------------------- endpoints ----
const app = express();
app.set('json spaces', 2); // readable when opened straight in a browser
app.use(
  cors({ origin: CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.split(',').map((o) => o.trim()) }),
);

/** Human-readable status page - just browse to the service root. */
app.get('/', async (_req, res) => {
  res.type('html').send(renderPage(buildInfo(), await buildDb()));
});

/** Liveness + readiness - does not touch the DB. Fails when /admin/ready has flipped the flag off. */
app.get('/health', (_req, res) => {
  res.status(state.ready ? 200 : 503).json({ status: state.ready ? 'ok' : 'error', service: SERVICE_NAME });
});

/** Admin: flips the readiness flag that /health reports on. No auth - lab use only. */
app.get('/admin/ready', (_req, res) => {
  state.ready = !state.ready;
  res.json({ ready: state.ready });
});

app.get('/api/info', (_req, res) => res.json(buildInfo()));

/** DB clock + persistent-state proof. Always 200, even when the DB is down. */
app.get('/api/db', async (_req, res) => res.json(await buildDb()));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] listening on http://0.0.0.0:${PORT}`);
  console.log(`[${SERVICE_NAME}] db target ${DB_TARGET}`);
  heartbeat();
  setInterval(heartbeat, TICK_MS);
});
