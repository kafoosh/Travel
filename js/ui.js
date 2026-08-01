/* =========================================================
   UI — all rendering and interaction.
   Ported from the Rome & Venice itinerary and generalised:
   no hardcoded cities, hotels, or stops; everything renders
   from the trip object and every piece of user content is
   escaped before it touches innerHTML.
   ========================================================= */

import { esc, formatTime, formatDur, parseTime, dayDate, formatDayDate, slugify, debounce } from './util.js';
import { CATEGORIES, DEFAULT_DUR, THEMES, newDay, serializeTrip, importText, blankTrip } from './format.js';
import { state, saveState, pushUndo, popUndo, replaceTrip, nextStopId, nextHotelId, forgetRoomCache } from './state.js';
import { computeSchedule, getHotel } from './schedule.js';
import { optimizeDayOrder, autoPlanOrders } from './optimize.js';
import { routingStatus, onRoutingUpdate } from './routing.js';
import { cloud, cloudStatusText, createRoom, duplicateRoom, deleteRoom, leaveRoom, shareUrl } from './cloud.js';
import { buildPrompt, PROMPT_PREFS } from './llm.js';
import { attachAutocomplete } from './geocode.js';
import { googleMapsDayUrl, tripKml } from './exporters.js';
import { mountImage } from './img.js';

