#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PLIST="$ROOT/scripts/com.scholarship-agent.portal.plist"
LABEL="com.scholarship-agent.portal"
DOMAIN="gui/$(id -u)"

/bin/launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "$DOMAIN" "$PLIST"
/bin/launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Scholarship Agent portal requested via launchd."
echo "Open http://127.0.0.1:4317/"
echo "Logs: /tmp/scholarship-agent-portal.out.log and /tmp/scholarship-agent-portal.err.log"
