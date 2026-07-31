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
const { optimizeDayOrder, distributeAcrossDays } = await import('../js/optimize.js');
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

/* --- 2. notes survive a round-trip --- */
colosseum.notes = 'Booked 09:20 entry\nRef ABC-123';
const t2 = parseTrip(serializeTrip(trip)).trip;
const c2 = Object.values(t2.stops).find(s => s.name === 'Colosseum');
check('multi-line notes survive', c2.notes === colosseum.notes);

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

  const { orders, moved } = distributeAcrossDays(trip);
  const allBefore = trip.days.flatMap(d => d.order).sort().join();
  const allAfter = Object.values(orders).flat().sort().join();
  check('distribute preserves every stop exactly once', allBefore === allAfter);
  check('distribute produced an order per day', trip.days.every(d => Array.isArray(orders[d.id])));
  console.log('  (distribute moved ' + moved + ' stops between days)');

  console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall checks passed');
  process.exit(failures ? 1 : 0);
});
