/* =========================================================
   APP STATE + PERSISTENCE + UNDO
   The whole trip is one JSON-serialisable object (see
   format.blankTrip). Undo snapshots the entire trip — the
   structure is user-editable everywhere, so partial snapshots
   aren't worth the bugs.
   ========================================================= */

import { blankTrip, isValidTrip } from './format.js';

const STORAGE_KEY = 'travelPlanner_v1';

export const state = {
  trip: blankTrip(),
  currentDayIndex: 0,
  currentView: 'days',    // 'days' | 'bin' | 'optional' | 'info'
  mobilePane: 'list',
  undoStack: [],
};

export function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const saved = JSON.parse(raw);
      if(isValidTrip(saved.trip)) state.trip = normalizeTrip(saved.trip);
    }
  } catch(e){ console.warn('Could not load saved trip', e); }
}

/* Fill any holes in a trip object that came from storage, an import,
   or another device, so the rest of the code can assume shape. */
export function normalizeTrip(t){
  const base = blankTrip();
  const trip = { ...base, ...t };
  trip.info = { ...base.info, ...(t.info || {}) };
  trip.days = (t.days || []).map((d, i) => ({
    id: i + 1, title: d.title || ('Day ' + (i + 1)), start: d.start || '09:00',
    hotelId: d.hotelId || null, order: Array.isArray(d.order) ? d.order.filter(id => t.stops && t.stops[id]) : [],
  }));
  if(!trip.days.length) trip.days = base.days;
  trip.hotels = (t.hotels || []).filter(h => h && h.name);
  trip.optional = (t.optional || []).filter(o => o && t.stops && t.stops[o.id]);
  trip.bin = (t.bin || []).filter(id => t.stops && t.stops[id]);
  trip.stops = t.stops || {};
  Object.values(trip.stops).forEach(s => {
    if(!Array.isArray(s.tags)) s.tags = [];
    if(s.notes == null) s.notes = '';
  });
  return trip;
}

/* Write to this browser only. Applying an incoming change from another
   device uses this rather than saveState(), so it doesn't bounce back out. */
export function persistLocal(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ trip: state.trip }));
  } catch(e){ console.warn('Could not save trip', e); }
}

let cloudPushHook = null;
export function setCloudPushHook(fn){ cloudPushHook = fn; }

export function saveState(){
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

export function replaceTrip(trip){
  state.trip = normalizeTrip(trip);
  state.currentDayIndex = 0;
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
