import { useEffect, useState, useCallback } from 'react';

const POLL_MS = Number(import.meta.env.VITE_POLL_MS || 5000);

const SERVICES = [
  { key: 'python', label: 'FastAPI (Python)', base: import.meta.env.VITE_PY_API || 'http://localhost:8001' },
  { key: 'node', label: 'Express (Node.js)', base: import.meta.env.VITE_NODE_API || 'http://localhost:8002' },
];

/**
 * Fetches JSON data from a URL, automatically aborting the request
 * if it takes longer than `timeoutMs` to respond.
 *
 * @param {string} url - The endpoint to fetch data from.
 * @param {number} [timeoutMs=8000] - Max time (in ms) to wait before aborting the request.
 * @returns {Promise<any>} Resolves with the parsed JSON response body.
 * @throws {Error} If the response status is not OK (e.g. 404, 500), with the status code/text.
 * @throws {DOMException} "AbortError" if the request exceeds `timeoutMs`.
 *
 * How it works:
 * 1. Creates an AbortController and schedules it to fire after `timeoutMs`,
 *    acting as a timeout for the fetch call.
 * 2. Passes the controller's signal to `fetch` so the request can be cancelled.
 * 3. Checks `res.ok` manually, since fetch does not reject on HTTP error statuses.
 * 4. Parses and returns the response body as JSON.
 * 5. Clears the timeout in a `finally` block so it doesn't linger after
 *    the request completes (success, failure, or abort).
 */
async function getJson(url, timeoutMs = 8000) {
  // Create an AbortController to allow us to cancel the fetch if it takes too long.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function errText(err) {
  // A CORS block or a dead port both surface as "Failed to fetch" here.
  return err?.name === 'AbortError' ? 'Request timed out' : String(err?.message || err);
}

/**
 * Probes one backend. /api/info and /api/db are probed INDEPENDENTLY and with
 * different timeouts on purpose: /api/db has to wait on a possibly-unreachable
 * Postgres, and a slow database must never make a perfectly healthy API look
 * dead. Reachability is decided by /api/info alone, which never touches the DB.
 */
async function probe(base) {
  // Start the timer before any fetches, so we can measure total latency.
  const started = performance.now();
  // Probe both endpoints in parallel, with different timeouts.
  const infoP = getJson(`${base}/api/info`, 6000);
  const dbP = getJson(`${base}/api/db`, 25000);

  // Wait for both probes to finish, but don't throw on failure: we want to
  const infoRes = await infoP.then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e }),
  );
  // The latency is measured from the start of the probe to the end of the /api/info probe,
  // because /api/db can take a long time if Postgres is down, and we don't want
  // that to make the API look slow or unreachable. 
  const latencyMs = Math.round(performance.now() - started);
  // Probe /api/db independently, but don't let it block the result of /api/info.
  const dbRes = await dbP.then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, e }),
  );

  // Return a structured result that the UI can render.
  return {
    reachable: infoRes.ok,
    latencyMs,
    info: infoRes.ok ? infoRes.v : null,
    db: dbRes.ok ? dbRes.v : null,
    error: infoRes.ok ? null : errText(infoRes.e),
    dbProbeError: dbRes.ok ? null : errText(dbRes.e),
  };
}

/**
 * Formats an ISO date string for display.
 * Returns '--' if `iso` is missing, the locale-formatted date/time if valid,
 * or the original string unchanged if it can't be parsed as a date.
 * date string (e.g. "2024-03-15T10:30:00Z"   -> "3/15/2024, 10:30:00 AM" in en-US locale).
 */
function fmt(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Dot({ tone }) {
  return <span className={`dot dot-${tone}`} />;
}

function Row({ label, children, mono }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className={mono ? 'row-value mono' : 'row-value'}>{children}</span>
    </div>
  );
}

