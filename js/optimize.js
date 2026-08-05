/* =========================================================
   ROUTE OPTIMISATION

   Two levels, both pure local search over best-known travel
   minutes (live routed times where cached, heuristic otherwise):

   - optimizeDayOrder: nearest-neighbour construction followed
     by 2-opt improvement for a single day (the ✨ button).

   - autoPlanOrders: the Auto-plan feature. Assigns every
     movable stop to a day AND a position in that day's route
     in one pass, using cheapest-insertion with hard per-day
     time budgets (visit durations + travel + hotel legs),
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
import { getStartHotel, getEndHotel } from './schedule.js';

const DAY_END_MIN = 22 * 60 + 30;   // assume nobody plans past ~10:30pm
const ANCHOR_CATS = ['travel', 'boat', 'hotel', 'flight'];

/* Stops auto-plan may not move between days: the fixed points of the trip
   (a flight, a train, a check-in) and anything already ticked off — a stop
   you have visited belongs to the day you visited it, whatever a replan of
   the days ahead would prefer. */
function isPinned(stop){
  return ANCHOR_CATS.includes(stop.cat) || !!stop.done;
}

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
  const startHotel = getStartHotel(trip, day);
  const endHotel = getEndHotel(trip, day);
  const stops = day.order.map(id => trip.stops[id]).filter(Boolean);
  const noCoord = stops.filter(s => s.lat == null);
  const withCoord = stops.filter(s => s.lat != null);
  if(withCoord.length < 2) return day.order.slice();

  const startUsable = startHotel && startHotel.lat != null;
  const endUsable = endHotel && endHotel.lat != null;
  const startBoat = !!(startUsable && startHotel.mode === 'boat');
  const endBoat = !!(endUsable && endHotel.mode === 'boat');
  let anchor;
  let fixedFirst = null;
  if(startUsable){
    anchor = { lat: startHotel.lat, lng: startHotel.lng };
  } else {
    fixedFirst = withCoord.shift();      // day doesn't start at a hotel: first stop stays first
    anchor = fixedFirst;
  }
  const endPoint = endUsable ? { lat: endHotel.lat, lng: endHotel.lng } : null;

  const remaining = withCoord.slice();
  const path = [];
  let cur = anchor;
  while(remaining.length){
    let bi = 0, bd = Infinity;
    remaining.forEach((s, i) => {
      const d = legMinutes(cur, s, startBoat && cur === anchor);
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
    const isBoatLeg = (startBoat && (a === anchor || b === anchor)) ||
                      (endBoat && (a === endPoint || b === endPoint));
    return legMinutes(a, b, isBoatLeg);
  };
  twoOpt(path, cost);

  const ordered = (fixedFirst ? [fixedFirst] : []).concat(path);
  return noCoord.map(s => s.id).concat(ordered.map(s => s.id));
}

/* =========================================================
   AUTO-PLAN (neighbourhood packing)

   Model: a good day is a NEIGHBOURHOOD — a tight cluster of
   places you'd naturally walk between — sized by what actually
   fits in the day (visit lengths + walking within the area).
   Hotels are deliberately ignored while planning: the day is
   built around where the stops are, not where you sleep.

   1. Movable stops agglomerate into micro-neighbourhoods
      (everything within ~0.8 km chains together); oversized
      neighbourhoods split along their walking chain.
   2. Days with anchors (flights, trains, boats, check-ins —
      immovable by definition) claim the neighbourhoods nearest
      their anchors, up to a comfortable day length.
   3. Remaining neighbourhoods chain-pack into the free days,
      region by region: adjacent areas land on the same or
      adjacent days, and a day closes when adding the next
      neighbourhood would blow its time budget.
   4. Within each day, anchors keep their original positions —
      a check-in that started the day still starts it, a
      departure train still ends it. Movable stops slot into
      the gaps around them, each gap ordered by nearest-
      neighbour + 2-opt.
   ========================================================= */

function centroid(pts){
  return {
    lat: pts.reduce((n, p) => n + p.lat, 0) / pts.length,
    lng: pts.reduce((n, p) => n + p.lng, 0) / pts.length,
  };
}

/* Greedy nearest-neighbour chain over stops (walking minutes). */
function chainOrder(stops){
  if(stops.length < 3) return stops.slice();
  const rem = stops.slice(1);
  const out = [stops[0]];
  while(rem.length){
    const cur = out[out.length - 1];
    let bi = 0, bd = Infinity;
    rem.forEach((s, i) => { const d = legMinutes(cur, s, false); if(d < bd){ bd = d; bi = i; } });
    out.push(rem.splice(bi, 1)[0]);
  }
  return out;
}

/* Visit minutes + a rough internal walking chain for a set of stops. */
function hoodMinutes(stops){
  let m = stops.reduce((n, s) => n + s.dur, 0);
  const ordered = chainOrder(stops);
  for(let i = 1; i < ordered.length; i++) m += legMinutes(ordered[i-1], ordered[i], false);
  return m;
}

/* NN + 2-opt with optional fixed endpoints (null = free end). */
function orderStops(stops, startPt, endPt){
  if(stops.length < 2) return stops.slice();
  const rem = stops.slice();
  const path = [];
  let cur = startPt || rem[0];
  if(!startPt){ path.push(rem.shift()); cur = path[0]; }
  while(rem.length){
    let bi = 0, bd = Infinity;
    rem.forEach((s, i) => { const d = legMinutes(cur, s, false); if(d < bd){ bd = d; bi = i; } });
    cur = rem.splice(bi, 1)[0];
    path.push(cur);
  }
  const head = startPt ? null : path.shift();     // a free start keeps its first pick fixed
  const at = i => i < 0 ? (startPt || head) : (i >= path.length ? endPt : path[i]);
  const cost = (i, j) => {
    const a = at(i), b = at(j);
    return (a && b) ? legMinutes(a, b, false) : 0;
  };
  twoOpt(path, cost);
  return head ? [head, ...path] : path;
}

/* ---- meal placement ----
   People eat lunch around midday and dinner in the evening; a geographically
   perfect route that schedules dinner at 9:50 AM is a bad plan. After a day's
   route is built, food stops are re-slotted to the position whose simulated
   clock time lands nearest their meal window, trading a little extra walking
   for a sane mealtime. ---- */
const MEAL_TARGET = { lunch: 12 * 60 + 45, dinner: 19 * 60 + 30 };

function foodRole(s){
  const n = s.name.toLowerCase();
  if(/lunch|brunch|pranzo|d[ée]jeuner|almuerzo/.test(n)) return 'lunch';
  if(/dinner|supper|cena|d[îi]ner/.test(n)) return 'dinner';
  return null;
}

/* Simulated start times for a sequence (heuristic legs, fixed starts honoured). */
function simTimes(day, seq){
  let t = parseTime(day.start);
  const starts = [];
  let prev = null;
  seq.forEach(s => {
    if(prev && prev.lat != null && s.lat != null) t += legMinutes(prev, s, false);
    if(s.fixedStart){
      const m = /^(\d{1,2}):(\d{2})$/.exec(s.fixedStart);
      if(m){ const fs = Number(m[1]) * 60 + Number(m[2]); if(t < fs) t = fs; }
    }
    starts.push(t);
    t += s.dur;
    if(s.lat != null) prev = (s.cat === 'hike' && s.endLat != null) ? { lat: s.endLat, lng: s.endLng } : s;
  });
  return { starts, end: t };
}

function placeMeals(day, seq){
  const foods = seq.filter(s => s.cat === 'food' && !s.fixedStart);
  if(!foods.length || seq.length < 3) return seq;
  let base = seq.filter(s => !foods.includes(s));

  // role assignment: names first (Lunch —, Dinner —), then fill by order
  const roles = new Map();
  const unnamed = [];
  foods.forEach(f => {
    const r = foodRole(f);
    if(r) roles.set(f, r);       // named meals keep their name, even duplicates
    else unnamed.push(f);
  });
  unnamed.forEach(f => {
    if(![...roles.values()].includes('lunch')) roles.set(f, 'lunch');
    else if(![...roles.values()].includes('dinner')) roles.set(f, 'dinner');
    else roles.set(f, 'any');
  });

  // insertion bounds: never before leading anchors or after trailing ones
  const lo = () => { let n = 0; while(n < base.length && isPinned(base[n])) n++; return n; };
  const hi = () => { let n = base.length; while(n > 0 && isPinned(base[n - 1])) n--; return n; };

  const order = ['lunch', 'dinner', 'any'];
  foods.sort((a, b) => order.indexOf(roles.get(a)) - order.indexOf(roles.get(b)))
    .forEach(f => {
      const role = roles.get(f);
      const target = MEAL_TARGET[role];
      const baseEnd = simTimes(day, base).end;
      const upper = hi();
      let best = { p: upper, cost: Infinity };   // fallback: before any trailing anchors
      for(let p = lo(); p <= upper; p++){
        const cand = [...base.slice(0, p), f, ...base.slice(p)];
        const { starts, end } = simTimes(day, cand);
        const detour = end - baseEnd - f.dur;                 // pure added travel
        const cost = (target != null ? Math.abs(starts[p] - target) : 0) + Math.min(detour, 90) * 0.25;
        if(cost < best.cost) best = { p, cost };
      }
      base = [...base.slice(0, best.p), f, ...base.slice(best.p)];
    });
  return base;
}

/* Assign all movable stops across the trip's days and order every day.
   Returns {orders: {dayId: [ids]}} without mutating the trip. */
export function autoPlanOrders(trip){
  const days = trip.days;
  const k = days.length;
  const stopOf = id => trip.stops[id];

  const fixedNoCoord = days.map(d => d.order.filter(id => { const s = stopOf(id); return !s || s.lat == null; }));
  const anchorsByDay = days.map(d => d.order.map(stopOf).filter(s => s && s.lat != null && isPinned(s)));
  const movable = [];
  days.forEach(d => d.order.forEach(id => {
    const s = stopOf(id);
    if(s && s.lat != null && !isPinned(s)) movable.push(s);
  }));

  if(movable.length < 2 || k < 1){
    return { orders: Object.fromEntries(days.map(d => [d.id, d.order.slice()])) };
  }

  // Day budgets: waking window minus the immovable anchors' own time.
  const anchorMinutes = anchorsByDay.map(list => {
    let m = list.reduce((n, s) => n + s.dur, 0);
    for(let i = 1; i < list.length; i++) m += legMinutes(list[i-1], list[i], false);
    return m;
  });
  const budgets = days.map((d, i) => Math.max(120, DAY_END_MIN - parseTime(d.start) - anchorMinutes[i]));
  // ~10.5h TOTAL activity target: a day already carrying a 4h train + check-in
  // has correspondingly little comfortable room left for sightseeing.
  const comfort = budgets.map((b, i) => Math.max(120, Math.min(b, 630 - anchorMinutes[i])));

  /* ---- 1. micro-neighbourhoods ---- */
  const NEIGH_KM = 0.8;
  const hoodOf = new Array(movable.length).fill(-1);
  let H = 0;
  for(let i = 0; i < movable.length; i++){
    if(hoodOf[i] !== -1) continue;
    const stack = [i];
    hoodOf[i] = H;
    while(stack.length){
      const a = stack.pop();
      for(let b = 0; b < movable.length; b++){
        if(hoodOf[b] === -1 && haversineKm(movable[a].lat, movable[a].lng, movable[b].lat, movable[b].lng) <= NEIGH_KM){
          hoodOf[b] = H;
          stack.push(b);
        }
      }
    }
    H++;
  }
  const makeHood = stops => ({ stops, c: centroid(stops), minutes: hoodMinutes(stops) });
  let hoods = [];
  for(let h = 0; h < H; h++) hoods.push(makeHood(movable.filter((m, i) => hoodOf[i] === h)));

  // Split oversized neighbourhoods along their walking chain. The threshold
  // is ~half a day, not a whole one: half-day chunks pack flexibly (two can
  // share a day, one can top up an anchored day), where near-day-sized
  // blocks jam the packing and pile onto whichever day has to take them.
  const maxComfort = Math.max(...comfort);
  let guard = 0;
  while(guard++ < 60){
    const idx = hoods.findIndex(h => h.stops.length > 1 && h.minutes > maxComfort * 0.55);
    if(idx === -1) break;
    const ordered = chainOrder(hoods[idx].stops);
    let acc = 0, cut = 1;
    const target = hoods[idx].minutes / 2;
    for(let i = 0; i < ordered.length - 1; i++){
      acc += ordered[i].dur + legMinutes(ordered[i], ordered[i+1], false);
      if(acc >= target){ cut = i + 1; break; }
    }
    hoods.splice(idx, 1, makeHood(ordered.slice(0, cut)), makeHood(ordered.slice(cut)));
  }

  /* ---- 2. regions (areas ~50 km apart are different cities) ---- */
  const regionOfHood = new Array(hoods.length).fill(-1);
  let R = 0;
  for(let i = 0; i < hoods.length; i++){
    if(regionOfHood[i] !== -1) continue;
    const stack = [i];
    regionOfHood[i] = R;
    while(stack.length){
      const a = stack.pop();
      for(let b = 0; b < hoods.length; b++){
        if(regionOfHood[b] === -1 && haversineKm(hoods[a].c.lat, hoods[a].c.lng, hoods[b].c.lat, hoods[b].c.lng) < 50){
          regionOfHood[b] = R;
          stack.push(b);
        }
      }
    }
    R++;
  }

  /* ---- 3a. anchored days claim their nearest neighbourhoods.
     Claims resolve globally by distance to the day's NEAREST anchor —
     the day whose boat actually docks at Murano gets the Murano
     neighbourhood, even if an earlier day's anchors are vaguely close. ---- */
  const claimedBy = new Array(hoods.length).fill(-1);
  const dayLoad = new Array(k).fill(0);
  const claims = [];
  days.forEach((d, i) => {
    if(!anchorsByDay[i].length) return;
    hoods.forEach((h, hi) => {
      const dist = Math.min(...anchorsByDay[i].map(a => haversineKm(a.lat, a.lng, h.c.lat, h.c.lng)));
      if(dist < 10) claims.push({ i, hi, dist });
    });
  });
  claims.sort((a, b) => a.dist - b.dist);
  claims.forEach(({ i, hi, dist }) => {
    if(claimedBy[hi] !== -1) return;
    if(dayLoad[i] + hoods[hi].minutes > comfort[i]) return;
    claimedBy[hi] = i;
    dayLoad[i] += hoods[hi].minutes;
  });

  /* ---- 3b. free days split among regions by load; chain-pack per region ---- */
  const freeDays = days.map((d, i) => i).filter(i => !anchorsByDay[i].length);
  const regionLoad = new Array(R).fill(0);
  hoods.forEach((h, hi) => { if(claimedBy[hi] === -1) regionLoad[regionOfHood[hi]] += h.minutes; });

  // Order regions by where they sit in the ORIGINAL trip, so free days keep
  // the trip's chronology (Rome days stay early, Venice days stay late).
  const regionAvgIdx = new Array(R).fill(0).map((_, r) => {
    let sum = 0, n = 0;
    days.forEach((d, di) => d.order.forEach(id => {
      const s = stopOf(id);
      if(!s || s.lat == null) return;
      const mi = movable.indexOf(s);
      if(mi !== -1 && regionOfHood[hoodOf[mi]] === r){ sum += di; n++; }
    }));
    return n ? sum / n : 999;
  });

  const totalLoad = regionLoad.reduce((a, b) => a + b, 0) || 1;
  const quota = regionLoad.map(l => l > 0 ? Math.max(1, Math.round(freeDays.length * l / totalLoad)) : 0);
  let excess = quota.reduce((a, b) => a + b, 0) - freeDays.length;
  while(excess > 0){ const r = quota.indexOf(Math.max(...quota)); quota[r]--; excess--; }
  while(excess < 0){ const r = regionLoad.indexOf(Math.max(...regionLoad.filter((l, ri) => quota[ri] >= 0))); quota[r]++; excess++; }

  const regionOrder = quota.map((q, r) => r).filter(r => quota[r] > 0).sort((a, b) => regionAvgIdx[a] - regionAvgIdx[b]);
  const daysOfRegion = new Map();
  let cursor = 0;
  regionOrder.forEach(r => {
    daysOfRegion.set(r, freeDays.slice(cursor, cursor + quota[r]));
    cursor += quota[r];
  });

  regionOrder.forEach(r => {
    const rDays = daysOfRegion.get(r);
    if(!rDays.length) return;
    let pool = hoods.map((h, hi) => hi).filter(hi => claimedBy[hi] === -1 && regionOfHood[hi] === r);
    if(!pool.length) return;
    // Pack toward the region's per-day average, so the walking chain fills
    // each day evenly instead of piling everything left over onto the last.
    const totalR = pool.reduce((n, hi) => n + hoods[hi].minutes, 0);
    const target = totalR / rDays.length;
    // chain from an edge of the region: start at the hood farthest from the centre
    const rc = centroid(pool.map(hi => hoods[hi].c));
    let di = 0;
    let current = pool.reduce((best, hi) =>
      haversineKm(rc.lat, rc.lng, hoods[hi].c.lat, hoods[hi].c.lng) >
      haversineKm(rc.lat, rc.lng, hoods[best].c.lat, hoods[best].c.lng) ? hi : best, pool[0]);
    while(pool.length){
      let day = rDays[Math.min(di, rDays.length - 1)];
      const cap = Math.min(comfort[day], Math.max(target * 1.2, hoods[current].minutes));
      if(dayLoad[day] > 0 && dayLoad[day] + hoods[current].minutes > cap){
        if(di < rDays.length - 1){ di++; continue; }
        // past the last day: least-loaded day in the region takes it
        day = rDays.reduce((b, i) => dayLoad[i] < dayLoad[b] ? i : b, rDays[0]);
      }
      claimedBy[current] = day;
      dayLoad[day] += hoods[current].minutes;
      pool = pool.filter(hi => hi !== current);
      if(!pool.length) break;
      const from = hoods[current].c;
      current = pool.reduce((best, hi) =>
        haversineKm(from.lat, from.lng, hoods[hi].c.lat, hoods[hi].c.lng) <
        haversineKm(from.lat, from.lng, hoods[best].c.lat, hoods[best].c.lng) ? hi : best, pool[0]);
    }
  });

  // Safety net: anything still unclaimed (region with zero quota, outliers)
  // goes to the day with the most room that can plausibly host it.
  hoods.forEach((h, hi) => {
    if(claimedBy[hi] !== -1) return;
    let best = -1;
    days.forEach((d, i) => {
      const near = anchorsByDay[i].length ? haversineKm(centroid(anchorsByDay[i]).lat, centroid(anchorsByDay[i]).lng, h.c.lat, h.c.lng) : 0;
      if(near > 100) return;
      if(best === -1 || (budgets[i] - dayLoad[i]) > (budgets[best] - dayLoad[best])) best = i;
    });
    if(best === -1) best = dayLoad.indexOf(Math.min(...dayLoad));
    claimedBy[hi] = best;
    dayLoad[best] += h.minutes;
  });

  /* ---- 4. in-day ordering: anchors hold position, movables fill the gaps ---- */
  const dayMov = days.map(() => []);
  hoods.forEach((h, hi) => { dayMov[claimedBy[hi]].push(...h.stops); });

  const orders = {};
  days.forEach((d, i) => {
    const anchors = anchorsByDay[i];
    const movs = dayMov[i];
    let seq;
    if(!anchors.length){
      seq = orderStops(movs, null, null);
    } else {
      // An anchor that opened the original day (check-in, arriving flight)
      // should keep opening it; one that closed it (departure train) should
      // keep closing it. Distances tie for the gaps either side of an
      // anchor, so bias the gap that matches the anchor's original role.
      const origLen = Math.max(1, d.order.length - 1);
      const early = anchors.map(a => (d.order.indexOf(a.id) / origLen) < 0.5);
      const gaps = anchors.length + 1;
      // Nothing can happen before an anchor that OPENED the original day
      // (you can't wander Venice before the train from Rome arrives), and
      // nothing after one that CLOSED it (a departure flight ends the day).
      const gapForbidden = new Array(gaps).fill(false);
      if(d.order.indexOf(anchors[0].id) === 0) gapForbidden[0] = true;
      if(d.order.indexOf(anchors[anchors.length - 1].id) === d.order.length - 1) gapForbidden[gaps - 1] = true;
      const firstAllowed = gapForbidden.findIndex(f => !f);
      const gapStops = Array.from({ length: gaps }, () => []);
      movs.forEach(s => {
        let bg = firstAllowed === -1 ? 0 : firstAllowed, bd = Infinity;
        for(let g = 0; g < gaps; g++){
          if(gapForbidden[g]) continue;
          const prev = g > 0 ? anchors[g - 1] : null;
          const next = g < anchors.length ? anchors[g] : null;
          let dd = Math.min(prev ? legMinutes(prev, s, false) : Infinity,
                            next ? legMinutes(s, next, false) : Infinity);
          if(next && early[g]) dd += 0.5;            // tie-break: don't slot before a day-opening anchor
          if(prev && !early[g - 1]) dd += 0.5;       // tie-break: don't slot after a day-closing anchor
          if(dd < bd){ bd = dd; bg = g; }
        }
        gapStops[bg].push(s);
      });
      seq = [];
      for(let g = 0; g < gaps; g++){
        const prev = g > 0 ? anchors[g - 1] : null;
        const next = g < anchors.length ? anchors[g] : null;
        seq.push(...orderStops(gapStops[g], prev, next));
        if(next) seq.push(next);
      }
    }
    seq = placeMeals(d, seq);
    orders[d.id] = [...fixedNoCoord[i], ...seq.map(s => s.id)];
  });
  return { orders };
}
