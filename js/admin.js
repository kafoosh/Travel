/* =========================================================
   ROOMS DASHBOARD (admin.html)

   Lists every room in the deployment's Firestore `trips`
   collection. The page is a plain static file like the rest
   of the site, so keeping it off the main page is privacy,
   not protection — the real gate is in the Firestore rules:
   `list` is only allowed for UIDs named in isAdmin() (see
   README). Room codes are the only key to a trip, so an open
   listing would hand every trip to anyone; until the rules
   name this browser's UID, Firestore refuses the query and
   this page shows the UID plus a paste-ready rules block.

   Reads are on demand (open the page / press Refresh) — no
   live listener, so an idle dashboard costs nothing.
   ========================================================= */

import { FIREBASE_CONFIG } from './config.js';
import { esc, slugify } from './util.js';
import { isValidTrip, serializeTrip } from './format.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';

let api = null;            // firestore adapter once loaded
let rooms = [];            // summarised rows (see summarize)
let sortKey = 'updatedMs';
let sortDir = -1;
let filterText = '';

const $ = id => document.getElementById(id);

/* ---------- firebase ---------- */

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
    uid: () => auth.currentUser ? auth.currentUser.uid : null,
    signIn: () => auth.currentUser ? Promise.resolve(auth.currentUser) : authMod.signInAnonymously(auth),
    /* One plain collection read, sorted client-side: an orderBy would
       silently drop any doc missing the field, and a personal deployment
       holds dozens of rooms, not thousands. */
    list: async () => {
      const snap = await fsMod.getDocs(fsMod.collection(db, 'trips'));
      return snap.docs.map(d => ({ code: d.id, data: d.data() }));
    },
    remove: code => fsMod.deleteDoc(fsMod.doc(db, 'trips', code)),
  };
  return api;
}

function errorMessage(e, what){
  const code = (e && e.code) || '';
  if(code === 'auth/operation-not-allowed')
    return 'Anonymous sign-in is switched off for this Firebase project — turn it on under Authentication → Sign-in method.';
  if(code === 'permission-denied' && what === 'delete')
    return 'Firestore refused the delete. The published rules probably still say “allow delete: if false” — see the README for the rule that permits it.';
  if(code === 'unavailable' || code === 'auth/network-request-failed')
    return 'Can’t reach Firestore — check the connection and try again.';
  return (e && e.message) || String(e);
}

function isDenied(e){ return !!(e && e.code === 'permission-denied'); }

/* ---------- room summaries ---------- */

function summarize({ code, data }){
  const trip = data && isValidTrip(data.trip) ? data.trip : null;
  const stops = trip ? trip.stops || {} : {};
  const binned = new Set(trip ? trip.bin || [] : []);
  const ids = Object.keys(stops).filter(id => !binned.has(id));
  const ts = data && data.updatedAt;
  let bytes = null;
  try{ bytes = new Blob([JSON.stringify((data && data.trip) ?? null)]).size; } catch(_e){ /* leave null */ }
  return {
    code,
    trip,                                       // null ⇒ unreadable doc
    name: trip ? (trip.name || 'Untitled Trip') : 'Unreadable trip data',
    subtitle: trip && trip.subtitle || '',
    days: trip ? (trip.days || []).length : 0,
    stops: ids.length,
    unassigned: trip ? (trip.optional || []).length : 0,
    done: ids.reduce((n, id) => n + (stops[id] && stops[id].done ? 1 : 0), 0),
    hotels: trip ? (trip.hotels || []).length : 0,
    startDate: trip && trip.startDate || null,
    theme: trip && trip.theme || null,
    updatedMs: ts && typeof ts.toMillis === 'function' ? ts.toMillis() : null,
    bytes,
  };
}

/* ---------- formatting ---------- */

function relAgo(ms){
  if(ms == null) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if(s < 60) return 'just now';
  if(s < 3600) return Math.floor(s / 60) + ' min ago';
  if(s < 86400) return Math.floor(s / 3600) + ' h ago';
  const d = Math.floor(s / 86400);
  if(d === 1) return 'yesterday';
  if(d < 31) return d + ' days ago';
  return new Date(ms).toLocaleDateString();
}

