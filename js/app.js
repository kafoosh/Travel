/* =========================================================
   APP ENTRY — load state, wire the UI, attach cloud sync.
   ========================================================= */

import { state, loadState, persistLocal, normalizeTrip, setCloudPushHook } from './state.js';
import { initCloud, scheduleCloudPush, roomFromUrl, cloud } from './cloud.js';
import { renderAll, renderInfo, renderAiPlan, renderCloudUI, wireStaticHandlers, applyTheme, setView } from './ui.js';

/* The tabs that render lazily: renderAll() covers the itinerary views, these
   two rebuild only when they're the one on screen. */
function renderOpenTab(){
  if(state.currentView === 'info') renderInfo();
  if(state.currentView === 'ai') renderAiPlan();
}

loadState();
applyTheme();
wireStaticHandlers();

// Every saveState() call schedules a (debounced) push to the shared room, if any.
setCloudPushHook(scheduleCloudPush);

renderAll();
renderOpenTab();

// Opened via a share link: reflect that immediately rather than flashing
// "saved in this browser only" while Firestore loads.
initCloud({
  getTrip: () => state.trip,
  onStatus: renderCloudUI,
  onRemoteTrip: (t) => {
    state.trip = normalizeTrip(t);
    persistLocal();     // not saveState() — that would echo the change back up
    applyTheme();
    renderAll();
    renderOpenTab();
  },
});
renderCloudUI();

if(roomFromUrl() && cloud.status === 'connecting'){
  setTimeout(() => {
    if(cloud.status === 'connecting'){
      cloud.status = 'error';
      cloud.error = 'Sync didn’t load. Check the connection and reload — your own changes are still saved on this device.';
      renderCloudUI();
    }
  }, 12000);
}
