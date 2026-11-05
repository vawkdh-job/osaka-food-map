// Draws the home-screen icons (icon-180/192/512.png) with headless Chromium.
// Usage: node tools/icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [180, 192, 512]) {
  const dataUrl = await page.evaluate(size => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'), s = size / 100;
    g.fillStyle = '#1d5a6c'; g.fillRect(0, 0, size, size);
    // map pin
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(50 * s, 40 * s, 24 * s, Math.PI, 0); g.bezierCurveTo(74 * s, 58 * s, 56 * s, 70 * s, 50 * s, 84 * s);
    g.bezierCurveTo(44 * s, 70 * s, 26 * s, 58 * s, 26 * s, 40 * s); g.fill();
    // bowl inside the pin
    g.fillStyle = '#e8590c';
    g.beginPath(); g.moveTo(36 * s, 38 * s); g.lineTo(64 * s, 38 * s); g.arc(50 * s, 38 * s, 14 * s, 0, Math.PI); g.fill();
    // chopsticks
    g.strokeStyle = '#1d5a6c'; g.lineWidth = 2.6 * s; g.lineCap = 'round';
    g.beginPath(); g.moveTo(44 * s, 34 * s); g.lineTo(60 * s, 20 * s); g.moveTo(49 * s, 34 * s); g.lineTo(65 * s, 22 * s); g.stroke();
    return c.toDataURL('image/png');
  }, size);
  writeFileSync(new URL(`../icon-${size}.png`, import.meta.url), Buffer.from(dataUrl.split(',')[1], 'base64'));
}
await browser.close();
console.log('icons written');
