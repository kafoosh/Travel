/* =========================================================
   APP ENTRY — load state, wire the UI, attach cloud sync.
   ========================================================= */

import { state, loadState, persistLocal, normalizeTrip, setCloudPushHook, backupRoomCache } from './state.js';
import { initCloud, scheduleCloudPush, roomFromUrl, cloud } from './cloud.js';
import { renderAll, renderInfo, renderAiPlan, renderCloudUI, wireStaticHandlers, applyTheme, setView, setTripLoading } from './ui.js';

/* The tabs that render lazily: renderAll() covers the itinerary views, these
   two rebuild only when they're the one on screen. */
function renderOpenTab(){
  if(state.currentView === 'info') renderInfo();
  if(state.currentView === 'ai') renderAiPlan();
}

const restored = loadState();
applyTheme();
wireStaticHandlers();

// Every saveState() call schedules a (debounced) push to the shared room, if any.
setCloudPushHook(scheduleCloudPush);

/* A share link opened where this browser holds no cached copy of the room has
   nothing to draw until Firestore answers — and answering takes three
   round-trips in sequence (SDK modules, sign-in, first snapshot). Rendering
   now would put "Untitled Trip", three empty days and the default theme on
   screen for the whole of that, which reads as a broken link rather than as
   loading. So hold the first render, and show the loading line instead. */
const awaitingRoom = !!roomFromUrl() && !restored && cloud.configured;
let patience = null;
let rendered = false;

/* Draw the trip. The first call also takes the loading gate down; later ones
   (a remote edit landing) are ordinary re-renders. */
function renderTrip(){
  if(!rendered){
    rendered = true;
    clearTimeout(patience);
    setTripLoading(false);
  }
  renderAll();
  renderOpenTab();
}

if(awaitingRoom) setTripLoading(true);

// Started before the first render so the network is already in flight while
// the page draws. Opened via a share link, this also reflects that state
// immediately rather than flashing "saved in this browser only".
initCloud({
  getTrip: () => state.trip,
  onStatus: () => {
    renderCloudUI();
    // Nothing more is coming — a deleted room, a bad link, an unreachable
    // Firestore. Show the planner and let the chip explain itself. Guarded on
    // the gate being up at all: without a gate the boot render below owns the
    // first paint, and an error raised synchronously here would double it.
    if(awaitingRoom && cloud.status === 'error') renderTrip();
  },
  onRemoteTrip: (t) => {
    backupRoomCache(t); // an emptied room syncing down leaves a recoverable copy
    state.trip = normalizeTrip(t);
    persistLocal();     // not saveState() — that would echo the change back up
    renderTrip();
  },
});
renderCloudUI();

/* However slow the room is, stop waiting well inside the 12s sync-error
   timeout below: a trip that hasn't arrived should leave someone on a usable
   planner with a "connecting" chip, not on a spinner. It still lands when it
   lands — onRemoteTrip re-renders either way. */
if(awaitingRoom) patience = setTimeout(renderTrip, 4500);
else renderTrip();

if(roomFromUrl() && cloud.status === 'connecting'){
  setTimeout(() => {
    if(cloud.status === 'connecting'){
      cloud.status = 'error';
      cloud.error = 'Sync didn’t load. Check the connection and reload — your own changes are still saved on this device.';
      renderCloudUI();
    }
  }, 12000);
}
