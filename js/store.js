// Shared app state, persistence and the result log (the single source of truth for what
// the team has learned). Both detection and manual input write here through recordResult().

import { Engine } from './engine.js';
import { buildTemplate } from './tracker.js';
import { advise, analyze } from './solver.js';
import { extractRun, mergeRuns } from './stats.js';
import { mergeLog, keyOf } from './merge.js';

export const COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419'];
// ?profile=name keeps a separate saved state per tab (several game clients on one PC)
const PROFILE = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('profile');
const SUFFIX = PROFILE ? `:${PROFILE.slice(0, 16)}` : '';
const KEY = `maple-rj-helper/v1${SUFFIX}`;
const DATA_KEY = `maple-rj-helper/data-v1${SUFFIX}`;

export const DEFAULT_SETTINGS = {
  procWidth: 1280, // frames are scaled down to this width before analysis
  fps: 12,
  matchThreshold: 0.8,
  tagOffsetY: 9, // name tag centre -> feet, in analysed pixels
  tolY: 30, // % of one level's height that still counts as "on that level"
  tolX: 70, // % of one platform spacing
  touchMs: 200, // standing this long = a real stop on a platform
  okMode: 'both', // infer success: 'both' | 'advance' | 'off'
  okStandMs: 1500,
  teleportMs: 250, // platform -> bottom this fast with no air frames = teleported
  collect: true, // keep every run's answers for the pattern statistics
  voice: false,
  autoAdoptFall: false,
};

export const state = {
  mode: 'auto', // 'auto' (screen detection) | 'manual'
  rule: 'latin', // 'latin' (each player has their own platform) | 'shared'
  maxTesters: 4,
  n: 4,
  names: ['玩家 1', '玩家 2', '玩家 3', '玩家 4'],
  log: [], // {id, t, type:'ok'|'bad', player, level, col, source, before?}
  tomb: {}, // "player:level:col" -> time it was deleted (so old copies cannot resurrect it)
  runId: newRunId(),
  runTs: 0, // when the run was last reset; the newest reset wins across the team
  me: 0, // my seat (0-3): the player this copy detects. null = this copy handles everyone
  room: { code: '', via: 'peer' },
  settings: { ...DEFAULT_SETTINGS },
  grid: null, // {x1, y1, x2, y2, groundY, procW, procH}
  tpls: [null, null, null, null], // {raw: Uint8Array, w, h, procW}
};

export const rt = {
  engine: new Engine(4),
  built: [null, null, null, null], // templates ready for Tracker.find
  chosen: [], // manual platform pick per player: {level, col}
  prev: [],
  toasts: [],
  seq: 0,
  remote: [], // latest status from each teammate: {level, col, attempt, intent, name, ts}
  peers: [], // seat -> connected?
  hooks: {}, // set by the sync layer: fact(entry), del(key, ts), reset(runId, runTs)
  data: { runs: [] }, // collected layouts, see stats.js
};

function newRunId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const b64 = (u8) => btoa(Array.from(u8, (c) => String.fromCharCode(c)).join(''));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function save() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...state,
        tpls: state.tpls.map((t) => t && { w: t.w, h: t.h, procW: t.procW, raw: b64(t.raw) }),
      }),
    );
  } catch {
    /* storage unavailable or full - the app still works without persistence */
  }
}

export function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!d) return;
    for (const k of ['mode', 'rule', 'maxTesters', 'n', 'names', 'log', 'tomb', 'runId', 'runTs', 'me', 'room', 'grid']) if (d[k] !== undefined) state[k] = d[k];
    state.settings = { ...DEFAULT_SETTINGS, ...d.settings };
    state.tpls = (d.tpls || []).map((t) => t && { w: t.w, h: t.h, procW: t.procW, raw: unb64(t.raw) });
    while (state.tpls.length < 4) state.tpls.push(null);
    rt.seq = state.log.reduce((m, e) => Math.max(m, e.id), 0);
  } catch {
    /* corrupt storage: start fresh */
  }
  try {
    const d = JSON.parse(localStorage.getItem(DATA_KEY) || 'null');
    if (d && Array.isArray(d.runs)) rt.data = { runs: mergeRuns([], d.runs).runs };
  } catch {
    /* ignore */
  }
  syncEngine();
  rebuildTemplates();
}

