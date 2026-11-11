// End-to-end checks in headless Chromium on phone viewports.
// Real tile servers are not reachable from the build machine, so tiles are synthetic (page.route).
// Usage: node tests/e2e.mjs [screenshot-dir]
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'; // let page.route see service-worker fetches
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import { routeOFM } from './mock-vector.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = process.argv[2] || join(ROOT, 'tests', 'shots');
mkdirSync(SHOTS, { recursive: true });

// ---------- static server (localhost counts as a secure context, like https) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL0 = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
let failures = 0;
const check = (ok, msg, extra = '') => { console.log(`${ok ? '  ✓' : '  ✗'} ${msg}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

// ---------- synthetic map tiles that look roughly like a street map ----------
const tilePage = await browser.newPage();
async function makeTile(size, label) {
  const b64 = await tilePage.evaluate(({ size, label }) => {
    const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'), s = size / 256;
    g.fillStyle = '#f3f0ea'; g.fillRect(0, 0, size, size);
    g.fillStyle = '#e4ecd9'; g.fillRect(150 * s, 20 * s, 70 * s, 50 * s);
    g.strokeStyle = '#ffffff'; g.lineWidth = 9 * s; g.beginPath(); g.moveTo(0, 90 * s); g.lineTo(256 * s, 110 * s); g.moveTo(80 * s, 0); g.lineTo(100 * s, 256 * s); g.stroke();
    g.strokeStyle = '#f6d48b'; g.lineWidth = 6 * s; g.beginPath(); g.moveTo(0, 200 * s); g.lineTo(256 * s, 180 * s); g.stroke();
    g.strokeStyle = '#d6dde0'; g.lineWidth = 1; g.strokeRect(0, 0, size, size);
    g.fillStyle = '#9aa7ab'; g.font = `${11 * s}px sans-serif`; g.fillText(label, 8 * s, 18 * s);
    return c.toDataURL('image/png').split(',')[1];
  }, { size, label });
  return Buffer.from(b64, 'base64');
}
const TILE = { gsi: await makeTile(256, 'gsi'), osm: await makeTile(256, 'osm'), esri: await makeTile(256, 'esri') };

async function newPhone(opts = {}) {
  const ctx = await browser.newContext({ ...(opts.device || devices['iPhone 13']), serviceWorkers: opts.sw ? 'allow' : 'block',
    locale: 'ko-KR', timezoneId: opts.tz || 'Asia/Seoul', ...(opts.geo ? { geolocation: opts.geo, permissions: ['geolocation'] } : {}) });
  const page = await ctx.newPage();
  const log = { errors: [], tiles: { gsi: 0, osm: 0, esri: 0, carto: 0 }, ofm: { n: 0 } };
  page.on('pageerror', e => log.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) log.errors.push(m.text()); });
  const t = opts.tiles || {};
  await ctx.route('**/*.basemaps.cartocdn.com/**', r => { log.tiles.carto++; r.abort(); });
  await ctx.route('https://tiles.openfreemap.org/**', routeOFM((opts.tiles || {}).ofm || 'ok', log.ofm));
  for (const [key, pat] of [['gsi', '**/cyberjapandata.gsi.go.jp/**'], ['osm', '**/tile.openstreetmap.org/**'], ['esri', '**/server.arcgisonline.com/**']]) {
    await ctx.route(pat, async route => {
      log.tiles[key]++;
      const mode = t[key] || 'ok';
      if (mode === 'fail') return route.abort('connectionrefused');
      if (typeof mode === 'number') await new Promise(r => setTimeout(r, mode));
      try { await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE[key] }); } catch {}
    });
  }
  await ctx.route(/^https?:\/\/(?!localhost)(?!.*(cartocdn|gsi\.go\.jp|openstreetmap|arcgisonline|openfreemap))/, r => r.abort()); // photos etc.
  // Google Maps: blocked by default (exercises the MapLibre fallback); 'authfail' stubs a rejected key; 'real' lets it through
  const gmode = opts.google || 'block';
  log.google = { n: 0 };
  await ctx.route(/^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|gstatic\.com|google\.com|ggpht\.com)\//, async route => {
    log.google.n++;
    if (gmode === 'real') return route.continue().catch(() => {});
    if (gmode === 'authfail' && route.request().url().includes('/maps/api/js'))
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'setTimeout(()=>window.gm_authFailure&&window.gm_authFailure(),50);' });
    return route.abort('connectionrefused');
  });
  if (opts.clock) await page.clock.setFixedTime(new Date(opts.clock));
  return { ctx, page, log };
}
const ready = page => page.waitForFunction(() => window.__ofm && window.__ofm.ready(), null, { timeout: 20000 }).catch(() => {});
const appState = page => page.evaluate(() => { const a = window.__ofm; return { sort: a.S.sort, ref: a.S.ref, day: a.S.day, view: a.S.view, provider: a.provider(),
  rows: a.rows().filter(x => x.r).map(x => ({ id: x.r.id, region: x.r.region, d: x.d })), me: a.me(), sheet: a.sheetPx() }; });
const visibleIcons = page => page.evaluate(() => [...document.querySelectorAll('.mk .pin, .mk .cl')].length);

// ======================================================================
console.log('1. iPhone 13 · first open, no location permission');
{
  const { ctx, page, log } = await newPhone();
  await page.goto(URL0); await ready(page); await page.waitForTimeout(800);
  const st = await appState(page);
  const exp = await page.evaluate(() => { const d = APP_DATA.restaurants.filter(r => r.lat != null && window.__ofm.visible(r)); const top = d.filter(r => r.tabelog != null).sort((a, b) => b.tabelog - a.tabelog)[0]; return { n: d.length, top: top.name, topT: top.tabelog.toFixed(2) }; });
  check(st.rows.length === exp.n && exp.n >= 60, `all ${exp.n} shown restaurants listed (top 10 per food type + saved)`, String(st.rows.length));
  check(st.sort === 'tabelog' && st.ref === 'hotel', 'default sort Tabelog, distance from hotel');
  const counts = await page.evaluate(() => { let n = 0; document.querySelectorAll('.mk .pin').forEach(() => n++);
    document.querySelectorAll('.mk .cl b').forEach(b => n += parseInt(b.textContent)); return n; });
  check(counts === exp.n, 'pins + cluster members account for every restaurant', String(counts));
  const first = await page.locator('.item').first().innerText();
  check(first.includes(exp.top) && first.includes(exp.topT), `top item is highest Tabelog (${exp.top} ${exp.topT})`, first.split('\n')[0]);
  const pinText = await page.evaluate(() => [...document.querySelectorAll('.mk .pin b, .mk .cl small')].map(e => e.textContent).join(' | '));
  check(/\d\.\d\d/.test(pinText), 'pins / groups show Tabelog scores', pinText.slice(0, 60));
  const ui = await page.evaluate(() => { const H = innerHeight, top = document.querySelector('#topbar').getBoundingClientRect().bottom, sh = document.querySelector('#sheet').getBoundingClientRect().top;
    return { mapVisiblePct: Math.round((sh - top) / H * 100), searchFont: getComputedStyle(document.querySelector('#q')).fontSize }; });
  check(ui.mapVisiblePct >= 55, 'map has ≥55% of the screen free with sheet collapsed', ui.mapVisiblePct + '%');
  check(ui.searchFont === '16px', 'search box 16px (no iOS zoom on focus)');
  check((await appState(page)).provider === 'ko' && log.ofm.n > 0 && log.tiles.gsi === 0 && log.tiles.carto === 0, 'Korean vector map loads (no fallback, no CARTO)', `ofm=${log.ofm.n} ${JSON.stringify(log.tiles)}`);
  const tf = await page.evaluate(() => { const st = window.__ofm.glStyle(); return st && Object.fromEntries(st.layers.filter(l => l.layout && l.layout['text-field']).map(l => [l.id, JSON.stringify(l.layout['text-field'])])); });
  check(tf && tf.place_label === '["coalesce",["get","name:ko"],["get","name"]]' && tf.housenumber === '"{housenumber}"', 'labels use name:ko → Japanese fallback; house numbers untouched', JSON.stringify(tf));
  check((await page.evaluate(() => window.__ofm.tiles().ok)) > 0, 'vector tiles rendered');
  check(tf && tf.poi_transit && tf.poi_transit.includes('format') && tf.poi_transit.includes('name:ko'), 'station labels: Korean with Japanese underneath', tf && tf.poi_transit);
  const poiVis = await page.evaluate(() => { const st = window.__ofm.glStyle(); const v = id => (st.layers.find(l => l.id === id).layout || {}).visibility || 'visible'; return { shop: v('poi_r1'), transit: v('poi_transit') }; });
  check(poiVis.shop === 'none' && poiVis.transit === 'visible', 'shop icons hidden, stations kept', JSON.stringify(poiVis));
  const align = await page.evaluate(() => { const a = window.__ofm, m = a.map(); const out = [];
    for (const [id, p] of a.markers) { if (!p.on) continue; const r = p.el.getBoundingClientRect(), q = m.project([p.r.lon, p.r.lat]), c = m.getContainer().getBoundingClientRect();
      out.push(Math.hypot(r.left - c.left - q.x - (p.m.getOffset().x || 0), r.top - c.top - q.y)); } return { n: out.length, max: Math.max(0, ...out) }; });
  check(align.n > 0 && align.max < 1.5, 'pins sit exactly on their coordinates', JSON.stringify(align));
  const pad = await page.evaluate(() => window.__ofm.map().getPadding());
  check(pad.top === 0 && pad.bottom === 0, 'camera padding not left behind by fitBounds', JSON.stringify(pad));
  const notes = await page.evaluate(() => ({ toasts: window.__ofm.toasts.slice(), engine: window.__ofm.engine(), why: window.__ofm.gmFail() }));
  check(notes.engine === 'ml' && notes.why === 'load' && notes.toasts.some(t => t.includes('구글 지도를 불러오지 못해')), 'Google blocked → falls back to MapLibre with a notice', JSON.stringify({ e: notes.engine, why: notes.why }));
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(SHOTS, '01_iphone_first_open.png') });
  // pinch zoom with two fingers
  const z0 = await page.evaluate(() => window.__ofm.map().getZoom());
  const cdp = await ctx.newCDPSession(page);
  const pts = (d) => [{ x: 195 - d, y: 330, id: 1 }, { x: 195 + d, y: 330, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(30) });
  for (let d = 30; d <= 130; d += 10) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(800);
  const z1 = await page.evaluate(() => window.__ofm.map().getZoom());
  check(z1 > z0, 'two-finger pinch zooms the map', `${z0} → ${z1}`);
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('2. Location granted, standing at Dotonbori');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 25 } });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const st = await appState(page);
  check(!!st.me, 'location acquired automatically (permission already granted)');
  check(st.ref === 'me' && st.sort === 'nearby', 'switched to “near me, by rating”', `${st.ref}/${st.sort}`);
  const nearTop = st.rows.slice(0, 8);
  check(nearTop.every(r => r.region === 'south'), 'top 8 are all Namba/Shinsaibashi');
  check(nearTop.every(r => r.d < 1.2), 'top 8 within ~20 min walk', nearTop.map(r => r.d.toFixed(2)).join(','));
  const scores = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).slice(0, 6).map(x => x.r.tabelog));
  check(scores.every((v, i) => i === 0 || v <= scores[i - 1]), 'nearby group sorted by Tabelog', scores.join(','));
  check(await page.locator('.meWrap .me').count() === 1, 'blue “me” dot on map');
  check(await page.locator('#locBtn.follow, #locBtn.on').count() === 1, 'location button shows active');
  const head = await page.locator('.item').first().innerText();
  check(/도보 \d+분/.test(head), 'list shows walking minutes', head.split('\n').find(l => l.includes('도보')));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(SHOTS, '02_iphone_near_me_dotonbori.png') });
  // select first item → detail; pin must be visible between top bar and sheet
  await page.locator('.item').first().click(); await page.waitForTimeout(1200);
  const vis = await page.evaluate(() => { const p = document.querySelector('.pin.sel'); if (!p) return null; const r = p.getBoundingClientRect();
    return { y: r.bottom, top: document.querySelector('#topbar').getBoundingClientRect().bottom, sheet: document.querySelector('#sheet').getBoundingClientRect().top }; });
  check(vis && vis.y > vis.top && vis.y < vis.sheet, 'selected pin visible above the sheet', JSON.stringify(vis));
  const dir = await page.locator('#detail .btn.primary').getAttribute('href');
  check(dir.includes('/maps/dir/') && !dir.includes('origin='), 'directions start from current location (no origin)');
  check(dir.includes('travelmode=walking'), 'walking mode for a nearby place');
  check(dir.includes('destination_place_id='), 'directions carry the Google place id');
  await page.locator('#crowdBtn').click(); await page.waitForTimeout(200);
  const alts = await page.evaluate(() => [...document.querySelectorAll('#alts .alt')].map(b => b.innerText.split('\n')[0]));
  check(alts.length >= 3, '“줄이 길어요” shows nearby alternatives', alts.slice(0, 3).join(' / '));
  await page.screenshot({ path: join(SHOTS, '03b_iphone_alternatives.png') });
  const links = await page.evaluate(() => [...document.querySelectorAll('#detail .links a')].map(a => a.textContent));
  check(links.some(t => t.includes('유튜브')) && links.some(t => t.includes('네이버')), 'YouTube and Naver blog links', links.join(' | '));
  await page.locator('#phraseBtn2').click(); await page.locator('.phr').first().click();
  check(await page.locator('#phraseBig').isVisible() && (await page.locator('#phraseBig').innerText()).includes('6人です'), 'phrase card shows large Japanese text');
  await page.locator('#phraseBig').click(); await page.locator('#phrases [data-close]').click();
  await page.screenshot({ path: join(SHOTS, '03_iphone_detail.png') });
  await page.goBack(); await page.waitForTimeout(300);
  check((await appState(page)).view === 'list', 'phone back button returns to list');
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('2b. GPS fix arriving right after start-up: the first near-me list already counts from my location');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const near = () => page.evaluate(() => { const O = window.__ofm, R = O.rows().filter(x => x.r); return { ref: O.S.ref, total: R.length, near: R.filter(x => Math.max(1, Math.round(x.d * 1.3 / 4.5 * 60)) <= 20).length, hint: (document.querySelector('#list .hint') || {}).textContent }; });
  const a = await near();
  await page.evaluate(() => window.__ofm.refresh()); await page.waitForTimeout(300);
  const b = await near();
  check(a.ref === 'me' && a.near === b.near && a.total === b.total && a.near >= 100 && a.hint.includes(`${a.near}곳`), 'Dotonbori, instant fix: the first list has the same near-me set as a forced refresh (not the hotel’s)', JSON.stringify([a.total, a.near, b.total, b.near]));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('2c. An open shop page survives the minute tick and walking (only status and distance update)');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__ofm.select(window.__ofm.rows().find(x => x.r).r.id)); await page.waitForTimeout(800);
  await page.locator('#crowdBtn').click(); await page.waitForTimeout(300);
  await page.evaluate(() => { window.__ofm.setSheet('full'); document.querySelector('#photos').insertAdjacentHTML('afterbegin', '<a class="ph" data-g id="fakeG"><small>Google 사진</small></a>'); window.__alts = document.querySelector('#alts'); }); await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelector('#sheetBody').scrollTop = 220; });
  const before = await page.evaluate(() => ({ dist: document.querySelector('.dDist').textContent, top: document.querySelector('#sheetBody').scrollTop }));
  await page.evaluate(() => window.__ofm.minuteTick()); await page.waitForTimeout(300);
  await ctx.setGeolocation({ latitude: 34.6705, longitude: 135.5013, accuracy: 20 }); await page.waitForTimeout(2500);   // ~200 m north
  const after = await page.evaluate(() => ({ alts: !document.querySelector('#alts').hidden && document.querySelector('#alts') === window.__alts && document.querySelectorAll('#alts .alt').length, photo: !!document.querySelector('#fakeG'), top: document.querySelector('#sheetBody').scrollTop, dist: document.querySelector('.dDist').textContent, view: window.__ofm.S.view }));
  check(after.view === 'detail' && after.alts > 0 && after.photo && Math.abs(after.top - before.top) < 2 && after.dist !== before.dist, 'minute tick + walking 200 m: the 줄이 길어요 panel, photo and scroll position stay; the distance updates', JSON.stringify({ before, after }));
  await page.locator('.round.fav').click(); await page.waitForTimeout(300);
  check(await page.evaluate(() => !document.querySelector('#fakeG')), 'a user action (찜) still re-renders the shop page');
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('2d. Directions: walking or transit from where the phone is, not from the picked place');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__ofm.setPlace(window.__ofm.placeHits('오사카성')[0])); await page.waitForTimeout(600);
  const far = await page.evaluate(() => { const O = window.__ofm, x = O.rows().find(x => x.r && x.d < 1.0); O.select(x.r.id); return x.r.name; }); await page.waitForTimeout(500);   // near the castle, ~3 km from me
  const a = await page.evaluate(() => ({ href: document.querySelector('#detail .ab.primary').href, dist: document.querySelector('.dDist').textContent }));
  await page.evaluate(() => window.__ofm.closeDetail());
  const b = await page.evaluate(() => { const O = window.__ofm, me = O.me(), r = APP_DATA.restaurants.find(r => r.lat != null && Math.hypot(r.lat - me.lat, (r.lon - me.lon) * 0.82) * 111 < 0.4); O.select(r.id); return new Promise(res => setTimeout(() => res({ name: r.name, href: document.querySelector('#detail .ab.primary').href }), 400)); });
  check(/travelmode=transit/.test(a.href) && /travelmode=walking/.test(b.href), 'directions: transit to a shop near the picked place but 3 km from me; walking to one next to me', JSON.stringify({ far, a: a.href.split('travelmode=')[1], dist: a.dist, near: b.name, b: b.href.split('travelmode=')[1] }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('2e. 🌙 late filter, 줄이 길어요 keeps filters, no double-tap zoom on buttons');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T19:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  await page.locator('#filterChip').click(); await page.locator('[data-f="late"]').check(); await page.waitForTimeout(200);
  const late = await page.evaluate(() => { const O = window.__ofm, t = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; }, R = O.rows().filter(x => x.r);
    const at22 = APP_DATA.restaurants.filter(r => Array.isArray(r.hours.fri) && r.hours.fri.length && Math.max(...r.hours.fri.map(([, b]) => t(b))) === 22 * 60).map(r => r.id);
    return { n: R.length, ok: R.every(x => x.r.hours.fri.some(([, b]) => t(b) >= 22 * 60 + 30)), at22: at22.length, at22shown: R.filter(x => at22.includes(x.r.id)).length, label: [...document.querySelectorAll('#filterBody .fchk')].map(e => e.innerText).find(t => /🌙/.test(t)) }; });
  check(late.n > 0 && late.ok && late.at22 > 0 && late.at22shown === 0 && /밤 10시 넘어서도 영업/.test(late.label), '🌙 filter: only places open until 22:30 or later (closing at 22:00 is not “after 10 pm”)', JSON.stringify(late));
  await page.locator('#filterReset').click(); await page.locator('[data-f="card"]').check(); await page.locator('#filterApply').click(); await page.waitForTimeout(200);
  await page.locator('#genreChip').click(); await page.locator('#genreGrid [data-genre="ramen"]').click(); await page.waitForTimeout(400);
  await page.evaluate(() => window.__ofm.select(window.__ofm.rows().find(x => x.r).r.id)); await page.waitForTimeout(500);
  await page.locator('#crowdBtn').click(); await page.waitForTimeout(300);
  const other = await page.evaluate(() => { const O = window.__ofm, inRows = new Set(O.rows().filter(x => x.r).map(x => x.r.id)); const b = [...document.querySelectorAll('#alts .alt')].find(e => !inRows.has(+e.dataset.go)); if (!b) return null; const id = +b.dataset.go; b.click(); return id; });
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => ({ sel: window.__ofm.S.selected, view: window.__ofm.S.view, card: window.__ofm.S.f.card, genre: window.__ofm.S.genre }));
  check(other != null && st.sel === other && st.view === 'detail' && st.card === true && st.genre === 'ramen', '줄이 길어요 → an alternative outside the current list opens it and keeps the filters and menu', JSON.stringify({ other, ...st }));
  const ta = await page.evaluate(() => ['#openChip', '#locBtn', '#detail .ab.primary', '#handle'].map(s => getComputedStyle(document.querySelector(s)).touchAction));
  check(ta.slice(0, 3).every(t => t === 'manipulation') && ta[3] === 'none', 'buttons, links and chips: touch-action manipulation (no double-tap zoom); the drag handle keeps none', ta.join(','));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('3. Location in Seoul (testing before the trip)');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 37.5665, longitude: 126.978, accuracy: 30 } });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1200);
  const st = await appState(page);
  check(!!st.me && st.ref === 'hotel', 'location shown but distances stay hotel-based');
  check((await page.evaluate(() => window.__ofm.toasts.join(' | '))).includes('오사카에서 약'), 'explains it will switch once in Osaka');
  check(await page.evaluate(() => window.__ofm.sheetState()) === 'peek', 'a fix outside Osaka leaves the list folded (peek)');
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('4. Location permission denied');
{
  const { ctx, page } = await newPhone();
  await ctx.clearPermissions();
  await page.goto(URL0); await page.waitForTimeout(800);
  await page.evaluate(() => { navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1, message: 'denied' }), 50); return 1; }; });
  await page.locator('#locBtn').click(); await page.waitForTimeout(400);
  check(await page.locator('#locHelp').isVisible(), 'help sheet with iPhone/Android steps opens');
  await page.screenshot({ path: join(SHOTS, '04_iphone_location_help.png') });
  await ctx.close();
}

console.log('5. Bottom sheet drag and filters');
{
  const { ctx, page } = await newPhone();
  await page.goto(URL0); await page.waitForTimeout(800);
  const h0 = (await appState(page)).sheet;
  const box = await page.locator('.handle').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 2); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 20, box.y + 2 - i * 45);
  await page.mouse.up(); await page.waitForTimeout(400);
  const h1 = (await appState(page)).sheet;
  check(h1 > h0 + 200, 'dragging the handle up expands the sheet', `${h0} → ${h1}px`);
  { // finger drags: on the 정렬 menu, on the list itself, and pulling a full list down from the top
    const cdp = await page.context().newCDPSession(page), H = await page.evaluate(() => innerHeight);
    const t = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const fdrag = async (x, y0, y1) => { await t('touchStart', x, y0); for (let i = 1; i <= 12; i++) { await t('touchMove', x, y0 + (y1 - y0) * i / 12); await page.waitForTimeout(16); } await t('touchEnd'); await page.waitForTimeout(450); };
    const sh = () => page.evaluate(() => document.querySelector('#sheet').dataset.state);
    await page.evaluate(() => window.__ofm.setSheet('peek')); await page.waitForTimeout(400);
    const so = await page.locator('#sortText').boundingBox(); await fdrag(so.x + so.width / 2, so.y + so.height / 2, 150); const a = await sh();
    const so2 = await page.locator('#sortText').boundingBox(); await fdrag(so2.x + so2.width / 2, so2.y + so2.height / 2, H - 100); const b = await sh();
    const bd = await page.locator('#sheetBody').boundingBox(); await fdrag(200, bd.y + 50, 140); const c = await sh();
    await page.locator('#sheetBody').evaluate(e => e.scrollTop = 0); const bd2 = await page.locator('#sheetBody').boundingBox(); await fdrag(200, bd2.y + 40, bd2.y + 380); const d = await sh();
    check(a === 'full' && b === 'peek' && c === 'full' && d !== 'full', 'finger drags move the sheet (on the menus, on the list, pull-down from the top)', [a, b, c, d].join(' → '));
    await cdp.detach();
  }
  await page.locator('#filterChip').click(); await page.locator('[data-mint="3.7"]').click(); await page.waitForTimeout(150);
  const applyTxt = await page.locator('#filterApply').innerText();
  await page.locator('#filterApply').click(); await page.waitForTimeout(200);
  const st = await appState(page);
  const ok = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).every(x => x.r.tabelog >= 3.7));
  check(ok && st.rows.length > 0 && applyTxt.includes(String(st.rows.length)), 'Tabelog 3.7+ filter (count shown on the button)', `${st.rows.length} left, button "${applyTxt}"`);
  check((await page.locator('#filterChip').innerText()).includes('1'), 'filter chip shows the number of active filters');
  await page.locator('#genreChip').click(); await page.locator('[data-genre="udon"]').click(); await page.waitForTimeout(200);
  const kinds = await page.evaluate(() => [...new Set(window.__ofm.rows().filter(x => x.r).map(x => x.r.genre))]);
  check(kinds.length === 1 && kinds[0] === '우동', '“뭐 먹지?” picker → udon only', kinds.join(','));
  check((await page.locator('#catBar .cat.on').innerText()).includes('우동'), 'the picked menu shows in the food-type strip');
  await page.locator('#catBar .cat.on').click(); await page.waitForTimeout(200);   // ✕ clears it
  await page.locator('#catBar [data-cat="c-noodle"]').click(); await page.waitForTimeout(200);
  const noodle = await page.evaluate(() => { const R = window.__ofm.rows().filter(x => x.r);
    return { n: R.length, all: R.every(x => window.__ofm.catsOf(x.r).includes('c-noodle')), g: [...new Set(R.map(x => x.r.genre))] }; });
  check(noodle.n > 0 && noodle.all && noodle.g.length >= 2, 'food-type strip → 면요리 groups several menus', `${noodle.n}: ${noodle.g.join(',')}`);
  await page.locator('#catBar [data-cat="c-noodle"]').click(); await page.waitForTimeout(200);
  check(await page.evaluate(() => window.__ofm.S.genre === 'all'), 'tapping the selected food type again clears it');
  const untyped = await page.evaluate(() => APP_DATA.restaurants.filter(r => !window.__ofm.allCats(r).length).map(r => r.name));
  check(untyped.length === 0, 'every shop belongs to at least one food type', untyped.join(','));
  // beyond walking distance each food type shows only its 10 best-rated shops; within 20 min everything shows
  const perCat = await page.evaluate(() => { const O = window.__ofm, D = APP_DATA.restaurants.filter(r => r.lat != null);
    return O.CATS.map(c => { const inT = D.filter(r => O.allCats(r).includes(c.key)), shown = inT.filter(r => O.inScope(r, c.key));
      return { far: shown.filter(r => !O.nearRef(r) && !O.fav.has(r.id) && !O.tripShopIds().has(r.id)).length, near: inT.filter(r => O.nearRef(r)).length, nearShown: shown.filter(r => O.nearRef(r)).length }; }); });
  check(perCat.every(x => x.far <= 10 && x.near === x.nearShown), 'food types: every shop within a 20-min walk + at most 10 best-rated farther away (+ our itinerary’s restaurants)', perCat.map(x => `${x.nearShown}+${x.far}`).join(','));
  // expand to every shop and back
  await page.locator('#filterChip').click(); await page.locator('#filterReset').click(); await page.locator('#filterApply').click(); await page.waitForTimeout(200);
  const shown0 = (await appState(page)).rows.length;
  check(await page.evaluate(() => { window.__ofm.setSheet('half'); const h = document.querySelector('#list .hint.soft'); return !h || getComputedStyle(h).display === 'none'; }), 'half sheet keeps the explanatory lines out of the way (they show when the list is fully open)');
  await page.evaluate(() => window.__ofm.setSheet('full')); await page.waitForTimeout(300);
  await page.locator('#list .linkBtn[data-expand="1"]').click(); await page.waitForTimeout(300);
  const all = await page.evaluate(() => ({ rows: window.__ofm.rows().filter(x => x.r).length, total: APP_DATA.restaurants.filter(r => r.lat != null).length }));
  check(all.rows === all.total && all.rows > shown0, '“모두 보기” shows every researched shop', `${shown0} → ${all.rows} of ${all.total}`);
  await page.locator('#list .linkBtn[data-expand="0"]').click(); await page.waitForTimeout(300);
  check((await appState(page)).rows.length === shown0, '“상위만 보기” goes back to the top-10 view');
  const hiddenOne = await page.evaluate(() => APP_DATA.restaurants.find(r => !window.__ofm.visible(r)).jp);
  await page.locator('#q').fill(hiddenOne.split(' ')[0]); await page.waitForTimeout(400);
  const found = await page.evaluate(n => window.__ofm.rows().some(x => x.r && x.r.jp === n), hiddenOne);
  check(found, 'search also finds hidden shops', hiddenOne);
  await page.locator('#q').fill(''); await page.waitForTimeout(300);
  await page.locator('#filterChip').click(); await page.locator('#filterReset').click(); await page.locator('[data-f="card"]').check(); await page.waitForTimeout(150);
  const cards = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).every(x => x.r.pay.card === true));
  check(cards, 'card-payment filter keeps only card-OK shops');
  await page.locator('#filterReset').click(); await page.locator('#filterApply').click();
  await page.locator('#listSel').selectOption('hyaku'); await page.waitForTimeout(200);
  const hy = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).map(x => x.r.hyakumeiten.length > 0));
  check(hy.length > 20 && hy.length <= 100 && hy.every(Boolean), '百名店 list (≤100, all with a badge)', hy.length + ' shops');
  await page.locator('#listSel').selectOption('top'); await page.waitForTimeout(200);
  const top = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).map(x => x.r.tabelog));
  check(top.length === 100 && top.every((v, i) => i === 0 || v <= top[i - 1]), 'Tabelog TOP 100 list, sorted', top.length + ' shops, last ' + top[top.length - 1]);
  await page.locator('#listSel').selectOption('all');
  await page.locator('#sort').selectOption('hyaku'); await page.waitForTimeout(200);
  const hk = await page.evaluate(() => { const R = window.__ofm.rows(), i = R.findIndex(x => x.divider), yes = (i < 0 ? R : R.slice(0, i)).map(x => x.r);
    const key = r => [r.hyakumeiten.length, Math.max(...r.hyakumeiten.map(h => h.year || 0))];
    return { n: yes.length, allHy: yes.every(r => r.hyakumeiten.length > 0), ordered: yes.every((r, j) => !j || key(yes[j - 1])[0] > key(r)[0] || (key(yes[j - 1])[0] === key(r)[0] && key(yes[j - 1])[1] >= key(r)[1])),
      after: i < 0 || R.slice(i + 1).every(x => !x.r.hyakumeiten.length) }; });
  check(hk.n > 0 && hk.allHy && hk.ordered && hk.after, '백명점순: 百名店 shops first, most selections/latest year first', JSON.stringify(hk));
  await page.locator('#sort').selectOption('google'); await page.waitForTimeout(200);
  check(/구글 평점은 실시간|구글에 연결되지 않아/.test(await page.locator('#list').innerText()), '구글 평점순 explains how ratings load (or that Google is unreachable)');
  await page.locator('#sort').selectOption('tabelog'); await page.waitForTimeout(200);
  await page.screenshot({ path: join(SHOTS, '05_iphone_sheet_full_filtered.png') });
  await ctx.close();
}

console.log('5b. Sheet: the grab handle is a real tap target, and the list opens once my location is found');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T12:10:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(800);
  const st = () => page.evaluate(() => ({ sheet: window.__ofm.sheetState(), mode: window.__ofm.S.mode }));
  const top = await page.evaluate(() => document.querySelector('#sheet').getBoundingClientRect().top);
  const hb = await page.locator('#handle').boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const tap = async (x, y, r = 12) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: r, radiusY: r }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(450); return st(page); };
  const res = [];
  for (const dy of [-12, 2, 10, 16, 22, 26]) for (const r of [0, 12]) {   // finger taps on and just around the handle, with and without a touch radius
    const a = await tap(195, top + dy, r); res.push(`${dy}/${r}:${a.sheet}/${a.mode}`);
    if (a.mode !== 'shops') await page.evaluate(() => window.__ofm.exitTrip(true));
    await page.evaluate(() => window.__ofm.setSheet('peek')); await page.waitForTimeout(350);
  }
  check(hb.height >= 28 && res.every(x => /half\/shops/.test(x)), 'taps from 12px above to 26px below the sheet top open the list — not the 🧳 next-stop line', res.join(' '));
  await tap(195, top + 10); const top2 = await page.evaluate(() => document.querySelector('#sheet').getBoundingClientRect().top);
  check((await tap(195, top2 + 10)).sheet === 'peek', 'tapping the handle again folds the list back down');
  const tl = await page.evaluate(() => { const b = document.querySelector('#tripLine').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, h: b.height }; });
  const t = await tap(tl.x, tl.y);
  check(t.mode === 'trip' && tl.h >= 44, 'the 🧳 next-stop line itself still opens the itinerary', JSON.stringify({ ...t, h: tl.h }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await cdp.detach(); await ctx.close();
}
{
  const { ctx, page } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  check(await page.evaluate(() => window.__ofm.sheetState()) === 'half', 'first location fix in Osaka opens the list to half');
  await ctx.close();
}
{
  const { ctx, page } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await ctx.addInitScript(() => { const g = navigator.geolocation, w = g.watchPosition.bind(g); g.watchPosition = (ok, err, o) => w(p => setTimeout(() => ok(p), 2500), err, o); });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(300);
  await page.locator('#handle').click(); await page.waitForTimeout(350); await page.locator('#handle').click(); await page.waitForTimeout(350);
  const a = await page.evaluate(() => window.__ofm.sheetState()); await page.waitForTimeout(3000);
  const b = await page.evaluate(() => ({ sheet: window.__ofm.sheetState(), me: !!window.__ofm.me() }));
  check(a === 'peek' && b.me && b.sheet === 'peek', 'a list the user folded away stays folded when the fix arrives later', JSON.stringify([a, b]));
  await ctx.close();
}

console.log('5c. Poor location fixes (> 500 m): warn, keep the previous position, never open the sheet (A2-6)');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 800 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const st = () => page.evaluate(() => ({ ref: window.__ofm.S.ref, sheet: window.__ofm.sheetState(), me: window.__ofm.me() && [window.__ofm.me().lat, window.__ofm.me().acc], hint: [...document.querySelectorAll('#list .hint')].map(e => e.textContent).join(' | ').slice(0, 60) }));
  const a = await st();
  check(a.ref === 'me' && a.sheet === 'peek' && /위치 부정확\(약 800m\)/.test(a.hint), 'first fix with 800 m accuracy: used, the list says “위치 부정확(약 800m)”, the sheet is not opened', JSON.stringify(a));
  await ctx.setGeolocation({ latitude: 34.7025, longitude: 135.4959, accuracy: 1200 }); await page.waitForTimeout(1500);   // a 1.2 km-wide fix in Umeda, 4 km away (out of the subway)
  const a2 = await st();
  check(a2.me[0] === 34.7025 && a2.me[1] === 1200 && /위치 부정확\(약 1200m\)/.test(a2.hint) && a2.sheet === 'peek', 'a poor fix that is clearly somewhere else (4 km on) replaces the old position, keeps the warning, and still does not open the sheet', JSON.stringify(a2));
  await ctx.setGeolocation({ latitude: 34.7030, longitude: 135.4965, accuracy: 900 }); await page.waitForTimeout(1500);
  const a3 = await st();
  check(a3.me[1] === 900 && a3.sheet === 'peek', 'a less poor fix replaces a poorer one (sheet still closed)', JSON.stringify(a3));
  await ctx.setGeolocation({ latitude: 34.7028, longitude: 135.4962, accuracy: 20 }); await page.waitForTimeout(1500);
  const b = await st();
  check(b.sheet === 'half' && b.me[1] === 20 && !/부정확/.test(b.hint), 'then a good fix: the list opens and the warning goes', JSON.stringify(b));
  await ctx.setGeolocation({ latitude: 34.7100, longitude: 135.4962, accuracy: 1200 }); await page.waitForTimeout(1500);   // a 1.2 km-wide fix 0.8 km away: it still agrees with the good position
  const c = await st();
  check(c.me[0] === b.me[0] && c.me[1] === 20, 'a later fix worse than 500 m that agrees with the good position is ignored: the good position stays the reference', JSON.stringify(c));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6. Sunday 11/15 12:00 in Japan (live opening hours)');
{
  const { ctx, page } = await newPhone({ clock: '2026-11-15T12:00:00+09:00' });
  await page.goto(URL0); await page.waitForTimeout(1000);
  const st = await appState(page);
  check(st.day === 'sun', 'day defaults to today (Sun) in Japan time even with a Seoul-time phone');
  check((await page.locator('#openChip').innerText()).includes('영업 중'), 'chip becomes “open now”');
  // example shops taken from the map itself (the curated list changes as data is added)
  const ex = await page.evaluate(() => { const D = APP_DATA.restaurants, sun = r => r.hours && r.hours.sun, k = r => window.__ofm.status(r, 'sun').kind;
    const closed = D.filter(r => Array.isArray(sun(r)) && sun(r).length === 0).slice(0, 3), later = D.find(r => sun(r) && sun(r).length && sun(r)[0][0] >= '14:00'),
      open = D.find(r => sun(r) && sun(r).some(([a, b]) => a <= '11:00' && b >= '15:00'));
    return { closed: closed.map(r => [r.id, k(r)]), later: [later.id, k(later)], open: [open.id, k(open)] }; });
  check(ex.closed.length === 3 && ex.closed.every(x => x[1] === 'closed'), 'Sunday closures', JSON.stringify(ex.closed));
  check(ex.later[1] === 'later' && ex.open[1] === 'open', 'opens-later and open-now states', JSON.stringify([ex.later, ex.open]));
  await page.locator('#openChip').click(); await page.waitForTimeout(200);
  const ids = (await appState(page)).rows.map(r => r.id);
  check(![...ex.closed.map(x => x[0]), ex.later[0]].some(i => ids.includes(i)) && ids.includes(ex.open[0]), '“open now” filter hides closed shops', ids.length + ' open');
  await page.screenshot({ path: join(SHOTS, '06_iphone_sunday_open_now.png') });
  await ctx.close();
}
{ // Saturday 00:30: places open from Friday evening past midnight are open now
  const { ctx, page } = await newPhone({ clock: '2026-11-14T00:30:00+09:00' });
  await page.goto(URL0); await page.waitForTimeout(800);
  const late = await page.evaluate(() => { const D = APP_DATA.restaurants.filter(r => (r.hours.fri || []).some(([, b]) => b >= '25:30'));
    return D.map(r => ({ n: r.name, s: window.__ofm.status(r, window.__ofm.S.day) })); });
  check(late.length > 0 && late.every(x => x.s.kind === 'open' || x.s.kind === 'closing') && late.every(x => /새벽|아침/.test(x.s.text)),
    'after midnight: last night’s late shops show open (“새벽 N:00까지”)', late.slice(0, 3).map(x => x.n + ' ' + x.s.text).join(' / '));
  await ctx.close();
}

console.log('6-day. A tab left open overnight switches back to today');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T21:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(500);
  await page.selectOption('#day', 'sun'); await page.waitForTimeout(300);
  const s0 = await page.evaluate(() => ({ day: window.__ofm.S.day, touched: window.__ofm.S.dayTouched }));
  await page.clock.setFixedTime(new Date('2026-11-14T12:30:00+09:00'));   // the same tab, next day
  await page.evaluate(() => window.__ofm.minuteTick()); await page.waitForTimeout(300);
  const s1 = await page.evaluate(() => ({ day: window.__ofm.S.day, touched: !!window.__ofm.S.dayTouched, opts: [...document.querySelectorAll('#day option')].map(o => o.textContent), chip: document.querySelector('#dayText').textContent, toast: window.__ofm.toasts.slice(-1)[0], tl: document.querySelector('#tripLine').textContent }));
  check(s0.day === 'sun' && s1.day === 'sat' && !s1.touched && /토 11\/14 \(오늘\)/.test(s1.chip) && s1.opts.filter(o => /오늘/.test(o)).length === 1 && s1.toast === '오늘(토) 기준으로 바꿨어요', 'next morning (minute tick): a hand-picked day goes back to today, “(오늘)” moves, toast', JSON.stringify({ s0, s1 }));
  await page.selectOption('#day', 'fri'); await page.waitForTimeout(300);
  const tl0 = await page.evaluate(() => document.querySelector('#tripLine').textContent);
  await page.clock.setFixedTime(new Date('2026-11-14T12:40:00+09:00'));
  await page.evaluate(() => window.__ofm.minuteTick()); await page.waitForTimeout(200);
  const tl1 = await page.evaluate(() => ({ t: document.querySelector('#tripLine').textContent, day: window.__ofm.S.day }));
  check(tl1.day === 'fri' && tl0 !== tl1.t, 'same day, another day picked: the 🧳 next-stop line still counts down', JSON.stringify({ tl0, tl1 }));
  await page.clock.setFixedTime(new Date('2026-11-15T09:00:00+09:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(300);
  check(await page.evaluate(() => window.__ofm.S.day) === 'sun', 'tab brought back to the front on Sunday → Sunday');
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6-lo. Last orders (A2-1)');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T21:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(400);
  const at = async (t, id, extra) => { await page.clock.setFixedTime(new Date(t)); await page.waitForTimeout(1100); return page.evaluate(([id, extra]) => { const O = window.__ofm, r = APP_DATA.restaurants.find(x => x.id === id); O.S.day = O.S.day; const st = O.status(r, O.S.day);
    const out = { kind: st.kind, text: st.text };
    if (extra) { O.S.openOnly = true; O.refresh(); out.inOpenOnly = O.rows().some(x => x.r && x.r.id === id); O.S.openOnly = false; O.refresh();
      const p = O.markers.get(id); out.pinDim = p && p.on ? p.el.querySelector('.pin').classList.contains('closed') : null; }
    return out; }, [id, extra]); };
  // id 11: Fri 16:00–23:00, last order 22:30
  const a = await at('2026-11-13T21:30:00+09:00', 11), b = await at('2026-11-13T21:50:00+09:00', 11), c = await at('2026-11-13T22:40:00+09:00', 11, true);
  check(a.kind === 'open' && a.text === '영업 중 · 마지막 주문 22:30' && b.kind === 'closing' && b.text === '곧 마감 · 마지막 주문 22:30', 'before last order: “영업 중 · 마지막 주문 22:30”, 곧 마감 from 45 min before it', JSON.stringify([a, b]));
  await page.evaluate(() => { const r = APP_DATA.restaurants.find(x => x.id === 11); window.__ofm.map().jumpTo({ center: [r.lon, r.lat], zoom: 17 }); }); await page.waitForTimeout(900);
  c.pinDim = await page.evaluate(() => { const p = window.__ofm.markers.get(11); return p && p.on ? p.el.querySelector('.pin').classList.contains('closed') : null; });
  check(c.kind === 'closing' && c.text === '주문 마감 · 23:00까지 영업' && c.inOpenOnly === false && c.pinDim === true, 'between last order and closing: “주문 마감 · 23:00까지 영업”, not in 영업 중만, pin drawn like a closed one', JSON.stringify(c));
  const noLo = await page.evaluate(() => { const O = window.__ofm, r = APP_DATA.restaurants.find(x => !x.lo && Array.isArray(x.hours.fri) && x.hours.fri.some(([a, b]) => a <= '22:00' && b >= '23:30')); return { id: r.id, st: O.status(r, 'fri') }; });
  check(noLo.st.kind === 'open' && /까지$/.test(noLo.st.text) && !/주문/.test(noLo.st.text), 'no last order in the data: unchanged wording', JSON.stringify(noLo));
  await page.evaluate(() => { window.__ofm.S.day = 'sat'; });
  const d = await at('2026-11-14T03:00:00+09:00', 132), e = await at('2026-11-14T04:30:00+09:00', 132);   // id 132: Fri 17:00–29:00, last order 28:00
  check(d.kind === 'open' && /마지막 주문 새벽 4:00/.test(d.text) && e.kind === 'closing' && /주문 마감 · 새벽 5:00까지 영업/.test(e.text), 'past midnight (Fri 17:00–29:00 seen on Sat): the last order 28:00 counts too', JSON.stringify([d, e]));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6-est. Estimated hours and Google hours that disagree (A2-2)');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T19:00:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(400);
  const r1 = await page.evaluate(() => { const O = window.__ofm, D = APP_DATA.restaurants, openNow = r => { const st = O.status(r, 'fri'); return st.kind === 'open' && !st.noOrder; };
    const low = D.find(r => (r.hoursConf === 'low' || r.hoursConf == null) && openNow(r)), high = D.find(r => (r.hoursConf === 'high' || r.hoursConf === 'medium') && openNow(r));
    const shop = O.SHOPS.map(s => O.status(s, 'fri')).find(st => st.kind === 'open');
    return { low: [low.id, O.status(low, 'fri')], high: [high.id, O.status(high, 'fri')], shop }; });
  check(/^영업 중\(추정\)/.test(r1.low[1].text) && r1.low[1].est && !/추정/.test(r1.high[1].text) && !r1.high[1].est && r1.shop && !/추정/.test(r1.shop.text), 'low/unknown-confidence hours: “영업 중(추정)”; confident hours and 🛍 shops unchanged', JSON.stringify(r1));
  await page.evaluate(() => window.__ofm.setSheet('half')); await page.waitForTimeout(400);
  const rowsEst = await page.evaluate(() => [...document.querySelectorAll('#list .item')].filter(e => e.querySelector('.st.est')).map(e => { const s = e.querySelector('.istat'); return Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight)); }));
  check(rowsEst.length > 0 && rowsEst.every(n => n === 1), '390 px: “영업 중(추정)” rows keep their status on one line (row height unchanged)', JSON.stringify(rowsEst));
  await page.evaluate(id => window.__ofm.select(id), r1.low[0]); await page.waitForTimeout(500);
  const d1 = await page.evaluate(() => ({ st: document.querySelector('#dStatus .st').className + ' ' + document.querySelector('#dStatus .st').textContent, note: /출처가 하나뿐/.test(document.querySelector('#detail').innerText) }));
  check(/est/.test(d1.st) && /추정/.test(d1.st) && d1.note, 'shop page: muted “(추정)” status and the hours caveat (low or unknown confidence)', JSON.stringify(d1));
  await page.evaluate(() => window.__ofm.closeDetail());
  // live Google hours in memory that disagree with ours for today → Google's, with a note; never 추정
  const g = await page.evaluate(id => { const O = window.__ofm, r = APP_DATA.restaurants.find(x => x.id === id); O.gCache.set(r.placeId, { periods: [{ od: 5, o: 17 * 60, cd: 5, c: 22 * 60 }], photos: [] });
    O.select(r.id); return new Promise(res => setTimeout(() => res({ st: O.status(r, 'fri'), line: document.querySelector('#dStatus').innerText }), 400)); }, r1.low[0]);
  check(g.st.gDiff && /22:00까지 \(구글\)$/.test(g.st.text) && !/추정/.test(g.st.text) && /구글 영업시간과 달라요/.test(g.line), 'live Google hours that differ today: Google’s shown, “구글 영업시간과 달라요 — 구글 기준으로 표시”', JSON.stringify(g));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6-resv. Reservation-only shops and the status badges (A2-3)');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T19:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(400);
  const R = await page.evaluate(() => { const O = window.__ofm, g = id => APP_DATA.restaurants.find(x => x.id === id), st = (id, d) => O.status(g(id), d);
    const out = { s133: st(133, 'fri'), s142: st(142, 'fri'), s148sat: st(148, 'sat'), s133sat: st(133, 'sat') };
    O.S.openOnly = true; O.refresh(); out.inOpen = O.rows().filter(x => x.r && [133, 142, 148].includes(x.r.id)).length;
    O.S.day = 'sat'; O.refresh(); out.inOpenSat = O.rows().filter(x => x.r && [133, 142, 148].includes(x.r.id)).length; O.S.day = 'fri'; O.S.openOnly = false; O.refresh();
    return out; });
  check(R.s133.kind === 'resv' && R.s133.text === '예약제 · 21:30까지' && R.s148sat.kind === 'resv' && /^예약제 · 토 18:00~$/.test(R.s148sat.text) && !/영업 중/.test(JSON.stringify(R)) && R.inOpen === 0 && R.inOpenSat === 0,
    'reservation-only shops: “예약제 · 21:30까지 / 예약제 · 토 18:00~”, never “영업 중”, not in 영업 중만 (today or another day)', JSON.stringify(R));
  // alternatives of a shop next to a reservation-only one never offer it
  const alt = await page.evaluate(() => { const O = window.__ofm, D = APP_DATA.restaurants, req = D.filter(r => r.reservation === 'required');
    const near = D.find(r => r.id !== 133 && r.reservation !== 'required' && r.lat != null && Math.hypot(r.lat - req[0].lat, (r.lon - req[0].lon) * .82) * 111 < 0.4);
    O.select(near.id); document.querySelector('#crowdBtn').click(); return new Promise(res => setTimeout(() => { const ids = [...document.querySelectorAll('#alts .alt')].map(e => +e.dataset.go); O.closeDetail(); res({ near: near.id, ids, hasReq: ids.some(i => req.some(r => r.id === i)) }); }, 300)); });
  check(alt.ids.length > 0 && !alt.hasReq, '줄이 길어요 alternatives never offer a reservation-only shop', JSON.stringify(alt));
  const pin = await page.evaluate(async () => { const O = window.__ofm, r = APP_DATA.restaurants.find(x => x.id === 133); O.S.showAll = true; O.refresh(); O.map().jumpTo({ center: [r.lon, r.lat], zoom: 17.5 }); await new Promise(res => setTimeout(res, 900)); const p = O.markers.get(133); return p && p.on ? p.el.querySelector('.pin').classList.contains('closed') : null; });
  check(pin === true, 'a reservation-only pin is drawn like a closed one (not as open)', String(pin));
  const chips = await page.evaluate(async () => { const O = window.__ofm, D = APP_DATA.restaurants, so = D.find(r => r.soldOut && r.lat != null), irr = D.find(r => /부정기/.test(r.closed || '') && r.lat != null);
    const ch = async id => { O.select(id); await new Promise(res => setTimeout(res, 300)); const t = document.querySelector('#detail').innerText; O.closeDetail(); return t; };
    O.S.showAll = true; O.refresh(); O.setSheet('full'); await new Promise(res => setTimeout(res, 300));
    const row = id => { const e = document.querySelector(`#list .item[data-id="${id}"]`); return e ? e.innerText : '(row not rendered)'; };
    return { req: /예약제/.test(await ch(133)), so: /재료 소진 시 조기 마감/.test(await ch(so.id)), irr: /부정기 휴무/.test(await ch(irr.id)) }; });
  check(chips.req && chips.so && chips.irr, 'shop page badges: 예약제 · 재료 소진 시 조기 마감 · 부정기 휴무', JSON.stringify(chips));
  const rowChips = await page.evaluate(async () => { const O = window.__ofm; O.S.q = '사이히'; O.refresh(); await new Promise(res => setTimeout(res, 200)); const e = document.querySelector('#list .item[data-id="133"]'); const t = e ? e.innerText : null; O.S.q = ''; O.refresh(); return t; });
  check(/예약제/.test(rowChips || '') && !/대기|줄 (없음|짧음|보통|김|매우 김)/.test(rowChips || ''), 'list row: 예약제 badge, no queue (줄/대기) chip', rowChips && rowChips.replace(/\s+/g, ' '));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6-late. “도착 전 마감” when the walk takes longer than the time left (A2-4)');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T22:52:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => { const O = window.__ofm; O.setSheet('full'); await new Promise(res => setTimeout(res, 300));
    const b = document.querySelector('#sheetBody'); for (let i = 0; i < 40; i++) { b.scrollTop = b.scrollHeight; await new Promise(res => setTimeout(res, 30)); }   // render every row
    const now = 22 * 60 + 52, wm = d => Math.max(1, Math.round(d * 1.3 / 4.5 * 60)), out = { late: [], ok: [], bad: [] };
    for (const x of O.rows().filter(x => x.r)) { const st = O.status(x.r, 'fri'), el = document.querySelector(`#list .item[data-id="${x.r.id}"] .st`); if (!el || st.end == null) continue;
      const late = wm(x.d) <= 40 && wm(x.d) >= st.end - now, txt = el.textContent;
      (late ? out.late : out.ok).push(`${x.r.id} ${wm(x.d)}분 ${txt}`); if (late !== /^도착 전 마감 · \d/.test(txt) || (late && !el.classList.contains('closing'))) out.bad.push(`${x.r.id} ${wm(x.d)}분/${st.end - now} ${txt}`); }
    return out; });
  check(r.late.length > 0 && r.ok.length > 0 && r.bad.length === 0, 'rows: “도착 전 마감 · HH:MM” when the walk is as long as the time left before last order / closing', JSON.stringify({ late: r.late.slice(0, 3), ok: r.ok.slice(0, 2), bad: r.bad.slice(0, 3) }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6-bands. Live trip day ordering: 5/10/20-minute bands, open first, closed dimmed (A2-5)');
const order = page => page.evaluate(() => { const O = window.__ofm, R = O.rows(), wm = d => Math.max(1, Math.round(d * 1.3 / 4.5 * 60));
  const n0 = new Date(), now = n0.getHours() * 60 + n0.getMinutes();   // these phones run on Japan / Korea time (the same clock)
  const grp = (r, d) => { const st = O.status(r, O.S.day), k = st.kind; return k === 'closed' || k === 'done' || st.noOrder || (st.end != null && wm(d) >= st.end - now) ? 3 : k === 'later' || k === 'resv' ? 2 : k === 'unknown' ? 1 : 0; };
  const bands = R.filter(x => x.band).map(x => x.divider); let bad = [], cur = null, prev = null;
  for (const x of R) { if (x.divider) { cur = x.band ? x.divider : null; prev = null; continue; } if (!cur) continue;
    const lim = /5분/.test(cur) ? 5 : /10분/.test(cur) ? 10 : 20, m = wm(x.d); if (m > lim || (lim > 5 && m <= (lim === 10 ? 5 : 10))) bad.push('band ' + x.r.id);
    const g = grp(x.r, x.d); if (prev && (g < prev.g || (g === prev.g && (x.r.tabelog ?? 0) > (prev.t ?? 0)))) bad.push('order ' + x.r.id); if (!!x.dim !== (g === 3)) bad.push('dim ' + x.r.id); prev = { g, t: x.r.tabelog ?? 0 }; }
  return { bands, bad, n: R.filter(x => x.r).length, count: document.querySelector('#count').textContent }; });
{ // live Friday, Dotonbori
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const o = await order(page);
  check(o.bands.join('|') === '걸어서 5분 안|걸어서 10분 안|걸어서 20분 안' && o.bad.length === 0 && o.count === `${o.n}곳`, 'live trip day, 근처 평점순: 5 / 10 / 20-minute bands; in each, open first, then later, then closed (dimmed), by rating', JSON.stringify(o).slice(0, 300));
  const vis = await page.evaluate(() => { const b = document.querySelector('#sheetBody').getBoundingClientRect(); return [...document.querySelectorAll('#list .item')].filter(e => { const r = e.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= Math.min(b.bottom, innerHeight) + 1; }).length; });
  check(vis >= 2, 'half sheet (iPhone 13): still two whole rows visible (band dividers show once the list is full)', String(vis));
  const dom = await page.evaluate(async () => { const O = window.__ofm; O.setSheet('full'); const b = document.querySelector('#sheetBody'); for (let i = 0; i < 40; i++) { b.scrollTop = b.scrollHeight; await new Promise(r => setTimeout(r, 30)); }
    const ds = [...document.querySelectorAll('#list .divider.band')].filter(e => e.offsetHeight > 0).map(e => e.textContent), items = document.querySelectorAll('#list .item').length, dimmed = document.querySelectorAll('#list .item.dimmed').length; return { ds, items, rows: O.rows().filter(x => x.r).length, dimmed }; });
  check(dom.ds.length === 3 && dom.items === dom.rows && dom.dimmed > 0, 'full list: every row and the three band dividers are shown once scrolled to the end (lazy rendering intact)', JSON.stringify(dom));
  await page.evaluate(() => window.__ofm.setPlace(window.__ofm.placeHits('오사카성')[0])); await page.waitForTimeout(600);
  const p = await order(page);
  check(p.bands.length >= 1 && p.bad.length === 0, 'a picked place uses the same bands', JSON.stringify(p).slice(0, 200));
  await page.evaluate(() => window.__ofm.clearPlace()); await page.locator('#sort').selectOption('wait'); await page.waitForTimeout(300);
  const w = await page.evaluate(() => { const O = window.__ofm, R = O.rows().filter(x => x.r), wm = d => Math.max(1, Math.round(d * 1.3 / 4.5 * 60)), shut = r => { const st = O.status(r, O.S.day); return st.kind === 'closed' || st.kind === 'done' || !!st.noOrder; };
    const s = R.map(x => shut(x.r)), first = s.indexOf(true), open = R.filter(x => !shut(x.r)), nf = open.findIndex(x => wm(x.d) > 20);
    return { n: R.length, closedLast: first < 0 || s.slice(first).every(Boolean), nearFirst: nf < 0 || open.slice(nf).every(x => wm(x.d) > 20), hint: document.querySelector('#list .hint').textContent }; });
  check(w.closedLast && w.nearFirst && /문 닫은 곳은 맨 뒤/.test(w.hint), '대기 짧은 순 on a live day: within a 20-min walk first, closed places last, and the hint says so', JSON.stringify(w));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}
{ // not a trip day: unchanged ordering, no bands
  const { ctx, page } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-11T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const o = await order(page);
  const sc = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).slice(0, 8).map(x => x.r.tabelog ?? 0));
  check(o.bands.length === 0 && sc.every((v, i) => !i || v <= sc[i - 1]), 'outside the trip days: no bands, the near-me group is plain rating order', JSON.stringify({ bands: o.bands, sc }));
  await ctx.close();
}

