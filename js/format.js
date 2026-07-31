/* =========================================================
   TRIP MODEL + IMPORT/EXPORT FORMAT

   The canonical interchange format is a human/LLM-friendly
   markdown document (see serializeTrip for the exact shape).
   parseTrip is deliberately tolerant: key aliases, missing
   sections, `-` or `*` or bare `key: value` lines all work,
   because the whole point is that an LLM (or a human in a
   text editor) writes these files. A simple CSV of locations
   is accepted too for spreadsheet-shaped input.
   ========================================================= */

export const CATEGORIES = ['landmark','museum','church','park','view','food','shop','hotel','travel','boat','other'];

export const DEFAULT_DUR = {
  landmark:45, museum:90, church:30, park:45, view:30, food:60,
  shop:60, hotel:20, travel:120, boat:30, other:45
};

export const THEMES = ['parchment','lagoon','terracotta','midnight','field-notes'];

export function newDay(n){
  return { id:n, title:'Day ' + n, start:'09:00', hotelId:null, order:[] };
}

export function blankTrip(){
  return {
    name:'Untitled Trip',
    subtitle:'',
    startDate:null,          // 'YYYY-MM-DD' or null
    theme:'parchment',
    hotels:[],               // {id, name, lat, lng, mode:'walk'|'boat', img, desc}
    days:[newDay(1), newDay(2), newDay(3)],
    stops:{},                // id -> {id,name,cat,dur,lat,lng,img,desc,detail,notes,tags:[]}
    optional:[],             // {id, day, note} — suggestions not on any day yet
    bin:[],                  // [stopId]
    info:{ weather:'', closures:'', reservations:'', events:'', notes:'' },
    counter:0                // id counter for stops added in the UI
  };
}

/* ---------- serialization ---------- */

const NL = '\n';
function encVal(v){ return String(v).replace(/\r?\n/g, '\\n'); }
function decVal(v){ return String(v).replace(/\\n/g, '\n'); }

function stopLines(s){
  const out = [];
  if(s.lat != null && s.lng != null){
    out.push('- lat: ' + s.lat);
    out.push('- lng: ' + s.lng);
  }
  out.push('- category: ' + (s.cat || 'other'));
  out.push('- duration: ' + (s.dur ?? DEFAULT_DUR[s.cat] ?? 45));
  if(s.img) out.push('- image: ' + encVal(s.img));
  if(s.desc) out.push('- description: ' + encVal(s.desc));
  if(s.detail) out.push('- detail: ' + encVal(s.detail));
  if(s.notes) out.push('- notes: ' + encVal(s.notes));
  if(s.tags && s.tags.length) out.push('- tags: ' + s.tags.map(encVal).join(', '));
  return out;
}

