import test from 'node:test';
import assert from 'node:assert/strict';
import { chiSquareP, poissonTail, summarize, predictNext, extractRun, runsToCSV, mergeRuns } from '../js/stats.js';
import { analyze } from '../js/solver.js';
import { mulberry32 } from '../js/sim.js';

const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('chi-square and poisson tails match known values', () => {
  close(chiSquareP(7.815, 3), 0.05, 0.001);
  close(chiSquareP(11.345, 3), 0.01, 0.001);
  close(chiSquareP(16.919, 9), 0.05, 0.001);
  assert.equal(chiSquareP(0, 3), 1);
  close(poissonTail(1, 2), 1 - Math.exp(-2), 1e-12);
  assert.equal(poissonTail(0, 5), 1);
});

const randomRuns = (count, seed, rule = 'latin') => {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, (_, r) => {
    const perm = () => {
      const a = [0, 1, 2, 3];
      for (let i = 3; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const levels = Array.from({ length: 10 }, () => (rule === 'latin' ? perm() : [Math.floor(rnd() * 4)]));
    const players = rule === 'latin' ? 4 : 1;
    return { id: `r${seed}-${r}`, savedAt: 1, rule, n: players, names: [], paths: Array.from({ length: players }, (_, p) => levels.map((l) => (rule === 'latin' ? l[p] : l[0]))) };
  });
};

test('truly random layouts are not flagged', () => {
  for (const rule of ['latin', 'shared']) {
    let flagged = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = summarize(randomRuns(rule === 'latin' ? 15 : 60, seed, rule));
      if (s.verdict === 'pattern') flagged++;
      if (s.verdict === 'insufficient') assert.fail('should have enough data');
    }
    assert.ok(flagged <= 1, `${rule}: ${flagged}/20 random datasets flagged`);
  }
});

test('a small pool of fixed combinations is detected and predicted', () => {
  const rnd = mulberry32(5);
  const pool = randomRuns(1, 77)[0].paths; // 4 fixed latin paths
  const runs = Array.from({ length: 12 }, (_, r) => {
    const order = [0, 1, 2, 3].sort(() => rnd() - 0.5);
    return { id: `f${r}`, savedAt: 1, rule: 'latin', n: 4, names: [], paths: order.map((i) => pool[i]) };
  });
  const s = summarize(runs);
  assert.equal(s.verdict, 'pattern');
  assert.ok(s.flagged.some((f) => f.startsWith('repeat@')));
  assert.equal(s.repeats[9].distinct, 4);
  const prefix = pool[2].slice(0, 3);
  const pred = predictNext(runs, prefix);
  assert.equal(pred.next, pool[2][3]);
  assert.equal(pred.share, 1);
  assert.equal(pred.matches, 12);
});

test('not enough data = no verdict', () => {
  assert.equal(summarize(randomRuns(1, 3)).verdict, 'insufficient');
});

test('predictNext ignores unknown levels and excluded run', () => {
  const runs = [{ id: 'a', paths: [[1, 2, null, null, null, null, null, null, null, null]] }, { id: 'b', paths: [[1, 2, 3, null, null, null, null, null, null, null]] }];
  assert.equal(predictNext(runs, [1, 2]).matches, 1);
  assert.equal(predictNext(runs, [1, 2], { excludeRun: 'b' }), null);
  assert.equal(predictNext(runs, [3]), null);
});

test('extractRun reads singleton candidates from the analysis', () => {
  const facts = [
    { level: 1, player: 0, col: 2, ok: true },
    { level: 2, player: 0, col: 0, ok: true },
  ];
  const run = extractRun(analyze(facts, 4, 'latin'), 4, 'latin');
  assert.equal(run.length, 4);
  assert.deepEqual(run[0].slice(0, 3), [2, 0, null]);
  assert.equal(extractRun(analyze([], 4, 'latin'), 4, 'latin'), null);
  assert.equal(extractRun(analyze(facts, 4, 'shared'), 4, 'shared').length, 1);
});

test('csv export and validated merge', () => {
  const runs = randomRuns(2, 9);
  const csv = runsToCSV(runs);
  assert.equal(csv.split('\n').length, 1 + 8);
  const m = mergeRuns([runs[0]], [runs[0], runs[1], { id: 'bad', rule: 'x', paths: [] }, null]);
  assert.equal(m.runs.length, 2);
  assert.equal(m.added, 1);
});
