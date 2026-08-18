#!/bin/bash
# One-command setup for a fresh machine (e.g. the Mac mini).
# Installs deps + browser, collects Pushover keys, tests once, and schedules.
set -e
cd "$(cd "$(dirname "$0")" && pwd)"
echo "== flightwatch setup =="
command -v node >/dev/null || { echo "Install Node 18+ first:  brew install node"; exit 1; }
echo "Installing dependencies + browser (one-time, a few hundred MB)..."
npm install
npx playwright install chromium
if [ ! -f .env ]; then
  echo
  echo "Enter your Pushover keys:"
  read -rp "  PUSHOVER_TOKEN (application/API token): " TOK
  read -rp "  PUSHOVER_USER  (user key): " USR
  printf 'PUSHOVER_TOKEN=%s\nPUSHOVER_USER=%s\n' "$TOK" "$USR" > .env
  chmod 600 .env
  echo "  .env written."
fi
echo
echo "Test run (a browser window appears briefly; must show fares + 'pushover sent')..."
node flightwatch.js || true
echo
echo "Scheduling twice daily at 02:17 and 04:43 local (+ up to 25 min random jitter)..."
bash install.sh
echo "== Done. Logs: ./flightwatch.log =="
