import test from 'node:test';
import assert from 'node:assert/strict';
import { advise, analyzeLevel, assignments, LEVELS } from '../js/solver.js';
import { createSim } from '../js/sim.js';

const f = (level, player, col, ok) => ({ level, player, col, ok });

test('latin: 4 players have 24 assignments, shared has 4', () => {
  assert.equal(assignments(4, 'latin').length, 24);
  assert.equal(assignments(4, 'shared').length, 4);
  assert.equal(assignments(2, 'latin').length, 12);
});

test('latin: a teammate succeeding removes that platform for everyone else', () => {
  const a = analyzeLevel([f(1, 0, 2, true)], 4, 'latin');
  assert.deepEqual(a.cands[0], [2]);
  for (const p of [1, 2, 3]) assert.deepEqual(a.cands[p], [0, 1, 3]);
});

test('latin: elimination chains into a forced answer', () => {
  // player 0 knows col 0; player 1 failed 1 and 2 -> must be 3; so 2 gets {1,2} minus... etc
  const a = analyzeLevel([f(1, 0, 0, true), f(1, 1, 1, false), f(1, 1, 2, false)], 4, 'latin');
  assert.deepEqual(a.cands[1], [3]);
  assert.deepEqual(a.cands[2], [1, 2]);
  assert.deepEqual(a.cands[3], [1, 2]);
});

test('shared: one success fixes the column for everybody', () => {
  const a = analyzeLevel([f(1, 2, 3, true)], 4, 'shared');
  for (let p = 0; p < 4; p++) assert.deepEqual(a.cands[p], [3]);
});

test('shared: three failures force the last column', () => {
  const a = analyzeLevel([f(1, 0, 0, false), f(1, 1, 1, false), f(1, 2, 2, false)], 4, 'shared');
  assert.deepEqual(a.cands[3], [3]);
});

test('contradictory facts are flagged and degrade to per-player elimination', () => {
  const a = analyzeLevel([f(1, 0, 1, true), f(1, 1, 1, true)], 4, 'latin');
  assert.equal(a.conflict, true);
  assert.deepEqual(a.cands[0], [1]);
  assert.deepEqual(a.cands[1], [1]);
  assert.deepEqual(a.cands[2], [0, 1, 2, 3]);
});

test('fresh start: all four players get different platforms on level 1', () => {
  const { plans } = advise({ facts: [], levels: [0, 0, 0, 0], mode: 'latin' });
  const cols = plans.map((p) => p.test.col);
  assert.equal(new Set(cols).size, 4);
  for (const p of plans) assert.deepEqual([p.test.level, p.ready], [1, true]);
});

test('route is the known path; test is the first unknown level', () => {
  const facts = [f(1, 0, 3, true), f(2, 0, 1, true)];
  const { plans } = advise({ facts, levels: [0, 0, 0, 0], mode: 'latin' });
  assert.deepEqual(plans[0].route, [
    { level: 1, col: 3 },
    { level: 2, col: 1 },
  ]);
  assert.equal(plans[0].testLevel, 3);
  assert.equal(plans[0].ready, false);
  // teammates are told level 1 is not column 3
  assert.equal(plans[1].testLevel, 1);
  assert.ok(!plans[1].cands.includes(3));
});

test('advice stays put when still consistent (prev)', () => {
  const first = advise({ facts: [], levels: [0, 0, 0, 0], mode: 'latin' });
  const prev = first.plans.map((p) => p.test);
  // player 3 fails somewhere that is not what players 0..2 were told
  const facts = [f(1, 3, prev[3].col === 0 ? 1 : 0, false)];
  const next = advise({ facts, levels: [0, 0, 0, 0], mode: 'latin', prev });
  const same = next.plans.filter((p, i) => p.test.col === prev[i].col).length;
  assert.ok(same >= 3, `expected most advice unchanged, only ${same} kept`);
  assert.equal(new Set(next.plans.map((p) => p.test.col)).size, 4);
});

test('pending attempts steer teammates away from that platform', () => {
  const { plans } = advise({
    facts: [],
    levels: [0, 0, 0, 0],
    mode: 'latin',
    pending: [{ player: 2, level: 1, col: 0 }],
  });
  assert.equal(plans[2].test.col, 0);
  for (const i of [0, 1, 3]) assert.notEqual(plans[i].test.col, 0);
});

test('shared: ready players probe distinct columns, extras wait', () => {
  const facts = [f(1, 0, 0, false), f(1, 0, 1, false)]; // cols 2,3 remain
  const { plans } = advise({ facts, levels: [0, 0, 0, 0], mode: 'shared' });
  const testers = plans.filter((p) => p.test);
  assert.equal(testers.length, 2);
  assert.notEqual(testers[0].test.col, testers[1].test.col);
  assert.equal(plans.filter((p) => p.wait).length, 2);
});

test('shared: maxTesters=1 sends one player at a time', () => {
  const { plans } = advise({ facts: [], levels: [0, 0, 0, 0], mode: 'shared', maxTesters: 1 });
  assert.equal(plans.filter((p) => p.test).length, 1);
});

test('a player already on top is done', () => {
  const { plans } = advise({ facts: [], levels: [LEVELS, 0, 0, 0] });
  assert.equal(plans[0].done, true);
  assert.equal(plans[0].test, null);
});

for (const mode of ['latin', 'shared']) {
  test(`simulation (${mode}): 300 random layouts, everybody reaches the top, nobody repeats a platform`, () => {
    let totalFalls = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const sim = createSim({ mode, seed });
      while (!sim.done) {
        assert.ok(sim.rounds < 400, `seed ${seed} did not finish`);
        sim.step(); // throws if two testers share a platform
      }
      // a player never retries a platform that already failed for them
      const seen = new Set();
      for (const fa of sim.facts) {
        const k = `${fa.level}:${fa.player}:${fa.col}`;
        assert.ok(!seen.has(k), `seed ${seed}: repeated ${k}`);
        seen.add(k);
      }
      totalFalls += sim.falls;
    }
    console.log(`  ${mode}: average falls per run = ${(totalFalls / 300).toFixed(1)}`);
  });
}
