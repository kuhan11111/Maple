// Fixtures are made up; not real Artale data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reports, LIMITS } from '../src/lookup/reports.js';
import { Db } from '../src/lookup/store.js';
import { buildDb } from '../src/lookup/import.js';
import { Index } from '../src/lookup/search.js';
import { renderMonster, renderItem, renderMap } from '../src/lookup/render.js';
import { createDbSource } from '../src/dbsource.js';

const base = () =>
  buildDb(
    {
      monsters: [{ 怪物: '藍寶', 等級: '12', HP: '300', 經驗: '25', 地圖: '舊森林', 別名: '小藍' }],
      drops: [{ 怪物: '藍寶', 道具: '藍色水滴', 機率: '20%' }, { 怪物: '藍寶', 道具: '神秘粉末' }],
    },
    { source: '測試' },
  ).db;

test('reports: validation, sanitising, duplicates, limits', () => {
  let t = 1_000_000;
  const r = new Reports(null, { now: () => t });
  assert.equal(r.add({ monster: '', item: 'x', userId: 'u' }).ok, false);
  assert.equal(r.add({ monster: 'x', item: '  ', userId: 'u' }).ok, false);
  const ok = r.add({ monster: '新怪 @everyone <@123>', item: '新\u0000道具', rate: ' 1/200 ', map: '新地圖', source: 'https://a.example/p/1', userId: 'u1' });
  assert.deepEqual([ok.ok, ok.id, ok.updated], [true, 1, false]);
  const [rec] = r.items;
  assert.equal(rec.monster, '新怪 everyone');
  assert.equal(rec.item, '新 道具');
  assert.equal(rec.rate, '1/200');
  assert.equal(r.add({ monster: 'x', item: 'y', source: 'javascript:alert(1)', userId: 'u2' }).ok, true);
  assert.equal(r.items[1].source, '', 'non-http schemes are dropped');
  assert.equal(r.add({ monster: 'z'.repeat(80), item: 'y', userId: 'u3' }).ok, true);
  assert.equal(r.items[2].monster.length, LIMITS.name);
  // the same person reporting the same drop again updates it instead of counting twice
  const again = r.add({ monster: '新怪 everyone', item: '新 道具', rate: '1/100', userId: 'u1' });
  assert.deepEqual([again.updated, again.id], [true, 1]);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].rate, '1/100');
  assert.equal(r.items[0].map, '新地圖', 'fields left empty keep their old value');
  const v = r.version;
  r.add({ monster: 'q', item: 'w', userId: 'u9' });
  assert.ok(r.version > v);
  for (let k = 0; k < LIMITS.perUserPerDay; k++) assert.equal(r.add({ monster: `m${k}`, item: 'i', userId: 'spammer' }).ok, true);
  assert.match(r.add({ monster: 'one more', item: 'i', userId: 'spammer' }).message, /今天回報太多/);
  t += 25 * 3600_000;
  assert.equal(r.add({ monster: 'one more', item: 'i', userId: 'spammer' }).ok, true, 'the limit resets after a day');
});

test('reports: who may delete', () => {
  const r = new Reports(null);
  const { id } = r.add({ monster: 'a', item: 'b', userId: 'owner' });
  assert.match(r.remove(id, { userId: 'stranger' }).message, /只能刪除自己的/);
  assert.match(r.remove(999, { userId: 'owner' }).message, /找不到/);
  assert.equal(r.remove(id, { userId: 'owner' }).ok, true);
  const second = r.add({ monster: 'a', item: 'b', userId: 'owner' }).id;
  assert.equal(r.remove(second, { userId: 'admin', admin: true }).ok, true);
  assert.equal(r.items.length, 0);
});

test('reports persist and keep counting ids', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rep-')), 'r.json');
  const r = new Reports(path);
  r.add({ monster: 'a', item: 'b', userId: 'u' });
  r.add({ monster: 'c', item: 'd', userId: 'u' });
  r.remove(1, { userId: 'u' });
  r.flush();
  const back = new Reports(path);
  assert.deepEqual(back.items.map((x) => x.id), [2]);
  assert.equal(back.add({ monster: 'e', item: 'f', userId: 'u' }).id, 3, 'ids are never reused');
  assert.equal(new Reports(join(path, '..', 'missing.json')).items.length, 0);
});

const rep = (o) => ({ id: 1, monster: '', item: '', rate: '', map: '', source: '', userId: 'u', at: 0, ...o });

