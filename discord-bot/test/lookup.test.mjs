// Fixtures below are made up for testing; they are not real Artale data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseTable } from '../src/lookup/csv.js';
import { buildDb, parseRate, slug } from '../src/lookup/import.js';
import { Db, loadDb } from '../src/lookup/store.js';
import { Index, similarity, norm } from '../src/lookup/search.js';
import { renderMonster, renderItem, renderMap, renderSuggestions, renderEntity } from '../src/lookup/render.js';

const monsters = [
  { 怪物: '肥肥頭', 等級: '10', HP: '1,200', 經驗: '15', 出沒地圖: '森林一;森林二', 別名: '肥頭' },
  { 怪物: '藍蝸牛', 等級: '2', 出沒地圖: '森林一' },
  { 怪物: '木妖', 等級: '30', 地圖: '森林二' },
];
const items = [{ 道具: '楓葉', 類型: '材料', 別名: '紅葉' }, { 道具: '藍殼', 類型: '材料' }];
const drops = [
  { 怪物: '肥肥頭', 道具: '楓葉', 機率: '0.5%' },
  { 怪物: '肥肥頭', 道具: '藍殼', 機率: '1/50' },
  { 怪物: '藍蝸牛', 道具: '藍殼', 機率: '30' },
  { 怪物: '木妖', 道具: '神秘石', 機率: '很稀有' },
  { 怪物: '木妖', 道具: '楓葉' },
];
const build = () => buildDb({ monsters, items, drops }, { source: '測試資料' });

test('csv: quotes, escaped quotes, CRLF, BOM, TSV', () => {
  const rows = parseTable('﻿name,note\r\n"肥肥頭, 大","他說""嗨"""\r\n\r\n藍蝸牛,\r\n');
  assert.deepEqual(rows, [{ name: '肥肥頭, 大', note: '他說"嗨"' }, { name: '藍蝸牛', note: '' }]);
  assert.deepEqual(parseTable('名稱\t等級\n肥肥頭\t10'), [{ 名稱: '肥肥頭', 等級: '10' }]);
  assert.deepEqual(parseTable(''), []);
});

test('rate parsing', () => {
  assert.equal(parseRate('0.5%').rate, 0.005);
  assert.equal(parseRate('1/50').rate, 0.02);
  assert.equal(parseRate('0.25').rate, 0.25);
  assert.equal(parseRate('30').rate, 0.3);
  assert.deepEqual(parseRate('很稀有'), { rate: null, rateText: '很稀有' });
  assert.deepEqual(parseRate(''), { rate: null, rateText: '' });
  assert.equal(parseRate('250%').rate, null);
});

test('import: Chinese headers, aliases, stubs for unknown names, duplicates merged', () => {
  const { db, warnings } = build();
  assert.equal(db.meta.counts.monsters, 3);
  assert.equal(db.meta.counts.items, 3); // 楓葉, 藍殼 + stub 神秘石
  assert.equal(db.meta.counts.drops, 5);
  const fat = db.monsters.find((m) => m.name === '肥肥頭');
  assert.deepEqual([fat.level, fat.hp, fat.exp], [10, 1200, 15]);
  assert.deepEqual(fat.maps, ['森林一', '森林二']);
  assert.deepEqual(fat.aliases, ['肥頭']);
  assert.deepEqual(warnings, []);
  const again = buildDb({ monsters: [...monsters, { 怪物: '肥肥頭', 地圖: '森林三' }], drops: [] }).db;
  assert.deepEqual(again.monsters.find((m) => m.name === '肥肥頭').maps, ['森林一', '森林二', '森林三']);
  assert.match(buildDb({ monsters: [{ 等級: '5' }], drops: [{ 怪物: 'x' }] }).warnings.join(), /沒有名稱[\s\S]*缺少/);
  assert.equal(slug(' 肥 肥頭 '), slug('肥肥頭'));
});

test('db: drops sorted by rate, droppers, maps sorted by level', () => {
  const db = new Db(build().db);
  const fat = db.monsters.find((m) => m.name === '肥肥頭');
  assert.deepEqual(db.dropsOf(fat.id).map((d) => d.item.name), ['藍殼', '楓葉']); // 2% before 0.5%
  const leaf = db.items.find((i) => i.name === '楓葉');
  assert.deepEqual(db.droppersOf(leaf.id).map((d) => d.monster.name), ['肥肥頭', '木妖']); // unknown rate last
  assert.deepEqual(db.monstersIn('森林一').map((m) => m.name), ['藍蝸牛', '肥肥頭']);
  assert.deepEqual(db.maps.sort(), ['森林一', '森林二']);
  assert.equal(new Db().empty, true);
  assert.equal(db.empty, false);
});

