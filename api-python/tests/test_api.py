import os
import time

# Must be set BEFORE importing the app: no background heartbeat, and a
# database address that goes nowhere so nothing can accidentally connect.
os.environ["HEARTBEAT_ENABLED"] = "false"
os.environ.setdefault("DB_HOST", "203.0.113.1")   # TEST-NET-3, guaranteed unroutable
os.environ.setdefault("DB_CONNECT_TIMEOUT", "30")
os.environ.setdefault("API_PREFIX", "")

from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402

client = TestClient(app)


def test_health_returns_200():
    r = client.get("/health")
    assert r.status_code == 200


def test_health_does_not_touch_the_database():
    """
    DB_CONNECT_TIMEOUT is 30s and DB_HOST is unroutable. If /health touched
    the database it would block for 30 seconds. It must answer instantly.
    """
    start = time.monotonic()
    r = client.get("/health")
    elapsed = time.monotonic() - start
    assert r.status_code == 200
    assert elapsed < 1.0, f"/health took {elapsed:.1f}s - it is touching the database"


def test_info_has_expected_shape_and_no_password():
    r = client.get("/api/info")
    assert r.status_code == 200
    body = r.json()
    for key in ("service", "commit_sha", "build_time"):
        assert key in body, f"missing key: {key}"
    assert "secret" not in r.text.lower() or "REDACTED" in r.text
