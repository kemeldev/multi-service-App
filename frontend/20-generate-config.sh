#!/bin/sh
set -eu
envsubst '${PY_API} ${NODE_API} ${POLL_MS}' \
  < /usr/share/nginx/html/config.js.template \
  > /usr/share/nginx/html/config.js
