// End-to-end checks in headless Chromium on phone viewports.
// Real tile servers are not reachable from the build machine, so tiles are synthetic (page.route).
// Usage: node tests/e2e.mjs [screenshot-dir]
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = process.argv[2] || join(ROOT, 'tests', 'shots');
mkdirSync(SHOTS, { recursive: true });

// ---------- static server (localhost counts as a secure context, like https) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
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
const TILE = { carto: await makeTile(512, 'carto@2x'), gsi: await makeTile(256, 'gsi'), esri: await makeTile(256, 'esri') };

async function newPhone(opts = {}) {
  const ctx = await browser.newContext({ ...(opts.device || devices['iPhone 13']), serviceWorkers: opts.sw ? 'allow' : 'block',
    locale: 'ko-KR', timezoneId: opts.tz || 'Asia/Seoul', ...(opts.geo ? { geolocation: opts.geo, permissions: ['geolocation'] } : {}) });
  const page = await ctx.newPage();
  const log = { errors: [], tiles: { carto: 0, gsi: 0, esri: 0 } };
  page.on('pageerror', e => log.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) log.errors.push(m.text()); });
  const t = opts.tiles || {};
  for (const [key, pat] of [['carto', '**/*.basemaps.cartocdn.com/**'], ['gsi', '**/cyberjapandata.gsi.go.jp/**'], ['esri', '**/server.arcgisonline.com/**']]) {
    await ctx.route(pat, async route => {
      log.tiles[key]++;
      const mode = t[key] || 'ok';
      if (mode === 'fail') return route.abort('connectionrefused');
      if (typeof mode === 'number') await new Promise(r => setTimeout(r, mode));
      try { await route.fulfill({ status: 200, contentType: 'image/png', body: TILE[key] }); } catch {}
    });
  }
  await ctx.route(/^https?:\/\/(?!localhost)(?!.*(cartocdn|gsi\.go\.jp|arcgisonline))/, r => r.abort()); // photos etc.
  if (opts.clock) await page.clock.setFixedTime(new Date(opts.clock));
  return { ctx, page, log };
}
const appState = page => page.evaluate(() => { const a = window.__ofm; return { sort: a.S.sort, ref: a.S.ref, day: a.S.day, view: a.S.view, provider: a.provider(),
  rows: a.rows().filter(x => x.r).map(x => ({ id: x.r.id, region: x.r.region, d: x.d })), me: a.me(), sheet: a.sheetPx() }; });
const visibleIcons = page => page.evaluate(() => [...document.querySelectorAll('.leaflet-marker-pane .pin, .leaflet-marker-pane .cl')].length);

