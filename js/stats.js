// Collects solved layouts across runs and asks: is the answer random, or are there fixed
// combinations? A "path" is one player's correct column on levels 1..LEVELS (null = unknown).
//
// A run = { id, savedAt, rule, n, names, paths } with one path per player (latin) or a single
// shared path (shared).

import { LEVELS, COLS } from './solver.js';

/** Pull the known answers out of the solver's analysis. Returns null if nothing is known. */
export function extractRun(analysis, n, rule) {
  const players = rule === 'shared' ? 1 : n;
  const paths = Array.from({ length: players }, (_, p) =>
    Array.from({ length: LEVELS }, (_, i) => {
      const c = analysis[i + 1].cands[p];
      return c.length === 1 ? c[0] : null;
    }),
  );
  return paths.some((path) => path.some((c) => c !== null)) ? paths : null;
}

// ---- distributions ------------------------------------------------------------------

function gammaQ(a, x) {
  // regularised upper incomplete gamma Q(a, x), Numerical Recipes style
  if (x <= 0) return 1;
  const gln = lgamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 300; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

function lgamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = z;
  let tmp = z + 5.5;
  tmp -= (z + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / z);
}

/** P(chi-square with df degrees of freedom >= x) */
export const chiSquareP = (x, df) => gammaQ(df / 2, x / 2);