export function serializeTrip(trip){
  const L = [];
  L.push('# Trip: ' + (trip.name || 'Untitled Trip'), '');
  if(trip.subtitle) L.push('- subtitle: ' + encVal(trip.subtitle));
  L.push('- days: ' + trip.days.length);
  if(trip.startDate) L.push('- start date: ' + trip.startDate);
  if(trip.theme) L.push('- theme: ' + trip.theme);
  L.push('');

  if(trip.hotels.length){
    L.push('## Hotels', '');
    trip.hotels.forEach(h => {
      L.push('### ' + h.name);
      if(h.lat != null && h.lng != null){
        L.push('- lat: ' + h.lat);
        L.push('- lng: ' + h.lng);
      }
      L.push('- transport: ' + (h.mode === 'boat' ? 'boat' : 'walk'));
      if(h.img) L.push('- image: ' + encVal(h.img));
      if(h.desc) L.push('- description: ' + encVal(h.desc));
      L.push('');
    });
  }

  trip.days.forEach((d, i) => {
    L.push('## Day ' + (i + 1) + ': ' + (d.title || ('Day ' + (i + 1))));
    L.push('- start: ' + (d.start || '09:00'));
    const hotel = trip.hotels.find(h => h.id === d.hotelId);
    L.push('- hotel: ' + (hotel ? hotel.name : 'none'));
    L.push('');
    d.order.forEach(id => {
      const s = trip.stops[id];
      if(!s) return;
      L.push('### ' + s.name);
      L.push(...stopLines(s));
      L.push('');
    });
  });

  if(trip.optional.length){
    L.push('## Optional', '');
    trip.optional.forEach(o => {
      const s = trip.stops[o.id];
      if(!s) return;
      L.push('### ' + s.name);
      L.push(...stopLines(s));
      if(o.day) L.push('- suggested day: ' + o.day);
      if(o.note) L.push('- suggestion note: ' + encVal(o.note));
      L.push('');
    });
  }

  if(trip.bin.length){
    L.push('## Bin', '');
    trip.bin.forEach(id => {
      const s = trip.stops[id];
      if(!s) return;
      L.push('### ' + s.name);
      L.push(...stopLines(s));
      L.push('');
    });
  }

  const info = trip.info || {};
  const infoSections = [
    ['Weather', info.weather], ['Closures', info.closures],
    ['Reservations', info.reservations], ['Events', info.events], ['Notes', info.notes]
  ].filter(([, v]) => v && v.trim());
  if(infoSections.length){
    L.push('## Trip Info', '');
    infoSections.forEach(([title, text]) => {
      L.push('### ' + title, '', text.trim(), '');
    });
  }

  return L.join(NL).replace(/\n{3,}/g, '\n\n').trim() + NL;
}

/* ---------- markdown parsing ---------- */

const KEY_ALIASES = {
  lat:'lat', latitude:'lat',
  lng:'lng', lon:'lng', long:'lng', longitude:'lng',
  category:'cat', cat:'cat', type:'cat',
  duration:'dur', dur:'dur', minutes:'dur', time:'dur',
  image:'img', img:'img', photo:'img', picture:'img',
  description:'desc', desc:'desc', 'short description':'desc', summary:'desc',
  detail:'detail', details:'detail', history:'detail', trivia:'detail', 'long description':'detail',
  notes:'notes', note:'notes',
  tags:'tags',
  'suggested day':'sday', 'recommended day':'sday',
  'suggestion note':'snote', 'recommended note':'snote', 'suggestion':'snote',
  transport:'mode', mode:'mode',
  start:'start', 'start time':'start',
  hotel:'hotel',
  subtitle:'subtitle', days:'days',
  'start date':'startDate', date:'startDate', 'startdate':'startDate',
  theme:'theme',
};

const INFO_KEYS = {
  weather:'weather',
  closures:'closures', 'weekly closures':'closures', 'location closures':'closures',
  reservations:'reservations', 'reservation musts':'reservations', bookings:'reservations',
  events:'events', 'overlapping events':'events',
  notes:'notes', general:'notes', misc:'notes', other:'notes',
};

function kvLine(line){
  const m = /^\s*[-*]?\s*([A-Za-z][A-Za-z0-9 _-]{0,24})\s*:\s*(.*)$/.exec(line);
  if(!m) return null;
  const key = KEY_ALIASES[m[1].trim().toLowerCase()];
  if(!key) return null;
  return { key, value: m[2].trim() };
}

