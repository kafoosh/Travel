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

export const CATEGORIES = ['landmark','museum','church','park','view','food','shop','hike','hotel','flight','travel','boat','other'];

/* The face of each category / travel mode. They live here, next to the
   category list itself, because more than one renderer needs them: the site
   (js/ui.js) and the self-contained offline export (js/offline.js), which
   can't import anything from the running UI. */
export const CAT_ICONS = {
  landmark:'🏛️', museum:'🖼️', church:'⛪', park:'🌳',
  food:'🍝', view:'🌇', travel:'🚄', shop:'🛍️', hike:'🥾',
  hotel:'🛏️', flight:'✈️', boat:'🚤', other:'📍'
};
export const MODE_ICONS = { walk:'🚶', cycle:'🚲', transit:'🚌', bus:'🚌', metro:'🚇', tram:'🚋', ferry:'⛴️', taxi:'🚕', boat:'🚤' };

export const DEFAULT_DUR = {
  landmark:45, museum:90, church:30, park:45, view:30, food:60,
  shop:60, hike:150, hotel:20, flight:90, travel:120, boat:30, other:45
};

export const THEMES = ['parchment','lagoon','terracotta','midnight','field-notes'];

/* Day colour palette: named accents a day can adopt so different cities or
   areas read apart at a glance. The key is what's persisted (`- color: teal`);
   only the accent hex lives here — dark/tint shades are derived in CSS with
   color-mix so they track whichever theme is active.
   Null prototype: keys are validated with plain `DAY_COLORS[value]` lookups
   in four modules, so inherited names ('constructor', …) must not pass. */
export const DAY_COLORS = Object.assign(Object.create(null), {
  rust:   { name:'Rust',   accent:'#C1502E' },
  gold:   { name:'Gold',   accent:'#B8891F' },
  olive:  { name:'Olive',  accent:'#77813B' },
  forest: { name:'Forest', accent:'#3E6B4F' },
  teal:   { name:'Teal',   accent:'#2E6E71' },
  sea:    { name:'Sea',    accent:'#3D6486' },
  plum:   { name:'Plum',   accent:'#7C4A6B' },
  wine:   { name:'Wine',   accent:'#96393F' },
});