console.log('6a. “영업 중만” chip: on screen without scrolling, and remembered on the phone');
for (const dev of [devices['iPhone 13'], devices['iPhone SE']]) {
  const { ctx, page, log } = await newPhone({ device: dev, clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(500);
  const W = dev.viewport.width;
  const chips = await page.evaluate(() => [...document.querySelectorAll('#chips .chip')].map(c => { const b = c.getBoundingClientRect(); return { id: c.id, l: Math.round(b.left), r: Math.round(b.right) }; }));
  const oc = chips.find(c => c.id === 'openChip');
  check(chips.map(c => c.id).join(',') === 'tripChip,shopChip,openChip,filterChip,genreChip,dayChip,listChip' && oc.r <= W * 0.86, `${W}px: chips 일정 · 쇼핑 · 영업 중만 · 필터 · 뭐 먹지? · 날짜 · 목록, 영업 중만 fully visible`, chips.map(c => `${c.id}@${c.l}-${c.r}`).join(' '));
  const on0 = await page.evaluate(() => window.__ofm.S.openOnly);
  await page.locator('#openChip').click(); await page.waitForTimeout(300);
  const n1 = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).length);
  await page.reload(); await ready(page); await page.waitForTimeout(500);
  const re = await page.evaluate(() => ({ on: window.__ofm.S.openOnly, n: window.__ofm.rows().filter(x => x.r).length, label: document.querySelector('#openChip').textContent }));
  await page.locator('#openChip').click(); await page.waitForTimeout(300); await page.reload(); await ready(page); await page.waitForTimeout(500);
  const off = await page.evaluate(() => window.__ofm.S.openOnly);
  check(!on0 && re.on && re.n === n1 && /✓/.test(re.label) && !off, `${W}px: 영업 중만 starts off and is remembered across reloads (on, then off)`, JSON.stringify({ on0, n1, re, off }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6b. Trip scenarios after the review fixes');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo', geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 } });
  await page.goto(URL0); await ready(page);
  await page.locator('#locBtn').click(); await page.waitForTimeout(1200);
  await page.locator('#genreChip').click(); await page.locator('#genreGrid [data-genre="ramen"]').click(); await page.waitForTimeout(400);
  const ramen = await page.evaluate(() => window.__ofm.rows().filter(x => x.r && x.d * 1.3 / 4.5 * 60 <= 20).length);
  const hint = await page.locator('#list .hint').first().innerText();
  check(ramen >= 5 && !/ 0곳/.test(hint), 'near-me ramen in Dotonbori lists the shops within a 20-min walk', `${ramen} near · "${hint}"`);
  await page.locator('#genreChip').click(); await page.locator('#genreGrid [data-genre="tako"]').click(); await page.waitForTimeout(400);
  const tako = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).map(x => x.r.genre));
  check(tako.length >= 5 && tako.every(g => g === '타코야키'), 'takoyaki menu lists takoyaki shops', String(tako.length));
  await page.locator('#catBar [data-cat="all"]').click(); await page.locator('#openChip').click(); await page.waitForTimeout(400);
  const order = await page.evaluate(() => { const O = window.__ofm, R = O.rows(), i = R.findIndex(x => x.divider && /영업시간 정보 없음/.test(x.divider)), k = x => O.status(x.r, O.S.day).kind;
    return { i, before: (i < 0 ? R : R.slice(0, i)).filter(x => x.r).every(x => k(x) !== 'unknown'), after: i < 0 || R.slice(i + 1).filter(x => x.r).every(x => k(x) === 'unknown') }; });
  check(order.i > 0 && order.before && order.after, '“영업 중만”: confirmed-open shops first, unknown hours after a divider', JSON.stringify(order));
  await page.locator('#openChip').click(); await page.waitForTimeout(200);
  await page.locator('.item').first().click(); await page.waitForTimeout(500);
  const ab = await page.evaluate(() => { const b = document.querySelector('.abar .ab.primary').getBoundingClientRect(); return { bottom: Math.round(b.bottom), vh: innerHeight }; });
  check(ab.bottom <= ab.vh, '길찾기 is on screen when a shop opens', JSON.stringify(ab));
  await page.locator('#taxiBtn').click(); await page.waitForTimeout(300);
  const taxi = await page.locator('.taxiCard').innerText();
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check(/お願いします/.test(taxi) && await page.locator('#taxi').isHidden(), '🚕 taxi card shows the Japanese name and request; Escape closes it', taxi.split('\n')[0]);
  await page.evaluate(() => { window.__ofm.S.f.card = true; });
  await page.locator('#crowdBtn').click(); await page.waitForTimeout(300);
  const alts = await page.evaluate(() => [...document.querySelectorAll('#alts .alt')].map(e => +e.dataset.go));
  const altsOk = await page.evaluate(ids => ids.every(id => APP_DATA.restaurants.find(r => r.id === id).pay.card === true) || /조건 없이/.test(document.querySelector('#alts').innerText), alts);
  check(alts.length > 0 && altsOk, '줄이 길어요 alternatives respect the card filter', alts.length + ' alternatives');
  await page.evaluate(() => { window.__ofm.S.f.card = false; });
  await page.locator('#filterChip').click(); await page.waitForTimeout(200);
  await page.goBack(); await page.waitForTimeout(300);
  check(await page.locator('#filters').isHidden() && page.url().startsWith(URL0) && await page.evaluate(() => window.__ofm.S.view) === 'detail', 'Back closes the filter sheet and stays in the app');
  await page.goBack(); await page.waitForTimeout(300);
  check(await page.evaluate(() => window.__ofm.S.view) === 'list' && page.url().startsWith(URL0), 'Back again closes the shop');
  await page.locator('#q').fill('라멘 우메다'); await page.waitForTimeout(400);
  const qs = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).map(x => x.r.genre + ' ' + x.r.area));
  check(qs.length > 0 && qs.every(t => /라멘|츠케멘/.test(t)), 'two-word search “라멘 우메다”', qs.length + ' shops: ' + qs.slice(0, 2).join(' / '));
  await page.locator('#q').fill('맥도날드'); await page.waitForTimeout(400);
  check(/검색 결과가 없어요/.test(await page.locator('#list').innerText()) && await page.locator('#list a.gmore').count() > 0, 'no result: says so and offers a Google Maps search');
  await page.locator('#q').fill(''); await page.waitForTimeout(200);
  check(log.errors.length === 0, 'no script errors in the trip scenarios', log.errors.slice(0, 2).join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await newPhone({ clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page);
  await page.locator('#ref').selectOption('center'); await page.waitForTimeout(600);
  const far = await page.evaluate(() => { const R = window.__ofm.rows().filter(x => x.r); return R[R.length - 1].r.id; });
  await page.evaluate(id => window.__ofm.select(id), far); await page.waitForTimeout(1500);
  const dist = await page.locator('#dStatus .dDist').innerText();
  check(!/(^| )0m\b|· 0m/.test(dist), 'map-centre distance stays put while a shop is open', dist);
  await ctx.close();
}

console.log('6c. Travel itinerary');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T13:20:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page);
  await page.locator('#tripChip').click(); await page.waitForTimeout(900);
  const t = await page.evaluate(() => ({ mode: window.__ofm.S.mode, day: window.__ofm.S.tripDay, stops: document.querySelectorAll('.tStop').length, pins: document.querySelectorAll('.tpin').length,
    lines: ((window.__ofm.glStyle() || { layers: [] }).layers || []).filter(l => /^tripline/.test(l.id)).length, now: (document.querySelector('.tNow') || {}).innerText || '' }));
  check(t.mode === 'trip' && t.day === 'fri' && t.stops === 10 && t.pins === 10, '🧳 일정 opens today (Fri) with its 10 stops and numbered pins', JSON.stringify({ ...t, now: undefined }));
  check(t.lines >= 4, 'route lines drawn between the stops', String(t.lines));
  check(/지금[\s\S]*다루마[\s\S]*다음[\s\S]*츠텐카쿠/.test(t.now), 'now/next card at Fri 13:20: now Daruma (lunch), next Tsutenkaku', t.now.replace(/\s+/g, ' ').slice(0, 120));
  await page.locator('.tStop').nth(3).click(); await page.waitForTimeout(400);   // Fri lunch: Daruma in Shinsekai
  const dir = await page.locator('.tStop.open a.tBtn.primary').getAttribute('href');
  check(/maps\/dir\/\?api=1.*destination=34\.65/.test(dir), 'a stop expands with a Google Maps directions link', dir.slice(0, 90));
  const alts = await page.locator('.tStop.open .tAlt').count();
  check(alts > 0, 'a meal stop lists nearby alternatives open at that time', String(alts));
  await page.locator('.tStop.open .tSwap').first().click(); await page.waitForTimeout(300);
  const sw = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ofm.tripSwap.v1') || '{}')));
  check(sw.includes('s3'), '“이걸로” swaps the meal and remembers it on the phone', sw.join(','));
  await page.locator('.tStop.open [data-unswap]').click(); await page.waitForTimeout(300);
  check(await page.evaluate(() => !Object.keys(JSON.parse(localStorage.getItem('ofm.tripSwap.v1') || '{}')).length), '“되돌리기” restores the planned place');
  await page.locator('[data-tday="all"]').click(); await page.waitForTimeout(700);
  const all = await page.evaluate(() => ({ pins: document.querySelectorAll('.tpin').length, days: document.querySelectorAll('.oDay').length, checks: document.querySelectorAll('[data-check]').length }));
  check(all.pins === 25 && all.days === 4 && all.checks >= 5, '전체: all three days on the map, overview and checklist', JSON.stringify(all));
  await page.evaluate(() => window.__ofm.setSheet('full')); await page.waitForTimeout(300);
  await page.locator('.tTab[data-tday="sat"]').click(); await page.waitForTimeout(300);   // a day tapped with the list fully open (map hidden)…
  await page.evaluate(() => window.__ofm.setSheet('half')); await page.waitForTimeout(1200);   // …is framed once the list comes down
  const satVis = await page.evaluate(() => { const top = document.querySelector('#topbar').getBoundingClientRect().bottom, bot = document.querySelector('#sheet').getBoundingClientRect().top;
    const P = [...document.querySelectorAll('.tpin')].map(e => e.getBoundingClientRect()); return { on: P.filter(r => r.top >= top - 4 && r.bottom <= bot + 4 && r.left >= 0 && r.right <= innerWidth).length, n: P.length }; });
  check(satVis.n === 10 && satVis.on === satVis.n, 'a day picked while the list is full is framed on the map when the list comes down', JSON.stringify(satVis));
  const hep = await page.evaluate(() => { const d = window.__ofm.TRIP_DATA.days.find(x => x.key === 'sat'), i = d.stops.findIndex(s => s.id === 's11'); return { after: d.stops[i - 1].id, time: d.stops[i].time, last: d.stops[d.stops.length - 1].id }; });
  check(hep.after === 'f7' && hep.time >= '21:30' && hep.time <= '22:15' && hep.last === 's10', 'Saturday: HEP FIVE Ferris wheel right after the Aburiya dinner, before the last boarding (22:45)', JSON.stringify(hep));
  await page.locator('.tTab[data-tday="all"]').click(); await page.waitForTimeout(400);
  await page.locator('#tripChip').click(); await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({ mode: window.__ofm.S.mode, pins: document.querySelectorAll('.tpin').length, items: document.querySelectorAll('.item').length, banner: (() => { const b = document.querySelector('#tripLine'); return !!b && !b.hidden && b.getBoundingClientRect().height >= 44 && /13:50/.test(b.textContent); })() }));
  check(back.mode === 'shops' && back.pins === 0 && back.items > 0 && back.banner, 'leaving the itinerary restores the shop list with a next-stop banner', JSON.stringify(back));
  check(log.errors.length === 0, 'no script errors in the itinerary', log.errors.slice(0, 2).join(' | '));
  await page.locator('#tripChip').click(); await page.waitForTimeout(400);   // leave it in the itinerary, then reopen the app
  await page.reload(); await ready(page); await page.waitForTimeout(800);
  const re = await page.evaluate(() => ({ mode: window.__ofm && window.__ofm.S.mode, stops: document.querySelectorAll('.tStop, .oRow').length, ready: !!(window.__ofm && window.__ofm.ready()) }));
  check(re.mode === 'trip' && re.stops > 0 && re.ready && log.errors.length === 0, 'reopening the app while in the itinerary works (no blank screen)', JSON.stringify(re) + ' ' + log.errors.slice(0, 1).join(''));
  const alt6 = await page.evaluate(() => { const O = window.__ofm, d = O.TRIP_DATA.days.find(x => x.key === 'fri'), s = d.stops.find(x => x.id === 's8'), A = O.tripAlts(s, d);
    return { n: A.length, first: A[0] && A[0].r.group6, names: A.map(x => x.r.name), hardLast: A.findIndex(x => x.r.group6 === 'hard') < 0 || A.slice(A.findIndex(x => x.r.group6 === 'hard')).every(x => x.r.group6 === 'hard') }; });
  check(alt6.n >= 3 && alt6.n <= 5 && alt6.first === 'likely' && alt6.hardLast && alt6.names.some(n => /코로안/.test(n)), 'itinerary alternatives for 대기수산 put 6인 OK first and include 코로안', JSON.stringify(alt6));
  check(await page.evaluate(() => { const r = APP_DATA.restaurants.find(x => /코로안/.test(x.name)); return window.__ofm.primaryCat(r) === 'c-sea'; }), 'a sushi bar that also fries counts as sushi for “같은 종류” alternatives');
  await page.evaluate(() => window.__ofm.openTripStop('fri', 'f9')); await page.waitForTimeout(500);
  await page.locator('.tStop.open [data-taxi]').click(); await page.waitForTimeout(300);
  const tx = await page.evaluate(() => ({ name: document.querySelector('#taxiName').textContent, addr: document.querySelector('#taxiAddr').textContent, copy: getComputedStyle(document.querySelector('#taxiCopy')).display }));
  check(/リーガロイヤル/.test(tx.name) && /中之島5-3-68/.test(tx.addr) && tx.copy !== 'none', 'taxi card from a hotel stop shows the hotel’s Japanese name and address (no Google needed)', JSON.stringify(tx));
  check(await page.evaluate(() => { const b = document.querySelector('#taxiCopy'); b.hidden = true; const d = getComputedStyle(b).display; b.hidden = false; return d === 'none'; }), 'a hidden button really hides (copy address when there is no address)');
  await page.goBack(); await page.waitForTimeout(300);
  const noAddr = await page.evaluate(() => window.__ofm.TRIP_DATA.days.flatMap(d => d.stops).filter(s => !(window.__ofm.tripPlace(s).address || (window.__ofm.tripPlace(s).shop || {}).address)).map(s => s.id));
  check(noAddr.length === 0, 'every itinerary stop has a Japanese address for the taxi card, without Google', noAddr.join(','));
  const linked = await page.evaluate(() => window.__ofm.TRIP_DATA.days.flatMap(d => d.stops).filter(s => ['meal', 'cafe'].includes(s.kind)).map(s => [s.id, !!window.__ofm.tripPlace(s).shop]));
  check(linked.every(([, ok]) => ok), 'every planned meal and café links to its shop record (seats, payment, wait)', JSON.stringify(linked.filter(([, ok]) => !ok)));
  await page.evaluate(() => window.__ofm.openTripStop('fri', 's5')); await page.waitForTimeout(500);
  await page.locator('.tStop.open [data-taxi]').click(); await page.waitForTimeout(300);
  const tk = await page.evaluate(() => ({ addr: document.querySelector('#taxiAddr').textContent, hint: document.querySelector('#taxiHint').hidden ? '' : document.querySelector('#taxiHint').textContent }));
  check(/日本橋2-4-1/.test(tk.addr) && /千日前通/.test(tk.hint), 'taxi card for a market gives its address and where to drop off (in Japanese)', JSON.stringify(tk));
  await page.goBack(); await page.waitForTimeout(300);
  await page.evaluate(() => { window.__ofm.setSheet('full'); window.__ofm.openTripStop('sat', 'f3'); }); await page.waitForTimeout(600);
  await page.evaluate(() => { const b = document.querySelector('#sheetBody'); b.scrollTop = Math.floor((b.scrollHeight - b.clientHeight) / 2); }); await page.waitForTimeout(500);   // mid-list, away from the clamp at the end
  const before = await page.evaluate(() => { const top = document.querySelector('#sheetBody').scrollTop; document.querySelector('.tStop.open .tAlt [data-shop]').click(); return top; });   // a tap where it is (no scroll-into-view)
  await page.waitForTimeout(600);
  const inDetail = await page.evaluate(() => window.__ofm.S.view);
  await page.goBack(); await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({ top: document.querySelector('#sheetBody').scrollTop, state: window.__ofm.sheetState(), view: window.__ofm.S.view, open: !!document.querySelector('.tStop.open') }));
  check(inDetail === 'detail' && after.view === 'list' && Math.abs(after.top - before) < 4 && after.state === 'full' && after.open, 'Back from a shop returns to the same spot in the itinerary', JSON.stringify({ before, ...after }));
  await ctx.close();
}

