// Builds the deployable site at the repo root: index.html (single file, Leaflet inlined), sw.js, manifest.
// Usage: node tools/build.mjs
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const write = (p, s) => writeFileSync(new URL('../' + p, import.meta.url), s);

const data = JSON.parse(read('src/data.json'));
const parts = {
  '/*__LEAFLET_CSS__*/': read('node_modules/leaflet/dist/leaflet.css'),
  '/*__CLUSTER_CSS__*/': read('node_modules/leaflet.markercluster/dist/MarkerCluster.css'),
  '/*__LEAFLET_JS__*/': read('node_modules/leaflet/dist/leaflet.js').replace(/\/\/# sourceMappingURL=.*$/m, ''),
  '/*__CLUSTER_JS__*/': read('node_modules/leaflet.markercluster/dist/leaflet.markercluster.js').replace(/\/\/# sourceMappingURL=.*$/m, ''),
  '/*__DATA__*/': JSON.stringify(data),
};

let html = read('src/app.html');
for (const [k, v] of Object.entries(parts)) {
  if (!html.includes(k)) throw new Error('missing placeholder ' + k);
  html = html.split(k).join(v); // split/join (not String.replace) keeps "$" sequences in the libraries intact
}
const hash = createHash('sha256').update(html).digest('hex').slice(0, 8);
const stamp = new Date().toISOString().slice(0, 10) + '-' + hash;
html = html.replaceAll('__BUILD__', stamp);
if (/<script[^>]+src=/i.test(html) || /<link[^>]+stylesheet/i.test(html)) throw new Error('external script/style found');

write('index.html', html);
write('sw.js', read('src/sw.js').replaceAll('__BUILD__', stamp));
copyFileSync(new URL('../src/manifest.webmanifest', import.meta.url), new URL('../manifest.webmanifest', import.meta.url));
write('.nojekyll', '');
// MapLibre (Korean vector map) is large, so it ships as separate files loaded on demand
mkdirSync(new URL('../vendor/', import.meta.url), { recursive: true });
copyFileSync(new URL('../node_modules/maplibre-gl/dist/maplibre-gl.js', import.meta.url), new URL('../vendor/maplibre-gl.js', import.meta.url));
copyFileSync(new URL('../node_modules/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js', import.meta.url), new URL('../vendor/leaflet-maplibre-gl.js', import.meta.url));
console.log(`built index.html (${(html.length / 1024).toFixed(0)} KB), version ${stamp}`);
