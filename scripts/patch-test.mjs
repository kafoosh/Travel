#!/usr/bin/env node
/* Change-list ("# Trip Changes") checks. Run: node scripts/patch-test.mjs */

globalThis.localStorage = {
  _m: new Map(),
  getItem(k){ return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v){ this._m.set(k, String(v)); },
  removeItem(k){ this._m.delete(k); },
};

const { parseTrip, serializeTrip } = await import('../js/format.js');
const { isPatchText, parsePatch, applyPatch } = await import('../js/patch.js');
const { normalizeTrip } = await import('../js/state.js');
const { readFileSync } = await import('node:fs');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, ok, extra){
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''));
  if(!ok) failures++;
}

const md = readFileSync(join(here, '..', 'demo', 'rome-venice-trip.md'), 'utf8');
const base = normalizeTrip(parseTrip(md).trip);
const byName = (t, n) => Object.values(t.stops).find(s => s.name === n);
const dayOfId = (t, id) => t.days.findIndex(d => d.order.includes(id)) + 1;

/* --- refs in the serialized document --- */
console.log('refs:');
const withRefs = serializeTrip(base, { refs: true });
const colo = byName(base, 'Colosseum');
check('stops carry {id}', withRefs.includes('### Colosseum {' + colo.id + '}'));
check('hotels carry {id}', withRefs.includes('{h1}'));
check('a document with refs parses to the same trip',
  JSON.stringify(parseTrip(withRefs).trip) === JSON.stringify(parseTrip(serializeTrip(base)).trip));
check('plain export carries no refs', !/\{s\d+\}/.test(serializeTrip(base)));

/* --- detection --- */
console.log('detection:');
check('fenced change list detected', isPatchText('Sure:\n```\n# Trip Changes\n## Remove {s1}\n```'));
check('whole trip is not a change list', !isPatchText(md));

/* --- every operation --- */
console.log('operations:');
const d2 = base.days[1], d3 = base.days[2];
const [a, b, c] = d2.order;
const d3first = d3.order[0];
const optFirst = base.optional[0].id;
const patch = `Here are the changes:

\`\`\`
# Trip Changes: Rome & Venice

## Add to Day 2 after {${a}}
### Gelateria del Teatro
- lat: 41.9012
- lng: 12.4699
- category: food
- duration: 30
- description: Superb gelato.

## Edit {${colo.id}}
- duration: 120
- fixed start: 09:30
- name: The Colosseum

## Move {${c}} to Day 3 at start
## Move {${optFirst}} to Day 3 after {${d3first}}
## Remove {${b}}

## Edit Day 3
- start: 08:15
- color: teal

## Add Day after Day 4: Day trip to Tivoli
- start: 08:30
### Villa d'Este
- lat: 41.9637
- lng: 12.7963
- category: park
- duration: 150

## Remove Day 10

## Add Hotel
### Hotel Nuovo
- lat: 45.43
- lng: 12.33
- transport: walk

## Edit Day 9
- hotel: Hotel Nuovo

## Add to Unassigned
### Rainy day museum
- lat: 41.9
- lng: 12.5
- category: museum
- group: Rainy day

## Add to Checklist
- [ ] Buy Tivoli tickets

## Add to Info: Closures
- Villa d'Este — closed Mondays

## Edit {nonexistent}
- duration: 5
\`\`\`
`;
const { ops } = parsePatch(patch);
check('14 operations parsed', ops.length === 14, String(ops.length));
const { trip: out, summary, warnings } = applyPatch(base, ops);
check('live trip untouched', base.days.length === 10 && !byName(base, 'Gelateria del Teatro'));
const gel = byName(out, 'Gelateria del Teatro');
check('added after anchor on Day 2', gel && out.days[1].order.indexOf(gel.id) === out.days[1].order.indexOf(a) + 1);
check('new stop got a fresh id', gel && !base.stops[gel.id]);
const colo2 = out.stops[colo.id];
check('edit: renamed, duration, fixed start; untouched fields kept',
  colo2.name === 'The Colosseum' && colo2.dur === 120 && colo2.fixedStart === '09:30' && colo2.desc === colo.desc);
check('move to start of Day 3', out.days[2].order[0] === c);
check('unassigned moved onto Day 3 after anchor',
  out.days[2].order.indexOf(optFirst) === out.days[2].order.indexOf(d3first) + 1 && !out.optional.some(o => o.id === optFirst));
