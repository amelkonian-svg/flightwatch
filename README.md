# ✈️ flightwatch

A tiny fare-and-**fare-bucket** watcher for Air Canada that pushes to your phone via [Pushover](https://pushover.net).

It doesn't scrape the pretty price tiles — it captures Air Canada's *own* pricing API response (`getFlightRecommendations`) using a real browser, so it sees the stuff the website hides: the **booking-class bucket** behind each price, the **fare basis code**, and the **`seatsLeft`** countdown that tells you when a price is about to jump. Using a real Chromium (not a raw HTTP call) is what lets it slip past Air Canada's Akamai bot protection the same way a normal visit does.

## What it alerts you about

Per your setup, you get a Pushover ping when any of these happen on a watched route:

- **Any price change** — up or down, per cabin, with the delta and the booking class.
- **Seats-left low** — when the cheap bucket drops to a low count (default ≤ 4). This is the early warning that the fare is about to step up.
- **A cheaper bucket opens** — when a lower booking class becomes available.

First run for each watch sends a "baseline" ping so you know it's alive; after that it only pings on change.

## One-time setup (~5 min)

1. **Install Node 18+** if you don't have it: `brew install node`
2. **Install dependencies** (this also downloads the browser):
   ```bash
   cd flightwatch
   npm install
   ```
3. **Add your Pushover keys.** Copy the example and fill it in — your keys stay on your Mac, they're never written into the code:
   ```bash
   cp .env.example .env
   # then edit .env and paste your PUSHOVER_TOKEN (app/API token) and PUSHOVER_USER (user key)
   ```
   (In Pushover: your **User Key** is on the dashboard; create an **Application/API Token** for the app token.)
4. **Edit `watches.json`** to taste — your Lima trip is pre-filled. Add more objects to the `watches` array for other routes.

## Test it right now

```bash
npm start
```
You should see it capture fares and send a baseline Pushover ping. Run it a second time and it'll say "no change." To watch it work end-to-end you can lower `seatThreshold` or tweak a date and re-run.

If it prints `no pricing response captured`, Air Canada either blocked the automated browser or the date is sold out. Fix: open `watches.json` and set `"headless": false` — a visible browser window passes bot checks more reliably. (Under the scheduler, a headed window will briefly appear at run time.)

## Schedule it (twice a day: 08:00 & 20:00)

```bash
bash install.sh
```
That fills in the paths and loads a macOS `launchd` agent. Logs go to `flightwatch.log`.

To change the times, edit the `Hour`/`Minute` blocks in `com.flightwatch.agent.plist` and re-run `bash install.sh`.
To stop it:
```bash
launchctl unload ~/Library/LaunchAgents/com.flightwatch.agent.plist
rm ~/Library/LaunchAgents/com.flightwatch.agent.plist
```

> Note: `launchd` fires the job the next time your Mac is awake at (or past) the scheduled time. If the laptop is closed at 08:00, it runs when you next open it. For always-on checking you'd want it on a machine that stays awake.

## watches.json reference

```jsonc
{
  "headless": true,          // set false if Air Canada blocks the headless browser
  "seatThreshold": 4,        // "seats left" at or below this triggers the low-seats alert
  "triggers": {              // turn individual alert types on/off
    "priceChange": true,
    "seatsLow": true,
    "cheaperBucket": true
  },
  "watches": [
    {
      "id": "lima-mar2027",                 // used for the saved-state filename; keep unique
      "name": "Lima trip (YYZ↔LIM, Mar 13–21)",
      "origin": "YYZ",
      "destination": "LIM",
      "departureDate": "2027-03-13",         // ISO; converted to AC's DD/MM/YYYY automatically
      "returnDate": "2027-03-21",
      "promoCode": "",                       // optional
      "passengers": { "adt": 2, "yth": 1, "chd": 0, "inf": 0, "ins": 0 },
      "seatThreshold": 4                     // optional per-watch override
    }
  ]
}
```

## How it works (the honest version)

- It monitors the **outbound availability** fares (the numbers on Air Canada's first results page — per person, based on a round-trip purchase). That's the leading indicator for the whole trip's price and where the bucket movement shows up first.
- State is saved per watch in `state/<id>.json`, so it only alerts on *changes* between runs.
- It never stores your Pushover keys in code and never sends your data anywhere except Pushover's API.
- Everything runs locally on your Mac.

## Limitations / good to know

- Round-trip **total** depends on the return you pick; this tracks the outbound-side fares as the signal, not a fully-priced round-trip basket.
- Air Canada can change their API shape or tighten bot detection at any time; if captures start failing, flip `headless` to `false` first, and if it still fails the selectors/URL may need a refresh.
- Keep the check cadence modest (twice a day is polite). Hammering the site invites blocks.
