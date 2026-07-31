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

function errorMessage(e){
  const code = (e && e.code) || '';
  if(code === 'auth/operation-not-allowed')
    return 'Anonymous sign-in is switched off for this Firebase project — turn it on under Authentication → Sign-in method.';
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

export async function createRoom(){
  if(!FIREBASE_CONFIG){
    setStatus('error', 'Sharing isn’t configured on this deployment — see the README for the two-minute Firebase setup.');
    return;
  }
  const code = newRoomCode();
  history.replaceState(null, '', shareUrl(code));
  await joinRoom(code);
  await pushNow();
}

export function leaveRoom(){
  if(unsub){ unsub(); unsub = null; }
  clearTimeout(pushTimer);
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
  if(!cloud.configured) return 'Sharing is not set up on this deployment yet — the trip is saved in this browser only. (One-time setup in the README.)';
  return 'This trip is saved in this browser only.';
}
