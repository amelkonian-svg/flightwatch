# flightwatch — build & handoff brief

**Purpose.** A personal Air Canada fare / fare-bucket / seat / eUpgrade watcher that runs on a home machine and pushes phone alerts (Pushover) when anything worth acting on moves on a watched route.

**Status.** Working and deployed on a Mac mini. Source of truth: **https://github.com/amelkonian-svg/flightwatch** (public). This brief is the spec for a Claude Code owner to maintain and extend it. It documents the hard-won reverse-engineering of Air Canada's private API so you don't have to rediscover it.

---

## 1. Non-negotiable constraints (learned the hard way)

1. **Headed browser only.** Air Canada is behind Akamai. A headless browser is blocked by fingerprint (the pricing API call never returns). Confirmed on both datacenter and residential IPs. `watches.json` must keep `"headless": false`.
2. **Residential IP only.** From any datacenter/cloud/CI/VPS IP the TLS connection is reset outright (curl gets HTTP 403, a real Chromium gets `ERR_CONNECTION_RESET`). This *cannot* run on a server, GitHub Actions, Lambda, etc. It must run on a home/office connection. Do not attempt proxies or IP rotation — the stable residential IP is the asset; rotating breaks it.
3. **A visible browser window appears ~15s per run.** Intended host is a headless-server Mac mini (no monitor / accessed via Screen Sharing) that stays logged in at the GUI, so nobody sees it. The mini must never sleep (`sudo pmset -c sleep 0`).
4. **Low, jittered cadence.** Twice a day at odd times (02:17 / 04:43 local) plus up to 25 min in-script random jitter, so requests never hit AC at a predictable clock minute. Do not increase frequency materially.

## 2. What it does today

- Captures AC's own `getFlightRecommendations` response via a real Chromium (response interception, not scraping the DOM).
- Builds a **booking-class "bucket" ladder** per cabin (Economy / Premium Economy / Business): every distinct booking class with its cheapest price, fare family, and #flights, sorted cheapest→most expensive. This is the dwindling signal — as cheap classes sell out they drop off the ladder and the floor price steps up.
- **Seat counts:** AC only returns an exact `seatsLeft` when inventory is low; otherwise null. Rendered as "9+ seats" (ceiling configurable via `disclosedSeatCeiling`) or the exact number when disclosed.
- **eUpgrade:** drives AC's eUpgrade toggle (picks an Aeroplan tier, default Super Elite → Business) and reports, per cabin, whether upgrade space exists, the eUpgrade credits required, and any cash co-pay.
- **Diffs** each run against saved state and **pushes Pushover alerts** on: cabin price change, cheaper bucket opening, a cheap class selling out (floor rises), seats running low/dropping, and upgrade space opening / getting cheaper. First run per watch sends a baseline ping.

## 3. Reverse-engineered Air Canada details (the valuable part)

