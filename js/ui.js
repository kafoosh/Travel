/* =========================================================
   UI — all rendering and interaction.
   Ported from the Rome & Venice itinerary and generalised:
   no hardcoded cities, hotels, or stops; everything renders
   from the trip object and every piece of user content is
   escaped before it touches innerHTML.
   ========================================================= */

import { esc, formatTime, formatDur, parseTime, dayDate, formatDayDate, slugify, debounce } from './util.js';
import { CATEGORIES, AB_CATS, DEFAULT_DUR, THEMES, DAY_COLORS, CAT_ICONS as ICONS, MODE_ICONS as MODE_ICON,
         newDay, serializeTrip, importText, blankTrip } from './format.js';
import { state, saveState, pushUndo, popUndo, replaceTrip, nextStopId, nextHotelId, nextChecklistId, forgetRoomCache, rememberPane } from './state.js';
import { computeSchedule } from './schedule.js';
import { optimizeDayOrder, autoPlanOrders } from './optimize.js';
import { routingStatus, onRoutingUpdate } from './routing.js';
import { cloud, cloudStatusText, createRoom, duplicateRoom, deleteRoom, leaveRoom, shareUrl } from './cloud.js';
import { buildPrompt, PROMPT_PREFS } from './llm.js';
import { attachAutocomplete } from './geocode.js';
import { dayMapPoints, googleMapsUrl, tripKml } from './exporters.js';
import { buildOfflineHtml, collectPhotos, photoUrls, offlineFileName } from './offline.js';
import { mountImage } from './img.js';

const CAT_LABEL = {
  landmark:'Landmark', museum:'Museum', church:'Church / temple', park:'Park / nature',
  view:'Viewpoint', food:'Food & drink', shop:'Shopping', hike:'Hike (A → B)',
  hotel:'Hotel / check-in', flight:'Flight (A → B)', travel:'Train / travel leg (A → B)',
  boat:'Boat / ferry (A → B)', other:'Other'
};
const MODE_LABEL = { walk:'walk', cycle:'cycle', transit:'transit', bus:'bus', metro:'metro', tram:'tram', ferry:'ferry', taxi:'taxi', boat:'boat' };
// Choosable per-leg overrides (submodes like bus/metro come from the router, not the picker)
const PICKABLE_MODES = [[null,'Auto'],['walk','🚶 Walk'],['cycle','🚲 Cycle'],['transit','🚌 Transit'],['taxi','🚕 Taxi'],['boat','🚤 Boat']];

const THEME_PREVIEW = {
  parchment:['#E9DFC6','#C1502E','#B8891F'],
  lagoon:['#DCE7E4','#2E6E71','#B8891F'],
  terracotta:['#F0E0CE','#B85C38','#C08A2E'],
  midnight:['#161C24','#D98B5F','#C9A24B'],
  'field-notes':['#F1EEE2','#4A6B3A','#A98A2F'],
};

let dragSourceId = null;
let lastFocusedEl = null;
let leafletMap = null;
let mapLayerGroup = null;
let lastMapDayId = null;
let mapFitPts = null;
let mapFitPending = false;
let modalStopId = null;
let promptEdits = null;   // user-edited prompt draft (survives view switches, cleared on mode change/reset)
let promptMode = null;    // sticky mode radio choice
let promptPrefs = {};     // tailoring controls (destination, pace, interests…)
let importNote = '';      // last import's error/warning line, shown on the AI Plan tab
let pendingFlash = null;   // {id, until} — highlight survives async re-renders

function applyPendingFlash(){
  if(!pendingFlash) return;
  if(Date.now() > pendingFlash.until){ pendingFlash = null; return; }
  const card = document.querySelector(`.stop-card[data-id="${CSS.escape(pendingFlash.id)}"]`);
  if(!card) return;
  card.classList.add('flash');
  setTimeout(() => {
    if(pendingFlash && Date.now() <= pendingFlash.until) return;   // a re-render will re-apply
    document.querySelectorAll('.stop-card.flash').forEach(c => c.classList.remove('flash'));
  }, Math.max(50, (pendingFlash.until - Date.now()) + 50));
}

const $ = id => document.getElementById(id);
const trip = () => state.trip;
const currentDay = () => {
  state.currentDayIndex = Math.max(0, Math.min(state.currentDayIndex, trip().days.length - 1));
  return trip().days[state.currentDayIndex];
};

/* =========================================================
   THEME + HERO
   ========================================================= */
export function applyTheme(){
  const t = THEMES.includes(trip().theme) ? trip().theme : 'parchment';
  document.documentElement.dataset.theme = t;
}

function renderHero(){
  $('trip-title').textContent = trip().name || 'Untitled Trip';
  const sub = $('trip-subtitle');
  sub.textContent = trip().subtitle || '';
  sub.classList.toggle('hidden', !trip().subtitle);
  const hh = $('hero-hotels');
  hh.innerHTML = trip().hotels.map(h =>
    `<div class="hotel-chip"><span class="dot"></span> ${esc(h.name)}${h.mode === 'boat' ? ' · boat shuttle' : ''}</div>`
  ).join('');
  document.title = (trip().name && trip().name !== 'Untitled Trip') ? trip().name + ' — Travel Planner' : 'Travel Planner';
}

/* =========================================================
   DAY TABS
   ========================================================= */
/* Day drags carry their own MIME type so a stop dragged across the tab strip
   can't be mistaken for one (and vice versa). */
const DAY_DND = 'application/x-travel-day';
const isDayDrag = (e) => Array.from(e.dataTransfer.types || []).includes(DAY_DND);
const clearTabMarks = () => document.querySelectorAll('.daytab').forEach(t => t.classList.remove('drop-before','drop-after'));

function renderTabs(){
  const el = $('daytabs');
  el.innerHTML = '';
  trip().days.forEach((d, i) => {
    const btn = document.createElement('div');
    btn.className = 'daytab' + (i === state.currentDayIndex ? ' active' : '');
    if(d.color && DAY_COLORS[d.color]) btn.dataset.dayColor = d.color;
    btn.draggable = true;
    btn.tabIndex = 0;
    btn.title = 'Drag to reorder the trip (or focus and press Shift + ← / →)';
    /* Two lines: the day number and date on top, the title beneath. A long
       title then ellipsizes inside a width-capped tab instead of stretching
       it off the edge of the strip. */
    const date = dayDate(trip().startDate, i);
    btn.innerHTML =
      '<span class="d-top"><span class="d-num">D' + d.id + '</span>' +
      (date ? '<span class="d-date">' + formatDayDate(date) + '</span>' : '') + '</span>' +
      '<span class="d-title">' + esc(d.title) + '</span>';
    btn.title = d.title + (date ? ' · ' + formatDayDate(date) : '') +
      ' — drag to reorder the trip (or focus and press Shift + ← / →)';
    btn.addEventListener('click', () => { state.currentDayIndex = i; renderAll(); });

    btn.addEventListener('dragstart', e => {
      btn.classList.add('dragging');
      e.dataTransfer.setData(DAY_DND, String(i));
      e.dataTransfer.setData('text/plain', 'day:' + i);   // Safari wants a text flavour
      e.dataTransfer.effectAllowed = 'move';
    });
    btn.addEventListener('dragend', () => { btn.classList.remove('dragging'); clearTabMarks(); });
    btn.addEventListener('dragover', e => {
      if(!isDayDrag(e)) return;
      e.preventDefault();
      const rect = btn.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      btn.classList.toggle('drop-before', before);
      btn.classList.toggle('drop-after', !before);
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('drop-before','drop-after'));
    btn.addEventListener('drop', e => {
      if(!isDayDrag(e)) return;
      e.preventDefault();
      const rect = btn.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      clearTabMarks();
      moveDay(parseInt(e.dataTransfer.getData(DAY_DND), 10), before ? i : i + 1);
    });

    btn.addEventListener('keydown', e => {
      if(!e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      e.stopPropagation();
      const landed = moveDay(i, e.key === 'ArrowLeft' ? i - 1 : i + 2);
      const tab = landed == null ? null : $('daytabs').children[landed];
      if(tab) tab.focus();
    });

    el.appendChild(btn);
  });
  const add = document.createElement('div');
  add.className = 'daytab';
  add.title = 'Add a day';
  add.textContent = '+ Day';
  add.addEventListener('click', () => {
    pushUndo();
    trip().days.push(newDay(trip().days.length + 1));
    state.currentDayIndex = trip().days.length - 1;
    saveState();
    renderAll();
  });
  // dropping past the last day tab sends the day to the end
  add.addEventListener('dragover', e => {
    if(!isDayDrag(e)) return;
    e.preventDefault();
    add.classList.add('drop-before');
  });
  add.addEventListener('dragleave', () => add.classList.remove('drop-before'));
  add.addEventListener('drop', e => {
    if(!isDayDrag(e)) return;
    e.preventDefault();
    clearTabMarks();
    moveDay(parseInt(e.dataTransfer.getData(DAY_DND), 10), trip().days.length);
  });
  el.appendChild(add);

  // Keep the active tab in view when the strip scrolls. Horizontal scroll on
  // the strip only — scrollIntoView could also scroll the page. Measured off
  // the rendered boxes rather than offsetLeft: the strip is sticky (so it is
  // its own offsetParent on mobile but not on desktop, where the wrapper is),
  // and rects don't care which.
  const active = el.querySelector('.daytab.active');
  if(active && el.scrollWidth > el.clientWidth){
    const target = el.scrollLeft + active.getBoundingClientRect().left - el.getBoundingClientRect().left
      - (el.clientWidth - active.offsetWidth) / 2;
    el.scrollLeft = Math.max(0, Math.min(target, el.scrollWidth - el.clientWidth));
  }
  syncTabNav();
}

/* Show each scroll arrow only while there are tabs that way, and fade the
   ends to match. Runs after every render, on scroll, and on resize — the
   strip's own listeners are wired once, not per render. */
function syncTabNav(){
  const el = $('daytabs'), wrap = $('daytabs-wrap');
  if(!el || !wrap) return;
  const slack = el.scrollWidth - el.clientWidth;
  wrap.classList.toggle('can-prev', el.scrollLeft > 1);
  wrap.classList.toggle('can-next', slack > 1 && el.scrollLeft < slack - 1);
}

function wireTabNav(){
  const el = $('daytabs'), wrap = $('daytabs-wrap');
  if(!el || !wrap) return;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const step = (dir) => el.scrollBy({
    left: dir * Math.max(180, el.clientWidth * 0.8),
    behavior: smooth ? 'smooth' : 'auto',
  });
  wrap.querySelector('.daytabs-nav.prev').addEventListener('click', () => step(-1));
  wrap.querySelector('.daytabs-nav.next').addEventListener('click', () => step(1));
  el.addEventListener('scroll', syncTabNav, { passive:true });
  window.addEventListener('resize', syncTabNav);
}

/* Move the day at `from` so it lands at index `to` of the *current* list
   (i.e. `to` is counted before the day is lifted out).

   Day ids are positional — D1, D2, … — so the run is renumbered afterwards.
   Two things ride on those numbers and are carried across: a title still
   holding its auto-generated "Day N" follows the new position, and the
   "suggested day" on unassigned stops is remapped through the permutation
   so it keeps pointing at the day the suggestion meant. */
function moveDay(from, to){
  const days = trip().days;
  if(!(from >= 0 && from < days.length)) return;
  const target = Math.max(0, Math.min(days.length - 1, to > from ? to - 1 : to));
  if(target === from) return;
  pushUndo();
  const viewed = days[state.currentDayIndex];    // stay on the day being looked at
  const autoTitled = new Set(days.filter(d => d.title === 'Day ' + d.id).map(d => d.id));
  const [moved] = days.splice(from, 1);
  days.splice(target, 0, moved);
  const remap = new Map(days.map((d, i) => [d.id, i + 1]));
  days.forEach((d, i) => {
    if(autoTitled.has(d.id)) d.title = 'Day ' + (i + 1);
    d.id = i + 1;
  });
  trip().optional.forEach(o => { if(o.day && remap.has(o.day)) o.day = remap.get(o.day); });
  state.currentDayIndex = Math.max(0, days.indexOf(viewed));
  saveState();
  renderAll();
  return target;
}

/* =========================================================
   DAY PANEL
   ========================================================= */
function renderDayPanel(){
  const day = currentDay();
  const panel = $('daypanel');
  // The whole panel adopts the day's colour: every var(--accent*) inside —
  // tabs aside — follows via the [data-day-color] CSS variable overrides.
  if(day.color && DAY_COLORS[day.color]) panel.dataset.dayColor = day.color;
  else delete panel.dataset.dayColor;
  const sched = computeSchedule(trip(), day);
  const date = sched.date;

  let hotelBarHtml = '';
  if(trip().hotels.length){
    // On mobile the bar rests as a one-line summary; tapping it unfolds the
    // controls. Desktop shows them directly — the summary button is
    // display:none there.
    // Each end of the day picks its own hotel: the same hotel in both is the
    // normal based-here day, and any other pair (none → hotel, hotel → none,
    // A → B) is an arrival, a departure, or a hotel-change day.
    const startH = trip().hotels.find(h => h.id === day.startHotelId) || null;
    const endH = trip().hotels.find(h => h.id === day.endHotelId) || null;
    const split = (day.startHotelId || null) !== (day.endHotelId || null);
    const summary = split
      ? (startH ? esc(startH.name) : 'No hotel') + ' → ' + (endH ? esc(endH.name) : 'no hotel')
      : (startH ? esc(startH.name) : 'No hotel');
    const options = (sel) => `<option value=""${sel ? '' : ' selected'}>No hotel</option>` +
      trip().hotels.map(h => `<option value="${esc(h.id)}"${sel === h.id ? ' selected' : ''}>${esc(h.name)}</option>`).join('');
    hotelBarHtml = `
    <div class="hotel-toggle" id="hotel-toggle">
      <button type="button" class="hotel-summary" id="hotel-summary" aria-expanded="false">
        <span class="hotel-toggle-label">Staying at:</span>
        <span class="hs-name">${summary}</span>
        <span class="hs-caret" aria-hidden="true">▾</span>
      </button>
      <div class="hotel-opts">
        <span class="hotel-toggle-label">Staying at:</span>
        <label class="hotel-pick" title="Where the day begins — No hotel on a day that starts mid-journey (an arrival)">
          <span class="hp-tag">Start</span>
          <select id="hotel-start-select" aria-label="Hotel the day starts from">${options(day.startHotelId)}</select>
        </label>
        <label class="hotel-pick" title="Where this night is spent — No hotel on a departure day">
          <span class="hp-tag">End</span>
          <select id="hotel-end-select" aria-label="Hotel the day ends at">${options(day.endHotelId)}</select>
        </label>
      </div>
    </div>`;
  }

  panel.innerHTML = `
    <div class="daypanel-head">
      <h2>Day ${day.id} — ${esc(day.title)}</h2>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        ${date ? `<span class="day-date-tag">${formatDayDate(date)}</span>` : ''}
        <span class="day-progress${dayProgressText(day) ? '' : ' hidden'}" id="day-progress" title="Stops ticked off on this day">${dayProgressText(day)}</span>
        <button class="reset-btn" id="edit-day-btn">✎ Edit day</button>
        <button class="reset-btn" id="gmaps-day-btn" title="Open this day's route in Google Maps — shareable on any device">🗺 Google Maps</button>
        <button class="reset-btn" id="add-location-btn">+ Add location</button>
        <button class="reset-btn" id="optimize-order" title="Reorder this day's stops to minimise travel time">✨ Optimize route</button>
      </div>
    </div>
    ${hotelBarHtml}
    <div id="day-unassigned"></div>
    <div class="view-switch" role="group" aria-label="Switch between schedule and map">
      <button id="switch-list" class="active" aria-pressed="true">☰ Schedule</button>
      <button id="switch-map" aria-pressed="false">🗺 Map</button>
    </div>
    <div class="daypanel-body show-list" id="daypanel-body">
      <div class="schedule" id="schedule-list"></div>
      <div class="mappanel">
        <div id="map"></div>
        <div class="map-legend">
          <span><span class="legend-dot"></span> Stop, in order</span>
          <span><span class="legend-line solid"></span> routed path</span>
          <span><span class="legend-line dashed"></span> estimate</span>
          <span>🚶 walk</span><span>🚲 cycle</span><span>🚌 transit</span><span>🚕 taxi</span><span>🚤 boat</span>
        </div>
      </div>
    </div>
  `;

  $('edit-day-btn').addEventListener('click', () => openDayEdit(state.currentDayIndex));
  $('gmaps-day-btn').addEventListener('click', () => openGmapsPicker(day));
  $('add-location-btn').addEventListener('click', () => openLocationForm(null, day.id));
  $('optimize-order').addEventListener('click', () => {
    pushUndo();
    day.order = optimizeDayOrder(trip(), day);
    saveState();
    renderDayPanel();
    updateUndoButton();
  });

  const body = $('daypanel-body');
  const btnList = $('switch-list');
  const btnMap = $('switch-map');
  function applyPaneMode(mode){
    state.mobilePane = mode;
    rememberPane(mode);
    body.classList.toggle('show-list', mode === 'list');
    body.classList.toggle('show-map', mode === 'map');
    btnList.classList.toggle('active', mode === 'list');
    btnMap.classList.toggle('active', mode === 'map');
    btnList.setAttribute('aria-pressed', mode === 'list');
    btnMap.setAttribute('aria-pressed', mode === 'map');
    if(mode === 'map') setTimeout(() => {
      if(!leafletMap) return;
      leafletMap.invalidateSize();
      if(mapFitPending) fitMapToDay();
    }, 60);
  }
  btnList.addEventListener('click', () => applyPaneMode('list'));
  btnMap.addEventListener('click', () => applyPaneMode('map'));
  applyPaneMode(state.mobilePane || 'list');

  const hotelSummary = $('hotel-summary');
  if(hotelSummary) hotelSummary.addEventListener('click', () => {
    const open = $('hotel-toggle').classList.toggle('open');
    hotelSummary.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  const wireHotelPick = (id, field) => {
    const sel = $(id);
    if(!sel) return;
    sel.addEventListener('change', () => {
      pushUndo();
      day[field] = sel.value || null;
      saveState();
      renderDayPanel();
      updateUndoButton();
    });
  };
  wireHotelPick('hotel-start-select', 'startHotelId');
  wireHotelPick('hotel-end-select', 'endHotelId');

  renderUnassignedTray($('day-unassigned'), day.id);
  renderScheduleList(day, sched);
  renderMap(day, sched);
}

/* =========================================================
   DONE TICKS

   A stop can be ticked off as you go. It lives on the stop
   itself (not in this browser), so it exports with the trip
   and everyone in a shared room sees the same crossed-off
   plan — the point of ticking a stop on the way out of it is
   that whoever you're travelling with knows too.

   The tick never moves or hides anything: a done stop keeps
   its place, its time and its number, and greys out. Nothing
   in the schedule, the map or the optimiser reads it.
   ========================================================= */
function doneBtnHtml(stop){
  const on = !!stop.done;
  return `<button class="done-btn" type="button" aria-pressed="${on}" data-done-id="${esc(stop.id)}"` +
    ` title="${on ? 'Done — click to untick' : 'Mark as done'}"` +
    ` aria-label="${on ? 'Mark not done' : 'Mark done'}: ${esc(stop.name)}">✓</button>`;
}

/* Wire the button inside `root` (a card or row). The card greys out in
   place — re-rendering the whole day would fight a fast series of ticks and
   lose the scroll position. `after` refreshes anything that counts them. */
function wireDoneBtn(root, id, after){
  const btn = root.querySelector('.done-btn');
  if(!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = trip().stops[id];
    if(!s) return;
    pushUndo();
    s.done = !s.done;
    saveState();
    const card = btn.closest('.stop-card, .bin-row');
    if(card) card.classList.toggle('done', s.done);
    btn.setAttribute('aria-pressed', String(!!s.done));
    btn.title = s.done ? 'Done — click to untick' : 'Mark as done';
    btn.setAttribute('aria-label', (s.done ? 'Mark not done: ' : 'Mark done: ') + s.name);
    if(after) after();
    updateUndoButton();
  });
}

/* =========================================================
   HIDE FROM THE MAP

   The eye next to the tick takes a stop's pin off the map
   without taking the stop out of the day: a corner of the map
   too crowded to read, a stop you're undecided about, a hotel
   errand nobody needs a pin for.

   It changes what is drawn and nothing else. The stop keeps its
   place, its time and — the point of it — its number, so the
   numbers on the cards and the pins that remain still agree:
   the map reads 1, 2, 4 and the day's third card is the one
   that isn't there. The route still runs through it, because
   the day still goes there. Like the tick, it lives on the stop,
   so it travels through export/import and everyone in a shared
   room sees the same map.
   ========================================================= */
function hideBtnHtml(stop){
  const on = !!stop.hidden;
  return `<button class="hide-btn${on ? ' off' : ''}" type="button" aria-pressed="${on}" data-hide-id="${esc(stop.id)}"` +
    ` title="${on ? 'Hidden from the map — click to show' : 'Hide from the map'}"` +
    ` aria-label="${on ? 'Show on map' : 'Hide from map'}: ${esc(stop.name)}">👁</button>`;
}

/* Wire the button inside `root` (a card or row). `after` re-renders whatever
   draws the pins — the map is the whole point, so unlike the tick this one
   always has something to refresh. */
function wireHideBtn(root, id, after){
  const btn = root.querySelector('.hide-btn');
  if(!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = trip().stops[id];
    if(!s) return;
    pushUndo();
    s.hidden = !s.hidden;
    saveState();
    const card = btn.closest('.stop-card, .bin-row');
    if(card) card.classList.toggle('off-map', s.hidden);
    btn.classList.toggle('off', s.hidden);
    btn.setAttribute('aria-pressed', String(!!s.hidden));
    btn.title = s.hidden ? 'Hidden from the map — click to show' : 'Hide from the map';
    btn.setAttribute('aria-label', (s.hidden ? 'Show on map: ' : 'Hide from map: ') + s.name);
    if(after) after();
    updateUndoButton();
  });
}

/* "3 of 7 done" in the day's header — only once something is ticked. */
function dayProgressText(day){
  const stops = day.order.map(id => trip().stops[id]).filter(Boolean);
  const done = stops.filter(s => s.done).length;
  return done ? '✓ ' + done + ' of ' + stops.length + ' done' : '';
}

function refreshDayProgress(day){
  const el = $('day-progress');
  if(!el) return;
  const text = dayProgressText(day);
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

/* A travel connector line. `target` makes it clickable to override the leg's
   transport mode: {stopId} sets that stop's arriveBy, {returnDay} sets the
   day's return-to-hotel mode. */
function travelConnector(minutes, mode, live, prefixText, target){
  const conn = document.createElement('div');
  conn.className = 'travel-connector' + (target ? ' pickable' : '');
  const override = target ? (target.stopId ? trip().stops[target.stopId]?.arriveBy : target.returnDay.returnBy) : null;
  conn.innerHTML = (MODE_ICON[mode] || '🚶') + ' ' + (prefixText || '') + '~' + minutes + ' min ' +
    (MODE_LABEL[mode] || mode) +
    (override ? ' <span class="mode-pin" title="Transport mode pinned by you">📌</span>' : '') +
    (live ? '' : ' <span class="est" title="Estimated from distance — a routed time will replace this shortly">· est</span>') +
    (target ? ' <span class="mode-caret">▾</span>' : '');
  if(!target) return conn;

  conn.title = 'Click to choose how you travel this leg';
  conn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = conn.querySelector('.mode-menu');
    if(existing){ existing.remove(); return; }
    document.querySelectorAll('.mode-menu').forEach(m => m.remove());
    const menu = document.createElement('span');
    menu.className = 'mode-menu';
    PICKABLE_MODES.forEach(([val, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mode-opt' + ((override || null) === val ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.remove();                 // clear before refresh, or the open-menu guard skips it
        pushUndo();
        if(target.stopId) trip().stops[target.stopId].arriveBy = val;
        else target.returnDay.returnBy = val;
        saveState();
        refreshDaySchedule();
        updateUndoButton();
      });
      menu.appendChild(b);
    });
    conn.appendChild(menu);
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  });
  return conn;
}

