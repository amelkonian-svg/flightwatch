#!/usr/bin/env node
/*
 * flightwatch — a real-browser Air Canada fare, bucket & eUpgrade watcher.
 *
 * Captures AC's getFlightRecommendations response via a real Chromium,
 * extracts the booking-class "bucket" ladder per cabin (+ seatsLeft when
 * AC exposes it), optionally drives the eUpgrade toggle (Aeroplan tier)
 * to capture upgrade eligibility/space/credits, diffs against the last
 * run, and pushes phone alerts via Pushover.
 *
 * Must run HEADED on a residential connection. See CLAUDE.md / README.
 * No secrets live in this file. Pushover creds come from .env / env.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIR = __dirname;
const STATE_DIR = path.join(DIR, 'state');
fs.mkdirSync(STATE_DIR, { recursive: true });

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
let SEAT_CEILING = 9; // AC only discloses exact seatsLeft when low; null => "more than this many"

const log = (...a) => console.log(new Date().toISOString(), ...a);
const money = n => '$' + Number(n).toLocaleString('en-CA');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const seatText = s => (s == null ? `${SEAT_CEILING}+ seats` : `${s} seat${s === 1 ? '' : 's'}`);

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

// Build the bucket ladder per cabin (+ optional eUpgrade-to-target detail).
function extractSnapshot(payload, seatThreshold, euTargetName) {
  const recs = payload?.data?.getFlightRecommendations?.responseData?.recommendations || [];
  const cabins = {};

  for (const rec of recs) {
    const bd = rec.boundDetails || {};
    const segs = bd.segments || [];
    const flight = segs.map(s => (s.flight?.flightId || s.flight?.marketingAirline?.code || '')).filter(Boolean).join('+') || '(flight)';
    const flightShort = segs.map(s => {
      const id = s.flight?.flightId || '';
      const m = id.match(/-([A-Z]{2}\d+)-/); return m ? m[1] : (s.flight?.marketingAirline?.code || '');
    }).filter(Boolean).join('+') || flight;

    for (const cab of (rec.fareDetails?.cabin || [])) {
      const name = CABIN_NAMES[cab.cabinCode] || cab.cabinCode || '?';
      const c = cabins[name] ||= { buckets: {}, euCandidates: [] };

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

        // eUpgrade: aggregate the per-segment eUpgradeInfo for this offer
        const infos = ad.map(a => a.eUpgradeInfo);
        if (infos.some(x => x)) {
          const eligible = infos.every(x => x && x.status && x.status !== 'Ineligible');
          if (eligible) {
            const space = infos.every(x => /^Available/.test(x.status));
            const inWindow = infos.every(x => x.isInClearanceWindow);
            const credits = infos.reduce((s, x) => s + (x.credits || 0), 0);
            const copay = infos.reduce((s, x) => s + (x.additionalAmount || 0), 0);
            c.euCandidates.push({ flight: flightShort, bucket, credits, copay, space, inWindow });
          }
        }
      }
    }
  }

  const out = { ts: new Date().toISOString(), cabins: {}, lowSeats: [], euTarget: euTargetName || null };
  for (const [name, c] of Object.entries(cabins)) {
    const ladder = Object.values(c.buckets)
      .map(b => ({ bucket: b.bucket, perPax: b.perPax, allPax: b.allPax, fareFamily: b.fareFamily, seatsLeft: b.seatsLeft, flights: b.flights.size }))
      .sort((a, b) => a.perPax - b.perPax);
    const entry = { ladder, cheapest: ladder[0] || null };

    if (c.euCandidates.length) {
      const withSpace = c.euCandidates.filter(x => x.space);
      const pool = (withSpace.length ? withSpace : c.euCandidates).sort((a, b) => a.credits - b.credits);
      const pick = pool[0];
      entry.eUpgrade = {
        anySpace: withSpace.length > 0,
        spaceCount: withSpace.length,
        minCredits: pick.credits,
        copay: pick.copay,
        inWindow: pick.inWindow,
        flight: pick.flight,
        bucket: pick.bucket,
        spaceFlights: withSpace.sort((a, b) => a.credits - b.credits).slice(0, 5)
          .map(x => ({ flight: x.flight, bucket: x.bucket, credits: x.credits, copay: x.copay, inWindow: x.inWindow })),
      };
    }
    out.cabins[name] = entry;

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

function euText(eu, target) {
  if (!eu) return null;
  const t = target || 'Business';
  const cost = `${eu.minCredits} cr${eu.copay ? ` +$${eu.copay}` : ''}`;
  if (eu.anySpace) return `↑${t}: ✅ space on ${eu.spaceCount} flt, from ${cost}${eu.inWindow ? ' (in clearance)' : ' (clears near departure)'}`;
  return `↑${t}: no space yet, from ${cost}`;
}

function compactLadder(snap) {
  const lines = [];
  for (const name of orderedCabins(snap)) {
    const c = snap.cabins[name];
    const rungs = c.ladder.map(b => `${b.bucket} ${money(b.perPax)} (${seatText(b.seatsLeft)})`);
    lines.push(`${name}: ${rungs.join(' · ')}`);
    const e = euText(c.eUpgrade, snap.euTarget);
    if (e) lines.push(`  ${e}`);
  }
  return lines.join('\n');
}

function fullLadder(snap) {
  const lines = [];
  for (const name of orderedCabins(snap)) {
    const c = snap.cabins[name];
    lines.push(`  ${name}:`);
    for (const b of c.ladder) {
      lines.push(`    ${b.bucket.padEnd(7)} ${money(b.perPax).padEnd(8)} ${String(b.fareFamily).padEnd(11)} ${seatText(b.seatsLeft).padEnd(10)} (${b.flights} flt)`);
    }
    const e = euText(c.eUpgrade, snap.euTarget);
    if (e) {
      lines.push(`      ${e}`);
      for (const f of (c.eUpgrade.spaceFlights || [])) {
        lines.push(`        ${f.flight} (${f.bucket}): ${f.credits} cr${f.copay ? ` +$${f.copay}` : ''}${f.inWindow ? ' in-clearance' : ''}`);
      }
    }
  }
  return lines.join('\n');
}

function diff(prev, cur, seatThreshold, triggers) {
  const lines = [];
  const target = cur.euTarget || 'Business';
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

    // eUpgrade transitions
    if (triggers.eUpgrade !== false && c.eUpgrade) {
      const pe = p?.eUpgrade;
      if (c.eUpgrade.anySpace && !(pe && pe.anySpace)) {
        lines.push(`⬆️ ${name}→${target} UPGRADE SPACE OPENED: ${c.eUpgrade.spaceCount} flight(s), from ${c.eUpgrade.minCredits} credits${c.eUpgrade.copay ? ` +$${c.eUpgrade.copay}` : ''} (${c.eUpgrade.bucket} on ${c.eUpgrade.flight})`);
      } else if (c.eUpgrade.anySpace && pe && pe.anySpace && c.eUpgrade.minCredits < pe.minCredits) {
        lines.push(`⬆️ ${name}→${target} upgrade now cheaper: ${pe.minCredits} → ${c.eUpgrade.minCredits} credits`);
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

// Turn on AC's eUpgrade toggle and pick the elite tier / target cabin.
async function driveEUpgrade(page, eu) {
  await page.getByText(/eUpgrade/i).first().click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  if (eu.cabin && eu.cabin !== 'J') {
    try {
      await page.getByRole('combobox', { name: /Upgrade to/i }).click({ timeout: 6000 });
      await page.waitForTimeout(600);
      await page.locator(`li[option-value="${eu.cabin}"]`).click({ timeout: 6000, force: true });
      await page.waitForTimeout(400);
    } catch (_) {}
  }
  await page.getByRole('combobox', { name: /Aeroplan Elite status/i }).click({ timeout: 8000 });
  await page.waitForTimeout(800);
  await page.locator(`li[option-value="${eu.tierCode || 'SE'}"]`).click({ timeout: 8000, force: true });
  await page.waitForTimeout(600);
  await page.locator('button[type="submit"]:has-text("View")').first().click({ timeout: 8000, force: true });
}

async function captureRecommendations(context, url, euCfg) {
  const page = await context.newPage();
  let base = null, eu = null;
  page.on('response', async (res) => {
    try {
      if (!/lfs-appsync.*graphql/i.test(res.url())) return;
      const txt = await res.text();
      if (!/getFlightRecommendations/.test(txt) || !/recommendations/.test(txt)) return;
      const j = JSON.parse(txt);
      if (!j?.data?.getFlightRecommendations?.responseData?.recommendations?.length) return;
      if (/"eUpgradeInfo":\s*\{/.test(txt)) eu = j; else base = j;
    } catch (_) {}
  });
  await page.goto('https://www.aircanada.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 50 && !base && !eu; i++) await page.waitForTimeout(1000);

  if (euCfg && euCfg.enabled) {
    try {
      await driveEUpgrade(page, euCfg);
      for (let i = 0; i < 40 && !eu; i++) await page.waitForTimeout(1000);
      if (!eu) log('  eUpgrade: toggled but no annotated response captured (using plain fares).');
    } catch (e) { log('  eUpgrade capture failed (' + e.message + ') — using plain fares.'); }
  }
  await page.close();
  return eu || base; // eu payload is a superset (fares + upgrade detail)
}

async function runWatch(context, w, cfg) {
  const seatThreshold = w.seatThreshold ?? cfg.seatThreshold ?? 4;
  const triggers = { ...{ priceChange: true, seatsLow: true, cheaperBucket: true, eUpgrade: true }, ...(cfg.triggers || {}) };
  const euCfg = (w.eUpgrade || cfg.eUpgrade || null);
  const euTargetName = euCfg && euCfg.enabled ? (CABIN_NAMES[euCfg.cabin] || 'Business') : null;
  const label = `${w.origin}→${w.destination} ${w.departureDate}…${w.returnDate}`;
  log(`Watch "${w.name || label}"`);

  const url = buildSearchUrl(w);
  let payload;
  try { payload = await captureRecommendations(context, url, euCfg); }
  catch (e) { log('  navigation error', e.message); return; }

  if (!payload) { log('  ⚠️ no pricing response captured (possible bot block or sold-out date) — skipping, no alert.'); return; }

  const cur = extractSnapshot(payload, seatThreshold, euTargetName);
  const stateFile = path.join(STATE_DIR, `${(w.id || w.name || label).replace(/[^\w.-]+/g, '_')}.json`);
  const prev = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;

  log('\n' + fullLadder(cur));

  if (!prev) {
    fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));
    await pushover(`✈️ Watch started: ${w.name || label}`, `Baseline:\n${compactLadder(cur)}\n\nI'll ping you when prices, buckets, seats, or upgrade space move.`);
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
  SEAT_CEILING = cfg.disclosedSeatCeiling ?? 9;
  if (!watches.length) { log('No watches configured in watches.json'); return; }

  const jitterMax = (process.env.NOJITTER ? 0 : (cfg.jitterMaxMinutes ?? 20)) * 60 * 1000;
  if (jitterMax > 0) {
    const j = Math.floor(Math.random() * jitterMax);
    log(`jitter: waiting ${Math.round(j / 1000)}s (${(j / 60000).toFixed(1)} min) before capture`);
    await sleep(j);
  }

  const userDataDir = path.join(DIR, '.browser-profile');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: cfg.headless !== false,
    viewport: { width: 1440, height: 960 },
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

if (require.main === module) main().catch(e => { log('FATAL', e); process.exit(1); });
module.exports = { extractSnapshot, fullLadder, compactLadder, diff };
