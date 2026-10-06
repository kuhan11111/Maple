// End-to-end check in a real (headless) Chromium: a synthetic "game" canvas stands in for the
// shared screen, and the test drives the real UI (capture, grid calibration, tag selection,
// detection). Not part of `npm test` because it needs Playwright; run: node test/e2e.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { GEO, sceneScript } from './lib/scene.mjs';

const require = createRequire(process.env.PW_ROOT || `${process.env.PW_GLOBAL || '/opt/node22/lib/node_modules'}/`);
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8765/index.html';
const SHOT = process.env.SHOT_DIR || '.';

// ---- synthetic game: three characters on one screen (single-computer mode) ---------------
const { colX, rowY } = GEO;
const cfg = {
  players: [
    { name: '小明', color: '#ff6b6b', tl: [[0, 450, 700], [800, 450, 700], [1100, 700, rowY(1), 1], [4200, 700, rowY(1)], [4500, 300, rowY(2), 1], [5500, 450, 700]] },
    { name: '小華', color: '#4dabf7', tl: [[0, 600, 700], [800, 600, 700], [1200, 300, rowY(1), 1], [1900, 600, 700], [3000, 600, 700], [3400, 900, rowY(1), 1]] },
    { name: '小美', color: '#51cf66', tl: [[0, 750, 700], [800, 750, 700], [1300, 500, rowY(1), 1], [1900, 750, 700], [3000, 750, 700], [3500, 300, rowY(1), 1], [5300, 300, rowY(1)], [5700, 300, 700, 1]] },
  ],
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => d.accept());
await page.addInitScript(sceneScript, cfg);
await page.goto(BASE);
await page.selectOption('#seatSel', 'all'); // one screen shows all three characters

// 1. capture
await page.click('#btnCapture');
await page.waitForFunction(() => window.__rj.run.W > 0, null, { timeout: 8000 });
assert.equal(await page.evaluate(() => window.__rj.run.W), 1280);

// canvas <-> page coordinates (measured fresh each time: the page may have scrolled)
const px = async (x, y) => {
  await page.locator('#view').scrollIntoViewIfNeeded();
  const box = await page.locator('#view').boundingBox();
  return [box.x + (x * box.width) / 1280, box.y + (y * box.height) / 720];
};

// 2. calibrate the grid: level 1 left platform, level 10 right platform, ground
await page.click('#btnGrid');
for (const [x, y] of [[300, 640], [900, 100], [600, 700]]) {
  const [X, Y] = await px(x, y);
  await page.mouse.click(X, Y);
}
assert.ok(await page.evaluate(() => !!window.__rj.state.grid), 'grid should exist');

// 3. select the three name tags (feet y=700 -> tag top y=701)
for (const [p, x] of [[0, 450], [1, 600], [2, 750]]) {
  await page.click(`[data-act="pickTpl"][data-p="${p}"]`);
  const [x0, y0] = await px(x - 38, 700);
  const [x1, y1] = await px(x + 38, 720);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 5 });
  await page.mouse.up();
}
assert.equal(await page.evaluate(() => window.__rj.state.tpls.filter(Boolean).length), 3);

// 4. detect, then let the scripted game play
await page.click('#btnDetect');
await page.waitForTimeout(800);
await page.evaluate(() => window.__sceneStart());
await page.waitForTimeout(9500);

const log = await page.evaluate(() => window.__rj.state.log.map((e) => `${e.type}:p${e.player}:L${e.level}:c${e.col}:${e.source}`).sort());
console.log(log.join('\n'));
const expected = ['ok:p0:L1:c2', 'bad:p1:L1:c0', 'bad:p2:L1:c1', 'ok:p1:L1:c3', 'ok:p2:L1:c0', 'bad:p0:L2:c0'].map((s) => `${s}:auto`).sort();
assert.deepEqual(log, expected, 'detected events should match the scripted game (and the natural fall must not count)');
await page.screenshot({ path: `${SHOT}/e2e-auto.png`, fullPage: true });

// 5. manual mode: buttons record results and the board updates
await page.click('#modeManual');
await page.waitForSelector('.card .btn.pass');
const before = await page.evaluate(() => window.__rj.state.log.length);
await page.click('.card:nth-child(4) .btn.pass'); // player 4 (never detected) says "ok"
assert.equal(await page.evaluate(() => window.__rj.state.log.length), before + 1);
await page.click('#btnUndo');
assert.equal(await page.evaluate(() => window.__rj.state.log.length), before);

// 6. stats + data collection
await page.click('#statsPanel > summary');
await page.waitForSelector('#stats table.stat');
const runs = await page.evaluate(() => window.__rj.rt.data.runs.length);
assert.ok(runs >= 1, 'current run should be collected');
await page.screenshot({ path: `${SHOT}/e2e-manual.png`, fullPage: true });

// 7. demo plays a full run (and is not collected)
await page.click('#btnDemo');
await page.waitForFunction(() => window.__rj.rt.engine.players.every((P) => P.level === 10), null, { timeout: 60000 });
await page.screenshot({ path: `${SHOT}/e2e-demo.png`, fullPage: true });
const runsAfter = await page.evaluate(() => window.__rj.rt.data.runs.length);
assert.ok(runsAfter >= 1);

assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
await browser.close();
console.log('E2E OK');
