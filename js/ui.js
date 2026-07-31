/* =========================================================
   UI — all rendering and interaction.
   Ported from the Rome & Venice itinerary and generalised:
   no hardcoded cities, hotels, or stops; everything renders
   from the trip object and every piece of user content is
   escaped before it touches innerHTML.
   ========================================================= */

import { esc, formatTime, formatDur, dayDate, formatDayDate, slugify, debounce } from './util.js';
import { CATEGORIES, DEFAULT_DUR, THEMES, newDay, serializeTrip, importText, blankTrip } from './format.js';
import { state, saveState, pushUndo, popUndo, replaceTrip, nextStopId, nextHotelId } from './state.js';
import { computeSchedule, getHotel } from './schedule.js';
import { optimizeDayOrder, distributeAcrossDays } from './optimize.js';
import { routingStatus, onRoutingUpdate } from './routing.js';
import { cloud, cloudStatusText, createRoom, leaveRoom, shareUrl } from './cloud.js';
import { buildPrompt } from './llm.js';

const ICONS = {
  landmark:'🏛️', museum:'🖼️', church:'⛪', park:'🌳',
  food:'🍝', view:'🌇', travel:'🚄', shop:'🛍️', hotel:'🛏️', boat:'🚤', other:'📍'
};
const CAT_LABEL = {
  landmark:'Landmark', museum:'Museum', church:'Church / temple', park:'Park / nature',
  view:'Viewpoint', food:'Food & drink', shop:'Shopping', hotel:'Hotel / check-in',
  travel:'Travel leg (train, flight…)', boat:'Boat / ferry', other:'Other'
};
const MODE_ICON = { walk:'🚶', transit:'🚌', taxi:'🚕', boat:'🚤' };
const MODE_LABEL = { walk:'walk', transit:'transit', taxi:'taxi', boat:'boat shuttle' };

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
let mapFitPts = null;
let mapFitPending = false;
let modalStopId = null;

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
function renderTabs(){
  const el = $('daytabs');
  el.innerHTML = '';
  trip().days.forEach((d, i) => {
    const btn = document.createElement('div');
    btn.className = 'daytab' + (i === state.currentDayIndex ? ' active' : '');
    const date = dayDate(trip().startDate, i);
    btn.innerHTML = '<span class="d-num">D' + d.id + '</span> · ' + esc(d.title) +
      (date ? ' <span style="opacity:.75">· ' + formatDayDate(date) + '</span>' : '');
    btn.addEventListener('click', () => { state.currentDayIndex = i; renderAll(); });
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
  el.appendChild(add);
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
        <button class="reset-btn" id="add-location-btn">+ Add location</button>
        <button class="reset-btn" id="optimize-order" title="Reorder this day's stops to minimise travel time">✨ Optimize route</button>
      </div>
    </div>
    ${hotelBarHtml}
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
          <span>🚶 walk</span><span>🚌 transit</span><span>🚕 taxi</span><span>🚤 boat</span>
        </div>
      </div>
    </div>
  `;

  $('edit-day-btn').addEventListener('click', () => openDayEdit(state.currentDayIndex));
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

  renderScheduleList(day, sched);
  renderMap(day, sched);
}

function travelConnector(minutes, mode, live, prefixText){
  const conn = document.createElement('div');
  conn.className = 'travel-connector';
  conn.innerHTML = (MODE_ICON[mode] || '🚶') + ' ' + (prefixText || '') + '~' + minutes + ' min ' +
    (MODE_LABEL[mode] || mode) + (live ? '' : ' <span class="est" title="Estimated from distance — a routed time will replace this shortly">· est</span>');
  return conn;
}

function renderScheduleList(day, sched){
  const { rows, leadTransfer, trailTransfer, returnTime, hotel } = sched;
  const list = $('schedule-list');
  list.innerHTML = '';

  if(rows.length === 0){
    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--ink-soft); font-size:14px; padding:8px 4px; line-height:1.5;';
    hint.innerHTML = 'Nothing planned for this day yet.<br>Use <b>+ Add location</b> above, pull something in from the <b>Optional</b> tab, or import a whole trip from <b>Trip Info → Import</b>.';
    list.appendChild(hint);
    return;
  }

  let mapOrder = 0;
  if(hotel && leadTransfer){
    list.appendChild(travelConnector(leadTransfer.minutes, leadTransfer.mode, leadTransfer.live, 'Depart ' + esc(hotel.name) + ', '));
  }

  rows.forEach((row, idx) => {
    if(idx > 0 && row.travelBefore > 0){
      list.appendChild(travelConnector(row.travelBefore, row.travelMode || 'walk', row.travelLive));
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
    const illustrationHtml = s.img
      ? `<div class="stop-illustration has-img"><img src="${esc(s.img)}" alt="${esc(s.name)}" loading="lazy"></div>`
      : `<div class="stop-illustration">${ICONS[s.cat] || '📍'}</div>`;

    const dayOptionsHtml = trip().days.filter(d => d.id !== day.id)
      .map(d => `<option value="${d.id}">D${d.id} · ${esc(shortTitle(d.title))}</option>`).join('') +
      `<option value="optional">→ Optional</option>`;

    card.innerHTML = `
      ${numberBadgeHtml}
      ${illustrationHtml}
      <div class="stop-main">
        <div class="stop-time-row">
          <span class="clock">${formatTime(row.start)}</span>
          <span>·</span>
          <span>${formatDur(s.dur)}</span>
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

    const imgEl = card.querySelector('.stop-illustration img');
    if(imgEl) imgEl.addEventListener('error', () => {
      const box = imgEl.parentElement;
      box.classList.remove('has-img');
      box.textContent = ICONS[s.cat] || '📍';
    });

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
      'Return to ' + esc(hotel.name) + ', '));
    const arrive = document.createElement('div');
    arrive.className = 'travel-connector';
    arrive.innerHTML = '🏨 Back at the hotel ~' + formatTime(returnTime);
    list.appendChild(arrive);
  }
}

