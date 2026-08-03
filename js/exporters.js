/* =========================================================
   EXTERNAL MAP EXPORTS

   - dayMapPoints: the day's located points in visit order —
     hotel bookends, stops, hike end points — labelled so the UI
     can offer them for picking.

   - googleMapsDayUrl: a plain Google Maps directions link for
     one day's stops in visit order (walking), optionally only
     the points the user picked. No API, no key — just the
     documented maps.google.com/dir/?api=1 URL scheme, openable
     and shareable on any device. Google caps waypoints at 9
     between origin and destination (11 points total); we report
     truncation so the UI can say so.

   - tripKml: the whole trip as a KML file — one folder per day
     with numbered placemarks and a route line, plus Optional —
     which imports directly into Google My Maps
     (mymaps.google.com → Create a new map → Import) to give a
     shareable custom Google map of the trip.
   ========================================================= */

import { computeSchedule } from './schedule.js';
import { formatTime } from './util.js';
import { DAY_COLORS } from './format.js';

/* KML colors are aabbggrr; b3 ≈ 70% opacity, matching the default route style. */
function kmlColor(hex){
  const h = hex.replace('#','');
  return 'b3' + h.slice(4,6) + h.slice(2,4) + h.slice(0,2);
}

function xmlEsc(s){
  return String(s == null ? '' : s)
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&apos;');
}

/* Ordered points for a day: hotel bookends + stops + hike ends. Each is
   {lat, lng, label, cat, when} — `when` is the scheduled time for stops and
   a plain word for the bookends, so a picker can name what it is offering. */
export function dayMapPoints(trip, day){
  const sched = computeSchedule(trip, day);
  const pts = [];
  const hotel = sched.hotel;
  const bookend = day.bookend || 'both';
  if(hotel && hotel.lat != null && bookend !== 'end')
    pts.push({ lat: hotel.lat, lng: hotel.lng, label: hotel.name, cat: 'hotel', when: 'Start of the day' });
  sched.rows.forEach(r => {
    const s = r.stop;
    if(s.lat == null) return;
    pts.push({ lat: s.lat, lng: s.lng, label: s.name, cat: s.cat, when: formatTime(r.start) });
    if(s.cat === 'hike' && s.endLat != null)
      pts.push({ lat: s.endLat, lng: s.endLng, label: s.name + ' (hike end)', cat: 'hike', when: '' });
  });
  if(hotel && hotel.lat != null && bookend !== 'start' && pts.length)
    pts.push({ lat: hotel.lat, lng: hotel.lng, label: hotel.name, cat: 'hotel', when: 'End of the day' });
  return pts;
}

const MAXPTS = 11;                      // origin + 9 waypoints + destination

/* A directions link through the given points, in the order given. */
export function googleMapsUrl(pts){
  if(!pts || pts.length < 2) return { url: null, truncated: false };
  const use = pts.length > MAXPTS ? pts.slice(0, MAXPTS) : pts;
  const fmt = p => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
  const params = new URLSearchParams({
    api: '1',
    origin: fmt(use[0]),
    destination: fmt(use[use.length - 1]),
    travelmode: 'walking',
  });
  if(use.length > 2) params.set('waypoints', use.slice(1, -1).map(fmt).join('|'));
  return { url: 'https://www.google.com/maps/dir/?' + params.toString(), truncated: pts.length > MAXPTS };
}

export function googleMapsDayUrl(trip, day){
  return googleMapsUrl(dayMapPoints(trip, day));
}

export function tripKml(trip){
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  L.push('<name>' + xmlEsc(trip.name || 'Trip') + '</name>');
  if(trip.subtitle) L.push('<description>' + xmlEsc(trip.subtitle) + '</description>');
  L.push('<Style id="route"><LineStyle><color>b3336ec1</color><width>3</width></LineStyle></Style>');
  Object.entries(DAY_COLORS).forEach(([key, c]) =>
    L.push('<Style id="route-' + key + '"><LineStyle><color>' + kmlColor(c.accent) + '</color><width>3</width></LineStyle></Style>'));

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
    const pts = dayMapPoints(trip, day);
    if(pts.length > 1){
      L.push('<Placemark><name>' + xmlEsc('Day ' + day.id + ' route') + '</name><styleUrl>#route' +
        (DAY_COLORS[day.color] ? '-' + day.color : '') + '</styleUrl>' +
        '<LineString><tessellate>1</tessellate><coordinates>' +
        pts.map(p => p.lng + ',' + p.lat + ',0').join(' ') +
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
