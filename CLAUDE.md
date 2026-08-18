# CLAUDE.md — flightwatch (SeatCounter on AC)

Context for Claude Code. Read this fully before acting.

## What this is
A real-browser Air Canada fare & fare-bucket watcher. It drives a real Chromium to
capture AC's own `getFlightRecommendations` GraphQL response, extracts the full
booking-class "bucket" ladder per cabin (+ `seatsLeft` when AC exposes it), diffs
against the last run, and pushes phone alerts via Pushover. Node + Playwright, no build step.

## CRITICAL CONSTRAINTS (do not fight these)
- **Must run headed** (`watches.json` -> `"headless": false`). AC's Akamai blocks
  headless browsers by fingerprint AND datacenter IPs by connection-reset. Verified.
- **Must run on a home/residential connection.** No cloud, CI, VPS, or container can
  run this. Do NOT try proxies/IP rotation; that breaks it. The residential IP is the asset.
- Headed means a browser window appears ~15s per run. Intended host is a **headless
  Mac mini** (no monitor / Screen Sharing) that stays logged in at the GUI, so nobody
  sees the window. The mini must never sleep: `sudo pmset -c sleep 0`.

## Layout
- `flightwatch.js` — everything: env load, URL build, capture, parse (`extractSnapshot`),
  ladder formatting (`compactLadder`/`fullLadder`), `diff`, Pushover, `main` (with jitter).
- `watches.json` — config: `headless`, `seatThreshold`, `triggers`, `jitterMaxMinutes`, `watches[]`.
- `install.sh` — fills the launchd plist with real paths and loads it.
- `setup.sh` — one-command bootstrap: npm install, playwright install, prompt for keys, test, schedule.
- `com.flightwatch.agent.plist` — launchd template (runs 02:17 & 04:43 local; script adds ≤25 min jitter).
- `.env` (gitignored) — `PUSHOVER_TOKEN` (app/API token) + `PUSHOVER_USER` (user key).
- `state/` (gitignored) — per-watch baseline snapshots; diffs are computed against these.

## Run / test
- Install + schedule from scratch: `./setup.sh`
- Manual run: `node flightwatch.js`  (delete a `state/*.json` first to force a fresh baseline ping)
- Success = a fares ladder printed for Economy/Premium Economy/Business, then `[pushover] sent`.
  `no pricing response captured` = blocked (only happens headless or from a datacenter IP).
- Change run times: edit Hour/Minute in the plist, then `bash install.sh`.
- Stop: `launchctl unload ~/Library/LaunchAgents/com.flightwatch.agent.plist && rm ~/Library/LaunchAgents/com.flightwatch.agent.plist`

## DEPLOY TASK (when asked to set this up on this Mac mini)
1. Ensure Node 18+ (`brew install node`).
2. `./setup.sh` — it prompts for the two Pushover keys. IMPORTANT: token and user key
   were historically SWAPPED. PUSHOVER_TOKEN is the ~30-char *application/API* token;
   PUSHOVER_USER is the ~30-char *user* key. Validate before trusting: a POST to
   `https://api.pushover.net/1/users/validate.json` with `token`+`user` should return `"status":1`.
3. `sudo pmset -c sleep 0` (needs the user's admin password — ask them to run it).
4. Confirm the agent is loaded: `launchctl list | grep flightwatch`.
5. Retire any stale copy at `~/TravelWatcher/flightwatch` (old code, wrong-arch browser, swapped keys).

## What it reports
Per cabin, the full ladder of booking classes with cheapest price + fare family, sorted
low→high. Alerts on: cheapest-price change per cabin, a cheaper bucket opening, a cheap
class selling out (floor rises), and seats-low/dropping. Exact seat counts are null for
far-out dates and appear automatically as AC publishes them near departure.

## Gotchas already fixed
- `state/` is auto-created (`fs.mkdirSync(STATE_DIR,{recursive:true})`) — was an ENOENT crash.
- Don't kill a run mid-capture; it can corrupt `.browser-profile`. If capture starts failing
  with "browser has been closed", `rm -rf .browser-profile` and re-run.
