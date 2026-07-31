/* =========================================================
   PLACE SEARCH (Photon)

   Search-as-you-type geocoding for the add-location and hotel
   forms, backed by Photon (photon.komoot.io) — OSM-based,
   keyless, and explicitly built for autocomplete (unlike
   Nominatim, whose public instance forbids type-ahead).
   Debounced, cancellable, and silent on failure: if Photon is
   unreachable the form simply behaves as before (manual
   coordinates).
   ========================================================= */

import { esc, debounce } from './util.js';

function baseOverride(key, fallback){
  try{ return localStorage.getItem(key) || fallback; } catch(e){ return fallback; }
}
const PHOTON = baseOverride('routing.photonBase', 'https://photon.komoot.io');

/* OSM tag → our category. Best effort; the user can always change it. */
function catFromOsm(key, value){
  if(key === 'tourism'){
    if(value === 'museum' || value === 'gallery') return 'museum';
    if(value === 'viewpoint') return 'view';
    if(value === 'hotel' || value === 'hostel' || value === 'guest_house') return 'hotel';
    return 'landmark';
  }
  if(key === 'amenity'){
    if(['restaurant','cafe','bar','pub','fast_food','food_court','ice_cream','biergarten'].includes(value)) return 'food';
    if(value === 'place_of_worship') return 'church';
    if(value === 'marketplace') return 'shop';
    if(value === 'theatre' || value === 'arts_centre') return 'landmark';
    return 'other';
  }
  if(key === 'historic') return 'landmark';
  if(key === 'leisure') return ['park','garden','nature_reserve'].includes(value) ? 'park' : 'other';
  if(key === 'shop') return 'shop';
  if(key === 'natural') return ['peak','beach','bay','cliff'].includes(value) ? 'view' : 'park';
  if(key === 'building' && value === 'church') return 'church';
  if(key === 'railway' || key === 'aeroway') return 'travel';
  return 'other';
}

function parseFeature(f){
  const p = f.properties || {};
  const [lng, lat] = (f.geometry && f.geometry.coordinates) || [null, null];
  const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || 'Unnamed place';
  const where = [p.city || p.county, p.state, p.country].filter(Boolean).filter(x => x !== name);
  return {
    name,
    label: where.slice(0, 2).join(', '),
    lat, lng,
    cat: catFromOsm(p.osm_key, p.osm_value),
  };
}

let reqSeq = 0;
async function search(q){
  const mySeq = ++reqSeq;
  const url = PHOTON + '/api/?' + new URLSearchParams({ q, limit: '6', lang: 'en' });
  const res = await fetch(url);
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if(mySeq !== reqSeq) throw new Error('stale');   // a newer keystroke superseded us
  return (data.features || []).map(parseFeature).filter(r => r.lat != null);
}

/* Attach an inline suggestion list under `input`. onPick(result) fires when a
   suggestion is chosen. The list renders as a normal block element (not a
   floating popover) so it never clips inside scrolling modals. */
export function attachAutocomplete(input, onPick, onStatus){
  const list = document.createElement('div');
  list.className = 'ac-list hidden';
  input.insertAdjacentElement('afterend', list);
  let results = [];
  let activeIdx = -1;
  let suppress = false;    // true right after a pick, so the fill doesn't re-search

  function hide(){ list.classList.add('hidden'); list.innerHTML = ''; results = []; activeIdx = -1; }
  function render(){
    if(!results.length){ hide(); return; }
    list.classList.remove('hidden');
    list.innerHTML = results.map((r, i) =>
      `<button type="button" class="ac-item${i === activeIdx ? ' active' : ''}" data-i="${i}">
        <span class="ac-name">${esc(r.name)}</span>${r.label ? `<span class="ac-where">${esc(r.label)}</span>` : ''}
      </button>`).join('');
    list.querySelectorAll('.ac-item').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {   // mousedown: fires before input blur
        e.preventDefault();
        pick(Number(btn.dataset.i));
      });
    });
  }
  function pick(i){
    const r = results[i];
    if(!r) return;
    suppress = true;
    hide();
    onPick(r);
    setTimeout(() => { suppress = false; }, 50);
  }

  const run = debounce(async () => {
    const q = input.value.trim();
    if(suppress || q.length < 3){ hide(); return; }
    try{
      results = await search(q);
      activeIdx = -1;
      render();
      if(onStatus) onStatus({ count: results.length, error: false });
    } catch(e){
      // offline / blocked / stale — manual entry still works; let the caller
      // know so it can reveal the manual-coordinates fields.
      if(onStatus && e.message !== 'stale') onStatus({ count: 0, error: true });
    }
  }, 300);

  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', run);
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => {
    if(list.classList.contains('hidden')) return;
    if(e.key === 'ArrowDown'){ e.preventDefault(); activeIdx = Math.min(activeIdx + 1, results.length - 1); render(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); render(); }
    else if(e.key === 'Enter' && activeIdx >= 0){ e.preventDefault(); pick(activeIdx); }
    else if(e.key === 'Escape'){ e.stopPropagation(); hide(); }
  });
}
