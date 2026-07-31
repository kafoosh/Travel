/* =========================================================
   TRAVEL-TIME ROUTING

   Two keyless, community-run public servers, both OSM-based:

   - Valhalla (FOSSGIS e.V.): real street-network walking and
     driving routes. Fair-use demo server; we identify with an
     X-Client-Id header per their policy and go through a small
     rate-limited queue.
   - Transitous (MOTIS): schedule-aware public transport
     (buses, metro, ferries — including Venice's vaporetti).

   Everything is layered over a synchronous heuristic:

     estimateLeg() ALWAYS returns immediately — from the live
     cache when a real answer is known, from the haversine
     heuristic otherwise — and quietly enqueues a fetch for
     any leg it had to guess. When real numbers land, the
     'update' listeners fire and the caller re-renders. Results
     are cached in localStorage (OSM data is ODbL — caching is
     explicitly allowed), so a trip converges to zero requests.

   Alongside the duration, each routed answer keeps the route
   GEOMETRY (decoded polyline, simplified), so the map can draw
   the actual street/transit path instead of a straight line.
   ========================================================= */

import { haversineKm } from './util.js';

/* Server bases are overridable via localStorage so self-hosters can point at
   their own instances (and tests at a mock) without touching code. */
function baseOverride(key, fallback){
  try{ return localStorage.getItem(key) || fallback; } catch(e){ return fallback; }
}
const VALHALLA = baseOverride('routing.valhallaBase', 'https://valhalla1.openstreetmap.de');
const TRANSITOUS = baseOverride('routing.transitousBase', 'https://api.transitous.org');
const CLIENT_ID = 'kafoosh-travel-planner';

const CACHE_KEY = 'travelPlanner_routeCache_v1';
const SHAPE_KEY = 'travelPlanner_shapeCache_v1';
const CACHE_MAX = 2500;
const SHAPE_MAX = 300;           // shapes are ~100× bigger than durations — cap harder
const MAX_SHAPE_PTS = 150;
const WALK_MAX_KM = 2.2;         // beyond this (street distance) we assume a ride
const WALK_KMH = 4.5;

/* ---------- heuristic fallback (haversine + circuity) ---------- */

function circuity(rawKm){
  // Streets aren't straight lines; the detour factor grows with distance.
  return Math.min(1.6, 1.2 + rawKm * 0.12);
}
function round5(m){ return Math.max(5, Math.round(m / 5) * 5); }

export function heuristicLeg(a, b, opts = {}){
  const rawKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
  if(opts.boat){
    // Hotel boat shuttle (e.g. a private-island resort): ~11 km/h door to door.
    return { minutes: Math.max(10, round5(rawKm / 11 * 60)), mode:'boat', live:false, path:null };
  }
  const walkKm = rawKm * circuity(rawKm);
  if(walkKm <= WALK_MAX_KM){
    return { minutes: round5(walkKm / WALK_KMH * 60), mode:'walk', live:false, path:null };
  }
  // Generic surface transit/taxi guess: ~14 km/h effective + boarding overhead.
  return { minutes: Math.max(12, round5(rawKm * 1.2 / 14 * 60 + 8)), mode:'transit', live:false, path:null };
}

/* ---------- polyline geometry ---------- */

/* Standard Google encoded-polyline decoder. Valhalla encodes at precision 6;
   MOTIS/OTP-style APIs vary (5–7), so decodeBest picks whichever precision
   lands the endpoints nearest the requested locations. */
