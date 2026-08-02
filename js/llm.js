/* =========================================================
   LLM PROMPT BUILDER
   Generates a copy-paste prompt that instructs any LLM to
   produce a trip in exactly the markdown format importText()
   understands. Two modes:
   - 'new':  plan a trip from scratch (embeds the format spec)
   - 'edit': modify the CURRENT trip — embeds the full current
     trip document so the LLM knows exactly what exists, and
     instructs it to output the complete updated document
     (which the user then imports, replacing the old plan).
   ========================================================= */

import { serializeTrip } from './format.js';

/* Preference controls surfaced in the UI. Each becomes a line of the
   prompt's "WHAT I WANT" block, so the plan is tailored without the user
   having to write prose. Kept declarative so the UI renders itself from
   this list — adding an option here adds the control. */
export const PROMPT_PREFS = [
  { key:'destination', type:'text', label:'Destination', placeholder:'e.g. Lisbon, or Kyoto & Osaka' },
  { key:'days', type:'number', label:'Number of days', min:1, max:60,
    placeholderFn: t => 'trip has ' + t.days.length },
  { key:'travellers', type:'text', label:'Who’s going', placeholder:'e.g. 2 adults + a 7-year-old' },
  { key:'pace', type:'choice', label:'Pace', options:['Relaxed','Balanced','Packed'], def:'Balanced' },
  { key:'budget', type:'choice', label:'Budget', options:['Shoestring','Mid-range','Comfortable','Luxury'], def:'Mid-range' },
  { key:'transport', type:'choice', label:'Getting around', options:['Any','Mostly walking','Public transport','Cycling','Car'], def:'Any' },
  { key:'startTime', type:'choice', label:'Mornings', options:['Early riser','Normal','Slow starts'], def:'Normal' },
  { key:'interests', type:'multi', label:'Interests', options:['History','Art & museums','Food & drink','Nightlife','Nature & hiking','Architecture','Shopping','Local markets','Beaches','Photography','Off the beaten path','Kid-friendly'] },
  { key:'food', type:'multi', label:'Food', options:['Restaurant picks each day','Street food','Vegetarian','Vegan','Halal','Gluten-free','One splurge meal'] },
  { key:'accessibility', type:'multi', label:'Access needs', options:['Step-free','Limited walking','Stroller-friendly'] },
  { key:'avoid', type:'text', label:'Avoid', placeholder:'e.g. crowds, long queues, early flights' },
  { key:'extras', type:'text', label:'Anything else', placeholder:'e.g. must see the Benfica match on the 12th' },
];

/* Turn collected preference values into prompt lines. `days` is handled
   separately: in a new plan it drives the "Number of days" line, so it would
   be redundant here; in an edit it IS the change being asked for. */
function prefLines(prefs, trip, mode){
  if(!prefs) return '';
  const L = [];
  const val = k => prefs[k];
  const add = (label, v) => { if(v && String(v).trim()) L.push('- ' + label + ': ' + String(v).trim()); };
  add('Destination', val('destination'));
  if(mode === 'edit' && val('days') && Number(val('days')) !== trip.days.length){
    add('Trip length', val('days') + ' days — reshape the plan to this many days (currently ' + trip.days.length + ')');
  }
  add('Travellers', val('travellers'));
  if(val('pace')) add('Pace', val('pace') + (val('pace') === 'Relaxed' ? ' — fewer stops, more time at each' : val('pace') === 'Packed' ? ' — fit in as much as reasonably possible' : ''));
  add('Budget', val('budget'));
  if(val('transport') && val('transport') !== 'Any'){
    add('Getting around', val('transport') + ' — prefer this mode, and set "arrive by" on stops where it applies');
  }
  if(val('startTime')) add('Mornings', val('startTime') === 'Early riser' ? 'happy to start by 08:00' : val('startTime') === 'Slow starts' ? 'prefer starting around 10:00–10:30' : 'normal ~09:00 starts');
  const arr = k => Array.isArray(val(k)) ? val(k) : [];
  if(arr('interests').length) add('Interests', arr('interests').join(', '));
  if(arr('food').length) add('Food', arr('food').join(', '));
  if(arr('accessibility').length) add('Accessibility', arr('accessibility').join(', ') + ' — respect this when choosing stops and routes');
  add('Please avoid', val('avoid'));
  add('Also', val('extras'));
  if(!L.length) return '';
  return '\n\nWHAT I WANT\n===========\n' + L.join('\n');
}

/* The five "### " subsections of "## Trip Info", in document order, with the
   brief each one answers. Single source of truth: both prompts render their
   Trip Info spec from here, and the titles are exactly the ones INFO_KEYS in
   format.js recognises — any other heading gets folded into Notes on import. */
