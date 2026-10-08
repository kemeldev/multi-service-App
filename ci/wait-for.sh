#!/usr/bin/env bash
set -euo pipefail

URL="$1"
TIMEOUT="${2:-60}"
NAME="${3:-$URL}"

echo -n "waiting for $NAME "
for i in $(seq 1 "$TIMEOUT"); do
  if curl -fsS --max-time 2 "$URL" >/dev/null 2>&1; then
    echo " ready after ${i}s"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo
echo "TIMEOUT: $NAME did not become ready within ${TIMEOUT}s" >&2
echo "last response:" >&2
curl -sS -o /dev/null -w 'http_code=%{http_code} connect=%{time_connect}s\n' --max-time 2 "$URL" >&2 || true
exit 1
