// Stand-in for tiles.openfreemap.org in tests: an OpenMapTiles-like style, TileJSON and vector tiles
// with a few Osaka place labels (some with name:ko, some Japanese only).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const geojsonvt = require('geojson-vt').default || require('geojson-vt');
const vtpbf = require('vt-pbf');

const pt = (lon, lat, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
const line = (coords, props = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props });
const fc = features => ({ type: 'FeatureCollection', features });
const LAYERS = {
  place: fc([
    pt(135.4959, 34.7025, { name: '梅田', 'name:ko': '우메다', 'name:latin': 'Umeda' }),
    pt(135.5010, 34.6660, { name: '難波', 'name:ko': '난바', 'name:latin': 'Namba' }),
    pt(135.5010, 34.6750, { name: '心斎橋', 'name:ko': '신사이바시', 'name:latin': 'Shinsaibashi' }),
    pt(135.4950, 34.6915, { name: '中之島', 'name:ko': '나카노시마', 'name:latin': 'Nakanoshima' }),
    pt(135.4860, 34.6965, { name: '福島', 'name:latin': 'Fukushima' }),
    pt(135.5023, 34.6687, { name: '道頓堀', 'name:ko': '도톤보리', 'name:latin': 'Dotonbori' }),
  ]),
  transportation: fc([
    line([[135.47, 34.70], [135.52, 34.70]]), line([[135.47, 34.68], [135.52, 34.685]]),
    line([[135.495, 34.65], [135.497, 34.72]]), line([[135.50, 34.65], [135.502, 34.72]]),
  ]),
  water: fc([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[135.46, 34.6925], [135.53, 34.6935], [135.53, 34.6905], [135.46, 34.6895], [135.46, 34.6925]]] } }]),
  housenumber: fc([pt(135.4990, 34.6990, { housenumber: '12' })]),
};
const INDEX = Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, new geojsonvt(v, { maxZoom: 14, indexMaxZoom: 4, indexMaxPoints: 0 })]));

export function style(name) {
  return {
    version: 8, name,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': name === 'positron' ? '#fafaf8' : '#f2efe9' } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#a8cde8' } },
      { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#ffffff', 'line-width': 7 } },
      { id: 'place_label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place',
        layout: { 'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': 18 },
        paint: { 'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 2 } },
      { id: 'housenumber', type: 'symbol', source: 'openmaptiles', 'source-layer': 'housenumber',
        layout: { 'text-field': '{housenumber}', 'text-font': ['Noto Sans Regular'] } },
    ],
  };
}
export const tilejson = { tilejson: '3.0.0', tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14,
  attribution: 'test', vector_layers: Object.keys(LAYERS).map(id => ({ id, fields: {} })) };

export function tile(z, x, y) {
  const layers = {};
  for (const [k, idx] of Object.entries(INDEX)) { const t = idx.getTile(z, x, y); if (t) layers[k] = t; }
  return Buffer.from(Object.keys(layers).length ? vtpbf.fromGeojsonVt(layers, { version: 2 }) : new Uint8Array(0));
}

// route handler for Playwright: mode 'ok' | 'fail' | delay in ms
export function routeOFM(mode = 'ok', counter) {
  return async route => {
    counter && counter.n++;
    if (mode === 'fail') return route.abort('connectionrefused');
    if (typeof mode === 'number') await new Promise(r => setTimeout(r, mode));
    const u = new URL(route.request().url());
    const cors = { 'access-control-allow-origin': '*' };
    let m;
    try {
      if ((m = u.pathname.match(/^\/styles\/(\w+)/))) return await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(style(m[1])) });
      if (u.pathname === '/planet') return await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(tilejson) });
      if ((m = u.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/)) && u.pathname.startsWith('/planet/')) return await route.fulfill({ status: 200, contentType: 'application/x-protobuf', headers: cors, body: tile(+m[1], +m[2], +m[3]) });
      return await route.fulfill({ status: 404, headers: cors, body: '' }); // fonts, sprites
    } catch {}
  };
}