console.log('6e. Map bubbles never cover each other when zoomed out');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T13:20:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page);
  const res = [];
  for (const z of [12, 13, 14]) {
    await page.evaluate(z => window.__ofm.map().jumpTo({ center: [135.5, 34.685], zoom: z }), z); await page.waitForTimeout(900);
    res.push(await page.evaluate(() => { const B = [...document.querySelectorAll('.cl, .pin')].map(e => e.getBoundingClientRect()).filter(r => r.width && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth);
      let n = 0; for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) { const a = B[i], c = B[j]; if (Math.min(a.right, c.right) - Math.max(a.left, c.left) > 2 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 2) n++; }
      return n; }));
  }
  check(res.every(n => n === 0), 'zoom 12–14: no two cluster bubbles or pins overlap', res.join(','));
  check(log.errors.length === 0, 'no script errors while zooming', log.errors.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('6e2. Food map: restaurant pins win taps over itinerary circles and shop squares; groups always zoom in');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T13:10:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.evaluate(() => window.__ofm.setSheet('half')); await page.waitForTimeout(600);
  let overl = 0, wrong = [];
  for (const [lon, lat] of [[135.5063, 34.6525], [135.5013, 34.6687], [135.4985, 34.7025], [135.4873, 34.6903], [135.5262, 34.6873]]) for (const z of [13, 14, 15, 15.5, 16, 16.5]) {
    await page.evaluate(([c, z]) => window.__ofm.map().jumpTo({ center: c, zoom: z }), [[lon, lat], z]); await page.waitForTimeout(500);
    const r = await page.evaluate(() => { const top = document.querySelector('#topbar').getBoundingClientRect().bottom, bot = document.querySelector('#sheet').getBoundingClientRect().top;
      const R = s => [...document.querySelectorAll(s)].map(e => ({ e, b: e.getBoundingClientRect() })).filter(x => x.b.width && x.b.top > top && x.b.bottom < bot && x.b.left > 0 && x.b.right < innerWidth);
      const food = R('.mk .pin, .mk .cl'), other = R('.itm .itPin, .spm .spin'); let n = 0; const bad = [];
      for (const o of other) for (const f of food) { const x0 = Math.max(o.b.left, f.b.left), x1 = Math.min(o.b.right, f.b.right), y0 = Math.max(o.b.top, f.b.top), y1 = Math.min(o.b.bottom, f.b.bottom);
        if (x1 - x0 < 4 || y1 - y0 < 4) continue; n++; const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2); if (!f.e.closest('.mk').contains(hit)) bad.push(f.e.textContent.slice(0, 12) + ' under ' + (hit && hit.closest('.mk') ? hit.closest('.mk').className : hit && hit.tagName)); }
      return { n, bad }; });
    overl += r.n; wrong.push(...r.bad);
  }
  check(overl > 0 && wrong.length === 0, 'food map: where an itinerary circle or shop square overlaps a restaurant pin/group, the restaurant gets the tap', `${overl} overlaps; ${wrong.slice(0, 4).join(' / ')}`);
  // a group whose members sit close together: tapping it must zoom in (not a no-op fitBounds)
  await page.evaluate(() => window.__ofm.map().jumpTo({ center: [135.5013, 34.6687], zoom: 14.6 })); await page.waitForTimeout(600);
  const res = await page.evaluate(async () => { const m = window.__ofm.map(), out = [];
    const cls = [...document.querySelectorAll('.mk .cl')].map(e => e.closest('.mk')).filter(e => { const b = e.getBoundingClientRect(); return b.top > 130 && b.bottom < document.querySelector('#sheet').getBoundingClientRect().top && b.left > 0 && b.right < innerWidth; });
    for (const el of cls.slice(0, 4)) { m.jumpTo({ center: [135.5013, 34.6687], zoom: 14.6 }); await new Promise(r => setTimeout(r, 500)); const z0 = m.getZoom(), t = el.textContent; if (!document.contains(el)) continue; el.click(); await new Promise(r => setTimeout(r, 900)); out.push([t, z0, +m.getZoom().toFixed(2)]); }
    return out; });
  check(res.length > 0 && res.every(([, a, b]) => b >= a + 1), 'tapping a group always zooms in at least one level', JSON.stringify(res));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6f. Phone held sideways: list panel on the left, map on the right');
{
  const { ctx, page, log } = await newPhone({ device: devices['iPhone 13 landscape'], clock: '2026-11-13T13:20:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(500);
  const g = () => page.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect();
    const fab = [...document.querySelectorAll('#fabs .fab')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
    return { W: innerWidth, H: innerHeight, map: [r('#map').left, r('#map').width, r('#map').height], sheet: [r('#sheet').top, r('#sheet').height, r('#sheet').width],
      fabsClear: fab.every(b => b.top >= r('#topbar').bottom), hs: document.documentElement.scrollWidth > innerWidth }; });
  const l = await g();
  check(l.map[1] >= l.W * 0.45 && l.map[2] === l.H && l.sheet[0] === 0 && l.sheet[1] === l.H && !l.hs, 'landscape: full-height list panel on the left and a full-height map', JSON.stringify(l));
  check(l.fabsClear, 'landscape: map buttons stay below the search bar and chips');
  await page.evaluate(() => window.__ofm.select(window.__ofm.rows().find(x => x.r).r.id)); await page.waitForTimeout(600);
  const dir = await page.evaluate(() => { const a = [...document.querySelectorAll('#detail a, #detail button')].find(e => /길찾기/.test(e.textContent)); const b = a.getBoundingClientRect(); return b.bottom <= innerHeight && b.top >= 0; });
  check(dir, 'landscape: 길찾기 is on screen when a shop opens');
  await page.evaluate(() => window.__ofm.closeDetail());
  await page.setViewportSize({ width: 390, height: 664 }); await page.waitForTimeout(600);   // turn the phone upright
  const p = await page.evaluate(() => ({ state: window.__ofm.sheetState(), top: document.querySelector('#sheet').getBoundingClientRect().top, H: innerHeight }));
  check(p.state !== 'desk' && p.top > p.H * 0.5, 'turning the phone upright brings back the bottom sheet', JSON.stringify(p));
  await page.setViewportSize({ width: 750, height: 342 }); await page.waitForTimeout(600);
  check(await page.evaluate(() => window.__ofm.sheetState() === 'desk' && document.querySelector('#sheet').getBoundingClientRect().top === 0), 'and sideways again brings back the side panel');
  check(log.errors.length === 0, 'no script errors in landscape', log.errors.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('6g. Search a place (landmark, area, station) to see our shops near it');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page);
  const hits = await page.evaluate(() => Object.fromEntries(['오사카성', '가이유칸', 'usj', '헵파이브', '츠루하시', '도톤보리', '우메다', '大阪城', 'Kaiyukan'].map(q => [q, (window.__ofm.placeHits(q)[0] || {}).ko || null])));
  check(Object.values(hits).every(Boolean) && /오사카성/.test(hits['오사카성']) && /오사카성/.test(hits['大阪城']) && /가이유칸/.test(hits['Kaiyukan']), 'landmarks, areas and stations are found in Korean, Japanese and English', JSON.stringify(hits));
  check(await page.evaluate(() => window.__ofm.PLACES.length) > 150, 'the place list covers stations and landmarks (offline, no Google)');
  await page.locator('#q').fill('오사카성'); await page.waitForTimeout(500);
  const sr = await page.evaluate(() => ({ places: [...document.querySelectorAll('#list .placeRow .pt b')].map(b => b.textContent), empty: !!document.querySelector('#list .empty') }));
  check(sr.places.length >= 1 && /오사카성/.test(sr.places[0]) && !sr.empty, 'searching “오사카성” offers the place (not “no results”)', JSON.stringify(sr));
  await page.locator('#list .placeRow').first().click(); await page.waitForTimeout(900);
  const st = await page.evaluate(() => { const O = window.__ofm, R = O.rows().filter(x => x.r); return { ref: O.S.ref, sort: O.S.sort, q: document.querySelector('#q').value, refText: document.querySelector('#refText').textContent,
    marker: !!document.querySelector('.placePin'), firstKm: R[0] && +R[0].d.toFixed(2), sortedNear: R.slice(0, 2).every(x => x.d < 1.6), anyNear: R.some(x => /R Baker/.test(x.r.name)) }; });
  check(st.ref === 'place' && st.sort === 'nearby' && st.q === '' && /오사카성 기준/.test(st.refText) && st.marker && st.sortedNear && st.anyNear, 'picking it lists our shops nearest to Osaka Castle first, with a marker and “📍 오사카성 기준”', JSON.stringify(st));
  const dist = await page.evaluate(() => { const O = window.__ofm, r = O.rows().find(x => x.r).r; O.select(r.id); return new Promise(res => setTimeout(() => { res(document.querySelector('.dDist').textContent); O.closeDetail(); }, 400)); });
  check(/오사카성에서/.test(dist), 'the shop page measures the distance from the picked place', dist);
  await page.locator('#placeOff').click(); await page.waitForTimeout(400);
  const off = await page.evaluate(() => ({ ref: window.__ofm.S.ref, marker: !!document.querySelector('.placePin'), opt: !!document.querySelector('#ref option[value=place]') }));
  check(off.ref !== 'place' && !off.marker && !off.opt, '“기준 해제” returns to the hotel / my location', JSON.stringify(off));
  await page.locator('#q').fill('가이유칸'); await page.locator('#q').press('Enter'); await page.waitForTimeout(800);
  check(await page.evaluate(() => window.__ofm.S.ref === 'place' && /가이유칸/.test(window.__ofm.S.place.name)), 'Enter on a place name goes straight to it');
  await page.locator('#q').fill('라멘'); await page.waitForTimeout(500);
  check(await page.evaluate(() => !document.querySelector('#list .placeRow') && window.__ofm.rows().some(x => x.r)), 'a menu word (라멘) still searches shops only');
  check(log.errors.length === 0, 'no script errors in place search', log.errors.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('6g2. Search box: ✕ clear button, spelling variants and synonyms');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page);
  const n = q => page.evaluate(q => { const i = document.querySelector('#q'); i.value = q; i.dispatchEvent(new Event('input', { bubbles: true })); return new Promise(res => setTimeout(() => res(window.__ofm.rows().filter(x => x.r).length), 260)); }, q);
  const R = {}; for (const q of ['타코야끼', '타코야키', '오코노미야끼', '오코노미야키', '야끼니꾸', '야키니쿠', '만두', '국수', '맥주', 'sushi', 'ramen', 'udon', 'curry', 'cafe', '돈까스', '맥도날드']) R[q] = await n(q);
  check(R['타코야끼'] === R['타코야키'] && R['오코노미야끼'] === R['오코노미야키'] && R['야끼니꾸'] === R['야키니쿠'] && R['타코야키'] > 0 && R['야키니쿠'] > 0, '끼/꾸 spellings find the same shops as 키/쿠', JSON.stringify(R));
  check(['만두', '국수', '맥주', 'sushi', 'ramen', 'udon', 'curry', 'cafe', '돈까스'].every(q => R[q] > 0) && R['맥도날드'] === 0, 'synonyms (만두→교자, 국수→면, 맥주→이자카야, English menu words) find shops; 맥도날드 still finds none', JSON.stringify(R));
  await n('');
  const vis0 = await page.locator('#qClear').isVisible();
  await page.evaluate(() => window.__ofm.setPlace(window.__ofm.placeHits('오사카성')[0])); await page.waitForTimeout(500);
  await page.locator('#q').fill('라멘'); await page.waitForTimeout(400);
  const b = await page.locator('#qClear').boundingBox(), qb = await page.locator('#q').boundingBox();
  const n1 = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).length);
  await page.locator('#qClear').click(); await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ q: document.querySelector('#q').value, S: window.__ofm.S.q, ref: window.__ofm.S.ref, place: window.__ofm.S.place && window.__ofm.S.place.name, focus: document.activeElement.id, vis: !document.querySelector('#qClear').hidden, n: window.__ofm.rows().filter(x => x.r).length }));
  check(!vis0 && b.width >= 44 && b.height >= 44 && b.x + b.width <= qb.x + qb.width && after.q === '' && after.S === '' && after.ref === 'place' && /오사카성/.test(after.place) && after.focus === 'q' && !after.vis && after.n > n1,
    '✕ (only shown with text) clears the search, keeps the picked place and puts the cursor back', JSON.stringify({ vis0, b, n1, after }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6g3. ◎ makes “내 위치” the reference again');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__ofm.setPlace(window.__ofm.placeHits('오사카성')[0])); await page.waitForTimeout(600);
  const a = await page.evaluate(() => ({ ref: window.__ofm.S.ref, pin: !!document.querySelector('.placePin') }));
  await page.locator('#locBtn').click(); await page.waitForTimeout(600);
  const b = await page.evaluate(() => ({ ref: window.__ofm.S.ref, pin: !!document.querySelector('.placePin'), opt: !!document.querySelector('#ref option[value=place]'), refText: document.querySelector('#refText').textContent, toast: window.__ofm.toasts.slice(-1)[0], first: window.__ofm.rows().find(x => x.r).d }));
  await page.evaluate(() => { const s = document.querySelector('#ref'); s.value = 'hotel'; s.dispatchEvent(new Event('change', { bubbles: true })); }); await page.waitForTimeout(300);
  await page.locator('#locBtn').click(); await page.waitForTimeout(400);
  const c = await page.evaluate(() => window.__ofm.S.ref);
  check(a.ref === 'place' && a.pin && b.ref === 'me' && !b.pin && !b.opt && /내 위치/.test(b.refText) && b.toast === '내 위치 기준으로 바꿨어요' && b.first < 1 && c === 'me', '◎ with a searched place (or the hotel) as reference goes back to “내 위치” and removes the place marker', JSON.stringify({ a, b, c }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6g4. “조건 N개 · 모두 지우기” line on top of a narrowed list');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const line = () => page.evaluate(() => { const c = document.querySelector('#list .conds'), b = c && c.querySelector('button').getBoundingClientRect(); return c ? { text: c.innerText.replace(/\s+/g, ' '), first: document.querySelector('#list').firstElementChild === c, h: b.height, w: b.width, vis: b.bottom <= innerHeight && b.top >= document.querySelector('#sheet').getBoundingClientRect().top } : null; });
  const none = await line();
  const sort0 = await page.evaluate(() => window.__ofm.S.sort);
  await page.locator('#openChip').click(); await page.waitForTimeout(200);
  await page.evaluate(() => { window.__ofm.S.f.card = true; window.__ofm.refresh(); });
  await page.locator('#catBar [data-cat="c-noodle"]').click(); await page.waitForTimeout(300);
  await page.evaluate(() => window.__ofm.setPlace(window.__ofm.placeHits('도톤보리')[0])); await page.waitForTimeout(500);
  await page.locator('#catBar [data-cat="c-noodle"]').click(); await page.waitForTimeout(300);   // setPlace reset the food type: pick it again
  await page.locator('#q').fill('라멘'); await page.waitForTimeout(400);
  await page.evaluate(() => window.__ofm.setSheet('half')); await page.waitForTimeout(400);
  const on = await line();
  await page.locator('#sort').selectOption('distance'); await page.waitForTimeout(300);
  await page.locator('#condsOff').click(); await page.waitForTimeout(500);
  const after = await page.evaluate(() => { const S = window.__ofm.S; return { q: S.q, box: document.querySelector('#q').value, card: S.f.card, open: S.openOnly, genre: S.genre, ref: S.ref, place: S.place, sort: S.sort, mode: S.mode, line: !!document.querySelector('#list .conds'), pin: !!document.querySelector('.placePin') }; });
  check(none === null && on && on.first && /조건 5개/.test(on.text) && on.h >= 44 && on.vis, 'with search, card filter, 영업 중만, food type and a picked place: “조건 5개 · 모두 지우기” tops the list (half sheet)', JSON.stringify({ none, on }));
  check(after.q === '' && after.box === '' && !after.card && !after.open && after.genre === 'all' && after.ref === 'me' && !after.place && !after.pin && after.sort === 'distance' && after.mode === 'shops' && !after.line, '“모두 지우기” clears them all, keeps the sort and the mode', JSON.stringify({ sort0, after }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6h. Map marker kinds and the 🛍 shopping view');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T15:00:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(600);
  const k = () => page.evaluate(() => ({ mode: window.__ofm.S.mode, it: document.querySelectorAll('.itPin').length, tag: document.querySelectorAll('.spin:not(.mini)').length, mini: document.querySelectorAll('.spin.mini').length,
    pins: document.querySelectorAll('.pin').length, tripB: document.querySelectorAll('.pin .tripB').length, hotel: getComputedStyle(document.querySelector('.hotelPin')).borderTopColor,
    rows: document.querySelectorAll('#list .sItem').length }));
  let m = await k();
  check(m.it >= 5 && m.tag === 0 && /251, 191, 36/.test(m.hotel), 'food map: itinerary places always shown as day-coloured circles; the hotel has a gold rim', JSON.stringify(m));
  await page.evaluate(() => window.__ofm.map().jumpTo({ center: [135.4985, 34.7025], zoom: 16 })); await page.waitForTimeout(900);
  m = await k();
  check(m.mini > 0 && m.tripB > 0, 'zoomed in: shopping places appear as small teal squares; restaurants on the itinerary carry a 🧳 badge', JSON.stringify(m));
  await page.locator('#shopChip').click(); await page.waitForTimeout(900);
  m = await k();
  const n = await page.evaluate(() => window.__ofm.SHOPS.length);
  check(m.mode === 'shopping' && m.rows === n && m.pins === 0 && m.it >= 5 && m.tag > 0, '🛍 쇼핑: shopping list and teal name tags, restaurant pins hidden, itinerary circles still shown', JSON.stringify({ ...m, n }));
  await page.evaluate(() => document.querySelector('[data-scat="dept"]').click()); await page.waitForTimeout(300);
  const dept = await page.evaluate(() => [...document.querySelectorAll('#list .sItem .imeta span:first-child')].map(e => e.textContent));
  check(dept.length >= 5 && dept.every(c => c === '백화점'), 'category tab “백화점” lists department stores only', String(dept.length));
  await page.evaluate(() => document.querySelector('[data-scat="trip"]').click()); await page.waitForTimeout(300);
  check(await page.evaluate(() => [...document.querySelectorAll('#list .sItem')].every(e => e.querySelector('.tripTag'))), 'tab “일정” lists the shopping places on our itinerary');
  await page.evaluate(() => document.querySelector('[data-scat="all"]').click()); await page.waitForTimeout(300);
  await page.locator('#q').fill('치이카와'); await page.waitForTimeout(500);
  const q = await page.evaluate(() => [...document.querySelectorAll('#list .sItem .iname span')].map(e => e.textContent));
  check(q.length >= 2 && q.every(t => /치이카와/.test(t)), 'search inside the shopping view (치이카와)', q.join(' / '));
  await page.locator('#q').fill(''); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#list .sItem').click()); await page.waitForTimeout(600);
  const d = await page.evaluate(() => ({ view: window.__ofm.S.view, dir: !!document.querySelector('#detail a.ab.primary[href*="maps/dir"]'), taxi: !!document.querySelector('#sTaxi'), hours: document.querySelectorAll('#detail .hoursT tr').length }));
  check(d.view === 'detail' && d.dir && d.taxi && d.hours === 3, 'a shopping place opens with directions, taxi card and Fri–Sun hours', JSON.stringify(d));
  await page.locator('#sTaxi').click(); await page.waitForTimeout(300);
  check(await page.evaluate(() => /大阪/.test(document.querySelector('#taxiAddr').textContent)), 'its taxi card shows the Japanese address');
  await page.goBack(); await page.waitForTimeout(300); await page.goBack(); await page.waitForTimeout(400);
  check(await page.evaluate(() => window.__ofm.S.mode === 'shopping' && window.__ofm.S.view === 'list'), 'Back closes the taxi card, then the shop page, staying in 🛍 쇼핑');
  await page.reload(); await ready(page); await page.waitForTimeout(800);
  check(await page.evaluate(() => window.__ofm.S.mode === 'shopping' && document.querySelectorAll('#list .sItem').length > 0) && log.errors.length === 0, 'reopening the app in 🛍 쇼핑 works');
  await page.goBack(); await page.waitForTimeout(500);
  m = await k();
  check(m.mode === 'shops' && m.rows === 0 && page.url().startsWith(URL0), 'Back from 🛍 쇼핑 returns to the restaurant list', JSON.stringify(m));
  check(log.errors.length === 0, 'no script errors in the shopping view', log.errors.slice(0, 2).join(' | '));
  await ctx.close();
}

console.log('6h2. Reopening the app: 🛍 쇼핑 only if it was left less than 10 minutes ago');
{
  const res = {};
  for (const [k, ago] of [['2min', 2], ['11min', 11], ['noStamp', null]]) {
    const { ctx, page, log } = await newPhone({ clock: '2026-11-14T12:30:00+09:00', tz: 'Asia/Tokyo' });
    await ctx.addInitScript(ago => { if (sessionStorage.getItem('s')) return; sessionStorage.setItem('s', 1); localStorage.setItem('ofm.mode', '"shopping"'); if (ago != null) localStorage.setItem('ofm.modeAt', String(Date.now() - ago * 60000)); else localStorage.removeItem('ofm.modeAt'); }, ago);
    await page.goto(URL0); await ready(page); await page.waitForTimeout(500);
    res[k] = await page.evaluate(() => ({ mode: window.__ofm.S.mode, items: document.querySelectorAll('#list .item:not(.sItem)').length, shops: document.querySelectorAll('#list .sItem').length }));
    if (log.errors.length) res[k].err = log.errors[0];
    await ctx.close();
  }
  check(res['2min'].mode === 'shopping' && res['2min'].shops > 0 && res['11min'].mode === 'shops' && res['11min'].items > 0 && res['noStamp'].mode === 'shops' && !Object.values(res).some(x => x.err), '🛍 쇼핑 reopens only if left less than 10 minutes ago; otherwise the food list', JSON.stringify(res));
}

console.log('6d. Back button (Android back / iOS swipe) never leaves the app by surprise');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T13:20:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page);
  const inApp = () => page.url().startsWith(URL0);
  const st = () => page.evaluate(() => ({ mode: window.__ofm.S.mode, view: window.__ofm.S.view, modals: [...document.querySelectorAll('.modal')].filter(m => !m.hidden).map(m => m.id), big: !document.querySelector('#phraseBig').hidden }));
  const back = async () => { await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await page.waitForTimeout(400); return inApp() ? await st() : 'LEFT'; };
  await page.locator('#tripChip').click(); await page.waitForTimeout(500);
  let r = await back();
  check(r !== 'LEFT' && r.mode === 'shops', 'Back from 🧳 일정 returns to the shop list', JSON.stringify(r));
  await page.locator('#menuBtn').click(); await page.waitForTimeout(300); await page.locator('#phraseBtn').click(); await page.waitForTimeout(400);
  r = await back();
  check(r !== 'LEFT' && !r.modals.length, '⋯ → 회화 카드 → Back closes the card and stays in the app', JSON.stringify(r));
  await page.locator('#menuBtn').click(); await page.waitForTimeout(300); await page.locator('#phraseBtn').click(); await page.waitForTimeout(400);
  await page.locator('#phraseList .phr').first().click(); await page.waitForTimeout(300);
  r = await back();
  const r2 = r !== 'LEFT' ? await back() : 'LEFT';
  check(r !== 'LEFT' && !r.big && r.modals.includes('phrases') && r2 !== 'LEFT' && !r2.modals.length, 'big phrase card → Back → Back: big card, then the phrase list, without leaving', JSON.stringify([r, r2]));
  await page.locator('#menuBtn').click(); await page.waitForTimeout(300); await page.locator('#locHelpBtn').click(); await page.waitForTimeout(400);
  r = await back();
  check(r !== 'LEFT' && !r.modals.length, '⋯ → 내 위치 도움말 → Back closes it and stays in the app', JSON.stringify(r));
  await page.locator('#tripChip').click(); await page.waitForTimeout(500);
  await page.locator('#filterChip').click(); await page.waitForTimeout(500);
  r = await back();
  check(r !== 'LEFT' && r.mode === 'shops' && !r.modals.length, '일정 → 필터 (switches to shops) → Back closes the filters only', JSON.stringify(r));
  await page.locator('#tripChip').click(); await page.waitForTimeout(500);
  await page.evaluate(() => window.__ofm.openTripStop('sat', 'f3')); await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('.tStop.open .tAlt [data-shop]').click()); await page.waitForTimeout(500);
  r = await back(); const r3 = r !== 'LEFT' ? await back() : 'LEFT';
  check(r !== 'LEFT' && r.mode === 'trip' && r.view === 'list' && r3 !== 'LEFT' && r3.mode === 'shops', '일정 → 가게 정보 → Back → Back: the itinerary, then the shop list', JSON.stringify([r, r3]));
  await page.locator('#q').fill('라멘'); await page.waitForTimeout(500);
  check(await page.evaluate(() => window.__ofm.sheetState()) === 'full', 'typing a search opens the list fully so results stay above the keyboard');
  check(log.errors.length === 0, 'no script errors while going back and forth', log.errors.slice(0, 2).join(' | '));
  await page.locator('#q').fill(''); await page.waitForTimeout(300);
  check(await back() === 'LEFT', 'with everything closed, Back leaves the page (no dead Back presses piled up)');
  await ctx.close();
}

console.log('6p. Polish: Korean line breaking, pressed feedback, no doubled empty message, shop name in the slim header (A3-1…3)');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(400);
  const wb = await page.evaluate(() => ({ body: getComputedStyle(document.body).wordBreak, ja: getComputedStyle(document.querySelector('[lang=ja]')).wordBreak, hs: document.documentElement.scrollWidth > innerWidth }));
  check(wb.body === 'keep-all' && wb.ja === 'normal' && !wb.hs, 'Korean words are not split (keep-all), Japanese may wrap anywhere', JSON.stringify(wb));
  const b = await page.locator('#openChip').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(150);
  const tr = await page.evaluate(() => getComputedStyle(document.querySelector('#openChip')).transform); await page.mouse.up();
  check(tr && tr !== 'none', 'a pressed chip shows feedback (scales down)', tr);
  const far = await page.evaluate(() => { const O = window.__ofm, p = O.PLACES.find(p => !APP_DATA.restaurants.some(r => r.lat != null && Math.max(1, Math.round(Math.hypot(r.lat - p.lat, (r.lon - p.lon) * 0.82) * 111 * 1.3 / 4.5 * 60)) <= 22)); O.setPlace(p); return p.ko; });
  await page.evaluate(() => window.__ofm.setSheet('full')); await page.waitForTimeout(500);
  const n = await page.evaluate(() => (document.querySelector('#list').innerText.match(/도보 20분 안에는/g) || []).length);
  check(n === 1, 'a place with nothing within a 20-min walk says so once (not twice)', `${far}: ${n}`);
  await page.evaluate(() => { window.__ofm.clearPlace(); window.__ofm.enterShop(true); }); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#list .sItem').click()); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__ofm.setSheet('full'); const b = document.querySelector('#sheetBody'); b.scrollTop = 400; b.dispatchEvent(new Event('scroll')); }); await page.waitForTimeout(300);
  const mini = await page.evaluate(() => ({ name: document.querySelector('#dMiniName').textContent, title: document.querySelector('#detail .dName').textContent }));
  check(mini.name && mini.title.includes(mini.name), 'a scrolled 🛍 shop page shows the shop name in the slim header', JSON.stringify(mini));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6q. Polish: larger score, my-location dot above every marker, 320 px selectors (A3-4, A3-5, A3-10)');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1500);
  const a = await page.evaluate(() => { const rt = document.querySelector('#list .item .imeta .rt'), im = rt.closest('.imeta'), me = document.querySelector('.meWrap'), z = e => parseInt(getComputedStyle(e).zIndex) || 0;
    const others = [...document.querySelectorAll('.mk:not(.meWrap)')].map(z); return { rt: getComputedStyle(rt).fontSize, imeta: Math.round(im.getBoundingClientRect().height), meZ: z(me), maxOther: Math.max(...others), dot: Math.round(document.querySelector('.meWrap .me').getBoundingClientRect().width) }; });
  check(a.rt === '15px' && a.imeta <= 20 && a.meZ > a.maxOther && a.dot >= 22, 'score 15px without a taller line; the my-location dot (22px, ringed) is above every other marker', JSON.stringify(a));
  await ctx.close();
}
{
  const { ctx, page } = await newPhone({ device: devices['iPhone SE'], geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1200);
  const m = await page.evaluate(() => ({ row: Math.round(document.querySelector('.headRow').getBoundingClientRect().height), gaps: ['#refMini', '#sortMini'].map(s => { const l = document.querySelector(s), t = l.querySelector('span').getBoundingClientRect(), c = getComputedStyle(l, '::after'); return Math.round(l.getBoundingClientRect().right - parseFloat(c.right) - 9 - t.right); }) }));
  check(m.row <= 44 && m.gaps.every(g => g >= 2), '320 px: the 기준/정렬 selectors keep a gap before their caret, on one row', JSON.stringify(m));
  await ctx.close();
}

console.log('6r. Microcopy: 줄 chips, 마지막 주문, payment in words, 이걸로 바꾸기, 해요체 (A3-6)');
{
  const { ctx, page, log } = await newPhone({ device: devices['iPhone SE'], geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 20 }, clock: '2026-11-13T13:20:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1200);
  await page.evaluate(() => window.__ofm.setSheet('full')); await page.waitForTimeout(300);
  const list = await page.evaluate(() => document.querySelector('#list').innerText);
  check(/줄 (김|보통|짧음)/.test(list) && !/대기 (김|보통|짧음|없음)/.test(list), 'list rows: “줄 김 / 줄 보통 / 줄 짧음” chips (no “대기 김”)');
  const id = await page.evaluate(() => APP_DATA.restaurants.find(r => r.lat != null && /L\.\s?O\./.test(r.hoursNote || '') && r.pay && r.pay.card != null && !r.pay.cashOnly && (r.pay.card || r.pay.emoney || r.pay.qr)).id);
  await page.evaluate(id => window.__ofm.select(id), id); await page.waitForTimeout(500);
  await page.locator('#crowdBtn').click(); await page.waitForTimeout(300);
  const d = await page.evaluate(() => document.querySelector('#detail').innerText);
  check(/마지막 주문/.test(d) && !/L\.\s?O\./.test(d) && /카드 (가능|불가|모름) · 교통카드 (가능|불가|모름) · QR (가능|불가|모름)/.test(d) && !/[○✕]/.test(d) && !/대기 (김|보통|짧음|없음)/.test(d), 'shop page: “마지막 주문” instead of L.O., “카드 가능 · 교통카드 불가 · QR 모름” wording, 줄 chips in the alternatives', String(id));
  await page.evaluate(() => { window.__ofm.closeDetail(); window.__ofm.enterTrip(); window.__ofm.openTripStop('fri', 's8'); }); await page.waitForTimeout(600);
  const sw = await page.evaluate(() => { const b = document.querySelector('.tStop.open .tSwap').getBoundingClientRect(), row = document.querySelector('.tStop.open .tAlt').getBoundingClientRect(); return { t: document.querySelector('.tStop.open .tSwap').textContent, h: Math.round(b.height), inRow: b.right <= row.right + 1, tips: document.querySelector('.tStop.open .tTips') ? document.querySelector('.tStop.open .tTips').innerText : '' }; });
  check(sw.t === '이걸로 바꾸기' && sw.h >= 44 && sw.inRow && !/L\.O\./.test(sw.tips), '320 px itinerary: “이걸로 바꾸기” fits its row (≥44px); stop tips say 마지막 주문', JSON.stringify({ ...sw, tips: sw.tips.slice(0, 60) }));
  const menu = await page.evaluate(() => document.querySelector('#menu').innerText + document.querySelector('#locHelp').innerText);
  check(!/[습합]니다|입니다|있습니다|됩니다/.test(menu), 'menu and location help read in 해요체');
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6s. 🗣 on the shop page, labelled menu button, menu order, hotel taxi card, hotel popup (A3-7, A3-8)');
{
  const { ctx, page, log } = await newPhone({ device: devices['iPhone SE'], clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(800);
  const box = s => page.evaluate(s => { const e = document.querySelector(s), b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), t: e.textContent.trim(), tag: e.tagName }; }, s);
  // shop page: 🗣 after 🚕, opens the existing phrase card; reachable by keyboard
  await page.evaluate(() => window.__ofm.select(window.__ofm.rows().find(x => x.r).r.id)); await page.waitForTimeout(500);
  const ab = await page.evaluate(() => [...document.querySelectorAll('#detail .abar .ab')].map(e => e.id || e.textContent.trim()));
  const pb = await box('#phraseBtn3');
  await page.focus('#phraseBtn3'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  const ph = await page.evaluate(() => !document.querySelector('#phrases').hidden && document.querySelectorAll('#phraseList .phr').length);
  check(ab.indexOf('phraseBtn3') === ab.indexOf('taxiBtn') + 1 && pb.h >= 44 && pb.w >= 44 && ph > 5, 'shop page: 🗣 회화 카드 right after 🚕 택시 (≥44px, Enter opens the phrase card)', JSON.stringify({ pb, ph }));
  await page.goBack(); await page.waitForTimeout(300); await page.evaluate(() => window.__ofm.closeDetail()); await page.waitForTimeout(200);
  // ⋯ menu: labelled button; legend above the map settings; map list folded; hotel taxi card
  const mb = await box('#menuBtn');
  await page.locator('#menuBtn').click(); await page.waitForTimeout(300);
  const m = await page.evaluate(() => { const hs = [...document.querySelectorAll('#menu h3')].map(h => h.textContent); const det = document.querySelector('#menu details.provDet'); return { hs, legendFirst: hs.findIndex(t => /표시 읽는 법/.test(t)) < hs.findIndex(t => t === '지도'), folded: !!det && !det.open && det.contains(document.querySelector('#providers')), sum: det && Math.round(det.querySelector('summary').getBoundingClientRect().height) }; });
  check(mb.t === '메뉴' && mb.h >= 44 && m.legendFirst && m.folded && m.sum >= 44, 'menu button says “메뉴”; inside, 📖 표시 읽는 법 comes before the map settings and the map list folds under “지도 종류 바꾸기”', JSON.stringify({ mb, m }));
  const tb = await box('#hotelTaxiBtn');
  await page.focus('#hotelTaxiBtn'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  const tx = await page.evaluate(() => ({ open: !document.querySelector('#taxi').hidden, menu: !document.querySelector('#menu').hidden, name: document.querySelector('#taxiName').textContent, addr: document.querySelector('#taxiAddr').textContent }));
  await page.goBack(); await page.waitForTimeout(400);
  const back = await page.evaluate(() => [...document.querySelectorAll('.modal')].filter(m => !m.hidden).map(m => m.id));
  check(tb.h >= 44 && tx.open && !tx.menu && /リーガロイヤル/.test(tx.name) && /中之島5-3-68/.test(tx.addr) && back.length === 0 && page.url().startsWith(URL0), '⋯ → 🚕 호텔 택시 카드 (keyboard): the hotel’s existing taxi card; Back closes it', JSON.stringify({ tb, tx, back }));
  // ⌂ hotel popup: close button clear of the chips; its taxi card button
  await page.evaluate(() => window.__ofm.setSheet('peek')); await page.waitForTimeout(300);
  await page.locator('#hotelBtn').click(); await page.waitForTimeout(1500);
  const pop = await page.evaluate(() => { const x = document.querySelector('.maplibregl-popup-close-button'), t = document.querySelector('[data-hoteltaxi]'), chips = document.querySelector('#chips').getBoundingClientRect().bottom;
    if (!x || !t) return null; const xb = x.getBoundingClientRect(), tb = t.getBoundingClientRect(), hit = document.elementFromPoint(xb.left + xb.width / 2, xb.top + xb.height / 2); return { xTop: Math.round(xb.top), chips: Math.round(chips), xFree: x.contains(hit), tH: Math.round(tb.height) }; });
  check(pop && pop.xTop > pop.chips && pop.xFree && pop.tH >= 44, '⌂ hotel popup: its close button is below the chip row and tappable; 🚕 호텔 택시 카드 button ≥44px', JSON.stringify(pop));
  await page.locator('[data-hoteltaxi]').click(); await page.waitForTimeout(400);
  check(await page.evaluate(() => !document.querySelector('#taxi').hidden && /リーガロイヤル/.test(document.querySelector('#taxiName').textContent)), '… which opens the same hotel taxi card');
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('6t. Icon emoji in colour (A3-9)');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(400);
  const t = await page.evaluate(() => ['#shopChip', '#filterChip', '#genreChip'].map(s => document.querySelector(s).textContent).concat(document.querySelector('#catBar .cat').textContent));
  check(t.every(x => /\uFE0F/.test(x)), 'icon emoji carry U+FE0F so they draw in colour like 🧳 (🛍 ⚙ 🍽)', JSON.stringify(t));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('7. Tile server failures');
{
  const { ctx, page, log } = await newPhone({ tiles: { ofm: 'fail' } });
  await page.goto(URL0); await page.waitForTimeout(3000);
  check((await appState(page)).provider === 'gsi', 'Korean map down → Japanese GSI map', JSON.stringify(log.tiles));
  check((await page.evaluate(() => window.__ofm.toasts.join(' | '))).includes('한글 지도를 불러오지 못해'), 'explains the switch');
  await ctx.close();
}
{
  const { ctx, page } = await newPhone({ tiles: { ofm: 'fail', gsi: 'fail', osm: 'fail', esri: 'fail' } });
  await page.goto(URL0); await page.waitForTimeout(4000);
  check(await page.locator('#mapStatus').isVisible(), 'all servers down → message with retry button (no fake map)');
  check((await appState(page)).rows.length === await page.evaluate(() => window.__ofm.shownCount()), 'list still works without tiles');
  await page.screenshot({ path: join(SHOTS, '07_iphone_tiles_down.png') });
  await ctx.close();
}
{
  const { ctx, page } = await newPhone({ tiles: { ofm: 4000 } });
  await page.goto(URL0); await page.waitForTimeout(16000);
  const ok = await page.evaluate(() => window.__ofm.tiles().ok);
  check((await appState(page)).provider === 'ko' && ok > 0 && !(await page.locator('#mapStatus').isVisible()), 'slow Korean map (4 s per request) → waits, no switch, map appears', `${ok} tiles`);
  await ctx.close();
}

console.log('8. Desktop and small phone layouts');
{
  const { ctx, page, log } = await newPhone({ device: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, '08_desktop.png') });
  check(log.errors.length === 0, 'desktop: no JS errors', log.errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page, log } = await newPhone({ device: devices['iPhone SE'] });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1200);
  const pct = await page.evaluate(() => Math.round((document.querySelector('#sheet').getBoundingClientRect().top - document.querySelector('#topbar').getBoundingClientRect().bottom) / innerHeight * 100));
  check(pct >= 45, 'iPhone SE: map area with sheet collapsed', pct + '%');
  await page.screenshot({ path: join(SHOTS, '09_iphone_se.png') });
  check(log.errors.length === 0, 'iPhone SE: no JS errors', log.errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page, log } = await newPhone({ device: devices['Pixel 7'], geo: { latitude: 34.7025, longitude: 135.4959, accuracy: 40 } });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1200);
  const st = await appState(page);
  check(st.rows.slice(0, 5).every(r => r.region === 'north'), 'Android at Osaka Station: Umeda places first');
  await page.screenshot({ path: join(SHOTS, '10_android_umeda.png') });
  check(log.errors.length === 0, 'Android: no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('9. Service worker: app opens with no connection');
{
  const { ctx, page } = await newPhone({ sw: true });
  await page.goto(URL0);
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(() => {});
  await page.reload(); await page.waitForTimeout(800);
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.reload().catch(() => {}); await page.waitForTimeout(1500);
  const n = await page.evaluate(() => document.querySelectorAll('.item').length ? window.__ofm.rows().filter(x => x.r).length : 0).catch(() => 0);
  const shownN = await page.evaluate(() => window.__ofm.shownCount()).catch(() => -1);
  check(controlled && n > 0 && n === shownN, 'offline reload still shows every restaurant', `controlled=${controlled}, items=${n}/${shownN}`);
  await ctx.close();
}

console.log('9b. New version while a shop page is open: reload waits until the page is hidden');
{
  const { ctx, page, log } = await newPhone({ sw: true, clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0);
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
  await page.reload(); await ready(page); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__marker = 1; window.__ofm.select(window.__ofm.rows().find(x => x.r).r.id); navigator.serviceWorker.addEventListener('controllerchange', () => { window.__cc = 1; }); });
  // a new version is deployed: a service worker under a new script URL takes over (skipWaiting + clients.claim → controllerchange)
  await page.evaluate(() => navigator.serviceWorker.register('sw.js?e2e-next').catch(e => { window.__regErr = String(e); }));
  await page.waitForFunction(() => window.__cc, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const a = await page.evaluate(() => ({ cc: !!window.__cc, marker: window.__marker || null, view: window.__ofm.S.view }));
  check(a.cc && a.marker === 1 && a.view === 'detail', 'new version installed while a shop page is open: no reload, the page stays', JSON.stringify(a));
  const nav = page.waitForEvent('load', { timeout: 10000 }).then(() => true).catch(() => false);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });   // the user switches apps (headless pages cannot really be hidden)
  const reloaded = await nav; await ready(page);
  const b = await page.evaluate(() => ({ marker: window.__marker || null, ready: !!(window.__ofm && window.__ofm.ready()) }));
  check(reloaded && b.marker === null && b.ready, 'once the page is hidden it reloads into the new version', JSON.stringify({ reloaded, ...b }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('10. Saved map works with no connection (service worker)');
{
  const { ctx, page } = await newPhone({ sw: true });
  await page.goto(URL0);
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
  await page.reload(); await ready(page);
  await page.locator('#menuBtn').click();
  await page.locator('#precacheBtn').click();
  await page.waitForFunction(() => /저장 완료|실패/.test(document.querySelector('#precacheText').textContent), null, { timeout: 90000 }).catch(() => {});
  const txt = await page.locator('#precacheText').innerText();
  check(txt.includes('저장 완료'), 'map pre-save finished', txt);
  await ctx.setOffline(true);
  await page.reload().catch(() => {}); await ready(page); await page.waitForTimeout(2500);
  const off = await page.evaluate(() => ({ prov: window.__ofm.provider(), ok: window.__ofm.tiles().ok, ready: window.__ofm.ready() }));
  check(off.ready && off.prov === 'ko' && off.ok > 0, 'offline: Korean map still draws from saved tiles', JSON.stringify(off));
  await page.screenshot({ path: join(SHOTS, '11_offline_saved_map.png') });
  await ctx.close();
}

console.log('10b. Offline at start, back online, corrupted storage, pre-save areas');
{ // (a) phone offline at start, Google script would hang: backup map at once; (b) back online → Google tried again
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  let gm = 0; await ctx.route(/maps\.googleapis\.com\/maps\/api\/js/, () => { gm++; });   // never answers (weak signal)
  await ctx.addInitScript(() => { window.__on = false; Object.defineProperty(Navigator.prototype, 'onLine', { get: () => window.__on, configurable: true }); });
  const t0 = Date.now(); await page.goto(URL0);
  await page.waitForFunction(() => window.__ofm && window.__ofm.engine() === 'ml', null, { timeout: 20000 }).catch(() => {});
  const ms = Date.now() - t0, st = await page.evaluate(() => ({ e: window.__ofm.engine(), why: window.__ofm.gmFail(), toast: window.__ofm.toasts.join(' | ') }));
  check(st.e === 'ml' && st.why === 'offline' && ms < 4000 && gm === 0 && /인터넷이 끊겨/.test(st.toast), 'offline at start: backup map right away (no 12–15 s wait for Google)', JSON.stringify({ ms, gm, ...st }));
  await page.evaluate(() => { window.__on = true; window.dispatchEvent(new Event('online')); }); await page.waitForTimeout(600);
  check(gm === 1 && await page.evaluate(() => window.__ofm.gmFail()) == null, 'back online: Google map is tried again', JSON.stringify({ gm }));
  await page.evaluate(() => { window.__on = false; window.dispatchEvent(new Event('offline')); window.__on = true; window.dispatchEvent(new Event('online')); }); await page.waitForTimeout(600);   // a blip while Google is (re)loading
  check(gm === 1, 'a second online event while Google is already being used does not start another Google load', JSON.stringify({ gm }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}
{ // (d) corrupted saved values do not stop the app; (c) pre-save covers Shinsekai–Tennoji and Osaka Castle too
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', 1); localStorage.setItem('ofm.fav.v5', '5'); localStorage.setItem('ofm.tripSwap.v1', 'null'); localStorage.setItem('ofm.tripCheck.v1', '[1,2]'); } });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(500);
  await page.locator('#tripChip').click(); await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({ ready: window.__ofm.ready(), rows: document.querySelectorAll('.tStop, .item').length, mode: window.__ofm.S.mode, fav: window.__ofm.fav.size }));
  check(r.ready && r.mode === 'trip' && r.rows > 0 && log.errors.length === 0, 'corrupted 찜 / itinerary values in storage: the app still starts and the itinerary opens', JSON.stringify(r) + ' ' + log.errors.slice(0, 1).join(''));
  const t = await page.evaluate(() => { const U = window.__ofm.tileUrls('gsi'), has = (lat, lon) => { const z = 16, n = 2 ** z, s = Math.sin(lat * Math.PI / 180), x = Math.floor((lon + 180) / 360 * n), y = Math.floor((.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); return U.some(u => u.endsWith(`/${z}/${x}/${y}.png`)); };
    return { n: U.length, tsutenkaku: has(34.6525, 135.5063), tennoji: has(34.6465, 135.5135), castle: has(34.6873, 135.5262), morinomiya: has(34.6806, 135.5340) }; });
  check(t.n === 662 && t.tsutenkaku && t.tennoji && t.castle && t.morinomiya, 'map pre-save also covers Shinsekai/Tsutenkaku–Tennoji and Osaka Castle–Morinomiya', JSON.stringify(t));
  await ctx.close();
}

console.log('11. Google rejects the key (gm_authFailure)');
{
  const { ctx, page, log } = await newPhone({ google: 'authfail' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(800);
  const st = await page.evaluate(() => ({ engine: window.__ofm.engine(), why: window.__ofm.gmFail(), prov: window.__ofm.provider(), ok: window.__ofm.tiles().ok }));
  check(st.engine === 'ml' && st.why === 'auth' && st.prov === 'ko' && st.ok > 0, 'auth failure → Korean OpenFreeMap map', JSON.stringify(st));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('11b. Google ratings failing (quota): no retry storm, the list says so');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await ctx.addInitScript(() => {   // a stand-in Places library that always fails (quota); never reaches Google
    window.__pl = 0; class Place { constructor(o) { this.id = o.id; } async fetchFields() { window.__pl++; throw new Error('MapsRequestError: PLACES_GET_PLACE: RESOURCE_EXHAUSTED'); } }
    window.google = { maps: { OverlayView: function () {}, importLibrary: async n => { if (n === 'places') return { Place }; throw new Error('no ' + n); } } };
  });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__ofm.S.gmFail = null; });   // as if the map loaded but Places calls fail
  await page.locator('#sort').selectOption('google'); await page.waitForTimeout(800);
  const d0 = await page.evaluate(() => window.__pl);
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__ofm.minuteTick()); await page.evaluate(() => window.__ofm.refresh()); await page.waitForTimeout(150); }
  const r = await page.evaluate(() => ({ n: window.__pl, hint: document.querySelector('#list .hint').textContent, more: !!document.querySelector('#gMore') }));
  check(d0 > 0 && d0 <= 20 && r.n === d0 && /구글 정보를 불러오지 못했어요/.test(r.hint) && !/불러오는 중/.test(r.hint) && !r.more, 'Places failing: one batch, then no retries on later refreshes, and the list says it could not load', JSON.stringify({ d0, ...r }));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

{ // the shop page asks Google for its own full-size photo (sharp on 3x phones), not the small list thumbnail
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T17:40:00+09:00', tz: 'Asia/Tokyo' });
  await ctx.addInitScript(() => {   // stand-in Places library (never reaches Google); photo URLs record the size asked for
    class Place { constructor(o) { this.id = o.id; } async fetchFields() { this.rating = 4.2; this.userRatingCount = 10; this.photos = [{ authorAttributions: [{ displayName: 't' }], getURI: o => { (window.__uris = window.__uris || []).push(o); return 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='; } }]; } async isOpen() { return true; } }
    window.google = { maps: { OverlayView: function () {}, importLibrary: async n => { if (n === 'places') return { Place }; throw new Error('no ' + n); } } };
  });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__ofm.S.gmFail = null; const r = window.__ofm.rows().find(x => x.r && x.r.placeId).r; window.__ofm.select(r.id); }); await page.waitForTimeout(800);
  const asked = await page.evaluate(() => ({ uris: window.__uris || [], shown: !!document.querySelector('#photos [data-g] img') }));
  check(asked.shown && asked.uris.some(o => o.maxHeight === 400), 'shop page photo is requested at full size (maxHeight 400)', JSON.stringify(asked));
  await ctx.close();
}

console.log('12. Real Google Maps (best effort, never fails the suite)');
{
  const { ctx, page, log } = await newPhone({ google: 'real' });
  // serve this build at the real site address so Google sees the allowed referrer (the key only accepts vawkdh-job.github.io)
  const SITE = 'https://vawkdh-job.github.io/osaka-food-map/';
  await ctx.route(SITE + '**', route => { let p = new URL(route.request().url()).pathname.replace('/osaka-food-map', '') || '/'; if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p); if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) }); });
  await page.goto(SITE);
  await page.waitForFunction(() => window.__ofm && (window.__ofm.ready() || window.__ofm.gmFail()), null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const st = await page.evaluate(() => { const a = window.__ofm, m = a.map(); const out = { engine: a.engine(), why: a.gmFail() || null, ready: a.ready(), prov: a.provider() };
    if (a.engine() === 'gm' && a.ready()) { const errs = [], c = m.getContainer().getBoundingClientRect();
      for (const [, p] of a.markers) { if (!p.on) continue; const r = p.el.getBoundingClientRect(), q = m.project([p.r.lon, p.r.lat]);
        errs.push(Math.hypot(r.left - c.left - q.x - (p.m.getOffset().x || 0), r.top - c.top - q.y)); }
      out.pins = errs.length; out.maxErr = Math.max(0, ...errs); out.errCard = !!document.querySelector('#gm .gm-err-container,#gm .dismissButton');
      out.logo = !!document.querySelector('#gm a[href*="maps.google.com"], #gm img[alt="Google"]');
      const g = m.getContainer().getBoundingClientRect(), sh = document.querySelector('#sheet').getBoundingClientRect(); out.mapBottom = Math.round(g.bottom); out.sheetTop = Math.round(sh.top); }
    return out; });
  console.log('  ℹ real Google:', JSON.stringify(st), 'google requests', log.google.n);
  await page.screenshot({ path: join(SHOTS, '12_real_google.png') });
  if (st.engine === 'gm' && st.ready) {
    await page.locator('#locBtn').count();
    const it = page.locator('.item').first(); await it.click(); await page.waitForTimeout(1500);
    const vis = await page.evaluate(() => { const p = document.querySelector('.pin.sel'); if (!p) return null; const r = p.getBoundingClientRect();
      return { y: Math.round(r.bottom), top: Math.round(document.querySelector('#topbar').getBoundingClientRect().bottom), sheet: Math.round(document.querySelector('#sheet').getBoundingClientRect().top) }; });
    console.log('  ℹ real Google selected pin:', JSON.stringify(vis));
    await page.waitForFunction(() => /실시간|불러오지 못함/.test((document.querySelector('#gCount') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
    const live = await page.evaluate(() => ({ score: document.querySelector('#gScore b')?.textContent, count: document.querySelector('#gCount')?.textContent,
      open: document.querySelector('#gOpen')?.textContent, live: (document.querySelector('#gLive')?.innerText || '').slice(0, 160), photo: !!document.querySelector('#gLive .gPhoto img'),
      photoOk: (() => { const i = document.querySelector('#gLive .gPhoto img'); return i ? i.complete && i.naturalWidth > 0 : null })() }));
    console.log('  ℹ real Google live details:', JSON.stringify(live));
    if (process.env.GOOGLE_SORT === '1') { // 20 Places requests from the trip budget: opt-in only
      await page.evaluate(() => window.__ofm.closeDetail()); await page.locator('#sort').selectOption('google');
      await page.waitForFunction(() => window.__ofm.gCache.size >= 20, null, { timeout: 25000 }).catch(() => {}); await page.waitForTimeout(1500);
      const gs = await page.evaluate(() => { const v = window.__ofm.rows().filter(x => x.r && window.__ofm.gRating(x.r) != null).map(x => window.__ofm.gRating(x.r)); return { loaded: window.__ofm.gCache.size, sorted: v.every((x, i) => !i || x <= v[i - 1]), top: v.slice(0, 5) }; });
      console.log('  ℹ real Google sort:', JSON.stringify(gs));
    }
    await page.evaluate(() => document.querySelector('#gLive')?.scrollIntoView()); await page.waitForTimeout(1500);
    await page.screenshot({ path: join(SHOTS, '14_real_google_live.png') });
    await page.screenshot({ path: join(SHOTS, '13_real_google_detail.png') });
    // reused pins must not pile up listeners each time they are shown again (food type / itinerary switches)
    await page.evaluate(() => window.__ofm.closeDetail());
    const cdp = await ctx.newCDPSession(page); await cdp.send('Performance.enable');
    const L = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSEventListeners').value; };
    const cycle = async () => { await page.evaluate(() => { window.__ofm.enterTrip(); window.__ofm.exitTrip(); }); await page.waitForTimeout(400); };
    await cycle(); const l0 = await L(); for (let i = 0; i < 5; i++) await cycle(); const l1 = await L();
    check(l1 - l0 <= 5, 'real Google: entering/leaving 일정 does not pile up event listeners', `${l0} → ${l1} after 5 cycles`);
  }
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
