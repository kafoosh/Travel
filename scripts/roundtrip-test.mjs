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
trip.days[0].color = 'teal';            // per-day colour (palette key)
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
check('day colour survives', t2.days[0].color === 'teal');
check('checklist survives with done state', (() => {
  trip.checklist = [
    { id:'k1', text:'Book Borghese: timed entry', done:false },
    { id:'k2', text:'Renew passport', done:true },
  ];
  const t = parseTrip(serializeTrip(trip)).trip;
  return t.checklist.length === 2
    && t.checklist[0].text === 'Book Borghese: timed entry' && t.checklist[0].done === false
    && t.checklist[1].text === 'Renew passport' && t.checklist[1].done === true;
})());
check('checklist trip is still a fixed point', (() => {
  const t = parseTrip(serializeTrip(trip)).trip;
  return JSON.stringify(t) === JSON.stringify(parseTrip(serializeTrip(t)).trip);
})());
check('unknown day colour is dropped', (() => {
  const bad = parseTrip(serializeTrip(trip).replace('- color: teal', '- color: neon')).trip;
  return bad.days[0].color === null;
})());
check('arrive-by survives', (() => {
  colosseum.arriveBy = 'taxi';
  trip.days[1].returnBy = 'cycle';
  const t3 = parseTrip(serializeTrip(trip)).trip;
  const c3 = Object.values(t3.stops).find(s => s.name === 'Colosseum');
  return c3.arriveBy === 'taxi' && t3.days[1].returnBy === 'cycle';
})());
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