function fmtBytes(n){
  if(n == null) return '—';
  if(n < 1024) return n + ' B';
  if(n < 1048576) return (n / 1024).toFixed(n < 102400 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

/* Firestore caps a document at 1 MiB; flag rooms getting close. */
const SIZE_WARN = 700 * 1024;

function roomUrl(code){
  return new URL('./#trip=' + encodeURIComponent(code), location.href).href;
}

/* ---------- rendering ---------- */

function visibleRooms(){
  const q = filterText.trim().toLowerCase();
  const list = q
    ? rooms.filter(r => (r.name + ' ' + r.subtitle + ' ' + r.code).toLowerCase().includes(q))
    : rooms.slice();
  const dir = sortDir;
  list.sort((a, b) => {
    if(sortKey === 'name') return dir * a.name.localeCompare(b.name) || a.code.localeCompare(b.code);
    const va = a[sortKey] ?? -Infinity, vb = b[sortKey] ?? -Infinity;
    return dir * (va - vb) || a.code.localeCompare(b.code);
  });
  return list;
}

function render(){
  const list = visibleRooms();

  $('adm-count').textContent = filterText.trim()
    ? list.length + ' of ' + rooms.length
    : rooms.length + (rooms.length === 1 ? ' room' : ' rooms');

  const totalStops = rooms.reduce((n, r) => n + r.stops, 0);
  const totalBytes = rooms.reduce((n, r) => n + (r.bytes || 0), 0);
  const newest = rooms.reduce((m, r) => Math.max(m, r.updatedMs || 0), 0);
  $('adm-summary').innerHTML = [
    ['' + rooms.length, rooms.length === 1 ? 'room' : 'rooms'],
    ['' + totalStops, 'stops'],
    [fmtBytes(totalBytes), 'stored'],
    [newest ? relAgo(newest) : '—', 'last activity'],
  ].map(([num, lbl]) => `<div class="stat"><span class="num">${esc(num)}</span><span class="lbl">${esc(lbl)}</span></div>`).join('');

  document.querySelectorAll('.adm-table thead th[data-sort]').forEach(th => {
    const active = th.dataset.sort === sortKey;
    th.querySelector('.dir').textContent = active ? (sortDir < 0 ? '▼' : '▲') : '';
    th.setAttribute('aria-sort', active ? (sortDir < 0 ? 'descending' : 'ascending') : 'none');
  });

  $('adm-rows').innerHTML = list.map(rowHtml).join('');

  const empty = $('adm-empty');
  empty.hidden = list.length > 0;
  if(!list.length){
    empty.textContent = rooms.length
      ? 'No rooms match that filter.'
      : 'No rooms yet — a trip only lands here when someone clicks “Create a share link”.';
  }
}

function rowHtml(r){
  const c = esc(r.code);
  const meta = [`<span class="room-chip code" title="Room code — the doc id in Firestore">${c}</span>`];
  if(!r.trip) meta.push('<span class="room-chip invalid" title="This document isn’t a valid trip — the app can’t open it">unreadable</span>');
  if(r.startDate) meta.push(`<span class="room-chip">${esc(r.startDate)}</span>`);
  if(r.theme && r.theme !== 'parchment') meta.push(`<span class="room-chip">${esc(r.theme)}</span>`);

  const stopBits = [];
  if(r.done) stopBits.push('✓ ' + r.done + ' done');
  if(r.unassigned) stopBits.push(r.unassigned + ' unassigned');

  const big = r.bytes != null && r.bytes >= SIZE_WARN;

  return `<tr data-code="${c}">
    <td class="cell-trip">
      <div class="room-name">${esc(r.name)}</div>
      ${r.subtitle ? `<div class="room-sub">${esc(r.subtitle)}</div>` : ''}
      <div class="room-meta">${meta.join('')}</div>
    </td>
    <td class="num-cell" data-label="Days">${r.trip ? r.days : '—'}</td>
    <td class="num-cell" data-label="Stops">${r.trip ? r.stops : '—'}${stopBits.length ? `<span class="cell-detail">${esc(stopBits.join(' · '))}</span>` : ''}</td>
    <td class="num-cell" data-label="Hotels">${r.trip ? r.hotels : '—'}</td>
    <td class="num-cell" data-label="Last change" title="${r.updatedMs ? esc(new Date(r.updatedMs).toLocaleString()) : ''}">${esc(relAgo(r.updatedMs))}</td>
    <td class="num-cell${big ? ' size-warn' : ''}" data-label="Size"${big ? ' title="Firestore caps a room at 1 MB — this trip is getting close"' : ''}>${esc(fmtBytes(r.bytes))}</td>
    <td class="cell-actions">
      <div class="adm-actions">
        <a class="adm-btn" href="./#trip=${encodeURIComponent(r.code)}" target="_blank" rel="noopener" title="Open this room in the planner">Open ↗</a>
        <button class="adm-btn" data-act="copy" title="Copy this room’s share link">Copy link</button>
        ${r.trip ? '<button class="adm-btn" data-act="md" title="Download this trip as a markdown file — a backup that imports back">.md</button>' : ''}
        <button class="adm-btn danger" data-act="delete" title="Delete this room from the server — every copy of the link stops working">Delete</button>
      </div>
    </td>
  </tr>`;
}

/* ---------- actions ---------- */

function flash(btn, text){
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { if(btn.isConnected) btn.textContent = old; }, 1600);
}

async function onRowAction(e){
  const btn = e.target.closest('button[data-act]');
  if(!btn || btn.disabled) return;
  const code = btn.closest('tr').dataset.code;
  const room = rooms.find(r => r.code === code);
  if(!room) return;

  if(btn.dataset.act === 'copy'){
    try{
      await navigator.clipboard.writeText(roomUrl(code));
      flash(btn, 'Copied ✓');
    } catch(_e){
      prompt('Copy this link:', roomUrl(code));   // clipboard API refused (http, permissions…)
    }
    return;
  }

  if(btn.dataset.act === 'md'){
    let md;
    try{ md = serializeTrip(room.trip); }
    catch(err){ alert('Couldn’t serialize this trip: ' + errorMessage(err)); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = slugify(room.name) + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return;
  }

  if(btn.dataset.act === 'delete'){
    const ok = confirm(`Delete “${room.name}” (${code})?\n\nThe shared copy is removed from the server and every copy of the link stops working. There is no undo from this page.`);
    if(!ok) return;
    btn.disabled = true;
    try{
      await api.remove(code);
      rooms = rooms.filter(r => r.code !== code);
      render();
    } catch(err){
      btn.disabled = false;
      alert('Delete failed: ' + errorMessage(err, 'delete'));
    }
  }
}

/* ---------- page states ---------- */

function setStatus(html){
  const el = $('adm-status');
  el.innerHTML = html;
  el.hidden = !html;
}

function showMain(){
  setStatus('');
  $('adm-locked').hidden = true;
  $('adm-main').hidden = false;
  render();
  const uid = api.uid();
  $('adm-foot').innerHTML =
    `Signed in anonymously as <b>${esc(uid || '?')}</b> · listing granted by this deployment’s Firestore rules. ` +
    `To let another browser use this page, add its UID to the isAdmin() list in the rules — this page shows a browser its UID when it’s refused.`;
}

function showError(msg){
  $('adm-main').hidden = true;
  $('adm-locked').hidden = true;
  setStatus(`<span>${esc(msg)}</span><button class="adm-btn" id="adm-retry">Try again</button>`);
  $('adm-retry').onclick = refresh;
}

/* Firestore said permission-denied for the listing — the expected state on
   a fresh deployment. Show this browser's UID and a paste-ready rules block
   with the UID already in place. */
function showLocked(){
  $('adm-main').hidden = true;
  setStatus('');
  const uid = api.uid() || 'sign-in-failed';
  const panel = $('adm-locked');
  panel.hidden = false;
  panel.innerHTML = `
    <h2>The rooms list is locked — that’s the default</h2>
    <p>Room codes are the only key to a trip, so letting anyone list every room would hand
       out every trip on this deployment. Firestore only answers this page for browsers
       whose ID is named as an admin in the security rules. Share links themselves are
       unaffected — this gate is only on listing.</p>
    <p><b>This browser’s ID</b> (it stays the same here until site data is cleared):</p>
    <div class="adm-uid-row">
      <span class="adm-uid" id="adm-uid">${esc(uid)}</span>
      <button class="adm-btn" id="adm-copy-uid">Copy</button>
    </div>
    <p>To make it an admin: open your Firebase console → Firestore → <b>Rules</b>, and add
       this ID to the <code>isAdmin()</code> list. If your published rules predate the
       dashboard, replace them with this block — it’s your current rules plus the
       admin gate, with this browser’s ID already filled in:</p>
    <pre class="adm-rules" id="adm-rules"></pre>
    <div class="adm-uid-row">
      <button class="adm-btn" id="adm-copy-rules">Copy rules</button>
      <button class="adm-btn primary" id="adm-retry2">I’ve published them — try again</button>
    </div>
    <p class="subtle">The ID is this browser’s anonymous Firebase sign-in, not a password —
       naming it in the rules is what grants access, and only the Firebase console can do that.</p>`;
  $('adm-rules').textContent = rulesBlock(uid);
  $('adm-copy-uid').onclick = async () => {
    try{ await navigator.clipboard.writeText(uid); flash($('adm-copy-uid'), 'Copied ✓'); }
    catch(_e){ prompt('Copy this ID:', uid); }
  };
  $('adm-copy-rules').onclick = async () => {
    try{ await navigator.clipboard.writeText(rulesBlock(uid)); flash($('adm-copy-rules'), 'Copied ✓'); }
    catch(_e){ /* the block is selectable on the page */ }
  };
  $('adm-retry2').onclick = refresh;
}

function rulesBlock(uid){
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Rooms dashboard (admin.html): only these UIDs may LIST rooms.
    // Room codes are the only key to a trip, so enumeration stays locked.
    function isAdmin(){
      return request.auth != null && request.auth.uid in [
        '${uid}'
      ];
    }
    match /trips/{code} {
      // get = opening one room by its code (a share link).
      // list would let anyone enumerate every room, so it's split out
      // below; request.resource only exists on writes, so read and write
      // must stay separate rules too.
      allow get: if request.auth != null
        && code.matches('^[a-z0-9]{12,40}$');
      allow list: if isAdmin();
      allow create, update: if request.auth != null
        && code.matches('^[a-z0-9]{12,40}$')
        && request.resource.data.keys().hasOnly(['trip', 'updatedBy', 'updatedAt']);
      // "Delete this room" in Trip Info. Swap for \`if false\` to make rooms
      // permanent — the button then reports that the rules refuse it.
      allow delete: if request.auth != null
        && code.matches('^[a-z0-9]{12,40}$');
    }
  }
}`;
}

/* ---------- boot ---------- */

async function refresh(){
  setStatus('<span><span class="spin">◌</span>Fetching rooms…</span>');
  $('adm-locked').hidden = true;
  try{
    await loadFirebase();
    await api.signIn();
  } catch(e){
    showError(errorMessage(e));
    return;
  }
  try{
    rooms = (await api.list()).map(summarize);
  } catch(e){
    if(isDenied(e)) showLocked();
    else showError(errorMessage(e));
    return;
  }
  showMain();
}

function boot(){
  if(!FIREBASE_CONFIG){
    showError('Sharing isn’t configured on this deployment (js/config.js has no Firebase config), so there are no rooms to list — see the README for the one-time setup.');
    return;
  }
  $('adm-refresh').addEventListener('click', refresh);
  $('adm-rows').addEventListener('click', onRowAction);
  $('adm-filter').addEventListener('input', e => { filterText = e.target.value; render(); });
  document.querySelectorAll('.adm-table thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if(key === sortKey) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'name' ? 1 : -1; }
      render();
    });
  });
  refresh();
}

boot();
