/* =========================================================
   STOP PHOTOS

   Image URLs are typed by people or written by an AI, so a
   fair share of them are wrong in predictable ways: a
   Wikimedia *page* about a file instead of the file itself, a
   thumbnail width that doesn't exist, or plain http on an
   https site (blocked as mixed content). Each URL therefore
   expands into a short list of candidates, each candidate
   gets a couple of retries, and when everything is exhausted
   the box simply keeps its category icon.

   The icon is what's on screen from the start — a photo only
   ever replaces it once it has actually loaded — so a broken
   link is invisible rather than an empty grey rectangle.

   Each URL is resolved once per session and the outcome is
   shared: re-renders (every day switch rebuilds its cards)
   reuse the answer instead of restarting the retries, and a
   URL known to be dead costs nothing at all.
   ========================================================= */

const RETRY_DELAYS = [500, 1500];   // per candidate; length = retries per candidate

const resolved = new Map();    // url as written -> working url, or false if none worked
const resolving = new Map();   // url -> in-flight Promise of the above

const WIKI_PAGE = /^https?:\/\/(?:[^/]+\.)?wik(?:ipedia|imedia|tionary|ivoyage)\.org\/wiki\/(?:File|Image|Datei|Fichier|Archivo|Immagine)(?::|%3A)(.+)$/i;
const WIKI_THUMB = /^https?:\/\/upload\.wikimedia\.org\/(wikipedia\/[^/]+)\/thumb\/([^/]+\/[^/]+\/[^/]+)\/[^/]+$/i;

function filePathUrl(name, width){
  const clean = name.replace(/[?#].*$/, '').replace(/ /g, '_');
  return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + clean + (width ? '?width=' + width : '');
}

/* Every URL worth trying for one stored image, best guess first. */
export function imageCandidates(raw){
  const url = String(raw || '').trim();
  if(!url) return [];
  const out = [];
  const push = u => { if(u && !out.includes(u)) out.push(u); };

  const page = WIKI_PAGE.exec(url);
  if(page){
    // A link to the description page, not to the image. Special:FilePath
    // redirects to the real file, and can size it on the way.
    push(filePathUrl(page[1], 1200));
    push(filePathUrl(page[1], 0));
  }

  // An http image on an https page is blocked as mixed content, so try the
  // https form first there. On an http page (localhost, a LAN box) the URL
  // as written is the better first guess.
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';
  if(secure && /^http:\/\//i.test(url)) push(url.replace(/^http:/i, 'https:'));

  push(url);

  const thumb = WIKI_THUMB.exec(url);
  if(thumb){
    // Thumbnails are generated on demand and the odd size 404s;
    // the original behind it is always there.
    push('https://upload.wikimedia.org/' + thumb[1] + '/' + thumb[2]);
  }
  if(!secure && /^http:\/\//i.test(url)) push(url.replace(/^http:/i, 'https:'));
  return out;
}

/* Walk the candidates until one loads. Resolves to the working URL, or
   false once they're all spent. */
function resolveImage(url){
  if(resolved.has(url)) return Promise.resolve(resolved.get(url));
  if(resolving.has(url)) return resolving.get(url);

  const candidates = imageCandidates(url);
  const p = new Promise(done => {
    if(!candidates.length) return done(false);
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';   // some hosts refuse hotlinks by referrer
    let ci = 0, attempt = 0;
    const load = () => { probe.src = attempt ? bust(candidates[ci], attempt) : candidates[ci]; };
    probe.addEventListener('load', () => done(probe.src));
    probe.addEventListener('error', () => {
      if(attempt < RETRY_DELAYS.length){
        const wait = RETRY_DELAYS[attempt];
        attempt += 1;
        setTimeout(load, wait);
        return;
      }
      ci += 1; attempt = 0;
      if(ci < candidates.length) load();
      else done(false);
    });
    load();
  }).then(result => {
    resolved.set(url, result);
    resolving.delete(url);
    return result;
  });

  resolving.set(url, p);
  return p;
}

/* Show `fallback` (a category icon) in `box`, then quietly replace it with
   the image at `url` if one can be loaded. Failure is a no-op. */
export function mountImage(box, url, fallback, opts = {}){
  box.classList.remove('has-img');
  box.textContent = fallback;
  if(!url) return;
  resolveImage(url).then(src => {
    if(!src || box.textContent !== fallback) return;   // gone, or re-rendered since
    const img = document.createElement('img');
    img.alt = opts.alt || '';
    img.referrerPolicy = 'no-referrer';
    img.src = src;                                     // already in the browser cache
    box.textContent = '';
    box.classList.add('has-img');
    box.appendChild(img);
  });
}

/* Retries reuse the same URL and browsers cache the failure — a throwaway
   query param forces a real request. */
function bust(url, n){
  return url + (url.includes('?') ? '&' : '?') + '_retry=' + n;
}