/* --- 3b. resilient import: chat-mangled LLM output --- */
console.log('resilient import:');
const fenced = '```markdown\n' + md + '```';
check('fenced code block unwrapped', importText(fenced).trip.days.length === 10);
// A chat UI that RENDERS markdown strips the #/- markers on copy.
const stripped = md.split('\n').map(l => l.replace(/^#{1,3}\s+/, '').replace(/^- /, '')).join('\n');
const rec = importText(stripped).trip;
check('stripped markers recovered: days', rec.days.length === 10, String(rec.days.length));
check('stripped markers recovered: stops', Object.keys(rec.stops).length === 79, String(Object.keys(rec.stops).length));
check('stripped markers recovered: hotels + optional', rec.hotels.length === 3 && rec.optional.length === 11);
const recCol = Object.values(rec.stops).find(s => s.name === 'Colosseum');
check('stripped: stop fields intact', recCol && recCol.dur === 105 && recCol.cat === 'landmark' && recCol.lat === 41.8902);
check('stripped: trip info sections recovered', ['weather','closures','reservations','events','notes'].every(k => rec.info[k].length > 50));
check('stripped + fenced together', importText('Here you go:\n\n```\n' + stripped + '\n```').trip.days.length === 10);

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
  check('no day overloaded (visits ≤ 12h)', Math.max(...loads) <= 12 * 60, Math.max(...loads) + ' min');
  // anchors that opened their original day must still open it after replanning
  const d1order = fo[fresh.days[0].id];
  const checkin = d1order.map(id => fresh.stops[id]).find(s => s && s.cat === 'hotel');
  check('day-opening check-in still opens its day', checkin && d1order.indexOf(checkin.id) === 0, checkin ? 'at index ' + d1order.indexOf(checkin.id) : 'missing');
  check('no day starved (every day gets stops)', Math.min(...loads) >= 60, Math.min(...loads) + ' min');
  check('loads reasonably balanced (max ≤ 2× min)', Math.max(...loads) <= 2 * Math.min(...loads),
    Math.min(...loads) + '–' + Math.max(...loads) + ' min');

  /* --- 5. external map exports --- */
  import('../js/exporters.js').then(({ googleMapsDayUrl, googleMapsUrl, dayMapPoints, tripKml }) => {
    console.log('map exports:');
    const t = parseTrip(md).trip;
    const { url, truncated } = googleMapsDayUrl(t, t.days[1]);
    check('gmaps url uses the documented api=1 scheme', !!url && url.startsWith('https://www.google.com/maps/dir/?api=1'), (url || '').slice(0, 60));
    check('gmaps url walks and has waypoints', !!url && url.includes('travelmode=walking') && url.includes('waypoints='));
    check('gmaps origin is the day-2 hotel', !!url && decodeURIComponent(url).includes('origin=41.9053'), 'day 2 starts at the Tribune');
    const big = googleMapsDayUrl(t, t.days.reduce((b, d) => d.order.length > b.order.length ? d : b));
    check('waypoint cap reported honestly', typeof big.truncated === 'boolean');
    const pts = dayMapPoints(t, t.days[1]);
    check('day points are named for the picker', pts.length > 2 && pts.every(p => p.label && p.lat != null));
    const picked = [pts[0], pts[2]];
    const two = googleMapsUrl(picked);
    check('a picked pair routes with no waypoints', !!two.url && !two.url.includes('waypoints=') && !two.truncated);
    check('a picked pair uses the picked ends', !!two.url &&
      decodeURIComponent(two.url).includes('destination=' + picked[1].lat.toFixed(5)));
    check('one point is not a route', googleMapsUrl([pts[0]]).url === null);
    const kml = tripKml(t);
    const placemarks = (kml.match(/<Placemark>/g) || []).length;
    check('kml has a folder per day + optional', (kml.match(/<Folder>/g) || []).length === 11);
    check('kml placemark count covers stops + routes', placemarks >= 68 + 10, String(placemarks));
    check('kml escapes reserved characters', !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(kml));

    // Point numbers belong to the itinerary, not to whatever is ticked in the
    // picker: stops count 1..n, a hike's end is "Nb", hotel bookends aren't
    // numbered at all.
    const numbered = dayMapPoints(t, t.days[1]);
    check('map points carry the itinerary\'s own numbers',
      numbered.filter(p => p.cat !== 'hotel').map(p => p.num).join(',') === '1,2,3,4,5,6,7',
      numbered.map(p => p.num).join(','));
    check('hotel bookends are unnumbered', numbered.filter(p => p.num == null).length === 2);
    check('numbering ignores any selection', (() => {
      const picked = [numbered[4], numbered[5]];   // "just these two" case
      return picked[0].num === '4' && picked[1].num === '5';
    })());

    /* --- 6. offline export --- */
    import('../js/offline.js').then(({ buildOfflineHtml, offlineFileName, photoUrls }) => {
      console.log('offline export:');
      const ot = parseTrip(md).trip;
      // A stop whose text is actively hostile: it must survive as text.
      const evil = Object.values(ot.stops)[0];
      evil.notes = '</textarea><script>alert(1)</script>"><img src=x onerror=alert(2)>';
      evil.name = 'Tricky "quoted" <b>stop</b>';
      const html = buildOfflineHtml(ot, { generatedAt: new Date('2026-01-01') });

      check('one self-contained document', html.startsWith('<!DOCTYPE html>') && html.trim().endsWith('</html>'));
      check('a view per day, plus unassigned and info', (html.match(/class="view"/g) || []).length === 12,
        String((html.match(/class="view"/g) || []).length));
      check('every located day gets a route sketch', (html.match(/<svg class="map"/g) || []).length === 10);
      check('every stop is on the page', (html.match(/class="stop"/g) || []).length === 68 + 11,
        String((html.match(/class="stop"/g) || []).length));
      check('exactly one script block', (html.match(/<script/g) || []).length === 1 && (html.match(/<\/script>/g) || []).length === 1);
      check('nothing is fetched at runtime', !/\b(fetch|XMLHttpRequest|importScripts)\s*\(/.test(html)
        && !/<link[^>]+href="http/.test(html) && !/<script[^>]+src=/.test(html));
      // Hostile text may appear as text (escaped); what it must never do is
      // close an attribute or open a tag of its own.
      check('hostile stop text cannot break out', !html.includes('<script>alert(1)') && !html.includes('<img src=x')
        && !html.includes('</textarea><script>') && !html.includes('<b>stop</b>'));
      check('file name is derived from the trip', offlineFileName(ot) === 'rome-venice-offline.html');
      check('photos are only counted once', photoUrls(ot).length === new Set(photoUrls(ot)).size);

      // The trip file travels inside the page, so a phone can hand the plan
      // back to the planner (or to another device) with nothing but the file.
      const raw = html.split('<textarea id="trip-src" readonly aria-hidden="true">')[1].split('</textarea>')[0];
      const unesc = raw.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"')
        .replaceAll('&#39;',"'").replaceAll('&amp;','&');
      const back = parseTrip(unesc).trip;
      check('the embedded trip file re-imports whole',
        back.days.length === 10 && Object.keys(back.stops).length === 79 && back.hotels.length === 3);
      check('embedded trip survives the hostile text', (() => {
        const s = Object.values(back.stops).find(x => x.name === evil.name);
        return !!s && s.notes === evil.notes;
      })());

      // Pins and route lines have to land inside the box that is drawn.
      const svg = html.split('<svg class="map"')[1].split('</svg>')[0];
      const h = Number(/viewBox="0 0 720 (\d+)"/.exec(html)[1]);
      const coords = [...svg.matchAll(/c[xy]="(-?[\d.]+)"/g)].map(m => Number(m[1]));
      check('map geometry stays inside the viewBox', coords.every(c => c >= -1 && c <= Math.max(720, h)),
        'height ' + h);

      console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall checks passed');
      process.exit(failures ? 1 : 0);
    });
  });
});
