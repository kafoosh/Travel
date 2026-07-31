/* =========================================================
   DAY SCHEDULE
   Walks a day's stop order and accumulates travel + visit
   time. Travel estimates come from routing.estimateLeg, which
   answers instantly (live cache or heuristic) and back-fills
   real numbers via the routing 'update' event.
   ========================================================= */

import { parseTime } from './util.js';
import { dayDate } from './util.js';
import { estimateLeg } from './routing.js';

export function getHotel(trip, day){
  return trip.hotels.find(h => h.id === day.hotelId) || null;
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

  const hotel = getHotel(trip, day);
  if(hotel && hotel.lat != null){
    prev = { lat: hotel.lat, lng: hotel.lng, __hotel: true };
  }

  const legOpts = (a, b) => ({
    boat: !!(hotel && hotel.mode === 'boat' && (a.__hotel || b.__hotel)),
    dayDate: date,
    departMinutes: t,
  });

  order.forEach((id, idx) => {
    const stop = trip.stops[id];
    if(!stop) return;
    let travel = 0, mode = null, live = false;
    if(prev && prev.lat != null && stop.lat != null){
      const info = estimateLeg(prev, stop, legOpts(prev, stop));
      travel = info.minutes; mode = info.mode; live = info.live;
      t += travel;
      if(rows.length === 0 && prev.__hotel) leadTransfer = info;
    }
    const startMin = t;
    t += stop.dur;
    rows.push({
      stop, start: startMin, end: t,
      travelBefore: (rows.length === 0 && leadTransfer) ? 0 : travel,
      travelMode: mode, travelLive: live,
    });
    if(stop.lat != null) prev = stop;
  });

  if(hotel && hotel.lat != null && rows.length){
    const lastWithCoords = [...rows].reverse().find(r => r.stop.lat != null);
    if(lastWithCoords){
      const back = { lat: hotel.lat, lng: hotel.lng, __hotel: true };
      trailTransfer = estimateLeg(lastWithCoords.stop, back, legOpts(lastWithCoords.stop, back));
      t += trailTransfer.minutes;
    }
  }

  return { rows, leadTransfer, trailTransfer, returnTime: t, hotel, date };
}
