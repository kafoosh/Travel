/* =========================================================
   SHARED TRIPS (Cloud Firestore)

   A room is only created when someone clicks "Create a share
   link" — until then nothing leaves the browser. The code in
   the URL (#trip=…) is the only key there is: anyone holding
   the link edits the same trip. If FIREBASE_CONFIG is null
   (see config.js) this module reports 'unconfigured' and the
   site runs local-only.

   Write safety: a device may only write to a room it just
   created, or one whose contents it has already received
   (`hydrated`). Firestore reports "document doesn't exist"
   from its local cache while the backend is unreachable —
   trusting that, or pushing edits made before the first sync
   arrived, is how a blank or stale device once wiped a
   populated room.
   ========================================================= */

import { FIREBASE_CONFIG } from './config.js';
import { isValidTrip } from './format.js';
import { rememberRoom, forgetLaunchRoom, isOffline } from './pwa.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const CLIENT_ID = Math.random().toString(36).slice(2, 10);

let api = null;              // firestore adapter once loaded
let unsub = null;
let joining = false;          // a joinRoom() is between detach() and subscribe()
let pushTimer = null;
let pushPending = false;      // an edit is waiting out the push debounce
/* A room this client created whose first write hasn't landed yet: a retry
   of its join must still be allowed to write it into existence. */
let pendingNew = false;
/* Write-safety latch: set once this client created the current room, or has
   applied its contents from a snapshot. Every cloud write is gated on it. */
let hydrated = false;
let onRemoteTrip = null;     // callback(trip)
let onStatus = null;         // callback() — read cloud.* for details
let getTrip = null;          // () => current trip object

/* `arriving` separates the two ways a room reaches 'connecting': opening one
   that already exists (a share link) from creating one (the Save button).
   They look identical in `status`, but they want opposite words on screen. */
export const cloud = { room: null, status: 'local', error: null, lastSync: null, note: null, arriving: false, retrying: false, configured: !!FIREBASE_CONFIG };

function setStatus(status, error){
  cloud.status = status;
  cloud.error = error || null;
  if(status !== 'connecting') cloud.arriving = false;
  if(status === 'synced'){ cloud.lastSync = Date.now(); resetRetry(); }
  if(status !== 'connecting') clearTimeout(stallTimer);
  if(onStatus) onStatus();
}

/* ---------- automatic retry ----------
   A failure that's about the network (no answer, a dropped connection, the
   SDK modules not loading) is tried again on its own — 15s, then doubling
   up to every 5 minutes, until a sync lands. Failures another attempt won't
   fix (a deleted room, rules that refuse, sign-in switched off) are not. */
const RETRY_FIRST = 15 * 1000;
const RETRY_MAX = 5 * 60 * 1000;
let retryTimer = null;
let retryDelay = RETRY_FIRST;

function isTransient(e){
  const code = (e && e.code) || '';
  if(!code) return true;     // a failed module import or fetch: no code, and worth another go
  return ['unavailable', 'deadline-exceeded', 'auth/network-request-failed', 'auth/internal-error',
    'internal', 'resource-exhausted', 'aborted', 'cancelled', 'unknown'].includes(code);
}

function failed(e){
  const again = isTransient(e);
  cloud.retrying = again;    // set before the status goes out: listeners read it
  setStatus('error', errorMessage(e));
  if(again) scheduleRetry();
}

function scheduleRetry(){
  clearTimeout(retryTimer);
  cloud.retrying = true;
  retryTimer = setTimeout(retryNow, retryDelay);
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
  if(onStatus) onStatus();   // the status text mentions the retry
}

function resetRetry(){
  clearTimeout(retryTimer);
  retryTimer = null;
  cloud.retrying = false;
  retryDelay = RETRY_FIRST;
}

function retryNow(){
  retryTimer = null;
  const code = roomFromUrl();
  if(!code || code !== cloud.room || cloud.status !== 'error') return;
  // Nothing to gain offline or in the background — the 'online' event and
  // the return-to-foreground refresh both try straight away anyway.
  if(joining || isOffline() || document.visibilityState === 'hidden'){ scheduleRetry(); return; }
  joinRoom(code, { expectNew: pendingNew });
}

