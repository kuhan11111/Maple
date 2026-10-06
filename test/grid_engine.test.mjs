import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGrid, classify } from '../js/grid.js';
import { Engine } from '../js/engine.js';

// level 1 left platform at (100, 600), level 10 right platform at (400, 150) -> 50 px per level
const grid = makeGrid({ x1: 100, y1: 600, x2: 400, y2: 150 });
const at = (level, col) => ({ kind: 'plat', level, col });
const GROUND = { kind: 'ground' };
const AIR = { kind: 'air' };

test('grid geometry', () => {
  assert.equal(grid.dy, 50);
  assert.equal(grid.dx, 100);
  assert.deepEqual(grid.colX, [100, 200, 300, 400]);
  assert.equal(grid.rowY[0], 650);
  assert.equal(grid.rowY[10], 150);
});

test('classify: platforms, ground, air', () => {
  assert.deepEqual(classify(grid, 210, 553), { kind: 'plat', level: 2, col: 1 });
  assert.deepEqual(classify(grid, 100, 148), { kind: 'plat', level: 10, col: 0 });
  assert.deepEqual(classify(grid, 250, 700), { kind: 'ground' });
  assert.deepEqual(classify(grid, 250, 650), { kind: 'ground' });
  assert.deepEqual(classify(grid, 250, 575), { kind: 'air' }); // between level 1 and 2
  assert.deepEqual(classify(grid, 700, 600), { kind: 'air' }); // far right of the board
});

// feed a list of [ms, cell] holds for one player at 80 ms frames
function run(engine, p, script, t0 = 0) {
  const events = [];
  let t = t0;
  for (const [ms, cell] of script) {
    for (let e = 0; e < ms; e += 80, t += 80) {
      const obs = [];
      obs[p] = cell;
      events.push(...engine.step(t, obs));
    }
  }
  return { events, t };
}

test('stood on the next platform without being sent back = ok, once', () => {
  const e = new Engine(2);
  const { events } = run(e, 0, [[400, GROUND], [2500, at(1, 2)]]);
  assert.deepEqual(events.map((x) => [x.type, x.level, x.col]), [['ok', 1, 2]]);
  assert.equal(e.players[0].level, 1);
});

test('teleport: platform -> bottom with nothing in the air = bad on that platform', () => {
  const e = new Engine(2);
  const { events } = run(e, 1, [[400, GROUND], [400, at(1, 3)], [600, GROUND]]);
  assert.deepEqual(events.map((x) => [x.type, x.level, x.col]), [['bad', 1, 3]]);
  assert.equal(e.players[1].level, 0);
});

test('teleport from a higher level is blamed on the platform it left', () => {
  const e = new Engine(1);
  const a = run(e, 0, [[400, GROUND], [2000, at(1, 0)], [2000, at(2, 2)]]); // ok 1, ok 2
  const b = run(e, 0, [[300, at(3, 1)], [600, GROUND]], a.t);
  assert.deepEqual([...a.events, ...b.events].map((x) => [x.type, x.level, x.col]), [['ok', 1, 0], ['ok', 2, 2], ['bad', 3, 1]]);
});

test('a fall through the air is not a verdict on the platform', () => {
  const e = new Engine(1);
  const { events } = run(e, 0, [[400, GROUND], [600, at(2, 1)], [320, AIR], [600, GROUND]]);
  assert.deepEqual(events, []);
  assert.equal(e.players[0].level, 0);
});

test('a late teleport after a premature ok flips it to bad', () => {
  const e = new Engine(1);
  const { events } = run(e, 0, [[400, GROUND], [1700, at(1, 0)], [600, GROUND]]);
  assert.deepEqual(events.map((x) => [x.type, x.level, x.col]), [['ok', 1, 0], ['bad', 1, 0]]);
});

test('going up to the next level from a platform counts as success (advance)', () => {
  const e = new Engine(1);
  const { events } = run(e, 0, [[400, GROUND], [600, at(1, 2)], [240, AIR], [500, at(2, 1)]]);
  assert.deepEqual(events.map((x) => [x.type, x.level, x.col]), [['ok', 1, 2]]);
  assert.equal(e.players[0].level, 1);
  assert.deepEqual(e.pending(), [{ player: 0, level: 2, col: 1 }]);
});

test("okMode 'off' never infers success, but still sees teleports", () => {
  const e = new Engine(1, { okMode: 'off' });
  const a = run(e, 0, [[400, GROUND], [3000, at(1, 2)], [240, AIR], [500, at(2, 1)]]);
  assert.deepEqual(a.events, []);
  const b = run(e, 0, [[320, AIR], [400, GROUND]], a.t);
  assert.deepEqual(b.events, []); // fell from level 2 through the air: no teleport signature
  const c = run(e, 0, [[400, at(1, 3)], [500, GROUND]], b.t);
  assert.deepEqual(c.events.map((x) => [x.type, x.level, x.col]), [['bad', 1, 3]]);
});

test('tag vanishing and reappearing at the bottom asks instead of guessing', () => {
  const e = new Engine(1);
  const { events } = run(e, 0, [[400, GROUND], [500, at(1, 1)], [400, null], [500, GROUND]]);
  assert.deepEqual(events.map((x) => [x.type, x.level, x.col]), [['unknownFall', 1, 1]]);
});

test('a one-frame glitch at the bottom is not a teleport', () => {
  const e = new Engine(1);
  const { events } = run(e, 0, [[400, GROUND], [500, at(1, 1)], [80, GROUND], [400, at(1, 1)]]);
  assert.deepEqual(events, []);
});

test('brushing past a platform while jumping is not a stop', () => {
  const e = new Engine(1);
  const { events } = run(e, 0, [[400, GROUND], [80, at(1, 1)], [160, AIR], [500, GROUND]]);
  assert.deepEqual(events, []);
  assert.equal(e.players[0].attempt, null);
});

test('missed jump landing back on the confirmed level is not a failure', () => {
  const e = new Engine(1);
  const a = run(e, 0, [[400, GROUND], [2000, at(1, 1)], [300, at(2, 0)], [240, AIR], [600, at(1, 1)]]);
  assert.deepEqual(a.events.map((x) => x.type), ['ok']);
  assert.equal(e.players[0].attempt, null);
});

test('lost tags do not generate events and flag the player', () => {
  const e = new Engine(1);
  const { events } = run(e, 0, [[400, GROUND], [4000, null]]);
  assert.deepEqual(events, []);
  assert.equal(e.players[0].lost, true);
});

test('pending exposes the attempt in progress', () => {
  const e = new Engine(2);
  run(e, 0, [[400, GROUND], [400, at(1, 3)]]);
  assert.deepEqual(e.pending(), [{ player: 0, level: 1, col: 3 }]);
});
