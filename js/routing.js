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
   ========================================================= */

import { haversineKm } from './util.js';

const VALHALLA = 'https://valhalla1.openstreetmap.de';
const TRANSITOUS = 'https://api.transitous.org';
const CLIENT_ID = 'kafoosh-travel-planner';

const CACHE_KEY = 'travelPlanner_routeCache_v1';
const CACHE_MAX = 2500;
const WALK_MAX_KM = 2.2;        // beyond this (street distance) we assume a ride
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
    return { minutes: Math.max(10, round5(rawKm / 11 * 60)), mode:'boat', live:false };
  }
  const walkKm = rawKm * circuity(rawKm);
  if(walkKm <= WALK_MAX_KM){
    return { minutes: round5(walkKm / WALK_KMH * 60), mode:'walk', live:false };
  }
  // Generic surface transit/taxi guess: ~14 km/h effective + boarding overhead.
  return { minutes: Math.max(12, round5(rawKm * 1.2 / 14 * 60 + 8)), mode:'transit', live:false };
}

/* ---------- persistent cache ---------- */

let cache = {};
try{
  const raw = localStorage.getItem(CACHE_KEY);
  if(raw) cache = JSON.parse(raw) || {};
} catch(e){ cache = {}; }

let cacheDirty = false;
function persistCache(){
  if(!cacheDirty) return;
  cacheDirty = false;
  try{
    const keys = Object.keys(cache);
    if(keys.length > CACHE_MAX){
      keys.sort((x, y) => (cache[x].t || 0) - (cache[y].t || 0))
        .slice(0, keys.length - CACHE_MAX)
        .forEach(k => { delete cache[k]; });
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch(e){ /* storage full/blocked — cache stays in memory */ }
}
setInterval(persistCache, 4000);

function r4(x){ return Math.round(x * 1e4) / 1e4; }
function legKey(a, b, profile){
  return r4(a.lat) + ',' + r4(a.lng) + '>' + r4(b.lat) + ',' + r4(b.lng) + ':' + profile;
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
  return Math.max(1, Math.round(sec / 60));
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
        if(typeof sec === 'number' && sec > 0) return Math.max(1, Math.round(sec / 60));
      }
      throw new Error('no itinerary');
    } catch(e){ lastErr = e; }
  }
  throw lastErr || new Error('transit failed');
}

/* ---------- public API ---------- */

/* estimateLeg(a, b, opts) → {minutes, mode, live}
   opts: { boat:bool, dayDate:Date|null, departMinutes:number } */
export function estimateLeg(a, b, opts = {}){
  if(!a || !b || a.lat == null || b.lat == null) return { minutes: 0, mode: null, live: false };

  const guess = heuristicLeg(a, b, opts);

  // Private hotel boat shuttles aren't in any public dataset — heuristic only.
  if(opts.boat) return guess;

  const profile = guess.mode === 'walk' ? 'walk' : 'transit';
  const key = legKey(a, b, profile);
  const hit = cache[key];
  if(hit) return { minutes: hit.m, mode: hit.mode, live: true };

  // Cache miss: return the guess now, fetch the real number in the background.
  if(profile === 'walk' && providerOk('valhalla')){
    enqueue(key, async () => {
      const m = await fetchValhalla(a, b, 'pedestrian');
      cache[key] = { m, mode:'walk', t: Date.now() };
      cacheDirty = true;
      notify();
    });
  } else if(profile === 'transit'){
    enqueue(key, async () => {
      if(providerOk('transitous')){
        try{
          const m = await fetchTransitous(a, b, transitTime(opts.dayDate, opts.departMinutes ?? 600));
          cache[key] = { m, mode:'transit', t: Date.now() };
          cacheDirty = true;
          notify();
          return;
        } catch(e){ /* fall through to a driving estimate */ }
      }
      if(providerOk('valhalla')){
        const m = await fetchValhalla(a, b, 'auto');
        cache[key] = { m: m + 6, mode:'taxi', t: Date.now() };  // hail/park overhead
        cacheDirty = true;
        notify();
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
  cacheDirty = true;
  persistCache();
}
