/* =========================================================
   SHARED TRIPS (Cloud Firestore)

   A room is only created when someone clicks "Create a share
   link" — until then nothing leaves the browser. The code in
   the URL (#trip=…) is the only key there is: anyone holding
   the link edits the same trip. If FIREBASE_CONFIG is null
   (see config.js) this module reports 'unconfigured' and the
   site runs local-only.
   ========================================================= */

import { FIREBASE_CONFIG } from './config.js';
import { isValidTrip } from './format.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const CLIENT_ID = Math.random().toString(36).slice(2, 10);

let api = null;              // firestore adapter once loaded
let unsub = null;
let pushTimer = null;
let onRemoteTrip = null;     // callback(trip)
let onStatus = null;         // callback() — read cloud.* for details
let getTrip = null;          // () => current trip object

export const cloud = { room: null, status: 'local', error: null, lastSync: null, note: null, configured: !!FIREBASE_CONFIG };

function setStatus(status, error){
  cloud.status = status;
  cloud.error = error || null;
  if(status === 'synced') cloud.lastSync = Date.now();
  if(onStatus) onStatus();
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
  return (e && e.message) || String(e);
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

async function loadFirebase(){
  if(api || !FIREBASE_CONFIG) return api;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
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
  if(code) joinRoom(code);
}

export async function joinRoom(code){
  cloud.room = code;
  setStatus('connecting');
  try{
    await loadFirebase();
    await api.signIn();
    if(unsub){ unsub(); unsub = null; }
    let seeded = false;
    let firstSnapshot = true;
    unsub = api.subscribe(code, snap => {
      if(snap.pending) return;
      if(!snap.exists){
        if(!seeded){ seeded = true; pushNow(); }   // adopt a never-written room
        return;
      }
      seeded = true;
      if(snap.data && snap.data.updatedBy === CLIENT_ID){ setStatus('synced'); return; }
      if(snap.data && isValidTrip(snap.data.trip)){
        onRemoteTrip(snap.data.trip);
        if(!firstSnapshot){
          cloud.note = 'Just updated from another device';
          clearTimeout(cloud.noteTimer);
          cloud.noteTimer = setTimeout(() => { cloud.note = null; if(onStatus) onStatus(); }, 5000);
        }
      }
      firstSnapshot = false;
      setStatus('synced');
    }, e => setStatus('error', errorMessage(e)));
    setStatus('synced');
  } catch(e){
    setStatus('error', errorMessage(e));
  }
}

/* Stop listening and cancel any queued write, so nothing further lands in
   the room we're about to leave behind. */
function detach(){
  if(unsub){ unsub(); unsub = null; }
  clearTimeout(pushTimer);
}

function notConfigured(){
  setStatus('error', 'Sharing isn’t configured on this deployment — see the README for the two-minute Firebase setup.');
  return false;
}

async function openNewRoom(){
  const code = newRoomCode();
  history.replaceState(null, '', shareUrl(code));
  await joinRoom(code);
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
  history.replaceState(null, '', location.origin + location.pathname);
  setStatus('local');
  return { code };
}

export function leaveRoom(){
  detach();
  cloud.room = null; cloud.note = null;
  history.replaceState(null, '', location.origin + location.pathname);
  setStatus('local');
}

export function scheduleCloudPush(){
  if(!cloud.room || !api) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 800);
}

async function pushNow(){
  if(!cloud.room || !api) return;
  try{
    await api.write(cloud.room, {
      trip: getTrip(),
      updatedBy: CLIENT_ID,
      updatedAt: api.serverTimestamp(),
    });
    setStatus('synced');
  } catch(e){
    setStatus('error', errorMessage(e));
  }
}

export function cloudStatusText(){
  if(cloud.status === 'error') return 'Sync problem: ' + cloud.error;
  if(cloud.status === 'connecting') return 'Connecting…';
  if(cloud.status === 'synced'){
    const t = cloud.lastSync ? new Date(cloud.lastSync).toLocaleTimeString() : '';
    return (cloud.note ? cloud.note + ' · ' : '') + 'Shared and syncing' + (t ? ' · last change ' + t : '') + '.';
  }
  if(!cloud.configured) return 'Sharing is not set up on this deployment yet — this trip lives in this browser tab only. (One-time setup in the README.)';
  return 'This trip lives in this browser tab only — create a share link to save it and get a URL you can come back to.';
}