function renderScheduleList(day, sched){
  const { rows, leadTransfer, trailTransfer, returnTime, startHotel, endHotel } = sched;
  const list = $('schedule-list');
  list.innerHTML = '';

  // Dropping on the list background (not a card) appends to this day —
  // the only way to place the first stop of an empty day by dragging.
  list.ondragover = (e) => {
    if(e.target.closest('.stop-card')) return;
    e.preventDefault();
    list.classList.add('drop-into');
  };
  list.ondragleave = () => list.classList.remove('drop-into');
  list.ondrop = (e) => {
    list.classList.remove('drop-into');
    if(e.target.closest('.stop-card')) return;   // the card's own handler placed it
    e.preventDefault();
    reorder(day, e.dataTransfer.getData('text/plain'), null, false);
  };

  if(rows.length === 0){
    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--ink-soft); font-size:14px; padding:8px 4px; line-height:1.5;';
    hint.innerHTML = 'Nothing planned for this day yet.<br>Use <b>+ Add location</b> above, pull something in from <b>Unassigned</b>, or import a whole trip from <b>Trip Info → Import</b>.';
    list.appendChild(hint);
    return;
  }

  let mapOrder = 0;
  if(startHotel && leadTransfer){
    const firstStop = rows.find(r => r.stop.lat != null);
    list.appendChild(travelConnector(leadTransfer.minutes, leadTransfer.mode, leadTransfer.live,
      'Depart ' + esc(startHotel.name) + ', ', firstStop ? { stopId: firstStop.stop.id } : null));
  }

  rows.forEach((row, idx) => {
    if(idx > 0 && row.travelBefore > 0){
      list.appendChild(travelConnector(row.travelBefore, row.travelMode || 'walk', row.travelLive, '', { stopId: row.stop.id }));
    }
    if(row.waitBefore > 0){
      const wait = document.createElement('div');
      wait.className = 'travel-connector';
      wait.innerHTML = '⏳ ' + row.waitBefore + ' min spare before the fixed ' + formatTime(parseTimeStr(row.stop.fixedStart)) + ' start';
      list.appendChild(wait);
    }

    const s = row.stop;
    const card = document.createElement('div');
    card.className = 'stop-card' + (s.cat === 'travel' || s.cat === 'boat' ? ' travel-row' : '') +
      (s.done ? ' done' : '') + (s.hidden ? ' off-map' : '');
    card.draggable = false;
    card.dataset.id = s.id;

    // A hidden stop still takes its number: the numbers left on the map are
    // the ones the cards carry, with the hidden stop's simply missing.
    const hasMapPin = s.lat != null && s.lng != null;
    if(hasMapPin) mapOrder += 1;
    const numberBadgeHtml = hasMapPin
      ? `<span class="stop-number${s.hidden ? ' off-map' : ''}"${s.hidden ? ' title="Hidden from the map — the number stays with the stop"' : ''}>${mapOrder}</span>`
      : `<span class="stop-number no-pin" title="No coordinates — not shown on map">–</span>`;

    const chips = s.tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('') +
      (s.notes ? `<span class="tag-chip note-chip" title="${esc(s.notes)}">📝 note</span>` : '');
    // The icon renders first and a photo only replaces it once one of the
    // candidate URLs actually loads (see img.js) — a dead link shows the icon.
    const illustrationHtml = `<div class="stop-illustration">${ICONS[s.cat] || '📍'}</div>`;

    const dayOptionsHtml = trip().days.filter(d => d.id !== day.id)
      .map(d => `<option value="${d.id}">D${d.id} · ${esc(shortTitle(d.title))}</option>`).join('') +
      `<option value="optional">→ Unassigned</option>`;

    card.innerHTML = `
      ${numberBadgeHtml}
      ${illustrationHtml}
      <div class="stop-main">
        <div class="stop-time-row">
          <span class="clock">${formatTime(row.start)}</span>
          <span>·</span>
          <span>${formatDur(s.dur)}</span>
          ${s.fixedStart ? `<span class="fixed-chip" title="Fixed start time">⏰ ${formatTime(parseTimeStr(s.fixedStart))}</span>` : ''}
          ${row.late > 0 ? `<span class="late-chip" title="The plan reaches this stop after its fixed time">⚠ ${row.late} min late</span>` : ''}
          ${AB_CATS.includes(s.cat) && s.endLat != null ? `<span class="fixed-chip" title="${s.cat === 'hike' ? 'Point-to-point hike' : 'Point-to-point leg — the day continues from where it arrives'}">${s.cat === 'hike' ? '🥾' : ICONS[s.cat] || '🚄'} A→B</span>` : ''}
        </div>
        <p class="stop-name">${esc(s.name)}</p>
        <p class="stop-desc">${esc(s.desc)}</p>
        <div class="tag-row">${chips}</div>
        <div class="manage-row">
          <select class="move-to-day" title="Move to another day" aria-label="Move ${esc(s.name)}">
            <option value="">Move to…</option>
            ${dayOptionsHtml}
          </select>
          ${doneBtnHtml(s)}
          ${hideBtnHtml(s)}
          <button class="bin-btn" title="Remove to bin" aria-label="Remove ${esc(s.name)} to bin">🗑</button>
        </div>
      </div>
      <div class="stop-controls">
        <span class="drag-handle" title="Drag to reorder (or focus and press ↑ / ↓)" role="button" tabindex="0" aria-label="Reorder ${esc(s.name)}: drag, or press arrow up and arrow down">⠿</span>
      </div>
    `;

    if(s.img) mountImage(card.querySelector('.stop-illustration'), s.img, ICONS[s.cat] || '📍', { alt: s.name });

    const sel = card.querySelector('.move-to-day');
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', e => {
      e.stopPropagation();
      const v = e.target.value;
      if(v === 'optional') moveToOptional(day, s.id);
      else if(v) moveToDay(day, s.id, parseInt(v, 10));
    });
    wireDoneBtn(card, s.id, () => refreshDayProgress(day));
    wireHideBtn(card, s.id, () => renderMap(day, sched));
    card.querySelector('.bin-btn').addEventListener('click', (e) => { e.stopPropagation(); removeToBin(day, s.id); });

    card.addEventListener('click', (e) => {
      const selObj = window.getSelection();
      if(selObj && !selObj.isCollapsed && selObj.toString().trim() && card.contains(selObj.anchorNode)) return;
      if(e.target.closest('.drag-handle')) return;
      openModal(s.id, row);
    });
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', 'View details for ' + s.name);
    card.addEventListener('keydown', (e) => {
      if(e.target !== card) return;
      if(e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        openModal(s.id, row);
      }
    });

    // --- HTML5 drag (desktop) ---
    card.addEventListener('dragstart', e => {
      dragSourceId = s.id;
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', s.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.draggable = false;
      card.classList.remove('dragging');
      document.querySelectorAll('.stop-card').forEach(c => c.classList.remove('drop-before','drop-after'));
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      card.classList.toggle('drop-before', before);
      card.classList.toggle('drop-after', !before);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before','drop-after'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      const draggedId = e.dataTransfer.getData('text/plain');
      const rect = card.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      reorder(day, draggedId, s.id, before);
      card.classList.remove('drop-before','drop-after');
    });

    const handle = card.querySelector('.drag-handle');
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('mousedown', () => { card.draggable = true; });
    handle.addEventListener('mouseup', () => { card.draggable = false; });

    // --- Keyboard reorder ---
    handle.addEventListener('keydown', (e) => {
      if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();
      moveStop(day, s.id, e.key === 'ArrowUp' ? -1 : 1);
      const moved = document.querySelector(`.stop-card[data-id="${CSS.escape(s.id)}"] .drag-handle`);
      if(moved) moved.focus();
    });

    // --- Touch drag ---
    handle.addEventListener('pointerdown', (ev) => {
      if(ev.pointerType === 'mouse') return;
      ev.preventDefault();
      ev.stopPropagation();
      card.classList.add('touch-dragging');
      let lastTarget = null, lastBefore = false;
      const onMove = (mv) => {
        const el = document.elementFromPoint(mv.clientX, mv.clientY);
        const overCard = el && el.closest ? el.closest('.stop-card') : null;
        document.querySelectorAll('.stop-card').forEach(c => c.classList.remove('drop-before','drop-after'));
        if(overCard && overCard !== card){
          const r = overCard.getBoundingClientRect();
          const before = (mv.clientY - r.top) < r.height / 2;
          overCard.classList.toggle('drop-before', before);
          overCard.classList.toggle('drop-after', !before);
          lastTarget = overCard.dataset.id;
          lastBefore = before;
        } else {
          lastTarget = null;
        }
        // The bottom auto-scroll zone sits above the fixed mobile nav bar,
        // otherwise the bar swallows the entire hot zone.
        const nav = document.querySelector('.tl-views');
        const navH = nav && getComputedStyle(nav).position === 'fixed' ? nav.offsetHeight : 0;
        const margin = 70;
        if(mv.clientY < margin) window.scrollBy(0, -12);
        else if(mv.clientY > window.innerHeight - navH - margin) window.scrollBy(0, 12);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        card.classList.remove('touch-dragging');
        document.querySelectorAll('.stop-card').forEach(c => c.classList.remove('drop-before','drop-after'));
        if(lastTarget) reorder(day, s.id, lastTarget, lastBefore);
      };
      document.addEventListener('pointermove', onMove, { passive:true });
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });

    list.appendChild(card);
  });

  if(endHotel && trailTransfer){
    // "Return to" when it's the hotel the day started from; a different end
    // hotel (or none at the start) means the day moves on, not back.
    const sameHotel = startHotel && startHotel.id === endHotel.id;
    list.appendChild(travelConnector(trailTransfer.minutes, trailTransfer.mode, trailTransfer.live,
      (sameHotel ? 'Return to ' : 'On to ') + esc(endHotel.name) + ', ', { returnDay: day }));
    const arrive = document.createElement('div');
    arrive.className = 'travel-connector';
    arrive.innerHTML = '🏨 ' + (sameHotel ? 'Back at the hotel' : 'At ' + esc(endHotel.name)) + ' ~' + formatTime(returnTime);
    list.appendChild(arrive);
  }

  // Day totals: distance on foot vs by vehicle, from routed geometry where
  // known and haversine-based estimates otherwise.
  const { walkKm, otherKm } = sched;
  if(walkKm > 0.05 || otherKm > 0.05){
    const totals = document.createElement('div');
    totals.className = 'day-totals';
    const parts = [];
    if(walkKm > 0.05) parts.push('🚶 ' + walkKm.toFixed(1) + ' km on foot');
    if(otherKm > 0.05) parts.push('🚌 ' + otherKm.toFixed(1) + ' km by other modes');
    totals.innerHTML = parts.join(' · ') + ' <span class="est-note">· estimated from routes</span>';
    list.appendChild(totals);
  }
  applyPendingFlash();
}