// ======================================================================
console.log('1. iPhone 13 · first open, no location permission');
{
  const { ctx, page, log } = await newPhone();
  await page.goto(URL0); await page.waitForTimeout(1500);
  const st = await appState(page);
  check(st.rows.length === 30, '30 restaurants listed', String(st.rows.length));
  check(st.sort === 'tabelog' && st.ref === 'hotel', 'default sort Tabelog, distance from hotel');
  const counts = await page.evaluate(() => { let n = 0; document.querySelectorAll('.leaflet-marker-pane .pin').forEach(() => n++);
    document.querySelectorAll('.leaflet-marker-pane .cl b').forEach(b => n += parseInt(b.textContent)); return n; });
  check(counts === 30, 'pins + cluster members account for all 30', String(counts));
  const first = await page.locator('.item').first().innerText();
  check(first.includes('무기토멘스케') && first.includes('3.90'), 'top item is highest Tabelog (3.90)');
  const pinText = await page.locator('.leaflet-marker-pane .pin b').first().innerText().catch(() => '');
  check(/^\d\.\d\d$/.test(pinText), 'pins show Tabelog score', pinText);
  const ui = await page.evaluate(() => { const H = innerHeight, top = document.querySelector('#topbar').getBoundingClientRect().bottom, sh = document.querySelector('#sheet').getBoundingClientRect().top;
    return { mapVisiblePct: Math.round((sh - top) / H * 100), searchFont: getComputedStyle(document.querySelector('#q')).fontSize }; });
  check(ui.mapVisiblePct >= 55, 'map has ≥55% of the screen free with sheet collapsed', ui.mapVisiblePct + '%');
  check(ui.searchFont === '16px', 'search box 16px (no iOS zoom on focus)');
  check(log.tiles.carto > 0 && log.tiles.gsi === 0, 'CARTO @2x tiles requested, no fallback', JSON.stringify(log.tiles));
  check(await page.locator('#toast.show').count() === 1, 'hint toast about ◎ button shown');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: join(SHOTS, '01_iphone_first_open.png') });
  // pinch zoom with two fingers
  const z0 = await page.evaluate(() => window.__ofm.map.getZoom());
  const cdp = await ctx.newCDPSession(page);
  const pts = (d) => [{ x: 195 - d, y: 330, id: 1 }, { x: 195 + d, y: 330, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(30) });
  for (let d = 30; d <= 130; d += 10) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(800);
  const z1 = await page.evaluate(() => window.__ofm.map.getZoom());
  check(z1 > z0, 'two-finger pinch zooms the map', `${z0} → ${z1}`);
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('2. Location granted, standing at Dotonbori');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 34.6687, longitude: 135.5013, accuracy: 25 } });
  await page.goto(URL0); await page.waitForTimeout(2500);
  const st = await appState(page);
  check(!!st.me, 'location acquired automatically (permission already granted)');
  check(st.ref === 'me' && st.sort === 'nearby', 'switched to “near me, by rating”', `${st.ref}/${st.sort}`);
  const nearTop = st.rows.slice(0, 8);
  check(nearTop.every(r => r.region === 'south'), 'top 8 are all Namba/Shinsaibashi');
  check(nearTop.every(r => r.d < 1.2), 'top 8 within ~20 min walk', nearTop.map(r => r.d.toFixed(2)).join(','));
  const scores = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).slice(0, 6).map(x => x.r.tabelog));
  check(scores.every((v, i) => i === 0 || v <= scores[i - 1]), 'nearby group sorted by Tabelog', scores.join(','));
  check(await page.locator('.meIcon .me').count() === 1, 'blue “me” dot on map');
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
  await page.screenshot({ path: join(SHOTS, '03_iphone_detail.png') });
  await page.goBack(); await page.waitForTimeout(300);
  check((await appState(page)).view === 'list', 'phone back button returns to list');
  check(log.errors.length === 0, 'no JS errors', log.errors.join(' | '));
  await ctx.close();
}

console.log('3. Location in Seoul (testing before the trip)');
{
  const { ctx, page, log } = await newPhone({ geo: { latitude: 37.5665, longitude: 126.978, accuracy: 30 } });
  await page.goto(URL0); await page.waitForTimeout(2500);
  const st = await appState(page);
  check(!!st.me && st.ref === 'hotel', 'location shown but distances stay hotel-based');
  check((await page.locator('#toast').innerText()).includes('오사카에서 약'), 'explains it will switch once in Osaka');
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
  await page.locator('#rating').selectOption('t3.7'); await page.waitForTimeout(200);
  const st = await appState(page);
  const ok = await page.evaluate(() => window.__ofm.rows().filter(x => x.r).every(x => x.r.tabelog >= 3.7));
  check(ok && st.rows.length > 0, 'Tabelog 3.7+ filter', st.rows.length + ' left');
  await page.locator('#kind').selectOption('우동'); await page.waitForTimeout(200);
  const kinds = await page.evaluate(() => [...new Set(window.__ofm.rows().filter(x => x.r).map(x => x.r.kind))]);
  check(kinds.length === 1 && kinds[0] === '우동', 'menu filter', kinds.join(','));
  await page.screenshot({ path: join(SHOTS, '05_iphone_sheet_full_filtered.png') });
  await ctx.close();
}