/** P(X >= k) for X ~ Poisson(lambda) */
export function poissonTail(k, lambda) {
  if (k <= 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = 0;
  for (let i = 0; i < k; i++) {
    cdf += term;
    term *= lambda / (i + 1);
  }
  return Math.max(0, 1 - cdf);
}

// ---- analysis -----------------------------------------------------------------------

const knownPrefix = (path) => {
  let k = 0;
  while (k < LEVELS && path[k] !== null && path[k] !== undefined) k++;
  return k;
};

/**
 * Everything the stats panel shows. `minPaths` is how much data is needed before a verdict.
 */
export function summarize(runs, { minPaths = 12 } = {}) {
  const all = runs.flatMap((run) => run.paths.map((path) => ({ run: run.id, path })));

  // column frequency per level, uniform-ness
  const levels = Array.from({ length: LEVELS }, (_, i) => {
    const counts = new Array(COLS).fill(0);
    for (const { path } of all) if (path[i] !== null && path[i] !== undefined) counts[path[i]]++;
    const total = counts.reduce((a, b) => a + b, 0);
    let chi2 = 0;
    for (const c of counts) chi2 += ((c - total / COLS) ** 2) / (total / COLS || 1);
    return { level: i + 1, counts, total, chi2, p: total >= 8 ? chiSquareP(chi2, COLS - 1) : null };
  });

  // does the column on level L+1 depend on the one on level L?
  const table = Array.from({ length: COLS }, () => new Array(COLS).fill(0));
  let pairs = 0;
  let same = 0;
  for (const { path } of all) {
    for (let i = 0; i + 1 < LEVELS; i++) {
      if (path[i] == null || path[i + 1] == null) continue;
      table[path[i]][path[i + 1]]++;
      pairs++;
      if (path[i] === path[i + 1]) same++;
    }
  }
  let tChi2 = 0;
  const rowT = table.map((r) => r.reduce((a, b) => a + b, 0));
  const colT = [0, 1, 2, 3].map((c) => table.reduce((a, r) => a + r[c], 0));
  for (let r = 0; r < COLS; r++) {
    for (let c = 0; c < COLS; c++) {
      const e = (rowT[r] * colT[c]) / (pairs || 1);
      if (e > 0) tChi2 += ((table[r][c] - e) ** 2) / e;
    }
  }
  const transitions = { table, pairs, sameRate: pairs ? same / pairs : null, chi2: tChi2, p: pairs >= 40 ? chiSquareP(tChi2, (COLS - 1) ** 2) : null };

  // do different runs share the same opening sequence more often than chance?
  const repeats = [];
  for (let m = 1; m <= LEVELS; m++) {
    const groups = new Map();
    let N = 0;
    for (const { run, path } of all) {
      if (knownPrefix(path) < m) continue;
      N++;
      const key = path.slice(0, m).join('');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(run);
    }
    // cross-run pairs only: teammates in one run can never hold the same path
    const perRun = new Map();
    for (const { run, path } of all) if (knownPrefix(path) >= m) perRun.set(run, (perRun.get(run) || 0) + 1);
    let crossPairs = (N * (N - 1)) / 2;
    for (const k of perRun.values()) crossPairs -= (k * (k - 1)) / 2;
    let observed = 0;
    let top = null;
    for (const [key, list] of groups) {
      const byRun = new Map();
      for (const r of list) byRun.set(r, (byRun.get(r) || 0) + 1);
      let g = (list.length * (list.length - 1)) / 2;
      for (const k of byRun.values()) g -= (k * (k - 1)) / 2;
      observed += g;
      if (!top || list.length > top.count) top = { prefix: key.split('').map(Number), count: list.length };
    }
    const expected = crossPairs / COLS ** m;
    repeats.push({ prefix: m, paths: N, distinct: groups.size, observed, expected, p: crossPairs >= 10 ? poissonTail(observed, expected) : null, top });
  }

  // verdict
  const nPaths = all.filter(({ path }) => knownPrefix(path) >= 1).length;
  let verdict = 'insufficient';
  const flagged = [];
  if (nPaths >= minPaths) {
    for (const r of repeats) if (r.p !== null && r.p < 0.001 && r.observed >= 3) flagged.push(`repeat@${r.prefix}`);
    for (const l of levels) if (l.p !== null && l.p < 0.001) flagged.push(`level${l.level}`);
    if (transitions.p !== null && transitions.p < 0.001) flagged.push('transitions');
    verdict = flagged.length ? 'pattern' : 'random';
  }
  return { runs: runs.length, paths: nPaths, levels, transitions, repeats, verdict, flagged };
}

/**
 * Given the contiguous known prefix of one player's path, what did stored paths do next?
 * Returns {matches, counts[4], next, share} or null when there is nothing to go on.
 */
export function predictNext(runs, prefix, { excludeRun = null } = {}) {
  const k = prefix.length;
  if (k >= LEVELS) return null;
  const counts = new Array(COLS).fill(0);
  let matches = 0;
  for (const run of runs) {
    if (run.id === excludeRun) continue;
    for (const path of run.paths) {
      if (path[k] == null) continue;
      if (prefix.every((c, i) => path[i] === c)) {
        counts[path[k]]++;
        matches++;
      }
    }
  }
  if (!matches) return null;
  const next = counts.indexOf(Math.max(...counts));
  return { matches, counts, next, share: counts[next] / matches };
}

// ---- export / import ----------------------------------------------------------------

export function runsToCSV(runs) {
  const head = ['run_id', 'saved_at', 'rule', 'player', 'name', ...Array.from({ length: LEVELS }, (_, i) => `L${i + 1}`)];
  const lines = [head.join(',')];
  for (const run of runs) {
    run.paths.forEach((path, p) => {
      const name = (run.names?.[p] ?? '').replace(/"/g, '""');
      lines.push([run.id, new Date(run.savedAt).toISOString(), run.rule, p + 1, `"${name}"`, ...path.map((c) => (c == null ? '' : c + 1))].join(','));
    });
  }
  return lines.join('\n');
}

/** Validate + merge imported runs (by id). Returns the merged list and how many were new. */
export function mergeRuns(existing, incoming) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  let added = 0;
  for (const r of Array.isArray(incoming) ? incoming : []) {
    const ok =
      r &&
      typeof r.id === 'string' &&
      (r.rule === 'latin' || r.rule === 'shared') &&
      Array.isArray(r.paths) &&
      r.paths.every((p) => Array.isArray(p) && p.length === LEVELS && p.every((c) => c === null || (Number.isInteger(c) && c >= 0 && c < COLS)));
    if (!ok) continue;
    if (!byId.has(r.id)) added++;
    byId.set(r.id, { id: r.id, savedAt: Number(r.savedAt) || Date.now(), rule: r.rule, n: r.paths.length, names: Array.isArray(r.names) ? r.names.map(String) : [], paths: r.paths });
  }
  return { runs: [...byId.values()], added };
}
