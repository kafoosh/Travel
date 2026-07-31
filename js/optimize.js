/* =========================================================
   ROUTE OPTIMISATION

   Two levels, both pure local search over best-known travel
   minutes (live routed times where cached, heuristic otherwise):

   - optimizeDayOrder: nearest-neighbour construction followed
     by 2-opt improvement for a single day (the ✨ button).

   - autoPlanOrders: the Auto-plan feature. Assigns every
     movable stop to a day AND a position in that day's route
     in one pass, using cheapest-insertion with hard per-day
     time budgets (visit durations + travel + hotel bookends),
     so "can this actually be seen that day?" is part of the
     assignment itself — not an afterthought. Seeds adapt to
     load: a day whose area is overfull pulls in an underused
     day's seed, so dense areas get more days. Anchored stops
     (flights, trains, boats, check-ins) pin their day and
     keep their relative order; insertion happens around them.

   Auto-plan returns a PROPOSAL — the UI shows a per-day
   preview (map + schedule) for the user to accept or reject.
   ========================================================= */

import { parseTime, haversineKm } from './util.js';
import { knownMinutes } from './routing.js';
import { getHotel } from './schedule.js';

const DAY_END_MIN = 22 * 60 + 30;   // assume nobody plans past ~10:30pm
const ANCHOR_CATS = ['travel', 'boat', 'hotel', 'flight'];

function legMinutes(a, b, boat){
  return knownMinutes(a, b, { boat });
}