function saveData() {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify({ runs: rt.data.runs, currentRun: state.runId }));
  } catch {
    /* ignore */
  }
}

/** Store (or refresh) the answers learned in the current run so they can be analysed later. */
export function collectRun() {
  if (!state.settings.collect || rt.demo) return;
  const analysis = analyze(facts(), state.n, state.rule);
  const paths = extractRun(analysis, state.n, state.rule);
  const others = rt.data.runs.filter((r) => r.id !== state.runId);
  rt.data.runs = paths
    ? [...others, { id: state.runId, savedAt: Date.now(), rule: state.rule, n: paths.length, names: state.names.slice(0, state.n), paths }]
    : others;
  saveData();
}

export function importRuns(incoming) {
  const m = mergeRuns(rt.data.runs, incoming);
  rt.data.runs = m.runs;
  saveData();
  return m.added;
}

export function clearData() {
  rt.data.runs = [];
  saveData();
}

export function syncEngine() {
  rt.engine.resize(state.n);
  const s = state.settings;
  Object.assign(rt.engine.timing, {
    touchMs: s.touchMs,
    okMode: s.okMode,
    okStandMs: s.okStandMs,
    teleportMs: s.teleportMs,
  });
}

export function rebuildTemplates() {
  rt.built = state.tpls.map((t) => (t ? buildTemplate(t.raw, t.w, t.h) : null));
}

export const facts = () =>
  state.log.filter((e) => e.player < state.n).map((e) => ({ level: e.level, player: e.player, col: e.col, ok: e.type === 'ok' }));

const publicEntry = (e) => ({ player: e.player, level: e.level, col: e.col, type: e.type, t: e.t, source: e.source });

/**
 * Record that `player` tried (level, col). With place=true the engine's idea of where the
 * player is gets updated too (manual input); detection has already moved it itself.
 */
export function recordResult(player, level, col, ok, { source = 'manual', place = source === 'manual' } = {}) {
  const P = rt.engine.players[player];
  const before = { level: P.level, col: P.col };
  state.log = state.log.filter((e) => !(e.player === player && e.level === level && e.col === col));
  const entry = { id: ++rt.seq, t: Date.now(), type: ok ? 'ok' : 'bad', player, level, col, source, before };
  state.log.push(entry);
  if (place) rt.engine.place(player, ok ? level : 0, ok ? col : null);
  delete rt.chosen[player];
  save();
  collectRun();
  rt.hooks.fact?.(publicEntry(entry));
}

/** Drop a log entry; with restore=true also put the player back where they were. */
export function removeEntry(id, restore = false) {
  const e = state.log.find((x) => x.id === id);
  if (!e) return;
  state.log = state.log.filter((x) => x.id !== id);
  if (restore && e.before) rt.engine.place(e.player, e.before.level, e.before.col);
  const ts = Math.max(Date.now(), e.t + 1);
  state.tomb[keyOf(e)] = ts;
  save();
  collectRun();
  rt.hooks.del?.(keyOf(e), ts);
}

function clearRun() {
  state.log = [];
  state.tomb = {};
  rt.engine.reset();
  rt.chosen = [];
  rt.prev = [];
  rt.toasts = [];
}

export function resetRun() {
  collectRun(); // keep what this run taught us
  rt.demo = false;
  state.runId = newRunId();
  state.runTs = Date.now();
  clearRun();
  save();
  rt.hooks.reset?.(state.runId, state.runTs);
}

// ---- team sync ------------------------------------------------------------------------

