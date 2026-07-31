/* =========================================================
   DAY SCHEDULE
   Walks a day's stop order and accumulates travel + visit
   time. Travel estimates come from routing.estimateLeg, which
   answers instantly (live cache or heuristic) and back-fills
   real numbers via the routing 'update' event.

   Understands:
   - hotel bookends per day: 'both' | 'start' | 'end'
   - fixed start times on stops (flight lands 14:30, timed
     museum entry…): the schedule waits when early and flags
     the overrun when late
   - hikes: a stop that starts at (lat,lng) and ends at
     (endLat,endLng) — the next leg departs from the end point
   - distance totals: km walked and km by other modes, from
     routed geometry when known, heuristics otherwise
   ========================================================= */

import { parseTime, dayDate } from './util.js';
import { estimateLeg } from './routing.js';

export function getHotel(trip, day){
  return trip.hotels.find(h => h.id === day.hotelId) || null;
}

export function departPoint(stop){
  if(stop.cat === 'hike' && stop.endLat != null && stop.endLng != null){
    return { lat: stop.endLat, lng: stop.endLng };
  }
  return (stop.lat != null) ? { lat: stop.lat, lng: stop.lng } : null;
}

export function computeSchedule(trip, day){
  const dayIdx = trip.days.indexOf(day);
  const date = dayDate(trip.startDate, dayIdx);
  const order = day.order;
  let t = parseTime(day.start);
  const rows = [];
  let prev = null;
  let leadTransfer = null;
  let trailTransfer = null;
  let walkKm = 0, otherKm = 0;

  const hotel = getHotel(trip, day);
  const bookend = day.bookend || 'both';
  const hotelUsable = hotel && hotel.lat != null;
  const startAtHotel = hotelUsable && bookend !== 'end';
  const endAtHotel = hotelUsable && bookend !== 'start';

  if(startAtHotel){
    prev = { lat: hotel.lat, lng: hotel.lng, __hotel: true };
  }

  const legOpts = (a, b, mode) => ({
    // An explicit per-leg mode wins; otherwise boat-shuttle hotels force
    // their boat leg and everything else is chosen automatically.
    mode: mode || null,
    boat: !mode && !!(hotel && hotel.mode === 'boat' && (a.__hotel || b.__hotel)),
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
    let waitBefore = 0, late = 0;
    if(stop.fixedStart && /^\d{1,2}:\d{2}$/.test(stop.fixedStart)){
      const fs = parseTime(stop.fixedStart);
      if(t < fs){ waitBefore = fs - t; t = fs; }
      else if(t > fs){ late = t - fs; }
    }

    const startMin = t;
    t += stop.dur;

    // A hike travels under its own steam from start to end point — always on
    // foot, counted as walked distance, drawn on the map by renderMap.
    let hikeLeg = null;
    const dep = departPoint(stop);
    if(stop.cat === 'hike' && dep && stop.lat != null && (dep.lat !== stop.lat || dep.lng !== stop.lng)){
      hikeLeg = estimateLeg({ lat: stop.lat, lng: stop.lng }, dep, { forceWalk: true, dayDate: date, departMinutes: startMin });
      walkKm += hikeLeg.distKm || 0;
    }

    rows.push({
      stop, start: startMin, end: t,
      travelBefore: (rows.length === 0 && leadTransfer) ? 0 : travel,
      travelMode: mode, travelLive: live, travelPath: path,
      waitBefore, late, hikeLeg,
    });
    if(dep) prev = dep;
  });

  if(endAtHotel && rows.length){
    const lastDep = [...rows].map(r => departPoint(r.stop)).reverse().find(Boolean);
    if(lastDep){
      const back = { lat: hotel.lat, lng: hotel.lng, __hotel: true };
      trailTransfer = estimateLeg(lastDep, back, legOpts(lastDep, back, day.returnBy));
      countDist(trailTransfer);
      t += trailTransfer.minutes;
    }
  }

  return { rows, leadTransfer, trailTransfer, returnTime: t, hotel, bookend, date, walkKm, otherKm };
}