**Search entry URL** (the browser navigates here; AC's SPA fires the API call):
```
https://www.aircanada.com/booking/ca/en/aco/search?departureDate0=DD%2FMM%2FYYYY&org0=YYZ&dest0=LIM&orgType0=A&destType0=A&departureDate1=DD%2FMM%2FYYYY&org1=LIM&orgType1=A&dest1=YYZ&destType1=A&tripType=RoundTrip&adt=2&yth=1&chd=0&inf=0&ins=0&promoCode=&isFlexible=false&isComplexItinerary=false&cabin=
```
Dates are DD/MM/YYYY, URL-encoded. It lands on `/aco/availability/rt/outbound`. The tool monitors the **outbound** bound (leading indicator for the whole trip).

**API capture.** Intercept responses whose URL matches `/lfs-appsync.*graphql/i` and whose body contains `getFlightRecommendations` + `recommendations`. It's a GraphQL POST; you cannot replay it directly (Akamai) — you must let the browser make it and read the response.

**Response shape** (the bits used):
```
data.getFlightRecommendations.responseData.recommendations[]
  .boundDetails.numberOfStops
  .boundDetails.segments[].flight.flightId        // e.g. "FLT-AC86-YYZLIM-2027-03-13T22:10:00"
  .fareDetails.cabin[]
     .cabinCode            // "Y"=Economy, "O"=Premium Economy, "J"=Business
     .seatsLeft            // usually null (see below)
     .eUpgradeStatus       // "Available" | "Unavailable" | "Ineligible" | null (only populated in eUpgrade mode)
     .offers[]
        .fareFamilyCode    // BASIC/STANDARD/FLEX/COMFORT/LATITUDE (Y); PYBASIC/PYSTANDARD/PYLATITUDE (O); EXECBASIC/EXECSTANDARD/EXECLATITUDE (J)
        .seatsLeft         // usually null
        .prices.priceSummary.totalFareRounded      // per-pax rounded price (the ladder value)
        .prices.priceSummary.totalFareAllPax       // all-pax total
        .availabilityDetails[]                      // one per segment
           .bookingClass   // the "bucket" letter (G,K,L,T,S,V,H,... in Y)
           .fareBasisCode
           .eUpgradeInfo   // null unless eUpgrade mode (see below)
```
A "bucket" = the itinerary's booking class(es), de-duped across segments (e.g. "G", "K/G").

**seatsLeft disclosure.** AC only fills `seatsLeft` when inventory is low (the "Only N left" the site shows, cap ≈ 9). For far-out dates it is null across the board. Treat null as "≥ ceiling"; a number as exact. It will start appearing on its own as the date nears.

**eUpgrade mechanism (no login required).** On the results page there is an **eUpgrades** toggle. Opening it shows two comboboxes — "Upgrade to" (cabin) and "Your Aeroplan Elite status" (25K/35K/50K/75K/Super Elite) — and a **View** button. Selecting a tier + View re-fires `getFlightRecommendations` with an extra variable:
```
variables.input.eUpgrade = { "cabin": "J", "tierCode": "SE" }   // J=Business, SE=Super Elite
```
The response is a **superset** of the normal one (same fares/buckets) with these now populated:
- `cabin.eUpgradeStatus`: Available / Unavailable / Ineligible.
- `availabilityDetails[].eUpgradeInfo`: `{ status, isInClearanceWindow, credits, additionalAmount }`.
  - status ∈ { "Available", "AvailableOutsideClearance", "Unavailable", "UnavailableOutsideClearance", "Ineligible" }.
  - "Available*" = an upgrade seat exists (Outside... = space exists but the clearance window hasn't opened yet; it clears near departure). "Ineligible" = fare not upgradeable (Basic fares, partner-operated legs).
  - `credits` = eUpgrade credits (per leg; the tool sums legs). `additionalAmount` = cash co-pay (e.g. $900 on deep-discount fares, $0 on higher).

**Playwright selectors for the eUpgrade dialog** (Angular Material overlay; use force-clicks):
- Open: `page.getByText(/eUpgrade/i).first().click()`
- "Upgrade to" combobox: `getByRole('combobox',{name:/Upgrade to/i})`, option `li[option-value="J"]` (or "O").
- Status combobox: `getByRole('combobox',{name:/Aeroplan Elite status/i})`, option `li[option-value="SE"]` (Super Elite; other tiers have their own option-value codes).
- Apply: `button[type="submit"]:has-text("View")`.
- Detect the eUpgrade-mode response by `/"eUpgradeInfo":\s*\{/` in the body (populated object vs `null`).

## 4. Architecture / files
- `flightwatch.js` — single-file app: env loader, `buildSearchUrl`, `captureRecommendations` (+ `driveEUpgrade`), `extractSnapshot` (parsing incl. eUpgrade), ladder formatting (`compactLadder`/`fullLadder`/`euText`), `diff`, `pushover`, `runWatch`, `main` (jitter + persistent Chromium). Functions are exported and `main()` only runs when invoked directly, so parsing can be unit-tested offline.
- `watches.json` — user-owned config (gitignored). `watches.example.json` — template.
- `add-watch.js` — interactive prompt to append a watch.
- `install.sh` — fills the launchd plist with real paths and loads it.
- `setup.sh` — one-command bootstrap (deps + browser + keys + test + schedule).
- `update.sh` — curl-pull latest code, preserving watches.json/.env/state.
- `com.flightwatch.agent.plist` — launchd template (02:17 & 04:43 local).
- `.env` — `PUSHOVER_TOKEN` (app/API token) + `PUSHOVER_USER` (user key). Gitignored.
- `state/<id>.json` — per-watch last snapshot; diffs computed against it.
- Node 18+, Playwright (bundled Chromium). No build step.

## 5. Config schema (watches.json)
```jsonc
{
  "headless": false,                 // must stay false
  "seatThreshold": 4,                // seats-left at/below this triggers a low-seats alert
  "disclosedSeatCeiling": 9,         // null seatsLeft renders as "9+ seats"
  "jitterMaxMinutes": 25,            // random pre-run delay (0 disables; NOJITTER=1 env also disables)
  "eUpgrade": { "enabled": true, "cabin": "J", "tierCode": "SE" },  // top-level default; per-watch override allowed
  "triggers": { "priceChange": true, "seatsLow": true, "cheaperBucket": true, "eUpgrade": true },
  "watches": [
    { "id": "lima-mar2027", "name": "...", "origin": "YYZ", "destination": "LIM",
      "departureDate": "2027-03-13", "returnDate": "2027-03-21", "promoCode": "",
      "passengers": { "adt": 2, "yth": 1, "chd": 0, "inf": 0, "ins": 0 },
      "seatThreshold": 4 }           // optional per-watch overrides: seatThreshold, eUpgrade
  ]
}
```

## 6. Deployment (Mac mini)
```
git clone https://github.com/amelkonian-svg/flightwatch.git ~/flightwatch   # or curl the tarball
cd ~/flightwatch && ./setup.sh        # deps + browser + prompts for keys + test + schedule
sudo pmset -c sleep 0                  # keep the mini awake for overnight runs
```
Update later: `./update.sh`. Manage watches: `node add-watch.js`. Manual test now: `NOJITTER=1 node flightwatch.js` (delete a `state/*.json` first to force a baseline ping). Success = a printed ladder for all cabins then `[pushover] sent`; `no pricing response captured` = blocked (headless or datacenter IP).

## 7. Pushover
Two keys in `.env`. NOTE: in the original setup the token and user key were swapped. Validate any pair via `POST https://api.pushover.net/1/users/validate.json` (`token`,`user`) → `"status":1`. TOKEN is the ~30-char application/API token; USER is the ~30-char user key.

## 8. Known limitations / gotchas
- Monitors the **outbound** bound only; round-trip total depends on the return chosen.
- eUpgrade requires driving the dialog each run (extra ~10s + selector fragility). On failure it logs and falls back to plain fares — so a selector break degrades gracefully rather than crashing. If AC changes the dialog DOM, update the selectors in `driveEUpgrade`.
- eUpgrade `credits` are summed per leg; if AC's number is itinerary-total this over-counts on connections. Verify against a known case if precision matters.
- Don't kill a run mid-capture — it can corrupt `.browser-profile` ("browser has been closed"); fix with `rm -rf .browser-profile`.
- AC can change the API shape or tighten bot detection anytime; if captures start failing, first confirm headed + residential, then re-inspect the payload.

## 9. Backlog — features to build next

### A. Remote entry of new watches from an iPhone (requested)
Goal: add a route (origin, destination, dates, passengers) from the phone without touching the mini.
- **Pushover cannot do this** — Pushover is outbound-only (server → phone); there is no inbound-message API to receive commands. Rule it out.
- **Recommended: a tiny local web form served by the mini, reached over Tailscale, saved to the iOS home screen as a web-app icon.** Build a small Express (or plain http) server (`server.js`) on the mini exposing `GET /` (a mobile-friendly form) and `POST /watch` (validates + appends to `watches.json` via the same logic as `add-watch.js`, then optionally runs one `NOJITTER=1` baseline). Bind to the Tailscale interface only (never public). Install Tailscale on the mini + iPhone; the Shortcut/home-screen icon points at `http://<mini-tailscale-name>:PORT`. This is the cleanest "iPhone app thing."
- **Lighter alternative: an iOS Shortcut over SSH.** Add `add-watch-cli.js` (non-interactive, argv: `--origin YYZ --dest LIM --dep 2027-03-13 --ret 2027-03-21 --adt 2 --yth 1 --name "..."`). The Shortcut runs `ssh mini "cd ~/flightwatch && node add-watch-cli.js ..."`. Requires SSH reachability (LAN or Tailscale) and a key. No server to maintain.
- Either way, factor the append/validate logic out of `add-watch.js` into a shared `lib/watches.js` so the CLI, the interactive prompt, and the web server all use one implementation.

### B. Other candidates
- Monitor the **return** bound too (currently outbound-only), and/or a fully-priced round-trip basket.
- Support multiple eUpgrade targets (e.g. also Premium Economy) and other Aeroplan tiers per watch (map tier → `option-value`).
- A small **history/dashboard**: append each snapshot to a per-watch JSONL and render a price/seat/upgrade timeline (self-contained HTML). Good candidate for a persisted artifact.
- Per-watch quiet hours / alert throttling; a weekly "still watching, here's the ladder" digest.
- Resilience: if `driveEUpgrade` selectors break, detect and send a one-time "eUpgrade capture needs attention" ping instead of silently falling back.

## 10. How to work on this (for the Claude Code owner)
- Read `CLAUDE.md` first (operational quick-reference). This BRIEF is the deeper spec.
- To iterate on parsing without a live capture: capture one payload to `raw.json` (drive a headed browser as in the git history's probe scripts), then `node -e "const {extractSnapshot,fullLadder}=require('./flightwatch.js'); console.log(fullLadder(extractSnapshot(JSON.parse(require('fs').readFileSync('raw.json')),4,'Business')))"`.
- Keep secrets out of git (`.env` is ignored). Keep `watches.json` user-owned (ignored); ship changes via `watches.example.json`.
- Test end-to-end on a residential machine with a visible browser before relying on a scheduled run.
