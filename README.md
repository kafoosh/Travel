# Travel Planner

A single-purpose, dependency-light travel planning site. Start a trip from scratch, add locations (or import a whole itinerary written by an AI assistant), drag stops around, and let the optimiser arrange your days. Real walking / transit travel times come from free, keyless, OpenStreetMap-based services. No accounts, no build step, no API keys required to run it.

Grown out of a hand-built [Rome & Venice itinerary](https://github.com/kafoosh/Trip) — that trip ships as the example (`demo/rome-venice-trip.md`).

## Features

- **Start from nothing** — name the trip, pick the number of days (optionally a start date, which gives every day a real weekday), add hotels and locations. Everything is editable.
- **Import / export** — the whole trip (locations, coordinates, images, descriptions, notes, hotels, trip info) round-trips through one markdown file. A CSV of locations works too. Both live on the **AI Plan** tab, alongside the assistant prompt they feed.
- **Plan with an AI** — the AI Plan tab has a copyable, editable prompt in two modes: *plan a new trip* (embeds the format spec) or *edit this trip* (embeds the full current plan so the AI knows exactly what exists and returns the complete updated trip to import back — user notes are explicitly protected). Both modes spell out the **Trip Info** section — weather, closures, reservations, events, notes — and the edit prompt names which of the five are still empty, so the assistant researches and fills them in rather than dropping them. Both also carry a **Photos** brief: ask for an image URL on every stop and hotel, Wikimedia Commons `Special:FilePath` form first (other public sources where Commons has nothing), look the file up rather than recall it, and leave the field out rather than guess — in edit mode the assistant fills in stops that have no photo yet while leaving the ones you chose alone. A **Tailor the plan** panel adds destination, travellers, pace, budget, transport preference, morning start, interests, food/dietary needs, accessibility, and things to avoid, all folded into the prompt. Example files in `.md`, `.txt`, and `.csv` ship in `demo/`.
- **Import survives real-world LLM output** — the prompt asks for a fenced code block (so `#`/`-` markers survive copy-paste), and the parser unwraps fences and *reconstructs* stripped markers when a chat UI rendered the markdown before you copied it.
- **Per-leg transport** — click any travel connector to pin that leg to walk / cycle / transit / taxi / boat; the leg re-routes against the matching profile and the schedule recalculates. Routed transit legs report the real vehicle (bus, metro, tram, ferry).
- **Take it offline** — **Offline copy (.html)** on the AI Plan tab writes the whole trip into one self-contained HTML file: every day, time, travel leg, note and coordinate, the photos (fetched and packed in, shrunk to phone size), and a tile-free route sketch per day drawn from the routed geometry. It makes no network requests at all, so it opens from a phone's Files app on a plane or with roaming off — searchable, day by day, with coordinates that hand off to an offline map app (Organic Maps, OsmAnd…) via `geo:` links. Stops already ticked off in the planner arrive ticked, and more can be ticked as you go (those stay on that device), the trip's own `.md` file rides along inside it for importing back, and printing it gives a PDF of the whole trip.
- **External maps** — per-day "Open in Google Maps" directions links: the button first shows the day's points by name (hotel bookends, stops, hike ends) so you can tick just the legs you want to navigate, with select all / none, the itinerary's own numbering (stop 4 stays "4" whatever is ticked, so "just 4 and 5" is picked by the numbers on the day), and an honest warning when a selection passes Google's 11-point cap. Plus a whole-trip KML export for [Google My Maps](https://mymaps.google.com) (one toggleable layer per day, with pins and routes).
- **Real travel times** — walking and driving legs are routed by the [FOSSGIS Valhalla server](https://valhalla.openstreetmap.de), public transport (including ferries like Venice's vaporetti) by [Transitous](https://transitous.org). Both are free, keyless, community-run, OSM-based. Distance-based estimates render instantly (marked "est") and upgrade in place when routed answers land; results are cached in the browser, so a settled trip makes no further requests.
- **Route optimisation** — per-day (nearest-neighbour + 2-opt over best-known travel minutes) and whole-trip **Auto-plan**: cheapest-insertion assignment with hard per-day time budgets (visit durations + travel + hotel legs), load-adaptive seeding so dense areas get more days, hotel-region coherence (a day sleeping in Rome never becomes a Venice day), stops already ticked off pinned to their day, and balance sweeps. Auto-plan shows a per-day preview — mini-map, schedule, distance, and runs-late warnings — to accept or reject before anything changes. Optimisation is a suggestion — drag-and-drop is always the escape hatch, and everything is one Undo away.
- **Reorderable days** — drag a day tab along the strip to move that day in the trip (or focus a tab and press Shift + ← / →; the day editor has Move earlier / Move later for touch). Days renumber themselves, dates follow the new order, and untouched "Day N" titles keep up.
- **Unassigned stops** — stops with no day yet live in their own tab *and* in a collapsible tray on every day panel and on All Stops (always present, so it is also where you add a stop without a day). Drag a chip onto the schedule to place it at an exact position, or click it to drop it straight into that day (in All Stops, clicking offers a day picker, so it works on touch too).
- **Hide anything from the map** — an eye next to the tick and the bin on every stop card (and in its detail popup) takes that stop off the map without taking it out of the day; the Start / End hotel chips have the same eye, so a day's bookends can go too. What's hidden leaves the map completely: no pin, no legs either side of it, and no pull on the zoom — which is the point on a transfer day. Hide the four-hour train *and* the hotel you checked out of, and a map stretched across a whole country snaps to the city you actually walk around, with the schedule, the timings and the travel legs all untouched. Numbers never shift: the day reads 1, 2, 3, 4 on the cards and 1, 2, 4 on the map, the hidden card dims and its badge goes hollow, so a gap in the pins always has a card explaining it. The flags live on the stop and the day, so they travel through export/import, the offline copy, the KML (whose route line breaks the same way) and shared rooms — and a hidden point opens unticked, not missing, in the Google Maps picker.
- **Notes everywhere** — every location has a free-text notes field (booking refs, must-try dishes…), included in export/import and sync.
- **Tick stops off as you go** — a ✓ next to the bin on every stop card (and in its detail popup) marks it done: the card fades, its name is struck through, its map pin greys, and the day header counts "✓ 3 of 7 done". Nothing moves — a done stop keeps its place, its time and its number, and the schedule computes exactly as before. Auto-plan is the one thing that reads the tick: a visited stop is pinned to the day you visited it, so replanning mid-trip reshuffles what's ahead, not what's behind. It lives on the stop itself, so it travels through export/import, rides along in the offline copy, and everyone in a shared room sees the same crossed-off plan. One Undo away, like everything else.
- **Share on demand — and sharing is saving** — an unshared trip lives only in its browser tab (a reload keeps it; a fresh tab at the bare URL always opens a new blank trip). Click "Create a share link" and the trip moves to Cloud Firestore at a stable URL: everyone holding the link edits the same plan, live, and that link is how you come back to it. Requires the one-time Firebase setup below; without it the site still works as a tab-local planner with export/import. Opening a link on a device that hasn't seen that trip before holds the first render behind a quiet "Opening the shared trip…" line rather than painting a blank *Untitled Trip* while Firestore answers — and gives up after a few seconds, so a trip that never arrives leaves a usable planner rather than a spinner.
- **Room tools** — from Trip Info: **duplicate** the current room into a second one (a copy of the trip at a brand-new link, the original untouched — the way to fork a plan, or to cut off a link that got out), **empty** a room (wipe the itinerary, keep the room and its link), or **delete** a room outright (the shared copy is removed and the link stops working). Emptying and deleting are one Undo away on the device that did it.
- **New trip** — a top-nav button (folded into the mobile More sheet) opens a blank, unshared trip in a new tab, the same page a bare visit to the site would show. The tab you're in is untouched either way — shared or an unsaved draft, it keeps exactly what it had.
- **Forgiving images** — a photo URL that doesn't load never leaves a broken box: the category icon shows from the start and is only replaced once an image actually decodes. Wikimedia Commons *File:* page links are rewritten to the real file, dead thumbnail sizes fall back to the original, `http://` is upgraded, and each candidate is retried twice before the icon simply stays.
- **Color schemes** — parchment (default), lagoon, terracotta, midnight, field-notes. The choice travels with the trip file.

## Running it

It's a static site — any web server works:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

**GitHub Pages:** Settings → Pages → deploy from branch → `main`, root. Done.

Opening `index.html` via `file://` mostly works, but browsers block `fetch` on that scheme, so the example-trip button and live routing need a real server.

## Import format

One markdown file. The full spec is embedded in the AI prompt (AI Plan → "Plan with an AI assistant"); the short version:

```markdown
# Trip: Rome & Venice

- subtitle: One atmospheric sentence
- days: 10
- start date: 2026-10-05
- theme: parchment

## Hotels

### The Tribune, JdV by Hyatt
- lat: 41.9053
- lng: 12.4886
- transport: walk          # "boat" = island resort, every hotel leg is a boat shuttle

## Day 1: Arrival & Trastevere
- start: 15:00
- start hotel: none                  # each end of a day picks its own hotel:
- end hotel: The Tribune, JdV by Hyatt   # an arrival day starts mid-journey, ends at the hotel

## Day 2: Ancient Rome
- start: 09:00
- hotel: The Tribune, JdV by Hyatt   # the normal case — starts AND ends here (or "none")
- hide start: yes                    # optional: this end of the day is off the map

### Colosseum
- lat: 41.8902
- lng: 12.4922
- category: landmark       # landmark|museum|church|park|view|food|shop|hotel|travel|boat|other
- duration: 105            # visit minutes; travel between stops is computed
- image: https://…
- description: Short and practical.
- detail: Longer history / a good story.
- notes: Your own notes.
- tags: any, labels
- done: yes                # ticked off on the trip; written only when true
- hidden: yes              # no pin on the map; written only when true

## Unassigned

### Centrale Montemartini
- …same fields…
- suggested day: 5
- suggestion note: Pairs with the Aventine stops.

## Trip Info

### Weather
Free text…

### Closures
- Vatican Museums — closed Sundays

### Reservations
…

### Events
…

### Notes
…
```

A day names either one `hotel:` (it starts *and* ends there — the normal case) or a `start hotel:` / `end hotel:` pair when the two ends differ (arrival days start at `none`, departure days end at `none`, hotel-change days name one of each); files from before this distinction, with `hotel bookend:` lines, still import. A day may also carry `hide start: yes` / `hide end: yes` — that end of the day is off the map (no hotel pin, no leg to it), while the schedule still departs from and returns to it. A stop that moves (`hike`, `travel`, `flight`, `boat`) may carry `end lat` / `end lng`: its own coordinates are the departure point (trailhead, station, airport), the end coordinates the arrival — the commute is computed to the departure point, `duration` is the leg itself, and the day continues from the arrival end. The parser is tolerant (key aliases, `-`/`*`/bare `key: value`, `1h 45m` durations, etc.). CSV import expects a header row with at least `name`; recognised columns: `name, day, lat, lng, category, duration, description, detail, image, notes, tags, done, hidden` (`day` = number or `unassigned`).

## Enabling shared trips (one-time, free, ~5 minutes)

Sharing uses Cloud Firestore's free tier. Until configured, the Share button explains what's missing; everything else works.

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com) (no billing needed — the Spark plan is fine).
2. **Build → Authentication → Sign-in method** → enable **Anonymous**.
3. **Build → Firestore Database** → Create database (production mode, any region).
4. Firestore → **Rules** → paste and publish:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /trips/{code} {
         // read and write must be separate rules: request.resource only
         // exists on writes, so referencing it in a read rule denies all reads.
         allow read: if request.auth != null
           && code.matches('^[a-z0-9]{12,40}$');
         allow create, update: if request.auth != null
           && code.matches('^[a-z0-9]{12,40}$')
           && request.resource.data.keys().hasOnly(['trip', 'updatedBy', 'updatedAt']);
         // "Delete this room" in Trip Info. Swap for `if false` to make rooms
         // permanent — the button then reports that the rules refuse it.
         allow delete: if request.auth != null
           && code.matches('^[a-z0-9]{12,40}$');
       }
     }
   }
   ```

   Deployments set up before room deletion existed have `allow delete: if false` published; re-paste the block above to enable the button.

5. Project settings → **Your apps** → add a **Web app** → copy the `firebaseConfig` object into `js/config.js` (replacing `null`).

The config values are public identifiers, not secrets — the rules above are what guard the data. Room codes are 16 random characters in the URL fragment; anyone with a link can edit that trip, and links can't be revoked — to cut off a link that got out, duplicate the trip to a new room and delete the old one.

### Why a device that opens a link can't wipe the room

A browser that merely follows a share link never writes to the room until the room's current contents have arrived from the server. That matters because Firestore answers "no such document" *from its local cache* while the backend is unreachable — on a flaky network a fresh (or long-stale) device could take that as "empty room" and push its blank or outdated copy over everyone's trip. Edits made before the first sync lands are held back for the same reason. Only the device that just created a room writes it into existence; opening a link to a room that no longer exists shows an error (with "Duplicate to a new room" as the way to re-share a copy this device still holds) instead of quietly re-creating it. As a last-ditch safety net, when an incoming sync would replace a populated local copy with an empty one, the populated copy is kept in `localStorage` under `travelPlanner_room_<code>_backup` for manual recovery.

## Routing services & being a good guest

The site uses two public, fair-use servers with no signup:

| Service | What for | Run by |
|---|---|---|
| `valhalla1.openstreetmap.de` | walking & driving legs (time + route geometry) | [FOSSGIS e.V.](https://www.fossgis.de/) (German OSM chapter) |
| `api.transitous.org` | public transport legs (time + route geometry) | [Transitous](https://transitous.org) community |
| `photon.komoot.io` | place search / autocomplete in the add-location and hotel forms | [komoot](https://photon.komoot.io) — OSM-based, built for type-ahead |

All three bases are overridable via localStorage (`routing.valhallaBase`, `routing.transitousBase`, `routing.photonBase`) for self-hosting or testing.

Requests go through a small sequential queue (~3/s max), are cached in `localStorage` (OSM data is ODbL-licensed — caching is explicitly fine), retried with backoff, and identified with an `X-Client-Id` header. If either server is unreachable the site silently falls back to distance-based estimates and says so in the footer. If this project ever grows real traffic, the right move is self-hosting Valhalla on a small VPS — please don't point a busy site at community demo servers.

## Repository layout

| Path | What |
|---|---|
| `index.html` | Page shell and modals |
| `css/main.css` | Design system; all five color schemes as CSS variables |
| `js/format.js` | Trip model + markdown/CSV import & export (the canonical format) |
| `js/routing.js` | Valhalla + Transitous clients, cache, heuristic fallback |
| `js/schedule.js` | Day timeline computation |
| `js/optimize.js` | 2-opt day ordering + capacity-aware multi-day distribution |
| `js/ui.js` | All rendering and interaction |
| `js/offline.js` | The self-contained offline export (one HTML file, no requests) |
| `js/state.js` | Persistence, undo, normalisation |
| `js/cloud.js` | Share-on-demand Firestore rooms (create / duplicate / delete) |
| `js/img.js` | Photo URL repair, retries, icon fallback |
| `js/llm.js` | The AI-assistant prompt builder |
| `js/config.js` | **Deployment config — paste your Firebase config here** |
| `vendor/leaflet/` | Leaflet 1.9.4, vendored (no CDN dependency) |
| `demo/rome-venice-trip.md` | Example trip, loadable from the AI Plan tab |

## Development notes

- Plain ES modules, no build step — edit and refresh.
- Everything user-entered is escaped (`esc()` in `js/util.js`) before touching `innerHTML`; imports are untrusted input.
- The trip object is one JSON document (see `blankTrip()` in `js/format.js`); undo snapshots the whole thing.
- `node scripts/roundtrip-test.mjs` runs the format round-trip checks.
