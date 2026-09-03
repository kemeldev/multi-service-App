# 3-Tier Test App

A three-tier app for testing **ports, connectivity, CORS, firewalls
and DB reachability**. Nothing here is business logic.

```
  Tier 1                    Tier 2                        Tier 3
  ------                    ------                        ------
                     +--> FastAPI  :8001 --> table py_heartbeat --+
  React UI :5173 ----|                                            +--> Postgres :5432
                     +--> Express  :8002 --> table node_heartbeat-+
```

Each tier is a **separate, independently runnable app** with its own `.env`. You can run
them on one box, on three boxes, or in three containers - nothing is shared but the
Postgres credentials.

## Every tier is browsable on its own

You do not need the React app to see a result. **Open either API directly in a browser**
and you get a full HTML status page (auto-refreshing every 5s) with the same information
the React card shows:

| URL | What you get |
| --- | --- |
| http://localhost:8001/ | FastAPI status page (HTML) |
| http://localhost:8002/ | Express status page (HTML) |
| http://localhost:5173/ | React UI showing both at once |

The JSON endpoints are pretty-printed, so they are readable straight in a browser tab too:

| Endpoint | Purpose |
| --- | --- |
| `GET /` | human-readable HTML status page |
| `GET /health` | liveness only, **never touches the DB** - use for LB / k8s probes |
| `GET /api/info` | service name, stack, host, port, table it owns, DB target (password redacted) |
| `GET /api/db` | live `NOW()`, server version, row count, last 5 heartbeat rows, write counters |
| `GET /docs` | Swagger UI (FastAPI only) |

`/api/db` always returns **200**, even when Postgres is down - the DB state is in the body
(`db_status`, `error`), so a client can tell "API down" apart from "DB down".

## What it proves

| Question | Where you see it |
| --- | --- |
| Can the browser reach each API? | green/red dot + round-trip latency per card |
| Is CORS configured right? | a CORS block shows as "API unreachable" with hints |
| Can each API reach Postgres? | live `SELECT NOW()` clock |
| Is state actually persisting? | row count of each service's heartbeat table |

Each backend **creates its own table** on startup and **inserts one row every
`HEARTBEAT_SECONDS`** (default 10). Restart a service and the row count keeps climbing
from where it left off - that is the persistence proof. The two backends never share a
table, so you can kill one and watch the other keep writing.

---

## Quick start

The DB does not need to be reachable. Both APIs start fine without it, report
`db_status: "down"`, and keep retrying in the background.

### 1. FastAPI (port 8001)

```powershell
cd api-python
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
```

### 2. Node/Express (port 8002)

```powershell
cd api-node
npm install
npm start
```

### 3. React UI (port 5173)

```powershell
cd frontend
npm install
npm run dev
```

`.env` files are already created from the `.env.example` templates.

---

## The database

Both APIs are already configured for this container:

```bash
docker volume create postgres_test_data

docker run -d \
  --name postgres-test \
  -e POSTGRES_USER=testuser \
  -e POSTGRES_PASSWORD='1234' \
  -e POSTGRES_DB=testdb \
  -p 5432:5432 \
  -v postgres_test_data:/var/lib/postgresql/data \
  --restart unless-stopped \
  postgres:16
```

The same thing as a compose file: `docker compose -f docker-compose.db.yml up -d`

### Gotcha: `POSTGRES_PASSWORD` only applies to an EMPTY volume

Worth knowing if `docker run` seems to set a password that does not work.

`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` are read **only when the data
directory is initialised**. If `postgres_test_data` already contained a database from an
earlier run, those variables are silently ignored and the old credentials remain - which
shows up as `password authentication failed for user "testuser"` even though the
`docker run` clearly set the password.

Confirm it on the DB host:

```bash
docker logs postgres-test | head -20
# "Database directory appears to contain a database; Skipping initialization"
#   -> the volume was reused, your env vars did nothing
```

Fix it either by setting the password on the existing database:

```bash
docker exec -it postgres-test psql -U postgres -c "ALTER USER testuser WITH PASSWORD '1234';"
```