export function decodePolyline(str, precision = 6){
  const factor = 10 ** precision;
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while(index < str.length){
    for(const which of [0, 1]){
      let shift = 0, result = 0, byte;
      do{
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while(byte >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if(which === 0) lat += delta; else lng += delta;
    }
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

function decodeBest(str, a, b, hintPrecision){
  const tries = hintPrecision ? [hintPrecision, 7, 6, 5] : [7, 6, 5];
  let best = null, bestErr = Infinity;
  for(const p of tries){
    let c;
    try{ c = decodePolyline(str, p); } catch(e){ continue; }
    if(c.length < 2) continue;
    const err = Math.abs(c[0][0] - a.lat) + Math.abs(c[0][1] - a.lng)
              + Math.abs(c[c.length-1][0] - b.lat) + Math.abs(c[c.length-1][1] - b.lng);
    if(err < bestErr){ bestErr = err; best = c; }
  }
  return bestErr < 0.05 ? best : null;   // endpoints must land near the request
}

function simplifyPath(pts){
  if(!pts || pts.length <= MAX_SHAPE_PTS) return pts;
  const step = Math.ceil(pts.length / MAX_SHAPE_PTS);
  const out = pts.filter((_, i) => i % step === 0);
  if(out[out.length-1] !== pts[pts.length-1]) out.push(pts[pts.length-1]);
  return out;
}
function roundPath(pts){
  return pts && pts.map(([la, ln]) => [Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5]);
}

/* ---------- persistent caches ---------- */

function loadJson(key){
  try{ const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) || {}) : {}; }
  catch(e){ return {}; }
}
let cache = loadJson(CACHE_KEY);    // key -> {m, mode, t}
let shapes = loadJson(SHAPE_KEY);   // key -> {p: [[lat,lng],…], t}

let cacheDirty = false;
function prune(obj, max){
  const keys = Object.keys(obj);
  if(keys.length > max){
    keys.sort((x, y) => (obj[x].t || 0) - (obj[y].t || 0))
      .slice(0, keys.length - max)
      .forEach(k => { delete obj[k]; });
  }
}
function persistCache(){
  if(!cacheDirty) return;
  cacheDirty = false;
  try{
    prune(cache, CACHE_MAX);
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    prune(shapes, SHAPE_MAX);
    localStorage.setItem(SHAPE_KEY, JSON.stringify(shapes));
  } catch(e){
    // Storage full: drop the bulky shapes, keep durations.
    try{ shapes = {}; localStorage.removeItem(SHAPE_KEY); localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch(e2){}
  }
}
setInterval(persistCache, 4000);
// The interval alone loses results that land just before a navigation/reload —
// flush whenever the page is being hidden, and when the fetch queue drains.
if(typeof addEventListener === 'function'){
  addEventListener('pagehide', persistCache);
  addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') persistCache(); });
}

function r4(x){ return Math.round(x * 1e4) / 1e4; }
function legKey(a, b, profile){
  return r4(a.lat) + ',' + r4(a.lng) + '>' + r4(b.lat) + ',' + r4(b.lng) + ':' + profile;
}

function storeResult(key, minutes, mode, path){
  cache[key] = { m: minutes, mode, t: Date.now() };
  if(path && path.length > 1) shapes[key] = { p: roundPath(simplifyPath(path)), t: Date.now() };
  cacheDirty = true;
  notify();
}

/* ---------- provider health ---------- */

const providers = {
  valhalla: { fails: 0, disabledUntil: 0 },
  transitous: { fails: 0, disabledUntil: 0 },
};
function providerOk(name){
  return providers[name].fails < 3 || Date.now() > providers[name].disabledUntil;
}
function noteFail(name){
  const p = providers[name];
  p.fails += 1;
  if(p.fails >= 3) p.disabledUntil = Date.now() + 10 * 60 * 1000; // back off 10 min
  notify();
}
function noteOk(name){
  const p = providers[name];
  if(p.fails) { p.fails = 0; notify(); }
}

export function routingStatus(){
  return {
    valhalla: providerOk('valhalla'),
    transitous: providerOk('transitous'),
    pending: queue.length + inFlight.size,
  };
}

/* ---------- update listeners ---------- */

const listeners = new Set();
export function onRoutingUpdate(fn){ listeners.add(fn); return () => listeners.delete(fn); }
let notifyTimer = null;
function notify(){
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => listeners.forEach(fn => { try{ fn(); }catch(e){} }), 350);
}

/* ---------- fetch queue (be a polite guest on shared servers) ---------- */

const queue = [];
const inFlight = new Set();
const failedAt = {};           // key -> timestamp of last failure (retry after 5 min)
let workerRunning = false;

function enqueue(key, job){
  if(inFlight.has(key) || queue.some(q => q.key === key)) return;
  if(failedAt[key] && Date.now() - failedAt[key] < 5 * 60 * 1000) return;
  queue.push({ key, job });
  runWorker();
}

async function runWorker(){
  if(workerRunning) return;
  workerRunning = true;
  while(queue.length){
    const { key, job } = queue.shift();
    inFlight.add(key);
    try{ await job(); }
    catch(e){ failedAt[key] = Date.now(); }
    inFlight.delete(key);
    await new Promise(r => setTimeout(r, 300)); // ~3 req/s max, sequential
  }
  workerRunning = false;
  persistCache();   // queue drained — get the batch onto disk promptly
  notify();
}

async function fetchJson(url, options, provider, timeoutMs = 12000){
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    noteOk(provider);
    return data;
  } catch(e){
    noteFail(provider);
    throw e;
  } finally{
    clearTimeout(to);
  }
}

/* ---------- Valhalla (walking / driving) ---------- */

async function fetchValhalla(a, b, costing){
  const body = {
    locations: [ { lat:a.lat, lon:a.lng }, { lat:b.lat, lon:b.lng } ],
    costing,
    directions_options: { units: 'kilometers' },
  };
  const data = await fetchJson(VALHALLA + '/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
    body: JSON.stringify(body),
  }, 'valhalla');
  const sec = data && data.trip && data.trip.summary && data.trip.summary.time;
  if(typeof sec !== 'number') throw new Error('no route');
  // Valhalla returns each leg's geometry as an encoded polyline at precision 6.
  let path = null;
  const legs = (data.trip.legs || []).filter(l => l && l.shape);
  if(legs.length){
    path = [];
    legs.forEach(l => {
      try{ path.push(...decodePolyline(l.shape, 6)); } catch(e){}
    });
    if(path.length < 2) path = null;
  }
  return { minutes: Math.max(1, Math.round(sec / 60)), path };
}

/* ---------- Transitous / MOTIS (public transport) ---------- */