check('remove → Bin', out.bin.includes(b) && !out.days.some(d => d.order.includes(b)));
check('Day 3 edited', out.days[2].start === '08:15' && out.days[2].color === 'teal');
check('day added after original Day 4', out.days[4].title === 'Day trip to Tivoli' && out.stops[out.days[4].order[0]].name === "Villa d'Este");
check('new day inherits the night before\'s hotel', out.days[4].startHotelId === out.days[3].endHotelId);
check('original Day 10 removed, its stops binned', out.days.length === 10 && base.days[9].order.every(id => out.bin.includes(id)));
const nuovo = out.hotels.find(h => h.name === 'Hotel Nuovo');
check('hotel added and referenced by an earlier-written day line (original Day 9 is now day 10)',
  nuovo && out.days[9].startHotelId === nuovo.id && out.days[9].endHotelId === nuovo.id);
const rainy = byName(out, 'Rainy day museum');
check('unassigned with a new group', rainy && out.optionalGroups.some(g => g.title === 'Rainy day' &&
  out.optional.find(o => o.id === rainy.id).group === g.id));
check('checklist item added', out.checklist.some(k => k.text === 'Buy Tivoli tickets' && !k.done));
check('info appended', out.info.closures.endsWith("- Villa d'Este — closed Mondays") && out.info.closures.startsWith(base.info.closures.trim().slice(0, 20)));
check('bad ref warned, not fatal', warnings.length === 1 && /nonexistent/.test(warnings[0]), warnings.join(' | '));
check('summary', summary.includes('3 stops added') && summary.includes('1 day removed'), summary.join(', '));
check('result normalises and re-serialises', (() => {
  const n = normalizeTrip(out);
  return parseTrip(serializeTrip(n)).trip.days.length === 10;
})());

/* --- reorder, name refs, day moves --- */
console.log('reorder / names / day moves:');
const d1 = base.days[1].order;
const rev = applyPatch(base, parsePatch(`# Trip Changes
## Reorder Day 2: ${[...d1].reverse().map(id => '{' + id + '}').join(' ')}
## Move Day 1 after Day 3
## Edit {Colosseum}
- duration: 99
`).ops).trip;
check('reorder', JSON.stringify(rev.days.find(d => d.title === base.days[1].title).order) === JSON.stringify([...d1].reverse()));
check('move day', rev.days[2].title === base.days[0].title && rev.days[0].title === base.days[1].title);
check('name in braces works as a ref', rev.stops[colo.id].dur === 99);

/* --- meal options --- */
console.log('meal options:');
{
  const { optionsOf } = await import('../js/format.js');
  const food = Object.values(base.stops).find(s => s.cat === 'food');
  const r = applyPatch(base, parsePatch(`# Trip Changes
## Add Options to {${food.id}}
### Trattoria Uno
- lat: 41.9
- lng: 12.47
- description: Cheap and cheerful.
### Trattoria Due
- lat: 41.91
- lng: 12.48
## Edit Option {${food.id}}: Trattoria Uno
- duration: 45
## Choose Option {${food.id}}: Trattoria Due
## Remove Option {${food.id}}: {Trattoria Uno}
## Add to Day 3 at end
### Dinner — Uno
- lat: 41.9
- lng: 12.5
- category: food
#### Option: Dinner — Due
- lat: 41.8
- lng: 12.5
`).ops);
  const f2 = r.trip.stops[food.id];
  check('options added, edited, chosen, removed', f2.name === 'Trattoria Due'
    && JSON.stringify(optionsOf(f2).map(o => o.name)) === JSON.stringify(['Trattoria Due', food.name]), r.warnings.join('; '));
  const r2 = applyPatch(r.trip, parsePatch(`# Trip Changes\n## Edit Option {${food.id}}: ${food.name}\n- duration: 35`).ops);
  check('an unchosen option edits in place', optionsOf(r2.trip.stops[food.id])[1].dur === 35 && r2.trip.stops[food.id].name === 'Trattoria Due');
  check('the slot keeps its day', dayOfId(r.trip, food.id) === dayOfId(base, food.id));
  const dinner = byName(r.trip, 'Dinner — Uno');
  check('a new stop can arrive with options', dinner && dinner.alts && dinner.alts[0].name === 'Dinner — Due');
  check('option ops are tallied', r.summary.includes('2 options added') && r.summary.includes('1 option chosen'));
  check('the live trip is untouched', !base.stops[food.id].alts);
  const bad = applyPatch(base, parsePatch(`# Trip Changes\n## Choose Option {${food.id}}: Nowhere\n## Edit {${food.id}}\n- duration: 61`).ops);
  check('an unknown option warns, the rest applies', bad.warnings.length === 1 && bad.trip.stops[food.id].dur === 61);
}

/* --- nothing applicable --- */
let threw = false;
try{ applyPatch(base, parsePatch('# Trip Changes\n## Remove {zzz}').ops); } catch(e){ threw = true; }
check('a list where nothing applies throws', threw);

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall checks passed');
process.exit(failures ? 1 : 0);
