#!/usr/bin/env bash
set -uo pipefail

PY=${PY:-http://localhost:8001}
NODE=${NODE:-http://localhost:8002}
FE=${FE:-http://localhost:8080}
EXPECTED_SHA=${EXPECTED_SHA:-}

PASS=0
FAIL=0

check () {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS  $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $name"
    FAIL=$((FAIL+1))
  fi
}

body_has () {
  curl -fsS --max-time 5 "$1" | grep -q "$2"
}

status_is () {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1")
  [ "$code" = "$2" ]
}

echo "== liveness =="
check "python  /health is 200"   status_is "$PY/health" 200
check "node    /health is 200"   status_is "$NODE/health" 200
check "frontend /healthz is 200" status_is "$FE/healthz" 200

echo "== identity =="
if [ -n "$EXPECTED_SHA" ]; then
  check "python  reports $EXPECTED_SHA" body_has "$PY/api/info"   "$EXPECTED_SHA"
  check "node    reports $EXPECTED_SHA" body_has "$NODE/api/info" "$EXPECTED_SHA"
else
  echo "  SKIP  no EXPECTED_SHA provided"
fi

echo "== frontend serves runtime config, not build-time =="
check "config.js exists"            status_is "$FE/config.js" 200
check "config.js has the injected value" body_has "$FE/config.js" "/api/py"
check "index.html is served"        status_is "$FE/" 200

echo "== degraded dependency is handled, not fatal =="
check "python  /api/db is still 200" status_is "$PY/api/db" 200
check "node    /api/db is still 200" status_is "$NODE/api/db" 200
check "python  reports db down"      body_has "$PY/api/db" "down"
check "node    reports db down"      body_has "$NODE/api/db" "down"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
