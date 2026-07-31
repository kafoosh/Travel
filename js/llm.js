/* =========================================================
   LLM PROMPT BUILDER
   Generates a copy-paste prompt that instructs any LLM to
   produce a trip in exactly the markdown format importText()
   understands. The prompt embeds the format spec and a short
   example, plus whatever the user has already decided (name,
   day count, dates).
   ========================================================= */

export function buildPrompt(trip){
  const dayCount = trip.days.length;
  const hasName = trip.name && trip.name !== 'Untitled Trip';
  const asks = [];
  if(!hasName) asks.push('where I am going');
  asks.push(hasName ? `anything about my interests, pace, and budget you need` : 'my interests, pace, and budget');

  return `You are a travel-planning assistant. Plan a trip for me and output it as ONE markdown document in EXACTLY the format specified below — no commentary before or after the document, no code fences.

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

### <location name>
- lat: <decimal latitude — REQUIRED, as accurate as you can>
- lng: <decimal longitude — REQUIRED>
- category: <one of: landmark | museum | church | park | view | food | shop | hotel | travel | boat | other>
- duration: <realistic visit length in minutes>
- image: <public image URL, optional — prefer Wikimedia Commons: https://commons.wikimedia.org/wiki/Special:FilePath/<File_Name>?width=1200>
- description: <1–2 sentences: what it is and one practical tip (booking, timing, closures)>
- detail: <2–4 sentences of history or a great story — the kind of thing a knowledgeable friend would tell you standing in front of it>
- tags: <optional comma-separated labels, e.g. a theme the trip follows>

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
- Output must start with "# Trip:" — nothing before it.
- Every location MUST have real lat/lng coordinates (decimal degrees). Accuracy matters: they drive the map and travel-time estimates.
- Durations are visit time only; travel between stops is computed automatically.
- Keep each "- key: value" on a single line (no line breaks inside a value).
- Cluster each day geographically; put lunch/dinner stops where the day actually is at that time.
- If asked for revisions, output the complete document again in full.`;
}
