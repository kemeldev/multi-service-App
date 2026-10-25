"""
Deletes heartbeat rows older than RETENTION_MINUTES from both tables.

Designed to run as a Kubernetes Job: it does its work, prints a summary,
and exits. Exit code 0 means success; anything else means failure.

FAIL_MODE exists only for the lab exercises:
  ""      normal behaviour
  "error" exit 1 immediately, to test retries
  "slow"  sleep SLOW_SECONDS before working, to test overlapping schedules
"""
import os
import sys
import time

import psycopg
from psycopg import sql

TABLES = ["py_heartbeat", "node_heartbeat"]


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and not value:
        print(f"ERROR: required environment variable {name} is not set", file=sys.stderr)
        sys.exit(2)
    return value


def main():
    retention = int(env("RETENTION_MINUTES", "10"))
    ts_column = env("TS_COLUMN", "created_at")
    fail_mode = env("FAIL_MODE", "")

    print(f"cleanup starting: retention={retention}m column={ts_column} pod={os.environ.get('HOSTNAME')}")

    if fail_mode == "error":
        print("FAIL_MODE=error: exiting with code 1", file=sys.stderr)
        sys.exit(1)

    if fail_mode == "slow":
        seconds = int(env("SLOW_SECONDS", "90"))
        print(f"FAIL_MODE=slow: sleeping {seconds}s before working")
        time.sleep(seconds)

    conn = psycopg.connect(
        host=env("DB_HOST", required=True),
        port=int(env("DB_PORT", "5432")),
        dbname=env("DB_NAME", required=True),
        user=env("DB_USER", required=True),
        password=env("DB_PASSWORD", required=True),
        connect_timeout=int(env("DB_CONNECT_TIMEOUT", "5")),
    )

    total = 0
    with conn:
        with conn.cursor() as cur:
            for table in TABLES:
                query = sql.SQL(
                    "DELETE FROM {table} WHERE {col} < now() - make_interval(mins => %s)"
                ).format(table=sql.Identifier(table), col=sql.Identifier(ts_column))
                cur.execute(query, (retention,))
                print(f"  {table}: deleted {cur.rowcount} rows")
                total += cur.rowcount

    print(f"cleanup finished: {total} rows deleted in total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
