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
