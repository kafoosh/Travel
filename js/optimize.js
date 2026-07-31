/* =========================================================
   ROUTE OPTIMISATION

   Two levels, both pure local search over best-known travel
   minutes (live routed times where cached, heuristic otherwise):

   - optimizeDayOrder: nearest-neighbour construction followed
     by 2-opt improvement. The plain greedy pass characteristically
     strands one far-away stop for a long backtrack; 2-opt
     (reverse any segment that shortens the path) repairs that.

   - distributeAcrossDays: capacity-aware clustering. Seeds day
     clusters (hotel locations where set, k-means++ otherwise),
     assigns stops to the nearest cluster, rebalances so each
     day's visit + travel time fits its time budget, then orders
     every day with the 2-opt pass.

   Optimisation is a strong suggestion, not an answer — the UI
   keeps drag-and-drop as the escape hatch, and everything is
   one Undo away.
   ========================================================= */

import { parseTime, haversineKm } from './util.js';
import { knownMinutes } from './routing.js';
import { getHotel } from './schedule.js';

const DAY_END_MIN = 22 * 60 + 30;   // assume nobody plans past ~10:30pm

function legMinutes(a, b, boat){
  return knownMinutes(a, b, { boat });
}

/* 2-opt over a fixed-endpoint path. pts = [{lat,lng},...] visited in order;
   start/end participate in cost but never move (pass null for a free end). */