test('search: exact, alias, prefix, typo, kinds, nothing', () => {
  const idx = new Index(new Db(build().db));
  assert.equal(idx.search('肥肥頭')[0].match, 'exact');
  assert.equal(idx.search('肥頭')[0].name, '肥肥頭');
  assert.equal(idx.search('肥頭')[0].match, 'alias');
  assert.equal(idx.search('紅葉')[0].name, '楓葉');
  assert.equal(idx.search('藍蝸')[0].name, '藍蝸牛');
  assert.equal(idx.search('肥肥投')[0].name, '肥肥頭', 'one wrong character still finds it');
  assert.equal(idx.search('  肥 肥-頭 ')[0].name, '肥肥頭');
  assert.deepEqual(idx.search('楓葉', { kinds: ['monster'] }).map((r) => r.kind), []);
  assert.deepEqual(idx.search('完全不相干的字串xyz'), []);
  assert.deepEqual(idx.search(''), []);
  assert.ok(similarity('肥肥頭', '肥肥頭') === 1 && similarity('abc', 'xyz') === 0);
  assert.equal(norm('「肥肥・頭」'), '肥肥頭');
});

test('search.best: clear winner vs ambiguous', () => {
  const idx = new Index(new Db(build().db));
  assert.equal(idx.best('肥肥頭').hit.name, '肥肥頭');
  const amb = new Index(new Db(buildDb({ monsters: [{ 怪物: '藍蝸牛' }, { 怪物: '藍蘑菇' }] }).db));
  const r = amb.best('藍');
  assert.equal(r.hit, null);
  assert.equal(r.others.length, 2);
});

test('render: monster, item, map cards; empty and long lists', () => {
  const db = new Db(build().db);
  const fat = db.monsters.find((m) => m.name === '肥肥頭');
  const card = renderMonster(db, fat);
  assert.match(card, /\*\*肥肥頭\*\*/);
  assert.match(card, /Lv\.10 · HP 1,200 · EXP 15/);
  assert.match(card, /出沒:森林一、森林二/);
  assert.ok(card.indexOf('藍殼') < card.indexOf('楓葉'));
  assert.match(card, /藍殼 — 1\/50/);
  assert.match(card, /資料:測試資料/);
  assert.match(renderItem(db, db.items.find((i) => i.name === '楓葉')), /木妖 \(Lv\.30\) — \(未知\)/);
  assert.match(renderMap(db, '森林一'), /藍蝸牛 \(Lv\.2\)/);
  assert.match(renderMonster(db, db.monsters.find((m) => m.name === '藍蝸牛')), /藍殼 — 30/);
  assert.match(renderEntity(db, { kind: 'map', id: '森林二' }), /森林二/);
  const none = new Db(buildDb({ monsters: [{ 怪物: '孤單怪' }] }).db);
  assert.match(renderMonster(none, none.monsters[0]), /還沒有人整理這隻怪物的掉落/);
  const many = new Db(buildDb({ drops: Array.from({ length: 400 }, (_, i) => ({ 怪物: 'Boss', 道具: `很長很長的道具名稱${i}`, 機率: '0.01%' })) }).db);
  const long = renderMonster(many, many.monsters[0]);
  assert.ok(long.length < 2000, `${long.length}`);
  assert.match(long, /還有 \d+ 筆/);
  assert.match(renderSuggestions('藍', [{ name: '藍蝸牛', kind: 'monster' }]), /藍蝸牛 👾 怪物/);
  assert.match(renderSuggestions('zzz', []), /找不到/);
});

test('import CLI: folder of tables -> db.json that loads and searches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artale-import-'));
  writeFileSync(join(dir, 'monsters.csv'), '怪物,等級,地圖\n肥肥頭,10,森林一\n');
  writeFileSync(join(dir, 'drops.tsv'), '怪物\t道具\t機率\n肥肥頭\t楓葉\t0.5%\n');
  const out = join(dir, 'db.json');
  const log = execFileSync('node', ['src/lookup/cli.js', '--dir', dir, '--out', out, '--source', '測'], { encoding: 'utf8' });
  assert.match(log, /1 隻怪物、1 個道具、1 筆掉落/);
  const db = loadDb(out);
  assert.equal(new Index(db).search('楓葉')[0].kind, 'item');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).meta.source, '測');
  assert.equal(loadDb(join(dir, 'nope.json')).empty, true);
});