export function newDay(n){
  // startHotelId / endHotelId: where the day begins and where that night is
  // spent — usually the same hotel, but an arrival day may have no start, a
  // departure day no end, and a hotel-change day one of each.
  // color: a DAY_COLORS key, or null to follow the theme accent
  return { id:n, title:'Day ' + n, start:'09:00', startHotelId:null, endHotelId:null, returnBy:null, color:null, order:[] };
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
    // Stops with no day yet. Surfaced in the UI as "Unassigned"; the field
    // keeps its original name because live shared rooms and saved drafts
    // already carry it.
    optional:[],             // {id, day, note}
    bin:[],                  // [stopId]
    // Trip to-dos — book this, pack that. Ticked items stay in the list with
    // done:true; the UI parks them in the Bin so they can be brought back.
    checklist:[],            // {id, text, done}
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
  if(s.endLat != null && s.endLng != null){
    out.push('- end lat: ' + s.endLat);
    out.push('- end lng: ' + s.endLng);
  }
  out.push('- category: ' + (s.cat || 'other'));
  out.push('- duration: ' + (s.dur ?? DEFAULT_DUR[s.cat] ?? 45));
  if(s.fixedStart) out.push('- fixed start: ' + s.fixedStart);
  if(s.arriveBy) out.push('- arrive by: ' + s.arriveBy);
  // Ticked off on the trip itself — written only when true, so a plan that
  // hasn't started yet reads exactly as it always did.
  if(s.done) out.push('- done: yes');
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
    // One "hotel:" line when the day starts and ends at the same place (the
    // common case); explicit start/end lines when the two ends differ.
    const startHotel = trip.hotels.find(h => h.id === d.startHotelId) || null;
    const endHotel = trip.hotels.find(h => h.id === d.endHotelId) || null;
    if(startHotel === endHotel){
      L.push('- hotel: ' + (startHotel ? startHotel.name : 'none'));
    } else {
      L.push('- start hotel: ' + (startHotel ? startHotel.name : 'none'));
      L.push('- end hotel: ' + (endHotel ? endHotel.name : 'none'));
    }
    if(d.returnBy) L.push('- return by: ' + d.returnBy);
    if(d.color) L.push('- color: ' + d.color);
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
    L.push('## Unassigned', '');
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

  if((trip.checklist || []).length){
    L.push('## Checklist', '');
    // Section headings ride out as "###" — real markdown structure, and the
    // parser below reads them back as headings rather than as items.
    trip.checklist.forEach(c => {
      if(c.type === 'header') L.push('', '### ' + encVal(c.text), '');
      else L.push('- [' + (c.done ? 'x' : ' ') + '] ' + encVal(c.text));
    });
    L.push('');
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
  'end lat':'endLat', 'end latitude':'endLat', endlat:'endLat',
  'end lng':'endLng', 'end lon':'endLng', 'end longitude':'endLng', endlng:'endLng',
  'fixed start':'fixedStart', 'fixed time':'fixedStart', fixed:'fixedStart',
  'start hotel':'startHotel', starthotel:'startHotel', 'hotel start':'startHotel',
  'end hotel':'endHotel', endhotel:'endHotel', 'hotel end':'endHotel',
  'hotel bookend':'bookend', bookend:'bookend',   // legacy — pre-start/end-hotel files
  'arrive by':'arriveBy', arriveby:'arriveBy', 'transport to':'arriveBy', 'travel by':'arriveBy',
  'return by':'returnBy', returnby:'returnBy',
  category:'cat', cat:'cat', type:'cat',
  duration:'dur', dur:'dur', minutes:'dur', time:'dur',
  image:'img', img:'img', photo:'img', picture:'img',
  description:'desc', desc:'desc', 'short description':'desc', summary:'desc',
  detail:'detail', details:'detail', history:'detail', trivia:'detail', 'long description':'detail',
  notes:'notes', note:'notes',
  done:'done', visited:'done', completed:'done', seen:'done',
  tags:'tags',
  'suggested day':'sday', 'recommended day':'sday',
  'suggestion note':'snote', 'recommended note':'snote', 'suggestion':'snote',
  transport:'mode', mode:'mode',
  start:'start', 'start time':'start',
  hotel:'hotel',
  subtitle:'subtitle', days:'days',
  'start date':'startDate', date:'startDate', 'startdate':'startDate',
  theme:'theme',
  color:'color', colour:'color', 'day color':'color', 'day colour':'color',
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

/* A yes/no field as a person or an LLM might write it. A bare "- done:" with
   nothing after it means yes — the line was written to say so. */
function isYes(v){
  const s = String(v || '').trim().toLowerCase();
  if(!s) return true;
  return /^(y|yes|true|1|x|✓|✔|done|visited)$/.test(s);
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
    ferry:'boat', gondola:'boat', accommodation:'hotel', lodging:'hotel',
    plane:'flight', airplane:'flight', airport:'flight', fly:'flight',
    trail:'hike', trek:'hike', trekking:'hike', hiking:'hike', walk:'hike' };
  return map[c] || 'other';
}

/* Recover markdown structure from text whose "#"/"##"/"###"/"- " markers were
   stripped — e.g. copied out of a chat UI that rendered the markdown. Only
   kicks in when NO heading markers survive but the shape is recognisable
   (a "Trip:"/"Day N:" line, then "key: value" lines). Idempotent on real
   markdown, which already has the markers. */
function recoverStructure(text){
  const lines = text.split(/\r?\n/);
  if(lines.some(l => /^#{1,3}\s/.test(l))) return text;   // markers intact — leave it
  const KEYS = /^(subtitle|days|start date|start hotel|end hotel|lat|lng|lon|latitude|longitude|end lat|end lng|category|type|duration|minutes|fixed start|arrive by|return by|image|photo|description|desc|detail|details|notes|note|tags|transport|mode|start|hotel|hotel bookend|suggested day|suggestion note|theme|colou?r|day colou?r)\s*:/i;
  const TOP = /^(hotels?|optional|unassigned|bin|checklist|to-?dos?|trip\s*info)\s*$/i;
  const INFOSUB = /^(weather|closures|reservations?|events?|notes|general)\s*$/i;
  const out = [];
  let started = false, inInfo = false;
  for(let i = 0; i < lines.length; i++){
    const raw = lines[i];
    const line = raw.trim();
    if(!line){ out.push(''); continue; }
    const next = (lines[i + 1] || '').trim();
    if(/^trip\s*:/i.test(line)){ out.push('# ' + line); started = true; continue; }
    if(/^day\s+\d+\s*[:—–-]/i.test(line)){ out.push('## ' + line); started = true; inInfo = false; continue; }
    if(TOP.test(line)){ out.push('## ' + line); inInfo = /trip\s*info/i.test(line); continue; }
    // Once inside Trip Info, its subsection titles are ### and their prose is free text.
    if(inInfo && INFOSUB.test(line)){ out.push('### ' + line); continue; }
    if(KEYS.test(line)){ out.push('- ' + line); continue; }
    // A bare line immediately followed by a key:value line is a heading (hotel
    // or stop name) that lost its "###". Inside Trip Info everything is prose.
    if(started && !inInfo && KEYS.test(next)){ out.push('### ' + line); continue; }
    out.push(raw);
  }
  return out.join('\n');
}

/* Parse the markdown trip format. Returns {trip, warnings}. Throws only when
   the text yields nothing usable at all. */
export function parseTrip(text){
  const warnings = [];
  // Unwrap a fenced code block (```…```), then recover any stripped markers.
  let src = String(text || '');
  const fence = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(src);
  if(fence) src = fence[1];
  src = recoverStructure(src);
  text = src;
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
        endLat: cur.endLat ?? null, endLng: cur.endLng ?? null,
        fixedStart: cur.fixedStart || null,
        arriveBy: cur.arriveBy || null,
        done: !!cur.done,
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
      else if(/^(optional|unassigned)/i.test(title)) section = 'optional';   // "Optional" kept as an alias for older files
      else if(/^bin$/i.test(title)) section = 'bin';
      else if(/^(checklist|to-?dos?|to do)$/i.test(title)) section = 'checklist';
      else if(/^trip\s*info/i.test(title) || /^info$/i.test(title)) section = 'info';
      else { warnings.push('Unrecognised section "' + title + '" — skipped.'); section = 'skip'; }
      continue;
    }

    /* Checklist items are plain lines, not headings or key:values — handled
       before everything else so a "###"-looking or colon-bearing item can't be
       mistaken for a stop or a field. "[x]" marks done; a bare line (markers
       stripped by a chat UI) still counts as an open item. */
    if(section === 'checklist'){
      const headM = /^###\s+(.+)$/.exec(line);
      if(headM){
        const htext = headM[1].trim();
        if(htext) trip.checklist.push({ id: 'k' + (trip.checklist.length + 1), text: decVal(htext), type:'header', done:false });
        continue;
      }
      const m = /^[-*]?\s*\[([ xX])\]\s*(.*)$/.exec(line);
      const text = m ? m[2].trim() : line.replace(/^[-*]\s*/, '').trim();
      if(text) trip.checklist.push({ id: 'k' + (trip.checklist.length + 1), text: decVal(text), done: !!(m && m[1].toLowerCase() === 'x') });
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
        if(key === 'lat' || key === 'lng' || key === 'endLat' || key === 'endLng'){ const n = parseFloat(value); if(!isNaN(n)) cur[key] = n; }
        else if(key === 'fixedStart'){ if(/^\d{1,2}:\d{2}$/.test(value)) cur.fixedStart = value; }
        else if(key === 'arriveBy'){ const v = value.toLowerCase(); if(['walk','cycle','transit','taxi','boat'].includes(v)) cur.arriveBy = v; }
        else if(key === 'dur'){ const d = parseDuration(value); if(d != null) cur.dur = d; }
        else if(key === 'cat') cur.cat = normCat(value);
        else if(key === 'done') cur.done = isYes(value);
        else if(key === 'tags') cur.tags = value.split(/[,|]/).map(t => decVal(t.trim())).filter(Boolean);
        else if(key === 'sday' && curOptMeta){ const n = parseInt(value, 10); if(!isNaN(n)) curOptMeta.day = n; }
        else if(key === 'snote' && curOptMeta) curOptMeta.note = decVal(value);
        else if(['img','desc','detail','notes','mode'].includes(key)) cur[key] = decVal(value);
      } else if(section && typeof section === 'object'){
        // day-level metadata; hotel names are held raw and resolved after the
        // whole document is read (the Hotels section may come later)
        const noneOr = v => /^(none|no|-|)$/i.test(v) ? null : v;
        if(key === 'start' && /^\d{1,2}:\d{2}$/.test(value)) section.start = value;
        else if(key === 'hotel') section.__hotelName = noneOr(value);
        else if(key === 'startHotel') section.__startHotelName = noneOr(value);
        else if(key === 'endHotel') section.__endHotelName = noneOr(value);
        else if(key === 'bookend' && ['both','start','end'].includes(value.toLowerCase())) section.__bookend = value.toLowerCase();
        else if(key === 'returnBy'){ const v = value.toLowerCase(); if(['walk','cycle','transit','taxi','boat'].includes(v)) section.returnBy = v; }
        else if(key === 'color' && DAY_COLORS[value.toLowerCase()]) section.color = value.toLowerCase();
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
  // "- hotel: X" is the whole day's base (start AND end); "- start hotel:" /
  // "- end hotel:" set the two ends separately and win over it. The legacy
  // "- hotel bookend:" line narrows a "- hotel:" line to one end, so files
  // written before start/end hotels existed import unchanged.
  trip.days.forEach(d => {
    const warned = new Set();
    const resolve = name => {
      if(!name) return null;
      const h = trip.hotels.find(h => h.name.toLowerCase() === name.toLowerCase());
      if(!h && !warned.has(name.toLowerCase())){
        warned.add(name.toLowerCase());
        warnings.push('Day ' + d.id + ' names hotel "' + name + '" which is not in the Hotels section.');
      }
      return h ? h.id : null;
    };
    const bookend = d.__bookend || 'both';
    d.startHotelId = resolve(('__startHotelName' in d) ? d.__startHotelName : (bookend !== 'end' ? d.__hotelName : null));
    d.endHotelId = resolve(('__endHotelName' in d) ? d.__endHotelName : (bookend !== 'start' ? d.__hotelName : null));
    delete d.__hotelName; delete d.__startHotelName; delete d.__endHotelName; delete d.__bookend;
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
   name, day, lat, lng, category, duration, description, detail, image, notes, tags, done.
   day may be a number, "unassigned"/"optional", or empty (→ day 1). */
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
    done: ['done','visited','completed'].map(col).find(i => i !== -1) ?? -1,
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
      done: idx.done !== -1 && !!get(cells, idx.done) && isYes(get(cells, idx.done)),
      tags: get(cells, idx.tags) ? get(cells, idx.tags).split(/[,|]/).map(t => t.trim()).filter(Boolean) : []
    };
    const dayRaw = get(cells, idx.day).toLowerCase();
    if(dayRaw === 'unassigned' || dayRaw === 'optional' || dayRaw === 'pool'){
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
  let t = String(text || '').trim();
  if(!t) throw new Error('Nothing to import.');
  // Unwrap a fenced code block up front so sniffing sees the real content.
  const fence = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(t);
  if(fence) t = fence[1].trim();
  const firstLines = t.split(/\r?\n/, 5);
  // Trip/Day markers (with or without their "#") are the strongest signal.
  const looksTrip = /^#{0,3}\s*(Trip|Day\s+\d+)\s*:/im.test(t);
  const looksMd = looksTrip || /^#/.test(t) || t.includes('\n#') ||
    firstLines.some(l => /^[-*]?\s*\w[\w ]*:\s/.test(l) && !l.includes(','));
  const looksCsv = firstLines[0] && firstLines[0].split(',').length >= 2 && /name/i.test(firstLines[0]) && !looksTrip;
  if(looksCsv && !/^#/.test(t)) return parseCsv(t);
  if(looksMd) return parseTrip(t);
  return parseCsv(t); // last resort; throws a helpful error if it isn't CSV either
}

/* Sanity-check a trip object that arrived from Firestore or storage. */
export function isValidTrip(t){
  return !!(t && typeof t === 'object' && Array.isArray(t.days) && t.days.length &&
    t.stops && typeof t.stops === 'object' && Array.isArray(t.bin) && Array.isArray(t.hotels));
}
