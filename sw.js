/* Service worker: keeps the app usable on weak roaming data.
   - App files: network first (so updates arrive), cached copy when offline or slow.
   - Map tiles and restaurant photos: cache first, so viewed or pre-saved areas work offline. */
const VERSION = '2026-11-11-e8548550';
const APP_CACHE = 'ofm-app-' + VERSION;
const TILE_CACHE = 'ofm-tiles-v3'; // v1: CARTO "API KEY REQUIRED" tiles; v2: opaque (no-cors) tiles MapLibre can't use
const IMG_CACHE = 'ofm-img-v1';
const VEC_CACHE = 'ofm-vec-meta-v1';
const APP_FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png',
  './vendor/maplibre-gl.js', './vendor/maplibre-gl.css'];
const TILE_HOSTS = ['cyberjapandata.gsi.go.jp', 'tile.openstreetmap.org', 'server.arcgisonline.com'];
const MAX_TILES = 4000, MAX_IMGS = 120;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => (k.startsWith('ofm-app-') && k !== APP_CACHE) || (k.startsWith('ofm-tiles-') && k !== TILE_CACHE)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(name, max) {
  const c = await caches.open(name), keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

async function cacheFirst(req, name, max) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreVary: true });
  // an opaque (no-cors) copy can't answer a CORS request such as a MapLibre tile fetch
  if (hit && !(hit.type === 'opaque' && req.mode === 'cors')) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) {
    c.put(req, res.clone()).then(() => { if (Math.random() < 0.05) trim(name, max); });
  }
  return res;
}

// Vector map style/TileJSON change when OpenFreeMap publishes new data: network first, cached copy offline.
async function networkFirstExt(req) {
  const c = await caches.open(VEC_CACHE);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 6000))]);
    if (res && res.ok) c.put(req.url, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req.url);
    if (hit) return hit;
    throw err;
  }
}

async function networkFirst(req) {
  const c = await caches.open(APP_CACHE);
  try {
    const res = await Promise.race([
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }), // revalidate past the 10-minute HTTP cache
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 6000)),
    ]);
    if (res && res.ok) c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await c.match('./index.html'));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Google Maps terms: never cache Google map tiles, scripts, fonts or images — let them go straight to the network
  if (/(^|\.)(google\.com|googleapis\.com|gstatic\.com|ggpht\.com|googleusercontent\.com)$/.test(url.hostname)) return;
  if (url.hostname === 'tiles.openfreemap.org') {
    // tiles (.pbf), fonts and sprites are immutable per URL; styles and TileJSON are not
    if (/\.pbf$|\/fonts\/|\/sprites\//.test(url.pathname)) e.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
    else e.respondWith(networkFirstExt(req));
  } else if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    e.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
  } else if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  } else if (req.destination === 'image') {
    e.respondWith(cacheFirst(req, IMG_CACHE, MAX_IMGS).catch(() => Response.error()));
  }
});
