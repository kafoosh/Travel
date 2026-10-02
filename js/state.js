/* =========================================================
   APP STATE + PERSISTENCE + UNDO
   The whole trip is one JSON-serialisable object (see
   format.blankTrip). Undo snapshots the entire trip — the
   structure is user-editable everywhere, so partial snapshots
   aren't worth the bugs.
   ========================================================= */

import { blankTrip, isValidTrip, DAY_COLORS } from './format.js';

/* Persistence model: a trip is only SAVED once it's shared.
   - Unshared work-in-progress lives in sessionStorage: an accidental reload
     keeps it, but the bare URL in a fresh tab always opens a blank trip —
     so anyone can come back to the site and start a new one.
   - A shared room (#trip=code in the URL) caches per room code in
     localStorage, for instant loads and offline fallback; Firestore is the
     real copy. */
const DRAFT_KEY = 'travelPlanner_draft_v1';
const ROOM_PREFIX = 'travelPlanner_room_';

function currentRoomCode(){
  const m = /[#&]trip=([a-z0-9]{12,40})/.exec(location.hash || '');
  return m ? m[1] : null;
}

/* The Schedule/Map pane choice survives reloads — someone following the map
   on foot shouldn't land back on the list every time the page reopens. */
function savedPane(){
  try{ return localStorage.getItem('travelPlanner_pane_v1') === 'map' ? 'map' : 'list'; } catch(e){ return 'list'; }
}
export function rememberPane(pane){
  try{ localStorage.setItem('travelPlanner_pane_v1', pane); } catch(e){}
}

export const state = {
  trip: blankTrip(),
  currentDayIndex: 0,
  currentView: 'days',    // 'days' | 'all' | 'bin' | 'optional' | 'info' | 'ai'
  mobilePane: savedPane(),
  undoStack: [],
};

/* "New trip" (js/ui.js) opens a second, same-origin tab — and browsers clone
   sessionStorage into a same-origin tab opened by script, draft and all, even
   with noopener set. A "?newTrip=1" marker on that URL is the escape hatch:
   caught here before anything reads the inherited draft, it wipes the clone
   and leaves state.trip at its default blankTrip(). The URL is cleaned up
   immediately after, so this only ever fires once, and a later reload of the
   same tab takes the normal path. */
function consumeNewTripFlag(){
  if(!/(?:^|[?&])newTrip=1(?:&|$)/.test(location.search)) return false;
  try{ sessionStorage.removeItem(DRAFT_KEY); } catch(e){}
  history.replaceState(null, '', location.origin + location.pathname + location.hash);
  return true;
}

/* Returns whether a stored trip was actually restored. A share link opened
   where the answer is `false` has nothing to show until the room arrives —
   app.js holds the first render rather than paint a blank trip meanwhile. */
export function loadState(){
  try{ localStorage.removeItem('travelPlanner_v1'); } catch(e){}   // pre-share-model key
  if(consumeNewTripFlag()) return false;
  try{
    const code = currentRoomCode();
    const raw = code ? localStorage.getItem(ROOM_PREFIX + code) : sessionStorage.getItem(DRAFT_KEY);
    if(raw){
      const saved = JSON.parse(raw);
      if(isValidTrip(saved.trip)){ state.trip = normalizeTrip(saved.trip); return true; }
    }
  } catch(e){ console.warn('Could not load saved trip', e); }
  return false;
}

/* Fill any holes in a trip object that came from storage, an import,
   or another device, so the rest of the code can assume shape. */
export function normalizeTrip(t){
  const base = blankTrip();
  const trip = { ...base, ...t };
  trip.info = { ...base.info, ...(t.info || {}) };
  trip.days = (t.days || []).map((d, i) => {
    // A day's two hotel ends are independent: where it starts and where that
    // night is spent. Trips saved before this model carried a single hotelId
    // plus a bookend ('both'|'start'|'end') — migrate those on the way in.
    let startHotelId = d.startHotelId || null, endHotelId = d.endHotelId || null;
    if(!('startHotelId' in d) && !('endHotelId' in d) && d.hotelId){
      const bookend = ['start','end'].includes(d.bookend) ? d.bookend : 'both';
      startHotelId = bookend !== 'end' ? d.hotelId : null;
      endHotelId = bookend !== 'start' ? d.hotelId : null;
    }
    return {
      id: i + 1, title: d.title || ('Day ' + (i + 1)), start: d.start || '09:00',
      startHotelId, endHotelId,
      returnBy: ['walk','cycle','transit','taxi','boat'].includes(d.returnBy) ? d.returnBy : null,
      color: DAY_COLORS[d.color] ? d.color : null,
      pinned: !!d.pinned,
      order: Array.isArray(d.order) ? d.order.filter(id => t.stops && t.stops[id]) : [],
    };
  });
  if(!trip.days.length) trip.days = base.days;
  // Room-wide "itinerary locked in": drag and keyboard reordering of stops
  // (and days) is switched off for everyone on the link. Toggled on Info.
  trip.stopsLocked = !!t.stopsLocked;
  // One pinned day at most — the tab the trip opens on. Two devices pinning
  // different days at once could merge into two; the earlier one wins.
  let pinSeen = false;
  trip.days.forEach(d => { if(d.pinned && pinSeen) d.pinned = false; if(d.pinned) pinSeen = true; });
  // Trip-level mirror of the pin (its day number). A device still running an
  // older build rebuilds every day from a fixed list of fields and drops
  // `pinned` when it writes the room back — but it keeps unknown trip-level
  // keys. So a trip with no pinned day and a mirror is one such a device
  // stripped: put the pin back. An unpin here clears both.
  if(!pinSeen && Number.isInteger(t.pinnedDay) && trip.days[t.pinnedDay - 1])
    trip.days[t.pinnedDay - 1].pinned = true;
  syncPinMirror(trip);
  trip.hotels = (t.hotels || []).filter(h => h && h.name);
  trip.days.forEach(d => {
    if(d.startHotelId && !trip.hotels.some(h => h.id === d.startHotelId)) d.startHotelId = null;
    if(d.endHotelId && !trip.hotels.some(h => h.id === d.endHotelId)) d.endHotelId = null;
    // Legacy mirror, for a shared room caught mid-deploy: a device still on
    // the old code reads (and writes back) hotelId/bookend, so carrying them
    // as derived fields means a round-trip through that device keeps the
    // hotels; the migration above restores them from the mirror. On a split
    // day the old model can only hold one hotel — keep the night's.
    d.hideStart = !!d.hideStart;
    d.hideEnd = !!d.hideEnd;
    d.hotelId = d.endHotelId || d.startHotelId;
    d.bookend = d.startHotelId === d.endHotelId ? 'both'
      : !d.startHotelId ? 'end'
      : !d.endHotelId ? 'start'
      : 'end';
  });
  // Unassigned groups: user-made headers on the Unassigned page. Titles must
  // be non-empty and ids unique; each optional entry's membership is checked
  // against the surviving ids so a dangling reference can't orphan a stop.
  const groupIds = new Set();
  trip.optionalGroups = (t.optionalGroups || [])
    .filter(g => g && typeof g.title === 'string' && g.title.trim())
    .map((g, i) => {
      let id = (typeof g.id === 'string' && g.id) ? g.id : 'g' + (i + 1);
      while(groupIds.has(id)) id = 'g' + (i + 1) + '-' + groupIds.size;
      groupIds.add(id);
      return { id, title: g.title.trim(), collapsed: !!g.collapsed };
    });
  trip.optional = (t.optional || []).filter(o => o && t.stops && t.stops[o.id]);
  trip.optional.forEach(o => { o.group = (o.group && groupIds.has(o.group)) ? o.group : null; });
  trip.bin = (t.bin || []).filter(id => t.stops && t.stops[id]);
  // Checklist: drop empties, keep ids unique (they key DOM rows and undo).
  const seenIds = new Set();
  trip.checklist = (t.checklist || [])
    .filter(c => c && typeof c.text === 'string' && c.text.trim())
    .map((c, i) => {
      let id = typeof c.id === 'string' && c.id ? c.id : 'k' + (i + 1);
      while(seenIds.has(id)) id = 'k' + (i + 1) + '-' + seenIds.size;
      seenIds.add(id);
      // A heading is a divider between items: nothing to tick, so never done.
      if(c.type === 'header') return { id, text: c.text.trim(), type:'header', done:false };
      return { id, text: c.text.trim(), done: !!c.done };
    });
  trip.stops = t.stops || {};
  Object.values(trip.stops).forEach(s => {
    if(!Array.isArray(s.tags)) s.tags = [];
    if(s.notes == null) s.notes = '';
    s.done = !!s.done;
    s.hidden = !!s.hidden;
    if(!['walk','cycle','transit','taxi','boat'].includes(s.arriveBy)) s.arriveBy = null;
    // Meal options (see optionsOf in format.js): both fields or neither.
    const alts = Array.isArray(s.alts) ? s.alts.filter(o => o && typeof o.name === 'string' && o.name.trim()) : [];
    if(alts.length){
      alts.forEach(o => {
        if(!Array.isArray(o.tags)) o.tags = [];
        ['img','desc','detail','notes'].forEach(k => { if(typeof o[k] !== 'string') o[k] = ''; });
        if(o.lat == null || o.lng == null){ o.lat = null; o.lng = null; }
        if(!Number.isFinite(o.dur)) o.dur = s.dur;
      });
      s.alts = alts;
      s.altPos = Math.min(Math.max(0, Number.isInteger(s.altPos) ? s.altPos : 0), alts.length);
    } else { delete s.alts; delete s.altPos; }
  });
  return trip;
}

/* Local edits (pinning, moving or deleting days) change the days directly,
   so the mirror is refreshed on every save rather than trusted from load. */
function syncPinMirror(trip){
  const idx = trip.days.findIndex(d => d.pinned);
  trip.pinnedDay = idx >= 0 ? idx + 1 : null;
}

/* Write to this browser only. Applying an incoming change from another
   device uses this rather than saveState(), so it doesn't bounce back out. */
export function persistLocal(){
  syncPinMirror(state.trip);
  try{
    const payload = JSON.stringify({ trip: state.trip });
    const code = currentRoomCode();   // checked live: sharing mid-session moves saves to the room key
    if(code) localStorage.setItem(ROOM_PREFIX + code, payload);
    else sessionStorage.setItem(DRAFT_KEY, payload);
  } catch(e){ console.warn('Could not save trip', e); }
}

/* Called before an incoming remote trip replaces the local one: if the
   incoming copy has no content while the current one does (an emptied or
   clobbered room syncing down), keep the current copy under a side key.
   Nothing in the app reads it — it exists so a wiped trip can be recovered
   by hand from localStorage ('travelPlanner_room_<code>_backup'). */
export function backupRoomCache(incoming){
  try{
    const code = currentRoomCode();
    if(!code) return;
    const content = t => t ? Object.keys(t.stops || {}).length + (t.hotels || []).length : 0;
    if(content(state.trip) && !content(incoming))
      localStorage.setItem(ROOM_PREFIX + code + '_backup', JSON.stringify({ trip: state.trip, savedAt: Date.now() }));
  } catch(e){ console.warn('Could not back up trip', e); }
}

/* Drop the offline cache for a room — used when its shared copy is deleted,
   so the code can't be resurrected from this browser. Takes the safety
   backup with it. */
export function forgetRoomCache(code){
  try{
    localStorage.removeItem(ROOM_PREFIX + code);
    localStorage.removeItem(ROOM_PREFIX + code + '_backup');
  } catch(e){}
}

let cloudPushHook = null;
export function setCloudPushHook(fn){ cloudPushHook = fn; }

/* Every edit ends in saveState(), so this is where a view-only trip (shared,
   and offline — see js/pwa.js) refuses one: a guard returning true means the
   change was not kept, and the guard has put the trip back. */
let saveGuard = null;
export function setSaveGuard(fn){ saveGuard = fn; }

export function saveState(){
  if(saveGuard && saveGuard()) return;
  persistLocal();
  if(cloudPushHook) cloudPushHook();
}

export function pushUndo(){
  state.undoStack.push(JSON.stringify(state.trip));
  if(state.undoStack.length > 30) state.undoStack.shift();
}

export function popUndo(){
  const prev = state.undoStack.pop();
  if(!prev) return false;
  try{
    state.trip = normalizeTrip(JSON.parse(prev));
    saveState();
    return true;
  } catch(e){ return false; }
}

/* The day a trip opens on: its pinned day, else the first. */
export function openingDayIndex(trip = state.trip){
  return Math.max(0, trip.days.findIndex(d => d.pinned));
}

export function replaceTrip(trip){
  state.trip = normalizeTrip(trip);
  state.currentDayIndex = openingDayIndex();
  saveState();
}

export function nextStopId(){
  state.trip.counter = (state.trip.counter || 0) + 1;
  return 'u' + state.trip.counter;    // 'u' prefix: added in the UI (imports use s1…)
}

export function nextHotelId(){
  let n = 1;
  while(state.trip.hotels.some(h => h.id === 'h' + n)) n++;
  return 'h' + n;
}

export function nextChecklistId(){
  let n = 1;
  while(state.trip.checklist.some(c => c.id === 'k' + n)) n++;
  return 'k' + n;
}
