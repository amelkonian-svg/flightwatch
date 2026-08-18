#!/usr/bin/env node
/*
 * flightwatch — a real-browser Air Canada fare & bucket watcher.
 *
 * Captures Air Canada's own Low Fare Search API response
 * (getFlightRecommendations) via a real Chromium, extracts the full
 * booking-class "bucket" ladder per cabin (with seats-left when AC
 * exposes it), diffs it against the last run, and pushes to Pushover
 * when something you care about changes.
 *
 * IMPORTANT: Air Canada blocks headless browsers and datacenter IPs.
 * Run this on a normal machine on a home/residential connection with
 * "headless": false. A small random start delay ("jitter") plus odd
 * run times keep the request pattern from looking robotic.
 *
 * No secrets live in this file. Pushover creds come from .env / env.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const STATE_DIR = path.join(DIR, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------- tiny .env loader (no dependency) ----------
(function loadEnv() {
  const envPath = path.join(DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER = process.env.PUSHOVER_USER;

const CABIN_NAMES = { Y: 'Economy', O: 'Premium Economy', J: 'Business', P: 'Premium Economy', N: 'Economy' };
const CABIN_ORDER = ['Economy', 'Premium Economy', 'Business'];

// ---------- helpers ----------
const log = (...a) => console.log(new Date().toISOString(), ...a);
const money = n => '$' + Number(n).toLocaleString('en-CA');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ddmmyyyy(iso) {
  const [y, m, d] = iso.split('-');
  return encodeURIComponent(`${d}/${m}/${y}`);
}

function buildSearchUrl(w) {
  const p = w.passengers || {};
  const q = [
    `departureDate0=${ddmmyyyy(w.departureDate)}`,
    `org0=${w.origin}`, `dest0=${w.destination}`, `orgType0=A`, `destType0=A`,
    `departureDate1=${ddmmyyyy(w.returnDate)}`,
    `org1=${w.destination}`, `orgType1=A`, `dest1=${w.origin}`, `destType1=A`,
    `tripType=RoundTrip`,
    `adt=${p.adt ?? 1}`, `yth=${p.yth ?? 0}`, `chd=${p.chd ?? 0}`,
    `inf=${p.inf ?? 0}`, `ins=${p.ins ?? 0}`,
    `promoCode=${w.promoCode || ''}`,
    `isFlexible=false`, `isComplexItinerary=false`, `cabin=`,
  ].join('&');
  return `https://www.aircanada.com/booking/ca/en/aco/search?${q}`;
}

function extractSnapshot(payload, seatThreshold) {
  const recs = payload?.data?.getFlightRecommendations?.responseData?.recommendations || [];
  const cabins = {};

  for (const rec of recs) {
    const bd = rec.boundDetails || {};
    const segs = bd.segments || [];
    const flight = segs.map(s => (s.flight?.flightId || s.flight?.marketingAirline?.code || '')).filter(Boolean).join('+') || '(flight)';

    for (const cab of (rec.fareDetails?.cabin || [])) {
      const name = CABIN_NAMES[cab.cabinCode] || cab.cabinCode || '?';
      const c = cabins[name] ||= { buckets: {} };

      for (const off of (cab.offers || [])) {
        const total = off.prices?.priceSummary?.totalFareRounded;
        if (total == null) continue;
        const allPax = off.prices?.priceSummary?.totalFareAllPax ?? null;
        const ad = off.availabilityDetails || [];
        const classes = ad.map(a => a.bookingClass).filter(Boolean);
        const bucket = [...new Set(classes)].join('/') || '?';
        const ff = off.fareFamilyCode || '?';
        const seatsLeft = off.seatsLeft ?? cab.seatsLeft ?? null;

        const b = c.buckets[bucket] ||= { bucket, perPax: total, allPax, fareFamily: ff, seatsLeft, flights: new Set() };
        if (total < b.perPax) { b.perPax = total; b.allPax = allPax; b.fareFamily = ff; }
        if (seatsLeft != null) b.seatsLeft = (b.seatsLeft == null) ? seatsLeft : Math.min(b.seatsLeft, seatsLeft);
        b.flights.add(flight);
      }
    }
  }

  const out = { ts: new Date().toISOString(), cabins: {}, lowSeats: [] };
  for (const [name, c] of Object.entries(cabins)) {
    const ladder = Object.values(c.buckets)
      .map(b => ({ bucket: b.bucket, perPax: b.perPax, allPax: b.allPax, fareFamily: b.fareFamily, seatsLeft: b.seatsLeft, flights: b.flights.size }))
      .sort((a, b) => a.perPax - b.perPax);
    out.cabins[name] = { ladder, cheapest: ladder[0] || null };
    for (const b of ladder) {
      if (b.seatsLeft != null && b.seatsLeft <= seatThreshold) {
        out.lowSeats.push({ cabin: name, bucket: b.bucket, fareFamily: b.fareFamily, seatsLeft: b.seatsLeft, perPax: b.perPax });
      }
    }
  }
  return out;
}

function orderedCabins(snap) {
  return Object.keys(snap.cabins || {}).sort((a, b) => {
    const ia = CABIN_ORDER.indexOf(a), ib = CABIN_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

function compactLadder(snap) {
  const lines = [];
  for (const name of orderedCabins(snap)) {
    const rungs = snap.cabins[name].ladder.map(b => {
      const seat = b.seatsLeft != null ? ` (${b.seatsLeft} seat${b.seatsLeft === 1 ? '' : 's'})` : '';
      return `${b.bucket} ${money(b.perPax)}${seat}`;
    });
    lines.push(`${name}: ${rungs.join(' · ')}`);
  }
  return lines.join('\n');
}

function fullLadder(snap) {
  const lines = [];
  for (const name of orderedCabins(snap)) {
    lines.push(`  ${name}:`);
    for (const b of snap.cabins[name].ladder) {
      const seat = b.seatsLeft != null ? String(b.seatsLeft) : '—';
      lines.push(`    ${b.bucket.padEnd(7)} ${money(b.perPax).padEnd(8)} ${String(b.fareFamily).padEnd(11)} seats:${seat}  (${b.flights} flt)`);
    }
  }
  return lines.join('\n');
}

function diff(prev, cur, seatThreshold, triggers) {
  const lines = [];
  for (const name of orderedCabins(cur)) {
    const c = cur.cabins[name];
    const p = prev?.cabins?.[name];
    if (!c.cheapest) continue;

    if (triggers.priceChange && p?.cheapest && p.cheapest.perPax !== c.cheapest.perPax) {
      const delta = c.cheapest.perPax - p.cheapest.perPax;
      const arrow = delta < 0 ? '▼' : '▲';
      lines.push(`${arrow} ${name}: ${money(p.cheapest.perPax)} → ${money(c.cheapest.perPax)} (${delta < 0 ? '' : '+'}${money(delta)}/pax) · class ${c.cheapest.bucket} ${c.cheapest.fareFamily}`);
    }

    if (p?.cheapest && c.cheapest.bucket !== p.cheapest.bucket) {
      if (c.cheapest.perPax < p.cheapest.perPax && triggers.cheaperBucket) {
        lines.push(`🎯 ${name}: cheaper bucket opened — now class ${c.cheapest.bucket} (${c.cheapest.fareFamily}) at ${money(c.cheapest.perPax)}/pax`);
      } else if (c.cheapest.perPax > p.cheapest.perPax) {
        lines.push(`⤴️ ${name}: class ${p.cheapest.bucket} (${money(p.cheapest.perPax)}) sold out — floor now ${c.cheapest.bucket} at ${money(c.cheapest.perPax)}/pax`);
      }
    }

    if (triggers.seatsLow && p) {
      const prevSeats = new Map((p.ladder || p.cabins?.[name]?.ladder || []).map(b => [b.bucket, b.seatsLeft]));
      for (const b of c.ladder) {
        if (b.seatsLeft == null || b.seatsLeft > seatThreshold) continue;
        const was = prevSeats.get(b.bucket);
        if (was == null || b.seatsLeft < was) {
          lines.push(`⚠️ ${name} class ${b.bucket} (${b.fareFamily}): only ${b.seatsLeft} seat${b.seatsLeft === 1 ? '' : 's'} left at ${money(b.perPax)}/pax — price may jump`);
        }
      }
    }
  }
  return lines;
}

async function pushover(title, message) {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) {
    log('  [pushover] MISSING creds — printing instead:\n  ' + title + '\n  ' + message.replace(/\n/g, '\n  '));
    return;
  }
  const body = new URLSearchParams({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title, message });
  try {
    const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body });
    log('  [pushover]', r.status === 200 ? 'sent' : 'error ' + r.status + ' ' + (await r.text()));
  } catch (e) { log('  [pushover] failed', e.message); }
}

async function captureRecommendations(context, url) {
  const page = await context.newPage();
  let payload = null;
  page.on('response', async (res) => {
    try {
      if (!/lfs-appsync.*graphql/i.test(res.url())) return;
      const txt = await res.text();
      if (/getFlightRecommendations/.test(txt) && /recommendations/.test(txt)) {
        const j = JSON.parse(txt);
        if (j?.data?.getFlightRecommendations?.responseData?.recommendations?.length) payload = j;
      }
    } catch (_) {}
  });
  await page.goto('https://www.aircanada.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 50 && !payload; i++) await page.waitForTimeout(1000);
  await page.close();
  return payload;
}

async function runWatch(context, w, cfg) {
  const seatThreshold = w.seatThreshold ?? cfg.seatThreshold ?? 4;
  const triggers = { ...{ priceChange: true, seatsLow: true, cheaperBucket: true }, ...(cfg.triggers || {}) };
  const label = `${w.origin}→${w.destination} ${w.departureDate}…${w.returnDate}`;
  log(`Watch "${w.name || label}"`);

  const url = buildSearchUrl(w);
  let payload;
  try { payload = await captureRecommendations(context, url); }
  catch (e) { log('  navigation error', e.message); return; }

  if (!payload) { log('  ⚠️ no pricing response captured (possible bot block or sold-out date) — skipping, no alert.'); return; }

  const cur = extractSnapshot(payload, seatThreshold);
  const stateFile = path.join(STATE_DIR, `${(w.id || w.name || label).replace(/[^\w.-]+/g, '_')}.json`);
  const prev = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;

  log('\n' + fullLadder(cur));

  if (!prev) {
    fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));
    await pushover(`✈️ Watch started: ${w.name || label}`, `Baseline bucket ladder:\n${compactLadder(cur)}\n\nI'll ping you when prices, buckets, or seat counts move.`);
    return;
  }

  const lines = diff(prev, cur, seatThreshold, triggers);
  fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));

  if (lines.length) {
    await pushover(`✈️ ${w.name || label}`, `${lines.join('\n')}\n\nCurrent ladder:\n${compactLadder(cur)}`);
    log('  ALERT:\n    ' + lines.join('\n    '));
  } else {
    log('  no change.');
  }
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'watches.json'), 'utf8'));
  const watches = cfg.watches || [];
  if (!watches.length) { log('No watches configured in watches.json'); return; }

  // jitter: random delay before hitting AC so scheduled runs don't fire at an exact clock time
  const jitterMax = (cfg.jitterMaxMinutes ?? 20) * 60 * 1000;
  if (jitterMax > 0) {
    const j = Math.floor(Math.random() * jitterMax);
    log(`jitter: waiting ${Math.round(j / 1000)}s (${(j / 60000).toFixed(1)} min) before capture`);
    await sleep(j);
  }

  const userDataDir = path.join(DIR, '.browser-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: cfg.headless !== false,
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    for (const w of watches) {
      await runWatch(context, w, cfg);
      await sleep(4000);
    }
  } finally {
    await context.close();
  }
}

main().catch(e => { log('FATAL', e); process.exit(1); });