function parseTimeStr(str){
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function shortTitle(t){ return t.length > 18 ? t.slice(0, 17) + '…' : t; }

/* Collapsible tray of unassigned stops. Chips are draggable onto a day's
   schedule (or, in All Stops, onto a day heading). Clicking a chip adds it
   straight to `dayId`; without one (All Stops) it opens a small day picker,
   so the tray works on touch devices too.

   Always rendered, even with nothing in it: the tray is also where you ADD a
   stop that has no day yet, so hiding it when empty hides the only affordance
   for filling it. */
function renderUnassignedTray(host, dayId){
  const items = trip().optional;
  const box = document.createElement('details');
  box.className = 'unassigned-tray' + (items.length ? '' : ' empty');
  const sum = document.createElement('summary');
  sum.innerHTML = 'Unassigned <span class="ut-count' + (items.length ? '' : ' zero') + '">' + items.length + '</span> ' +
    '<span class="ut-hint">' + (items.length
      ? (dayId ? 'click to add to this day, or drag onto the schedule' : 'drag onto a day, or click to choose one')
      : 'stops with no day yet — add one here') + '</span>';
  box.appendChild(sum);

  const row = document.createElement('div');
  row.className = 'ut-chips';
  if(!items.length){
    const hint = document.createElement('span');
    hint.className = 'ut-empty';
    hint.textContent = 'Nothing unassigned. Add a stop here to park it without a day, or send an existing one over with “Move to… → Unassigned”.';
    row.appendChild(hint);
  }
  items.forEach(o => {
    const s = trip().stops[o.id];
    if(!s) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ut-chip';
    chip.draggable = true;
    chip.dataset.id = o.id;
    chip.innerHTML = (ICONS[s.cat] || '📍') + ' ' + esc(s.name) +
      (o.day ? ' <span class="ut-sug">D' + o.day + '?</span>' : '');
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', o.id);
      e.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      if(dayId){ moveToDay(null, o.id, dayId); return; }
      const open = chip.querySelector('.ut-menu');
      document.querySelectorAll('.ut-menu').forEach(m => m.remove());
      if(open) return;
      const menu = document.createElement('span');
      menu.className = 'ut-menu';
      trip().days.forEach(d => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mode-opt';
        b.textContent = 'D' + d.id;
        b.title = d.title;
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          moveToDay(null, o.id, d.id);
          renderAllStops();
        });
        menu.appendChild(b);
      });
      chip.appendChild(menu);
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
    });
    row.appendChild(chip);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ut-chip ut-add';
  add.textContent = '+ Add unassigned stop';
  add.title = 'Add a stop with no day yet — park it here and place it later';
  add.addEventListener('click', () => openLocationForm(null, 'optional'));
  row.appendChild(add);

  box.appendChild(row);
  host.appendChild(box);
}

/* ---------- reorder / move / bin ---------- */

