import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, makeTemplate } from '../js/tracker.js';
import { mulberry32 } from '../js/sim.js';

const W = 640;
const H = 480;

// A fake name tag: dark box with a random "text" pattern of bright strokes.
function tagPattern(seed, w = 64, h = 14) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(w * h).fill(40);
  for (let x = 3; x < w - 3; x++) for (let y = 3; y < h - 3; y++) if (rnd() < 0.45) p[y * w + x] = 230;
  return { p, w, h };
}

function scene(tags, seed = 7) {
  const rnd = mulberry32(seed);
  const g = new Uint8Array(W * H);
  // smooth-ish noisy background with a few platform-like bright bars
  for (let i = 0; i < g.length; i++) g[i] = 90 + Math.floor(rnd() * 50);
  for (let y = 60; y < H; y += 50) for (let x = 100; x < 560; x++) g[y * W + x] = g[(y + 1) * W + x] = 200;
  for (const { tag, x, y, shade = 0 } of tags) {
    for (let j = 0; j < tag.h; j++) for (let i = 0; i < tag.w; i++) g[(y + j) * W + x + i] = Math.min(255, Math.max(0, tag.p[j * tag.w + i] + shade));
  }
  return g;
}

test('tracks four distinct name tags to the pixel while they move', () => {
  const tags = [1, 2, 3, 4].map((s) => tagPattern(s));
  const start = [[100, 100], [200, 160], [320, 220], [430, 300]];
  const tr = new Tracker();
  tr.setFrame(scene(tags.map((tag, i) => ({ tag, x: start[i][0], y: start[i][1] }))), W, H, true);
  const tpls = tags.map((tag, i) => makeTemplate(tr.gray, W, H, { x: start[i][0], y: start[i][1], w: tag.w, h: tag.h }));
  const hints = start.map(([x, y]) => ({ x, y }));
  for (let step = 1; step <= 25; step++) {
    const pos = start.map(([x, y], i) => [x + step * (i % 2 ? -3 : 4), y + step * (i === 2 ? -2 : 3)]);
    tr.setFrame(scene(tags.map((tag, i) => ({ tag, x: pos[i][0], y: pos[i][1] }))), W, H, true);
    tpls.forEach((tpl, i) => {
      const r = tr.find(tpl, { hint: hints[i], radius: 60 });
      assert.ok(r, `player ${i} lost at step ${step}`);
      assert.deepEqual([r.x, r.y], pos[i], `player ${i} step ${step} score ${r.score.toFixed(2)}`);
      assert.ok(r.score > 0.95);
      hints[i] = { x: r.x, y: r.y };
    });
  }
});

test('survives brightness shift + mild noise and rejects a different tag', () => {
  const a = tagPattern(11);
  const b = tagPattern(12);
  const tr = new Tracker();
  tr.setFrame(scene([{ tag: a, x: 200, y: 200 }]), W, H, true);
  const tpl = makeTemplate(tr.gray, W, H, { x: 200, y: 200, w: a.w, h: a.h });
  const noisy = scene([{ tag: a, x: 230, y: 214, shade: -25 }]);
  const rnd = mulberry32(99);
  for (let i = 0; i < noisy.length; i++) noisy[i] = Math.max(0, Math.min(255, noisy[i] + Math.floor(rnd() * 21) - 10));
  tr.setFrame(noisy, W, H, true);
  const hit = tr.find(tpl, { hint: { x: 200, y: 200 }, radius: 60 });
  assert.deepEqual([hit.x, hit.y], [230, 214]);
  assert.ok(hit.score > 0.8, `score ${hit.score}`);

  tr.setFrame(scene([{ tag: b, x: 230, y: 214 }]), W, H, true);
  const miss = tr.find(tpl, { hint: { x: 200, y: 200 }, radius: 60 });
  assert.ok(!miss || miss.score < 0.6, `different tag scored ${miss && miss.score}`);
});

test('global search re-acquires a tag that jumped far away', () => {
  const a = tagPattern(21);
  const tr = new Tracker();
  tr.setFrame(scene([{ tag: a, x: 100, y: 100 }]), W, H, true);
  const tpl = makeTemplate(tr.gray, W, H, { x: 100, y: 100, w: a.w, h: a.h });
  tr.setFrame(scene([{ tag: a, x: 470, y: 380 }]), W, H, true);
  assert.ok(!tr.find(tpl, { hint: { x: 100, y: 100 }, radius: 60 }) || tr.find(tpl, { hint: { x: 100, y: 100 }, radius: 60 }).score < 0.6);
  const r = tr.find(tpl, { global: true });
  assert.deepEqual([r.x, r.y], [470, 380]);
});

test('local search over four players stays fast', () => {
  const tags = [1, 2, 3, 4].map((s) => tagPattern(s));
  const tr = new Tracker();
  const frame = scene(tags.map((tag, i) => ({ tag, x: 100 + i * 100, y: 100 + i * 60 })));
  tr.setFrame(frame, W, H, true);
  const tpls = tags.map((tag, i) => makeTemplate(tr.gray, W, H, { x: 100 + i * 100, y: 100 + i * 60, w: tag.w, h: tag.h }));
  const t0 = performance.now();
  for (let k = 0; k < 20; k++) {
    tr.setFrame(frame, W, H, true);
    tpls.forEach((tpl, i) => tr.find(tpl, { hint: { x: 100 + i * 100, y: 100 + i * 60 }, radius: 100 }));
  }
  const per = (performance.now() - t0) / 20;
  console.log(`  frame + 4 local searches: ${per.toFixed(1)} ms`);
  assert.ok(per < 60);
});
