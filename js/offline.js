/* =========================================================
   OFFLINE EXPORT

   One self-contained .html file holding the whole trip: every
   day, time, travel leg, note, photo and coordinate, plus a
   route sketch per day. It makes no network requests of any
   kind — no CDN, no fonts, no map tiles, no fetch — so it
   opens from a phone's Files app on a plane, in a tunnel, or
   in a country where the data roaming is off.

   What it is NOT: the planner. Nothing in the exported page
   edits the trip (there is nowhere to sync an edit back to);
   it is the itinerary, frozen at the moment of export, plus
   two things that are pure local state — ticking a stop off
   as visited and the packing checklist — kept in that file's
   own localStorage.

   Design constraints worth remembering when editing:
   - No ES modules, no imports: browsers refuse module scripts
     on file:// URLs, so the page's script is one plain
     <script> block.
   - Route lines come from the geometry the routing cache
     already holds; legs with no routed shape are drawn as a
     dashed straight line, and say so by looking different.
   - Photos are re-encoded to data: URIs at export time. A
     photo that can't be fetched (CORS, dead link, offline at
     export time) simply leaves the category icon in place —
     the same forgiving behaviour as the site.
   ========================================================= */

import { esc, formatTime, formatDur, formatDayDate, dayDate, parseTime, slugify, haversineKm } from './util.js';
import { CAT_ICONS, MODE_ICONS, DAY_COLORS, AB_CATS, serializeTrip } from './format.js';
import { computeSchedule, departPoint } from './schedule.js';
import { dayMapPoints } from './exporters.js';
import { imageCandidates } from './img.js';

/* ---------- theme ----------
   The exported page carries the colours of whichever scheme the trip is
   using. Rather than keeping a second copy of the palette here (which would
   drift from css/main.css), the values are read off the live document; the
   fallback is only for a non-browser caller such as the test script. */
const FALLBACK_VARS = {
  '--paper':'#E9DFC6', '--paper-card':'#FBF7EA', '--card':'#FFFFFF',
  '--ink':'#23303F', '--ink-soft':'#556370', '--accent':'#C1502E',
  '--accent-dark':'#8F3A20', '--accent-tint':'#F1D8C9', '--gold':'#B8891F',
  '--line':'#C9BB9C', '--danger':'#A33B34',
};

function readThemeVars(){
  const out = Object.assign({}, FALLBACK_VARS);
  if(typeof document === 'undefined' || !document.documentElement) return out;
  const cs = getComputedStyle(document.documentElement);
  Object.keys(out).forEach(k => {
    const v = (cs.getPropertyValue(k) || '').trim();
    if(v) out[k] = v;
  });
  return out;
}

/* A day's own colour has to bring its shades with it: the exported page sets
   --accent inline on the day's section, and --accent-dark / --accent-tint are
   mixed here rather than left pointing at the theme's (which would put the
   wrong hue on times, links and tags). Anything that isn't a plain hex is
   left alone — the theme's shades then stay in force, slightly off but never
   unreadable. */
function parseHex(hex){
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if(!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixHex(a, b, weightA){
  const ca = parseHex(a), cb = parseHex(b);
  if(!ca || !cb) return null;
  const ch = (i) => Math.round(ca[i] * weightA + cb[i] * (1 - weightA));
  return '#' + [0, 1, 2].map(i => ch(i).toString(16).padStart(2, '0')).join('');
}

function isDarkPaper(vars){
  const p = parseHex(vars['--paper']);
  return !!p && (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 110;
}

function dayAccentStyle(day, vars){
  const c = day.color && DAY_COLORS[day.color];
  if(!c) return '';
  // On a dark scheme --accent-dark is text on dark cards, so it has to
  // lighten rather than darken — the same flip css/main.css makes.
  const dark = isDarkPaper(vars) ? mixHex(c.accent, '#FFFFFF', 0.62) : mixHex(c.accent, '#000000', 0.72);
  const tint = mixHex(c.accent, vars['--paper-card'], 0.2);
  return ' style="' + ['--accent:' + c.accent, dark ? '--accent-dark:' + dark : '', tint ? '--accent-tint:' + tint : '']
    .filter(Boolean).join('; ') + '"';
}

/* ---------- small helpers ---------- */

const n1 = (x) => Math.round(x * 10) / 10;

function tripDateRange(trip){
  const first = dayDate(trip.startDate, 0);
  const last = dayDate(trip.startDate, trip.days.length - 1);
  if(!first || !last) return '';
  const year = last.getFullYear();
  return formatDayDate(first) + ' – ' + formatDayDate(last) + ' ' + year;
}

/* Everything a stop can be found by: one lowercased haystack per card. */
function searchText(stop, dayLabel){
  return [stop.name, stop.desc, stop.detail, stop.notes, (stop.tags || []).join(' '), dayLabel]
    .filter(Boolean).join(' ').toLowerCase();
}

/* ---------- day route sketch ----------
   A tiles-free map: routed geometry where the cache has it, dashed straight
   lines where it doesn't, numbered pins matching the timeline. Web-Mercator,
   which over a single day's extent is indistinguishable from anything more
   careful. */

const MAP_W = 720, MAP_PAD = 30;
/* Web Mercator on the unit sphere: both axes in radians, so one unit is the
   same length on each and the sketch keeps the shape the day really has. */
const mercX = (lng) => lng * Math.PI / 180;
/* Negated, because screen y grows downward and latitude grows up. */
const mercY = (lat) => -Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI / 180) / 2));
const EARTH_KM = 6371;