/* 2-opt over a fixed-endpoint path. */
function twoOpt(order, cost){
  const n = order.length;
  if(n < 3) return order;
  let improved = true;
  let guard = 0;
  while(improved && guard++ < 60){
    improved = false;
    for(let i = 0; i < n - 1; i++){
      for(let k = i + 1; k < n; k++){
        const before = cost(i - 1, i) + cost(k, k + 1);
        const after = cost(i - 1, k) + cost(i, k + 1, true);
        if(after < before - 0.01){
          const seg = order.slice(i, k + 1).reverse();
          order.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
  }
  return order;
}

/* Order one day's stops. Returns a new order array (ids). */
export function optimizeDayOrder(trip, day){
  const hotel = getHotel(trip, day);
  const bookend = day.bookend || 'both';
  const boat = !!(hotel && hotel.mode === 'boat');
  const stops = day.order.map(id => trip.stops[id]).filter(Boolean);
  const noCoord = stops.filter(s => s.lat == null);
  const withCoord = stops.filter(s => s.lat != null);
  if(withCoord.length < 2) return day.order.slice();

  const hotelUsable = hotel && hotel.lat != null;
  let anchor;
  let fixedFirst = null;
  if(hotelUsable && bookend !== 'end'){
    anchor = { lat: hotel.lat, lng: hotel.lng };
  } else {
    fixedFirst = withCoord.shift();      // day doesn't start at a hotel: first stop stays first
    anchor = fixedFirst;
  }
  const endPoint = (hotelUsable && bookend !== 'start') ? { lat: hotel.lat, lng: hotel.lng } : null;

  const remaining = withCoord.slice();
  const path = [];
  let cur = anchor;
  while(remaining.length){
    let bi = 0, bd = Infinity;
    remaining.forEach((s, i) => {
      const d = legMinutes(cur, s, boat && cur === anchor);
      if(d < bd){ bd = d; bi = i; }
    });
    const next = remaining.splice(bi, 1)[0];
    path.push(next);
    cur = next;
  }

  const at = i => i < 0 ? anchor : (i >= path.length ? endPoint : path[i]);
  const cost = (i, j) => {
    const a = at(i), b = at(j);
    if(!a || !b) return 0;
    const isHotelLeg = boat && (a === anchor || b === anchor || a === endPoint || b === endPoint);
    return legMinutes(a, b, isHotelLeg);
  };
  twoOpt(path, cost);

  const ordered = (fixedFirst ? [fixedFirst] : []).concat(path);
  return noCoord.map(s => s.id).concat(ordered.map(s => s.id));
}

/* =========================================================
   AUTO-PLAN
   ========================================================= */

function centroid(pts){
  return {
    lat: pts.reduce((n, p) => n + p.lat, 0) / pts.length,
    lng: pts.reduce((n, p) => n + p.lng, 0) / pts.length,
  };
}

/* Assign all movable stops across the trip's days and order every day.
   Returns {orders: {dayId: [ids]}} without mutating the trip. */
export function autoPlanOrders(trip){
  const days = trip.days;
  const k = days.length;
  const stopOf = id => trip.stops[id];

  // Partition each day's current stops: no-coordinate stops stay put (front),
  // anchored coordinate stops (flights/trains/boats/check-ins) pin the day and
  // keep their relative order, everything else is movable.
  const fixedNoCoord = days.map(d => d.order.filter(id => { const s = stopOf(id); return !s || s.lat == null; }));
  const fixedCoord = days.map(d => d.order.map(stopOf).filter(s => s && s.lat != null && ANCHOR_CATS.includes(s.cat)));
  const movable = [];
  days.forEach(d => d.order.forEach(id => {
    const s = stopOf(id);
    if(s && s.lat != null && !ANCHOR_CATS.includes(s.cat)) movable.push(s);
  }));

  if(movable.length < 2 || k < 1){
    return { orders: Object.fromEntries(days.map(d => [d.id, d.order.slice()])) };
  }

  const budgets = days.map(d => Math.max(240, DAY_END_MIN - parseTime(d.start)));

  // Hotel bookend endpoints per day (participate in route cost + budget).
  const ends = days.map(d => {
    const h = getHotel(trip, d);
    const usable = h && h.lat != null;
    const be = d.bookend || 'both';
    return {
      start: usable && be !== 'end' ? { lat: h.lat, lng: h.lng, __h: true } : null,
      end: usable && be !== 'start' ? { lat: h.lat, lng: h.lng, __h: true } : null,
      boat: !!(h && h.mode === 'boat'),
    };
  });

  /* ---- seeds: where each day "lives".
     Anchored days seed at their anchors (immovable — a Murano boat day IS a
     Murano day). Hotel days seed at the hotel; unseeded days spread by
     farthest-point over the stops. Then a load pass: while one seed's area
     is overfull and another day is nearly idle, the idle day's seed moves
     into the overloaded area — dense areas get more days. ---- */
  const seeds = days.map((d, i) => {
    if(fixedCoord[i].length) return { ...centroid(fixedCoord[i]), anchored: true };
    if(ends[i].start) return { lat: ends[i].start.lat + i * 1e-3, lng: ends[i].start.lng + i * 1e-3, anchored: false };
    return null;
  });
  seeds.forEach((seed, i) => {
    if(seed) return;
    const placed = seeds.filter(Boolean);
    let best = movable[0], bd = -1;
    movable.forEach(m => {
      const dmin = placed.length ? Math.min(...placed.map(o => haversineKm(o.lat, o.lng, m.lat, m.lng))) : 1;
      if(dmin > bd){ bd = dmin; best = m; }
    });
    seeds[i] = { lat: best.lat, lng: best.lng, anchored: false };
  });

  // A day's seed may only live where that day's hotel can plausibly serve —
  // you sleep there, so a Rome-hotel day must not become a Venice day.
  const hotelPos = days.map((d, i) => ends[i].start || ends[i].end || null);
  const seedAllowed = (i, pt) => !hotelPos[i] || haversineKm(hotelPos[i].lat, hotelPos[i].lng, pt.lat, pt.lng) < 60;

  for(let iter = 0; iter < k * 2; iter++){
    const load = days.map((d, i) => fixedCoord[i].reduce((n, s) => n + s.dur, 0));
    movable.forEach(m => {
      let bi = 0, bd = Infinity;
      seeds.forEach((s, i) => { const d = haversineKm(s.lat, s.lng, m.lat, m.lng); if(d < bd){ bd = d; bi = i; } });
      load[bi] += m.dur + 20;   // +20: rough per-stop travel overhead
    });
    let over = -1;
    days.forEach((d, i) => {
      if(load[i] > budgets[i] * 1.15 && (over === -1 || load[i] - budgets[i] > load[over] - budgets[over])) over = i;
    });
    if(over === -1) break;
    const members = movable.filter(m => {
      let bi = 0, bd = Infinity;
      seeds.forEach((s, i) => { const d = haversineKm(s.lat, s.lng, m.lat, m.lng); if(d < bd){ bd = d; bi = i; } });
      return bi === over;
    });
    if(!members.length) break;
    let far = members[0], fd = -1;
    members.forEach(m => { const d = haversineKm(seeds[over].lat, seeds[over].lng, m.lat, m.lng); if(d > fd){ fd = d; far = m; } });
    let under = -1;
    days.forEach((d, i) => {
      if(i === over || seeds[i].anchored || !seedAllowed(i, far)) return;
      if(load[i] < budgets[i] * 0.4 && (under === -1 || load[i] < load[under])) under = i;
    });
    if(under === -1) break;
    seeds[under] = { lat: far.lat, lng: far.lng, anchored: false };
  }

  /* ---- cheapest insertion with budgets ---- */
  const routes = days.map((d, i) => fixedCoord[i].slice());
  const used = days.map((d, i) =>
    fixedCoord[i].reduce((n, s) => n + s.dur, 0) +
    fixedNoCoord[i].reduce((n, id) => n + ((stopOf(id) || {}).dur || 0), 0));

  const leg = (i, a, b) => {
    if(!a || !b) return 0;
    return legMinutes(a, b, ends[i].boat && (a.__h || b.__h));
  };
  const routePts = i => [ends[i].start, ...routes[i], ends[i].end].filter(Boolean);
  const routeTravel = i => {
    const p = routePts(i);
    let m = 0;
    for(let j = 1; j < p.length; j++) m += leg(i, p[j-1], p[j]);
    return m;
  };
  const travel = days.map((d, i) => routeTravel(i));

  // Best gap (by added minutes) for stop s in day i. Gap g means "before the
  // g-th entry of routes[i]" — anchored stops never reorder.
  const insertionCost = (i, s) => {
    const off = ends[i].start ? 1 : 0;
    const p = routePts(i);
    let best = Infinity, bestPos = 0;
    for(let g = 0; g <= routes[i].length; g++){
      const before = (g + off - 1) >= 0 ? p[g + off - 1] : null;
      const after = (g + off) < p.length ? p[g + off] : null;
      const added = leg(i, before, s) + leg(i, s, after) - leg(i, before, after);
      if(added < best){ best = added; bestPos = g; }
    }
    return { cost: best === Infinity ? 0 : best, pos: bestPos };
  };

  // Hardest stops first: the farther a stop is from every seed, the fewer
  // good homes it has — place those while there's still room.
  const orderIdx = movable.map((m, mi) => mi).sort((a, b) => {
    const near = mi => Math.min(...seeds.map(s => haversineKm(s.lat, s.lng, movable[mi].lat, movable[mi].lng)));
    return near(b) - near(a);
  });

  // A day CAN run to the 22:30 ceiling, but nobody wants every day maxed out.
  // Insertion prefers days under a comfortable ~11h of activity and, among
  // geographically-equivalent days, the emptier one — so load spreads across
  // the days available instead of packing early days to the ceiling.
  const comfort = days.map((d, i) => Math.min(budgets[i], 660));

  const dayOf = new Array(movable.length).fill(-1);
  orderIdx.forEach(mi => {
    const s = movable[mi];
    let best = null;
    days.forEach((d, i) => {
      const near = haversineKm(seeds[i].lat, seeds[i].lng, s.lat, s.lng);
      const { cost, pos } = insertionCost(i, s);
      const projected = used[i] + travel[i] + cost + s.dur;
      const fits = projected <= budgets[i];
      const score = cost + near * 2                     // ~2 min/km: the geographically-right day dominates
        + (used[i] + travel[i]) * 0.25                  // mild pull toward emptier days
        + Math.max(0, projected - comfort[i]) * 2;      // strong pushback past a comfortable day length
      if(fits && (!best || score < best.score)) best = { i, pos, cost, score };
    });
    if(!best){
      // Nothing has room: least-bad nearby day (≤60 km), else most slack anywhere.
      let cands = days.map((d, i) => i).filter(i => haversineKm(seeds[i].lat, seeds[i].lng, s.lat, s.lng) < 60);
      if(!cands.length) cands = days.map((d, i) => i);
      let bi = cands[0], bs = -Infinity;
      cands.forEach(i => { const slack = budgets[i] - used[i] - travel[i]; if(slack > bs){ bs = slack; bi = i; } });
      const { pos } = insertionCost(bi, s);
      best = { i: bi, pos };
    }
    routes[best.i].splice(best.pos, 0, s);
    dayOf[mi] = best.i;
    used[best.i] += s.dur;
    travel[best.i] = routeTravel(best.i);
  });

  /* ---- improvement sweeps: move stops between days when it genuinely
     saves travel and fits; then re-slot each stop within its day ---- */
  for(let sweep = 0; sweep < 2; sweep++){
    movable.forEach((s, mi) => {
      const from = dayOf[mi];
      const idx = routes[from].indexOf(s);
      if(idx === -1) return;
      routes[from].splice(idx, 1);
      const removedTravel = routeTravel(from);
      const saving = travel[from] - removedTravel;
      let best = null;
      days.forEach((d, i) => {
        if(i === from) return;
        const { cost, pos } = insertionCost(i, s);
        const fits = used[i] + travel[i] + cost + s.dur <= budgets[i];
        if(fits && cost < saving - 8 && (!best || cost < best.cost)) best = { i, pos, cost };
      });
      if(best){
        routes[best.i].splice(best.pos, 0, s);
        used[from] -= s.dur; used[best.i] += s.dur;
        travel[from] = removedTravel; travel[best.i] = routeTravel(best.i);
        dayOf[mi] = best.i;
      } else {
        routes[from].splice(idx, 0, s);
      }
    });
    days.forEach((d, i) => {
      routes[i].slice().forEach(s => {
        if(ANCHOR_CATS.includes(s.cat)) return;
        const idx = routes[i].indexOf(s);
        if(idx === -1) return;
        routes[i].splice(idx, 1);
        const { pos } = insertionCost(i, s);
        routes[i].splice(pos, 0, s);
      });
      travel[i] = routeTravel(i);
    });
  }

  /* ---- balance sweep: even out day loads within each area. Insertion is
     greedy in sequence, so early days end up fuller than late ones; keep
     moving the cheapest stop from the fullest day to the emptiest nearby
     day until no pair differs by more than ~2.5h. ---- */
  const loadOf = i => used[i] + travel[i];
  for(let pass = 0; pass < movable.length; pass++){
    const byLoad = days.map((d, i) => i).sort((a, b) => loadOf(b) - loadOf(a));
    let applied = false;
    for(const hi of byLoad){
      let lo = -1;
      days.forEach((d, i) => {
        if(i === hi) return;
        if(haversineKm(seeds[hi].lat, seeds[hi].lng, seeds[i].lat, seeds[i].lng) > 60) return;
        if(lo === -1 || loadOf(i) < loadOf(lo)) lo = i;
      });
      if(lo === -1 || loadOf(hi) - loadOf(lo) <= 150) continue;
      let best = null;
      routes[hi].slice().forEach(s => {
        if(ANCHOR_CATS.includes(s.cat)) return;
        const idx = routes[hi].indexOf(s);
        routes[hi].splice(idx, 1);
        const removedTravel = routeTravel(hi);
        const { cost, pos } = insertionCost(lo, s);
        const fits = used[lo] + travel[lo] + cost + s.dur <= budgets[lo];
        if(fits && (!best || cost < best.cost)) best = { s, idx, cost, pos, removedTravel };
        routes[hi].splice(idx, 0, s);
      });
      if(!best) continue;
      routes[hi].splice(best.idx, 1);
      used[hi] -= best.s.dur;
      travel[hi] = best.removedTravel;
      routes[lo].splice(best.pos, 0, best.s);
      used[lo] += best.s.dur;
      travel[lo] = routeTravel(lo);
      const mi = movable.indexOf(best.s);
      if(mi !== -1) dayOf[mi] = lo;
      applied = true;
      break;
    }
    if(!applied) break;
  }

  const orders = {};
  days.forEach((d, i) => { orders[d.id] = [...fixedNoCoord[i], ...routes[i].map(s => s.id)]; });
  return { orders };
}
