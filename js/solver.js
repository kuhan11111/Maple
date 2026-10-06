// Inference + advice for the 10-level / 4-platform climb.
//
// A "fact" is { level, player, col, ok } : player stood on (level, col) and either
// stayed (ok) or was sent back to the bottom (!ok). Levels are 1..LEVELS, cols 0..COLS-1
// (left to right).
//
// Two rule sets are supported because the in-game wording is ambiguous:
//   latin  - every player has their own correct platform per level, and no two players
//            share one (a platform that is right for a teammate is wrong for you).
//   shared - one correct platform per level for the whole team.

export const LEVELS = 10;
export const COLS = 4;

const assignmentCache = new Map();

/** Every possible player -> column assignment for one level under the given rules. */
export function assignments(nPlayers, mode) {
  const key = `${mode}:${nPlayers}`;
  let all = assignmentCache.get(key);
  if (all) return all;
  all = [];
  if (mode === 'shared') {
    for (let c = 0; c < COLS; c++) all.push(new Array(nPlayers).fill(c));
  } else {
    const cur = [];
    const used = new Array(COLS).fill(false);
    const rec = () => {
      if (cur.length === nPlayers) {
        all.push(cur.slice());
        return;
      }
      for (let c = 0; c < COLS; c++) {
        if (used[c]) continue;
        used[c] = true;
        cur.push(c);
        rec();
        cur.pop();
        used[c] = false;
      }
    };
    rec();
  }
  assignmentCache.set(key, all);
  return all;
}

/**
 * Candidate columns per player for one level, by enumerating every assignment that
 * agrees with the facts. Contradictory facts (a mis-detection) fall back to plain
 * per-player elimination and set `conflict`.
 */
export function analyzeLevel(facts, nPlayers, mode) {
  const sols = assignments(nPlayers, mode).filter((s) =>
    facts.every((f) => (s[f.player] === f.col) === f.ok),
  );
  if (sols.length) {
    const cands = Array.from({ length: nPlayers }, (_, p) =>
      [...new Set(sols.map((s) => s[p]))].sort((a, b) => a - b),
    );
    return { cands, solutions: sols, conflict: false };
  }
  const cands = Array.from({ length: nPlayers }, (_, p) => {
    const mine = facts.filter((f) => mode === 'shared' || f.player === p);
    const ok = mine.filter((f) => f.ok).pop();
    if (ok) return [ok.col];
    const left = [0, 1, 2, 3].filter((c) => !mine.some((f) => !f.ok && f.col === c));
    return left.length ? left : [0, 1, 2, 3];
  });
  return { cands, solutions: null, conflict: true };
}

/** analysis[L] for L = 1..LEVELS (index 0 unused). */
export function analyze(facts, nPlayers, mode) {
  const byLevel = Array.from({ length: LEVELS + 1 }, () => []);
  for (const f of facts) if (f.level >= 1 && f.level <= LEVELS) byLevel[f.level].push(f);
  const out = [null];
  for (let L = 1; L <= LEVELS; L++) out.push(analyzeLevel(byLevel[L], nPlayers, mode));
  return out;
}

/**
 * Work out what every player should do next.
 *
 *   facts       known results so far
 *   levels      current confirmed level of each player (0 = bottom), length = team size
 *   mode        'latin' | 'shared'
 *   maxTesters  shared mode only: how many players may probe the same level at once
 *   prev        previous advice per player ({level, col}) - kept when still valid so the
 *               suggestion does not flip around between calls
 *   pending     attempts happening right now ({player, level, col}); teammates are steered
 *               away from those platforms
 *
 * Each plan: { player, level, done, route[], testLevel, cands[], ready, wait, test }
 *   route  known steps still to climb, [{level, col}]
 *   test   {level, col} to probe at testLevel, or null
 */
export function advise({ facts, levels, mode = 'latin', maxTesters = COLS, prev = [], pending = [] }) {
  const n = levels.length;
  const analysis = analyze(facts, n, mode);
  const pendingCol = (p, L) => pending.find((q) => q.player === p && q.level === L)?.col;
  const prevCol = (p, L) => (prev[p] && prev[p].level === L ? prev[p].col : undefined);

  const plans = levels.map((level, player) => {
    const route = [];
    let testLevel = null;
    for (let L = level + 1; L <= LEVELS; L++) {
      const c = analysis[L].cands[player];
      if (c.length === 1) route.push({ level: L, col: c[0] });
      else {
        testLevel = L;
        break;
      }
    }
    return {
      player,
      level,
      done: level >= LEVELS,
      route,
      testLevel,
      cands: testLevel ? analysis[testLevel].cands[player] : [],
      ready: testLevel !== null && level === testLevel - 1,
      wait: false,
      test: null,
    };
  });

  const testLevels = [...new Set(plans.filter((pl) => pl.testLevel).map((pl) => pl.testLevel))];
  for (const L of testLevels) {
    const group = plans.filter((pl) => pl.testLevel === L);
    const a = analysis[L];
    if (mode === 'latin' && a.solutions) {
      // Pick one complete, consistent assignment and hand each tester their column from
      // it, so concurrent testers never share a platform.
      let best = null;
      let bestScore = -1;
      for (const s of a.solutions) {
        let score = 0;
        for (const pl of group) {
          if (pendingCol(pl.player, L) === s[pl.player]) score += 100;
          if (prevCol(pl.player, L) === s[pl.player]) score += 1;
        }
        if (score > bestScore) {
          best = s;
          bestScore = score;
        }
      }
      for (const pl of group) pl.test = { level: L, col: best[pl.player] };
    } else {
      assignDistinct(group, L, mode === 'shared' ? maxTesters : COLS, pendingCol, prevCol);
    }
  }
  return { analysis, plans, conflicts: analysis.flatMap((a, L) => (a && a.conflict ? [L] : [])) };
}

// Give each tester a different column from their candidates. Players who are already
// standing at the frontier choose first; the rest get a provisional pick.
function assignDistinct(group, L, maxTesters, pendingCol, prevCol) {
  const order = group
    .slice()
    .sort((x, y) => Number(y.ready) - Number(x.ready) || y.level - x.level || x.player - y.player);
  const used = new Set();
  let testers = 0;
  for (const pl of order) {
    const free = pl.cands.filter((c) => !used.has(c));
    if (testers >= maxTesters || !free.length) {
      pl.wait = true;
      continue;
    }
    const pick = [pendingCol(pl.player, L), prevCol(pl.player, L)].find((c) => c !== undefined && free.includes(c)) ?? free[0];
    used.add(pick);
    testers++;
    pl.test = { level: L, col: pick };
  }
}