function daySegments(sched){
  const segs = [];
  const startHotel = sched.startHotel && sched.startHotel.lat != null
    ? { lat: sched.startHotel.lat, lng: sched.startHotel.lng } : null;
  const endHotel = sched.endHotel && sched.endHotel.lat != null
    ? { lat: sched.endHotel.lat, lng: sched.endHotel.lng } : null;
  let prev = startHotel;

  sched.rows.forEach(row => {
    const s = row.stop;
    if(s.lat == null) return;
    const here = { lat: s.lat, lng: s.lng };
    if(prev) segs.push({ from: prev, to: here, path: row.travelPath, mode: row.travelMode });
    const dep = departPoint(s);
    // The stop's own point-to-point movement: a hike's routed walk, or a
    // ride's straight line between its stations.
    if(dep && (dep.lat !== s.lat || dep.lng !== s.lng))
      segs.push({ from: here, to: dep, path: row.hikeLeg ? row.hikeLeg.path : null, mode: row.hikeLeg ? 'walk' : null });
    if(dep) prev = dep;
  });

  if(endHotel && sched.trailTransfer && prev)
    segs.push({ from: prev, to: endHotel, path: sched.trailTransfer.path, mode: sched.trailTransfer.mode });
  return segs;
}

/* A metric scale bar, sized to a round number of km/m near a quarter of the
   map's width. Without one, a tiles-free sketch gives no sense of distance. */
const NICE_KM = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
function scaleBar(kmPerPx, mapH){
  if(!isFinite(kmPerPx) || kmPerPx <= 0) return '';
  // The roundest distance that draws between 20px and the map's width.
  const target = kmPerPx * MAP_W * 0.25;
  const fits = NICE_KM.filter(v => v / kmPerPx >= 20 && v / kmPerPx <= MAP_W - 2 * MAP_PAD);
  if(!fits.length) return '';
  const km = fits.reduce((best, v) => Math.abs(v - target) < Math.abs(best - target) ? v : best, fits[0]);
  const px = km / kmPerPx;
  const y = mapH - 14, x = MAP_PAD;
  const label = km < 1 ? Math.round(km * 1000) + ' m' : km + ' km';
  return `<g class="sc"><line x1="${x}" y1="${y}" x2="${n1(x + px)}" y2="${y}"></line>` +
    `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}"></line>` +
    `<line x1="${n1(x + px)}" y1="${y - 4}" x2="${n1(x + px)}" y2="${y + 4}"></line>` +
    `<text x="${n1(x + px + 7)}" y="${y + 4}">${label}</text></g>`;
}