function transitTime(dayDate, minutes){
  // A concrete departure time makes transit answers schedule-aware. If the trip
  // has no dates, plan for the same weekday next week so schedules are typical.
  const d = dayDate ? new Date(dayDate.getTime()) : new Date(Date.now() + 7 * 864e5);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if(d.getTime() < Date.now()) d.setDate(d.getDate() + 7);
  return d.toISOString();
}

async function fetchTransitous(a, b, whenIso){
  const params = new URLSearchParams({
    fromPlace: a.lat + ',' + a.lng,
    toPlace: b.lat + ',' + b.lng,
    time: whenIso,
    arriveBy: 'false',
  });
  // MOTIS has shipped v1..v3 of the same endpoint; try newest first.
  let lastErr = null;
  for(const ver of ['v3', 'v1']){
    try{
      const data = await fetchJson(TRANSITOUS + '/api/' + ver + '/plan?' + params, {
        headers: { 'X-Client-Id': CLIENT_ID },
      }, 'transitous');
      const its = data && (data.itineraries || (data.plan && data.plan.itineraries));
      if(Array.isArray(its) && its.length){
        const it = its[0];
        let sec = it.duration;
        if(typeof sec !== 'number' && it.startTime && it.endTime){
          sec = (new Date(it.endTime) - new Date(it.startTime)) / 1000;
        }
        if(typeof sec === 'number' && sec > 0){
          return { minutes: Math.max(1, Math.round(sec / 60)), path: transitPath(it, a, b) };
        }
      }
      throw new Error('no itinerary');
    } catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('transit failed');
}

/* Stitch an itinerary's leg geometries into one path. Legs carry OTP-style
   legGeometry {points, precision?}; endpoints fall back to straight segments. */
function transitPath(it, a, b){
  const legs = it.legs;
  if(!Array.isArray(legs) || !legs.length) return null;
  const path = [];
  for(const leg of legs){
    const from = leg.from && { lat: leg.from.lat, lng: leg.from.lon ?? leg.from.lng };
    const to = leg.to && { lat: leg.to.lat, lng: leg.to.lon ?? leg.to.lng };
    const geom = leg.legGeometry && leg.legGeometry.points;
    let seg = null;
    if(geom && from && to) seg = decodeBest(geom, from, to, leg.legGeometry.precision);
    if(!seg && from && to) seg = [[from.lat, from.lng], [to.lat, to.lng]];
    if(seg) path.push(...seg);
  }
  if(path.length < 2) return null;
  // Anchor the drawn path to the exact requested endpoints.
  path.unshift([a.lat, a.lng]);
  path.push([b.lat, b.lng]);
  return path;
}

/* ---------- public API ---------- */

/* estimateLeg(a, b, opts) → {minutes, mode, live, path}
   opts: { boat:bool, dayDate:Date|null, departMinutes:number }
   path is [[lat,lng],…] when a routed geometry is known, else null. */
export function estimateLeg(a, b, opts = {}){
  if(!a || !b || a.lat == null || b.lat == null) return { minutes: 0, mode: null, live: false, path: null };

  const guess = heuristicLeg(a, b, opts);

  // Private hotel boat shuttles aren't in any public dataset — heuristic only.
  if(opts.boat) return guess;

  const profile = guess.mode === 'walk' ? 'walk' : 'transit';
  const key = legKey(a, b, profile);
  const hit = cache[key];
  if(hit){
    const sh = shapes[key];
    return { minutes: hit.m, mode: hit.mode, live: true, path: sh ? sh.p : null };
  }

  // Cache miss: return the guess now, fetch the real number in the background.
  if(profile === 'walk' && providerOk('valhalla')){
    enqueue(key, async () => {
      const r = await fetchValhalla(a, b, 'pedestrian');
      storeResult(key, r.minutes, 'walk', r.path);
    });
  } else if(profile === 'transit'){
    enqueue(key, async () => {
      if(providerOk('transitous')){
        try{
          const r = await fetchTransitous(a, b, transitTime(opts.dayDate, opts.departMinutes ?? 600));
          storeResult(key, r.minutes, 'transit', r.path);
          return;
        } catch(e){ /* fall through to a driving estimate */ }
      }
      if(providerOk('valhalla')){
        const r = await fetchValhalla(a, b, 'auto');
        storeResult(key, r.minutes + 6, 'taxi', r.path);   // hail/park overhead
      } else {
        throw new Error('all providers down');
      }
    });
  }
  return guess;
}

/* Used by the optimiser: best-known minutes right now, no fetching. */
export function knownMinutes(a, b, opts = {}){
  if(!a || !b || a.lat == null || b.lat == null) return 0;
  const guess = heuristicLeg(a, b, opts);
  if(opts.boat) return guess.minutes;
  const key = legKey(a, b, guess.mode === 'walk' ? 'walk' : 'transit');
  return cache[key] ? cache[key].m : guess.minutes;
}

export function clearRouteCache(){
  cache = {};
  shapes = {};
  cacheDirty = true;
  persistCache();
}
