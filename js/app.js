/* =========================================================
   APP ENTRY — load state, wire the UI, attach cloud sync.
   ========================================================= */

import { state, loadState, persistLocal, normalizeTrip, setCloudPushHook, setSaveGuard, backupRoomCache } from './state.js';
import { initCloud, resumeCloud, scheduleCloudPush, roomFromUrl, cloud } from './cloud.js';
import { renderAll, renderInfo, renderAiPlan, renderCloudUI, wireStaticHandlers, applyTheme, setView, setTripLoading,
  setTripLoadingText, showUpdateBanner, flashNote, updateUndoButton } from './ui.js';
import { restoreLaunchRoom, registerServiceWorker, isOffline, isViewOnly, onConnectivityChange, cachePhotosForRoom,
  syncManifest, launchedAsApp } from './pwa.js';
import { photoUrls } from './offline.js';
import { resolveImage } from './img.js';
import { debounce } from './util.js';

/* The tabs that render lazily: renderAll() covers the itinerary views, these
   two rebuild only when they're the one on screen. */
function renderOpenTab(){
  if(state.currentView === 'info') renderInfo();
  if(state.currentView === 'ai') renderAiPlan();
}

// An installed app launches without the #trip= hash — put the last room back
// before anything reads the URL.
restoreLaunchRoom();

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
let savedNoticeShown = false;
let rendered = false;

/* Draw the trip. The first call also takes the loading gate down; later ones
   (a remote edit landing) are ordinary re-renders. */
function renderTrip(){
  if(!rendered){
    rendered = true;
    clearTimeout(patience);
    setTripLoading(false);
  }
  redraw();
  cacheTripPhotos();
}

/* Re-render without touching the loading gate. */
function redraw(){
  renderAll();
  renderOpenTab();
  syncManifest(state.trip.name);   // "Add to Home Screen" on iOS keeps this trip
}

/* A share link this device has never opened, with no connection: there is
   nothing to show, and nothing will come until the network does. Say so,
   rather than spinning — and don't give up to a blank trip either. */
const OPENING_TEXT = 'Opening the shared trip…';
const NEEDS_NETWORK_TEXT = 'This trip needs an internet connection the first time it’s opened on this device. It will load by itself once you’re back online.';
const stuckOffline = () => awaitingRoom && !rendered && isOffline();

if(awaitingRoom){
  setTripLoading(true);
  if(isOffline()) setTripLoadingText(NEEDS_NETWORK_TEXT, { spinning: false });
}

/* ---------- view-only while offline ----------
   Edit controls are dimmed (html.view-only, set in renderAll), and this is
   the backstop for any that slip through: an edit that reaches saveState()
   is undone by reloading the last kept copy, and the undo steps it pushed
   are dropped. */
let undoMark = state.undoStack.length;
setSaveGuard(() => {
  if(!isViewOnly()) return false;
  loadState();
  state.undoStack.length = Math.min(state.undoStack.length, undoMark);
  redraw();
  flashNote('You’re offline — this shared trip is view-only until the connection returns.');
  return true;
});

onConnectivityChange((online) => {
  undoMark = state.undoStack.length;
  if(online){
    resumeCloud();
    if(awaitingRoom && !rendered){
      setTripLoadingText(OPENING_TEXT);
      clearTimeout(patience);
      patience = setTimeout(renderTrip, 4500);
    }
  } else if(stuckOffline()){
    setTripLoadingText(NEEDS_NETWORK_TEXT, { spinning: false });
  }
  if(rendered) redraw();
  else updateUndoButton();
  renderCloudUI();
  if(roomFromUrl()) flashNote(online ? 'Back online — changes sync again.' : 'Offline — this shared trip is view-only for now.');
  if(online) cacheTripPhotos();
});

/* ---------- photos for offline ----------
   Once a shared trip is on screen (and again after edits settle), hand the
   working URL of every photo in it to the service worker to keep. */
const cacheTripPhotos = debounce(async () => {
  const code = roomFromUrl();
  if(!code || isOffline()) return;
  const urls = await Promise.all(photoUrls(state.trip).map(u => resolveImage(u)));
  if(roomFromUrl() === code) cachePhotosForRoom(code, urls);
}, 4000);

registerServiceWorker({ onUpdateReady: showUpdateBanner }).then(() => {
  // The very first install claims this page a moment after it loads; the
  // photos queued before that had no worker to go to.
  if(navigator.serviceWorker) navigator.serviceWorker.ready.then(() => setTimeout(cacheTripPhotos, 1500));
});

// Started before the first render so the network is already in flight while
// the page draws. Opened via a share link, this also reflects that state
// immediately rather than flashing "saved in this browser only".
initCloud({
  getTrip: () => state.trip,
  onStatus: () => {
    renderCloudUI();
    syncManifest(state.trip.name);   // a room was joined, created or left
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
    /* An installed app's first sight of its trip — on iOS, the first launch
       after "Add to Home Screen", which starts with empty storage. Say that
       it's now kept, so nobody has to find out on a plane. */
    if(!restored && !savedNoticeShown && launchedAsApp()){
      savedNoticeShown = true;
      flashNote('✓ Trip saved on this device — it will open offline from now on.', 5000);
    }
  },
});
renderCloudUI();

/* However slow the room is, stop waiting well inside the 12s sync-error
   timeout below: a trip that hasn't arrived should leave someone on a usable
   planner with a "connecting" chip, not on a spinner. It still lands when it
   lands — onRemoteTrip re-renders either way. */
if(awaitingRoom){ if(!isOffline()) patience = setTimeout(renderTrip, 4500); }
else renderTrip();

if(roomFromUrl() && cloud.status === 'connecting' && !isOffline()){
  setTimeout(() => {
    if(cloud.status === 'connecting'){
      cloud.status = 'error';
      cloud.error = 'Sync didn’t load. Check the connection and reload — your own changes are still saved on this device.';
      renderCloudUI();
    }
  }, 12000);
}