function twoOpt(order, cost){
  const n = order.length;
  if(n < 3) return order;
  let improved = true;
  let guard = 0;
  while(improved && guard++ < 60){
    improved = false;
    for(let i = 0; i < n - 1; i++){
      for(let k = i + 1; k < n; k++){
        // Reversing order[i..k] changes only the two boundary edges.
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

/* Order one day's stops. Returns a new order array (ids). Stops without
   coordinates keep their relative position at the front (they cost nothing). */
export function optimizeDayOrder(trip, day){
  const hotel = getHotel(trip, day);
  const bookend = day.bookend || 'both';
  const boat = !!(hotel && hotel.mode === 'boat');
  const stops = day.order.map(id => trip.stops[id]).filter(Boolean);
  const noCoord = stops.filter(s => s.lat == null);
  const withCoord = stops.filter(s => s.lat != null);
  if(withCoord.length < 2) return day.order.slice();

  const hotelUsable = hotel && hotel.lat != null;
  let anchor;         // fixed start point
  let fixedFirst = null;
  if(hotelUsable && bookend !== 'end'){
    anchor = { lat: hotel.lat, lng: hotel.lng };
  } else {
    fixedFirst = withCoord.shift();      // day doesn't start at a hotel: first stop stays first
    anchor = fixedFirst;
  }
  const endPoint = (hotelUsable && bookend !== 'start') ? { lat: hotel.lat, lng: hotel.lng } : null;

  // Nearest-neighbour construction
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

  // 2-opt refinement. cost(i,j) = minutes between path items i and j, where
  // index -1 is the anchor and index n is the end point (or free).
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

/* Rough total minutes a day's plan needs (visits + travel), for budgeting. */
function dayLoad(trip, day, ids){
  const hotel = getHotel(trip, day);
  const boat = !!(hotel && hotel.mode === 'boat');
  const stops = ids.map(id => trip.stops[id]).filter(Boolean);
  let mins = stops.reduce((n, s) => n + (s.dur || 0), 0);
  const pts = stops.filter(s => s.lat != null);
  let prev = (hotel && hotel.lat != null) ? hotel : null;
  pts.forEach(p => {
    if(prev) mins += legMinutes(prev, p, boat && prev === hotel);
    prev = p;
  });
  if(hotel && hotel.lat != null && prev && prev !== hotel) mins += legMinutes(prev, hotel, boat);
  return mins;
}

function budget(day){
  return Math.max(4 * 60, DAY_END_MIN - parseTime(day.start));
}

/* Reassign all movable, coordinate-bearing stops across the trip's days,
   then order each day. Returns {orders: {dayId: [ids]}, moved: n} without
   mutating the trip — the caller applies it (after pushUndo). Stops without
   coordinates, and categories that anchor a day (travel legs), stay put. */
export function distributeAcrossDays(trip){
  const days = trip.days;
  const k = days.length;
  // Travel legs, boat/ferry rides, and hotel check-ins anchor the day they're
  // on — redistributing those would wreck arrival days and island day-trips.
  const ANCHOR_CATS = ['travel', 'boat', 'hotel', 'flight'];
  const fixedByDay = days.map(d => d.order.filter(id => {
    const s = trip.stops[id];
    return !s || s.lat == null || ANCHOR_CATS.includes(s.cat);
  }));
  const movable = [];
  days.forEach((d, di) => d.order.forEach(id => {
    const s = trip.stops[id];
    if(s && s.lat != null && !ANCHOR_CATS.includes(s.cat)) movable.push({ id, s, from: di });
  }));
  if(movable.length < 2 || k < 2){
    return { orders: Object.fromEntries(days.map((d, i) => [d.id, days[i].order.slice()])), moved: 0 };
  }

  // --- seed centers: day hotels where set, else k-means++ over the stops.
  // Centers only SEED from hotels — they drift with their cluster afterwards,
  // because several days sharing one hotel would otherwise start as identical
  // centers and every stop would pile onto the first of them. A tiny per-day
  // offset breaks the remaining ties deterministically. ---
  const centers = days.map((d, i) => {
    const h = getHotel(trip, d);
    return (h && h.lat != null) ? { lat: h.lat + i * 1e-3, lng: h.lng + i * 1e-3, fixed: false } : null;
  });
  const need = centers.map((c, i) => c ? -1 : i).filter(i => i !== -1);
  if(need.length){
    const pts = movable.map(m => m.s);
    let seedIdx = 0;
    need.forEach(ci => {
      // farthest-point seeding from existing centers
      let best = null, bestD = -1;
      pts.forEach(p => {
        const dmin = Math.min(...centers.filter(Boolean).map(c => haversineKm(c.lat, c.lng, p.lat, p.lng)), Infinity);
        const d = centers.some(Boolean) ? dmin : (seedIdx++ === 0 ? 1 : 0);
        if(d > bestD){ bestD = d; best = p; }
      });
      centers[ci] = { lat: best.lat, lng: best.lng, fixed: false };
    });
  }

  // --- iterate: assign to nearest center, recenter, rebalance to budgets ---
  let assign = movable.map(() => 0);
  for(let iter = 0; iter < 12; iter++){
    let changed = false;
    movable.forEach((m, i) => {
      let bi = 0, bd = Infinity;
      centers.forEach((c, ci) => {
        const d = haversineKm(c.lat, c.lng, m.s.lat, m.s.lng);
        if(d < bd){ bd = d; bi = ci; }
      });
      if(assign[i] !== bi){ assign[i] = bi; changed = true; }
    });
    centers.forEach((c, ci) => {
      if(c.fixed) return;
      const mine = movable.filter((m, i) => assign[i] === ci);
      if(mine.length){
        c.lat = mine.reduce((n, m) => n + m.s.lat, 0) / mine.length;
        c.lng = mine.reduce((n, m) => n + m.s.lng, 0) / mine.length;
      }
    });
    if(!changed && iter > 0) break;
  }

  // --- rebalance: move boundary stops off overloaded days ---
  const idsFor = ci => fixedByDay[ci].concat(movable.filter((m, i) => assign[i] === ci).map(m => m.id));
  for(let pass = 0; pass < 40; pass++){
    const loads = days.map((d, ci) => dayLoad(trip, d, idsFor(ci)) - budget(d));
    let worst = -1;
    loads.forEach((over, ci) => { if(over > 0 && (worst === -1 || over > loads[worst])) worst = ci; });
    if(worst === -1) break;
    // cheapest stop to exile: the one whose move to an underloaded day adds least distance
    let bestMove = null;
    movable.forEach((m, i) => {
      if(assign[i] !== worst) return;
      days.forEach((d, ci) => {
        if(ci === worst || loads[ci] > -m.s.dur) return;  // target must have room
        const d2 = haversineKm(centers[ci].lat, centers[ci].lng, m.s.lat, m.s.lng)
                 - haversineKm(centers[worst].lat, centers[worst].lng, m.s.lat, m.s.lng);
        if(!bestMove || d2 < bestMove.cost) bestMove = { i, to: ci, cost: d2 };
      });
    });
    if(!bestMove) break;   // nowhere to put anything — leave it overloaded
    assign[bestMove.i] = bestMove.to;
  }

  // --- build and order the final day plans ---
  const orders = {};
  let moved = 0;
  movable.forEach((m, i) => { if(assign[i] !== m.from) moved += 1; });
  days.forEach((d, ci) => {
    const scratch = { ...d, order: idsFor(ci) };
    orders[d.id] = optimizeDayOrder(trip, scratch);
  });
  return { orders, moved };
}
