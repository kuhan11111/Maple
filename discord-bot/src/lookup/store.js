// Loads data/db.json and answers the questions the commands ask: what does a monster drop,
// who drops an item, what lives on a map.

import { readFileSync, existsSync } from 'node:fs';

export class Db {
  constructor(raw = {}) {
    this.meta = raw.meta ?? {};
    this.monsters = raw.monsters ?? [];
    this.items = raw.items ?? [];
    this.drops = raw.drops ?? [];
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

export function loadDb(path) {
  if (!existsSync(path)) return new Db();
  return new Db(JSON.parse(readFileSync(path, 'utf8')));
}