const ICONS = {
  landmark:'🏛️', museum:'🖼️', church:'⛪', park:'🌳',
  food:'🍝', view:'🌇', travel:'🚄', shop:'🛍️', hike:'🥾',
  hotel:'🛏️', flight:'✈️', boat:'🚤', other:'📍'
};
const CAT_LABEL = {
  landmark:'Landmark', museum:'Museum', church:'Church / temple', park:'Park / nature',
  view:'Viewpoint', food:'Food & drink', shop:'Shopping', hike:'Hike (A → B)',
  hotel:'Hotel / check-in', flight:'Flight', travel:'Train / travel leg',
  boat:'Boat / ferry', other:'Other'
};
const MODE_ICON = { walk:'🚶', cycle:'🚲', transit:'🚌', bus:'🚌', metro:'🚇', tram:'🚋', ferry:'⛴️', taxi:'🚕', boat:'🚤' };
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
    btn.draggable = true;
    btn.tabIndex = 0;
    btn.title = 'Drag to reorder the trip (or focus and press Shift + ← / →)';
    const date = dayDate(trip().startDate, i);
    btn.innerHTML = '<span class="d-num">D' + d.id + '</span> · ' + esc(d.title) +
      (date ? ' <span style="opacity:.75">· ' + formatDayDate(date) + '</span>' : '');
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
  const sched = computeSchedule(trip(), day);
  const date = sched.date;

  let hotelBarHtml = '';
  if(trip().hotels.length){
    hotelBarHtml = `
    <div class="hotel-toggle">
      <span class="hotel-toggle-label">Staying at:</span>
      <button class="hotel-opt ${!day.hotelId ? 'active' : ''}" data-hotel="">No hotel</button>
      ${trip().hotels.map(h =>
        `<button class="hotel-opt ${day.hotelId === h.id ? 'active' : ''}" data-hotel="${esc(h.id)}">${esc(h.name)}</button>`
      ).join('')}
    </div>`;
  }

  panel.innerHTML = `
    <div class="daypanel-head">
      <h2>Day ${day.id} — ${esc(day.title)}</h2>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        ${date ? `<span class="day-date-tag">${formatDayDate(date)}</span>` : ''}
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
  $('gmaps-day-btn').addEventListener('click', () => {
    const { url, truncated } = googleMapsDayUrl(trip(), day);
    if(!url){ alert('This day needs at least two located stops for a Google Maps route.'); return; }
    if(truncated) alert('Google Maps direction links cap at 11 points — opening the first 11 stops of this day.');
    window.open(url, '_blank', 'noopener');
  });
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

  panel.querySelectorAll('.hotel-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      pushUndo();
      day.hotelId = btn.dataset.hotel || null;
      saveState();
      renderDayPanel();
      updateUndoButton();
    });
  });

  renderUnassignedTray($('day-unassigned'), day.id);
  renderScheduleList(day, sched);
  renderMap(day, sched);
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
  const { rows, leadTransfer, trailTransfer, returnTime, hotel } = sched;
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
  if(hotel && leadTransfer){
    const firstStop = rows.find(r => r.stop.lat != null);
    list.appendChild(travelConnector(leadTransfer.minutes, leadTransfer.mode, leadTransfer.live,
      'Depart ' + esc(hotel.name) + ', ', firstStop ? { stopId: firstStop.stop.id } : null));
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
    card.className = 'stop-card' + (s.cat === 'travel' || s.cat === 'boat' ? ' travel-row' : '');
    card.draggable = false;
    card.dataset.id = s.id;

    const hasMapPin = s.lat != null && s.lng != null;
    if(hasMapPin) mapOrder += 1;
    const numberBadgeHtml = hasMapPin
      ? `<span class="stop-number">${mapOrder}</span>`
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
          ${s.cat === 'hike' && s.endLat != null ? `<span class="fixed-chip" title="Point-to-point hike">🥾 A→B</span>` : ''}
        </div>
        <p class="stop-name">${esc(s.name)}</p>
        <p class="stop-desc">${esc(s.desc)}</p>
        <div class="tag-row">${chips}</div>
        <div class="manage-row">
          <select class="move-to-day" title="Move to another day" aria-label="Move ${esc(s.name)}">
            <option value="">Move to…</option>
            ${dayOptionsHtml}
          </select>
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
        const margin = 70;
        if(mv.clientY < margin) window.scrollBy(0, -12);
        else if(mv.clientY > window.innerHeight - margin) window.scrollBy(0, 12);
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

  if(hotel && trailTransfer){
    list.appendChild(travelConnector(trailTransfer.minutes, trailTransfer.mode, trailTransfer.live,
      'Return to ' + esc(hotel.name) + ', ', { returnDay: day }));
    const arrive = document.createElement('div');
    arrive.className = 'travel-connector';
    arrive.innerHTML = '🏨 Back at the hotel ~' + formatTime(returnTime);
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
  const hotel = sched.hotel;
  let prevPt = null;

  if(hotel && hotel.lat != null){
    const hotelIcon = L.divIcon({
      className: '',
      html: '<div class="map-pin hotel-pin"><span>' + (hotel.mode === 'boat' ? '🚤' : '🏨') + '</span></div>',
      iconSize: [26,26],
      iconAnchor: [13,24]
    });
    L.marker([hotel.lat, hotel.lng], { icon: hotelIcon }).addTo(mapLayerGroup)
      .bindPopup('<b>' + esc(hotel.name) + '</b><br>start / end of day');
    pts.push([hotel.lat, hotel.lng]);
    prevPt = [hotel.lat, hotel.lng];
  }

  sched.rows.forEach(row => {
    const s = row.stop;
    if(s.lat == null || s.lng == null) return;
    order += 1;
    const icon = L.divIcon({
      className: '',
      html: '<div class="map-pin"><span>' + order + '</span></div>',
      iconSize: [26,26],
      iconAnchor: [13,24]
    });
    L.marker([s.lat, s.lng], { icon }).addTo(mapLayerGroup)
      .bindPopup('<b>' + esc(s.name) + '</b><br>' + formatTime(row.start));
    const cur = [s.lat, s.lng];
    // travelPath on a row is the routed geometry of the leg ARRIVING at it
    // (computed in the same sequence computeSchedule walked).
    if(prevPt) segs.push({ from: prevPt, to: cur, path: row.travelPath });
    pts.push(cur);
    prevPt = cur;

    // Point-to-point hike: draw the hike itself and continue from its end.
    if(s.cat === 'hike' && s.endLat != null && s.endLng != null){
      const end = [s.endLat, s.endLng];
      const flagIcon = L.divIcon({
        className: '',
        html: '<div class="map-pin hike-end-pin"><span>🏁</span></div>',
        iconSize: [26,26],
        iconAnchor: [13,24]
      });
      L.marker(end, { icon: flagIcon }).addTo(mapLayerGroup)
        .bindPopup('<b>' + esc(s.name) + '</b><br>hike ends here');
      segs.push({ from: cur, to: end, path: row.hikeLeg ? row.hikeLeg.path : null, hike: true });
      pts.push(end);
      prevPt = end;
    }
  });

  if(hotel && hotel.lat != null && pts.length > 1){
    segs.push({ from: prevPt, to: [hotel.lat, hotel.lng], path: sched.trailTransfer ? sched.trailTransfer.path : null });
    pts.push([hotel.lat, hotel.lng]);
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#C1502E';
  const boundPts = pts.slice();
  const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#B8891F';
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

  $('modal-overlay').classList.add('open');
  lastFocusedEl = document.activeElement;
  $('modal-close').focus();
  document.body.style.overflow = 'hidden';
}
function closeModal(){
  const hadStop = modalStopId;
  modalStopId = null;
  $('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
  if(lastFocusedEl && lastFocusedEl.focus) lastFocusedEl.focus();
  // Notes may have changed while the modal was open — refresh so the 📝 chip
  // (and anything else) reflects it immediately.
  if(hadStop){
    if(state.currentView === 'days') renderDayPanel();
    else if(state.currentView === 'optional') renderOptional();
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

function refreshHikeFields(){
  $('al-end-wrap').classList.toggle('hidden', $('al-cat').value !== 'hike');
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
  refreshHikeFields();

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
  const endLat = cat === 'hike' ? parseFloat($('al-endlat').value) : NaN;
  const endLng = cat === 'hike' ? parseFloat($('al-endlng').value) : NaN;
  pushUndo();
  const editId = $('al-editing').value;
  const id = editId || nextStopId();
  trip().stops[id] = {
    id, name, cat,
    dur: parseInt($('al-dur').value, 10) || DEFAULT_DUR[cat] || 45,
    lat: (lat != null && lng != null) ? lat : null,
    lng: (lat != null && lng != null) ? lng : null,
    endLat: (!isNaN(endLat) && !isNaN(endLng)) ? endLat : null,
    endLng: (!isNaN(endLat) && !isNaN(endLng)) ? endLng : null,
    fixedStart: /^\d{1,2}:\d{2}$/.test($('al-fixed').value) ? $('al-fixed').value : null,
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
function openDayEdit(dayIndex){
  const day = trip().days[dayIndex];
  $('de-index').value = String(dayIndex);
  $('de-title').value = day.title;
  $('de-start').value = day.start;
  const sel = $('de-hotel');
  sel.innerHTML = `<option value="">No hotel</option>` +
    trip().hotels.map(h => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('');
  sel.value = day.hotelId || '';
  $('de-bookend').value = day.bookend || 'both';
  const syncBookendVisibility = () => $('de-bookend-label').classList.toggle('hidden', !sel.value);
  sel.onchange = syncBookendVisibility;
  syncBookendVisibility();
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
  day.hotelId = $('de-hotel').value || null;
  day.bookend = ['start','end'].includes($('de-bookend').value) ? $('de-bookend').value : 'both';
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
  trip().days.forEach(d => { if(d.hotelId === hotelId) d.hotelId = null; });
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
  if(state.trip.bin.length === 0){
    el.innerHTML = `<p style="padding:20px 22px; color:var(--ink-soft); font-size:14px;">Nothing in the bin. Remove a stop from any day (the 🗑 button) and it'll show up here to restore later.</p>`;
    return;
  }
  el.innerHTML = '';
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
    row.className = 'search-row';
    row.innerHTML = `<span class="sr-icon">${ICONS[s.cat] || '📍'}</span>
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
    const usedBy = trip().days.filter(d => d.hotelId === h.id).map(d => 'D' + d.id).join(', ');
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
  row.className = 'bin-row all-row';
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
  pendingPlan = plan;
  renderAutoPlanPreview(plan);
}

function renderAutoPlanPreview(plan){
  destroyApMaps();
  const wrap = $('ap-days');
  wrap.innerHTML = '';
  $('ap-sub').textContent = 'Stops grouped by proximity and what realistically fits each day (visit lengths + travel + hotel legs). Check each day below — nothing changes until you accept.';
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#C1502E';

  const scheds = plan.days.map(d => computeSchedule(plan, d));
  plan.days.forEach((day, i) => {
    const sched = scheds[i];
    const over = sched.rows.length && sched.returnTime > 22 * 60 + 30;
    const el = document.createElement('div');
    el.className = 'ap-day';
    el.innerHTML = `
      <div class="ap-head">
        <b>Day ${day.id}</b> · ${day.order.length} stop${day.order.length === 1 ? '' : 's'}
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
      if(!document.getElementById(elId)) return;
      const m = L.map(elId, { zoomControl: false, attributionControl: false, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
      const pts = [];
      let num = 0;
      scheds[i].rows.forEach(r => {
        const s = r.stop;
        if(s.lat == null) return;
        num += 1;
        L.marker([s.lat, s.lng], { icon: L.divIcon({
          className: '', html: '<div class="map-pin ap-pin"><span>' + num + '</span></div>',
          iconSize: [20, 20], iconAnchor: [10, 18]
        })}).addTo(m);
        pts.push([s.lat, s.lng]);
      });
      if(scheds[i].hotel && scheds[i].hotel.lat != null && pts.length){
        pts.push([scheds[i].hotel.lat, scheds[i].hotel.lng]);
      }
      if(pts.length > 1){
        L.polyline(pts, { color: accent, weight: 2, dashArray: '4 4', opacity: 0.8 }).addTo(m);
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
  ['weather', 'Weather', 'Expected weather for your dates, what to pack…'],
  ['closures', 'Location closures', 'Which attractions close on which weekdays — e.g. "Musée d’Orsay — closed Mondays"'],
  ['reservations', 'Reservation musts', 'What needs booking, and how far ahead…'],
  ['events', 'Overlapping events', 'Festivals, exhibitions, holidays during the trip…'],
  ['notes', 'General notes', 'Anything else — transport tips, etiquette, scams to avoid…'],
];

export function renderInfo(){
  const el = $('infogrid');
  const t = trip();

  el.innerHTML = `
    <div class="infocard" style="grid-column:1/-1;">
      <h3>Hotels</h3>
      <div id="hotel-mini-list"></div>
      <button class="reset-btn" id="add-hotel-btn" style="margin-top:10px;">+ Add hotel</button>
    </div>
    ${INFO_CARDS.map(([key, title, ph]) => `
      <div class="infocard">
        <h3>${title}</h3>
        <textarea class="info-edit" data-info="${key}" placeholder="${esc(ph)}">${esc(t.info[key] || '')}</textarea>
      </div>`).join('')}
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

  // editable info fields
  el.querySelectorAll('.info-edit').forEach(ta => {
    autoGrow(ta);
    ta.addEventListener('input', debounce(() => {
      trip().info[ta.dataset.info] = ta.value;
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
      <p>Export saves this whole trip (locations, notes, hotels, trip info) as one markdown file. Import accepts pasted text or an uploaded file — the markdown format (.md/.txt) carries everything, a CSV carries locations only. <b>Importing replaces the current trip</b> (Undo brings the old one back) — to change an existing trip with an AI, use the "Edit this trip" prompt above and import its full updated output. The KML export makes a shareable Google map: go to <a href="https://mymaps.google.com" target="_blank" rel="noopener">mymaps.google.com</a> → Create a new map → Import → pick the .kml — every day becomes a toggleable layer with pins and the route.</p>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="export-btn">⬇ Export trip (.md)</button>
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
  on('btn-view-days', 'click', () => setView('days'));
  on('btn-view-all', 'click', () => setView('all'));
  on('btn-view-bin', 'click', () => setView('bin'));
  on('btn-view-optional', 'click', () => setView('optional'));
  on('btn-view-info', 'click', () => setView('info'));
  on('btn-view-ai', 'click', () => setView('ai'));
  on('group-btn', 'click', autoPlanPreview);
  on('auto-plan-close', 'click', closeAutoPlan);
  on('ap-cancel', 'click', closeAutoPlan);
  on('ap-accept', 'click', acceptAutoPlan);
  on('auto-plan-overlay', 'click', (e) => { if(e.target.id === 'auto-plan-overlay') closeAutoPlan(); });
  on('add-optional-btn', 'click', () => openLocationForm(null, 'optional'));
  on('all-add-btn', 'click', () => openLocationForm(null, currentDay().id));

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
  on('al-cat', 'change', refreshHikeFields);
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
    for(const id of ['search-overlay','auto-plan-overlay','add-location-overlay','day-edit-overlay','hotel-edit-overlay','settings-overlay','modal-overlay']){
      const ov = $(id);
      if(ov && ov.classList.contains('open')){
        if(id === 'modal-overlay') closeModal();
        else if(id === 'search-overlay') closeSearch();
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
    refreshHikeFields();
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
