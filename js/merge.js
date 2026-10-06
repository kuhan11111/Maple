// Conflict-free merging of the result log between devices.
//
// Every entry is keyed by (player, level, col) and carries the time it was written; the newest
// write for a key wins. Deleting an entry leaves a tombstone (key -> time) so an older copy
// arriving late cannot bring it back. Applying the same set of entries / tombstones in any
// order, any number of times, gives the same log - which is what keeps four players' screens
// in agreement.

import { LEVELS, COLS } from './solver.js';

export const keyOf = (e) => `${e.player}:${e.level}:${e.col}`;

/** Accept only well-formed entries (they arrive from other people's browsers). */
export function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const { player, level, col, type, t } = e;
  if (!Number.isInteger(player) || player < 0 || player > 3) return null;
  if (!Number.isInteger(level) || level < 1 || level > LEVELS) return null;
  if (!Number.isInteger(col) || col < 0 || col >= COLS) return null;
  if (type !== 'ok' && type !== 'bad') return null;
  if (!Number.isFinite(t)) return null;
  return { player, level, col, type, t, source: e.source === 'auto' ? 'auto' : 'manual' };
}

/**
 * Merge `incoming` ({entries, tombs}) into `base` ({log, tomb}). Pure: returns new objects and
 * whether anything changed. `nextId` supplies ids for entries that are new to this device.
 */
export function mergeLog(base, incoming, nextId) {
  const tomb = { ...base.tomb };
  let log = base.log.slice();
  let changed = false;

  for (const [k, ts] of Object.entries(incoming.tombs || {})) {
    if (!Number.isFinite(ts) || !(ts > (tomb[k] ?? 0))) continue;
    tomb[k] = ts;
    log = log.filter((e) => !(keyOf(e) === k && e.t <= ts));
    changed = true;
  }

  for (const raw of incoming.entries || []) {
    const e = cleanEntry(raw);
    if (!e) continue;
    const k = keyOf(e);
    if ((tomb[k] ?? 0) >= e.t) continue;
    const cur = log.find((x) => keyOf(x) === k);
    if (cur && (cur.t > e.t || (cur.t === e.t && cur.type >= e.type))) continue;
    log = log.filter((x) => x !== cur);
    log.push({ ...e, id: nextId() });
    changed = true;
  }
  return { log, tomb, changed };
}