const INFO_SECTIONS = [
  ['weather', 'Weather',
   'expected weather for the dates (or the season, if no start date is set), and what to pack'],
  ['closures', 'Closures',
   'bulleted list: every attraction in the plan with a weekly closing day, e.g. "- Musée d’Orsay — closed Mondays". If the start date is known, flag any stop that lands on its closed day.'],
  ['reservations', 'Reservations',
   'bulleted list, grouped by urgency: which stops/restaurants need booking and how far ahead'],
  ['events', 'Events',
   'festivals, exhibitions, or public holidays overlapping the trip dates'],
  ['notes', 'Notes',
   'anything else important: local transport tips, scams to avoid, dress codes, day-trip logistics'],
];

/* The spec block itself — kept free of commentary so it can be copied
   verbatim; anything trailing a "### " heading would be filed under Notes. */
function infoSpec(){
  return INFO_SECTIONS
    .map(([, title, brief]) => '### ' + title + '\n<' + brief + '>')
    .join('\n\n');
}

/* Which sections this trip already has, and which are absent. serializeTrip
   omits empty ones entirely, so for a trip whose Trip Info tab is blank the
   embedded document shows no trace that the section exists — say so in words
   rather than annotating the spec. */
function infoStatus(info){
  const has = t => String((info || {})[t] || '').trim();
  const filled = INFO_SECTIONS.filter(([k]) => has(k)).map(([, t]) => t);
  const empty = INFO_SECTIONS.filter(([k]) => !has(k)).map(([, t]) => t);
  const L = [];
  if(empty.length) L.push('Not in the document at all yet: ' + empty.join(', ') + '. Research these for this destination and these dates and write them — that is information I want the plan to carry.');
  if(filled.length){
    const it = filled.length > 1 ? 'them' : 'it';
    L.push('Already written: ' + filled.join(', ') + '. Keep ' + it + ', and extend ' + it + ' so closures, reservations and events cover every stop you add or move.');
  }
  return L.join('\n');
}

export function buildPrompt(trip, mode = 'new', prefs = null){
  if(mode === 'edit') return buildEditPrompt(trip, prefs);
  return buildNewPrompt(trip, prefs);
}

function buildEditPrompt(trip, prefs){
  return `You are a travel-planning assistant. I have an existing trip in a structured markdown format — the complete current plan is at the bottom of this message. I want you to EDIT it.

First, ask me what changes I want (unless I've already told you). Changes might be: adding or removing locations, moving stops between days, adding/removing days, inserting a new city, updating hotels, changing pacing, or refreshing the Trip Info sections.${prefLines(prefs, trip, 'edit')}

RULES
=====
- Output ONE complete document in EXACTLY the same format as the current plan below — the ENTIRE updated trip, not a diff, not just the changed days.
- Put the whole document inside a single fenced code block (triple backticks) so the "#" and "- " markers survive copy-paste — they are load-bearing. Write nothing after the block. (If I ask for a file, save the same content as .md or .txt.)
- Keep every field of unchanged locations EXACTLY as they are — same names, coordinates, durations, descriptions, details, images, notes, and tags. My notes are mine: never edit or drop a "- notes:" line.
- Keep every day's "- color:" line exactly as it is unless I ask to change it (valid values: rust, gold, olive, forest, teal, sea, plum, wine — it colour-codes that day in the planner).
- New locations must follow the same field structure, with real lat/lng coordinates (they drive the map and travel times) and realistic durations.
- If you add or remove days, renumber "## Day N" headings sequentially and update the "- days:" count.
- Keep "## Unassigned" present and updated.
- Keep the "## Checklist" section and every one of its "- [ ] " / "- [x] " lines exactly as they are unless I ask to change them (the "[x]" ones are already done).
- End the document with the "## Trip Info" section described below — all five subsections, filled in.
- Travel between stops is computed automatically — durations are visit time only.
- If asked for further revisions, output the complete document again in full.

TRIP INFO SECTION
=================
The document ends with "## Trip Info", built from exactly these five "###" subsections, in this order. Use these headings verbatim, with nothing after them on the line — any other heading is filed under Notes on import.

## Trip Info

${infoSpec()}

${infoStatus(trip.info)}

CURRENT TRIP DOCUMENT
=====================
${serializeTrip(trip)}`;
}