/* Every join gets 12s to produce its first snapshot. One that doesn't —
   a hung module load, a socket that never opens — is reported, and retried
   like any other network failure rather than left on "Connecting…". */
const STALL_MS = 12 * 1000;
let stallTimer = null;

function watchForStall(){
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if(cloud.status !== 'connecting' || isOffline()) return;
    cloud.retrying = true;
    setStatus('error', 'Sync didn’t load. Your own changes are still saved on this device.');
    scheduleRetry();
  }, STALL_MS);
}

function errorMessage(e, what){
  const code = (e && e.code) || '';
  if(code === 'auth/operation-not-allowed')
    return 'Anonymous sign-in is switched off for this Firebase project — turn it on under Authentication → Sign-in method.';
  if(code === 'permission-denied' && what === 'delete')
    return 'Firestore refused the delete. The published rules probably still say “allow delete: if false” — see the README for the rule that permits it.';
  if(code === 'permission-denied')
    return 'Firestore refused the request. Check the security rules have been published.';
  if(code === 'unavailable' || code === 'auth/network-request-failed')
    return 'Can’t reach Firestore. Changes are saved on this device and will go up when the connection returns.';
  if(!code && e instanceof TypeError)       // fetch() couldn't connect at all
    return 'Can’t reach the sync server right now. Changes are saved on this device.';
  return (e && e.message) || String(e);
}

/* Shown when the server confirms the room's doc doesn't exist and this
   client didn't just create it: the room was deleted, or the link is bad. */
function missingRoomMessage(){
  const t = getTrip && getTrip();
  const hasContent = !!(t && (Object.keys(t.stops || {}).length || (t.hotels || []).length));
  return 'This room no longer exists on the server — it may have been deleted, or the link may be incomplete. Nothing was written to it from this device.'
    + (hasContent ? ' The trip shown here is this device’s own copy — “Duplicate to a new room” shares it at a fresh link.' : '');
}

export function newRoomCode(){
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
export function roomFromUrl(){
  const m = /[#&]trip=([a-z0-9]{12,40})/.exec(location.hash || '');
  return m ? m[1] : null;
}
export function shareUrl(code){
  return location.origin + location.pathname + '#trip=' + code;
}

/* Browsers remember a failed module import for the life of the page: once
   import() of the SDK has failed (a flaky connection at launch), every later
   import() of it fails at once without touching the network, so no retry or
   reconnect could ever recover. So first check the files can be fetched —
   a failed fetch() isn't remembered — and only import once they can (the
   import is then served from the HTTP cache). If an import fails even so,
   only a reload can fix it, and the error says so instead of retrying. */
const SDK_FILES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => `${SDK}/${f}`);
let sdkBroken = false;

async function loadFirebase(){
  if(api || !FIREBASE_CONFIG) return api;
  const reloadError = () => Object.assign(new Error('Sync couldn’t load its code. Reload the page to reconnect — your changes are still saved on this device.'), { code: 'sdk-broken' });
  if(sdkBroken) throw reloadError();
  await Promise.all(SDK_FILES.map(async u => {
    const res = await fetch(u);            // throws (no code ⇒ retried) when unreachable
    if(!res.ok) throw new Error('Couldn’t load the sync code (HTTP ' + res.status + ').');
  }));
  let mods;
  try{ mods = await Promise.all(SDK_FILES.map(u => import(u))); }
  catch(e){ sdkBroken = true; throw reloadError(); }
  const [appMod, authMod, fsMod] = mods;
  const app = appMod.initializeApp(FIREBASE_CONFIG);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);
  api = {
    serverTimestamp: fsMod.serverTimestamp,
    signIn: () => auth.currentUser ? Promise.resolve(auth.currentUser) : authMod.signInAnonymously(auth),
    write: (code, payload) => fsMod.setDoc(fsMod.doc(db, 'trips', code), payload),
    remove: (code) => fsMod.deleteDoc(fsMod.doc(db, 'trips', code)),
    subscribe: (code, onData, onError) =>
      fsMod.onSnapshot(fsMod.doc(db, 'trips', code), snap => onData({
        exists: snap.exists(),
        pending: snap.metadata.hasPendingWrites,
        fromCache: snap.metadata.fromCache,
        data: snap.data(),
      }), onError),
  };
  return api;
}

