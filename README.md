# Travel Planner

A single-purpose, dependency-light travel planning site. Start a trip from scratch, add locations (or import a whole itinerary written by an AI assistant), drag stops around, and let the optimiser arrange your days. Real walking / transit travel times come from free, keyless, OpenStreetMap-based services. No accounts, no build step, no API keys required to run it.

Grown out of a hand-built [Rome & Venice itinerary](https://github.com/kafoosh/Trip) — that trip ships as the example (`demo/rome-venice-trip.md`).

## Features

- **Start from nothing** — name the trip, pick the number of days (optionally a start date, which gives every day a real weekday), add hotels and locations. Everything is editable.
- **Import / export** — the whole trip (locations, coordinates, images, descriptions, notes, hotels, trip info) round-trips through one markdown file. A CSV of locations works too.
- **Plan with an AI** — Trip Info has a copyable prompt that instructs any LLM to produce a complete trip in exactly the import format: locations with coordinates and realistic durations, restaurant picks, weekly closures, reservation lead times, overlapping events.
- **Real travel times** — walking and driving legs are routed by the [FOSSGIS Valhalla server](https://valhalla.openstreetmap.de), public transport (including ferries like Venice's vaporetti) by [Transitous](https://transitous.org). Both are free, keyless, community-run, OSM-based. Distance-based estimates render instantly (marked "est") and upgrade in place when routed answers land; results are cached in the browser, so a settled trip makes no further requests.
- **Route optimisation** — per-day (nearest-neighbour + 2-opt over best-known travel minutes) and whole-trip ("Distribute stops across days": capacity-aware geographic clustering that respects each day's time budget, then orders every day). Optimisation is a suggestion — drag-and-drop is always the escape hatch, and everything is one Undo away.
- **Notes everywhere** — every location has a free-text notes field (booking refs, must-try dishes…), included in export/import and sync.
- **Share on demand** — nothing leaves the browser until you click "Create a share link". Then the trip lives in Cloud Firestore and everyone holding the link edits the same plan, live. Requires the one-time Firebase setup below; without it the site is fully functional locally.
- **Color schemes** — parchment (default), lagoon, terracotta, midnight, field-notes. The choice travels with the trip file.

## Running it

It's a static site — any web server works:

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

**GitHub Pages:** Settings → Pages → deploy from branch → `main`, root. Done.

Opening `index.html` via `file://` mostly works, but browsers block `fetch` on that scheme, so the example-trip button and live routing need a real server.

## Import format

One markdown file. The full spec is embedded in the AI prompt (Trip Info → "Plan with an AI assistant"); the short version:

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
- hotel: The Tribune, JdV by Hyatt   # or "none"

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

## Optional

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

The parser is tolerant (key aliases, `-`/`*`/bare `key: value`, `1h 45m` durations, etc.). CSV import expects a header row with at least `name`; recognised columns: `name, day, lat, lng, category, duration, description, detail, image, notes, tags` (`day` = number or `optional`).

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
         allow read, update, create: if request.auth != null
           && code.matches('^[a-z0-9]{12,40}$')
           && request.resource.data.keys().hasOnly(['trip', 'updatedBy', 'updatedAt']);
         allow delete: if false;
       }
     }
   }
   ```

5. Project settings → **Your apps** → add a **Web app** → copy the `firebaseConfig` object into `js/config.js` (replacing `null`).

The config values are public identifiers, not secrets — the rules above are what guard the data. Room codes are 16 random characters in the URL fragment; anyone with a link can edit that trip, and links can't be revoked (create a new room instead).

## Routing services & being a good guest

The site uses two public, fair-use servers with no signup:

| Service | What for | Run by |
|---|---|---|
| `valhalla1.openstreetmap.de` | walking & driving legs | [FOSSGIS e.V.](https://www.fossgis.de/) (German OSM chapter) |
| `api.transitous.org` | public transport legs | [Transitous](https://transitous.org) community |

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
| `js/state.js` | Persistence, undo, normalisation |
| `js/cloud.js` | Share-on-demand Firestore rooms |
| `js/llm.js` | The AI-assistant prompt builder |
| `js/config.js` | **Deployment config — paste your Firebase config here** |
| `vendor/leaflet/` | Leaflet 1.9.4, vendored (no CDN dependency) |
| `demo/rome-venice-trip.md` | Example trip, loadable from Trip Info |

## Development notes

- Plain ES modules, no build step — edit and refresh.
- Everything user-entered is escaped (`esc()` in `js/util.js`) before touching `innerHTML`; imports are untrusted input.
- The trip object is one JSON document (see `blankTrip()` in `js/format.js`); undo snapshots the whole thing.
- `node scripts/roundtrip-test.mjs` runs the format round-trip checks.