or by starting clean (**this deletes the volume's data**):

```bash
docker rm -f postgres-test
docker volume rm postgres_test_data
# then re-run the docker volume create + docker run above
```

No restart of the APIs is needed afterwards - the heartbeat loop retries every 10s and
reconnects on its own.

### Set `DB_HOST` to wherever that container runs

This is the one value you have to get right.

| Where the container runs | `DB_HOST` in both `.env` files |
| --- | --- |
| Same machine as the APIs | `localhost` |
| A Linux box / VM / another host | that host's name or IP - **currently `ubuntuserver1.ssa.veeam.local` (172.31.17.182)** |
| Docker Desktop, APIs on the host | `localhost` |
| APIs also in containers, same compose network | `postgres-test` (the container name) |

Then **restart that service**. No code changes, no rebuild.

Check reachability first - if this fails, it is a network problem, not an app problem:

```powershell
Test-NetConnection -ComputerName <DB_HOST> -Port 5432
```

### All DB variables

**`api-python/.env`**

| Variable | Current | Meaning |
| --- | --- | --- |
| `DB_HOST` | `ubuntuserver1.ssa.veeam.local` | hostname or IP of the Postgres server |
| `DB_PORT` | `5432` | published port |
| `DB_NAME` | `testdb` | database name |
| `DB_USER` | `testuser` | username |
| `DB_PASSWORD` | *(set in `.env`)* | password - kept out of `.env.example` and this README |
| `DB_SSLMODE` | `disable` | `disable` \| `prefer` \| `require` \| `verify-full` |
| `DB_CONNECT_TIMEOUT` | `3` | seconds per connect attempt - **keep this small**, see below |

**`api-node/.env`** - same, except SSL is a boolean:

| Variable | Current | Meaning |
| --- | --- | --- |
| `DB_SSL` | `false` | `true` for managed Postgres (RDS, Azure, Neon...) |

The `postgres:16` image does not enable SSL, so `disable` / `false` is correct for this
container. Switch to `require` / `true` for a managed cloud database.

The app user needs `CONNECT`, `CREATE TABLE` (once), plus `INSERT`/`SELECT`. `testuser`
owns `testdb`, so it already has all of that. If you later use a restricted user that
cannot create tables, run [`db/init.sql`](db/init.sql) as an admin first.

### Why `DB_CONNECT_TIMEOUT` is small

An unreachable host burns the full timeout **per resolved address**, and `localhost`
resolves to both `::1` and `127.0.0.1` - so a 5s timeout means a 10s hang on every
request. That is enough to make a perfectly healthy API look dead to a browser.

Two things prevent that:

- **Short timeout** (3s) by default.
- **A circuit breaker**: when the background heartbeat has just failed, `/api/db` answers
  instantly from that cached result instead of retrying inline. You can see which happened
  in the `probe` field of the response (`live` vs `cached`). The heartbeat keeps retrying
  on its own, so recovery is automatic - nothing to restart when the DB comes back.

The UI also probes `/api/info` and `/api/db` **independently**, so a slow database can
never make an API card go red.

---

## Pointing the UI at other hosts

The frontend reads its backend URLs at **build time**:

```ini
# frontend/.env
VITE_PY_API=http://10.0.0.21:8001
VITE_NODE_API=http://10.0.0.22:8002
VITE_POLL_MS=5000
```

Use the address **the browser** can reach - not `localhost` if you open the UI from
another machine. Restart `npm run dev` (or rebuild) after changing these.

When the UI is not on `localhost`, add its origin to each API's `CORS_ORIGINS`:

```ini
CORS_ORIGINS=http://10.0.0.5:5173,http://myhost:5173
```

## Changing ports

| App | Variable | Default |
| --- | --- | --- |
| frontend | `APP_PORT` in `frontend/.env` | 5173 |
| FastAPI | `APP_PORT` in `api-python/.env` | 8001 |
| Express | `APP_PORT` in `api-node/.env` | 8002 |

All three bind `0.0.0.0`, so they are reachable from other machines once the firewall
allows the port.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Card red, "Failed to fetch" | API not running, wrong port, firewall, or CORS |
| Card red but `curl` works on the server | CORS, or the browser cannot route to that IP |
| Card amber, `ECONNREFUSED` | API is fine; nothing is listening on `DB_HOST:DB_PORT` |
| Card amber, `connection timeout expired` | firewall/security group between the API and Postgres, or wrong IP |
| Card amber, `password authentication failed` | wrong `DB_USER` / `DB_PASSWORD` - **or the volume gotcha below** |
| Card amber, `database "..." does not exist` | wrong `DB_NAME` |
| Card amber, `no pg_hba.conf entry` | Postgres is not accepting your source IP or SSL mode |
| Row count stuck | the app user cannot `INSERT`, or the table was never created |
