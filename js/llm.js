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

export function buildPrompt(trip, mode = 'new'){
  if(mode === 'edit') return buildEditPrompt(trip);
  return buildNewPrompt(trip);
}

function buildEditPrompt(trip){
  return `You are a travel-planning assistant. I have an existing trip in a structured markdown format — the complete current plan is at the bottom of this message. I want you to EDIT it.

First, ask me what changes I want (unless I've already told you). Changes might be: adding or removing locations, moving stops between days, adding/removing days, inserting a new city, updating hotels, changing pacing, or refreshing the Trip Info sections.

RULES
=====
- Output ONE complete document in EXACTLY the same format as the current plan below — the ENTIRE updated trip, not a diff, not just the changed days.
- Put the whole document inside a single fenced code block (triple backticks) so the "#" and "- " markers survive copy-paste — they are load-bearing. Write nothing after the block. (If I ask for a file, save the same content as .md or .txt.)
- Keep every field of unchanged locations EXACTLY as they are — same names, coordinates, durations, descriptions, details, images, notes, and tags. My notes are mine: never edit or drop a "- notes:" line.
- New locations must follow the same field structure, with real lat/lng coordinates (they drive the map and travel times) and realistic durations.
- If you add or remove days, renumber "## Day N" headings sequentially and update the "- days:" count.
- Keep "## Optional" and "## Trip Info" sections present and updated to stay consistent with the changes (closures, reservations, and events should cover any newly added stops).
- Travel between stops is computed automatically — durations are visit time only.
- If asked for further revisions, output the complete document again in full.

CURRENT TRIP DOCUMENT
=====================
${serializeTrip(trip)}`;
}

function buildNewPrompt(trip){
  const dayCount = trip.days.length;
  const hasName = trip.name && trip.name !== 'Untitled Trip';
  const asks = [];
  if(!hasName) asks.push('where I am going');
  asks.push(hasName ? `anything about my interests, pace, and budget you need` : 'my interests, pace, and budget');

  return `You are a travel-planning assistant. Plan a trip for me and output it as ONE plain-text document in EXACTLY the format specified below.

CRITICAL — HOW TO OUTPUT:
Put the ENTIRE document inside a single fenced code block (start a line with three backticks, then the document, then a line with three backticks). This keeps the "#", "##", "###" and "- " characters intact when I copy it — they are load-bearing and MUST survive copy-paste. Do NOT render it as normal formatted markdown, and write nothing before or after the code block except, if you like, one short sentence and then the block. I will copy the block's contents and paste or import them into my trip planner. (If I ask for a file instead, save the same content as a .md or .txt file — the format is identical.)

${hasName ? `Destination / trip: ${trip.name}` : 'First ask me where I am going, for how many days, and roughly when.'}
Number of days: ${dayCount}${trip.startDate ? `\nTrip start date: ${trip.startDate} (use real weekdays for closures and events)` : ''}

Before writing the plan, ask me any questions you need about interests, pace, budget, dietary needs, and where I'm staying (or suggest 2–3 hotels yourself).

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

### <location name>
- lat: <decimal latitude — REQUIRED, as accurate as you can>
- lng: <decimal longitude — REQUIRED>
- category: <one of: landmark | museum | church | park | view | food | shop | hike | hotel | flight | travel | boat | other>
- duration: <realistic visit length in minutes>
- fixed start: <optional HH:MM for things pinned to a clock: flight landing/boarding time, train departure, timed museum entry. The schedule waits for it and flags conflicts.>
- arrive by: <optional: walk | cycle | transit | taxi | boat — pins how the traveller reaches THIS stop when one mode clearly makes sense (a ferry-only island, a cycling city, a stop best reached by taxi). Omit for automatic selection.>
- image: <public image URL, optional — prefer Wikimedia Commons: https://commons.wikimedia.org/wiki/Special:FilePath/<File_Name>?width=1200>
- description: <1–2 sentences: what it is and one practical tip (booking, timing, closures)>
- detail: <2–4 sentences of history or a great story — the kind of thing a knowledgeable friend would tell you standing in front of it>
- tags: <optional comma-separated labels, e.g. a theme the trip follows>

For a point-to-point hike (category "hike"), also give where it ends — travel to the next stop continues from there:
- end lat: <decimal latitude of the trailhead where the hike finishes>
- end lng: <decimal longitude>

Arrival/departure days: model the flight or train as its own stop — category "flight" or "travel", at the airport/station coordinates, with "fixed start" as the landing or departure time and "duration" covering deplaning/immigration/luggage (arrivals) or the arrive-early buffer (departures). Give such days "- hotel bookend: end" (arrival) or "start" (departure).

(Repeat "## Day N: …" for every day. Include meals as category "food" stops with real restaurant recommendations. 4–8 stops per day is a realistic pace; do not overpack. Order each day's stops geographically so the day flows without backtracking.)

## Optional

### <location name>
- <same fields as any location>
- suggested day: <day number it fits best>
- suggestion note: <one sentence on why/when to add it>

(3–8 interesting niche spots that didn't make the main plan.)

## Trip Info

### Weather
<expected weather for the season, and what to pack>

### Closures
<bulleted list: every attraction in the plan with a weekly closing day, e.g. "- Musée d'Orsay — closed Mondays". If the start date is known, flag any stop that lands on its closed day.>

### Reservations
<bulleted list, grouped by urgency: which stops/restaurants need booking and how far ahead>

### Events
<festivals, exhibitions, or public holidays overlapping the trip dates>

### Notes
<anything else important: local transport tips, scams to avoid, dress codes, day-trip logistics>

RULES
=====
- Wrap the whole document in one fenced code block (triple backticks) so the "#" and "- " markers survive copy-paste. Inside the block, it starts with "# Trip:".
- Every location MUST have real lat/lng coordinates (decimal degrees). Accuracy matters: they drive the map and travel-time estimates.
- Durations are visit time only; travel between stops is computed automatically.
- Keep each "- key: value" on a single line (no line breaks inside a value).
- Cluster each day geographically; put lunch/dinner stops where the day actually is at that time.
- If asked for revisions, output the complete document again in full.`;
}
