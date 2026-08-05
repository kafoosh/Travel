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

/* How the assistant should source "- image:" URLs. Written once and shared by
   both prompts, since the sourcing advice is the same whether the stop is new
   or being filled in. img.js already repairs the near-misses — a Commons
   *File:* page link, a thumbnail width that 404s, http on an https page — so
   the rules below aim at the two things it cannot repair: a file name that was
   invented, and a URL that isn't an image at all. */
const IMAGE_FIELD = '<public image URL — include one wherever a real photo exists; see PHOTOS below>';

function imageSpec(){
  return `PHOTOS
======
Give every location, hotel and unassigned stop an "- image:" line wherever you can source a real photo of it. The planner shows it on the stop card, in the map popup and in the offline copy, and falls back to a category icon when the field is absent.

- Wikimedia Commons first, written in exactly this form:
  https://commons.wikimedia.org/wiki/Special:FilePath/<File_Name>?width=1200
  <File_Name> is the file's name on Commons — underscores for spaces, extension included, e.g. .../Special:FilePath/Colosseo_2020.jpg?width=1200. Most landmarks, museums, churches, parks, viewpoints, stations and airports have one, and a file name you know from a Commons *File:* page or a Wikipedia infobox is exactly what goes here.
- Never hand-build an upload.wikimedia.org path — the two hashed folders in it cannot be derived from the file name, so the URL will 404. Use the Special:FilePath form above and let it redirect.
- Where Commons has nothing, another public source is fine: a restaurant's or hotel's own site, an official tourism board, a museum's press page. It must be a direct link to the image file (https, ending .jpg / .jpeg / .png / .webp) — not a page that contains the photo, not a search-results link, not a watermarked stock preview.
- Only give a URL you are genuinely confident exists. Do NOT invent a plausible-looking file name to fill the field: in the planner a wrong URL and a missing one look identical (the category icon shows), so a guess buys nothing and costs accuracy. Skip the field instead.
- One photo per stop, landscape where there's a choice, showing the place itself rather than a map, logo, portrait or crowd.
- If you can search or browse the web, look the files up rather than recalling them — searching Wikimedia Commons for the place name, or opening its Wikipedia article and taking the file name from the infobox photo, gives a name that certainly exists.`;
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
- Keep every field of unchanged locations EXACTLY as they are — same names, coordinates, durations, descriptions, details, images, notes, and tags. My notes are mine: never edit or drop a "- notes:" line, and a "- done: yes" line is a stop I have already visited — keep it, and don't rearrange or drop those stops unless I ask. A "- hidden: yes" line means I have taken that stop's pin off the map; keep the line, and keep the stop.
- Keep every day's "- color:" line exactly as it is unless I ask to change it (valid values: rust, gold, olive, forest, teal, sea, plum, wine — it colour-codes that day in the planner).
- Each day says where it starts and ends. "- hotel: X" means the day starts AND ends at hotel X ("none" = no hotel). A day may instead carry a "- start hotel:" / "- end hotel:" pair when its two ends differ: an arrival day has "start hotel: none", a departure day has "end hotel: none", and a hotel-change day starts at the old hotel and ends at the new one — the end hotel is where that night is spent. Keep these lines matching where the traveller actually wakes up and sleeps, and update them whenever you add, remove or reorder days, or change hotels.
- A moving stop — a hike, a train, a flight, a ferry (category hike | travel | flight | boat) — may carry "- end lat:" / "- end lng:" lines: its lat/lng is the DEPARTURE point (trailhead, departure station or airport) and the end coordinates are where it ARRIVES; the commute to the departure point is computed like any leg, "duration" is the leg itself, and the day continues from the arrival. Keep both ends exactly as they are when moving such stops between days, and give both ends to any within-trip train/flight/ferry you add — never place one only at its arrival point.
- New locations must follow the same field structure, with real lat/lng coordinates (they drive the map and travel times) and realistic durations.
- Photos: give every stop and hotel you add an "- image:" line, and fill the gaps — where an existing stop or hotel has no "- image:" line, add one if you can source a real photo of it (see PHOTOS below). Never change or remove an image line that is already there; a photo I picked stays mine.
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

${imageSpec()}

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
- image: ${IMAGE_FIELD}
- description: <one sentence>

## Day 1: <short day title, e.g. "Ancient Rome">
- start: <HH:MM 24h, e.g. 09:00>
- hotel: <exact hotel name from the Hotels section, or "none" — the day starts AND ends at this hotel (the normal case)>
- color: <optional: rust | gold | olive | forest | teal | sea | plum | wine — colour-codes the day in the planner; if the trip spans several cities/areas, give each area its own colour>

A day whose two ends differ takes TWO lines INSTEAD of the single "hotel:" line — where the day starts, and where that night is spent ("none" works at either end):
- start hotel: <hotel the day STARTS from, or "none">
- end hotel: <hotel the day ENDS at, or "none">
Use this for exactly three kinds of day: an ARRIVAL day ("start hotel: none" — the day begins mid-journey — plus "end hotel:" naming the first hotel), a DEPARTURE day ("start hotel:" naming the last hotel, plus "end hotel: none" — no hotel that night), and a HOTEL-CHANGE day ("start hotel:" the old one, "end hotel:" the new one — check out of the first, sleep at the second). The planner adds the matching travel legs: the day departs from its start hotel and returns to its end hotel.

### <location name>
- lat: <decimal latitude — REQUIRED, as accurate as you can>
- lng: <decimal longitude — REQUIRED>
- category: <one of: landmark | museum | church | park | view | food | shop | hike | hotel | flight | travel | boat | other>
- duration: <realistic visit length in minutes>
- fixed start: <optional HH:MM for things pinned to a clock: flight landing/boarding time, train departure, timed museum entry. The schedule waits for it and flags conflicts.>
- arrive by: <optional: walk | cycle | transit | taxi | boat — pins how the traveller reaches THIS stop when one mode clearly makes sense (a ferry-only island, a cycling city, a stop best reached by taxi). Omit for automatic selection.>
- image: ${IMAGE_FIELD}
- description: <1–2 sentences: what it is and one practical tip (booking, timing, closures)>
- detail: <2–4 sentences of history or a great story — the kind of thing a knowledgeable friend would tell you standing in front of it>
- tags: <optional comma-separated labels, e.g. a theme the trip follows>

A stop that MOVES — a hike, a train, a flight, a ferry (category "hike" | "travel" | "flight" | "boat") — can name both of its ends. Its "lat"/"lng" is the DEPARTURE point (trailhead, departure station, departure airport, departure dock); add the arrival:
- end lat: <decimal latitude of where the leg ENDS — the arrival station / airport / dock, or where the hike finishes>
- end lng: <decimal longitude>
The planner then computes the commute TO the departure point like any other leg (e.g. hotel → station), treats "duration" as the leg itself (boarding to arrival — for a flight, include check-in/security before and deplaning/luggage after), and continues the day from the end point. ALWAYS give both ends for a train/flight/ferry that travels WITHIN the trip — e.g. a Rome → Venice train has lat/lng at Roma Termini and end lat/lng at Venezia Santa Lucia; never place such a stop only at its arrival point, or the commute to it will be computed across the whole country. A single-point stop (no end lat/lng) is right only when one end lies outside the trip: the flight IN sits at the arrival airport alone (with "fixed start" as the landing time and "duration" covering deplaning/immigration/luggage), and the flight home sits at the departure airport alone (duration covering the arrive-early buffer).

Arrival/departure/transfer days: model the flight or train as its own stop as described above, with "fixed start" as its departure (or landing) time. Give such days the "start hotel" / "end hotel" pair rather than a single "hotel:" line.

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

${imageSpec()}

RULES
=====
- Wrap the whole document in one fenced code block (triple backticks) so the "#" and "- " markers survive copy-paste. Inside the block, it starts with "# Trip:".
- Every location MUST have real lat/lng coordinates (decimal degrees). Accuracy matters: they drive the map and travel-time estimates.
- Durations are visit time only; travel between stops is computed automatically.
- Keep each "- key: value" on a single line (no line breaks inside a value).
- Cluster each day geographically; put lunch/dinner stops where the day actually is at that time.
- Add an "- image:" line to every stop and hotel you can find a real photo for, following PHOTOS above.
- Fill in all five "## Trip Info" subsections — they are part of the plan, not optional extras.
- If asked for revisions, output the complete document again in full.`;
}