export const snapshot = () => ({ runId: state.runId, runTs: state.runTs, entries: state.log.map(publicEntry), tombs: state.tomb });

/** Merge entries/tombstones from a teammate. Returns true if the log changed. */
export function mergeRemote(incoming) {
  const r = mergeLog({ log: state.log, tomb: state.tomb }, incoming, () => ++rt.seq);
  if (!r.changed) return false;
  state.log = r.log;
  state.tomb = r.tomb;
  save();
  collectRun();
  return true;
}

/**
 * A teammate announced a run. The newest reset wins and replaces ours; the same run just gets
 * merged. Returns 'adopted' | 'merged' | 'ignored'.
 */
export function adoptRun({ runId, runTs }) {
  const adopt = () => {
    collectRun();
    state.runId = runId;
    state.runTs = runTs;
    clearRun();
    save();
    return 'adopted';
  };
  if (runTs > state.runTs) return adopt();
  if (runTs < state.runTs) return 'ignored';
  if (runId === state.runId) return 'merged';
  if (state.runTs === 0) {
    // two fresh copies that never reset: share one id (the smaller) so their data is one run
    if (runId < state.runId) {
      rt.data.runs = rt.data.runs.filter((r) => r.id !== state.runId);
      state.runId = runId;
      save();
    }
    return 'merged';
  }
  return runId < state.runId ? adopt() : 'ignored'; // reset in the same millisecond: smaller id wins
}

export function applySnapshot(snap) {
  const how = adoptRun(snap);
  if (how !== 'ignored') mergeRemote(snap);
  return how;
}

/** A teammate's live position. Returns {changed, names}. */
export function applyStatus(s) {
  rt.remote[s.slot] = { ...s, ts: Date.now() };
  const P = rt.engine.players[s.slot];
  if (!P || s.slot === state.me) return { changed: false, names: false };
  const attempt = s.attempt ? { ...s.attempt, tLast: Date.now() } : null;
  const changed = P.level !== s.level || P.col !== s.col || JSON.stringify(P.attempt && [P.attempt.level, P.attempt.col]) !== JSON.stringify(attempt && [attempt.level, attempt.col]);
  Object.assign(P, { level: s.level, col: s.col, attempt, lost: false, cell: null });
  const names = !!s.name && s.name !== state.names[s.slot];
  if (names) state.names[s.slot] = s.name;
  return { changed, names };
}

/** What this copy tells the others about itself (null when it handles everyone). */
export function myStatus() {
  if (state.me === null) return null;
  const P = rt.engine.players[state.me];
  const t = rt.prev[state.me];
  return {
    slot: state.me,
    level: P.level,
    col: P.col,
    attempt: P.attempt ? { level: P.attempt.level, col: P.attempt.col } : null,
    intent: t ? { level: t.level, col: t.col } : null,
    name: state.names[state.me],
  };
}

/** Seats whose tag this screen watches: just mine, or all of them when one copy handles everyone. */
export const watched = (p) => state.me === null || state.me === p;

export const isOnline = (p) => rt.peers[p] === true || (!!rt.remote[p] && Date.now() - rt.remote[p].ts < 6000);

/** Current advice for everyone. */
export function computeAdvice() {
  const levels = rt.engine.players.slice(0, state.n).map((P) => P.level);
  const pending = state.mode === 'auto' ? rt.engine.pending() : [];
  rt.chosen.forEach((c, player) => c && player < state.n && pending.push({ player, ...c }));
  // With teammates connected, the advice they were given is the one they publish.
  const prev = state.me === null ? rt.prev : Array.from({ length: state.n }, (_, p) => (p === state.me ? rt.prev[p] : (rt.remote[p] && rt.remote[p].intent) || null));
  const res = advise({ facts: facts(), levels, mode: state.rule, maxTesters: state.maxTesters, prev, pending });
  rt.prev = res.plans.map((pl) => pl.test);
  return res;
}
