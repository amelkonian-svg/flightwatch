#!/usr/bin/env node
/*
 * add-watch.js — interactively add a route to watches.json.
 * Usage:  node add-watch.js
 * It asks for the trip details, appends a watch, and (if it exists) keeps
 * your other watches intact. Re-run flightwatch to get a baseline ping.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILE = path.join(__dirname, 'watches.json');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, a => r(a.trim())));

const isIata = s => /^[A-Za-z]{3}$/.test(s);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (s, d) => (s === '' ? d : Math.max(0, parseInt(s, 10) || 0));

(async () => {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { cfg = { headless: false, seatThreshold: 4, disclosedSeatCeiling: 9, jitterMaxMinutes: 25, triggers: { priceChange: true, seatsLow: true, cheaperBucket: true }, watches: [] }; }
  cfg.watches ||= [];

  console.log('\nAdd a flight watch (Ctrl+C to cancel)\n');
  let origin = ''; while (!isIata(origin)) origin = (await ask('Origin airport (3-letter code, e.g. YYZ): ')).toUpperCase() || '';
  let dest = ''; while (!isIata(dest)) dest = (await ask('Destination airport (3-letter code, e.g. LIM): ')).toUpperCase() || '';
  let dep = ''; while (!isDate(dep)) dep = await ask('Departure date (YYYY-MM-DD): ');
  let ret = ''; while (!isDate(ret)) ret = await ask('Return date (YYYY-MM-DD): ');
  const adt = num(await ask('Adults [1]: '), 1);
  const yth = num(await ask('Youth (12-17) [0]: '), 0);
  const chd = num(await ask('Children (2-11) [0]: '), 0);
  const inf = num(await ask('Infants on lap [0]: '), 0);
  const defName = `${origin}↔${dest} ${dep} to ${ret}`;
  const name = (await ask(`Label [${defName}]: `)) || defName;
  const thrRaw = await ask(`Seats-left alert threshold [${cfg.seatThreshold ?? 4}]: `);
  const seatThreshold = thrRaw === '' ? undefined : Math.max(1, parseInt(thrRaw, 10) || 4);

  const base = `${origin}-${dest}-${dep}`.toLowerCase();
  let id = base, n = 2;
  while (cfg.watches.some(w => w.id === id)) id = `${base}-${n++}`;

  const watch = { id, name, origin, destination: dest, departureDate: dep, returnDate: ret, promoCode: '', passengers: { adt, yth, chd, inf, ins: 0 } };
  if (seatThreshold != null) watch.seatThreshold = seatThreshold;
  cfg.watches.push(watch);
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n');

  console.log(`\nAdded "${name}" (id: ${id}). Total watches: ${cfg.watches.length}.`);
  console.log('Test it now with:  node flightwatch.js   (first run sends a baseline ping)\n');
  rl.close();
})();
