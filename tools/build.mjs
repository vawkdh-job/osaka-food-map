// Builds the deployable site at the repo root:
//   index.html (app + data), sw.js, manifest, vendor/maplibre-gl.{js,css}
// Usage: node tools/build.mjs
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const url = p => new URL('../' + p, import.meta.url);
const read = p => readFileSync(url(p), 'utf8');
const write = (p, s) => writeFileSync(url(p), s);

const data = JSON.parse(read('src/data.json'));
let html = read('src/app.html');
if (!html.includes('/*__DATA__*/')) throw new Error('missing data placeholder');
html = html.split('/*__DATA__*/').join(JSON.stringify(data));

// vendor files (MapLibre GL JS) are served next to index.html and cached by the service worker
mkdirSync(url('vendor/'), { recursive: true });
copyFileSync(url('node_modules/maplibre-gl/dist/maplibre-gl.js'), url('vendor/maplibre-gl.js'));
copyFileSync(url('node_modules/maplibre-gl/dist/maplibre-gl.css'), url('vendor/maplibre-gl.css'));
if (existsSync(url('vendor/leaflet-maplibre-gl.js'))) rmSync(url('vendor/leaflet-maplibre-gl.js'));

const hash = createHash('sha256').update(html).update(read('vendor/maplibre-gl.js')).digest('hex').slice(0, 8);
const stamp = new Date().toISOString().slice(0, 10) + '-' + hash;
html = html.replaceAll('__BUILD__', stamp);
if (/<(script|link)[^>]+(src|href)="https?:/i.test(html)) throw new Error('external script/style found');

write('index.html', html);
write('sw.js', read('src/sw.js').replaceAll('__BUILD__', stamp));
copyFileSync(url('src/manifest.webmanifest'), url('manifest.webmanifest'));
write('.nojekyll', '');
console.log(`built index.html (${(html.length / 1024).toFixed(0)} KB), version ${stamp}`);
