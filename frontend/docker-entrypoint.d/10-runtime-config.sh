#!/bin/sh
set -eu
CONFIG_PATH="/usr/share/nginx/html/config.js"
cat > "$CONFIG_PATH" <<JSON
window.__APP_CONFIG__ = {
  pyApi:   "${PY_API:-/api/py}",
  nodeApi: "${NODE_API:-/api/node}",
  pollMs:  ${POLL_MS:-5000},
  commit:  "${COMMIT_SHA:-unknown}",
  built:   "${BUILD_TIME:-unknown}"
};
JSON
echo "runtime config written to $CONFIG_PATH"