function daySvg(trip, day, sched){
  const pts = dayMapPoints(trip, day);
  const segs = daySegments(sched);
  if(pts.length < 1) return '';

  // Bounds over every drawn coordinate, pins and route geometry alike.
  const all = pts.map(p => [p.lat, p.lng]);
  segs.forEach(sg => {
    if(sg.path && sg.path.length) all.push(...sg.path);
    else all.push([sg.from.lat, sg.from.lng], [sg.to.lat, sg.to.lng]);
  });
  const lats = all.map(p => p[0]), lngs = all.map(p => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  let x0 = mercX(Math.min(...lngs)), x1 = mercX(Math.max(...lngs));
  let y0 = mercY(Math.max(...lats)), y1 = mercY(Math.min(...lats));   // north is the smaller y
  // A single point (or a day in one square) still needs an extent to scale by.
  const MINSPAN = mercX(0.004);
  if(x1 - x0 < MINSPAN){ const c = (x0 + x1) / 2; x0 = c - MINSPAN / 2; x1 = c + MINSPAN / 2; }
  if(y1 - y0 < MINSPAN){ const c = (y0 + y1) / 2; y0 = c - MINSPAN / 2; y1 = c + MINSPAN / 2; }
  // A day strung out along one street is geometrically a line; drawn as one
  // it's a scratch across the page. Padding the short axis (never the long
  // one, which would distort distances) keeps the sketch in a readable
  // rectangle — the scale bar stays honest either way.
  const grow = (lo, hi, want) => { const c = (lo + hi) / 2; return [c - want / 2, c + want / 2]; };
  if(y1 - y0 < (x1 - x0) * 0.45) [y0, y1] = grow(y0, y1, (x1 - x0) * 0.45);
  if(x1 - x0 < (y1 - y0) * 0.9) [x0, x1] = grow(x0, x1, (y1 - y0) * 0.9);

  const inner = MAP_W - 2 * MAP_PAD;
  const scale = inner / (x1 - x0);
  // Never taller than it is wide: a phone screen full of sketch, with the
  // day's actual list pushed below the fold, helps nobody.
  const mapH = Math.max(240, Math.min(560, Math.round((y1 - y0) * scale) + 2 * MAP_PAD));
  const yScale = Math.min(scale, (mapH - 2 * MAP_PAD) / (y1 - y0));
  const offX = MAP_PAD + (inner - (x1 - x0) * Math.min(scale, yScale)) / 2;
  const offY = MAP_PAD + ((mapH - 2 * MAP_PAD) - (y1 - y0) * Math.min(scale, yScale)) / 2;
  const k = Math.min(scale, yScale);
  const px = (lng) => n1(offX + (mercX(lng) - x0) * k);
  const py = (lat) => n1(offY + (mercY(lat) - y0) * k);

  const lines = segs.map(sg => {
    const routed = sg.path && sg.path.length > 1;
    const coords = routed ? sg.path : [[sg.from.lat, sg.from.lng], [sg.to.lat, sg.to.lng]];
    return `<polyline class="rt${routed ? '' : ' est'}" points="${coords.map(c => px(c[1]) + ',' + py(c[0])).join(' ')}"></polyline>`;
  }).join('');

  const pins = pts.map(p => {
    const x = px(p.lng), y = py(p.lat);
    if(p.num == null)
      return `<g class="pin hotel"><circle cx="${x}" cy="${y}" r="9"></circle><text x="${x}" y="${y + 3.5}">⌂</text></g>`;
    const wide = String(p.num).length > 1;
    return `<g class="pin"><circle cx="${x}" cy="${y}" r="${wide ? 11 : 10}"></circle>` +
      `<text x="${x}" y="${y + 3.5}">${esc(p.num)}</text></g>`;
  }).join('');

  // km per pixel from the map's own scale, at the middle latitude — Mercator
  // stretches away from the equator, and one day's map is all one latitude.
  const kmPerPx = (EARTH_KM * Math.cos(midLat * Math.PI / 180)) / k;

  return `<svg class="map" viewBox="0 0 ${MAP_W} ${mapH}" role="img" aria-label="Route sketch for day ${day.id}">` +
    lines + pins + scaleBar(kmPerPx, mapH) + '</svg>';
}

/* ---------- page pieces ---------- */

/* Embedded photo if there is one; otherwise the original URL, which shows the
   picture when there happens to be signal and falls back to the category icon
   when there isn't (the page script clears an image that fails to load). The
   icon is what's there in the first place, so nothing is ever a grey box. */
function photoHtml(url, cat, alt, photos){
  const ico = CAT_ICONS[cat] || '📍';
  const embedded = url && photos ? photos.get(url) : null;
  const src = embedded || (url && /^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : null);
  if(!src) return `<div class="ph" data-ico="${ico}"></div>`;
  return `<div class="ph has-img" data-ico="${ico}"><img src="${esc(src)}" alt="${esc(alt)}"` +
    (embedded ? '' : ' referrerpolicy="no-referrer"') + ' loading="lazy"></div>';
}

function coordsHtml(lat, lng, label, cls){
  if(lat == null || lng == null) return '';
  const c = Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
  // geo: hands the point to whatever map app is installed — including an
  // offline one (Organic Maps, OsmAnd…), which is the whole point out here.
  // The Google link is for when there is signal again.
  return `<p class="coords${cls ? ' ' + cls : ''}"><a href="geo:${c}?q=${c}(${encodeURIComponent(label || '')})">📍 ${esc(c.replace(',', ', '))}</a>` +
    ` <a class="quiet" href="https://www.google.com/maps/search/?api=1&amp;query=${c}" target="_blank" rel="noopener">Google Maps ↗</a></p>`;
}

function connectorHtml(minutes, mode, live, prefix){
  if(!minutes) return '';
  return `<p class="leg">${MODE_ICONS[mode] || '🚶'} ${prefix ? esc(prefix) + ' ' : ''}~${Math.round(minutes)} min ${esc(mode || 'walk')}` +
    (live ? '' : ' <span class="est-chip" title="Estimated from distance, not routed">est</span>') + '</p>';
}

function stopCardHtml(stop, opts){
  const { photos, num, time, dayLabel, extra } = opts;
  const tags = (stop.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const id = 'stop-' + esc(String(stop.id));
  // Stops already ticked off in the planner start ticked here; the page then
  // keeps its own ticks on top, for the days walked after the file was made.
  const done = !!stop.done;
  return `
  <article class="stop${done ? ' done' : ''}" id="${id}" data-search="${esc(searchText(stop, dayLabel))}">
    <div class="stop-head">
      <span class="num${num == null ? ' nonum' : ''}">${num == null ? '·' : esc(String(num))}</span>
      ${photoHtml(stop.img, stop.cat, stop.name, photos)}
      <div class="stop-title">
        ${time ? `<p class="time">${esc(time)}</p>` : ''}
        <h3>${esc(stop.name)}</h3>
        ${extra || ''}
      </div>
      <button class="tick" type="button" data-tick="${id}" aria-pressed="${done}" title="Mark as done">✓</button>
    </div>
    ${stop.desc ? `<p class="desc">${esc(stop.desc)}</p>` : ''}
    ${stop.detail ? `<details class="more"><summary>More about this</summary><p>${esc(stop.detail)}</p></details>` : ''}
    ${stop.notes ? `<p class="notes">📝 ${esc(stop.notes)}</p>` : ''}
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${coordsHtml(stop.lat, stop.lng, stop.name)}
    ${AB_CATS.includes(stop.cat) && stop.endLat != null ? coordsHtml(stop.endLat, stop.endLng, stop.name + (stop.cat === 'hike' ? ' (end)' : ' (arrival)'), 'end') : ''}
  </article>`;
}

function dayHtml(trip, day, idx, opts){
  const sched = computeSchedule(trip, day);
  const date = dayDate(trip.startDate, idx);
  const dayLabel = 'Day ' + day.id + ' ' + (day.title || '');
  const visitMin = sched.rows.reduce((n, r) => n + (r.stop.dur || 0), 0);

  const facts = [
    date ? formatDayDate(date) : null,
    'starts ' + formatTime(parseTime(day.start)),
    sched.rows.length + (sched.rows.length === 1 ? ' stop' : ' stops'),
    visitMin ? formatDur(visitMin) + ' of visits' : null,
    sched.rows.some(r => r.stop.done)
      ? '✓ ' + sched.rows.filter(r => r.stop.done).length + ' of ' + sched.rows.length + ' done' : null,
    sched.walkKm >= 0.1 ? n1(sched.walkKm) + ' km on foot' : null,
    sched.otherKm >= 0.1 ? n1(sched.otherKm) + ' km other transport' : null,
  ].filter(Boolean);

  const body = [];
  if(sched.startHotel && sched.leadTransfer)
    body.push(connectorHtml(sched.leadTransfer.minutes, sched.leadTransfer.mode, sched.leadTransfer.live,
      'Depart ' + sched.startHotel.name + ','));

  let num = 0;
  sched.rows.forEach((row, i) => {
    if(i > 0 && row.travelBefore > 0)
      body.push(connectorHtml(row.travelBefore, row.travelMode || 'walk', row.travelLive, ''));
    if(row.waitBefore > 0)
      body.push(`<p class="leg wait">⏳ ${row.waitBefore} min spare before the fixed start</p>`);
    const s = row.stop;
    if(s.lat != null) num += 1;
    const isRide = AB_CATS.includes(s.cat) && s.cat !== 'hike' && s.endLat != null && s.lat != null;
    const chips = [
      formatDur(s.dur),
      s.fixedStart ? '⏰ fixed ' + s.fixedStart : null,
      row.late > 0 ? '⚠ ' + row.late + ' min late' : null,
      row.hikeLeg ? '🥾 ' + n1(row.hikeLeg.distKm || 0) + ' km walk to the end point' : null,
      isRide ? (CAT_ICONS[s.cat] || '🚄') + ' ~' + Math.round(haversineKm(s.lat, s.lng, s.endLat, s.endLng)) + ' km leg — the day continues from where it arrives' : null,
    ].filter(Boolean).map(c => `<span class="chip">${esc(c)}</span>`).join('');
    body.push(stopCardHtml(s, {
      photos: opts.photos,
      num: s.lat != null ? num : null,
      time: formatTime(row.start),
      dayLabel,
      extra: `<div class="chips">${chips}</div>`,
    }));
  });

  const sameHotel = sched.startHotel && sched.endHotel && sched.startHotel.id === sched.endHotel.id;
  if(!sched.rows.length) body.push('<p class="empty">Nothing planned for this day.</p>');
  if(sched.trailTransfer)
    body.push(connectorHtml(sched.trailTransfer.minutes, sched.trailTransfer.mode, sched.trailTransfer.live,
      (sameHotel ? 'Back to ' : 'On to ') + (sched.endHotel ? sched.endHotel.name : 'the hotel') + ','));
  if(sched.rows.length && sched.endHotel)
    body.push(`<p class="dayend">${sameHotel ? 'Back' : 'At ' + esc(sched.endHotel.name)} by ${esc(formatTime(sched.returnTime))}</p>`);

  const map = opts.maps && sched.rows.some(r => r.stop.lat != null) ? daySvg(trip, day, sched) : '';

  let hotelLine = '';
  if(sameHotel) hotelLine = `🛏 ${esc(sched.startHotel.name)}`;
  else if(sched.startHotel && sched.endHotel)
    hotelLine = `🛏 ${esc(sched.startHotel.name)} <span class="quiet">→</span> ${esc(sched.endHotel.name)} <span class="quiet">(hotel change)</span>`;
  else if(sched.startHotel) hotelLine = `🛏 ${esc(sched.startHotel.name)} <span class="quiet">(start of the day only)</span>`;
  else if(sched.endHotel) hotelLine = `🛏 ${esc(sched.endHotel.name)} <span class="quiet">(end of the day only)</span>`;

  return `
  <section class="view" id="view-d${idx}"${dayAccentStyle(day, opts.vars)} hidden>
    <div class="dayhead">
      <h2>Day ${day.id}${day.title ? ' · ' + esc(day.title) : ''}</h2>
      <p class="facts">${esc(facts.join(' · '))}</p>
      ${hotelLine ? `<p class="hotel">${hotelLine}</p>` : ''}
    </div>
    ${map}
    <div class="timeline">${body.join('')}</div>
  </section>`;
}

function infoHtml(trip, opts){
  const cards = [];

  if(trip.hotels.length){
    cards.push(`<div class="card"><h3>🛏 Hotels</h3>` + trip.hotels.map(h => {
      // A day's end hotel is where that night is spent, so counting end
      // hotels counts the actual nights.
      const nights = trip.days.filter(d => d.endHotelId === h.id).length;
      return `<div class="hotel-row">${photoHtml(h.img, 'hotel', h.name, opts.photos)}
        <div><p class="hotel-name">${esc(h.name)}</p>
        <p class="quiet">${nights ? nights + (nights === 1 ? ' night' : ' nights') : 'no nights assigned'}${h.mode === 'boat' ? ' · reached by boat' : ''}</p>
        ${h.desc ? `<p class="desc">${esc(h.desc)}</p>` : ''}
        ${coordsHtml(h.lat, h.lng, h.name)}</div></div>`;
    }).join('') + '</div>');
  }

  const live = (trip.checklist || []).filter(c => !c.done);
  const done = (trip.checklist || []).filter(c => c.done);
  if(live.length || done.length){
    // Section headings keep their place among the open rows; ticked items are
    // collected at the end, past the last section, exactly as they read here.
    const row = (c) => c.type === 'header'
      ? `<p class="check-sec">${esc(c.text)}</p>`
      : `<label class="check"><input type="checkbox" data-check="${esc(c.id)}"${c.done ? ' checked' : ''}><span>${esc(c.text)}</span></label>`;
    cards.push(`<div class="card"><h3>✅ Checklist</h3>${live.map(row).join('')}${done.map(row).join('')}
      <p class="quiet small">Ticks here are kept on this device only — they don't travel back to the planner.</p></div>`);
  }

  const INFO = [['weather','🌤','Weather'], ['closures','🚫','Closures'], ['reservations','🎟','Reservations'],
    ['events','🎭','Events'], ['notes','📓','Notes']];
  INFO.forEach(([key, ico, title]) => {
    const text = (trip.info || {})[key];
    if(!text || !String(text).trim()) return;
    cards.push(`<div class="card"><h3>${ico} ${title}</h3><div class="prose">${esc(text).replace(/\n/g, '<br>')}</div></div>`);
  });

  if(!cards.length) cards.push('<p class="empty">No trip info was filled in.</p>');
  return `<section class="view" id="view-info" hidden><div class="cards">${cards.join('')}</div></section>`;
}

function optionalHtml(trip, opts){
  const items = (trip.optional || []).map(o => trip.stops[o.id] ? { stop: trip.stops[o.id], meta: o } : null).filter(Boolean);
  if(!items.length) return '';
  return `<section class="view" id="view-opt" hidden>
    <div class="dayhead"><h2>Unassigned</h2><p class="facts">Ideas with no day of their own</p></div>
    <div class="timeline">${items.map(({ stop, meta }) => stopCardHtml(stop, {
      photos: opts.photos, num: null, time: '', dayLabel: 'Unassigned',
      extra: `<div class="chips"><span class="chip">${esc(formatDur(stop.dur))}</span>` +
        (meta.day ? `<span class="chip">suggested day ${esc(String(meta.day))}</span>` : '') + '</div>' +
        (meta.note ? `<p class="desc quiet">${esc(meta.note)}</p>` : ''),
    })).join('')}</div>
  </section>`;
}

/* ---------- CSS ---------- */

function pageCss(vars){
  const v = Object.entries(vars).map(([k, val]) => `  ${k}:${val};`).join('\n');
  return `
:root{
${v}
  --radius:12px;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;}
body{margin:0; background:var(--paper); color:var(--ink); font-family:var(--sans); font-size:16px; line-height:1.5;
  padding-bottom:env(safe-area-inset-bottom);}
h1,h2,h3{font-family:var(--serif); font-weight:600; margin:0;}
a{color:var(--accent-dark); text-decoration-thickness:1px; text-underline-offset:2px;}
.quiet{color:var(--ink-soft);}
.small{font-size:13px;}
.wrap{max-width:820px; margin:0 auto; padding:0 14px 60px;}

header.hero{padding:26px 14px 18px; text-align:center; background:var(--paper-card); border-bottom:1px solid var(--line);}
.hero .eyebrow{margin:0 0 6px; font-family:var(--mono); font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-soft);}
.hero h1{font-size:30px; line-height:1.15;}
.hero .sub{margin:8px auto 0; max-width:34em; color:var(--ink-soft); font-size:15px;}
.hero .meta{margin:10px 0 0; font-family:var(--mono); font-size:12px; color:var(--ink-soft);}

nav.pills{position:sticky; top:0; z-index:20; display:flex; gap:6px; overflow-x:auto; padding:9px 12px;
  background:var(--paper); border-bottom:1px solid var(--line); scrollbar-width:none; -webkit-overflow-scrolling:touch;}
nav.pills::-webkit-scrollbar{display:none;}
nav.pills button{flex:none; padding:7px 12px; border-radius:999px; border:1px solid var(--line); background:var(--card);
  color:var(--ink); font:inherit; font-size:13.5px; cursor:pointer; white-space:nowrap;}
nav.pills button .d{font-family:var(--mono); font-size:11px; color:var(--ink-soft); margin-left:5px;}
nav.pills button.on{background:var(--accent); border-color:var(--accent); color:#fff;}
nav.pills button.on .d{color:rgba(255,255,255,.8);}

.searchbar{display:flex; gap:8px; align-items:center; margin:14px 0 4px;}
.searchbar input{flex:1; min-width:0; padding:11px 13px; border:1px solid var(--line); border-radius:10px;
  background:var(--card); color:var(--ink); font:inherit; font-size:16px;}
.searchbar button{padding:11px 13px; border:1px solid var(--line); border-radius:10px; background:var(--card);
  color:var(--ink); font:inherit; cursor:pointer;}
.results{margin:10px 0 0;}
.results .hit{display:flex; gap:10px; align-items:baseline; width:100%; text-align:left; padding:10px 12px; margin-bottom:6px;
  border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink); font:inherit; cursor:pointer;}
.results .hit .where{font-family:var(--mono); font-size:11px; color:var(--ink-soft); flex:none;}
.results .none{color:var(--ink-soft); padding:10px 2px;}

.dayhead{margin:18px 0 12px;}
.dayhead h2{font-size:23px;}
.facts{margin:6px 0 0; font-family:var(--mono); font-size:12px; color:var(--ink-soft);}
.dayhead .hotel{margin:8px 0 0; font-size:14px;}

svg.map{display:block; width:100%; height:auto; max-height:52vh; margin:0 0 16px; background:var(--paper-card);
  border:1px solid var(--line); border-radius:var(--radius);}
svg.map .rt{fill:none; stroke:var(--accent); stroke-width:3; stroke-linejoin:round; stroke-linecap:round; opacity:.75;}
svg.map .rt.est{stroke-dasharray:6 6; opacity:.5;}
svg.map .pin circle{fill:var(--accent); stroke:var(--card); stroke-width:2;}
svg.map .pin text{fill:#fff; font-family:var(--mono); font-size:11px; text-anchor:middle;}
svg.map .pin.hotel circle{fill:var(--ink);}
svg.map .sc line{stroke:var(--ink-soft); stroke-width:1.5;}
svg.map .sc text{fill:var(--ink-soft); font-family:var(--mono); font-size:11px;}

.leg{margin:0; padding:7px 4px 7px 30px; font-family:var(--mono); font-size:12px; color:var(--ink-soft);}
.leg.wait{color:var(--gold);}
.est-chip{font-size:10px; opacity:.75;}
.dayend{margin:10px 0 0; padding-left:30px; font-family:var(--mono); font-size:12px; color:var(--ink-soft);}
.empty{color:var(--ink-soft); padding:12px 2px;}

.stop{background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:12px;
  margin:0 0 10px; box-shadow:0 1px 4px rgba(0,0,0,.05);}
.stop.done{opacity:.55;}
.stop.done h3{text-decoration:line-through;}
.stop.flash{box-shadow:0 0 0 3px var(--accent);}
.stop-head{display:flex; gap:10px; align-items:flex-start;}
.num{flex:none; min-width:24px; height:24px; padding:0 5px; border-radius:12px; background:var(--accent); color:#fff;
  font-family:var(--mono); font-size:12px; display:flex; align-items:center; justify-content:center;}
.num.nonum{background:transparent; color:var(--ink-soft); border:1px dashed var(--line);}
.ph{flex:none; width:64px; height:64px; border-radius:10px; background:var(--accent-tint); overflow:hidden;
  display:flex; align-items:center; justify-content:center; font-size:26px; line-height:1;}
.ph::before{content:attr(data-ico);}
.ph.has-img::before{display:none;}
.ph img{width:100%; height:100%; object-fit:cover; display:block;}
.stop-title{flex:1; min-width:0;}
.stop-title h3{font-size:18px; line-height:1.25; overflow-wrap:anywhere;}
.time{margin:0 0 2px; font-family:var(--mono); font-size:12.5px; color:var(--accent-dark);}
.chips{display:flex; flex-wrap:wrap; gap:5px; margin-top:5px;}
.chip{font-family:var(--mono); font-size:11px; color:var(--ink-soft); border:1px solid var(--line);
  border-radius:999px; padding:1px 7px;}
.tick{flex:none; width:30px; height:30px; border-radius:50%; border:1px solid var(--line); background:var(--paper-card);
  color:var(--ink-soft); font-size:14px; cursor:pointer;}
.tick[aria-pressed="true"]{background:var(--accent); border-color:var(--accent); color:#fff;}
.desc{margin:9px 0 0; font-size:14.5px;}
.notes{margin:8px 0 0; padding:8px 10px; background:var(--accent-tint); border-radius:8px; font-size:14px; white-space:pre-wrap;}
.more{margin:8px 0 0; font-size:14px;}
.more summary{cursor:pointer; color:var(--ink-soft); font-size:13px;}
.more p{margin:6px 0 0;}
.tags{display:flex; flex-wrap:wrap; gap:5px; margin-top:8px;}
.tag{font-size:11.5px; background:var(--accent-tint); color:var(--accent-dark); border-radius:999px; padding:2px 8px;}
.coords{margin:8px 0 0; font-family:var(--mono); font-size:12px;}
.coords.end{margin-top:2px; opacity:.8;}
.coords a{margin-right:10px;}

.cards{display:grid; gap:12px; margin-top:16px;}
.card{background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:14px;}
.card h3{font-size:17px; margin-bottom:8px;}
.prose{font-size:14.5px; overflow-wrap:anywhere;}
.hotel-row{display:flex; gap:10px; margin-bottom:12px;}
.hotel-row:last-of-type{margin-bottom:0;}
.hotel-name{margin:0; font-weight:600;}
.check{display:flex; gap:9px; align-items:flex-start; padding:6px 0; font-size:14.5px; cursor:pointer;}
.check input{width:18px; height:18px; margin-top:2px; accent-color:var(--accent); flex:none;}
.check input:checked + span{text-decoration:line-through; color:var(--ink-soft);}
.check-sec{margin:12px 0 2px; font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:0.07em; color:var(--ink-soft);}
.check-sec:first-child{margin-top:0;}

footer{margin-top:28px; padding-top:16px; border-top:1px solid var(--line); font-size:13.5px; color:var(--ink-soft);}
footer h3{font-size:15px; margin-bottom:6px; color:var(--ink);}
footer details{margin:10px 0;}
footer summary{cursor:pointer;}
footer ol{margin:8px 0 0; padding-left:20px;}
footer li{margin-bottom:4px;}
.tools{display:flex; flex-wrap:wrap; gap:8px; margin:12px 0;}
.tools button{padding:9px 13px; border:1px solid var(--line); border-radius:10px; background:var(--card); color:var(--ink);
  font:inherit; font-size:13.5px; cursor:pointer;}
#trip-src{display:none;}

@media (min-width:640px){
  .hero h1{font-size:38px;}
  .ph{width:88px; height:88px; font-size:34px;}
}
/* Printing (and "Save as PDF") wants the whole trip, not the open day. */
@media print{
  nav.pills,.searchbar,.results,.tick,.tools,footer details{display:none !important;}
  .view[hidden]{display:block !important;}
  body{background:#fff;}
  .stop{break-inside:avoid; box-shadow:none;}
  .view + .view{break-before:page;}
}
`;
}

/* ---------- page script (plain, non-module: file:// blocks modules) ---------- */

function pageJs(storeKey){
  return `
(function(){
  var KEY = ${JSON.stringify(storeKey)};
  var views = [].slice.call(document.querySelectorAll('.view'));
  var pills = [].slice.call(document.querySelectorAll('nav.pills button'));

  function show(id, focusId, quiet){
    views.forEach(function(v){ v.hidden = v.id !== id; });
    pills.forEach(function(b){
      var on = b.getAttribute('data-view') === id;
      b.classList.toggle('on', on);
      // Scroll the strip itself, not the page: scrollIntoView would drag the
      // whole document up to the sticky bar and hide the trip's own header.
      if(on && b.parentNode) b.parentNode.scrollLeft = b.offsetLeft - (b.parentNode.clientWidth - b.offsetWidth) / 2;
    });
    // Not on the first paint: a fragment written while the page is still
    // loading makes the browser jump to it once loading finishes, which
    // would scroll the trip's header off before it was ever seen.
    if(!quiet){ try{ history.replaceState(null, '', '#' + id); }catch(e){} }
    if(focusId){
      var el = document.getElementById(focusId);
      if(el){
        el.scrollIntoView({block:'center'});
        el.classList.add('flash');
        setTimeout(function(){ el.classList.remove('flash'); }, 1400);
      }
    } else {
      window.scrollTo(0, 0);
    }
  }
  pills.forEach(function(b){ b.addEventListener('click', function(){
    show(b.getAttribute('data-view'));
    if(q && q.value){ q.value = ''; runSearch(); }      // a day was picked; the hit list has had its say
  }); });
  var start = (location.hash || '').replace('#','');
  var known = views.some(function(v){ return v.id === start; });
  show(known ? start : views[0].id, null, true);
  if(!known) window.scrollTo(0, 0);

  /* ---- search ---- */
  var q = document.getElementById('q');
  var res = document.getElementById('results');
  var cards = [].slice.call(document.querySelectorAll('.stop'));
  var index = cards.map(function(c){
    var view = c.closest('.view');
    var pill = document.querySelector('nav.pills button[data-view="' + view.id + '"]');
    return { id:c.id, view:view.id, hay:c.getAttribute('data-search') || '',
      name:(c.querySelector('h3') || {}).textContent || '',
      time:(c.querySelector('.time') || {}).textContent || '',
      where:pill ? pill.getAttribute('data-short') || pill.textContent : '' };
  });
  function runSearch(){
    var term = q.value.trim().toLowerCase();
    if(!term){ res.hidden = true; res.innerHTML = ''; return; }
    var hits = index.filter(function(it){ return it.hay.indexOf(term) !== -1; }).slice(0, 40);
    res.hidden = false;
    if(!hits.length){ res.innerHTML = '<p class="none">Nothing matches “' + term.replace(/[<>&]/g,'') + '”.</p>'; return; }
    res.innerHTML = '';
    hits.forEach(function(it){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'hit';
      var w = document.createElement('span');
      w.className = 'where';
      w.textContent = it.where + (it.time ? ' · ' + it.time : '');
      var n = document.createElement('span');
      n.textContent = it.name;
      b.appendChild(w); b.appendChild(n);
      b.addEventListener('click', function(){ show(it.view, it.id); });
      res.appendChild(b);
    });
  }
  q.addEventListener('input', runSearch);
  document.getElementById('q-clear').addEventListener('click', function(){ q.value = ''; runSearch(); q.focus(); });

  /* ---- a photo that isn't embedded (and there is no signal) goes back to
         being the category icon, rather than a broken-image box. An image can
         fail before this script runs, so already-finished ones are checked
         outright rather than waited on. ---- */
  [].slice.call(document.querySelectorAll('.ph img')).forEach(function(img){
    var drop = function(){
      var box = img.parentNode;
      if(box){ box.classList.remove('has-img'); img.remove(); }
    };
    if(img.complete && img.naturalWidth === 0) drop();
    else img.addEventListener('error', drop);
  });

  /* ---- ticks: local to this file, on this device ---- */
  var saved = { visited:[], checked:[] };
  try{ saved = JSON.parse(localStorage.getItem(KEY)) || saved; }catch(e){}
  function save(){ try{ localStorage.setItem(KEY, JSON.stringify(saved)); }catch(e){} }

  [].slice.call(document.querySelectorAll('.tick')).forEach(function(btn){
    var id = btn.getAttribute('data-tick');
    var card = document.getElementById(id);
    function paint(on){
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if(card) card.classList.toggle('done', on);
    }
    // What the trip already said, unless this device has since said otherwise.
    var wasDone = btn.getAttribute('aria-pressed') === 'true';
    paint(saved.visited.indexOf('off:' + id) !== -1 ? false
      : (wasDone || saved.visited.indexOf(id) !== -1));
    btn.addEventListener('click', function(){
      var on = btn.getAttribute('aria-pressed') !== 'true';
      // Both directions are recorded: unticking something the trip already
      // called done has to survive a reload too.
      saved.visited = saved.visited.filter(function(x){ return x !== id && x !== 'off:' + id; });
      saved.visited.push(on ? id : 'off:' + id);
      paint(on);
      save();
    });
  });

  [].slice.call(document.querySelectorAll('input[data-check]')).forEach(function(box){
    var id = box.getAttribute('data-check');
    if(saved.checked.indexOf('on:' + id) !== -1) box.checked = true;
    if(saved.checked.indexOf('off:' + id) !== -1) box.checked = false;
    box.addEventListener('change', function(){
      saved.checked = saved.checked.filter(function(x){ return x !== 'on:' + id && x !== 'off:' + id; });
      saved.checked.push((box.checked ? 'on:' : 'off:') + id);
      save();
    });
  });

  /* ---- the trip file, for importing back into the planner ---- */
  var src = document.getElementById('trip-src');
  var dl = document.getElementById('dl-src');
  if(dl) dl.addEventListener('click', function(){
    var blob = new Blob([src.value], {type:'text/markdown'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ${JSON.stringify(storeKey.replace(/^tp-offline:/, '') + '.md')};
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 5000);
  });
  var cp = document.getElementById('copy-src');
  if(cp) cp.addEventListener('click', function(){
    var done = function(){ cp.textContent = 'Copied ✓'; setTimeout(function(){ cp.textContent = 'Copy trip file'; }, 1500); };
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(src.value).then(done, function(){}); return; }
    src.style.display = 'block'; src.select();
    try{ document.execCommand('copy'); done(); }catch(e){}
    src.style.display = 'none';
  });
})();
`;
}

/* ---------- the document ---------- */

export function offlineFileName(trip){
  return slugify(trip.name) + '-offline.html';
}

/* opts: { photos: Map<url, dataUri>|null, maps: bool, optional: bool,
           planUrl: string|null, generatedAt: Date } */
export function buildOfflineHtml(trip, opts = {}){
  const vars = readThemeVars();
  const o = Object.assign({ photos: null, maps: true, optional: true, planUrl: null, generatedAt: new Date() }, opts, { vars });
  const storeKey = 'tp-offline:' + slugify(trip.name);

  const days = trip.days.map((d, i) => dayHtml(trip, d, i, o)).join('');
  const optional = o.optional ? optionalHtml(trip, o) : '';
  const info = infoHtml(trip, o);

  const pills = [
    ...trip.days.map((d, i) => {
      const date = dayDate(trip.startDate, i);
      return `<button data-view="view-d${i}" data-short="Day ${d.id}">Day ${d.id}${date ? `<span class="d">${esc(formatDayDate(date))}</span>` : ''}</button>`;
    }),
    optional ? '<button data-view="view-opt" data-short="Unassigned">Unassigned</button>' : '',
    `<button data-view="view-info" data-short="Trip info">Trip info</button>`,
  ].filter(Boolean).join('');

  const stopCount = trip.days.reduce((n, d) => n + d.order.length, 0);
  const range = tripDateRange(trip);
  const stamp = o.generatedAt.toISOString().slice(0, 10);
  const meta = [trip.days.length + (trip.days.length === 1 ? ' day' : ' days'), range,
    stopCount + ' stops', 'saved offline ' + stamp].filter(Boolean).join(' · ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="${esc(vars['--paper'])}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex">
<title>${esc(trip.name || 'Trip')} — offline itinerary</title>
<style>${pageCss(vars)}</style>
</head>
<body>

<header class="hero">
  <p class="eyebrow">Offline itinerary</p>
  <h1>${esc(trip.name || 'Trip')}</h1>
  ${trip.subtitle ? `<p class="sub">${esc(trip.subtitle)}</p>` : ''}
  <p class="meta">${esc(meta)}</p>
</header>

<nav class="pills" aria-label="Days">${pills}</nav>

<div class="wrap">
  <div class="searchbar">
    <input id="q" type="search" placeholder="Search stops, notes, tags…" autocomplete="off" aria-label="Search the itinerary">
    <button id="q-clear" type="button" aria-label="Clear search">✕</button>
  </div>
  <div class="results" id="results" hidden></div>

  <main>${days}${optional}${info}</main>

  <footer>
    <h3>This file works with no signal</h3>
    <p>Everything here — text, photos, route sketches — is inside this one file. It never loads anything from the
      internet, so it opens the same on a plane as it does at home. Coordinates open in whatever map app the phone
      has; an offline map app (Organic Maps, OsmAnd…) will place them without a connection.</p>
    <details>
      <summary>Keeping it on a phone</summary>
      <ol>
        <li><b>iPhone:</b> open this file once in Safari, then Share → <i>Add to Home Screen</i>, or keep it in
          Files (On My iPhone) and open it from there.</li>
        <li><b>Android:</b> keep it in Downloads and open it with Chrome, or Chrome menu → <i>Add to Home screen</i>.</li>
        <li>Airdrop / email / message the file to whoever is travelling with you — it needs nothing else.</li>
      </ol>
    </details>
    <p class="small">Ticks and checklist marks are stored by this file on this device alone. Nothing here edits the
      trip — reopen the planner for that.</p>
    <div class="tools">
      <button id="dl-src" type="button">Download trip file (.md)</button>
      <button id="copy-src" type="button">Copy trip file</button>
    </div>
    <p class="small">The trip file above is what the planner imports — it carries every stop, note and setting back.</p>
    ${o.planUrl ? `<p class="small">Back online: <a href="${esc(o.planUrl)}">open the live plan</a>. Anyone with that
      link can edit the trip, so pass the link on with the same care you'd give the trip itself.</p>` : ''}
    <p class="small">Exported ${esc(stamp)} from Travel Planner.</p>
    <textarea id="trip-src" readonly aria-hidden="true">${esc(serializeTrip(trip))}</textarea>
  </footer>
</div>

<script>${pageJs(storeKey)}</script>
</body>
</html>
`;
}

/* ---------- photo embedding ----------
   Fetch each distinct photo once, shrink it to something a phone screen can
   actually use, and hand back data: URIs. Best effort throughout: a host that
   refuses cross-origin reads, a dead link, or being offline at export time
   costs that one photo and nothing else. */

const PHOTO_MAX_PX = 900;
const PHOTO_QUALITY = 0.72;
const PHOTO_CONCURRENCY = 4;

export function photoUrls(trip, { optional = true } = {}){
  const urls = new Set();
  const add = (u) => { if(u && /^https?:\/\//i.test(String(u).trim())) urls.add(String(u).trim()); };
  const wanted = new Set(trip.days.flatMap(d => d.order));
  if(optional) (trip.optional || []).forEach(o => wanted.add(o.id));
  Object.values(trip.stops).forEach(s => { if(wanted.has(s.id)) add(s.img); });
  trip.hotels.forEach(h => add(h.img));
  return [...urls];
}

async function toDataUri(url){
  const res = await fetch(url, { referrerPolicy: 'no-referrer', mode: 'cors', cache: 'force-cache' });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  if(!/^image\//.test(blob.type || '')) throw new Error('not an image');

  // Re-encode down to phone size. If anything about that fails (SVG, a codec
  // the canvas won't take), fall back to embedding the bytes as they came.
  try{
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    const out = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: PHOTO_QUALITY })
      : await new Promise((res2, rej) => canvas.toBlob(b => b ? res2(b) : rej(new Error('encode failed')), 'image/jpeg', PHOTO_QUALITY));
    return await blobToDataUri(out.size < blob.size ? out : blob);
  } catch(e){
    return await blobToDataUri(blob);
  }
}

function blobToDataUri(blob){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/* Resolves to { photos: Map<originalUrl, dataUri>, ok, failed }.
   onProgress({done, total, ok}) fires as they land. */
export async function collectPhotos(trip, { optional = true, onProgress = null } = {}){
  const urls = photoUrls(trip, { optional });
  const photos = new Map();
  let done = 0, failed = 0;

  const worker = async (queue) => {
    while(queue.length){
      const url = queue.shift();
      for(const candidate of imageCandidates(url)){
        try{
          photos.set(url, await toDataUri(candidate));
          break;
        } catch(e){ /* next candidate */ }
      }
      if(!photos.has(url)) failed += 1;
      done += 1;
      if(onProgress) onProgress({ done, total: urls.length, ok: photos.size });
    }
  };

  const queue = [...urls];
  await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, queue.length) }, () => worker(queue)));
  return { photos, ok: photos.size, failed, total: urls.length };
}
