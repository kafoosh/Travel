/* Small shared helpers — no DOM, no state. */

export function toRad(x){ return x * Math.PI / 180; }

export function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export function parseTime(str){
  const m = /^(\d{1,2}):(\d{2})$/.exec((str || '').trim());
  if(!m) return 9 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatTime(mins){
  mins = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(mins/60);
  const m = mins % 60;
  const period = h < 12 ? 'AM' : 'PM';
  let h12 = h % 12; if(h12 === 0) h12 = 12;
  return h12 + ':' + String(m).padStart(2,'0') + ' ' + period;
}

export function formatClock24(mins){
  mins = ((Math.round(mins) % 1440) + 1440) % 1440;
  return String(Math.floor(mins/60)).padStart(2,'0') + ':' + String(mins % 60).padStart(2,'0');
}

export function formatDur(mins){
  if(mins < 60) return mins + ' min';
  const h = Math.floor(mins/60), m = mins % 60;
  return h + 'h' + (m ? ' ' + m + 'm' : '');
}

/* Escape user-entered text before it lands in innerHTML. Every stop name,
   description, hotel, and note is user (or LLM) supplied in this app, so
   nothing may be interpolated raw. */
export function esc(s){
  return String(s == null ? '' : s)
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&#39;');
}

export function debounce(fn, ms){
  let t = null;
  return function(...args){
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

export function slugify(s){
  return String(s || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'trip';
}

/* Date helpers for the optional trip start date. dayIndex is 0-based. */
export function dayDate(startDateStr, dayIndex){
  if(!startDateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDateStr.trim());
  if(!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if(isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + dayIndex);
  return d;
}

const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function formatDayDate(d){
  if(!d) return '';
  return WEEKDAYS[d.getDay()] + ' ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
}

/* Read a coordinate pair out of whatever a map app hands over when copied:
   "41.9101438, 12.4983547", "(41.9101438, 12.4983547)", "41.91 12.49",
   "41.91° N, 12.49° E", degrees-minutes-seconds (41°54'36.5"N 12°29'54.1"E),
   or a Google Maps link carrying the pin (…!3d41.91!4d12.49) or view
   (…/@41.91,12.49,17z). Returns { lat, lng } or null when the text isn't a
   pair — an address, a lone number, something out of range. */
const COORD = String.raw`([NSEW])?\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*['′’]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:["″”]|'')\s*)?([NSEW])?`;
const COORD_PAIR = new RegExp('^' + COORD + String.raw`(?:\s*[,;/]\s*|\s+|(?<=[NSEW°'′’"″”]))` + COORD + '$', 'i');

export function parseLatLng(str){
  let s = String(str == null ? '' : str).trim();
  if(!s) return null;
  if(/^https?:\/\//i.test(s)){
    const m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(s) ||
              /[@=](-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(decodeURIComponent(s));
    return m ? checkLatLng(Number(m[1]), Number(m[2])) : null;
  }
  s = s.replace(/^[([{]\s*/, '').replace(/\s*[)\]}]$/, '');
  const m = COORD_PAIR.exec(s);
  if(!m) return null;
  const a = coordPart(m.slice(1, 6)), b = coordPart(m.slice(6, 11));
  if(!a || !b) return null;
  // Hemisphere letters can put longitude first ("12.49E 41.91N").
  const swap = /[EW]/i.test(a.hemi) || /[NS]/i.test(b.hemi);
  return swap ? checkLatLng(b.val, a.val) : checkLatLng(a.val, b.val);
}

function coordPart([pre, deg, min, sec, post]){
  if(pre && post) return null;
  const hemi = (pre || post || '').toUpperCase();
  if((min && Number(min) >= 60) || (sec && Number(sec) >= 60)) return null;
  if((min || sec) && deg.includes('.')) return null;
  let val = Math.abs(Number(deg)) + (min ? Number(min) / 60 : 0) + (sec ? Number(sec) / 3600 : 0);
  if(deg.startsWith('-') || hemi === 'S' || hemi === 'W') val = -val;
  if(deg.startsWith('-') && hemi) return null;   // "-41.9 S" — contradictory
  return { val: Math.round(val * 1e7) / 1e7, hemi };
}

function checkLatLng(lat, lng){
  if(!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
