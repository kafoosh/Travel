#!/usr/bin/env node
/* Format + optimiser sanity checks. Run: node scripts/roundtrip-test.mjs */

// Browser-only globals the modules touch at load time.
globalThis.localStorage = {
  _m: new Map(),
  getItem(k){ return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v){ this._m.set(k, String(v)); },
  removeItem(k){ this._m.delete(k); },
};

const { parseTrip, serializeTrip, parseCsv, importText, blankTrip } = await import('../js/format.js');
const { optimizeDayOrder, autoPlanOrders } = await import('../js/optimize.js');
const { readFileSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, ok, extra){
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''));
  if(!ok) failures++;
}

/* --- 1. demo trip round-trips as a fixed point --- */
console.log('format round-trip:');
const md = readFileSync(join(here, '..', 'demo', 'rome-venice-trip.md'), 'utf8');
const { trip, warnings } = parseTrip(md);
const again = parseTrip(serializeTrip(trip)).trip;
check('parse → serialize → parse is a fixed point', JSON.stringify(trip) === JSON.stringify(again));
check('10 days', trip.days.length === 10, String(trip.days.length));
check('68 scheduled stops', trip.days.reduce((n, d) => n + d.order.length, 0) === 68);
check('11 optional', trip.optional.length === 11);
check('3 hotels', trip.hotels.length === 3);
check('no warnings on demo', warnings.length === 0, warnings.join('; '));
check('day 2 uses hotel h1', trip.days[1].hotelId === 'h1');
check('boat hotel preserved', trip.hotels.find(h => h.name.includes('JW')).mode === 'boat');
const colosseum = Object.values(trip.stops).find(s => s.name === 'Colosseum');
check('Colosseum fields', colosseum && colosseum.dur === 105 && colosseum.cat === 'landmark' && colosseum.tags.length === 1);
check('trip info sections', ['weather','closures','reservations','events','notes'].every(k => trip.info[k].length > 50));

/* --- 2. notes + new fields survive a round-trip --- */
colosseum.notes = 'Booked 09:20 entry\nRef ABC-123';
colosseum.fixedStart = '09:20';
trip.days[0].hotelId = 'h1';            // arrival day: hotel at the end only
trip.days[0].bookend = 'end';
const hikeId = 'u999';
trip.stops[hikeId] = { id: hikeId, name: 'Sentiero degli Dei', cat: 'hike', dur: 240,
  lat: 40.6262, lng: 14.5326, endLat: 40.6140, endLng: 14.4780, fixedStart: null,
  img: '', desc: 'Path of the Gods, Bomerano to Nocelle.', detail: '', notes: '', tags: [] };
trip.days[0].order.push(hikeId);
const t2 = parseTrip(serializeTrip(trip)).trip;
const c2 = Object.values(t2.stops).find(s => s.name === 'Colosseum');
check('multi-line notes survive', c2.notes === colosseum.notes);
check('fixed start survives', c2.fixedStart === '09:20');
check('day bookend survives', t2.days[0].bookend === 'end');
const h2 = Object.values(t2.stops).find(s => s.name === 'Sentiero degli Dei');
check('hike end coords survive', h2 && h2.cat === 'hike' && h2.endLat === 40.614 && h2.endLng === 14.478);
check('extended trip still a fixed point', JSON.stringify(t2) === JSON.stringify(parseTrip(serializeTrip(t2)).trip));

/* --- 3. CSV import --- */
console.log('csv import:');
const csv = [
  'name,day,lat,lng,category,duration,description,notes',
  'Eiffel Tower,1,48.8584,2.2945,landmark,90,"Book the summit, skip the line",go at sunset',
  'Louvre,2,48.8606,2.3376,museum,180,Biggest museum on earth,',
  'Le Chateaubriand,optional,48.8649,2.3800,food,120,Tasting menu,book 3 weeks out',
].join('\n');
const { trip: ct } = parseCsv(csv);
check('2 days created', ct.days.length === 2);
check('optional row lands in optional', ct.optional.length === 1);
check('quoted field with comma', Object.values(ct.stops)[0].desc === 'Book the summit, skip the line');
check('importText sniffs CSV', (() => { try{ return importText(csv).trip.days.length === 2; } catch(e){ return false; } })());
check('importText sniffs markdown', (() => { try{ return importText(md).trip.days.length === 10; } catch(e){ return false; } })());
check('garbage rejected with message', (() => { try{ importText('hello world'); return false; } catch(e){ return true; } })());

/* --- 4. optimiser --- */
console.log('optimiser:');
// A deliberately bad order around Rome: optimiser should shorten the path.
const day2 = trip.days[1];
const shuffled = [...day2.order].reverse();
day2.order = shuffled;
const opt = optimizeDayOrder(trip, day2);
check('same stops, reordered', opt.length === shuffled.length && [...opt].sort().join() === [...shuffled].sort().join());

import('../js/routing.js').then(({ heuristicLeg }) => {
  const pathMinutes = (order) => {
    let mins = 0, prev = trip.hotels.find(h => h.id === day2.hotelId);
    order.map(id => trip.stops[id]).filter(s => s.lat != null).forEach(s => {
      mins += heuristicLeg(prev, s).minutes; prev = s;
    });
    return mins;
  };
  const before = pathMinutes(shuffled), after = pathMinutes(opt);
  check('optimised path is no longer than the shuffled one', after <= before, after + ' vs ' + before + ' min');

  const { orders } = autoPlanOrders(trip);
  const allBefore = trip.days.flatMap(d => d.order).sort().join();
  const allAfter = Object.values(orders).flat().sort().join();
  check('auto-plan preserves every stop exactly once', allBefore === allAfter);
  check('auto-plan produced an order per day', trip.days.every(d => Array.isArray(orders[d.id])));

  // Quality checks on the pristine demo trip (the mutated one above contains
  // a deliberately-remote Amalfi hike that must overflow SOMEWHERE).
  const fresh = parseTrip(md).trip;
  const { orders: fo } = autoPlanOrders(fresh);
  let crossCity = 0, anchorMoved = 0;
  const anchorDayBefore = {};
  fresh.days.forEach(d => d.order.forEach(id => {
    const s = fresh.stops[id];
    if(s && ['travel','boat','hotel','flight'].includes(s.cat)) anchorDayBefore[id] = d.id;
  }));
  const loads = fresh.days.map(d => {
    const cities = new Set(fo[d.id].map(id => fresh.stops[id]).filter(s => s && s.lat != null).map(s => s.lat > 44 ? 'V' : 'R'));
    if(cities.size > 1) crossCity++;
    fo[d.id].forEach(id => { if(anchorDayBefore[id] && anchorDayBefore[id] !== d.id) anchorMoved++; });
    return fo[d.id].reduce((n, id) => n + ((fresh.stops[id] || {}).dur || 0), 0);
  });
  check('auto-plan never mixes cities within a day', crossCity === 0, crossCity + ' mixed days');
  check('anchored stops stay on their day', anchorMoved === 0, String(anchorMoved));
  check('no day overloaded (visits ≤ 11h)', Math.max(...loads) <= 11 * 60, Math.max(...loads) + ' min');
  check('no day starved (every day gets stops)', Math.min(...loads) >= 60, Math.min(...loads) + ' min');
  check('loads reasonably balanced (max ≤ 2× min)', Math.max(...loads) <= 2 * Math.min(...loads),
    Math.min(...loads) + '–' + Math.max(...loads) + ' min');

  console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
});
