#!/bin/bash
# One-shot installer: fills the launchd plist with real paths and loads it.
# Run from inside the flightwatch folder:  bash install.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "❌ node not found on PATH. Install Node 18+ first (e.g. 'brew install node')."; exit 1; fi

PLIST_SRC="$DIR/com.flightwatch.agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.flightwatch.agent.plist"

sed -e "s#__NODE_PATH__#$NODE#g" -e "s#__PROJECT_DIR__#$DIR#g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "✅ Installed. flightwatch will run at 08:00 and 20:00 daily."
echo "   Log:    $DIR/flightwatch.log"
echo "   Remove: launchctl unload \"$PLIST_DST\" && rm \"$PLIST_DST\""