console.log('6. Sunday 11/15 12:00 in Japan (live opening hours)');
{
  const { ctx, page } = await newPhone({ clock: '2026-11-15T12:00:00+09:00' });
  await page.goto(URL0); await page.waitForTimeout(1000);
  const st = await appState(page);
  check(st.day === 'sun', 'day defaults to today (Sun) in Japan time even with a Seoul-time phone');
  check((await page.locator('#openChip').innerText()).includes('지금 영업 중'), 'chip becomes “open now”');
  const s = await page.evaluate(() => Object.fromEntries([2, 11, 14, 26, 30].map(id => [id, window.__ofm.status(APP_DATA.restaurants.find(r => r.id === id), 'sun').kind])));
  check(s[2] === 'closed' && s[14] === 'closed' && s[26] === 'closed', 'Sunday closures (#2, #14, #26)', JSON.stringify(s));
  check(s[11] === 'later' && s[30] === 'open', 'opens-later and open-now states', JSON.stringify(s));
  await page.locator('#openChip').click(); await page.waitForTimeout(200);
  const ids = (await appState(page)).rows.map(r => r.id);
  check(![2, 11, 14, 26].some(i => ids.includes(i)) && ids.includes(30), '“open now” filter hides closed shops', ids.length + ' open');
  await page.screenshot({ path: join(SHOTS, '06_iphone_sunday_open_now.png') });
  await ctx.close();
}

console.log('7. Tile server failures');
{
  const { ctx, page, log } = await newPhone({ tiles: { carto: 'fail' } });
  await page.goto(URL0); await page.waitForTimeout(3000);
  check((await appState(page)).provider === 'gsi', 'CARTO down → switches to GSI map', JSON.stringify(log.tiles));
  await ctx.close();
}
{
  const { ctx, page } = await newPhone({ tiles: { carto: 'fail', gsi: 'fail', esri: 'fail' } });
  await page.goto(URL0); await page.waitForTimeout(4000);
  check(await page.locator('#mapStatus').isVisible(), 'all servers down → message with retry button (no fake map)');
  check((await appState(page)).rows.length === 30, 'list still works without tiles');
  await page.screenshot({ path: join(SHOTS, '07_iphone_tiles_down.png') });
  await ctx.close();
}
{
  const { ctx, page } = await newPhone({ tiles: { carto: 10000 } });
  await page.goto(URL0); await page.waitForTimeout(13000);
  const loaded = await page.evaluate(() => [...document.querySelectorAll('.leaflet-tile-loaded')].length);
  check((await appState(page)).provider === 'carto' && loaded > 0, 'slow tiles (10 s) → waits, no switch, tiles appear', `${loaded} tiles`);
  await ctx.close();
}

console.log('8. Desktop and small phone layouts');
{
  const { ctx, page, log } = await newPhone({ device: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } });
  await page.goto(URL0); await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, '08_desktop.png') });
  check(log.errors.length === 0, 'desktop: no JS errors', log.errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page, log } = await newPhone({ device: devices['iPhone SE'] });
  await page.goto(URL0); await page.waitForTimeout(2500);
  const pct = await page.evaluate(() => Math.round((document.querySelector('#sheet').getBoundingClientRect().top - document.querySelector('#topbar').getBoundingClientRect().bottom) / innerHeight * 100));
  check(pct >= 45, 'iPhone SE: map area with sheet collapsed', pct + '%');
  await page.screenshot({ path: join(SHOTS, '09_iphone_se.png') });
  check(log.errors.length === 0, 'iPhone SE: no JS errors', log.errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page, log } = await newPhone({ device: devices['Pixel 7'], geo: { latitude: 34.7025, longitude: 135.4959, accuracy: 40 } });
  await page.goto(URL0); await page.waitForTimeout(2500);
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
  const n = await page.locator('.item').count().catch(() => 0);
  check(controlled && n === 30, 'offline reload still shows all 30 restaurants', `controlled=${controlled}, items=${n}`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