// 
function ServiceCard({ label, base, result }) {
  if (!result) {
    return (
      <section className="card">
        <header className="card-head">
          <Dot tone="idle" />
          <h2>{label}</h2>
        </header>
        <p className="muted">Probing {base} ...</p>
      </section>
    );
  }

  const { reachable, latencyMs, info, db, error, dbProbeError } = result;
  const dbUp = db?.db_status === 'up';
  const tone = !reachable ? 'bad' : dbUp ? 'good' : 'warn';

  return (
    <section className="card">
      <header className="card-head">
        <Dot tone={tone} />
        <h2>{label}</h2>
        <span className="badge">{reachable ? `${latencyMs} ms` : 'unreachable'}</span>
      </header>

      <Row label="Endpoint" mono>
        <a href={base} target="_blank" rel="noreferrer">{base}</a>
      </Row>
      <div className="links small">
        Open directly:{' '}
        <a href={base} target="_blank" rel="noreferrer">status page</a>{' '}
        <a href={`${base}/api/db`} target="_blank" rel="noreferrer">/api/db</a>{' '}
        <a href={`${base}/api/info`} target="_blank" rel="noreferrer">/api/info</a>{' '}
        <a href={`${base}/health`} target="_blank" rel="noreferrer">/health</a>
      </div>

      {/* tier 2: is the API itself up? */}
      {!reachable && (
        <div className="alert alert-bad">
          <strong>API unreachable.</strong>
          <div className="mono small">{error}</div>
          <ul className="hints">
            <li>Is the service started and listening on that port?</li>
            <li>Right host/IP for this browser (not <code>localhost</code> if remote)?</li>
            <li>Firewall / security group open on the port?</li>
            <li>Is your origin allowed by <code>CORS_ORIGINS</code>?</li>
          </ul>
        </div>
      )}

      {reachable && (
        <>
          <Row label="Stack">{info.stack}</Row>
          <Row label="Serving from" mono>{info.host}:{info.port}</Row>
          <Row label="DB target" mono>{info.db_target}</Row>
          <Row label="Owns table" mono>{info.table}</Row>

          {/* tier 3: is Postgres up behind it? */}
          {!dbUp ? (
            <div className="alert alert-warn">
              <strong>API is up, database is not connected yet.</strong>
              <div className="small">
                Once you fill the DB credentials in this service's <code>.env</code> and
                restart it, this panel will show the live Postgres clock, the row count of{' '}
                <code className="mono">{info.table}</code>, and the last few heartbeat rows
                it wrote.
              </div>
              {db?.error && <div className="mono small err">{db.error}</div>}
              {!db && dbProbeError && (
                <div className="mono small err">
                  /api/db probe failed: {dbProbeError}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="clock">
                <span className="clock-label">Postgres NOW()</span>
                <span className="clock-value mono">{fmt(db.db_time)}</span>
              </div>
              <Row label="Server">{db.db_version}</Row>
              <Row label="Rows written">
                {db.row_count}{' '}
                <span className="muted">
                  ({db.writes_ok} ok / {db.writes_failed} failed this run)
                </span>
              </Row>
              <Row label="Last write">{fmt(db.last_write_at)}</Row>

              <details open className="recent">
                <summary>Last {db.recent.length} rows in {db.table}</summary>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>id</th><th>host</th><th>message</th><th>created_at</th></tr>
                    </thead>
                    <tbody>
                      {db.recent.map((r) => (
                        <tr key={r.id}>
                          <td className="mono">{r.id}</td>
                          <td className="mono">{r.host}</td>
                          <td>{r.message}</td>
                          <td className="mono">{fmt(r.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </section>
  );
}

export default function App() {
  const [results, setResults] = useState({});
  const [lastPoll, setLastPoll] = useState(null);
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    setBusy(true);
    const entries = await Promise.all(
      SERVICES.map(async (s) => [s.key, await probe(s.base)]),
    );
    setResults(Object.fromEntries(entries));
    setLastPoll(new Date());
    setBusy(false);
  }, []);

  // Self-scheduling rather than setInterval: one probe can take many seconds
  // when a DB is unreachable, and overlapping polls would stack up requests.
  useEffect(() => {
    let alive = true;
    let timer;
    (async function loop() {
      await poll();
      if (alive) timer = setTimeout(loop, POLL_MS);
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [poll]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>3-Tier Connectivity Test</h1>
          <p className="muted">
            React UI &rarr; two independent APIs &rarr; one Postgres. Each API owns its own
            table and writes a heartbeat row on a timer, so the row count proves persistence
            across restarts.
          </p>
        </div>
        <div className="controls">
          <button onClick={poll} disabled={busy}>{busy ? 'Polling...' : 'Refresh now'}</button>
          <span className="muted small">
            auto every {POLL_MS / 1000}s{lastPoll ? ` - last ${lastPoll.toLocaleTimeString()}` : ''}
          </span>
        </div>
      </header>

      <div className="grid">
        {SERVICES.map((s) => (
          <ServiceCard key={s.key} label={s.label} base={s.base} result={results[s.key]} />
        ))}
      </div>

      <footer className="legend muted small">
        <span><Dot tone="good" /> API + DB up</span>
        <span><Dot tone="warn" /> API up, DB down</span>
        <span><Dot tone="bad" /> API unreachable</span>
      </footer>
    </div>
  );
}
