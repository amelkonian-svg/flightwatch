#!/bin/bash
# Pull the latest flightwatch code without touching your watches.json, .env, or state.
set -e
cd "$(cd "$(dirname "$0")" && pwd)"
echo "Updating flightwatch code from GitHub..."
curl -fsSL https://github.com/amelkonian-svg/flightwatch/archive/refs/heads/main.tar.gz -o /tmp/fw.tgz
tar -xzf /tmp/fw.tgz -C . --strip-components=1
rm -f /tmp/fw.tgz
npm install >/dev/null 2>&1 || true
echo "Done. (watches.json, .env, and state/ were left untouched.)"
echo "The launchd agent picks up the new code on its next scheduled run."
