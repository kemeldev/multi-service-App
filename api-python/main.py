"""
Tier 2a - FastAPI service.

Talks to Postgres, owns the table `py_heartbeat`, and writes a row every
HEARTBEAT_SECONDS. Every DB call is defensive: if Postgres is unreachable the
API still answers 200 with db_status="down" so the UI can render a placeholder.

Browsable in a plain browser:
    /            human-readable HTML status page (auto-refreshes)
    /docs        Swagger UI
    /health      liveness JSON, never touches the DB
    /api/info    service metadata JSON
    /api/db      DB clock + heartbeat rows JSON
"""
import os
import time
import json
import html
import asyncio
import socket
import platform
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------- config ----
SERVICE_NAME = os.getenv("SERVICE_NAME", "fastapi-service")
APP_PORT = int(os.getenv("APP_PORT", "8001"))
HEARTBEAT_SECONDS = int(os.getenv("HEARTBEAT_SECONDS", "10"))
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "testdb")
DB_USER = os.getenv("DB_USER", "testuser")
DB_PASSWORD = os.getenv("DB_PASSWORD", "1234")
DB_SSLMODE = os.getenv("DB_SSLMODE", "prefer")

# Keep this SHORT. psycopg tries every address the host resolves to ("localhost"
# is both ::1 and 127.0.0.1), so the worst-case wait is timeout x address-count.
# A long timeout here makes /api/db look like a dead API to any HTTP client.
DB_CONNECT_TIMEOUT = int(os.getenv("DB_CONNECT_TIMEOUT", "3"))

TABLE = "py_heartbeat"

# Passed as keyword args rather than a "host=... password=..." conninfo string:
# a password containing a space, quote or backslash would silently corrupt that
# string, and test credentials are exactly where such characters show up.
CONN_PARAMS = {
    "host": DB_HOST,
    "port": DB_PORT,
    "dbname": DB_NAME,
    "user": DB_USER,
    "password": DB_PASSWORD,
    "sslmode": DB_SSLMODE,
    "connect_timeout": DB_CONNECT_TIMEOUT,
}

# Redacted version, safe to show in the UI / logs.
DB_TARGET = f"{DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME} (sslmode={DB_SSLMODE})"

# ------------------------------------------------------------ app state ----
state = {
    "db_ok": False,
    "db_error": None,
    "table_ready": False,
    "writes_ok": 0,
    "writes_failed": 0,
    "last_write_at": None,
    "last_fail_at": 0.0,  # time.monotonic() of the last failed connect
    "started_at": datetime.now(timezone.utc).isoformat(),
}


def breaker_open() -> bool:
    """
    Circuit breaker for the request path.

    If the background heartbeat just failed to reach Postgres, do not make HTTP
    clients sit through another connect timeout - an unreachable host burns
    DB_CONNECT_TIMEOUT per resolved address, which is what makes a healthy API
    look hung. The loop retries on its own every HEARTBEAT_SECONDS.
    """
    if state["db_ok"]:
        return False
    return (time.monotonic() - state["last_fail_at"]) < HEARTBEAT_SECONDS


def connect():
    return psycopg.connect(**CONN_PARAMS, row_factory=dict_row, autocommit=True)


