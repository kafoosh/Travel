/* =========================================================
   EXTERNAL MAP EXPORTS

   - googleMapsDayUrl: a plain Google Maps directions link for
     one day's stops in visit order (walking). No API, no key —
     just the documented maps.google.com/dir/?api=1 URL scheme,
     openable and shareable on any device. Google caps waypoints
     at 9 between origin and destination (11 points total); we
     report truncation so the UI can say so.

   - tripKml: the whole trip as a KML file — one folder per day
     with numbered placemarks and a route line, plus Optional —
     which imports directly into Google My Maps
     (mymaps.google.com → Create a new map → Import) to give a
     shareable custom Google map of the trip.
   ========================================================= */

import { computeSchedule } from './schedule.js';
import { formatTime } from './util.js';

function xmlEsc(s){
  return String(s == null ? '' : s)
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&apos;');
}

/* Ordered [lat,lng,label] points for a day: hotel bookends + stops + hike ends. */
function dayPoints(trip, day){
  const sched = computeSchedule(trip, day);
  const pts = [];
  const hotel = sched.hotel;
  const bookend = day.bookend || 'both';
  if(hotel && hotel.lat != null && bookend !== 'end') pts.push([hotel.lat, hotel.lng, hotel.name]);
  sched.rows.forEach(r => {
    const s = r.stop;
    if(s.lat == null) return;
    pts.push([s.lat, s.lng, s.name]);
    if(s.cat === 'hike' && s.endLat != null) pts.push([s.endLat, s.endLng, s.name + ' (hike end)']);
  });
  if(hotel && hotel.lat != null && bookend !== 'start' && pts.length) pts.push([hotel.lat, hotel.lng, hotel.name]);
  return pts;
}

export function googleMapsDayUrl(trip, day){
  const pts = dayPoints(trip, day);
  if(pts.length < 2) return { url: null, truncated: false };
  const MAXPTS = 11;                    // origin + 9 waypoints + destination
  const use = pts.length > MAXPTS ? pts.slice(0, MAXPTS) : pts;
  const fmt = p => p[0].toFixed(5) + ',' + p[1].toFixed(5);
  const params = new URLSearchParams({
    api: '1',
    origin: fmt(use[0]),
    destination: fmt(use[use.length - 1]),
    travelmode: 'walking',
  });
  if(use.length > 2) params.set('waypoints', use.slice(1, -1).map(fmt).join('|'));
  return { url: 'https://www.google.com/maps/dir/?' + params.toString(), truncated: pts.length > MAXPTS };
}

export function tripKml(trip){
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  L.push('<name>' + xmlEsc(trip.name || 'Trip') + '</name>');
  if(trip.subtitle) L.push('<description>' + xmlEsc(trip.subtitle) + '</description>');
  L.push('<Style id="route"><LineStyle><color>b3336ec1</color><width>3</width></LineStyle></Style>');

  const placemark = (name, desc, lat, lng) =>
    '<Placemark><name>' + xmlEsc(name) + '</name>' +
    (desc ? '<description>' + xmlEsc(desc) + '</description>' : '') +
    '<Point><coordinates>' + lng + ',' + lat + ',0</coordinates></Point></Placemark>';

  trip.days.forEach(day => {
    const sched = computeSchedule(trip, day);
    L.push('<Folder><name>' + xmlEsc('Day ' + day.id + ' — ' + day.title) + '</name>');
    let n = 0;
    sched.rows.forEach(r => {
      const s = r.stop;
      if(s.lat == null) return;
      n += 1;
      const desc = [formatTime(r.start) + ' · ' + s.dur + ' min', s.desc, s.notes ? 'Notes: ' + s.notes : '']
        .filter(Boolean).join('\n');
      L.push(placemark(n + '. ' + s.name, desc, s.lat, s.lng));
      if(s.cat === 'hike' && s.endLat != null) L.push(placemark(n + 'b. ' + s.name + ' (hike end)', '', s.endLat, s.endLng));
    });
    const pts = dayPoints(trip, day);
    if(pts.length > 1){
      L.push('<Placemark><name>' + xmlEsc('Day ' + day.id + ' route') + '</name><styleUrl>#route</styleUrl>' +
        '<LineString><tessellate>1</tessellate><coordinates>' +
        pts.map(p => p[1] + ',' + p[0] + ',0').join(' ') +
        '</coordinates></LineString></Placemark>');
    }
    L.push('</Folder>');
  });

  if(trip.optional.length){
    L.push('<Folder><name>Optional ideas</name>');
    trip.optional.forEach(o => {
      const s = trip.stops[o.id];
      if(!s || s.lat == null) return;
      L.push(placemark(s.name, s.desc || '', s.lat, s.lng));
    });
    L.push('</Folder>');
  }

  L.push('</Document></kml>');
  return L.join('\n');
}
