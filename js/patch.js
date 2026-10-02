/* =========================================================
   CHANGE LISTS ("# Trip Changes")

   The token-light way back from an AI edit. Instead of the
   whole trip, the assistant returns only the operations —
   add / edit / move / remove — aimed at the "{id}" references
   serializeTrip({refs:true}) writes into the edit prompt:

     # Trip Changes
     ## Add to Day 3 after {s14}
     ### Gelateria del Teatro
     - lat: 41.9012
     …
     ## Edit {s12}
     - duration: 120
     ## Move {s7} to Day 2 after {s3}
     ## Remove {s9}

   Fields inside an operation are the same "- key: value"
   lines as the trip format, read by the same helpers in
   format.js. Day numbers always mean the numbering of the
   document the AI was given, however many days the list adds,
   removes or moves before it gets there. applyPatch works on
   a copy and returns it, so a list that half-fails never
   leaves the live trip half-changed; the caller swaps the
   copy in behind one Undo.
   ========================================================= */

import { kvLine, applyStopKv, buildStop, splitRef, isYes, decVal, newDay,
         readStopLines, optionHeading, optionsOf, chooseOption, addOption, removeOption,
         findOption, chosenOptionIndex, OPTION_FIELDS, INFO_KEYS, DAY_COLORS, THEMES } from './format.js';

const FENCE = /```[a-zA-Z]*\n([\s\S]*?)```/;
const MODES = ['walk','cycle','transit','taxi','boat'];
const NONE = /^(none|null|no|-|remove|clear|)$/i;

function unfence(text){
  const src = String(text || '');
  const m = FENCE.exec(src);
  return (m ? m[1] : src).replace(/\r/g, '');
}

/* Is this pasted text a change list rather than a whole trip? */
export function isPatchText(text){
  const first = unfence(text).split('\n').find(l => l.trim());
  return !!first && /^#?\s*Trip\s+Changes\b/i.test(first.trim());
}

/* Every {ref} in a heading. Braces may hold an id ({s12}) or, for a stop the
   AI added in an earlier change list and so never saw an id for, its exact
   name ({Gelateria del Teatro}). */
function refsIn(s){ return [...String(s).matchAll(/\{([^{}]+)\}/g)].map(m => m[1].trim()); }

/* "after {s3}" / "before {s3}" / "at start" / "at end" anywhere in a heading. */
function positionIn(s){
  const anchor = /\b(after|before)\s*\{([^{}]+)\}/i.exec(s);
  if(anchor) return { kind: anchor[1].toLowerCase(), ref: anchor[2].trim(), text: s.replace(anchor[0], ' ') };
  if(/\b(?:at|to)\s+(?:the\s+)?(?:start|top|beginning|front)\b/i.test(s)) return { kind:'start', text: s };
  return { kind:'end', text: s };
}

/* ---------- parsing ---------- */

/* Split the text into operations: one per "## " heading, each with its body
   lines. Returns {ops, warnings}; throws when there is nothing to apply. */