test('overlay: a brand new monster and item exist only as player reports, counted by distinct people', () => {
  const db = new Db(base(), [
    rep({ monster: '新地圖怪', item: '新材料', rate: '1%', map: '新地圖', userId: 'a' }),
    rep({ monster: '新地圖怪', item: '新材料', rate: '1%', userId: 'b' }),
    rep({ monster: '新地圖怪', item: '新材料', rate: '2%', userId: 'c', source: 'https://x.example/1' }),
    rep({ monster: '新地圖怪', item: '另一個', userId: 'a' }),
  ]);
  const m = db.monsters.find((x) => x.name === '新地圖怪');
  assert.equal(m.status, 'reported');
  assert.deepEqual([m.level, m.hp, m.maps, m.reportedMaps], [null, null, ['新地圖'], ['新地圖']]);
  const drops = db.dropsOf(m.id);
  const mat = drops.find((d) => d.item.name === '新材料');
  assert.deepEqual([mat.status, mat.reports, mat.rateText], ['reported', 3, '1%'], 'the most common rate wins');
  assert.equal(mat.rate, 0.01, 'a numeric rate is parsed for sorting');
  assert.deepEqual(mat.sources, ['https://x.example/1']);
  assert.equal(db.dropsOf(m.id).find((d) => d.item.name === '另一個').reports, 1);
  assert.deepEqual(db.maps.sort(), ['新地圖', '舊森林'].sort());
  assert.equal(new Index(db).search('新地圖怪')[0].kind, 'monster');
});

test('overlay: reports fill a missing rate but never overwrite a known one, and match by alias', () => {
  const db = new Db(base(), [
    rep({ monster: '小藍', item: '神秘粉末', rate: '5%', userId: 'a' }), // alias of 藍寶; rate unknown in the database
    rep({ monster: '藍寶', item: '藍色水滴', rate: '99%', userId: 'b' }), // database says 20%
  ]);
  assert.equal(db.monsters.length, 1, 'no duplicate monster for an alias');
  const drops = db.dropsOf(db.monsters[0].id);
  const powder = drops.find((d) => d.item.name === '神秘粉末');
  assert.deepEqual([powder.rateText, powder.rateFromReports, powder.status], ['5%', true, 'confirmed']);
  const drop = drops.find((d) => d.item.name === '藍色水滴');
  assert.deepEqual([drop.rateText, drop.reports], ['20%', 1], 'the imported rate stays; the report is just counted');
  assert.equal(drop.rateFromReports, undefined);
});

test('render: anything missing says (未知); player-reported data is tagged and warned about', () => {
  const db = new Db(base(), [rep({ monster: '新地圖怪', item: '新材料', map: '新地圖', userId: 'a' }), rep({ monster: '新地圖怪', item: '新材料', userId: 'b' })]);
  const fresh = renderMonster(db, db.monsters.find((m) => m.name === '新地圖怪'));
  assert.match(fresh, /\*\*新地圖怪\*\* 👾 怪物 〔玩家回報〕/);
  assert.match(fresh, /Lv\.\(未知\) · HP \(未知\) · EXP \(未知\)/);
  assert.match(fresh, /出沒:新地圖〔回報〕/);
  assert.match(fresh, /• 新材料 — \(未知\) 〔玩家回報×2〕/);
  assert.match(fresh, /⚠️ 〔玩家回報〕是玩家分享、尚未證實/);
  const known = renderMonster(db, db.monsters.find((m) => m.name === '藍寶'));
  assert.match(known, /Lv\.12 · HP 300 · EXP 25/);
  assert.match(known, /• 藍色水滴 — 20%/);
  assert.match(known, /• 神秘粉末 — \(未知\)/, 'a drop with no rate in the data is (未知), not blank');
  assert.ok(!known.includes('⚠️'), 'fully imported data carries no warning');
  const nothing = new Db(buildDb({ monsters: [{ 怪物: '孤單怪' }] }).db);
  const lonely = renderMonster(nothing, nothing.monsters[0]);
  assert.match(lonely, /Lv\.\(未知\).*\n📍 出沒:\(未知\)/s);
  assert.match(lonely, /• \(未知\)\(還沒有人整理這隻怪物的掉落/);
  assert.match(renderItem(db, db.items.find((i) => i.name === '新材料')), /新材料\*\* 🎒 道具 〔玩家回報〕[\s\S]*新地圖怪 \(Lv\.\(未知\)\) — \(未知\) 〔玩家回報×2〕/);
  assert.match(renderMap(db, '新地圖'), /新地圖怪 \(Lv\.\(未知\)\) 〔玩家回報〕/);
  assert.match(renderMap(db, '舊森林'), /藍寶 \(Lv\.12\)\n/);
});

test('render: markdown in reported names cannot break the message', () => {
  const db = new Db({}, [rep({ monster: '**粗體怪**', item: '_斜_道具|', rate: '`1%`', userId: 'a' })]);
  const card = renderMonster(db, db.monsters[0]);
  assert.match(card, /\\\*\\\*粗體怪\\\*\\\*/);
  assert.match(card, /\\_斜\\_道具\\\|/);
  assert.ok(card.length < 2000);
});

test('db source: rebuilds when reports change', () => {
  const reports = new Reports(null);
  const src = createDbSource(join(tmpdir(), 'definitely-missing-db.json'), { reports });
  assert.equal(src.get().db.empty, true);
  const first = src.get();
  assert.equal(src.get(), first, 'cached while nothing changed');
  reports.add({ monster: '新怪', item: '新物', userId: 'u' });
  const after = src.get();
  assert.notEqual(after, first);
  assert.equal(after.db.monsters[0].name, '新怪');
  assert.equal(after.db.empty, false, 'reports alone are enough to have a database');
});
