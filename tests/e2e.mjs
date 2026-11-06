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

console.log('3. Location in Seoul (testing before the trip)');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 37.5665, longitude: 126.978, accuracy: 30 } });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(1200);
  const st = await appState(page);
  check(!!st.me && st.ref === 'hotel', 'location shown but distances stay hotel-based');
  check((await page.evaluate(() => window.__ofm.toasts.join(' | '))).includes('오사카에서 약'), 'explains it will switch once in Osaka');
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
      return { far: shown.filter(r => !O.nearRef(r) && !O.fav.has(r.id)).length, near: inT.filter(r => O.nearRef(r)).length, nearShown: shown.filter(r => O.nearRef(r)).length }; }); });
  check(perCat.every(x => x.far <= 10 && x.near === x.nearShown), 'food types: every shop within a 20-min walk + at most 10 best-rated farther away', perCat.map(x => `${x.nearShown}+${x.far}`).join(','));
  // expand to every shop and back
  await page.locator('#filterChip').click(); await page.locator('#filterReset').click(); await page.locator('#filterApply').click(); await page.waitForTimeout(200);
  const shown0 = (await appState(page)).rows.length;
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
  await page.locator('#q').fill('이치란'); await page.waitForTimeout(400);
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
  check(!/ 0m\b|· 0m/.test(dist), 'map-centre distance stays put while a shop is open', dist);
  await ctx.close();
}

console.log('6c. Travel itinerary');
{
  const { ctx, page, log } = await newPhone({ clock: '2026-11-13T13:20:00+09:00', tz: 'Asia/Tokyo' });
  await page.goto(URL0); await ready(page);
  await page.locator('#tripChip').click(); await page.waitForTimeout(900);
  const t = await page.evaluate(() => ({ mode: window.__ofm.S.mode, day: window.__ofm.S.tripDay, stops: document.querySelectorAll('.tStop').length, pins: document.querySelectorAll('.tpin').length,
    lines: ((window.__ofm.glStyle() || { layers: [] }).layers || []).filter(l => /^tripline/.test(l.id)).length, now: (document.querySelector('.tNow') || {}).innerText || '' }));
  check(t.mode === 'trip' && t.day === 'fri' && t.stops === 7 && t.pins === 7, '🧳 일정 opens today (Fri) with its 7 stops and numbered pins', JSON.stringify({ ...t, now: undefined }));
  check(t.lines >= 4, 'route lines drawn between the stops', String(t.lines));
  check(/지금[\s\S]*이치란[\s\S]*다음[\s\S]*기타하마/.test(t.now), 'now/next card at Fri 13:20: now Ichiran, next Kitahama', t.now.replace(/\s+/g, ' ').slice(0, 120));
  await page.locator('.tStop').nth(2).click(); await page.waitForTimeout(400);
  const dir = await page.locator('.tStop.open a.tBtn.primary').getAttribute('href');
  check(/maps\/dir\/\?api=1.*destination=34\.7/.test(dir), 'a stop expands with a Google Maps directions link', dir.slice(0, 90));
  const alts = await page.locator('.tStop.open .tAlt').count();
  check(alts > 0, 'a meal stop lists nearby alternatives open at that time', String(alts));
  await page.locator('.tStop.open .tSwap').first().click(); await page.waitForTimeout(300);
  const sw = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('ofm.tripSwap.v1') || '{}')));
  check(sw.includes('f3'), '“이걸로” swaps the meal and remembers it on the phone', sw.join(','));
  await page.locator('.tStop.open [data-unswap]').click(); await page.waitForTimeout(300);
  check(await page.evaluate(() => !Object.keys(JSON.parse(localStorage.getItem('ofm.tripSwap.v1') || '{}')).length), '“되돌리기” restores the planned place');
  await page.locator('[data-tday="all"]').click(); await page.waitForTimeout(700);
  const all = await page.evaluate(() => ({ pins: document.querySelectorAll('.tpin').length, days: document.querySelectorAll('.oDay').length, checks: document.querySelectorAll('[data-check]').length }));
  check(all.pins === 21 && all.days === 4 && all.checks >= 5, '전체: all three days on the map, overview and checklist', JSON.stringify(all));
  await page.locator('#tripChip').click(); await page.waitForTimeout(600);
  const back = await page.evaluate(() => ({ mode: window.__ofm.S.mode, pins: document.querySelectorAll('.tpin').length, items: document.querySelectorAll('.item').length, banner: !!document.querySelector('.tripBanner') }));
  check(back.mode === 'shops' && back.pins === 0 && back.items > 0 && back.banner, 'leaving the itinerary restores the shop list with a next-stop banner', JSON.stringify(back));
  check(log.errors.length === 0, 'no script errors in the itinerary', log.errors.slice(0, 2).join(' | '));
  await page.locator('#tripChip').click(); await page.waitForTimeout(400);   // leave it in the itinerary, then reopen the app
  await page.reload(); await ready(page); await page.waitForTimeout(800);
  const re = await page.evaluate(() => ({ mode: window.__ofm && window.__ofm.S.mode, stops: document.querySelectorAll('.tStop, .oRow').length, ready: !!(window.__ofm && window.__ofm.ready()) }));
  check(re.mode === 'trip' && re.stops > 0 && re.ready && log.errors.length === 0, 'reopening the app while in the itinerary works (no blank screen)', JSON.stringify(re) + ' ' + log.errors.slice(0, 1).join(''));
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

console.log('11. Google rejects the key (gm_authFailure)');
{
  const { ctx, page, log } = await newPhone({ google: 'authfail' });
  await page.goto(URL0); await ready(page); await page.waitForTimeout(800);
  const st = await page.evaluate(() => ({ engine: window.__ofm.engine(), why: window.__ofm.gmFail(), prov: window.__ofm.provider(), ok: window.__ofm.tiles().ok }));
  check(st.engine === 'ml' && st.why === 'auth' && st.prov === 'ko' && st.ok > 0, 'auth failure → Korean OpenFreeMap map', JSON.stringify(st));
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
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
  }
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