function shortTitle(t){ return t.length > 18 ? t.slice(0, 17) + '…' : t; }

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

function reorder(day, draggedId, targetId, before){
  if(draggedId === targetId) return;
  const order = day.order;
  const fromIdx = order.indexOf(draggedId);
  if(fromIdx === -1) return;
  pushUndo();
  order.splice(fromIdx, 1);
  let toIdx = order.indexOf(targetId);
  if(!before) toIdx += 1;
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
  leafletMap.fitBounds(mapFitPts, { padding:[30,30], maxZoom:16 });
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

  if(leafletMap){ leafletMap.remove(); leafletMap = null; }
  leafletMap = L.map('map', { scrollWheelZoom: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(leafletMap);

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
    L.marker([hotel.lat, hotel.lng], { icon: hotelIcon }).addTo(leafletMap)
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
    L.marker([s.lat, s.lng], { icon }).addTo(leafletMap)
      .bindPopup('<b>' + esc(s.name) + '</b><br>' + formatTime(row.start));
    const cur = [s.lat, s.lng];
    // travelPath on a row is the routed geometry of the leg ARRIVING at it
    // (computed in the same sequence computeSchedule walked).
    if(prevPt) segs.push({ from: prevPt, to: cur, path: row.travelPath });
    pts.push(cur);
    prevPt = cur;
  });

  if(hotel && hotel.lat != null && pts.length > 1){
    segs.push({ from: prevPt, to: [hotel.lat, hotel.lng], path: sched.trailTransfer ? sched.trailTransfer.path : null });
    pts.push([hotel.lat, hotel.lng]);
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#C1502E';
  const boundPts = pts.slice();
  segs.forEach(seg => {
    if(seg.path && seg.path.length > 1){
      // Real routed geometry: solid line following the streets/canals.
      L.polyline(seg.path, { color: accent, weight: 3.5, opacity: 0.85 }).addTo(leafletMap);
      boundPts.push(...seg.path);
    } else {
      // No routed shape (yet, or boat shuttle): dashed straight estimate.
      L.polyline([seg.from, seg.to], { color: accent, weight: 3, dashArray: '6 6', opacity: 0.7 }).addTo(leafletMap);
    }
  });

  mapFitPts = boundPts;
  mapFitPending = false;
  if(boundPts.length > 1){
    if(!fitMapToDay()){
      leafletMap.setView(L.latLngBounds(boundPts).getCenter(), 13);
    }
  } else if(boundPts.length === 1){
    leafletMap.setView(boundPts[0], 15);
  } else {
    leafletMap.setView([30, 10], 2);   // blank trip: whole-world view
  }
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
  if(stop.img){
    photo.innerHTML = `<img src="${esc(stop.img)}" alt="${esc(stop.name)}">`;
    photo.querySelector('img').addEventListener('error', () => { photo.textContent = ICONS[stop.cat] || '📍'; });
  } else {
    photo.textContent = ICONS[stop.cat] || '📍';
  }
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
    `<option value="optional">Optional (no day yet)</option>`;
  sel.value = selectedValue;
  if(!sel.value) sel.value = String(trip().days[0].id);
}

function whereIsStop(id){
  for(const d of trip().days){ if(d.order.includes(id)) return String(d.id); }
  if(trip().optional.some(o => o.id === id)) return 'optional';
  return 'bin';
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
    $('al-lat').value = s.lat ?? '';
    $('al-lng').value = s.lng ?? '';
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
  pushUndo();
  const editId = $('al-editing').value;
  const id = editId || nextStopId();
  const prev = editId ? trip().stops[editId] : null;
  trip().stops[id] = {
    id, name, cat,
    dur: parseInt($('al-dur').value, 10) || DEFAULT_DUR[cat] || 45,
    lat: (lat != null && lng != null) ? lat : null,
    lng: (lat != null && lng != null) ? lng : null,
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
  $('day-edit-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
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
    el.innerHTML = `<p style="padding:20px 22px; color:var(--ink-soft); font-size:14px;">No optional ideas yet. Use "Move to… → Optional" on any stop, choose "Optional" when adding a location, or include an "## Optional" section in an imported trip.</p>`;
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
      <h3>Plan with an AI assistant</h3>
      <p>Copy this prompt into any AI assistant (Claude, ChatGPT…). It asks the right questions, then produces a complete trip — locations, coordinates, descriptions, restaurant picks, closures, reservations — in exactly the format this site imports.</p>
      <textarea class="prompt-area" id="llm-prompt" readonly></textarea>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="copy-prompt">Copy prompt</button>
      </div>
    </div>
    <div class="infocard" style="grid-column:1/-1;">
      <h3>Import &amp; export</h3>
      <p>Export saves this whole trip (locations, notes, hotels, trip info) as one markdown file. Import accepts that same format — hand-written, exported here, or produced by an AI using the prompt above — or a simple CSV of locations. Importing replaces the current trip (Undo works).</p>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="export-btn">⬇ Export trip (.md)</button>
        <button class="reset-btn" id="import-file-btn">⬆ Import file (.md / .txt / .csv)</button>
        <input type="file" id="import-file" accept=".md,.txt,.csv,text/plain,text/markdown,text/csv" class="hidden">
        <button class="reset-btn" id="demo-btn">Load example trip (Rome &amp; Venice)</button>
      </div>
      <p style="margin:12px 0 4px;">…or paste a trip here:</p>
      <textarea class="import-area" id="import-paste" placeholder="# Trip: My Trip&#10;&#10;## Day 1: …"></textarea>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="import-paste-btn">Import pasted text</button>
      </div>
      <p class="import-warnings" id="import-warnings"></p>
    </div>
    <div class="infocard" style="grid-column:1/-1;">
      <h3>Share &amp; sync across devices</h3>
      <p>Create a share link and this trip moves to the cloud. Open the link on your phone, or send it to whoever you're travelling with — everyone sees the same plan, and edits show up on the other devices within a second or two. No accounts: the link <i>is</i> the key. Nothing is uploaded until you create a link.</p>
      <p id="cloud-state" class="cloud-state"></p>
      <div id="cloud-link-row" class="cloud-link-row hidden">
        <input type="text" id="cloud-link" readonly aria-label="Share link" />
        <button class="reset-btn" id="cloud-copy">Copy link</button>
      </div>
      <div class="cloud-btn-row">
        <button class="reset-btn" id="cloud-create">Create a share link</button>
        <button class="reset-btn hidden" id="cloud-leave">Stop syncing</button>
      </div>
      <p class="cloud-warn"><b>Worth knowing:</b> anyone holding the link can edit the trip, and a link that gets out can't be revoked — you'd have to create a new one. Simultaneous edits resolve last-change-wins. "Stop syncing" only detaches this browser; it doesn't delete the shared copy.</p>
    </div>
    <div class="infocard">
      <h3>How to use this site</h3>
      <p>Reorder a day by dragging a stop card with its ⠿ handle — dragging anywhere else selects text. Keyboard: focus the handle and press ↑/↓. Click a card for details and notes. "Move to…" reassigns a stop; 🗑 sends it to the Bin. "✨ Optimize route" reorders a day to minimise travel; "Distribute stops across days" (in ⚙ Settings) rebalances the whole trip. Travel times marked "est" are distance-based guesses that upgrade automatically to real routed times.</p>
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

  // LLM prompt
  $('llm-prompt').value = buildPrompt(t);
  $('copy-prompt').addEventListener('click', () => copyText($('llm-prompt').value, $('copy-prompt'), 'Copy prompt'));

  // import / export
  $('export-btn').addEventListener('click', exportTrip);
  $('import-file-btn').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    doImport(await file.text());
    e.target.value = '';
  });
  $('import-paste-btn').addEventListener('click', () => doImport($('import-paste').value));
  $('demo-btn').addEventListener('click', loadDemo);

  // cloud
  $('cloud-create').addEventListener('click', createRoom);
  $('cloud-leave').addEventListener('click', () => {
    if(confirm('Stop syncing this browser with the shared trip? The shared copy stays available at the link.')) leaveRoom();
  });
  $('cloud-copy').addEventListener('click', () => copyText($('cloud-link').value, $('cloud-copy'), 'Copy link'));
  renderCloudUI();
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

function doImport(text){
  const warnEl = $('import-warnings');
  warnEl.textContent = '';
  let result;
  try{
    result = importText(text);
  } catch(e){
    warnEl.textContent = '✕ ' + e.message;
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
  if(result.warnings.length){
    warnEl.textContent = '⚠ ' + result.warnings.slice(0, 6).join(' ') + (result.warnings.length > 6 ? ' (+' + (result.warnings.length - 6) + ' more)' : '');
  }
}

async function loadDemo(){
  try{
    const res = await fetch('demo/rome-venice-trip.md');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    doImport(await res.text());
  } catch(e){
    $('import-warnings').textContent = '✕ Could not load the example trip (' + e.message + ').';
  }
}

/* =========================================================
   CLOUD UI
   ========================================================= */
export function renderCloudUI(){
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
  $('cloud-leave').classList.toggle('hidden', !inRoom);
  if(inRoom) $('cloud-link').value = shareUrl(cloud.room);
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

function distribute(){
  const t = trip();
  const total = t.days.reduce((n, d) => n + d.order.length, 0);
  if(total < 2){ alert('Add some locations first — there’s nothing to distribute yet.'); return; }
  if(!confirm('Reassign stops across all ' + t.days.length + ' days by geography and time budget, then optimise each day’s order? Undo can revert it.')) return;
  pushUndo();
  const { orders, moved } = distributeAcrossDays(t);
  t.days.forEach(d => { if(orders[d.id]) d.order = orders[d.id]; });
  saveState();
  closeSettings();
  renderAll();
  if(moved === 0) setTimeout(() => alert('Days were already well balanced — each day’s order was optimised.'), 50);
}

function clearTrip(){
  if(!confirm('Start a new blank trip? The current one is replaced (Undo can bring it back, and Export first if you want a file copy).')) return;
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
  ['days','bin','optional','info'].forEach(v => {
    $('btn-view-' + v).classList.toggle('active', view === v);
    $('view-' + v).classList.toggle('hidden', view !== v);
  });
  if(view === 'days') setTimeout(() => {
    if(!leafletMap) return;
    leafletMap.invalidateSize();
    if(mapFitPending) fitMapToDay();
  }, 50);
  if(view === 'bin') renderBin();
  if(view === 'optional') renderOptional();
  if(view === 'info') renderInfo();
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
  if(state.currentView === 'bin') renderBin();
  if(state.currentView === 'optional') renderOptional();
}

export function wireStaticHandlers(){
  $('btn-view-days').addEventListener('click', () => setView('days'));
  $('btn-view-bin').addEventListener('click', () => setView('bin'));
  $('btn-view-optional').addEventListener('click', () => setView('optional'));
  $('btn-view-info').addEventListener('click', () => setView('info'));
  $('btn-settings').addEventListener('click', openSettings);
  $('trip-title').addEventListener('click', openSettings);
  $('cloud-chip').addEventListener('click', () => setView('info'));
  $('undo-btn').addEventListener('click', () => {
    if(popUndo()){
      applyTheme();
      renderAll();
      if(state.currentView === 'info') renderInfo();
    }
  });

  // detail modal
  $('modal-close').addEventListener('click', closeModal);
  $('modal-overlay').addEventListener('click', (e) => { if(e.target.id === 'modal-overlay') closeModal(); });
  $('modal-notes').addEventListener('input', saveNotesDebounced);
  $('modal-edit').addEventListener('click', () => {
    const id = modalStopId;
    closeModal();
    if(id) openLocationForm(id);
  });
  $('modal-bin').addEventListener('click', () => {
    const id = modalStopId;
    closeModal();
    if(!id) return;
    const day = trip().days.find(d => d.order.includes(id)) || null;
    removeToBin(day, id);
  });

  // add/edit location
  $('add-location-close').addEventListener('click', closeLocationForm);
  $('add-location-overlay').addEventListener('click', (e) => { if(e.target.id === 'add-location-overlay') closeLocationForm(); });
  $('add-location-form').addEventListener('submit', submitLocationForm);

  // day edit
  $('day-edit-close').addEventListener('click', closeDayEdit);
  $('day-edit-overlay').addEventListener('click', (e) => { if(e.target.id === 'day-edit-overlay') closeDayEdit(); });
  $('day-edit-form').addEventListener('submit', submitDayEdit);
  $('de-delete').addEventListener('click', deleteDay);

  // hotel edit
  $('hotel-edit-close').addEventListener('click', closeHotelEdit);
  $('hotel-edit-overlay').addEventListener('click', (e) => { if(e.target.id === 'hotel-edit-overlay') closeHotelEdit(); });
  $('hotel-edit-form').addEventListener('submit', submitHotelEdit);

  // settings
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', (e) => { if(e.target.id === 'settings-overlay') closeSettings(); });
  $('settings-form').addEventListener('submit', submitSettings);
  $('st-distribute').addEventListener('click', distribute);
  $('st-clear').addEventListener('click', clearTrip);

  // escape closes whichever overlay is open
  document.addEventListener('keydown', (e) => {
    if(e.key !== 'Escape') return;
    for(const id of ['add-location-overlay','day-edit-overlay','hotel-edit-overlay','settings-overlay','modal-overlay']){
      if($(id).classList.contains('open')){
        if(id === 'modal-overlay') closeModal();
        else { $(id).classList.remove('open'); document.body.style.overflow = ''; }
        return;
      }
    }
  });

  // disarm drag armed on a handle press that never became a drag
  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.stop-card[draggable="true"]').forEach(c => { c.draggable = false; });
  });

  // routed travel times landing → refresh the schedule quietly
  onRoutingUpdate(() => {
    if(state.currentView === 'days') renderDayPanel();
    renderFooter();
  });
}
