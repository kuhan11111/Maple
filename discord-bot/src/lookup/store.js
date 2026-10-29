// Loads data/db.json and answers the questions the commands ask: what does a monster drop,
// who drops an item, what lives on a map.

import { readFileSync, existsSync } from 'node:fs';
import { slug, parseRate } from './import.js';

const mostCommon = (arr) => {
  const n = new Map();
  for (const x of arr.filter(Boolean)) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
};

/**
 * Imported data (raw) is "confirmed". Player reports are layered on top and stay marked as
 * unconfirmed: a drop only they mention gets status 'reported' and the number of different people
 * who reported it; a missing rate / map may be filled from reports.
 */
export class Db {
  constructor(raw = {}, reports = []) {
    this.meta = raw.meta ?? {};
    this.monsters = (raw.monsters ?? []).map((m) => ({ status: 'confirmed', reportedMaps: [], ...m }));
    this.items = (raw.items ?? []).map((i) => ({ status: 'confirmed', ...i }));
    this.drops = (raw.drops ?? []).map((d) => ({ status: 'confirmed', reports: 0, sources: [], ...d }));
    this.reportCount = reports.length;
    this.#applyReports(reports);
    this.monsterById = new Map(this.monsters.map((m) => [m.id, m]));
    this.itemById = new Map(this.items.map((i) => [i.id, i]));
    this.byMonster = new Map();
    this.byItem = new Map();
    for (const d of this.drops) {
      if (!this.monsterById.has(d.monster) || !this.itemById.has(d.item)) continue;
      (this.byMonster.get(d.monster) ?? this.byMonster.set(d.monster, []).get(d.monster)).push(d);
      (this.byItem.get(d.item) ?? this.byItem.set(d.item, []).get(d.item)).push(d);
    }
    this.byMap = new Map();
    for (const m of this.monsters) for (const map of m.maps ?? []) (this.byMap.get(map) ?? this.byMap.set(map, []).get(map)).push(m);
    this.maps = [...this.byMap.keys()];
  }

  #applyReports(reports) {
    const find = (list, name) => list.find((x) => x.id === slug(name) || (x.aliases ?? []).some((a) => slug(a) === slug(name)));
    const groups = new Map();
    for (const r of reports) {
      const k = `${slug(r.monster)}>${slug(r.item)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
    }
    for (const rs of groups.values()) {
      const first = rs[0];
      let m = find(this.monsters, first.monster);
      if (!m) this.monsters.push((m = { id: slug(first.monster), name: first.monster, aliases: [], level: null, hp: null, exp: null, maps: [], note: '', status: 'reported', reportedMaps: [] }));
      let it = find(this.items, first.item);
      if (!it) this.items.push((it = { id: slug(first.item), name: first.item, aliases: [], type: '', note: '', status: 'reported' }));
      for (const map of new Set(rs.map((r) => r.map).filter(Boolean))) {
        if (!m.maps.includes(map)) (m.maps.push(map), m.reportedMaps.push(map));
      }
      const users = new Set(rs.map((r) => r.userId));
      const rate = mostCommon(rs.map((r) => r.rate));
      const sources = [...new Set(rs.map((r) => r.source).filter(Boolean))].slice(0, 2);
      const have = this.drops.find((d) => d.monster === m.id && d.item === it.id);
      if (have) {
        if (!have.rateText && rate) Object.assign(have, { rateText: rate, rate: have.rate ?? parseRate(rate).rate, rateFromReports: true });
        have.reports = users.size;
        have.sources = sources;
      } else {
        this.drops.push({ monster: m.id, item: it.id, rate: parseRate(rate).rate, rateText: rate, note: '', status: 'reported', reports: users.size, sources });
      }
    }
  }

  get empty() {
    return !this.monsters.length && !this.items.length;
  }

  /** Highest rate first; unknown rates last. */
  #byRate = (a, b) => (b.rate ?? -1) - (a.rate ?? -1);

  dropsOf(monsterId) {
    return (this.byMonster.get(monsterId) ?? []).map((d) => ({ ...d, item: this.itemById.get(d.item) })).sort(this.#byRate);
  }

  droppersOf(itemId) {
    return (this.byItem.get(itemId) ?? []).map((d) => ({ ...d, monster: this.monsterById.get(d.monster) })).sort(this.#byRate);
  }

  monstersIn(map) {
    return [...(this.byMap.get(map) ?? [])].sort((a, b) => (a.level ?? 1e9) - (b.level ?? 1e9));
  }
}

export function loadDb(path, reports = []) {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return new Db(raw, reports);
}
