/* =========================================================
   DAY SCHEDULE
   Walks a day's stop order and accumulates travel + visit
   time. Travel estimates come from routing.estimateLeg, which
   answers instantly (live cache or heuristic) and back-fills
   real numbers via the routing 'update' event.

   Understands:
   - per-day start/end hotels: the day departs from its start
     hotel and returns to its end hotel — usually the same one,
     but either can be missing (arrival/departure days) or a
     different hotel (a check-out/check-in day)
   - fixed start times on stops (flight lands 14:30, timed
     museum entry…): the schedule waits when early and flags
     the overrun when late. The day's first fixed start is the
     exception to "late": the day's start time is a default,
     not a promise, so when the stops before it can't make it
     from there, the day sets off earlier instead
   - point-to-point stops (hike, train/travel, flight, boat):
     start at (lat,lng), optionally end at (endLat,endLng).
     The commute runs to the start point, the stop's duration
     is the leg itself, and the next leg departs from the end
     point. A hike gets a routed walking path and counts as
     walked km; a ride counts straight-line km by other modes.
   - distance totals: km walked and km by other modes, from
     routed geometry when known, heuristics otherwise
   ========================================================= */

import { parseTime, dayDate, haversineKm } from './util.js';
import { estimateLeg } from './routing.js';
import { AB_CATS } from './format.js';

export function getStartHotel(trip, day){
  return trip.hotels.find(h => h.id === day.startHotelId) || null;
}

export function getEndHotel(trip, day){
  return trip.hotels.find(h => h.id === day.endHotelId) || null;
}

export function departPoint(stop){
  if(AB_CATS.includes(stop.cat) && stop.endLat != null && stop.endLng != null){
    return { lat: stop.endLat, lng: stop.endLng };
  }
  return (stop.lat != null) ? { lat: stop.lat, lng: stop.lng } : null;
}

export function computeSchedule(trip, day){
  const planned = parseTime(day.start);
  const sched = walkDay(trip, day, planned);
  // A 07:55 train on a day set to start at 09:00 is the plan being early,
  // not the train being missed: leave in time for it. Only the first fixed
  // start moves the day — every later one is timed from the stops before it.
  const firstFixed = sched.rows.find(r => r.fixed);
  if(!firstFixed || firstFixed.late <= 0) return sched;
  const earlier = walkDay(trip, day, Math.max(0, planned - firstFixed.late));
  // Travel estimates can shift with the departure time (transit timetables);
  // one more nudge settles any leftover minutes.
  const still = earlier.rows.find(r => r.fixed);
  const fixed = (still && still.late > 0 && earlier.startTime > 0)
    ? walkDay(trip, day, Math.max(0, earlier.startTime - still.late)) : earlier;
  fixed.movedFor = fixed.rows.find(r => r.fixed).stop;
  return fixed;
}

function walkDay(trip, day, startTime){
  const dayIdx = trip.days.indexOf(day);
  const date = dayDate(trip.startDate, dayIdx);
  const order = day.order;
  let t = startTime;
  const rows = [];
  let prev = null;
  let leadTransfer = null;
  let trailTransfer = null;
  let walkKm = 0, otherKm = 0;

  const startHotel = getStartHotel(trip, day);
  const endHotel = getEndHotel(trip, day);
  const startAtHotel = !!(startHotel && startHotel.lat != null);
  const endAtHotel = !!(endHotel && endHotel.lat != null);

  if(startAtHotel){
    prev = { lat: startHotel.lat, lng: startHotel.lng, __hotel: true };
  }

  const legOpts = (a, b, mode) => ({
    // An explicit per-leg mode wins; otherwise a boat-shuttle hotel forces
    // its own leg — departing the start hotel, or returning to the end one —
    // and everything else is chosen automatically.
    mode: mode || null,
    boat: !mode && !!((a.__hotel && startHotel && startHotel.mode === 'boat') ||
                      (b.__hotel && endHotel && endHotel.mode === 'boat')),
    dayDate: date,
    departMinutes: t,
  });

  const countDist = (info) => {
    if(!info) return;
    if(info.mode === 'walk') walkKm += info.distKm || 0;
    else otherKm += info.distKm || 0;
  };

  order.forEach((id) => {
    const stop = trip.stops[id];
    if(!stop) return;
    let travel = 0, mode = null, live = false, path = null;
    if(prev && prev.lat != null && stop.lat != null){
      const info = estimateLeg(prev, stop, legOpts(prev, stop, stop.arriveBy));
      travel = info.minutes; mode = info.mode; live = info.live; path = info.path;
      countDist(info);
      t += travel;
      if(rows.length === 0 && prev.__hotel) leadTransfer = info;
    }

    // Fixed-clock stops (flights, trains, timed entries): wait if early,
    // flag the overrun if the plan arrives late.
    let waitBefore = 0, late = 0, fixed = false;
    if(stop.fixedStart && /^\d{1,2}:\d{2}$/.test(stop.fixedStart)){
      fixed = true;
      const fs = parseTime(stop.fixedStart);
      if(t < fs){ waitBefore = fs - t; t = fs; }
      else if(t > fs){ late = t - fs; }
    }

    const startMin = t;
    t += stop.dur;

    // A point-to-point stop moves the day from its start to its end point.
    // A hike does the moving on foot: its walking route is fetched (drawn by
    // renderMap) and counts as walked distance. A ride (train, flight, boat)
    // IS the moving — its duration already covers it, so no route is fetched
    // and the straight-line distance counts toward the other-modes total.
    let hikeLeg = null;
    const dep = departPoint(stop);
    const movesAB = dep && stop.lat != null && (dep.lat !== stop.lat || dep.lng !== stop.lng);
    if(movesAB && stop.cat === 'hike'){
      hikeLeg = estimateLeg({ lat: stop.lat, lng: stop.lng }, dep, { forceWalk: true, dayDate: date, departMinutes: startMin });
      walkKm += hikeLeg.distKm || 0;
    } else if(movesAB){
      otherKm += haversineKm(stop.lat, stop.lng, dep.lat, dep.lng);
    }

    rows.push({
      stop, start: startMin, end: t,
      travelBefore: (rows.length === 0 && leadTransfer) ? 0 : travel,
      travelMode: mode, travelLive: live, travelPath: path,
      waitBefore, late, fixed, hikeLeg,
    });
    if(dep) prev = dep;
  });

  if(endAtHotel && rows.length){
    const lastDep = [...rows].map(r => departPoint(r.stop)).reverse().find(Boolean);
    if(lastDep){
      const back = { lat: endHotel.lat, lng: endHotel.lng, __hotel: true };
      trailTransfer = estimateLeg(lastDep, back, legOpts(lastDep, back, day.returnBy));
      countDist(trailTransfer);
      t += trailTransfer.minutes;
    }
  }

  // startTime: when the day actually sets off — the day's own start, or
  // earlier when computeSchedule moved it for a fixed start (movedFor).
  return { rows, leadTransfer, trailTransfer, returnTime: t, startTime, movedFor: null,
    startHotel, endHotel, date, walkKm, otherKm };
}