def ensure_table():
    """Create our own table. Each service owns exactly one table."""
    with connect() as conn:
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {TABLE} (
                id          BIGSERIAL PRIMARY KEY,
                service     TEXT        NOT NULL,
                host        TEXT        NOT NULL,
                message     TEXT        NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    state["table_ready"] = True


def write_heartbeat():
    with connect() as conn:
        return conn.execute(
            f"INSERT INTO {TABLE} (service, host, message) VALUES (%s, %s, %s) "
            f"RETURNING id, created_at",
            (SERVICE_NAME, socket.gethostname(), f"tick from {SERVICE_NAME}"),
        ).fetchone()


async def heartbeat_loop():
    """Background writer. Retries forever; never kills the app."""
    while True:
        try:
            if not state["table_ready"]:
                await asyncio.to_thread(ensure_table)
            row = await asyncio.to_thread(write_heartbeat)
            state["db_ok"] = True
            state["db_error"] = None
            state["writes_ok"] += 1
            state["last_write_at"] = row["created_at"].isoformat()
        except Exception as exc:  # noqa: BLE001 - DB may simply not exist yet
            state["db_ok"] = False
            state["table_ready"] = False
            state["db_error"] = f"{type(exc).__name__}: {exc}".strip()
            state["writes_failed"] += 1
            state["last_fail_at"] = time.monotonic()
        await asyncio.sleep(HEARTBEAT_SECONDS)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(heartbeat_loop())
    yield
    task.cancel()


class PrettyJSON(JSONResponse):
    """Indented JSON so the raw endpoints are readable in a browser tab."""

    def render(self, content) -> bytes:
        return json.dumps(content, indent=2, default=str).encode("utf-8")


app = FastAPI(title=SERVICE_NAME, lifespan=lifespan, default_response_class=PrettyJSON)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------- helpers ----
def build_info() -> dict:
    return {
        "service": SERVICE_NAME,
        "stack": f"FastAPI / Python {platform.python_version()}",
        "host": socket.gethostname(),
        "port": APP_PORT,
        "table": TABLE,
        "db_target": DB_TARGET,
        "heartbeat_seconds": HEARTBEAT_SECONDS,
        "started_at": state["started_at"],
    }


def build_db() -> dict:
    payload = {
        "service": SERVICE_NAME,
        "table": TABLE,
        "db_target": DB_TARGET,
        "db_status": "down",
        "db_time": None,
        "db_version": None,
        "row_count": None,
        "last_write_at": state["last_write_at"],
        "writes_ok": state["writes_ok"],
        "writes_failed": state["writes_failed"],
        "recent": [],
        "error": state["db_error"],
        "probe": "live",
    }

    if breaker_open():
        # Known-down: answer instantly from what the heartbeat loop learned.
        payload["probe"] = "cached (last connect failed, retrying in background)"
        return payload

    try:
        with connect() as conn:
            meta = conn.execute("SELECT NOW() AS now, version() AS version").fetchone()
            payload["db_time"] = meta["now"].isoformat()
            payload["db_version"] = meta["version"].split(",")[0]
            payload["db_status"] = "up"
            payload["error"] = None
            state["db_ok"] = True

            try:
                cnt = conn.execute(f"SELECT COUNT(*) AS c FROM {TABLE}").fetchone()
                payload["row_count"] = cnt["c"]
                rows = conn.execute(
                    f"SELECT id, service, host, message, created_at FROM {TABLE} "
                    f"ORDER BY id DESC LIMIT 5"
                ).fetchall()
                payload["recent"] = [
                    {**r, "created_at": r["created_at"].isoformat()} for r in rows
                ]
            except Exception:
                # Connected, but the heartbeat table has not been created yet.
                payload["row_count"] = 0
    except Exception as exc:  # noqa: BLE001
        payload["error"] = f"{type(exc).__name__}: {exc}".strip()
        state["db_ok"] = False
        state["last_fail_at"] = time.monotonic()
    return payload


# ------------------------------------------------------------ html page ----
PAGE_CSS = """
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
"""


def _rows(pairs) -> str:
    return "".join(
        '<div class="row"><span class="k">{}</span>'
        '<span class="v mono">{}</span></div>'.format(
            html.escape(str(k)), html.escape(str(v))
        )
        for k, v in pairs
    )


def _db_block(db: dict) -> str:
    if db["db_status"] == "up":
        recent = "".join(
            "<tr><td class=\"mono\">{}</td><td class=\"mono\">{}</td>"
            "<td>{}</td><td class=\"mono\">{}</td></tr>".format(
                r["id"],
                html.escape(str(r["host"])),
                html.escape(str(r["message"])),
                html.escape(str(r["created_at"])),
            )
            for r in db["recent"]
        )
        return (
            '<div class="clock"><span class="lbl">Postgres NOW()</span>'
            '<span class="val mono">{}</span></div>'.format(
                html.escape(str(db["db_time"]))
            )
            + _rows(
                [
                    ("Server", db["db_version"]),
                    ("Rows in " + db["table"], db["row_count"]),
                    (
                        "Writes this run",
                        "{} ok / {} failed".format(db["writes_ok"], db["writes_failed"]),
                    ),
                    ("Last write", db["last_write_at"] or "--"),
                ]
            )
            + '<div class="tw"><table><thead><tr><th>id</th><th>host</th>'
            "<th>message</th><th>created_at</th></tr></thead>"
            "<tbody>{}</tbody></table></div>".format(recent)
        )

    err = (
        '<div class="err mono small">{}</div>'.format(html.escape(str(db["error"])))
        if db["error"]
        else ""
    )
    return (
        '<div class="alert"><strong>Database not connected yet.</strong>'
        '<div class="small muted">Set DB_HOST / DB_PORT / DB_NAME / DB_USER / '
        'DB_PASSWORD in <span class="mono">api-python/.env</span> and restart. Then '
        "this box shows the live Postgres clock, the row count of "
        '<span class="mono">{}</span>, and the last rows written.</div>{}</div>'.format(
            html.escape(str(db["table"])), err
        )
        + _rows([("Failed write attempts", db["writes_failed"])])
    )


def render_page(info: dict, db: dict) -> str:
    up = db["db_status"] == "up"
    return """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>{service}</title>
<style>{css}</style></head><body><div class="wrap">
<h1>{service}</h1>
<div class="muted small">{stack} &middot; tier 2 of 3</div>
<div class="pill"><span class="dot {tone}"></span>API up &middot; database {dbword}</div>
<div class="card"><h2>Database</h2>{db_block}</div>
<div class="card"><h2>Service</h2>{svc_rows}</div>
<nav>
  <a href="/api/db">/api/db</a>
  <a href="/api/info">/api/info</a>
  <a href="/health">/health</a>
  <a href="/docs">/docs (Swagger)</a>
</nav>
<p class="muted small">This page refreshes every 5s.</p>
</div></body></html>""".format(
        service=html.escape(str(info["service"])),
        stack=html.escape(str(info["stack"])),
        css=PAGE_CSS,
        tone="up" if up else "down",
        dbword="up" if up else "down",
        db_block=_db_block(db),
        svc_rows=_rows(
            [
                ("Serving from", "{}:{}".format(info["host"], info["port"])),
                ("DB target", info["db_target"]),
                ("Owns table", info["table"]),
                ("Heartbeat every", "{}s".format(info["heartbeat_seconds"])),
                ("Started at", info["started_at"]),
            ]
        ),
    )


# ------------------------------------------------------------- endpoints ----
@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def home():
    """Human-readable status page - just browse to the service root."""
    return HTMLResponse(render_page(build_info(), build_db()))


@app.get("/health")
def health():
    """Liveness only - does not touch the DB. Use this for LB / k8s probes."""
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/api/info")
def info():
    return build_info()


@app.get("/api/db")
def db_status():
    """DB clock + persistent-state proof. Always 200, even when the DB is down."""
    return build_db()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=APP_PORT)