function moveStop(day, id, delta){
  const order = day.order;
  const idx = order.indexOf(id);
  const newIdx = idx + delta;
  if(idx === -1 || newIdx < 0 || newIdx >= order.length) return;
  pushUndo();
  [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
  saveState();
  renderDayPanel();
  updateUndoButton();
}

/* Reorder within a day, or place a stop dragged in from the Unassigned tray
   (or another day) at that position. targetId null appends to the end. */
function reorder(day, draggedId, targetId, before){
  if(!draggedId || draggedId === targetId || !trip().stops[draggedId]) return;
  const fromIdx = day.order.indexOf(draggedId);
  pushUndo();
  if(fromIdx === -1){
    // arriving from outside this day — detach from wherever it was
    trip().days.forEach(d => { d.order = d.order.filter(x => x !== draggedId); });
    trip().optional = trip().optional.filter(o => o.id !== draggedId);
    trip().bin = trip().bin.filter(x => x !== draggedId);
  } else {
    day.order.splice(fromIdx, 1);
  }
  // Read AFTER the detach: filtering above replaces each day's order array,
  // so a reference captured earlier would point at a detached copy.
  const order = day.order;
  let toIdx = targetId ? order.indexOf(targetId) : order.length;
  if(toIdx === -1) toIdx = order.length;
  else if(targetId && !before) toIdx += 1;
  order.splice(toIdx, 0, draggedId);
  saveState();
  renderDayPanel();
  updateUndoButton();
}

function removeToBin(day, id){
  pushUndo();
  if(day) day.order = day.order.filter(x => x !== id);
  trip().optional = trip().optional.filter(o => o.id !== id);
  if(!trip().bin.includes(id)) trip().bin.push(id);
  saveState();
  renderAll();
}

function moveToDay(day, id, targetDayId){
  const target = trip().days.find(d => d.id === targetDayId);
  if(!target) return;
  pushUndo();
  if(day) day.order = day.order.filter(x => x !== id);
  trip().optional = trip().optional.filter(o => o.id !== id);
  trip().bin = trip().bin.filter(x => x !== id);
  target.order.push(id);
  saveState();
  renderAll();
}

function moveToOptional(day, id){
  pushUndo();
  if(day) day.order = day.order.filter(x => x !== id);
  trip().bin = trip().bin.filter(x => x !== id);
  if(!trip().optional.some(o => o.id === id)) trip().optional.push({ id, day:null, note:'' });
  saveState();
  renderAll();
}

export function updateUndoButton(){
  const btn = $('undo-btn');
  if(btn) btn.disabled = state.undoStack.length === 0;
}

/* =========================================================
   MAP
   ========================================================= */
function fitMapToDay(){
  if(!leafletMap || !mapFitPts || mapFitPts.length < 2) return false;
  const size = leafletMap.getSize();
  if(size.x < 40 || size.y < 40){ mapFitPending = true; return false; }
  leafletMap.fitBounds(mapFitPts, { padding:[30,30], maxZoom:16, animate:false });
  mapFitPending = false;
  return true;
}

function renderMap(day, sched){
  const mapEl = $('map');
  if(!mapEl) return;
  if(typeof L === 'undefined'){   // vendored Leaflet failed to load — degrade gracefully
    mapEl.innerHTML = '<p style="padding:16px;color:var(--ink-soft);font-size:13px;">Map library failed to load.</p>';
    return;
  }

  // Reuse the map instance whenever its container survived the render —
  // recreating Leaflet on every routed-time arrival flickers tiles and
  // stomps the user's pan/zoom.
  const sameContainer = leafletMap && leafletMap.getContainer() === mapEl;
  if(!sameContainer){
    if(leafletMap){ try{ leafletMap.stop(); leafletMap.remove(); }catch(e){} }
    leafletMap = L.map('map', { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(leafletMap);
    mapLayerGroup = L.layerGroup().addTo(leafletMap);
    lastMapDayId = null;
  } else {
    leafletMap.stop();          // halt any in-flight pan/zoom before mutating layers
    mapLayerGroup.clearLayers();
  }

  const pts = [];        // marker points, in visit order (drives fitBounds)
  const segs = [];       // legs between consecutive points: {from, to, path|null}
  let order = 0;
  const startHotel = (sched.startHotel && sched.startHotel.lat != null) ? sched.startHotel : null;
  const endHotel = (sched.endHotel && sched.endHotel.lat != null) ? sched.endHotel : null;
  const sameHotel = !!(startHotel && endHotel && startHotel.id === endHotel.id);
  let prevPt = null;

  const hotelMarker = (h, role) => {
    const hotelIcon = L.divIcon({
      className: '',
      html: '<div class="map-pin hotel-pin"><span>' + (h.mode === 'boat' ? '🚤' : '🏨') + '</span></div>',
      iconSize: [26,26],
      iconAnchor: [13,24]
    });
    L.marker([h.lat, h.lng], { icon: hotelIcon }).addTo(mapLayerGroup)
      .bindPopup('<b>' + esc(h.name) + '</b><br>' + role);
  };
  if(startHotel){
    hotelMarker(startHotel, sameHotel ? 'start / end of day' : 'start of the day');
    pts.push([startHotel.lat, startHotel.lng]);
    prevPt = [startHotel.lat, startHotel.lng];
  }
  if(endHotel && !sameHotel) hotelMarker(endHotel, 'end of the day');

  sched.rows.forEach(row => {
    const s = row.stop;
    if(s.lat == null || s.lng == null) return;
    // The number is counted before the pin is drawn, so hiding one stop never
    // renumbers the others — the map keeps 1, 2, 4 and the cards still match.
    order += 1;
    if(!s.hidden){
      const icon = L.divIcon({
        className: '',
        // A ticked-off stop keeps its pin and its number — greyed, so the map
        // reads as "here's what's left" at a glance.
        html: '<div class="map-pin' + (s.done ? ' done-pin' : '') + '"><span>' + order + '</span></div>',
        iconSize: [26,26],
        iconAnchor: [13,24]
      });
      L.marker([s.lat, s.lng], { icon }).addTo(mapLayerGroup)
        .bindPopup('<b>' + esc(s.name) + '</b><br>' + formatTime(row.start) + (s.done ? ' · ✓ done' : ''));
    }
    const cur = [s.lat, s.lng];
    // travelPath on a row is the routed geometry of the leg ARRIVING at it
    // (computed in the same sequence computeSchedule walked).
    if(prevPt) segs.push({ from: prevPt, to: cur, path: row.travelPath });
    pts.push(cur);
    prevPt = cur;

    // Point-to-point stop: draw the leg itself and continue from its end —
    // a hike as its routed walking path, a ride as a straight line between
    // its stations.
    if(AB_CATS.includes(s.cat) && s.endLat != null && s.endLng != null){
      const end = [s.endLat, s.endLng];
      const isHike = s.cat === 'hike';
      const endIcon = L.divIcon({
        className: '',
        html: '<div class="map-pin hike-end-pin"><span>' + (isHike ? '🏁' : (ICONS[s.cat] || '📍')) + '</span></div>',
        iconSize: [26,26],
        iconAnchor: [13,24]
      });
      // Both ends belong to the one stop: hiding it takes the arrival pin too.
      if(!s.hidden){
        L.marker(end, { icon: endIcon }).addTo(mapLayerGroup)
          .bindPopup('<b>' + esc(s.name) + '</b><br>' + (isHike ? 'hike ends here' : 'arrives here'));
      }
      segs.push({ from: cur, to: end, path: row.hikeLeg ? row.hikeLeg.path : null, hike: isHike });
      pts.push(end);
      prevPt = end;
    }
  });

  if(endHotel && prevPt && sched.trailTransfer){
    segs.push({ from: prevPt, to: [endHotel.lat, endHotel.lng], path: sched.trailTransfer.path });
    pts.push([endHotel.lat, endHotel.lng]);
  } else if(endHotel && !sameHotel){
    pts.push([endHotel.lat, endHotel.lng]);   // no routed leg yet, but keep the pin in view
  }

  // Read from the panel, not the root: the panel may carry a per-day colour
  // override on --accent (data-day-color), which the polylines must follow.
  const accent = getComputedStyle($('daypanel')).getPropertyValue('--accent').trim() || '#C1502E';
  const boundPts = pts.slice();
  const gold = getComputedStyle($('daypanel')).getPropertyValue('--gold').trim() || '#B8891F';
  segs.forEach(seg => {
    const color = seg.hike ? gold : accent;   // hikes draw in the accent-gold so they read as "on foot, on purpose"
    if(seg.path && seg.path.length > 1){
      // Real routed geometry: solid line following the streets/canals/trails.
      L.polyline(seg.path, { color, weight: 3.5, opacity: 0.85 }).addTo(mapLayerGroup);
      boundPts.push(...seg.path);
    } else {
      // No routed shape (yet, or boat shuttle): dashed straight estimate.
      L.polyline([seg.from, seg.to], { color, weight: 3, dashArray: '6 6', opacity: 0.7 }).addTo(mapLayerGroup);
    }
  });

  mapFitPts = boundPts;
  mapFitPending = false;
  const dayChanged = lastMapDayId !== day.id || !sameContainer;
  lastMapDayId = day.id;
  if(!dayChanged) return;              // same day refreshed: keep the user's pan/zoom
  if(boundPts.length > 1){
    if(!fitMapToDay()){
      leafletMap.setView(L.latLngBounds(boundPts).getCenter(), 13, { animate:false });
    }
  } else if(boundPts.length === 1){
    leafletMap.setView(boundPts[0], 15, { animate:false });
  } else {
    leafletMap.setView([30, 10], 2, { animate:false });   // blank trip: whole-world view
  }
}

/* Light refresh: recompute times and redraw list + map layers WITHOUT
   rebuilding the panel DOM (so the map instance and pan/zoom survive).
   Used when routed travel times land in the background. */
function refreshDaySchedule(){
  const day = currentDay();
  if(!document.getElementById('schedule-list')) { renderDayPanel(); return; }
  // Don't rip the list out from under an open transport-mode menu — a routed
  // time landing mid-interaction would otherwise close it.
  if(document.querySelector('.mode-menu')) return;
  const sched = computeSchedule(trip(), day);
  renderScheduleList(day, sched);
  renderMap(day, sched);
}

/* =========================================================
   DETAIL MODAL (with notes)
   ========================================================= */
const saveNotesDebounced = debounce(() => {
  if(!modalStopId) return;
  const s = trip().stops[modalStopId];
  if(!s) return;
  s.notes = $('modal-notes').value;
  saveState();
}, 500);

function openModal(stopId, row){
  const stop = trip().stops[stopId];
  if(!stop) return;
  modalStopId = stopId;
  const photo = $('modal-photo');
  if(stop.img) mountImage(photo, stop.img, ICONS[stop.cat] || '📍', { alt: stop.name });
  else { photo.textContent = ICONS[stop.cat] || '📍'; photo.classList.remove('has-img'); }
  $('modal-time-row').textContent = row ? (formatTime(row.start) + ' · ' + formatDur(stop.dur)) : formatDur(stop.dur);
  $('modal-title').textContent = stop.name;
  $('modal-tags').innerHTML = stop.tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('');
  const full = stop.detail ? (stop.desc + '\n\n' + stop.detail) : stop.desc;
  $('modal-text').textContent = full;
  $('modal-notes').value = stop.notes || '';
  paintModalDone(stop);
  paintModalHide(stop);

  $('modal-overlay').classList.add('open');
  lastFocusedEl = document.activeElement;
  $('modal-close').focus();
  document.body.style.overflow = 'hidden';
}
function paintModalDone(stop){
  const btn = $('modal-done');
  if(!btn) return;
  const on = !!stop.done;
  btn.textContent = on ? '✓ Done — untick' : '✓ Mark as done';
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('on', on);
}

function toggleModalDone(){
  const s = modalStopId ? trip().stops[modalStopId] : null;
  if(!s) return;
  pushUndo();
  s.done = !s.done;
  saveState();
  paintModalDone(s);
  updateUndoButton();
}

function paintModalHide(stop){
  const btn = $('modal-hide');
  if(!btn) return;
  const on = !!stop.hidden;
  btn.textContent = on ? '👁 Show on map' : '👁 Hide from map';
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('on', on);
  btn.disabled = stop.lat == null;   // nothing to hide: it was never on the map
  btn.title = stop.lat == null ? 'No coordinates — this stop isn’t on the map anyway' : '';
}

function toggleModalHide(){
  const s = modalStopId ? trip().stops[modalStopId] : null;
  if(!s) return;
  pushUndo();
  s.hidden = !s.hidden;
  saveState();
  paintModalHide(s);
  updateUndoButton();
}

function closeModal(){
  const hadStop = modalStopId;
  modalStopId = null;
  $('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
  if(lastFocusedEl && lastFocusedEl.focus) lastFocusedEl.focus();
  // Notes, the done tick or the map eye may have changed while the modal was
  // open — refresh so the 📝 chip, the greyed-out card and the pins follow.
  if(hadStop){
    if(state.currentView === 'days') renderDayPanel();
    else if(state.currentView === 'optional') renderOptional();
    else if(state.currentView === 'all') renderAllStops();
  }
}

/* =========================================================
   ADD / EDIT LOCATION
   ========================================================= */
function fillDaySelect(sel, selectedValue){
  sel.innerHTML = trip().days.map(d =>
    `<option value="${d.id}">D${d.id} — ${esc(d.title)}</option>`).join('') +
    `<option value="optional">Unassigned (no day yet)</option>`;
  sel.value = selectedValue;
  if(!sel.value) sel.value = String(trip().days[0].id);
}

function whereIsStop(id){
  for(const d of trip().days){ if(d.order.includes(id)) return String(d.id); }
  if(trip().optional.some(o => o.id === id)) return 'optional';
  return 'bin';
}

/* Coordinates stay hidden while search can fill them; the status line shows
   what's set, with a manual-entry escape hatch. */
export function refreshCoordsStatus(){
  const lat = $('al-lat').value.trim(), lng = $('al-lng').value.trim();
  const st = $('al-coords-status');
  if(lat && lng){
    st.innerHTML = `✓ Coordinates: ${esc(lat)}, ${esc(lng)} — <button type="button" class="linklike" data-act="toggle">edit</button>`;
  } else {
    st.innerHTML = `No coordinates yet — pick a search suggestion above, or <button type="button" class="linklike" data-act="toggle">enter them manually</button>.`;
  }
  st.querySelector('[data-act="toggle"]').addEventListener('click', () => {
    $('al-coords-wrap').classList.toggle('hidden');
  });
}

/* The "ends at" fields appear for any category that can run point-to-point:
   a hike, a train / travel leg, a flight, a boat. */
function refreshEndPointFields(){
  $('al-end-wrap').classList.toggle('hidden', !AB_CATS.includes($('al-cat').value));
}

export function openLocationForm(editStopId, defaultDayId){
  const catSel = $('al-cat');
  catSel.innerHTML = CATEGORIES.map(c => `<option value="${c}">${CAT_LABEL[c]}</option>`).join('');
  $('add-location-form').reset();
  $('al-editing').value = editStopId || '';
  $('al-heading').textContent = editStopId ? 'Edit location' : 'Add a location';
  $('al-submit').textContent = editStopId ? 'Save changes' : 'Add location';

  if(editStopId){
    const s = trip().stops[editStopId];
    $('al-name').value = s.name;
    catSel.value = s.cat;
    $('al-dur').value = s.dur;
    $('al-fixed').value = s.fixedStart || '';
    $('al-lat').value = s.lat ?? '';
    $('al-lng').value = s.lng ?? '';
    $('al-endlat').value = s.endLat ?? '';
    $('al-endlng').value = s.endLng ?? '';
    $('al-end-search').value = '';
    $('al-desc').value = s.desc || '';
    $('al-detail').value = s.detail || '';
    $('al-notes').value = s.notes || '';
    $('al-img').value = s.img || '';
    $('al-tags').value = s.tags.join(', ');
    fillDaySelect($('al-day'), whereIsStop(editStopId));
  } else {
    catSel.value = 'landmark';
    $('al-dur').value = 60;
    fillDaySelect($('al-day'), String(defaultDayId || currentDay().id));
  }

  $('al-coords-wrap').classList.add('hidden');
  refreshCoordsStatus();
  refreshEndPointFields();

  $('add-location-overlay').classList.add('open');
  lastFocusedEl = document.activeElement;
  $('al-name').focus();
  document.body.style.overflow = 'hidden';
}
function closeLocationForm(){
  $('add-location-overlay').classList.remove('open');
  document.body.style.overflow = '';
  if(lastFocusedEl && lastFocusedEl.focus) lastFocusedEl.focus();
}

function submitLocationForm(e){
  e.preventDefault();
  const name = $('al-name').value.trim();
  if(!name){ alert('The location needs a name.'); return; }
  const latRaw = $('al-lat').value.trim(), lngRaw = $('al-lng').value.trim();
  const lat = latRaw === '' ? null : parseFloat(latRaw);
  const lng = lngRaw === '' ? null : parseFloat(lngRaw);
  if((lat != null && (isNaN(lat) || lat < -90 || lat > 90)) || (lng != null && (isNaN(lng) || lng < -180 || lng > 180))){
    alert('Latitude/longitude don’t look like coordinates. Leave both blank if you don’t know them.');
    return;
  }
  const cat = $('al-cat').value;
  const endLat = AB_CATS.includes(cat) ? parseFloat($('al-endlat').value) : NaN;
  const endLng = AB_CATS.includes(cat) ? parseFloat($('al-endlng').value) : NaN;
  pushUndo();
  const editId = $('al-editing').value;
  const id = editId || nextStopId();
  // The form doesn't cover everything a stop carries: an edit rebuilds the
  // object, so the fields it never asked about are carried across rather
  // than quietly reset (a pinned transport mode, a done tick, a hidden pin).
  const prev = editId ? trip().stops[editId] : null;
  trip().stops[id] = {
    id, name, cat,
    dur: parseInt($('al-dur').value, 10) || DEFAULT_DUR[cat] || 45,
    lat: (lat != null && lng != null) ? lat : null,
    lng: (lat != null && lng != null) ? lng : null,
    endLat: (!isNaN(endLat) && !isNaN(endLng)) ? endLat : null,
    endLng: (!isNaN(endLat) && !isNaN(endLng)) ? endLng : null,
    fixedStart: /^\d{1,2}:\d{2}$/.test($('al-fixed').value) ? $('al-fixed').value : null,
    arriveBy: prev ? prev.arriveBy || null : null,
    done: prev ? !!prev.done : false,
    hidden: prev ? !!prev.hidden : false,
    img: $('al-img').value.trim(),
    desc: $('al-desc').value.trim(),
    detail: $('al-detail').value.trim(),
    notes: $('al-notes').value.trim(),
    tags: $('al-tags').value.split(',').map(t => t.trim()).filter(Boolean),
  };
  const dest = $('al-day').value;
  const from = editId ? whereIsStop(editId) : null;
  if(dest !== from){
    trip().days.forEach(d => { d.order = d.order.filter(x => x !== id); });
    trip().optional = trip().optional.filter(o => o.id !== id);
    trip().bin = trip().bin.filter(x => x !== id);
    if(dest === 'optional') trip().optional.push({ id, day:null, note:'' });
    else {
      const d = trip().days.find(d => d.id === parseInt(dest, 10)) || trip().days[0];
      d.order.push(id);
      state.currentDayIndex = trip().days.indexOf(d);
    }
  }
  saveState();
  closeLocationForm();
  renderAll();
}

/* =========================================================
   DAY EDIT
   ========================================================= */
/* Day-colour picker inside the Edit-day modal: one "Theme" swatch (follow
   the theme accent, i.e. color:null) plus the DAY_COLORS palette. */
let deColor = null;
function renderDayColorRow(){
  const row = $('de-color-row');
  if(!row) return;
  row.innerHTML = '';
  const mk = (key, label, swatchColor) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day-color-swatch' + (deColor === key ? ' active' : '') + (swatchColor ? '' : ' none');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', deColor === key ? 'true' : 'false');
    if(swatchColor) b.style.setProperty('--sw', swatchColor);
    b.innerHTML = '<span class="sw-dot"></span><span class="sw-name">' + esc(label) + '</span>';
    b.addEventListener('click', () => { deColor = key; renderDayColorRow(); });
    row.appendChild(b);
  };
  mk(null, 'Theme', null);
  Object.entries(DAY_COLORS).forEach(([key, c]) => mk(key, c.name, c.accent));
}

function openDayEdit(dayIndex){
  const day = trip().days[dayIndex];
  $('de-index').value = String(dayIndex);
  $('de-title').value = day.title;
  $('de-start').value = day.start;
  deColor = DAY_COLORS[day.color] ? day.color : null;
  renderDayColorRow();
  // Each end of the day picks its hotel independently — same hotel both ends
  // is the normal day, and any other combination is just a different pick.
  const hotelOpts = `<option value="">No hotel</option>` +
    trip().hotels.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
  $('de-start-hotel').innerHTML = hotelOpts;
  $('de-end-hotel').innerHTML = hotelOpts;
  $('de-start-hotel').value = day.startHotelId || '';
  $('de-end-hotel').value = day.endHotelId || '';
  syncDayMoveButtons(dayIndex);
  $('day-edit-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

/* Reordering for touch, where dragging a tab isn't available. The modal
   stays open on the day it was opened for, which has just changed index. */
function syncDayMoveButtons(idx){
  $('de-earlier').disabled = idx <= 0;
  $('de-later').disabled = idx >= trip().days.length - 1;
}
function moveDayFromModal(dir){
  const idx = parseInt($('de-index').value, 10);
  const landed = moveDay(idx, dir < 0 ? idx - 1 : idx + 2);
  if(landed == null) return;
  $('de-index').value = String(landed);
  syncDayMoveButtons(landed);
}
function closeDayEdit(){
  $('day-edit-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
function submitDayEdit(e){
  e.preventDefault();
  const day = trip().days[parseInt($('de-index').value, 10)];
  if(!day) return;
  pushUndo();
  day.title = $('de-title').value.trim() || day.title;
  day.start = $('de-start').value || day.start;
  day.startHotelId = $('de-start-hotel').value || null;
  day.endHotelId = $('de-end-hotel').value || null;
  day.color = DAY_COLORS[deColor] ? deColor : null;
  saveState();
  closeDayEdit();
  renderAll();
}
function deleteDay(){
  const idx = parseInt($('de-index').value, 10);
  const day = trip().days[idx];
  if(!day) return;
  if(trip().days.length === 1){ alert('A trip needs at least one day.'); return; }
  if(!confirm('Delete Day ' + day.id + ' — ' + day.title + '? Its stops go to the bin.')) return;
  pushUndo();
  day.order.forEach(id => { if(!trip().bin.includes(id)) trip().bin.push(id); });
  trip().days.splice(idx, 1);
  trip().days.forEach((d, i) => { d.id = i + 1; });
  state.currentDayIndex = Math.min(state.currentDayIndex, trip().days.length - 1);
  saveState();
  closeDayEdit();
  renderAll();
}

/* =========================================================
   HOTELS
   ========================================================= */
function openHotelEdit(hotelId){
  $('hotel-edit-form').reset();
  $('he-editing').value = hotelId || '';
  $('he-heading').textContent = hotelId ? 'Edit hotel' : 'Add a hotel';
  if(hotelId){
    const h = trip().hotels.find(h => h.id === hotelId);
    $('he-name').value = h.name;
    $('he-lat').value = h.lat ?? '';
    $('he-lng').value = h.lng ?? '';
    $('he-mode').value = h.mode || 'walk';
    $('he-img').value = h.img || '';
    $('he-desc').value = h.desc || '';
  }
  $('hotel-edit-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeHotelEdit(){
  $('hotel-edit-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
function submitHotelEdit(e){
  e.preventDefault();
  const name = $('he-name').value.trim();
  if(!name) return;
  const lat = parseFloat($('he-lat').value), lng = parseFloat($('he-lng').value);
  pushUndo();
  const editId = $('he-editing').value;
  const hotel = {
    id: editId || nextHotelId(),
    name,
    lat: isNaN(lat) ? null : lat,
    lng: isNaN(lng) ? null : lng,
    mode: $('he-mode').value === 'boat' ? 'boat' : 'walk',
    img: $('he-img').value.trim(),
    desc: $('he-desc').value.trim(),
  };
  if(editId){
    const i = trip().hotels.findIndex(h => h.id === editId);
    if(i !== -1) trip().hotels[i] = hotel;
  } else {
    trip().hotels.push(hotel);
  }
  saveState();
  closeHotelEdit();
  renderAll();
  renderInfo();
}
function deleteHotel(hotelId){
  const h = trip().hotels.find(h => h.id === hotelId);
  if(!h) return;
  if(!confirm('Remove hotel "' + h.name + '"? Days using it will have no hotel.')) return;
  pushUndo();
  trip().hotels = trip().hotels.filter(x => x.id !== hotelId);
  trip().days.forEach(d => {
    if(d.startHotelId === hotelId) d.startHotelId = null;
    if(d.endHotelId === hotelId) d.endHotelId = null;
  });
  saveState();
  renderAll();
  renderInfo();
}

/* =========================================================
   OPTIONAL + BIN VIEWS
   ========================================================= */
function renderOptional(){
  const el = $('optional-list');
  if(!el) return;
  el.innerHTML = '';
  if(!trip().optional.length){
    el.innerHTML = `<p style="padding:20px 22px; color:var(--ink-soft); font-size:14px;">Nothing unassigned. Use "Move to… → Unassigned" on any stop, choose "Unassigned" when adding a location, or include an "## Unassigned" section in an imported trip.</p>`;
    return;
  }
  trip().optional.forEach(o => {
    const s = trip().stops[o.id];
    if(!s) return;
    const row = document.createElement('div');
    row.className = 'bin-row';
    const dayOptions = trip().days.map(d =>
      `<option value="${d.id}" ${d.id === o.day ? 'selected' : ''}>D${d.id} — ${esc(d.title)}</option>`).join('');
    const suggested = o.day && trip().days.find(d => d.id === o.day);
    row.innerHTML = `
      <div class="stop-illustration">${ICONS[s.cat] || '📍'}</div>
      <div class="stop-main">
        <p class="stop-name">${esc(s.name)}</p>
        <p class="stop-desc">${esc(s.desc)}</p>
        ${suggested || o.note ? `<p class="stop-desc" style="font-style:italic;">${suggested ? 'Suggested: Day ' + o.day + ' — ' + esc(suggested.title) + '. ' : ''}${esc(o.note || '')}</p>` : ''}
      </div>
      <div class="manage-row">
        <select class="restore-to-day">${dayOptions}</select>
        <button class="restore-btn">+ Add</button>
        <button class="bin-btn" title="Remove to bin">🗑</button>
      </div>
    `;
    row.querySelector('.stop-main').style.cursor = 'pointer';
    row.querySelector('.stop-main').addEventListener('click', () => openModal(o.id, null));
    row.querySelector('.restore-btn').addEventListener('click', () => {
      const targetDayId = parseInt(row.querySelector('.restore-to-day').value, 10);
      moveToDay(null, o.id, targetDayId);
    });
    row.querySelector('.bin-btn').addEventListener('click', () => removeToBin(null, o.id));
    el.appendChild(row);
  });
}

function renderBin(){
  const el = $('bin-list');
  if(!el) return;
  const doneItems = trip().checklist.filter(c => c.done);
  if(state.trip.bin.length === 0 && !doneItems.length){
    el.innerHTML = `<p style="padding:20px 22px; color:var(--ink-soft); font-size:14px;">Nothing in the bin. Remove a stop from any day (the 🗑 button), or tick a checklist item off in Trip Info, and it'll show up here to bring back later.</p>`;
    return;
  }
  el.innerHTML = '';
  if(state.trip.bin.length){
    const head = document.createElement('div');
    head.className = 'bin-head';
    head.textContent = 'Removed locations (' + state.trip.bin.length + ')';
    el.appendChild(head);
  }
  trip().bin.forEach(id => {
    const s = trip().stops[id];
    if(!s) return;
    const row = document.createElement('div');
    row.className = 'bin-row';
    const dayOptions = trip().days.map(d => `<option value="${d.id}">D${d.id} — ${esc(d.title)}</option>`).join('');
    row.innerHTML = `
      <div class="stop-illustration">${ICONS[s.cat] || '📍'}</div>
      <div class="stop-main">
        <p class="stop-name">${esc(s.name)}</p>
        <p class="stop-desc">${esc(s.desc)}</p>
      </div>
      <div class="manage-row">
        <select class="restore-to-day">${dayOptions}</select>
        <button class="restore-btn">Restore</button>
        <button class="bin-btn" title="Delete forever">✕</button>
      </div>
    `;
    row.querySelector('.restore-btn').addEventListener('click', () => {
      const targetDayId = parseInt(row.querySelector('.restore-to-day').value, 10);
      moveToDay(null, id, targetDayId);
    });
    row.querySelector('.bin-btn').addEventListener('click', () => {
      if(!confirm('Delete "' + s.name + '" permanently?')) return;
      pushUndo();
      trip().bin = trip().bin.filter(x => x !== id);
      delete trip().stops[id];
      saveState();
      renderBin();
      updateUndoButton();
    });
    el.appendChild(row);
  });

  // Completed checklist items park here — ticked, not lost.
  if(doneItems.length){
    const head = document.createElement('div');
    head.className = 'bin-head';
    head.textContent = 'Completed checklist (' + doneItems.length + ')';
    el.appendChild(head);
    doneItems.forEach(item => {
      const row = document.createElement('div');
      row.className = 'bin-row check-bin-row';
      row.innerHTML = `
        <div class="stop-illustration">✅</div>
        <div class="stop-main"><p class="stop-name done">${esc(item.text)}</p></div>
        <div class="manage-row">
          <button class="restore-btn">Return</button>
          <button class="bin-btn" title="Delete forever">✕</button>
        </div>`;
      row.querySelector('.restore-btn').addEventListener('click', () => {
        pushUndo();
        item.done = false;
        saveState();
        renderBin();
        if(state.currentView === 'info') renderInfo();
        updateUndoButton();
      });
      row.querySelector('.bin-btn').addEventListener('click', () => {
        if(!confirm('Delete "' + item.text + '" permanently?')) return;
        pushUndo();
        trip().checklist = trip().checklist.filter(c => c.id !== item.id);
        saveState();
        renderBin();
        updateUndoButton();
      });
      el.appendChild(row);
    });
  }
}

/* =========================================================
   GOOGLE MAPS ROUTE PICKER

   A day is often more points than Google's 11-point directions
   cap, and usually you only want to navigate part of it — so the
   button opens the day's located points by name (hotel bookends,
   stops, hike ends) and hands Google only the ticked ones, in day
   order. Everything is ticked on open, with select all / none for
   the common "just these two" case.
   ========================================================= */
const GMAPS_MAX = 11;      // origin + 9 waypoints + destination
let gmapsPts = [];         // the day's points, in visit order
let gmapsPicked = [];      // parallel ticks

function openGmapsPicker(day){
  gmapsPts = dayMapPoints(trip(), day);
  if(gmapsPts.length < 2){
    alert('This day needs at least two located stops for a Google Maps route.');
    return;
  }
  // Everything is ticked on open except the stops taken off the map — they are
  // listed, and can be ticked back in, but they don't shape the route by default.
  gmapsPicked = gmapsPts.map(p => !p.hidden);
  $('gmaps-heading').textContent = 'Google Maps — Day ' + day.id;
  const list = $('gmaps-list');
  list.innerHTML = gmapsPts.map(p => `
    <label class="gmaps-row">
      <input type="checkbox"${p.hidden ? '' : ' checked'}>
      <span class="gm-num${p.num == null ? ' gm-num-none' : ''}"${p.num == null ? ' title="A hotel bookend — the day doesn&#39;t number it"' : ''}>${p.num == null ? '–' : esc(p.num)}</span>
      <span class="gm-icon" aria-hidden="true">${ICONS[p.cat] || '📍'}</span>
      <span class="gm-main">
        <span class="gm-name">${esc(p.label)}</span>
        ${p.when ? `<span class="gm-when">${esc(p.when)}</span>` : ''}
      </span>
    </label>`).join('');
  list.querySelectorAll('input[type="checkbox"]').forEach((box, i) => {
    box.addEventListener('change', () => { gmapsPicked[i] = box.checked; refreshGmapsPicker(); });
  });
  refreshGmapsPicker();
  $('gmaps-overlay').classList.add('open');
  lastFocusedEl = document.activeElement;
  $('gmaps-close').focus();
  document.body.style.overflow = 'hidden';
}

function setAllGmapsPicks(on){
  gmapsPicked = gmapsPicked.map(() => on);
  $('gmaps-list').querySelectorAll('input[type="checkbox"]').forEach(box => { box.checked = on; });
  refreshGmapsPicker();
}

/* The numbers are the itinerary's own — stop 4 stays "4" however the ticks
   fall, so a route between two stops is picked by the numbers you see on the
   day. Only the styling follows the selection: unticked rows grey out, and
   ticked ones past Google's cap are shown as dropped, not silently lost. */
function refreshGmapsPicker(){
  let n = 0;
  $('gmaps-list').querySelectorAll('.gmaps-row').forEach((row, i) => {
    const on = gmapsPicked[i];
    if(on) n += 1;
    row.classList.toggle('off', !on);
    row.classList.toggle('over', on && n > GMAPS_MAX);
  });
  $('gmaps-count').textContent = n + ' of ' + gmapsPts.length + ' selected';
  const note = $('gmaps-note');
  const openBtn = $('gmaps-open');
  if(n < 2){
    note.textContent = 'Pick at least two — a start and a destination.';
    note.classList.remove('warn');
  } else if(n > GMAPS_MAX){
    note.textContent = 'Google Maps links carry at most ' + GMAPS_MAX + ' points — the greyed-out ticks past the ' +
      GMAPS_MAX + 'th will be left out.';
    note.classList.add('warn');
  } else {
    note.textContent = 'Opens as a walking route through these ' + n + ' points, in this order.';
    note.classList.remove('warn');
  }
  openBtn.disabled = n < 2;
}

function openGmapsRoute(){
  const { url } = googleMapsUrl(gmapsPts.filter((p, i) => gmapsPicked[i]));
  if(!url) return;
  closeGmapsPicker();
  window.open(url, '_blank', 'noopener');
}

function closeGmapsPicker(){
  $('gmaps-overlay').classList.remove('open');
  document.body.style.overflow = '';
  if(lastFocusedEl && lastFocusedEl.focus) lastFocusedEl.focus();
}

/* =========================================================
   SEARCH — find any location and where it's slotted
   ========================================================= */
function openSearch(){
  $('search-overlay').classList.add('open');
  lastFocusedEl = document.activeElement;
  $('search-input').value = '';
  $('search-results').innerHTML = '<p class="search-hint">Type to search every stop — scheduled, optional, or binned — by name, description, notes, or tags.</p>';
  $('search-input').focus();
  document.body.style.overflow = 'hidden';
}
function closeSearch(){
  $('search-overlay').classList.remove('open');
  document.body.style.overflow = '';
  if(lastFocusedEl && lastFocusedEl.focus) lastFocusedEl.focus();
}

/* Where is this stop, and when? Returns {kind, day, time, optMeta}. */
function locateStop(id, schedules){
  for(const d of trip().days){
    if(d.order.includes(id)){
      const sched = schedules.get(d.id) || schedules.set(d.id, computeSchedule(trip(), d)).get(d.id);
      const row = sched.rows.find(r => r.stop.id === id);
      return { kind:'day', day:d, time: row ? row.start : null };
    }
  }
  const opt = trip().optional.find(o => o.id === id);
  if(opt) return { kind:'optional', optMeta: opt };
  if(trip().bin.includes(id)) return { kind:'bin' };
  return { kind:'lost' };
}

function runSearch(){
  const q = $('search-input').value.trim().toLowerCase();
  const out = $('search-results');
  if(q.length < 2){
    out.innerHTML = '<p class="search-hint">Keep typing…</p>';
    return;
  }
  const schedules = new Map();
  const scored = [];
  Object.values(trip().stops).forEach(s => {
    const name = s.name.toLowerCase();
    let score = -1;
    if(name.startsWith(q)) score = 0;
    else if(name.includes(q)) score = 1;
    else if((s.desc || '').toLowerCase().includes(q) || (s.notes || '').toLowerCase().includes(q)
      || (s.detail || '').toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q))) score = 2;
    if(score >= 0) scored.push({ s, score });
  });
  const hotelHits = trip().hotels.filter(h => h.name.toLowerCase().includes(q));
  scored.sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name));

  if(!scored.length && !hotelHits.length){
    out.innerHTML = '<p class="search-hint">No matches for “' + esc(q) + '”.</p>';
    return;
  }
  out.innerHTML = '';
  scored.slice(0, 25).forEach(({ s }) => {
    const loc = locateStop(s.id, schedules);
    let whereHtml = '';
    if(loc.kind === 'day'){
      whereHtml = `<span class="sr-where">D${loc.day.id} · ${esc(shortTitle(loc.day.title))}${loc.time != null ? ' · ' + formatTime(loc.time) : ''}</span>`;
    } else if(loc.kind === 'optional'){
      whereHtml = `<span class="sr-where">Unassigned${loc.optMeta.day ? ' · suggested D' + loc.optMeta.day : ''}</span>`;
    } else if(loc.kind === 'bin'){
      whereHtml = `<span class="sr-where">Bin</span>`;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-row' + (s.done ? ' done' : '');
    row.innerHTML = `<span class="sr-icon">${s.done ? '✓' : (ICONS[s.cat] || '📍')}</span>
      <span class="sr-main"><span class="sr-name">${esc(s.name)}</span>${whereHtml}</span>`;
    row.addEventListener('click', () => {
      closeSearch();
      if(loc.kind === 'day'){
        state.currentDayIndex = trip().days.indexOf(loc.day);
        setView('days');
        renderAll();
        pendingFlash = { id: s.id, until: Date.now() + 2600 };
        setTimeout(() => {
          const card = document.querySelector(`.stop-card[data-id="${CSS.escape(s.id)}"]`);
          if(card) card.scrollIntoView({ behavior:'smooth', block:'center' });
          applyPendingFlash();
        }, 120);
      } else if(loc.kind === 'optional'){
        setView('optional');
      } else {
        setView('bin');
      }
    });
    out.appendChild(row);
  });
  hotelHits.forEach(h => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-row';
    const usedBy = trip().days.filter(d => d.startHotelId === h.id || d.endHotelId === h.id).map(d => 'D' + d.id).join(', ');
    row.innerHTML = `<span class="sr-icon">🏨</span>
      <span class="sr-main"><span class="sr-name">${esc(h.name)}</span><span class="sr-where">Hotel${usedBy ? ' · ' + usedBy : ''}</span></span>`;
    row.addEventListener('click', () => { closeSearch(); setView('info'); });
    out.appendChild(row);
  });
}

/* =========================================================
   ALL STOPS VIEW — master list + group-by-proximity
   ========================================================= */
function allStopRow(id, fromDay, isOptional, optMeta){
  const s = trip().stops[id];
  if(!s) return null;
  const row = document.createElement('div');
  row.className = 'bin-row all-row' + (s.done ? ' done' : '') + (s.hidden ? ' off-map' : '');
  const dayOptions = trip().days.map(d =>
    `<option value="${d.id}" ${(!isOptional && fromDay && d.id === fromDay.id) ? 'selected' : (isOptional && optMeta && optMeta.day === d.id ? 'selected' : '')}>D${d.id} — ${esc(shortTitle(d.title))}</option>`).join('');
  row.innerHTML = `
    <div class="stop-illustration">${ICONS[s.cat] || '📍'}</div>
    <div class="stop-main">
      <p class="stop-name">${esc(s.name)}${s.lat == null ? ' <span class="tag-chip" title="No coordinates">no coords</span>' : ''}</p>
      <p class="stop-desc">${esc(s.desc || '')}</p>
    </div>
    <div class="manage-row">
      ${isOptional
        ? `<select class="restore-to-day">${dayOptions}</select><button class="restore-btn">+ Add</button>`
        : `<select class="move-to-day"><option value="">Move to…</option>${trip().days.filter(d => d.id !== fromDay.id).map(d => `<option value="${d.id}">D${d.id} · ${esc(shortTitle(d.title))}</option>`).join('')}<option value="optional">→ Unassigned</option></select>
           ${doneBtnHtml(s)}
           ${hideBtnHtml(s)}
           <button class="bin-btn" title="Remove to bin">🗑</button>`}
      <span class="drag-handle" title="Drag to another day or position" role="button" tabindex="0">⠿</span>
    </div>`;
  row.dataset.id = id;
  row.dataset.dayId = isOptional ? 'optional' : String(fromDay.id);
  row.draggable = false;
  const handle = row.querySelector('.drag-handle');
  handle.addEventListener('click', e => e.stopPropagation());
  handle.addEventListener('mousedown', () => { row.draggable = true; });
  handle.addEventListener('mouseup', () => { row.draggable = false; });
  row.addEventListener('dragstart', e => {
    row.classList.add('dragging');
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    row.draggable = false;
    row.classList.remove('dragging');
    document.querySelectorAll('.all-row, .all-day-head').forEach(x => x.classList.remove('drop-before','drop-after','drop-target'));
  });
  row.addEventListener('dragover', e => {
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    row.classList.toggle('drop-before', before);
    row.classList.toggle('drop-after', !before);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before','drop-after'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    const dragId = e.dataTransfer.getData('text/plain');
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    allStopsMove(dragId, { type:'row', id, dayId: row.dataset.dayId === 'optional' ? 'optional' : Number(row.dataset.dayId), before });
  });
  row.querySelector('.stop-main').style.cursor = 'pointer';
  row.querySelector('.stop-main').addEventListener('click', () => openModal(id, null));
  if(isOptional){
    row.querySelector('.restore-btn').addEventListener('click', () => {
      moveToDay(null, id, parseInt(row.querySelector('.restore-to-day').value, 10));
      renderAllStops();
    });
  } else {
    row.querySelector('.move-to-day').addEventListener('change', e => {
      const v = e.target.value;
      if(v === 'optional') moveToOptional(fromDay, id);
      else if(v) moveToDay(fromDay, id, parseInt(v, 10));
      renderAllStops();
    });
    wireDoneBtn(row, id, null);
    // Switching back to Day by Day only unhides the panel, so the day (and its
    // map) has to be rebuilt here or it would show the pin until something
    // else redrew it.
    wireHideBtn(row, id, () => renderDayPanel());
    row.querySelector('.bin-btn').addEventListener('click', () => { removeToBin(fromDay, id); renderAllStops(); });
  }
  return row;
}

/* Apply a drag-drop move in the All Stops list. */
function allStopsMove(dragId, target){
  if(!dragId || (target.id && target.id === dragId)) return;
  pushUndo();
  trip().days.forEach(dd => { dd.order = dd.order.filter(x => x !== dragId); });
  trip().optional = trip().optional.filter(o => o.id !== dragId);
  trip().bin = trip().bin.filter(x => x !== dragId);
  if(target.type === 'optional'){
    trip().optional.push({ id: dragId, day: null, note: '' });
  } else if(target.type === 'day'){
    const day = trip().days.find(d => d.id === target.dayId);
    if(day) day.order.push(dragId);
  } else if(target.type === 'row'){
    if(target.dayId === 'optional'){
      trip().optional.push({ id: dragId, day: null, note: '' });
    } else {
      const day = trip().days.find(d => d.id === target.dayId);
      if(!day) return;
      let idx = day.order.indexOf(target.id);
      if(idx === -1) idx = day.order.length;
      else if(!target.before) idx += 1;
      day.order.splice(idx, 0, dragId);
    }
  }
  saveState();
  renderAllStops();
  updateUndoButton();
}

export function renderAllStops(){
  const el = $('all-list');
  if(!el) return;
  el.innerHTML = '';
  const t = trip();
  renderUnassignedTray(el, null);
  if(!$('group-days').value || document.activeElement !== $('group-days')){
    $('group-days').value = t.days.length;
  }
  const wireHeadDrop = (head, target) => {
    head.addEventListener('dragover', e => { e.preventDefault(); head.classList.add('drop-target'); });
    head.addEventListener('dragleave', () => head.classList.remove('drop-target'));
    head.addEventListener('drop', e => {
      e.preventDefault();
      allStopsMove(e.dataTransfer.getData('text/plain'), target);
    });
  };
  t.days.forEach(d => {
    const head = document.createElement('div');
    head.className = 'all-day-head';
    if(d.color && DAY_COLORS[d.color]) head.dataset.dayColor = d.color;
    head.textContent = 'Day ' + d.id + ' — ' + d.title + ' (' + d.order.length + ')';
    wireHeadDrop(head, { type:'day', dayId: d.id });
    el.appendChild(head);
    d.order.forEach(id => {
      const row = allStopRow(id, d, false);
      if(row) el.appendChild(row);
    });
  });
  if(t.optional.length){
    const head = document.createElement('div');
    head.className = 'all-day-head';
    head.textContent = 'Unassigned (' + t.optional.length + ')';
    wireHeadDrop(head, { type:'optional' });
    el.appendChild(head);
    t.optional.forEach(o => {
      const row = allStopRow(o.id, null, true, o);
      if(row) el.appendChild(row);
    });
  }
  if(!el.children.length){
    el.innerHTML = '<p style="padding:20px 22px; color:var(--ink-soft); font-size:14px;">No locations yet — add some from a day panel, or import a trip in Trip Info.</p>';
  }
}

/* ---------- Auto-plan: propose, preview, accept ---------- */
let pendingPlan = null;
const apMaps = [];

function destroyApMaps(){
  apMaps.forEach(m => { try{ m.remove(); }catch(e){} });
  apMaps.length = 0;
}

function closeAutoPlan(){
  destroyApMaps();
  pendingPlan = null;
  $('auto-plan-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function acceptAutoPlan(){
  if(!pendingPlan) return;
  const plan = pendingPlan;
  pushUndo();
  closeAutoPlan();
  replaceTrip(plan);
  applyTheme();
  renderAll();
  renderAllStops();
  setView('days');
}

function autoPlanPreview(){
  const base = trip();
  const n = Math.max(1, Math.min(60, parseInt($('group-days').value, 10) || base.days.length));
  const includeOptional = $('group-include-optional') && $('group-include-optional').checked;
  const total = base.days.reduce((s, d) => s + d.order.length, 0) + (includeOptional ? base.optional.length : 0);
  if(total < 2){ alert('Add some locations first — there’s nothing to plan yet.'); return; }

  // Plan on a clone: nothing touches the real trip until Accept.
  const plan = JSON.parse(JSON.stringify(base));
  if(includeOptional){
    plan.optional.forEach(o => plan.days[0].order.push(o.id));
    plan.optional = [];
  }
  if(n > plan.days.length){
    while(plan.days.length < n) plan.days.push(newDay(plan.days.length + 1));
  } else if(n < plan.days.length){
    const removed = plan.days.slice(n);
    removed.forEach(d => plan.days[n - 1].order.push(...d.order));
    plan.days = plan.days.slice(0, n);
  }
  plan.days.forEach((d, i) => { d.id = i + 1; });
  const { orders } = autoPlanOrders(plan);
  plan.days.forEach(d => { if(orders[d.id]) d.order = orders[d.id]; });
  // Colours label areas, and auto-plan just re-clustered the stops — a day's
  // old colour would now tag the wrong place, so the proposal starts clean.
  plan.days.forEach(d => { d.color = null; });
  pendingPlan = plan;
  renderDayMapsOverlay(plan, {
    title: 'Auto-plan preview',
    sub: 'Stops grouped by proximity and what realistically fits each day (visit lengths + travel + hotel legs). Check each day below — nothing changes until you accept.',
    accept: true,
  });
}

/* "Day maps" in All Stops: the same per-day mini-maps as the auto-plan
   preview, but showing the trip exactly as it stands — every day's route
   at a glance without tabbing through Day by Day. */
function previewCurrentRoutes(){
  const t = trip();
  if(!t.days.some(d => d.order.length)){ alert('No stops on any day yet — add some locations first.'); return; }
  pendingPlan = null;
  renderDayMapsOverlay(t, {
    title: 'Day routes as planned',
    sub: 'Every day side by side, stops in their current order with the times they work out to. Nothing changes from here.',
    accept: false,
  });
}

/* One overlay, two uses: a proposed auto-plan (accept / keep current) or a
   read-only look at the days as they stand. `plan` is only read. */
function renderDayMapsOverlay(plan, opts){
  destroyApMaps();
  const wrap = $('ap-days');
  wrap.innerHTML = '';
  $('ap-title').textContent = opts.title;
  $('ap-sub').textContent = opts.sub;
  $('ap-accept').classList.toggle('hidden', !opts.accept);
  $('ap-cancel').textContent = opts.accept ? 'Keep my current plan' : 'Close';
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#C1502E';

  const scheds = plan.days.map(d => computeSchedule(plan, d));
  plan.days.forEach((day, i) => {
    const sched = scheds[i];
    const over = sched.rows.length && sched.returnTime > 22 * 60 + 30;
    const el = document.createElement('div');
    el.className = 'ap-day';
    if(day.color && DAY_COLORS[day.color]) el.dataset.dayColor = day.color;
    el.innerHTML = `
      <div class="ap-head">
        <b>Day ${day.id}${day.title && day.title !== 'Day ' + day.id ? ' — ' + esc(shortTitle(day.title)) : ''}</b> · ${day.order.length} stop${day.order.length === 1 ? '' : 's'}
        ${sched.rows.length ? ' · ' + formatTime(parseTime(day.start)) + ' – ' + formatTime(sched.returnTime) : ''}
        ${sched.walkKm > 0.05 ? ' · 🚶 ' + sched.walkKm.toFixed(1) + ' km' : ''}
        ${over ? ' <span class="late-chip">⚠ runs late — consider more days</span>' : ''}
      </div>
      <div class="ap-map" id="ap-map-${i}"></div>
      <ol class="ap-list">${sched.rows.map(r => `<li>${formatTime(r.start)} — ${esc(r.stop.name)}</li>`).join('') || '<li class="ap-empty">Empty day</li>'}</ol>`;
    wrap.appendChild(el);
  });

  $('auto-plan-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  // Mini-maps need their containers laid out before Leaflet can size them.
  setTimeout(() => {
    if(typeof L === 'undefined') return;
    plan.days.forEach((day, i) => {
      const elId = 'ap-map-' + i;
      const mapEl = document.getElementById(elId);
      if(!mapEl) return;
      // The card may carry a per-day colour override on --accent.
      const dayAccent = getComputedStyle(mapEl).getPropertyValue('--accent').trim() || accent;
      const m = L.map(elId, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
      const pts = [];
      const hotelPin = (h) => L.marker([h.lat, h.lng], { icon: L.divIcon({
        className: '', html: '<div class="map-pin hotel-pin ap-pin"><span>' + (h.mode === 'boat' ? '🚤' : '🏨') + '</span></div>',
        iconSize: [20, 20], iconAnchor: [10, 10]
      })}).addTo(m);
      const startH = scheds[i].startHotel && scheds[i].startHotel.lat != null ? scheds[i].startHotel : null;
      const endH = scheds[i].endHotel && scheds[i].endHotel.lat != null ? scheds[i].endHotel : null;
      if(startH){ hotelPin(startH); pts.push([startH.lat, startH.lng]); }
      let num = 0;
      scheds[i].rows.forEach(r => {
        const s = r.stop;
        if(s.lat == null) return;
        num += 1;   // counted whether or not it's drawn, so the numbers hold
        if(!s.hidden){
          L.marker([s.lat, s.lng], { icon: L.divIcon({
            className: '', html: '<div class="map-pin ap-pin"><span>' + num + '</span></div>',
            iconSize: [20, 20], iconAnchor: [10, 18]
          })}).addTo(m);
        }
        pts.push([s.lat, s.lng]);
      });
      if(endH){
        if(!startH || startH.id !== endH.id) hotelPin(endH);
        pts.push([endH.lat, endH.lng]);
      }
      if(pts.length > 1){
        L.polyline(pts, { color: dayAccent, weight: 2, dashArray: '4 4', opacity: 0.8 }).addTo(m);
        m.fitBounds(pts, { padding: [14, 14], maxZoom: 15 });
      } else if(pts.length === 1) m.setView(pts[0], 14);
      else m.setView([30, 10], 1);
      apMaps.push(m);
    });
  }, 90);
}

/* =========================================================
   TRIP INFO TAB
   ========================================================= */
const INFO_CARDS = [
  ['weather', '🌦', 'Weather', 'Expected weather for your dates, what to pack…'],
  ['closures', '🚪', 'Location closures', 'Which attractions close on which weekdays — e.g. "Musée d’Orsay — closed Mondays"'],
  ['reservations', '🎟', 'Reservation musts', 'What needs booking, and how far ahead…'],
  ['events', '🎉', 'Overlapping events', 'Festivals, exhibitions, holidays during the trip…'],
  ['notes', '📝', 'General notes', 'Anything else — transport tips, etiquette, scams to avoid…'],
];

/* Checklist rows carry their own MIME type: a row dragged over anything else
   that accepts a drop (a day tab, a stop list) must not read as that thing's
   drag, and vice versa. */
const CHECK_DND = 'application/x-travel-check';
const isCheckDrag = (e) => Array.from(e.dataTransfer.types || []).includes(CHECK_DND);
const clearCheckMarks = () => document.querySelectorAll('.check-row').forEach(r => r.classList.remove('drop-before','drop-after'));

/* Move one row so it lands just before (or after) another. The rows on screen
   are the open half of the list, but the array also holds ticked items — they
   wait in the Bin to be brought back — so only the open slots are rewritten
   and the ticked ones stay where they are. */
function moveChecklist(dragId, targetId, before){
  const list = trip().checklist;
  const slots = [];
  list.forEach((c, i) => { if(!c.done) slots.push(i); });
  const open = slots.map(i => list[i]);
  const from = open.findIndex(c => c.id === dragId);
  let to = open.findIndex(c => c.id === targetId);
  if(from < 0 || to < 0 || dragId === targetId) return;
  if(!before) to++;
  if(to > from) to--;              // the row is lifted out before it lands
  if(to === from) return;
  pushUndo();
  const [moved] = open.splice(from, 1);
  open.splice(to, 0, moved);
  slots.forEach((pos, k) => { list[pos] = open[k]; });
  saveState();
  renderInfo();
  updateUndoButton();
}

/* ↑ / ↓ from the grip — the same move, one row at a time, for keyboards. */
function nudgeChecklist(id, delta){
  const open = trip().checklist.filter(c => !c.done);
  const i = open.findIndex(c => c.id === id);
  const j = i + delta;
  if(i < 0 || j < 0 || j >= open.length) return;
  moveChecklist(id, open[j].id, delta < 0);
  const moved = document.querySelector(`.check-row[data-id="${CSS.escape(id)}"] .check-grip`);
  if(moved) moved.focus();
}

/* The open half of the checklist. Ticking an item doesn't delete it — it
   moves to the Bin's completed section, where it can be brought back.
   Only the box ticks: clicking the text opens it for editing instead, so a
   mis-aimed click reworded an item rather than filing it away.

   A row is either an item or a section heading (type:'header') — headings are
   plain dividers with no box to tick, and they drag and edit like any other
   row, so grouping the list is just typing a name and dragging rows under it. */
function renderChecklist(){
  const el = $('check-list');
  if(!el) return;
  const open = trip().checklist.filter(c => !c.done);
  if(!open.length){
    el.innerHTML = '<p class="check-empty">Nothing to do yet — add bookings, packing, anything you need to remember.</p>';
    return;
  }
  el.innerHTML = '';
  open.forEach(item => {
    const head = item.type === 'header';
    const row = document.createElement('div');
    row.className = 'check-row' + (head ? ' check-head' : '');
    row.dataset.id = item.id;
    row.innerHTML = `
      <span class="check-grip" role="button" tabindex="0" title="Drag to reorder (or focus and press ↑ / ↓)"
            aria-label="Reorder ${esc(item.text)}: drag, or press arrow up and arrow down">⠿</span>
      ${head ? '' : `<input type="checkbox" class="check-tick" aria-label="Mark done: ${esc(item.text)}">`}
      <span class="check-text" role="button" tabindex="0" title="Click to edit">${esc(item.text)}</span>
      <button type="button" class="check-del" title="${head ? 'Delete this heading (the items below stay)' : 'Delete this item'}">✕</button>`;
    if(!head) row.querySelector('.check-tick').addEventListener('change', () => {
      pushUndo();
      item.done = true;
      saveState();
      renderInfo();
      updateUndoButton();
    });

    // --- Reorder: drag from the grip (mouse), press it (touch), or ↑ / ↓ ---
    const grip = row.querySelector('.check-grip');
    grip.addEventListener('mousedown', () => { row.draggable = true; });
    grip.addEventListener('mouseup', () => { row.draggable = false; });
    grip.addEventListener('keydown', (e) => {
      if(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      nudgeChecklist(item.id, e.key === 'ArrowUp' ? -1 : 1);
    });
    row.addEventListener('dragstart', (e) => {
      row.classList.add('dragging');
      e.dataTransfer.setData(CHECK_DND, item.id);
      e.dataTransfer.setData('text/plain', item.text);   // Safari wants a text flavour
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('dragging');
      clearCheckMarks();
    });
    row.addEventListener('dragover', (e) => {
      if(!isCheckDrag(e)) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before','drop-after'));
    row.addEventListener('drop', (e) => {
      if(!isCheckDrag(e)) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      clearCheckMarks();
      moveChecklist(e.dataTransfer.getData(CHECK_DND), item.id, before);
    });
    grip.addEventListener('pointerdown', (ev) => {
      if(ev.pointerType === 'mouse') return;      // mouse uses the HTML5 drag above
      ev.preventDefault();
      row.classList.add('touch-dragging');
      let lastTarget = null, lastBefore = false;
      const onMove = (mv) => {
        const under = document.elementFromPoint(mv.clientX, mv.clientY);
        const overRow = under && under.closest ? under.closest('.check-row') : null;
        clearCheckMarks();
        if(overRow && overRow !== row){
          const r = overRow.getBoundingClientRect();
          lastBefore = (mv.clientY - r.top) < r.height / 2;
          overRow.classList.toggle('drop-before', lastBefore);
          overRow.classList.toggle('drop-after', !lastBefore);
          lastTarget = overRow.dataset.id;
        } else {
          lastTarget = null;
        }
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        row.classList.remove('touch-dragging');
        clearCheckMarks();
        if(lastTarget) moveChecklist(item.id, lastTarget, lastBefore);
      };
      document.addEventListener('pointermove', onMove, { passive:true });
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });

    /* Swap the text for an input in place. Saving on blur keeps Enter, a
       click elsewhere and a tab-away all doing the same thing; Escape backs
       out, and blanking the text is treated as "leave it alone" so an
       accidental select-all-delete can't silently empty a row. */
    const text = row.querySelector('.check-text');
    const startEdit = () => {
      if(row.querySelector('.check-edit')) return;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'check-edit';
      input.value = item.text;
      input.setAttribute('aria-label', (head ? 'Edit heading: ' : 'Edit item: ') + item.text);
      let cancelled = false;
      const stopEdit = () => {
        const val = input.value.trim();
        if(!cancelled && val && val !== item.text){
          pushUndo();
          item.text = val;
          saveState();
          renderInfo();
          updateUndoButton();
          return;          // renderInfo rebuilds the row for us
        }
        input.replaceWith(text);
      };
      input.addEventListener('keydown', (e) => {
        if(e.key === 'Enter'){ e.preventDefault(); input.blur(); }
        else if(e.key === 'Escape'){ e.preventDefault(); cancelled = true; input.blur(); }
      });
      input.addEventListener('blur', stopEdit);
      text.replaceWith(input);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };
    text.addEventListener('click', startEdit);
    text.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); startEdit(); }
    });

    row.querySelector('.check-del').addEventListener('click', () => {
      pushUndo();
      trip().checklist = trip().checklist.filter(c => c.id !== item.id);
      saveState();
      renderInfo();
      updateUndoButton();
    });
    el.appendChild(row);
  });
}

/* Trip Info holds real prose — paragraphs, "- " lists and "**bold**" lead-ins
   (that's what the AI plans produce). Reading it raw inside a textarea is the
   hard part, so the card shows formatted text and only becomes an editor when
   you click it. Input is escaped before any markup is added. */
function infoHtml(text){
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null, para = [];
  const flushPara = () => {
    if(para.length) out.push('<p>' + para.join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if(list) out.push('<ul>' + list.join('') + '</ul>');
    list = null;
  };
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  lines.forEach(raw => {
    const line = raw.trim();
    if(!line){ flushPara(); flushList(); return; }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if(bullet){
      flushPara();
      (list = list || []).push('<li>' + inline(bullet[1]) + '</li>');
      return;
    }
    flushList();
    // A line that is entirely bold reads as a heading for what follows.
    const lead = /^\*\*(.+)\*\*$/.exec(line);
    if(lead){ flushPara(); out.push('<p class="info-lead">' + esc(lead[1]) + '</p>'); return; }
    para.push(inline(line));
  });
  flushPara(); flushList();
  return out.join('');
}

export function renderInfo(){
  const el = $('infogrid');
  const t = trip();

  // Headings are dividers, not work: they count towards neither figure.
  const openCount = t.checklist.filter(c => !c.done && c.type !== 'header').length;
  const doneCount = t.checklist.filter(c => c.done).length;

  el.innerHTML = `
    <div class="infocard span-all">
      <h3><span class="ic-icon" aria-hidden="true">✅</span> Checklist
        ${openCount ? `<span class="ic-count">${openCount} open</span>` : ''}</h3>
      <form class="check-add" id="check-add-form">
        <input type="text" id="check-add-input" placeholder="Add a to-do — book tickets, renew passport…" autocomplete="off">
        <button type="submit" class="reset-btn">+ Add</button>
        <button type="button" class="reset-btn check-add-head" id="check-add-head"
                title="Add what you've typed as a section heading — a divider to group the rows under it">+ Section</button>
      </form>
      <div class="check-list" id="check-list"></div>
      ${doneCount ? `<p class="check-done-note">${doneCount} completed item${doneCount === 1 ? '' : 's'} — in the <button type="button" class="linklike" id="check-to-bin">Bin</button>, where they can be brought back.</p>` : ''}
    </div>
    <div class="infocard span-all">
      <h3><span class="ic-icon" aria-hidden="true">🛏️</span> Hotels</h3>
      <div id="hotel-mini-list"></div>
      <button class="reset-btn" id="add-hotel-btn" style="margin-top:10px;">+ Add hotel</button>
    </div>
    <div class="info-notes">
    ${INFO_CARDS.map(([key, icon, title, ph]) => {
      const val = t.info[key] || '';
      return `
      <div class="infocard info-note" data-key="${key}">
        <h3><span class="ic-icon" aria-hidden="true">${icon}</span> ${title}
          <button type="button" class="ic-edit" data-edit="${key}" title="Edit ${title}">✎ Edit</button>
        </h3>
        <div class="info-read" data-read="${key}" tabindex="0" role="button" title="Click to edit">${
          val.trim() ? infoHtml(val) : `<p class="info-empty">${esc(ph)}</p>`
        }</div>
        <textarea class="info-edit hidden" data-info="${key}" placeholder="${esc(ph)}">${esc(val)}</textarea>
      </div>`;
    }).join('')}
    </div>
    <div class="infocard" style="grid-column:1/-1;">
      <h3>Share &amp; sync across devices</h3>
      <p>Create a share link and this trip moves to the cloud. Open the link on your phone, or send it to whoever you're travelling with — everyone sees the same plan, and edits show up on the other devices within a second or two. No accounts: the link <i>is</i> the key.</p>
      <p><b>Sharing is also how a trip is saved.</b> An unshared trip lives only in this browser tab — nothing is uploaded, and closing the tab lets it go, so the bare site URL always opens a fresh blank trip. Share (or Export) anything you want to keep.</p>
      <p id="cloud-state" class="cloud-state"></p>
      <div id="cloud-link-row" class="cloud-link-row hidden">
        <input type="text" id="cloud-link" readonly aria-label="Share link" />
        <button class="reset-btn" id="cloud-copy">Copy link</button>
      </div>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="cloud-create">Create a share link</button>
        <button class="reset-btn hidden" id="cloud-duplicate" title="Copy this trip to a second room with its own link — the current link keeps the trip as it is now">Duplicate to a new room</button>
        <button class="reset-btn hidden" id="cloud-leave">Stop syncing</button>
      </div>
      <div class="cloud-btn-row" id="cloud-danger-row">
        <button class="reset-btn danger" id="cloud-empty" title="Wipe the itinerary but keep this room and its link">Empty this room</button>
        <button class="reset-btn danger" id="cloud-delete" title="Delete the shared copy so the link stops working">Delete this room</button>
      </div>
      <p class="cloud-warn"><b>Worth knowing:</b> anyone holding the link can edit the trip, and a link that gets out can't be revoked — duplicate to a new room (and delete the old one) to cut it off. Simultaneous edits resolve last-change-wins. "Stop syncing" only detaches this browser and leaves the shared copy alone; "Empty this room" clears the itinerary for everyone on the link but keeps the link working; "Delete this room" removes the shared copy for good.</p>
    </div>
  `;

  // hotels list
  const list = $('hotel-mini-list');
  if(!t.hotels.length){
    list.innerHTML = '<p>No hotels yet. Adding one lets each day start and end there, with the travel time shown.</p>';
  } else {
    list.innerHTML = '';
    t.hotels.forEach(h => {
      const row = document.createElement('div');
      row.className = 'hotel-mini-row';
      row.innerHTML = `
        <span class="h-name">${esc(h.name)}${h.mode === 'boat' ? ' · 🚤 boat shuttle' : ''}</span>
        <button data-act="edit">Edit</button>
        <button data-act="del">Remove</button>`;
      row.querySelector('[data-act="edit"]').addEventListener('click', () => openHotelEdit(h.id));
      row.querySelector('[data-act="del"]').addEventListener('click', () => deleteHotel(h.id));
      list.appendChild(row);
    });
  }
  $('add-hotel-btn').addEventListener('click', () => openHotelEdit(null));

  // checklist
  renderChecklist();
  /* One input, two buttons: what's typed lands as a to-do, or as a heading to
     group the rows under it. Both keep the caret in the box, so a section and
     its first few items can be typed in one go. */
  const addCheck = (header) => {
    const input = $('check-add-input');
    const text = input.value.trim();
    if(!text){ input.focus(); return; }
    pushUndo();
    trip().checklist.push(header
      ? { id: nextChecklistId(), text, type:'header', done: false }
      : { id: nextChecklistId(), text, done: false });
    input.value = '';
    saveState();
    renderInfo();
    updateUndoButton();
    const again = $('check-add-input');
    if(again) again.focus();     // keep adding without re-clicking
  };
  $('check-add-form').addEventListener('submit', (e) => { e.preventDefault(); addCheck(false); });
  $('check-add-head').addEventListener('click', () => addCheck(true));
  const toBin = $('check-to-bin');
  if(toBin) toBin.addEventListener('click', () => setView('bin'));

  /* Info notes: read view until clicked, textarea while editing. Saving on
     blur (not per keystroke) is what lets the read view rebuild once. */
  el.querySelectorAll('.info-note').forEach(card => {
    const key = card.dataset.key;
    const read = card.querySelector('.info-read');
    const ta = card.querySelector('.info-edit');
    const editBtn = card.querySelector('.ic-edit');
    const startEdit = () => {
      read.classList.add('hidden');
      ta.classList.remove('hidden');
      autoGrow(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    const stopEdit = () => {
      const val = ta.value;
      trip().info[key] = val;
      saveState();
      read.innerHTML = val.trim() ? infoHtml(val) : '<p class="info-empty">' + esc(ta.placeholder) + '</p>';
      ta.classList.add('hidden');
      read.classList.remove('hidden');
    };
    read.addEventListener('click', startEdit);
    read.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); startEdit(); }
    });
    editBtn.addEventListener('click', () => (ta.classList.contains('hidden') ? startEdit() : stopEdit()));
    ta.addEventListener('blur', stopEdit);
    // Belt and braces: a tab switch or reload mid-edit still keeps the text.
    ta.addEventListener('input', debounce(() => {
      trip().info[key] = ta.value;
      saveState();
    }, 600));
  });

  // cloud
  $('cloud-create').addEventListener('click', createRoom);
  $('cloud-duplicate').addEventListener('click', duplicateCurrentRoom);
  $('cloud-empty').addEventListener('click', emptyCurrentRoom);
  $('cloud-delete').addEventListener('click', deleteCurrentRoom);
  $('cloud-leave').addEventListener('click', () => {
    if(confirm('Stop syncing this browser with the shared trip? The shared copy stays available at the link.')) leaveRoom();
  });
  $('cloud-copy').addEventListener('click', () => copyText($('cloud-link').value, $('cloud-copy'), 'Copy link'));
  renderCloudUI();
}

/* =========================================================
   AI PLAN TAB — the assistant prompt, and import / export
   ========================================================= */
export function renderAiPlan(){
  const el = $('aigrid');
  const t = trip();

  el.innerHTML = `
    <div class="infocard" style="grid-column:1/-1;">
      <h3>Plan with an AI assistant</h3>
      <p>Copy this prompt into any AI assistant (Claude, ChatGPT…). It asks the right questions, then produces a trip in exactly the format this site imports — locations with coordinates, descriptions, restaurant picks, closures, reservations.</p>
      <div class="prompt-mode" id="prompt-mode">
        <label><input type="radio" name="prompt-mode" value="new"> Plan a new trip from scratch</label>
        <label><input type="radio" name="prompt-mode" value="edit"> Edit this trip — the prompt includes the current plan so the AI knows exactly what exists, and returns the full updated trip to import back</label>
      </div>
      <details class="prefs-box" id="prefs-box">
        <summary>Tailor the plan <span class="prefs-count" id="prefs-count"></span></summary>
        <div class="prefs-grid" id="prefs-grid"></div>
        <button type="button" class="reset-btn" id="prefs-clear">Clear preferences</button>
      </details>
      <textarea class="prompt-area" id="llm-prompt" spellcheck="false"></textarea>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="copy-prompt">Copy prompt</button>
        <button class="reset-btn" id="reset-prompt" title="Regenerate the prompt from the current trip, discarding your edits">↺ Reset prompt</button>
      </div>
      <p class="al-hint">The prompt is editable — tweak it before copying. Switching mode or pressing Reset regenerates it.</p>
    </div>
    <div class="infocard" style="grid-column:1/-1;">
      <h3>Import &amp; export</h3>
      <p>Export saves this whole trip (locations, notes, hotels, trip info) as one markdown file. <b>Offline copy</b> builds a single HTML file of the finished itinerary — days, times, notes, photos and a route sketch each day — that opens on a phone with no signal at all. Import accepts pasted text or an uploaded file — the markdown format (.md/.txt) carries everything, a CSV carries locations only. <b>Importing replaces the current trip</b> (Undo brings the old one back) — to change an existing trip with an AI, use the "Edit this trip" prompt above and import its full updated output. The KML export makes a shareable Google map: go to <a href="https://mymaps.google.com" target="_blank" rel="noopener">mymaps.google.com</a> → Create a new map → Import → pick the .kml — every day becomes a toggleable layer with pins and the route.</p>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="export-btn">⬇ Export trip (.md)</button>
        <button class="reset-btn" id="export-offline-btn" title="One self-contained HTML file with the whole itinerary — opens on a phone with no signal at all">📴 Offline copy (.html)</button>
        <button class="reset-btn" id="export-kml-btn" title="One folder per day with pins and route lines — import at mymaps.google.com for a shareable Google map">⬇ Export KML (Google My Maps)</button>
        <button class="reset-btn" id="import-file-btn">⬆ Import file (.md / .txt / .csv)</button>
        <input type="file" id="import-file" accept=".md,.txt,.csv,text/plain,text/markdown,text/csv" class="hidden">
        <button class="reset-btn hidden" id="demo-btn">Load example trip (Rome &amp; Venice)</button>
      </div>
      <p style="margin:12px 0 4px;">…or paste a trip here:</p>
      <textarea class="import-area" id="import-paste" placeholder="# Trip: My Trip&#10;&#10;## Day 1: …"></textarea>
      <p class="al-hint">Pasting from a chat works even if it swallowed the formatting — code fences are unwrapped and lost <code>#</code>/<code>-</code> markers are reconstructed automatically.</p>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="import-paste-btn">Import pasted text</button>
      </div>
      <p class="import-warnings" id="import-warnings"></p>
      <p class="example-files">Example files (a real 10-day Rome &amp; Venice trip):
        <a href="demo/rome-venice-trip.md" download>rome-venice-trip.md</a> ·
        <a href="demo/rome-venice-trip.txt" download>.txt</a> ·
        <a href="demo/rome-venice-trip.csv" download>.csv (locations only)</a></p>
    </div>
  `;

  // LLM prompt — default to 'edit' once the trip actually has content.
  // The textarea is editable; user edits stick (per session) until the mode
  // changes or Reset is pressed.
  const defaultMode = Object.keys(t.stops).length ? 'edit' : 'new';
  const refreshPrompt = (force) => {
    if(promptEdits != null && !force){ $('llm-prompt').value = promptEdits; return; }
    const mode = (el.querySelector('input[name="prompt-mode"]:checked') || {}).value || 'new';
    promptEdits = null;
    $('llm-prompt').value = buildPrompt(trip(), mode, promptPrefs);
  };
  el.querySelectorAll('input[name="prompt-mode"]').forEach(r => {
    r.checked = promptMode ? r.value === promptMode : r.value === defaultMode;
    r.addEventListener('change', () => { promptMode = r.value; refreshPrompt(true); });
  });
  renderPromptPrefs(() => refreshPrompt(true));
  $('llm-prompt').addEventListener('input', () => { promptEdits = $('llm-prompt').value; });
  refreshPrompt();
  $('copy-prompt').addEventListener('click', () => copyText($('llm-prompt').value, $('copy-prompt'), 'Copy prompt'));
  $('reset-prompt').addEventListener('click', () => refreshPrompt(true));

  // import / export
  $('export-btn').addEventListener('click', exportTrip);
  $('export-offline-btn').addEventListener('click', openOfflineExport);
  $('export-kml-btn').addEventListener('click', () => {
    const blob = new Blob([tripKml(trip())], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slugify(trip().name) + '.kml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('import-file-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    doImport(await file.text());
    e.target.value = '';
  });
  $('import-paste-btn').addEventListener('click', () => doImport($('import-paste').value));
  $('demo-btn').addEventListener('click', loadDemo);
  $('import-warnings').textContent = importNote;
}

/* Build the "Tailor the plan" controls from PROMPT_PREFS; every change
   regenerates the prompt. Text inputs debounce so typing stays smooth. */
function renderPromptPrefs(onChange){
  const grid = $('prefs-grid');
  if(!grid) return;
  grid.innerHTML = '';
  const bump = debounce(onChange, 250);

  PROMPT_PREFS.forEach(p => {
    const wrap = document.createElement('div');
    wrap.className = 'pref-item' + (p.type === 'multi' ? ' wide' : '');
    const lab = document.createElement('div');
    lab.className = 'pref-label';
    lab.textContent = p.label;
    wrap.appendChild(lab);

    if(p.type === 'text' || p.type === 'number'){
      const inp = document.createElement('input');
      inp.type = p.type;
      inp.className = 'pref-text' + (p.type === 'number' ? ' pref-num' : '');
      if(p.min != null) inp.min = p.min;
      if(p.max != null) inp.max = p.max;
      inp.placeholder = p.placeholderFn ? p.placeholderFn(trip()) : (p.placeholder || '');
      inp.value = promptPrefs[p.key] ?? '';
      inp.addEventListener('input', () => {
        promptPrefs[p.key] = inp.value === '' ? '' : inp.value;
        updatePrefCount();
        bump();
      });
      wrap.appendChild(inp);
    } else {
      const row = document.createElement('div');
      row.className = 'chip-row';
      p.options.forEach(opt => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'pref-chip';
        chip.textContent = opt;
        const isOn = p.type === 'multi'
          ? (promptPrefs[p.key] || []).includes(opt)
          : (promptPrefs[p.key] || p.def) === opt;
        chip.classList.toggle('on', isOn);
        chip.addEventListener('click', () => {
          if(p.type === 'multi'){
            const cur = promptPrefs[p.key] || [];
            promptPrefs[p.key] = cur.includes(opt) ? cur.filter(x => x !== opt) : [...cur, opt];
          } else {
            // clicking the active choice clears it back to "unspecified"
            promptPrefs[p.key] = (promptPrefs[p.key] || p.def) === opt && promptPrefs[p.key] ? null : opt;
          }
          renderPromptPrefs(onChange);
          onChange();
        });
        row.appendChild(chip);
      });
      wrap.appendChild(row);
    }
    grid.appendChild(wrap);
  });
  updatePrefCount();
  const clear = $('prefs-clear');
  if(clear) clear.onclick = () => { promptPrefs = {}; renderPromptPrefs(onChange); onChange(); };
}

function updatePrefCount(){
  const badge = $('prefs-count');
  if(!badge) return;
  const n = Object.values(promptPrefs).filter(v => Array.isArray(v) ? v.length : (v && String(v).trim())).length;
  badge.textContent = n ? '· ' + n + ' set' : '· optional';
}

function autoGrow(ta){
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(420, ta.scrollHeight + 4) + 'px'; };
  ta.addEventListener('input', fit);
  fit();
}

async function copyText(text, btn, restoreLabel){
  try{ await navigator.clipboard.writeText(text); }
  catch(e){
    const tmp = document.createElement('textarea');
    tmp.value = text; document.body.appendChild(tmp); tmp.select();
    try{ document.execCommand('copy'); } catch(e2){}
    tmp.remove();
  }
  btn.textContent = 'Copied ✓';
  setTimeout(() => { btn.textContent = restoreLabel; }, 1500);
}

function exportTrip(){
  const md = serializeTrip(trip());
  const blob = new Blob([md], { type:'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = slugify(trip().name) + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* =========================================================
   OFFLINE EXPORT

   The .md export is the trip's source; this is the trip as a
   thing you carry. One HTML file, no requests of any kind, so
   the itinerary survives a flight, a tunnel, or roaming
   switched off — see js/offline.js for what goes in it.
   ========================================================= */
let offlineBuilding = false;

function openOfflineExport(){
  const t = trip();
  const hasOptional = (t.optional || []).length > 0;
  $('off-optional-row').classList.toggle('hidden', !hasOptional);
  $('off-link-row').classList.toggle('hidden', !cloud.room);

  const n = photoUrls(t, { optional: hasOptional }).length;
  const photoBox = $('off-photos');
  photoBox.disabled = n === 0;
  if(n === 0) photoBox.checked = false;
  $('off-status').textContent = n
    ? n + (n === 1 ? ' photo' : ' photos') + ' to pack — that part needs the connection you have right now.'
    : 'This trip has no photos to pack.';

  $('offline-overlay').classList.add('open');
  lastFocusedEl = document.activeElement;
  $('offline-close').focus();
  document.body.style.overflow = 'hidden';
}

function closeOfflineExport(){
  if(offlineBuilding) return;        // a half-fetched build has nowhere to go
  $('offline-overlay').classList.remove('open');
  document.body.style.overflow = '';
  if(lastFocusedEl && lastFocusedEl.focus) lastFocusedEl.focus();
}

function fileSize(bytes){
  return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function buildOffline(){
  if(offlineBuilding) return;
  const t = trip();
  const btn = $('off-build');
  const status = $('off-status');
  const optional = !$('off-optional-row').classList.contains('hidden') && $('off-optional').checked;
  const wantPhotos = $('off-photos').checked && !$('off-photos').disabled;

  offlineBuilding = true;
  btn.disabled = true;
  btn.textContent = '◌ Building…';
  try{
    let photos = null, report = null;
    if(wantPhotos){
      report = await collectPhotos(t, {
        optional,
        onProgress: (p) => { status.textContent = 'Packing photos… ' + p.done + ' of ' + p.total; },
      });
      photos = report.photos;
    }
    status.textContent = 'Writing the file…';
    const html = buildOfflineHtml(t, {
      photos,
      optional,
      maps: $('off-maps').checked,
      planUrl: (cloud.room && $('off-link').checked) ? shareUrl(cloud.room) : null,
    });
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = offlineFileName(t);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status.textContent = '✓ ' + a.download + ' · ' + fileSize(blob.size) +
      (report ? ' · ' + report.ok + ' of ' + report.total + ' photos packed' +
        (report.failed ? ' (' + report.failed + ' refused — those stops keep their icon)' : '') : '');
  } catch(e){
    status.textContent = '✕ ' + (e.message || 'The file could not be built.');
  } finally {
    offlineBuilding = false;
    btn.disabled = false;
    btn.textContent = '⬇ Build the offline copy';
  }
}

/* Held in a variable, not just in the DOM: a successful import switches to
   Day by Day, so the note has to still be there when the AI Plan tab is
   rebuilt on the way back. */
function setImportNote(text){
  importNote = text;
  const el = $('import-warnings');
  if(el) el.textContent = text;
}

function doImport(text){
  setImportNote('');
  let result;
  try{
    result = importText(text);
  } catch(e){
    setImportNote('✕ ' + e.message);
    return;
  }
  const n = Object.keys(result.trip.stops).length;
  if(!confirm('Import "' + result.trip.name + '" (' + result.trip.days.length + ' days, ' + n + ' locations)? This replaces the current trip — Undo can bring the old one back.')) return;
  pushUndo();
  replaceTrip(result.trip);
  applyTheme();
  renderAll();
  renderInfo();
  setView('days');
  setImportNote(result.warnings.length
    ? '⚠ ' + result.warnings.slice(0, 6).join(' ') + (result.warnings.length > 6 ? ' (+' + (result.warnings.length - 6) + ' more)' : '')
    : '');
}

async function loadDemo(){
  try{
    const res = await fetch('demo/rome-venice-trip.md');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    doImport(await res.text());
  } catch(e){
    setImportNote('✕ Could not load the example trip (' + e.message + ').');
  }
}

/* =========================================================
   CLOUD UI
   ========================================================= */
export function renderCloudUI(){
  const ss = $('save-share-btn');
  if(ss){
    if(cloud.room){
      ss.textContent = cloud.status === 'connecting' ? '◌ Saving…' : '🔗 Share';
      ss.title = 'Copy the shareable link to this trip';
    } else {
      ss.textContent = '💾 Save';
      ss.title = cloud.configured
        ? 'Save this trip to the cloud and get a shareable link'
        : 'Sharing isn’t configured on this deployment — see Trip Info';
    }
  }
  const chip = $('cloud-chip');
  if(chip){
    const on = cloud.status !== 'local';
    chip.classList.toggle('hidden', !on);
    chip.classList.toggle('bad', cloud.status === 'error');
    chip.textContent = cloud.status === 'error' ? '⚠ Sync problem'
      : cloud.status === 'connecting' ? '◌ Connecting…'
      : cloud.note ? '↻ Updated elsewhere' : '● Shared';
    // Mobile renders the chip glyph-only off this attribute (text stays for desktop).
    chip.dataset.state = cloud.status === 'error' ? 'error'
      : cloud.status === 'connecting' ? 'connecting'
      : cloud.note ? 'note' : 'ok';
  }
  const stateEl = $('cloud-state');
  if(!stateEl) return;
  stateEl.textContent = cloudStatusText();
  stateEl.classList.toggle('bad', cloud.status === 'error');
  const inRoom = !!cloud.room;
  $('cloud-link-row').classList.toggle('hidden', !inRoom);
  $('cloud-create').classList.toggle('hidden', inRoom);
  $('cloud-duplicate').classList.toggle('hidden', !inRoom);
  $('cloud-leave').classList.toggle('hidden', !inRoom);
  $('cloud-danger-row').classList.toggle('hidden', !inRoom);
  if(inRoom) $('cloud-link').value = shareUrl(cloud.room);
}

/* =========================================================
   ROOM TOOLS — duplicate / empty / delete

   All three are destructive in different amounts, so each one
   spells out exactly what happens to the link and to everyone
   else holding it before it does anything.
   ========================================================= */

/* "My Trip" → "My Trip (copy)" → "My Trip (copy 2)" → … */
function copyName(name){
  const m = /^(.*) \(copy(?: (\d+))?\)$/.exec(name || '');
  if(m) return m[1] + ' (copy ' + (parseInt(m[2] || '1', 10) + 1) + ')';
  return (name || 'Untitled Trip') + ' (copy)';
}

async function duplicateCurrentRoom(){
  const name = copyName(trip().name);
  if(!confirm('Duplicate this trip into a new room?\n\nThis browser moves to the copy — named "' + name + '", with its own link. The room you\'re in now keeps the trip exactly as it stands, at the link you already have.')) return;
  const btn = $('cloud-duplicate');
  btn.disabled = true;
  const ok = await duplicateRoom(() => { trip().name = name; });
  btn.disabled = false;
  if(!ok){
    renderCloudUI();
    alert('Could not create the copy.\n\n' + (cloud.error || 'Check the connection and try again.'));
    return;
  }
  saveState();
  renderAll();
  renderInfo();
}

function emptyCurrentRoom(){
  if(!confirm('Delete everything in this room — every day, location, hotel and trip note?\n\nThe room and its link keep working: everyone on the link ends up on an empty trip. Undo can bring it back from this device.')) return;
  pushUndo();
  replaceTrip(blankTrip());
  applyTheme();
  renderAll();
  renderInfo();
}

async function deleteCurrentRoom(){
  if(!confirm('Permanently delete this shared trip?\n\nThe shared copy is removed and the link stops working for everyone. This browser drops back to a blank, unshared trip — Undo can bring the itinerary back if you want to re-share it somewhere new.')) return;
  const btn = $('cloud-delete');
  btn.disabled = true;
  const res = await deleteRoom();
  btn.disabled = false;
  if(res.error){
    renderCloudUI();
    alert('Could not delete this room — nothing was changed.\n\n' + res.error);
    return;
  }
  forgetRoomCache(res.code);
  pushUndo();
  replaceTrip(blankTrip());
  applyTheme();
  renderAll();
  renderInfo();
}

/* =========================================================
   SETTINGS
   ========================================================= */
function openSettings(){
  $('st-name').value = trip().name;
  $('st-subtitle').value = trip().subtitle || '';
  $('st-days').value = trip().days.length;
  $('st-date').value = trip().startDate || '';
  renderThemePicker();
  $('settings-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSettings(){
  $('settings-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
function renderThemePicker(){
  const el = $('theme-picker');
  el.innerHTML = '';
  THEMES.forEach(t => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'theme-swatch' + (trip().theme === t ? ' active' : '');
    const [paper, accent, gold] = THEME_PREVIEW[t];
    sw.innerHTML = `<span class="sw-strip"><span style="background:${paper}"></span><span style="background:${accent}"></span><span style="background:${gold}"></span></span><span class="sw-name">${t}</span>`;
    sw.addEventListener('click', () => {
      trip().theme = t;
      saveState();
      applyTheme();
      renderThemePicker();
      renderDayPanel();   // map polyline color follows the accent
    });
    el.appendChild(sw);
  });
}
function submitSettings(e){
  e.preventDefault();
  pushUndo();
  trip().name = $('st-name').value.trim() || 'Untitled Trip';
  trip().subtitle = $('st-subtitle').value.trim();
  trip().startDate = $('st-date').value || null;
  const want = Math.max(1, Math.min(60, parseInt($('st-days').value, 10) || trip().days.length));
  const days = trip().days;
  if(want > days.length){
    while(days.length < want) days.push(newDay(days.length + 1));
  } else if(want < days.length){
    const removed = days.slice(want);
    const withStops = removed.reduce((n, d) => n + d.order.length, 0);
    if(withStops && !confirm('Reducing to ' + want + ' days sends ' + withStops + ' stop(s) from the removed days to the bin. Continue?')){
      state.undoStack.pop();
      return;
    }
    removed.forEach(d => d.order.forEach(id => { if(!trip().bin.includes(id)) trip().bin.push(id); }));
    trip().days = days.slice(0, want);
  }
  trip().days.forEach((d, i) => { d.id = i + 1; });
  state.currentDayIndex = Math.min(state.currentDayIndex, trip().days.length - 1);
  saveState();
  closeSettings();
  renderAll();
  renderInfo();
}

function clearTrip(){
  const shared = cloud.room
    ? '\n\nThis trip is shared: the blank trip syncs to the link too, so everyone on it loses the itinerary. To keep the shared copy, use "Stop syncing" (Trip Info) first.'
    : '';
  if(!confirm('Start a new blank trip? The current one is replaced (Undo can bring it back, and Export first if you want a file copy).' + shared)) return;
  pushUndo();
  replaceTrip(blankTrip());
  applyTheme();
  closeSettings();
  renderAll();
  renderInfo();
}

/* =========================================================
   VIEW SWITCH + FOOTER
   ========================================================= */
export function setView(view){
  state.currentView = view;
  // Mirrored on the root so CSS can light up the mobile "More" tab and
  // sheet rows for views whose buttons are folded away on small screens.
  document.documentElement.dataset.view = view;
  ['days','all','bin','optional','info','ai'].forEach(v => {
    $('btn-view-' + v).classList.toggle('active', view === v);
    $('view-' + v).classList.toggle('hidden', view !== v);
  });
  if(view === 'days') setTimeout(() => {
    if(!leafletMap) return;
    leafletMap.invalidateSize();
    if(mapFitPending) fitMapToDay();
  }, 50);
  if(view === 'all') renderAllStops();
  if(view === 'bin') renderBin();
  if(view === 'optional') renderOptional();
  if(view === 'info') renderInfo();
  if(view === 'ai') renderAiPlan();
}

function renderFooter(){
  const el = $('page-footer');
  const rs = routingStatus();
  const live = rs.valhalla || rs.transitous;
  el.innerHTML =
    'Maps © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · ' +
    (live
      ? 'Live travel times: <a href="https://valhalla.openstreetmap.de">Valhalla (FOSSGIS)</a> for walking &amp; driving, <a href="https://transitous.org">Transitous</a> for public transport' +
        (rs.pending ? ' · ◌ fetching ' + rs.pending + '…' : '')
      : 'Live routing unreachable right now — times shown are distance-based estimates') +
    ' · Place search: <a href="https://photon.komoot.io">Photon</a>' +
    ' · Times marked <span class="est">· est</span> are estimates pending a routed answer.';
}

/* =========================================================
   TOP-LEVEL RENDER + ONE-TIME WIRING
   ========================================================= */
export function renderAll(){
  applyTheme();
  renderHero();
  renderTabs();
  renderDayPanel();
  updateUndoButton();
  renderFooter();
  if(state.currentView === 'all') renderAllStops();
  if(state.currentView === 'bin') renderBin();
  if(state.currentView === 'optional') renderOptional();
}

/* Null-safe wiring: on a no-build site, a stale-cached index.html can lag the
   JS (or vice versa) by one deploy. One missing element must skip its own
   handler, not throw and kill every handler wired after it. */
function on(id, evt, fn){
  const el = $(id);
  if(el) el.addEventListener(evt, fn);
  else console.warn('wire: #' + id + ' missing (stale cached page?) — hard-refresh to fix');
}
function ac(id, onPick, onStatus){
  if($(id)) attachAutocomplete($(id), onPick, onStatus);
}

export function wireStaticHandlers(){
  wireTabNav();
  on('btn-view-days', 'click', () => setView('days'));
  on('btn-view-all', 'click', () => setView('all'));
  on('btn-view-bin', 'click', () => setView('bin'));
  on('btn-view-optional', 'click', () => setView('optional'));
  on('btn-view-info', 'click', () => setView('info'));
  on('btn-view-ai', 'click', () => setView('ai'));

  // Mobile "More" sheet — proxy rows for views folded out of the bottom bar.
  const moreSheet = $('more-sheet');
  const setMore = (open) => {
    if(!moreSheet) return;
    moreSheet.hidden = !open;
    const btn = $('btn-more');
    if(btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Keyboard users: land in the sheet on open, back on the trigger on close.
    if(open){ const first = moreSheet.querySelector('.sheet-panel button'); if(first) first.focus(); }
    else if(btn && moreSheet.contains(document.activeElement)) btn.focus();
  };
  on('btn-more', 'click', () => setMore(moreSheet && moreSheet.hidden));
  on('more-backdrop', 'click', () => setMore(false));
  [['mnav-optional','optional'], ['mnav-bin','bin'], ['mnav-ai','ai']].forEach(([id, view]) =>
    on(id, 'click', () => { setMore(false); setView(view); }));
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Escape' || !moreSheet || moreSheet.hidden) return;
    // An overlay stacked above the sheet owns this Escape — close layers one at a time.
    if(document.querySelector('.modal-overlay.open')) return;
    setMore(false);
  });
  document.documentElement.dataset.view = state.currentView;
  on('group-btn', 'click', autoPlanPreview);
  on('map-preview-btn', 'click', previewCurrentRoutes);
  on('auto-plan-close', 'click', closeAutoPlan);
  on('ap-cancel', 'click', closeAutoPlan);
  on('ap-accept', 'click', acceptAutoPlan);
  on('auto-plan-overlay', 'click', (e) => { if(e.target.id === 'auto-plan-overlay') closeAutoPlan(); });
  on('add-optional-btn', 'click', () => openLocationForm(null, 'optional'));
  on('all-add-btn', 'click', () => openLocationForm(null, currentDay().id));

  // google maps route picker
  on('gmaps-close', 'click', closeGmapsPicker);
  on('gmaps-overlay', 'click', (e) => { if(e.target.id === 'gmaps-overlay') closeGmapsPicker(); });
  on('gmaps-all', 'click', () => setAllGmapsPicks(true));
  on('gmaps-none', 'click', () => setAllGmapsPicks(false));
  on('gmaps-open', 'click', openGmapsRoute);

  // offline export
  on('offline-close', 'click', closeOfflineExport);
  on('offline-overlay', 'click', (e) => { if(e.target.id === 'offline-overlay') closeOfflineExport(); });
  on('off-build', 'click', buildOffline);

  // search
  on('btn-search', 'click', openSearch);
  on('search-close', 'click', closeSearch);
  on('search-overlay', 'click', (e) => { if(e.target.id === 'search-overlay') closeSearch(); });
  on('search-input', 'input', debounce(runSearch, 150));
  document.addEventListener('keydown', (e) => {
    if(e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    openSearch();
  });
  on('al-cat', 'change', refreshEndPointFields);
  on('al-lat', 'input', refreshCoordsStatus);
  on('al-lng', 'input', refreshCoordsStatus);
  on('btn-settings', 'click', openSettings);
  on('trip-title', 'click', openSettings);
  on('cloud-chip', 'click', () => setView('info'));
  on('save-share-btn', 'click', async () => {
    const btn = $('save-share-btn');
    if(cloud.room){
      await copyText(shareUrl(cloud.room), btn, '🔗 Share');
    } else if(cloud.configured){
      btn.textContent = '◌ Saving…';
      await createRoom();
      renderCloudUI();
      if(cloud.room) copyText(shareUrl(cloud.room), btn, '🔗 Share');
    } else {
      setView('info');   // the share card explains the one-time setup
    }
  });
  on('undo-btn', 'click', () => {
    if(popUndo()){
      applyTheme();
      renderAll();
      if(state.currentView === 'info') renderInfo();
    }
  });

  // detail modal
  on('modal-close', 'click', closeModal);
  on('modal-overlay', 'click', (e) => { if(e.target.id === 'modal-overlay') closeModal(); });
  on('modal-notes', 'input', saveNotesDebounced);
  on('modal-done', 'click', toggleModalDone);
  on('modal-hide', 'click', toggleModalHide);
  on('modal-edit', 'click', () => {
    const id = modalStopId;
    closeModal();
    if(id) openLocationForm(id);
  });
  on('modal-bin', 'click', () => {
    const id = modalStopId;
    closeModal();
    if(!id) return;
    const day = trip().days.find(d => d.order.includes(id)) || null;
    removeToBin(day, id);
  });

  // add/edit location
  on('add-location-close', 'click', closeLocationForm);
  on('add-location-overlay', 'click', (e) => { if(e.target.id === 'add-location-overlay') closeLocationForm(); });
  on('add-location-form', 'submit', submitLocationForm);

  // day edit
  on('day-edit-close', 'click', closeDayEdit);
  on('day-edit-overlay', 'click', (e) => { if(e.target.id === 'day-edit-overlay') closeDayEdit(); });
  on('day-edit-form', 'submit', submitDayEdit);
  on('de-earlier', 'click', () => moveDayFromModal(-1));
  on('de-later', 'click', () => moveDayFromModal(1));
  on('de-delete', 'click', deleteDay);

  // hotel edit
  on('hotel-edit-close', 'click', closeHotelEdit);
  on('hotel-edit-overlay', 'click', (e) => { if(e.target.id === 'hotel-edit-overlay') closeHotelEdit(); });
  on('hotel-edit-form', 'submit', submitHotelEdit);

  // settings
  on('settings-close', 'click', closeSettings);
  on('settings-overlay', 'click', (e) => { if(e.target.id === 'settings-overlay') closeSettings(); });
  on('settings-form', 'submit', submitSettings);
  on('st-distribute', 'click', () => { closeSettings(); setView('all'); autoPlanPreview(); });
  on('st-clear', 'click', clearTrip);

  // escape closes whichever overlay is open
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Escape') return;
    for(const id of ['search-overlay','gmaps-overlay','offline-overlay','auto-plan-overlay','add-location-overlay','day-edit-overlay','hotel-edit-overlay','settings-overlay','modal-overlay']){
      const ov = $(id);
      if(ov && ov.classList.contains('open')){
        if(id === 'modal-overlay') closeModal();
        else if(id === 'search-overlay') closeSearch();
        else if(id === 'gmaps-overlay') closeGmapsPicker();
        else if(id === 'offline-overlay') closeOfflineExport();
        else if(id === 'auto-plan-overlay') closeAutoPlan();
        else { ov.classList.remove('open'); document.body.style.overflow = ''; }
        return;
      }
    }
  });

  // place search: typing a name suggests real places and fills coordinates.
  // Coordinates stay hidden unless search fails (or the user asks for them).
  ac('al-name', (r) => {
    $('al-name').value = r.name;
    $('al-lat').value = r.lat;
    $('al-lng').value = r.lng;
    if(!$('al-editing').value) $('al-cat').value = r.cat;   // don't override an existing stop's category
    refreshEndPointFields();
    refreshCoordsStatus();
  }, (status) => {
    if((status.error || status.count === 0) && !$('al-lat').value.trim()){
      $('al-coords-wrap').classList.remove('hidden');
    }
  });
  ac('al-end-search', (r) => {
    $('al-end-search').value = r.name;
    $('al-endlat').value = r.lat;
    $('al-endlng').value = r.lng;
  });
  ac('he-name', (r) => {
    $('he-name').value = r.name;
    $('he-lat').value = r.lat;
    $('he-lng').value = r.lng;
  });

  // disarm drag armed on a handle press that never became a drag
  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.stop-card[draggable="true"], .all-row[draggable="true"]').forEach(c => { c.draggable = false; });
  });

  // routed travel times landing → refresh the schedule quietly
  onRoutingUpdate(() => {
    if(state.currentView === 'days') refreshDaySchedule();
    renderFooter();
  });
}