function parseDuration(v){
  const hm = /^(\d+)\s*h(?:\s*(\d+)\s*m?)?/i.exec(v);
  if(hm) return Number(hm[1]) * 60 + Number(hm[2] || 0);
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function normCat(v){
  const c = String(v || '').trim().toLowerCase();
  if(CATEGORIES.includes(c)) return c;
  const map = { restaurant:'food', dining:'food', cafe:'food', bar:'food',
    viewpoint:'view', lookout:'view', gallery:'museum', shopping:'shop', store:'shop',
    monument:'landmark', sight:'landmark', square:'landmark', plaza:'landmark',
    garden:'park', beach:'park', nature:'park', transit:'travel', train:'travel',
    ferry:'boat', gondola:'boat', accommodation:'hotel', lodging:'hotel' };
  return map[c] || 'other';
}

/* Parse the markdown trip format. Returns {trip, warnings}. Throws only when
   the text yields nothing usable at all. */
export function parseTrip(text){
  const warnings = [];
  const trip = blankTrip();
  trip.days = [];

  let section = null;          // 'hotels' | day object | 'optional' | 'bin' | 'info'
  let cur = null;              // current stop/hotel being filled
  let curOptMeta = null;       // {day, note} for the current optional stop
  let infoKey = null, infoBuf = [];
  let stopSeq = 0, hotelSeq = 0, metaDays = null;

  const flushInfo = () => {
    if(infoKey && infoBuf.length){
      const textVal = infoBuf.join('\n').trim();
      if(textVal) trip.info[infoKey] = (trip.info[infoKey] ? trip.info[infoKey] + '\n\n' : '') + textVal;
    }
    infoBuf = [];
  };
  const finishStop = () => {
    if(!cur) return;
    if(cur.__kind === 'hotel'){
      trip.hotels.push({ id:'h' + (++hotelSeq), name:cur.name, lat:cur.lat ?? null, lng:cur.lng ?? null,
        mode:cur.mode === 'boat' ? 'boat' : 'walk', img:cur.img || '', desc:cur.desc || '' });
    } else {
      const id = 's' + (++stopSeq);
      const stop = { id, name:cur.name, cat:cur.cat || 'other',
        dur: cur.dur ?? DEFAULT_DUR[cur.cat || 'other'] ?? 45,
        lat: cur.lat ?? null, lng: cur.lng ?? null,
        img: cur.img || '', desc: cur.desc || '', detail: cur.detail || '',
        notes: cur.notes || '', tags: cur.tags || [] };
      trip.stops[id] = stop;
      if(cur.__kind === 'day') cur.__day.order.push(id);
      else if(cur.__kind === 'optional') trip.optional.push({ id, day: curOptMeta.day || null, note: curOptMeta.note || '' });
      else if(cur.__kind === 'bin') trip.bin.push(id);
    }
    cur = null; curOptMeta = null;
  };

  for(const rawLine of String(text).split(/\r?\n/)){
    const line = rawLine.replace(/\s+$/,'');

    const h1 = /^#\s+(?:Trip\s*:\s*)?(.+)$/.exec(line);
    if(h1 && trip.name === 'Untitled Trip' && !section){
      trip.name = h1[1].trim();
      continue;
    }

    const h2 = /^##\s+(.+)$/.exec(line);
    if(h2){
      finishStop(); flushInfo(); infoKey = null;
      const title = h2[1].trim();
      const dayM = /^Day\s+(\d+)\s*(?:[:—–-]\s*(.*))?$/i.exec(title);
      if(dayM){
        const n = Number(dayM[1]);
        while(trip.days.length < n) trip.days.push(newDay(trip.days.length + 1));
        const day = trip.days[n - 1];
        if(dayM[2]) day.title = dayM[2].trim();
        section = day;
      } else if(/^hotels?$/i.test(title)) section = 'hotels';
      else if(/^optional/i.test(title)) section = 'optional';
      else if(/^bin$/i.test(title)) section = 'bin';
      else if(/^trip\s*info/i.test(title) || /^info$/i.test(title)) section = 'info';
      else { warnings.push('Unrecognised section "' + title + '" — skipped.'); section = 'skip'; }
      continue;
    }

    const h3 = /^###\s+(.+)$/.exec(line);
    if(h3){
      finishStop();
      if(section === 'info'){
        flushInfo();
        const k = INFO_KEYS[h3[1].trim().toLowerCase()];
        if(k){ infoKey = k; }
        else { infoKey = 'notes'; infoBuf.push('**' + h3[1].trim() + '**'); }
      } else if(section === 'hotels'){
        cur = { __kind:'hotel', name:h3[1].trim() };
      } else if(section && section !== 'skip'){
        const kind = section === 'optional' ? 'optional' : section === 'bin' ? 'bin' : 'day';
        cur = { __kind:kind, name:h3[1].trim() };
        if(kind === 'day') cur.__day = section;
        if(kind === 'optional') curOptMeta = {};
      }
      continue;
    }

    if(section === 'info'){
      if(infoKey) infoBuf.push(line);
      continue;
    }

    const kv = kvLine(line);
    if(kv){
      const { key, value } = kv;
      if(cur){
        if(key === 'lat' || key === 'lng'){ const n = parseFloat(value); if(!isNaN(n)) cur[key] = n; }
        else if(key === 'dur'){ const d = parseDuration(value); if(d != null) cur.dur = d; }
        else if(key === 'cat') cur.cat = normCat(value);
        else if(key === 'tags') cur.tags = value.split(/[,|]/).map(t => decVal(t.trim())).filter(Boolean);
        else if(key === 'sday' && curOptMeta){ const n = parseInt(value, 10); if(!isNaN(n)) curOptMeta.day = n; }
        else if(key === 'snote' && curOptMeta) curOptMeta.note = decVal(value);
        else if(['img','desc','detail','notes','mode'].includes(key)) cur[key] = decVal(value);
      } else if(section && typeof section === 'object'){
        // day-level metadata
        if(key === 'start' && /^\d{1,2}:\d{2}$/.test(value)) section.start = value;
        else if(key === 'hotel') section.__hotelName = /^(none|no|-|)$/i.test(value) ? null : value;
      } else if(!section){
        // trip-level metadata
        if(key === 'subtitle') trip.subtitle = decVal(value);
        else if(key === 'days'){ const n = parseInt(value, 10); if(!isNaN(n)) metaDays = n; }
        else if(key === 'startDate' && /^\d{4}-\d{2}-\d{2}$/.test(value)) trip.startDate = value;
        else if(key === 'theme' && THEMES.includes(value.toLowerCase())) trip.theme = value.toLowerCase();
      }
      continue;
    }
  }
  finishStop(); flushInfo();

  if(metaDays){ while(trip.days.length < metaDays) trip.days.push(newDay(trip.days.length + 1)); }
  if(!trip.days.length) trip.days.push(newDay(1));

  // Resolve day → hotel references by name (case-insensitive).
  trip.days.forEach(d => {
    if(d.__hotelName){
      const h = trip.hotels.find(h => h.name.toLowerCase() === d.__hotelName.toLowerCase());
      if(h) d.hotelId = h.id;
      else warnings.push('Day ' + d.id + ' names hotel "' + d.__hotelName + '" which is not in the Hotels section.');
    }
    delete d.__hotelName;
  });

  trip.counter = stopSeq;
  const stopCount = Object.keys(trip.stops).length;
  if(stopCount === 0 && trip.hotels.length === 0 && trip.name === 'Untitled Trip'){
    throw new Error('Could not find a trip in that text — expected markdown starting with "# Trip: <name>" with "## Day 1: …" sections (or a CSV of locations).');
  }
  Object.values(trip.stops).forEach(s => {
    if(s.lat == null || s.lng == null) warnings.push('"' + s.name + '" has no coordinates — it will not appear on the map or in travel times.');
  });
  return { trip, warnings };
}

/* ---------- CSV parsing ---------- */

function splitCsvLine(line, delim){
  const out = []; let cur = '', inQ = false;
  for(let i = 0; i < line.length; i++){
    const ch = line[i];
    if(inQ){
      if(ch === '"'){ if(line[i+1] === '"'){ cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else {
      if(ch === '"') inQ = true;
      else if(ch === delim){ out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/* Accepts a CSV with a header row. Recognised columns (any order, case-insensitive):
   name, day, lat, lng, category, duration, description, detail, image, notes, tags.
   day may be a number, "optional", or empty (→ day 1). */
export function parseCsv(text){
  const warnings = [];
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if(lines.length < 2) throw new Error('CSV needs a header row and at least one location row.');
  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const header = splitCsvLine(lines[0], delim).map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const idx = {
    name: col('name'), day: col('day'), lat: col('lat') !== -1 ? col('lat') : col('latitude'),
    lng: ['lng','lon','longitude'].map(col).find(i => i !== -1) ?? -1,
    cat: ['category','cat','type'].map(col).find(i => i !== -1) ?? -1,
    dur: ['duration','minutes','dur'].map(col).find(i => i !== -1) ?? -1,
    desc: ['description','desc'].map(col).find(i => i !== -1) ?? -1,
    detail: ['detail','details'].map(col).find(i => i !== -1) ?? -1,
    img: ['image','img','photo'].map(col).find(i => i !== -1) ?? -1,
    notes: ['notes','note'].map(col).find(i => i !== -1) ?? -1,
    tags: col('tags'),
  };
  if(idx.name === -1) throw new Error('CSV must have a "name" column.');

  const trip = blankTrip();
  trip.name = 'Imported Trip';
  trip.days = [newDay(1)];
  let seq = 0;
  const get = (cells, i) => i === -1 ? '' : (cells[i] || '').trim();

  for(let r = 1; r < lines.length; r++){
    const cells = splitCsvLine(lines[r], delim);
    const name = get(cells, idx.name);
    if(!name) continue;
    const cat = normCat(get(cells, idx.cat));
    const id = 's' + (++seq);
    const lat = parseFloat(get(cells, idx.lat)), lng = parseFloat(get(cells, idx.lng));
    trip.stops[id] = {
      id, name, cat,
      dur: parseDuration(get(cells, idx.dur)) ?? DEFAULT_DUR[cat] ?? 45,
      lat: isNaN(lat) ? null : lat, lng: isNaN(lng) ? null : lng,
      img: get(cells, idx.img), desc: get(cells, idx.desc), detail: get(cells, idx.detail),
      notes: get(cells, idx.notes),
      tags: get(cells, idx.tags) ? get(cells, idx.tags).split(/[,|]/).map(t => t.trim()).filter(Boolean) : []
    };
    const dayRaw = get(cells, idx.day).toLowerCase();
    if(dayRaw === 'optional' || dayRaw === 'pool'){
      trip.optional.push({ id, day:null, note:'' });
    } else {
      const n = parseInt(dayRaw, 10) || 1;
      while(trip.days.length < n) trip.days.push(newDay(trip.days.length + 1));
      trip.days[n - 1].order.push(id);
    }
  }
  trip.counter = seq;
  if(!seq) throw new Error('No location rows found in the CSV.');
  Object.values(trip.stops).forEach(s => {
    if(s.lat == null) warnings.push('"' + s.name + '" has no coordinates.');
  });
  return { trip, warnings };
}

/* Sniff which parser a pasted/uploaded text wants. */
export function importText(text){
  const t = String(text || '').trim();
  if(!t) throw new Error('Nothing to import.');
  const firstLines = t.split(/\r?\n/, 5);
  const looksMd = /^#/.test(t) || t.includes('\n#') || firstLines.some(l => /^[-*]?\s*\w[\w ]*:\s/.test(l) && !l.includes(','));
  const looksCsv = firstLines[0] && firstLines[0].split(',').length >= 2 && /name/i.test(firstLines[0]);
  if(looksCsv && !/^#/.test(t)) return parseCsv(t);
  if(looksMd) return parseTrip(t);
  return parseCsv(t); // last resort; throws a helpful error if it isn't CSV either
}

/* Sanity-check a trip object that arrived from Firestore or storage. */
export function isValidTrip(t){
  return !!(t && typeof t === 'object' && Array.isArray(t.days) && t.days.length &&
    t.stops && typeof t.stops === 'object' && Array.isArray(t.bin) && Array.isArray(t.hotels));
}
