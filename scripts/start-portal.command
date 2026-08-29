#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

export PORT="${PORT:-4317}"
export HOST="${HOST:-127.0.0.1}"

NODE_BIN="/Users/carlosp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

echo "Starting Scholarship Agent portal at http://${HOST}:${PORT}/"
echo "Login: parent@example.com"
echo "Password: change-me-now"
echo
echo "Leave this window open while using the portal."
echo

exec "$NODE_BIN" --disable-warning=ExperimentalWarning src/server.ts