export function initCloud(handlers){
  onRemoteTrip = handlers.onRemoteTrip;
  onStatus = handlers.onStatus;
  getTrip = handlers.getTrip;
  const code = roomFromUrl();
  if(!FIREBASE_CONFIG){
    setStatus(code ? 'error' : 'local', code
      ? 'This link points at a shared trip, but sharing isn’t configured on this deployment (see README).'
      : null);
    return;
  }
  if(!code) return;
  // No connection: the room's cached copy (if any) is what's shown, and
  // resumeCloud() joins once the connection returns.
  if(isOffline()){ cloud.room = code; setStatus('connecting'); return; }
  joinRoom(code);
}

/* Back online: join the room from the URL if nothing is listening to it —
   the app was opened offline, or the first join failed for lack of network —
   or if what is listening is stuck in an error. A healthy listener
   reconnects by itself and is left alone. */
export function resumeCloud(){
  const code = roomFromUrl();
  if(!FIREBASE_CONFIG || !code || joining) return;
  if(unsub && cloud.status !== 'error') return;
  resetRetry();
  joinRoom(code, { expectNew: pendingNew });
}

/* Back in the foreground after a while (app.js): a phone may have dropped
   the connection while the app was suspended, and edits from other devices
   may be waiting. Send anything this device still owes the room, then
   re-subscribe for a fresh copy from the server. */
export async function refreshRoom(){
  const code = roomFromUrl();
  if(!FIREBASE_CONFIG || !code || code !== cloud.room || joining || isOffline()) return;
  if(pushPending){
    clearTimeout(pushTimer);
    // A write only settles once the server acknowledges it; don't let a
    // half-dead connection hold the refresh up for ever.
    await Promise.race([pushNow(), new Promise(r => setTimeout(r, 5000))]);
  }
  if(joining || roomFromUrl() !== code) return;
  resetRetry();
  joinRoom(code, { expectNew: pendingNew });
}

export async function joinRoom(code, opts = {}){
  const expectNew = !!opts.expectNew;   // true only for a room this client just created
  detach();
  pendingNew = expectNew;
  cloud.room = code;
  cloud.arriving = !expectNew;
  hydrated = expectNew;
  rememberRoom(code);        // reopened by the installed app at launch
  setStatus('connecting');
  watchForStall();
  joining = true;
  try{
    await loadFirebase();
    await api.signIn();
    let seeded = false;        // room seen with contents, or seeded by us
    let firstSnapshot = true;
    unsub = api.subscribe(code, snap => {
      if(snap.pending) return;
      if(!snap.exists){
        /* A cache-served miss only means the backend is unreachable and the
           doc isn't in the SDK's local cache — it proves nothing about the
           room, so it must never trigger a write. */
        if(snap.fromCache) return;
        if(expectNew && !seeded){ seeded = true; pushNow(); }   // first write of a just-created room
        else { hydrated = false; setStatus('error', missingRoomMessage()); }  // deleted or bad link — stop writing
        return;
      }
      seeded = true;
      pendingNew = false;
      if(snap.data && snap.data.updatedBy === CLIENT_ID){ hydrated = true; setStatus('synced'); return; }
      if(snap.data && isValidTrip(snap.data.trip)){
        hydrated = true;       // the room's real contents are in — writing is safe now
        onRemoteTrip(snap.data.trip);
        if(!firstSnapshot){
          cloud.note = 'Just updated from another device';
          clearTimeout(cloud.noteTimer);
          cloud.noteTimer = setTimeout(() => { cloud.note = null; if(onStatus) onStatus(); }, 5000);
        }
      }
      firstSnapshot = false;
      setStatus('synced');
    }, e => {
      // A listener that errors is finished: drop it, so a rejoin isn't
      // mistaken for "already listening".
      if(unsub){ unsub(); unsub = null; }
      failed(e);
    });
    /* Status stays 'connecting' until the first snapshot arrives — claiming
       'synced' here used to put a reassuring label over a trip that hadn't
       loaded yet. */
  } catch(e){
    failed(e);
  } finally {
    joining = false;
  }
}

