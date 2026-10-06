// Headless simulation of a full run. Used by the demo button and by the tests to check
// that the advice always gets every player to the top without ever repeating a platform.

import { LEVELS, COLS, advise } from './solver.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createSim({ mode = 'latin', n = 4, seed = 1, maxTesters = COLS } = {}) {
  const rnd = mulberry32(seed);
  // truth[L][p] = the column that is correct for player p on level L
  const truth = [null];
  for (let L = 1; L <= LEVELS; L++) {
    if (mode === 'shared') truth.push(new Array(n).fill(Math.floor(rnd() * COLS)));
    else truth.push(shuffle([0, 1, 2, 3], rnd).slice(0, n));
  }
  const sim = {
    truth,
    facts: [],
    levels: new Array(n).fill(0),
    prev: [],
    falls: 0,
    rounds: 0,
    log: [],
    get done() {
      return this.levels.every((l) => l >= LEVELS);
    },
    /** One round: every ready tester attempts at once, everyone else climbs. */
    step() {
      const { plans } = advise({ facts: this.facts, levels: this.levels, mode, maxTesters, prev: this.prev });
      const events = [];
      const seen = new Map();
      for (const pl of plans) {
        if (pl.done) continue;
        if (pl.test && pl.ready) {
          const { level: L, col } = pl.test;
          const key = `${L}:${col}`;
          if (seen.has(key)) {
            throw new Error(`players ${seen.get(key)} and ${pl.player} both sent to level ${L} platform ${col}`);
          }
          seen.set(key, pl.player);
          const ok = truth[L][pl.player] === col;
          this.facts.push({ level: L, player: pl.player, col, ok });
          events.push({ type: ok ? 'ok' : 'bad', player: pl.player, level: L, col });
          if (ok) this.levels[pl.player] = L;
          else {
            this.levels[pl.player] = 0;
            this.falls++;
          }
        } else if (pl.test) {
          this.levels[pl.player] = pl.testLevel - 1; // climbs the known route
          events.push({ type: 'climb', player: pl.player, level: pl.testLevel - 1 });
        } else if (!pl.wait) {
          this.levels[pl.player] = LEVELS; // whole route known
          events.push({ type: 'climb', player: pl.player, level: LEVELS });
        }
      }
      this.prev = plans.map((pl) => pl.test);
      this.rounds++;
      this.log.push(...events);
      return events;
    },
  };
  return sim;
}
