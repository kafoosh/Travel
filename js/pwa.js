/* =========================================================
   INSTALLED APP + OFFLINE

   The live planner as an installable, offline-first app — a
   second offline path beside the single-file export in
   offline.js, which this leaves alone.

   - Launch: an installed app opens at the manifest's
     start_url, which can't carry a #trip= hash. So the last
     room this browser opened is remembered, and a launch
     (never a plain visit — the bare URL still means "new
     blank trip") puts it back in the URL before anything
     reads it.
   - Service worker (sw.js): registered here. A new version
     downloads in the background and waits; the page offers a
     "Reload" banner, and a version still waiting at the next
     launch is switched to straight away.
   - Offline: a shared trip is view-only while there's no
     connection — edits can't reach the room, and two devices
     editing apart would overwrite each other on reconnect.
   - Photos: the stop photos of the last few trips opened are
     handed to the service worker to keep, so a trip renders
     with its pictures offline.
   ========================================================= */

const LAST_ROOM_KEY = 'travelPlanner_lastRoom_v1';
const RECENT_KEY = 'travelPlanner_recentRooms_v1';
export const RECENT_LIMIT = 5;   // trips whose photos are kept offline

const roomInHash = () => {
  const m = /[#&]trip=([a-z0-9]{12,40})/.exec(location.hash || '');
  return m ? m[1] : null;
};

/* ---------- launch ---------- */

/* Decided once, at load: restoreLaunchRoom() tidies ?source=pwa off the URL. */
const LAUNCHED_AS_APP = typeof location !== 'undefined' && (() => {
  if(/(?:^|[?&])source=pwa(?:&|$)/.test(location.search)) return true;
  try{
    if(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch(e){}
  return navigator.standalone === true;   // iOS Safari home-screen app
})();
export const launchedAsApp = () => LAUNCHED_AS_APP;

/* Must run before loadState()/initCloud(): both read the hash. */
export function restoreLaunchRoom(){
  const isApp = LAUNCHED_AS_APP;
  // Tidy the marker off the URL (a shared link copied from the app
  // shouldn't carry it). ?newTrip=1 is left for state.js to consume.
  if(/(?:^|[?&])source=pwa(?:&|$)/.test(location.search)){
    const rest = location.search.replace(/(^\?|&)source=pwa(?=&|$)/, '$1').replace(/^\?&/, '?').replace(/^\?$/, '');
    history.replaceState(null, '', location.pathname + rest + location.hash);
  }
  if(!isApp || roomInHash()) return;
  if(/(?:^|[?&])newTrip=1(?:&|$)/.test(location.search)) return;   // "New trip" asked for a blank one
  let code = null;
  try{ code = localStorage.getItem(LAST_ROOM_KEY); } catch(e){}
  if(code && /^[a-z0-9]{12,40}$/.test(code))
    history.replaceState(null, '', location.pathname + location.search + '#trip=' + code);
}

/* ---------- per-trip manifest (iOS) ----------
   An iOS home-screen app starts with empty storage and opens at the
   manifest's start_url, so the generic "./?source=pwa" gives it no trip at
   all. While a shared trip is open in iOS Safari, the page links a manifest
   whose start_url carries that trip instead — each home-screen icon is then
   one trip, and it downloads and keeps its own copy on first launch. (If
   Safari won't read the generated manifest, there is no other one linked,
   and it falls back to the page's own URL — which carries the trip too.)
   Elsewhere the static manifest.json stays: an installed Chrome/Edge app
   shares the browser's storage, so restoreLaunchRoom() already finds the
   last trip. */

export function isIOS(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function roomManifestUrl(code, name){
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const label = (name || '').trim() || 'Travel Planner';
  const manifest = {
    id: base + '?trip=' + code,
    name: label,
    short_name: label.length > 20 ? label.slice(0, 19) + '…' : label,
    start_url: base + '?source=pwa#trip=' + code,
    scope: base,
    display: 'standalone',
    theme_color: '#C1502E',
    background_color: '#E9DFC6',
    icons: [
      { src: base + 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: base + 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
  return 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(manifest));
}

/* Point the manifest link (and the home-screen label) at the trip on screen.
   Call whenever the room or the trip's name may have changed. */
export function syncManifest(tripName){
  if(typeof document === 'undefined' || launchedAsApp()) return;
  const code = roomInHash();
  let link = document.querySelector('link[rel="manifest"]');
  const href = isIOS() && code ? roomManifestUrl(code, tripName) : 'manifest.json';
  if(!link){
    link = document.createElement('link');
    link.rel = 'manifest';
    document.head.appendChild(link);
  }
  if(link.getAttribute('href') !== href) link.setAttribute('href', href);
  const title = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if(title) title.setAttribute('content', code && tripName ? tripName : 'Travel');
}

/* ---------- which rooms this browser has opened ---------- */

export function recentRooms(){
  try{
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter(c => typeof c === 'string') : [];
  } catch(e){ return []; }
}

export function rememberRoom(code){
  if(!code) return;
  try{
    localStorage.setItem(LAST_ROOM_KEY, code);
    const list = [code, ...recentRooms().filter(c => c !== code)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch(e){}
}

/* Left or deleted: the app shouldn't reopen it at launch. Deleted rooms
   also leave the recent list, which drops their cached photos. */
export function forgetLaunchRoom(code, { deleted = false } = {}){
  try{
    if(localStorage.getItem(LAST_ROOM_KEY) === code) localStorage.removeItem(LAST_ROOM_KEY);
    if(deleted){
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentRooms().filter(c => c !== code)));
      postToWorker({ type: 'keep-photos', keep: recentRooms() });
    }
  } catch(e){}
}

/* ---------- online / offline ---------- */

export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/* A shared trip with no connection can be read, not edited. An unshared
   draft has nowhere to sync to, so it stays editable. */
export const isViewOnly = () => isOffline() && !!roomInHash();

export function onConnectivityChange(fn){
  window.addEventListener('online', () => fn(true));
  window.addEventListener('offline', () => fn(false));
}

/* ---------- service worker ---------- */

let registration = null;

function postToWorker(msg){
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if(sw) sw.postMessage(msg);
}

/* `onUpdateReady(apply)` is called when a new version has downloaded while
   this page is open; calling `apply()` switches to it and reloads. */
export async function registerServiceWorker({ onUpdateReady } = {}){
  if(!('serviceWorker' in navigator)) return;
  // Only over http(s) with a real origin — never from file:// or a sandbox.
  if(!/^https?:$/.test(location.protocol)) return;
  // A page that booted without a worker gets claimed by the first one — that
  // isn't an update, so it only reloads on a swap it asked for (`applying`).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false, applying = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(!reloading && (hadController || applying)){ reloading = true; location.reload(); }
  });

  try{
    registration = await navigator.serviceWorker.register('sw.js');
  } catch(e){ console.warn('Service worker registration failed', e); return; }

  const apply = (worker) => { if(worker){ applying = true; worker.postMessage({ type: 'skip-waiting' }); } };

  // A version that finished downloading in an earlier session and is still
  // waiting: this launch is the "next launch", so switch now.
  if(registration.waiting && hadController){ apply(registration.waiting); return; }

  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if(!worker) return;
    worker.addEventListener('statechange', () => {
      // First install (no controller yet) isn't an update — nothing to offer.
      if(worker.state === 'installed' && navigator.serviceWorker.controller && onUpdateReady)
        onUpdateReady(() => apply(worker));
    });
  });

  // An installed app can sit in the background for days: look for a new
  // version whenever it comes back to the front, at most every few minutes.
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState !== 'visible' || isOffline()) return;
    if(Date.now() - lastCheck < 5 * 60 * 1000) return;
    lastCheck = Date.now();
    registration.update().catch(() => {});
  });
}

/* ---------- trip photos ---------- */

let lastPhotoSig = '';

/* Hand the working URLs of a room's photos to the service worker to keep.
   Skipped offline, without a controlling worker, or when nothing changed. */
export function cachePhotosForRoom(code, urls){
  if(!code || isOffline() || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  const list = [...new Set(urls.filter(Boolean))].sort();
  const sig = code + '|' + list.join('|');
  if(sig === lastPhotoSig) return;
  lastPhotoSig = sig;
  postToWorker({ type: 'cache-photos', room: code, urls: list, keep: recentRooms() });
}
