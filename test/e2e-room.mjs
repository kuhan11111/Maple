// Three "players" in separate rooms, each with their own copy of the app (own storage via
// ?profile=), connected through a room code. Two detect their own character from a synthetic
// screen, one types results by hand. Run: node test/e2e-room.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { GEO, sceneScript } from './lib/scene.mjs';

const require = createRequire(`${process.env.PW_GLOBAL || '/opt/node22/lib/node_modules'}/`);
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8765/index.html';
const SHOT = process.env.SHOT_DIR || '.';
const { rowY } = GEO;
const CODE = `room${Math.random().toString(36).slice(2, 7)}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1500 } });
const errors = [];

async function device(seat, { scene, startX }) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`seat${seat}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`seat${seat}: ${m.text()}`));
  page.on('dialog', (d) => d.accept());
  if (scene) await page.addInitScript(sceneScript, { players: [scene] });
  await page.goto(`${BASE}?profile=seat${seat}`);
  await page.selectOption('#seatSel', String(seat));
  await page.fill('#roomCode', CODE);
  await page.selectOption('#roomVia', 'tab');
  await page.click('#btnRoom');
  await page.waitForFunction(() => document.querySelector('#btnRoom').textContent.includes('中斷'));
  if (!scene) return page;

  const px = async (x, y) => {
    await page.locator('#view').scrollIntoViewIfNeeded();
    const b = await page.locator('#view').boundingBox();
    return [b.x + (x * b.width) / 1280, b.y + (y * b.height) / 720];
  };
  await page.click('#btnCapture');
  await page.waitForFunction(() => window.__rj.run.W > 0);
  await page.click('#btnGrid');
  for (const [x, y] of [[300, 640], [900, 100], [600, 700]]) await page.mouse.click(...(await px(x, y)));
  await page.click(`[data-act="pickTpl"][data-p="${seat}"]`);
  await page.mouse.move(...(await px(startX - 38, 700)));
  await page.mouse.down();
  await page.mouse.move(...(await px(startX + 38, 720)), { steps: 5 });
  await page.mouse.up();
  assert.ok(await page.evaluate((s) => !!window.__rj.state.tpls[s], seat), `seat ${seat}: tag template`);
  await page.click('#btnDetect');
  return page;
}

const A = await device(0, { startX: 450, scene: { name: '小明', color: '#ff6b6b', tl: [[0, 450, 700], [800, 450, 700], [1100, 700, rowY(1), 1]] } });
const B = await device(1, { startX: 600, scene: { name: '小華', color: '#4dabf7', tl: [[0, 600, 700], [800, 600, 700], [1200, 300, rowY(1), 1], [1900, 600, 700]] } });
const C = await device(2, {}); // manual, no screen
await A.waitForTimeout(500);

await A.evaluate(() => window.__sceneStart());
await B.evaluate(() => window.__sceneStart());
await A.waitForTimeout(4500);

// player 3 (manual) is told which platform to try on level 1 and reports being teleported back
const advice = await C.locator('.card').nth(2).locator('.big').innerText();
console.log('C is told:', advice);
await C.locator('.card').nth(2).locator('.btn.fail').click();
await A.waitForTimeout(1200);

const snap = (page) => page.evaluate(() => ({
  log: window.__rj.state.log.map((e) => `${e.type}:p${e.player}:L${e.level}:c${e.col}`).sort(),
  runId: window.__rj.state.runId,
  levels: window.__rj.rt.engine.players.map((P) => P.level),
  online: [...document.querySelectorAll('#seats .seat.on')].length,
  names: window.__rj.state.names.slice(0, 3),
}));
const [a, b, c] = [await snap(A), await snap(B), await snap(C)];
console.log(JSON.stringify(a.log));
assert.equal(a.log.length, 3);
assert.ok(a.log.includes('ok:p0:L1:c2') && a.log.includes('bad:p1:L1:c0') && a.log.some((x) => x.startsWith('bad:p2:L1:')));
assert.deepEqual(b.log, a.log, 'B should hold the same results as A');
assert.deepEqual(c.log, a.log, 'C should hold the same results as A');
// everyone sees where everybody is
for (const s of [a, b, c]) assert.deepEqual(s.levels.slice(0, 2), [1, 0]);
for (const s of [a, b, c]) assert.ok(s.online >= 3, `all three seats shown online (${s.online})`);

// the point of sharing: B now knows A's platform is not B's, and its own failure
const bCands = await B.evaluate(async () => {
  const { analyze } = await import('/js/solver.js');
  const facts = window.__rj.state.log.map((e) => ({ level: e.level, player: e.player, col: e.col, ok: e.type === 'ok' }));
  return analyze(facts, 4, 'latin')[1].cands[1];
});
assert.ok(!bCands.includes(2) && !bCands.includes(0), `B's candidates ${bCands}`);
console.log('B candidates on level 1:', bCands);

// names travel too
await A.fill('input[data-act="name"][data-p="0"]', '阿明');
await A.press('input[data-act="name"][data-p="0"]', 'Enter');
await A.waitForTimeout(400);
assert.equal((await snap(B)).names[0], '阿明');

// deleting a result on one screen removes it everywhere
await C.locator('#log li button').first().click();
await C.waitForTimeout(500);
assert.equal((await snap(A)).log.length, 2);
assert.equal((await snap(B)).log.length, 2);

await A.screenshot({ path: `${SHOT}/room-A.png`, fullPage: true });
await C.screenshot({ path: `${SHOT}/room-C.png`, fullPage: true });

// a new round started by anyone starts it for everybody
await B.click('#btnReset');
await A.waitForTimeout(700);
const after = [await snap(A), await snap(B), await snap(C)];
for (const s of after) assert.deepEqual(s.log, []);
assert.equal(new Set(after.map((s) => s.runId)).size, 1, 'same run id everywhere');
assert.notEqual(after[0].runId, a.runId);

assert.deepEqual(errors, [], errors.join(' | '));
await browser.close();
console.log('ROOM E2E OK');