export function parsePatch(text){
  const lines = unfence(text).split('\n');
  const ops = [];
  let cur = null;
  for(const raw of lines){
    const line = raw.replace(/\s+$/, '');
    if(/^#\s/.test(line) && !cur) continue;               // "# Trip Changes: …"
    const h2 = /^##\s+(.+)$/.exec(line);
    if(h2){ cur = { head: h2[1].trim(), body: [] }; ops.push(cur); continue; }
    if(cur) cur.body.push(line);
  }
  if(!ops.length) throw new Error('That change list has no "## " operations in it — nothing to apply.');
  return { ops, warnings: [] };
}

/* A body's "### " blocks: [{name, lines}], plus any lines before the first. */
function blocksOf(body){
  const pre = [], blocks = [];
  let b = null;
  for(const line of body){
    const h3 = /^###\s+(.+)$/.exec(line);
    if(h3){ b = { name: splitRef(h3[1]).name, lines: [] }; blocks.push(b); continue; }
    (b ? b.lines : pre).push(line);
  }
  return { pre, blocks };
}

/* "- name: X" / "- title: X" aren't trip-format keys, so read them here. */
function kv(line){
  const own = /^\s*[-*]?\s*(name|title|rename)\s*:\s*(.*)$/i.exec(line);
  if(own) return { key: own[1].toLowerCase() === 'title' ? 'title' : 'name', value: own[2].trim() };
  return kvLine(line);
}

/* ---------- applying ---------- */

export function applyPatch(liveTrip, ops){
  const trip = JSON.parse(JSON.stringify(liveTrip));
  const warnings = [];
  // tally: "noun|verb" → n, read back as "2 stops added" / "1 day removed".
  const tally = {};
  const count = (noun, verb, n = 1) => { const k = noun + '|' + verb; tally[k] = (tally[k] || 0) + n; };
  const warn = (op, msg) => warnings.push('“## ' + op.head + '” — ' + msg);

  trip.optional = trip.optional || [];
  trip.optionalGroups = trip.optionalGroups || [];
  trip.bin = trip.bin || [];
  trip.checklist = trip.checklist || [];
  trip.info = trip.info || {};
  // Day numbers in the list mean the document the AI saw.
  const origDays = trip.days.slice();

  /* --- lookups --- */
  const dayByNum = (op, n) => {
    const d = origDays[n - 1];
    if(!d){ warn(op, 'there is no Day ' + n + '.'); return null; }
    if(!trip.days.includes(d)){ warn(op, 'Day ' + n + ' was removed earlier in the list.'); return null; }
    return d;
  };
  const findStop = ref => {
    if(Object.hasOwn(trip.stops, ref)) return ref;
    const named = Object.values(trip.stops).filter(s => s.name.toLowerCase() === ref.toLowerCase());
    return named.length === 1 ? named[0].id : null;
  };
  const findHotel = ref => trip.hotels.find(h => h.id === ref)
    || trip.hotels.find(h => h.name.toLowerCase() === ref.toLowerCase()) || null;
  const findCheck = ref => trip.checklist.find(c => c.id === ref) || null;
  const resolveHotel = (op, v) => {
    if(NONE.test(v.trim())) return null;
    const r = refsIn(v)[0] || v.trim();
    const h = findHotel(r);
    if(!h){ warn(op, 'no hotel called "' + r + '" — that hotel line was skipped.'); return undefined; }
    return h.id;
  };

  /* --- stop placement --- */
  const dayOf = id => trip.days.find(d => d.order.includes(id)) || null;
  const detach = id => {
    trip.days.forEach(d => { d.order = d.order.filter(x => x !== id); });
    trip.optional = trip.optional.filter(o => o.id !== id);
    trip.bin = trip.bin.filter(x => x !== id);
  };
  const insert = (op, day, ids, pos) => {
    let idx = day.order.length;
    if(pos.kind === 'start') idx = 0;
    else if(pos.kind === 'after' || pos.kind === 'before'){
      const a = findStop(pos.ref);
      const at = a ? day.order.indexOf(a) : -1;
      if(at === -1) warn(op, '{' + pos.ref + '} is not on that day — placed at the end instead.');
      else idx = pos.kind === 'after' ? at + 1 : at;
    }
    day.order.splice(idx, 0, ...ids);
  };
  const groupId = title => {
    const t = title.trim();
    let g = trip.optionalGroups.find(x => x.title.toLowerCase() === t.toLowerCase());
    if(!g){
      let n = trip.optionalGroups.length + 1;
      while(trip.optionalGroups.some(x => x.id === 'g' + n)) n++;
      g = { id: 'g' + n, title: t, collapsed: false };
      trip.optionalGroups.push(g);
    }
    return g.id;
  };
  const toUnassigned = (id, meta = {}) => {
    trip.optional.push({ id, day: meta.day || null, note: meta.note || '', group: meta.group ? groupId(meta.group) : null });
  };
  const newStopId = () => {
    let id;
    do { trip.counter = (trip.counter || 0) + 1; id = 'u' + trip.counter; } while(Object.hasOwn(trip.stops, id));
    return id;
  };
  /* "### " blocks → new stop ids (already in trip.stops), with their
     unassigned-only fields alongside. */
  const makeStops = (op, blocks) => blocks.map(b => {
    const meta = {};
    const cur = readStopLines({ name: b.name }, meta, b.lines);
    if(cur.lat == null || cur.lng == null) warn(op, '"' + b.name + '" has no coordinates — it will not appear on the map.');
    const id = newStopId();
    trip.stops[id] = buildStop(id, cur);
    count('stop', 'added');
    return { id, meta };
  });

  /* --- day fields --- */
  const applyDayLines = (op, day, lines) => {
    lines.forEach(l => {
      const p = kv(l);
      if(!p) return;
      const { key, value } = p;
      if(key === 'title' || key === 'name') day.title = decVal(value);
      else if(key === 'start'){ if(/^\d{1,2}:\d{2}$/.test(value)) day.start = value; }
      else if(key === 'hotel'){ const h = resolveHotel(op, value); if(h !== undefined){ day.startHotelId = h; day.endHotelId = h; } }
      else if(key === 'startHotel'){ const h = resolveHotel(op, value); if(h !== undefined) day.startHotelId = h; }
      else if(key === 'endHotel'){ const h = resolveHotel(op, value); if(h !== undefined) day.endHotelId = h; }
      else if(key === 'returnBy'){ const v = value.toLowerCase(); day.returnBy = MODES.includes(v) ? v : null; }
      else if(key === 'color'){ const v = value.toLowerCase(); day.color = DAY_COLORS[v] ? v : null; }
      else if(key === 'hideStart') day.hideStart = isYes(value);
      else if(key === 'hideEnd') day.hideEnd = isYes(value);
      else if(key === 'pinned'){
        const on = isYes(value);
        if(on) trip.days.forEach(d => { d.pinned = false; });
        day.pinned = on;
      }
    });
  };

  /* --- meal options --- */
  // "## <verb> Option {s12}: <place>" — the stop is the first {ref}; the place
  // is the text after the colon, or a second {ref} holding its name.
  const optionTarget = (op, rest) => {
    const refs = refsIn(rest);
    const id = refs.length ? findStop(refs[0]) : null;
    if(!id){ warn(op, refs.length ? 'no stop {' + refs[0] + '}.' : 'no {ref} for the stop.'); return null; }
    const after = rest.replace(/\{[^{}]*\}/, '');
    const name = refs[1] || (/[:—–]\s*(.+)$/.exec(after) || [])[1] || '';
    return { stop: trip.stops[id], name: name.trim() };
  };
  const optionAt = (op, t) => {
    if(!t.name){ warn(op, 'which option? Name it after a colon.'); return -1; }
    const i = findOption(t.stop, t.name);
    if(i === -1) warn(op, '"' + t.stop.name + '" has no option called "' + t.name + '".');
    return i;
  };

  /* --- the operations --- */
  const handlers = [
    // Add Option(s) to {s12} — "###" or "####" blocks, each one place
    [/^add\s+(?:an?\s+)?(?:options?|alternatives?)\s+(?:to|for)\s+(.+)$/i, (op, m) => {
      const t = optionTarget(op, m[1]);
      if(!t) return;
      const blocks = [];
      op.body.forEach(l => {
        const h = /^###\s+(.+)$/.exec(l);
        const name = h ? splitRef(h[1]).name : optionHeading(l);
        if(name){ blocks.push({ name, lines: [] }); return; }
        if(blocks.length) blocks[blocks.length - 1].lines.push(l);
      });
      if(!blocks.length){ warn(op, 'no "### " places under it.'); return; }
      blocks.forEach(b => {
        const cur = readStopLines({ name: b.name }, null, b.lines);
        if(cur.lat == null || cur.lng == null) warn(op, '"' + b.name + '" has no coordinates — it will not appear on the map.');
        addOption(t.stop, cur);
        count('option', 'added');
      });
    }],

    // Edit / Remove / Choose Option {s12}: <place>
    [/^(edit|change|update|remove|delete|drop|choose|pick|select|show|use)\s+(?:the\s+)?(?:option|alternative)\s+(.+)$/i, (op, m) => {
      const t = optionTarget(op, m[2]);
      if(!t) return;
      const i = optionAt(op, t);
      if(i === -1) return;
      const verb = m[1].toLowerCase();
      if(/^(remove|delete|drop)$/.test(verb)){
        if(removeOption(t.stop, i)) count('option', 'removed');
        else warn(op, 'a stop keeps at least one place — use "## Remove {ref}" to drop the stop.');
      } else if(/^(edit|change|update)$/.test(verb)){
        const fields = {};
        op.body.forEach(l => {
          const p = kv(l);
          if(!p) return;
          if(p.key === 'name' || p.key === 'title'){ if(p.value) fields.name = decVal(p.value); return; }
          if(p.key === 'tags' && NONE.test(p.value)){ fields.tags = []; return; }
          applyStopKv(fields, null, p.key, p.value);
        });
        const target = i === chosenOptionIndex(t.stop) ? t.stop : optionsOf(t.stop)[i];
        OPTION_FIELDS.forEach(k => { if(k in fields) target[k] = fields[k]; });
        if(target !== t.stop){
          const alts = optionsOf(t.stop);
          alts[i] = target;
          t.stop.alts = alts.filter((_, j) => j !== chosenOptionIndex(t.stop));
        }
        count('option', 'edited');
      } else {
        chooseOption(t.stop, i);
        count('option', 'chosen');
      }
    }],


    // Edit Trip
    [/^edit\s+(?:the\s+)?trip\b/i, op => {
      op.body.forEach(l => {
        const p = kv(l);
        if(!p) return;
        if(p.key === 'name' || p.key === 'title') trip.name = decVal(p.value) || trip.name;
        else if(p.key === 'subtitle') trip.subtitle = decVal(p.value);
        else if(p.key === 'startDate'){
          if(NONE.test(p.value)) trip.startDate = null;
          else if(/^\d{4}-\d{2}-\d{2}$/.test(p.value)) trip.startDate = p.value;
        }
        else if(p.key === 'theme' && THEMES.includes(p.value.toLowerCase())) trip.theme = p.value.toLowerCase();
        else if(p.key === 'days') warn(op, 'the day count follows the days themselves — use "Add Day" / "Remove Day".');
      });
      count('trip detail', 'edited');
    }],

    // Add Hotel(s)
    [/^add\s+hotels?\b/i, op => {
      blocksOf(op.body).blocks.forEach(b => {
        const cur = { name: b.name };
        b.lines.forEach(l => { const p = kvLine(l); if(p) applyStopKv(cur, null, p.key, p.value); });
        let n = 1;
        while(trip.hotels.some(h => h.id === 'h' + n)) n++;
        trip.hotels.push({ id: 'h' + n, name: b.name, lat: cur.lat ?? null, lng: cur.lng ?? null,
          mode: cur.mode === 'boat' ? 'boat' : 'walk', img: cur.img || '', desc: cur.desc || '' });
        count('hotel', 'added');
      });
    }],

    // Edit Day N
    [/^edit\s+day\s+(\d+)\b/i, (op, m) => {
      const day = dayByNum(op, Number(m[1]));
      if(!day) return;
      applyDayLines(op, day, op.body);
      count('day', 'edited');
    }],

    // Add Day after Day N / before Day N / at start / at end [: title]
    [/^add\s+(?:a\s+)?(?:new\s+)?day\b(.*)$/i, (op, m) => {
      const rest = m[1];
      const [where, ...titleParts] = rest.split(/\s*[:—–]\s*/);
      const title = titleParts.join(': ').trim();
      let idx = trip.days.length;
      const rel = /\b(after|before)\s+day\s+(\d+)/i.exec(where);
      if(rel){
        const anchor = dayByNum(op, Number(rel[2]));
        if(anchor){
          idx = trip.days.indexOf(anchor) + (rel[1].toLowerCase() === 'after' ? 1 : 0);
        }
      } else if(/\b(start|beginning|front)\b/i.test(where)) idx = 0;
      const day = newDay(idx + 1);
      day.title = title || '';
      // Until told otherwise, a new day sleeps where the day before it did.
      const prev = trip.days[idx - 1];
      if(prev){ day.startHotelId = prev.endHotelId; day.endHotelId = prev.endHotelId; }
      trip.days.splice(idx, 0, day);
      const { pre, blocks } = blocksOf(op.body);
      applyDayLines(op, day, pre);
      makeStops(op, blocks).forEach(({ id }) => day.order.push(id));
      count('day', 'added');
    }],

    // Move Day N after/before Day M, to start/end
    [/^move\s+day\s+(\d+)\b(.*)$/i, (op, m) => {
      const day = dayByNum(op, Number(m[1]));
      if(!day) return;
      const rel = /\b(after|before)\s+day\s+(\d+)/i.exec(m[2]);
      let anchor = null;
      if(rel){ anchor = dayByNum(op, Number(rel[2])); if(!anchor || anchor === day) return; }
      trip.days.splice(trip.days.indexOf(day), 1);
      let idx;
      if(anchor) idx = trip.days.indexOf(anchor) + (rel[1].toLowerCase() === 'after' ? 1 : 0);
      else if(/\b(start|beginning|front)\b/i.test(m[2])) idx = 0;
      else idx = trip.days.length;
      trip.days.splice(idx, 0, day);
      count('day', 'moved');
    }],

    // Remove Day N[, M…]
    [/^(?:remove|delete)\s+days?\s+(.+)$/i, (op, m) => {
      const nums = [...m[1].matchAll(/\d+/g)].map(x => Number(x[0]));
      nums.forEach(n => {
        const day = dayByNum(op, n);
        if(!day) return;
        if(trip.days.length === 1){ warn(op, 'a trip needs at least one day.'); return; }
        day.order.forEach(id => { if(!trip.bin.includes(id)) trip.bin.push(id); });
        if(day.order.length) count('stop', 'removed', day.order.length);
        trip.days.splice(trip.days.indexOf(day), 1);
        count('day', 'removed');
      });
    }],

    // Reorder Day N: {a} {b} …
    [/^reorder\s+day\s+(\d+)\b/i, (op, m) => {
      const day = dayByNum(op, Number(m[1]));
      if(!day) return;
      const wanted = [...refsIn(op.head), ...op.body.flatMap(refsIn)].map(r => {
        const id = findStop(r);
        if(!id || !day.order.includes(id)){ warn(op, '{' + r + '} is not on Day ' + m[1] + ' — ignored.'); return null; }
        return id;
      }).filter(Boolean);
      const seen = new Set(wanted);
      const rest = day.order.filter(id => !seen.has(id));
      if(rest.length) warn(op, rest.length + ' stop(s) not listed were kept at the end of the day.');
      day.order = [...new Set(wanted), ...rest];
      count('day', 'reordered');
    }],

    // Add to Checklist
    [/^add\s+(?:to\s+)?(?:the\s+)?(?:checklist|to-?dos?)\b/i, op => {
      op.body.forEach(l => {
        const head = /^###\s+(.+)$/.exec(l);
        const item = /^\s*[-*]?\s*\[([ xX])\]\s*(.*)$/.exec(l);
        const text = head ? splitRef(head[1]).name : item ? splitRef(item[2]).name : splitRef(l.replace(/^\s*[-*]\s*/, '')).name;
        if(!text) return;
        let n = 1;
        while(trip.checklist.some(c => c.id === 'k' + n)) n++;
        trip.checklist.push(head ? { id: 'k' + n, text: decVal(text), type: 'header', done: false }
          : { id: 'k' + n, text: decVal(text), done: !!(item && item[1].toLowerCase() === 'x') });
        count('checklist item', 'added');
      });
    }],

    // Replace Info: X / Add to Info: X
    [/^(replace|rewrite|set|append|add\s+to|extend)\s+(?:the\s+)?(?:trip\s+)?info\s*[:/—–-]?\s*(.+)$/i, (op, m) => {
      const key = INFO_KEYS[m[2].replace(/^#+\s*/, '').trim().toLowerCase()];
      if(!key){ warn(op, 'unknown Trip Info section — use Weather, Closures, Reservations, Events or Notes.'); return; }
      const text = op.body.join('\n').trim();
      const replace = /^(replace|rewrite|set)/i.test(m[1]);
      trip.info[key] = replace ? text : [String(trip.info[key] || '').trim(), text].filter(Boolean).join('\n');
      count('Trip Info section', 'updated');
    }],

    // Add to Day N [position] / Add to Unassigned
    [/^add\s+(?:stops?\s+)?(?:to|on)\s+(.+)$/i, (op, m) => {
      const target = m[1];
      const { blocks } = blocksOf(op.body);
      if(!blocks.length){ warn(op, 'no "### " stops under it.'); return; }
      if(/^(unassigned|optional)/i.test(target)){
        makeStops(op, blocks).forEach(({ id, meta }) => toUnassigned(id, meta));
        return;
      }
      const dm = /^day\s+(\d+)/i.exec(target);
      if(!dm){ warn(op, 'expected "Add to Day N" or "Add to Unassigned".'); return; }
      const day = dayByNum(op, Number(dm[1]));
      if(!day) return;
      insert(op, day, makeStops(op, blocks).map(s => s.id), positionIn(target));
    }],

    // Move {refs} [to Day N | to Unassigned] [after/before {ref} | at start/end]
    [/^move\s+(.+)$/i, (op, m) => {
      const pos = positionIn(m[1]);
      const toUn = /\bto\s+(?:the\s+)?(unassigned|optional)/i.test(pos.text);
      const dm = /\bto\s+day\s+(\d+)/i.exec(pos.text);
      const ids = refsIn(pos.text).map(r => {
        const id = findStop(r);
        if(!id) warn(op, 'no stop {' + r + '}.');
        return id;
      }).filter(Boolean);
      if(!ids.length) return;
      if(toUn){
        ids.forEach(id => { detach(id); toUnassigned(id); });
        count('stop', 'moved', ids.length);
        return;
      }
      let day = null;
      if(dm) day = dayByNum(op, Number(dm[1]));
      else if(pos.ref){ const a = findStop(pos.ref); day = a ? dayOf(a) : null; }
      else if(ids.length) day = dayOf(ids[0]);
      if(!day){ if(!dm) warn(op, 'could not tell which day to move to.'); return; }
      ids.forEach(detach);
      insert(op, day, ids, pos);
      count('stop', 'moved', ids.length);
    }],

    // Remove {refs}
    [/^(?:remove|delete|drop)\s+(.+)$/i, (op, m) => {
      const refs = refsIn(m[1]);
      if(!refs.length){ warn(op, 'no {ref} to remove.'); return; }
      refs.forEach(r => {
        const id = findStop(r);
        if(id){
          detach(id);
          trip.bin.push(id);
          count('stop', 'removed');
          return;
        }
        const h = findHotel(r);
        if(h){
          trip.hotels = trip.hotels.filter(x => x !== h);
          trip.days.forEach(d => {
            if(d.startHotelId === h.id) d.startHotelId = null;
            if(d.endHotelId === h.id) d.endHotelId = null;
          });
          count('hotel', 'removed');
          return;
        }
        const c = findCheck(r);
        if(c){ trip.checklist = trip.checklist.filter(x => x !== c); count('checklist item', 'removed'); return; }
        warn(op, 'nothing called {' + r + '}.');
      });
    }],

    // Edit {ref} — a stop, a hotel or a checklist item
    [/^edit\s+(.+)$/i, (op, m) => {
      const r = refsIn(m[1])[0];
      if(!r){ warn(op, 'no {ref} to edit.'); return; }
      const id = findStop(r);
      if(id){ editStop(op, trip.stops[id]); count('stop', 'edited'); return; }
      const h = findHotel(r);
      if(h){ editHotel(op, h); count('hotel', 'edited'); return; }
      const c = findCheck(r);
      if(c){
        const line = op.body.find(l => l.trim());
        if(line){
          const item = /^\s*[-*]?\s*\[([ xX])\]\s*(.*)$/.exec(line);
          const text = splitRef(item ? item[2] : line.replace(/^\s*[-*]\s*/, '')).name;
          if(text) c.text = decVal(text);
          if(item && c.type !== 'header') c.done = item[1].toLowerCase() === 'x';
        }
        count('checklist item', 'edited');
        return;
      }
      warn(op, 'nothing called {' + r + '}.');
    }],
  ];

  function editStop(op, stop){
    const fields = {}, meta = {};
    op.body.forEach(l => {
      const p = kv(l);
      if(!p) return;
      const { key, value } = p;
      if(key === 'name' || key === 'title'){ if(value) stop.name = decVal(value); return; }
      if(key === 'tags' && NONE.test(value)){ stop.tags = []; return; }
      if(NONE.test(value) && ['fixedStart','arriveBy'].includes(key)){ stop[key] = null; return; }
      if(NONE.test(value) && (key === 'endLat' || key === 'endLng')){ stop.endLat = null; stop.endLng = null; return; }
      applyStopKv(fields, meta, key, value);
    });
    delete fields.mode;                              // a hotel field, not a stop's
    Object.assign(stop, fields);
    const opt = trip.optional.find(o => o.id === stop.id);
    if(opt){
      if('day' in meta) opt.day = meta.day;
      if('note' in meta) opt.note = meta.note;
      if('group' in meta) opt.group = groupId(meta.group);
    }
  }

  function editHotel(op, h){
    const fields = {};
    op.body.forEach(l => {
      const p = kv(l);
      if(!p) return;
      if(p.key === 'name' || p.key === 'title'){ if(p.value) h.name = decVal(p.value); return; }
      applyStopKv(fields, null, p.key, p.value);
    });
    ['lat','lng','img','desc'].forEach(k => { if(k in fields) h[k] = fields[k]; });
    if('mode' in fields) h.mode = String(fields.mode).toLowerCase() === 'boat' ? 'boat' : 'walk';
  }

  // Hotels first, so a day line further down can name a hotel the same list
  // adds or renames — wherever in the list the AI happened to put it.
  const isHotelOp = op => /^add\s+hotels?\b/i.test(op.head)
    || (/^edit\s+/i.test(op.head) && refsIn(op.head).some(r => trip.hotels.some(h => h.id === r)));
  const ordered = [...ops.filter(isHotelOp), ...ops.filter(op => !isHotelOp(op))];

  ordered.forEach(op => {
    for(const [re, fn] of handlers){
      const m = re.exec(op.head);
      if(m){ fn(op, m); return; }
    }
    warn(op, 'not an operation the planner knows — skipped.');
  });

  trip.days.forEach((d, i) => {
    d.id = i + 1;
    if(!d.title) d.title = 'Day ' + (i + 1);
  });

  const summary = Object.entries(tally).map(([k, n]) => {
    const [noun, verb] = k.split('|');
    return n + ' ' + noun + (n === 1 ? '' : 's') + ' ' + verb;
  });
  if(!summary.length) throw new Error(warnings.length
    ? 'None of the changes could be applied. ' + warnings.slice(0, 4).join(' ')
    : 'That change list has nothing in it to apply.');
  return { trip, summary, warnings };
}
