// Builds the lookup database (data/db.json) from tables you export from a spreadsheet.
//
//   monsters  name, level, hp, exp, maps, aliases, note
//   items     name, type, aliases, note
//   drops     monster, item, rate, note
//
// Header names may be English or Chinese (see HEADERS); extra columns are ignored. Drops that
// mention a monster or item missing from the other tables create a bare entry for it, so a
// single drops table is already enough to get going.

import { parseTable } from './csv.js';

export const HEADERS = {
  monster: {
    name: ['name', 'monster', '怪物', '怪物名稱', '名稱'],
    level: ['level', 'lv', 'lvl', '等級'],
    hp: ['hp', '血量', '生命', '生命值'],
    exp: ['exp', 'xp', '經驗', '經驗值'],
    maps: ['maps', 'map', '地圖', '出沒地圖', '出沒地點', '地點', '棲息地'],
    aliases: ['aliases', 'alias', '別名', '簡稱', '又名'],
    note: ['note', 'notes', '備註', '說明'],
  },
  item: {
    name: ['name', 'item', '道具', '道具名稱', '物品', '物品名稱', '名稱'],
    type: ['type', 'category', '類型', '分類', '種類'],
    aliases: ['aliases', 'alias', '別名', '簡稱', '又名'],
    note: ['note', 'notes', '備註', '說明', '效果'],
  },
  drop: {
    monster: ['monster', '怪物', '怪物名稱', '來源'],
    item: ['item', '道具', '道具名稱', '物品', '物品名稱', '掉落物', '掉落'],
    rate: ['rate', 'chance', '機率', '掉落率', '掉率', '爆率'],
    note: ['note', 'notes', '備註', '說明'],
  },
};

const clean = (s) => String(s ?? '').normalize('NFKC').trim();
const key = (s) => clean(s).toLowerCase().replace(/\s+/g, '');
const SPLIT = /[;；、,，|]/;

/** Value of the first column whose header matches one of `names`. */
function pick(row, names) {
  const wanted = names.map(key);
  for (const [h, v] of Object.entries(row)) if (wanted.includes(key(h)) && clean(v) !== '') return clean(v);
  return '';
}
const list = (v) => [...new Set(clean(v).split(SPLIT).map(clean).filter(Boolean))];
const toNum = (v) => {
  const n = Number(clean(v).replace(/[,，\s]/g, ''));
  return clean(v) !== '' && Number.isFinite(n) ? n : null;
};

/** "0.5%" -> 0.005, "1/200" -> 0.005, "0.005" -> 0.005, "5" -> 0.05 (plain numbers above 1 are percentages). */
export function parseRate(v) {
  const text = clean(v);
  if (!text) return { rate: null, rateText: '' };
  let m;
  let rate = null;
  if ((m = /^(\d+(?:\.\d+)?)\s*%$/.exec(text))) rate = Number(m[1]) / 100;
  else if ((m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text)) && Number(m[2]) > 0) rate = Number(m[1]) / Number(m[2]);
  else if ((m = /^\d+(?:\.\d+)?$/.exec(text))) rate = Number(text) > 1 ? Number(text) / 100 : Number(text);
  return { rate: rate !== null && rate >= 0 && rate <= 1 ? rate : null, rateText: text };
}

export const slug = (name) => key(name).replace(/[^\p{L}\p{N}]+/gu, '') || key(name);

/** rows are objects as produced by parseTable (or any JSON array with the same headers). */
export function buildDb({ monsters = [], items = [], drops = [] }, meta = {}) {
  const mon = new Map();
  const itm = new Map();
  const warnings = [];

  const addMonster = (name, extra = {}) => {
    const id = slug(name);
    const cur = mon.get(id) ?? { id, name: clean(name), aliases: [], level: null, hp: null, exp: null, maps: [], note: '' };
    cur.aliases = [...new Set([...cur.aliases, ...(extra.aliases ?? [])])];
    cur.maps = [...new Set([...cur.maps, ...(extra.maps ?? [])])];
    for (const k of ['level', 'hp', 'exp']) cur[k] ??= extra[k] ?? null;
    cur.note ||= extra.note ?? '';
    mon.set(id, cur);
    return cur;
  };
  const addItem = (name, extra = {}) => {
    const id = slug(name);
    const cur = itm.get(id) ?? { id, name: clean(name), aliases: [], type: '', note: '' };
    cur.aliases = [...new Set([...cur.aliases, ...(extra.aliases ?? [])])];
    cur.type ||= extra.type ?? '';
    cur.note ||= extra.note ?? '';
    itm.set(id, cur);
    return cur;
  };

  monsters.forEach((r, i) => {
    const name = pick(r, HEADERS.monster.name);
    if (!name) return warnings.push(`monsters 第 ${i + 2} 列沒有名稱,略過`);
    addMonster(name, {
      level: toNum(pick(r, HEADERS.monster.level)),
      hp: toNum(pick(r, HEADERS.monster.hp)),
      exp: toNum(pick(r, HEADERS.monster.exp)),
      maps: list(pick(r, HEADERS.monster.maps)),
      aliases: list(pick(r, HEADERS.monster.aliases)),
      note: pick(r, HEADERS.monster.note),
    });
  });
  items.forEach((r, i) => {
    const name = pick(r, HEADERS.item.name);
    if (!name) return warnings.push(`items 第 ${i + 2} 列沒有名稱,略過`);
    addItem(name, { type: pick(r, HEADERS.item.type), aliases: list(pick(r, HEADERS.item.aliases)), note: pick(r, HEADERS.item.note) });
  });

  const out = new Map();
  drops.forEach((r, i) => {
    const mName = pick(r, HEADERS.drop.monster);
    const iName = pick(r, HEADERS.drop.item);
    if (!mName || !iName) return warnings.push(`drops 第 ${i + 2} 列缺少怪物或道具,略過`);
    const m = mon.get(slug(mName)) ?? addMonster(mName);
    const it = itm.get(slug(iName)) ?? addItem(iName);
    const { rate, rateText } = parseRate(pick(r, HEADERS.drop.rate));
    out.set(`${m.id}>${it.id}`, { monster: m.id, item: it.id, rate, rateText, note: pick(r, HEADERS.drop.note) });
  });

  const db = {
    meta: { ...meta, importedAt: new Date().toISOString() },
    monsters: [...mon.values()],
    items: [...itm.values()],
    drops: [...out.values()],
  };
  db.meta.counts = { monsters: db.monsters.length, items: db.items.length, drops: db.drops.length };
  return { db, warnings };
}

export const tableFromText = (text, name = '') => (/\.json$/i.test(name) ? JSON.parse(text) : parseTable(text));