function buildNewPrompt(trip, prefs){
  const wanted = prefs && Number(prefs.days);
  const dayCount = (wanted && wanted > 0) ? wanted : trip.days.length;
  const hasName = trip.name && trip.name !== 'Untitled Trip';
  const asks = [];
  if(!hasName) asks.push('where I am going');
  asks.push(hasName ? `anything about my interests, pace, and budget you need` : 'my interests, pace, and budget');

  return `You are a travel-planning assistant. Plan a trip for me and output it as ONE plain-text document in EXACTLY the format specified below.

CRITICAL — HOW TO OUTPUT:
Put the ENTIRE document inside a single fenced code block (start a line with three backticks, then the document, then a line with three backticks). This keeps the "#", "##", "###" and "- " characters intact when I copy it — they are load-bearing and MUST survive copy-paste. Do NOT render it as normal formatted markdown, and write nothing before or after the code block except, if you like, one short sentence and then the block. I will copy the block's contents and paste or import them into my trip planner. (If I ask for a file instead, save the same content as a .md or .txt file — the format is identical.)

${hasName ? `Destination / trip: ${trip.name}` : 'First ask me where I am going, for how many days, and roughly when.'}
Number of days: ${dayCount}${trip.startDate ? `\nTrip start date: ${trip.startDate} (use real weekdays for closures and events)` : ''}

Before writing the plan, ask me any questions you still need answered, and suggest 2–3 hotels if I haven't named one.${prefLines(prefs, trip, 'new')}

FORMAT SPECIFICATION
====================

# Trip: <trip name>

- subtitle: <one atmospheric sentence>
- days: <number of days>
- start date: <YYYY-MM-DD, only if known>

## Hotels

### <hotel name>
- lat: <decimal latitude>
- lng: <decimal longitude>
- transport: walk        <"walk" normally; "boat" only if every trip to/from the hotel is by boat shuttle>
- image: <public image URL, optional>
- description: <one sentence>

## Day 1: <short day title, e.g. "Ancient Rome">
- start: <HH:MM 24h, e.g. 09:00>
- hotel: <exact hotel name from the Hotels section, or "none">
- hotel bookend: <optional: "both" (default — day starts and ends at the hotel) | "start" | "end" (e.g. an arrival day that only ENDS at the hotel)>
- color: <optional: rust | gold | olive | forest | teal | sea | plum | wine — colour-codes the day in the planner; if the trip spans several cities/areas, give each area its own colour>

### <location name>
- lat: <decimal latitude — REQUIRED, as accurate as you can>
- lng: <decimal longitude — REQUIRED>
- category: <one of: landmark | museum | church | park | view | food | shop | hike | hotel | flight | travel | boat | other>
- duration: <realistic visit length in minutes>
- fixed start: <optional HH:MM for things pinned to a clock: flight landing/boarding time, train departure, timed museum entry. The schedule waits for it and flags conflicts.>
- arrive by: <optional: walk | cycle | transit | taxi | boat — pins how the traveller reaches THIS stop when one mode clearly makes sense (a ferry-only island, a cycling city, a stop best reached by taxi). Omit for automatic selection.>
- image: <public image URL, optional — use Wikimedia Commons in exactly this form: https://commons.wikimedia.org/wiki/Special:FilePath/<File_Name>?width=1200, with a file name you are confident exists. Never hand-build an upload.wikimedia.org path (the hashed folders can't be guessed), and skip the field entirely rather than inventing a URL — a missing image just shows the category icon.>
- description: <1–2 sentences: what it is and one practical tip (booking, timing, closures)>
- detail: <2–4 sentences of history or a great story — the kind of thing a knowledgeable friend would tell you standing in front of it>
- tags: <optional comma-separated labels, e.g. a theme the trip follows>

For a point-to-point hike (category "hike"), also give where it ends — travel to the next stop continues from there:
- end lat: <decimal latitude of the trailhead where the hike finishes>
- end lng: <decimal longitude>

Arrival/departure days: model the flight or train as its own stop — category "flight" or "travel", at the airport/station coordinates, with "fixed start" as the landing or departure time and "duration" covering deplaning/immigration/luggage (arrivals) or the arrive-early buffer (departures). Give such days "- hotel bookend: end" (arrival) or "start" (departure).

(Repeat "## Day N: …" for every day. Include meals as category "food" stops with real restaurant recommendations. 4–8 stops per day is a realistic pace; do not overpack. Order each day's stops geographically so the day flows without backtracking.)

## Unassigned

### <location name>
- <same fields as any location>
- suggested day: <day number it fits best>
- suggestion note: <one sentence on why/when to add it>

(3–8 interesting niche spots that didn't make the main plan — worth seeing, but not slotted into a day.)

## Checklist

- [ ] <something to do before or during the trip>

(Optional. Bookings to make, documents to sort, things to pack — one "- [ ] " line each. "- [x] " marks an item already done.)

## Trip Info

(All five subsections, with these exact headings, in this order — any other heading is filed under Notes on import.)

${infoSpec()}

RULES
=====
- Wrap the whole document in one fenced code block (triple backticks) so the "#" and "- " markers survive copy-paste. Inside the block, it starts with "# Trip:".
- Every location MUST have real lat/lng coordinates (decimal degrees). Accuracy matters: they drive the map and travel-time estimates.
- Durations are visit time only; travel between stops is computed automatically.
- Keep each "- key: value" on a single line (no line breaks inside a value).
- Cluster each day geographically; put lunch/dinner stops where the day actually is at that time.
- Fill in all five "## Trip Info" subsections — they are part of the plan, not optional extras.
- If asked for revisions, output the complete document again in full.`;
}