/* Stop listening and cancel any queued write, so nothing further lands in
   the room we're about to leave behind. */
function detach(){
  if(unsub){ unsub(); unsub = null; }
  clearTimeout(pushTimer);
  pushPending = false;
  clearTimeout(retryTimer);  // a new attempt (or none) replaces any queued one
  retryTimer = null;
  cloud.retrying = false;
  clearTimeout(stallTimer);
  hydrated = false;          // detached ⇒ not writable
}

function notConfigured(){
  setStatus('error', 'Sharing isn’t configured on this deployment — see the README for the two-minute Firebase setup.');
  return false;
}

async function openNewRoom(){
  const code = newRoomCode();
  history.replaceState(null, '', shareUrl(code));
  await joinRoom(code, { expectNew: true });
  await pushNow();
  return cloud.status !== 'error';
}

export async function createRoom(){
  if(!FIREBASE_CONFIG) return notConfigured();
  return openNewRoom();
}

/* Copy the trip into a brand-new room and move this browser to it. The
   original room keeps whatever it holds now: we detach first, so neither
   `beforeCopy` nor any later edit can reach it. */
export async function duplicateRoom(beforeCopy){
  if(!FIREBASE_CONFIG) return notConfigured();
  detach();
  if(beforeCopy) beforeCopy();
  return openNewRoom();
}

/* Delete the shared copy outright. Returns { code } so the caller can drop
   the room's local cache, or { error } if Firestore refused — the error is
   returned rather than left in cloud.status, which the re-subscribe below
   would immediately overwrite with 'synced'. */
export async function deleteRoom(){
  const code = cloud.room;
  if(!code || !api) return { error: 'This trip isn’t in a shared room.' };
  detach();
  try{
    await api.remove(code);
  } catch(e){
    await joinRoom(code);            // still ours — go back to watching it
    return { error: errorMessage(e, 'delete') };
  }
  cloud.room = null; cloud.note = null;
  resetRetry();
  pendingNew = false;
  forgetLaunchRoom(code, { deleted: true });
  history.replaceState(null, '', location.origin + location.pathname);
  setStatus('local');
  return { code };
}

export function leaveRoom(){
  detach();
  resetRetry();
  pendingNew = false;
  if(cloud.room) forgetLaunchRoom(cloud.room);
  cloud.room = null; cloud.note = null;
  history.replaceState(null, '', location.origin + location.pathname);
  setStatus('local');
}

export function scheduleCloudPush(){
  if(!cloud.room || !api || !hydrated) return;
  clearTimeout(pushTimer);
  pushPending = true;
  pushTimer = setTimeout(pushNow, 800);
}

async function pushNow(){
  pushPending = false;
  if(!cloud.room || !api || !hydrated) return;
  try{
    await api.write(cloud.room, {
      trip: getTrip(),
      updatedBy: CLIENT_ID,
      updatedAt: api.serverTimestamp(),
    });
    pendingNew = false;        // the room exists now
    setStatus('synced');
  } catch(e){
    setStatus('error', errorMessage(e));
  }
}

export function cloudStatusText(){
  if(isOffline()) return cloud.room
    ? 'Offline — this is the copy of the trip saved on this device, and it’s view-only until the connection returns. Syncing picks up again by itself.'
    : 'Offline — this unshared trip still saves in this tab. Share it once you’re back online.';
  if(cloud.status === 'error') return 'Sync problem: ' + cloud.error + (cloud.retrying ? ' Trying again automatically.' : '');
  if(cloud.status === 'connecting') return 'Connecting…';
  if(cloud.status === 'synced'){
    const t = cloud.lastSync ? new Date(cloud.lastSync).toLocaleTimeString() : '';
    return (cloud.note ? cloud.note + ' · ' : '') + 'Shared and syncing' + (t ? ' · last change ' + t : '') + '.';
  }
  if(!cloud.configured) return 'Sharing is not set up on this deployment yet — this trip lives in this browser tab only. (One-time setup in the README.)';
  return 'This trip lives in this browser tab only — create a share link to save it and get a URL you can come back to.';
}
