// Player reports: drops, levels and maps that are not in the imported database yet (a brand new map,
// say). Stored separately from db.json and merged in at load time, always marked as unconfirmed.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const LIMITS = { perUserPerDay: 15, total: 5000, name: 30, rate: 20, map: 30, source: 200 };

const clean = (s, max) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/@(everyone|here)/gi, '$1')
    .replace(/<[@#][!&]?\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const safeSource = (s) => {
  const t = clean(s, LIMITS.source);
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^https?:\/\//i.test(t)) return ''; // no javascript:, file: ...
  return t;
};

export class Reports {
  constructor(path = null, { now = () => Date.now(), delayMs = 500 } = {}) {
    Object.assign(this, { path, now, delayMs });
    this.items = [];
    this.nextId = 1;
    this.timer = null;
    this.version = 0; // bumps on every change so readers know to rebuild
    if (path && existsSync(path)) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8'));
        this.items = Array.isArray(d.items) ? d.items : [];
        this.nextId = d.nextId ?? this.items.reduce((m, r) => Math.max(m, r.id), 0) + 1;
      } catch {
        this.items = []; // unreadable file: start over rather than crash
      }
    }
  }

  /** -> {ok:true, id, updated} | {ok:false, message} */
  add({ monster, item, rate, map, source, userId }) {
    const r = {
      monster: clean(monster, LIMITS.name),
      item: clean(item, LIMITS.name),
      rate: clean(rate, LIMITS.rate),
      map: clean(map, LIMITS.map),
      source: safeSource(source),
    };
    if (!r.monster || !r.item) return { ok: false, message: '要填怪物和道具的名字。' };
    const key = (x) => x.monster.toLowerCase() + '\u0000' + x.item.toLowerCase();
    const mine = this.items.find((x) => x.userId === userId && key(x) === key(r));
    if (mine) {
      Object.assign(mine, { rate: r.rate || mine.rate, map: r.map || mine.map, source: r.source || mine.source, at: this.now() });
      this.#changed();
      return { ok: true, id: mine.id, updated: true };
    }
    const dayAgo = this.now() - 24 * 60 * 60 * 1000;
    if (this.items.filter((x) => x.userId === userId && x.at > dayAgo).length >= LIMITS.perUserPerDay) return { ok: false, message: `你今天回報太多了(一天最多 ${LIMITS.perUserPerDay} 筆),明天再來吧。` };
    if (this.items.length >= LIMITS.total) return { ok: false, message: '回報資料已滿,請通知管理員整理。' };
    const rec = { id: this.nextId++, ...r, userId, at: this.now() };
    this.items.push(rec);
    this.#changed();
    return { ok: true, id: rec.id, updated: false };
  }

  /** Removes a report if it is yours or you are an admin. */
  remove(id, { userId, admin = false }) {
    const r = this.items.find((x) => x.id === id);
    if (!r) return { ok: false, message: `找不到編號 #${id} 的回報。` };
    if (!admin && r.userId !== userId) return { ok: false, message: '只能刪除自己的回報(管理員可以刪全部)。' };
    this.items = this.items.filter((x) => x !== r);
    this.#changed();
    return { ok: true, report: r };
  }

  #changed() {
    this.version++;
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ nextId: this.nextId, items: this.items }));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
