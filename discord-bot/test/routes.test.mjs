// Fixtures are made up; not real Artale data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRoutes, helpText } from '../src/routes.js';
import { createDbSource } from '../src/dbsource.js';
import { Db } from '../src/lookup/store.js';
import { Index } from '../src/lookup/search.js';
import { buildDb } from '../src/lookup/import.js';
import { Scores } from '../src/scores.js';
import { GuessGames } from '../src/games/logic.js';
import { fakeInteraction as fi, seq } from './helpers-discord.mjs';
import { baseConfig } from './helpers.mjs';

const rawDb = () =>
  buildDb(
    {
      monsters: [{ 怪物: '肥肥頭', 等級: '10', 地圖: '森林一' }, { 怪物: '藍蝸牛', 等級: '2', 地圖: '森林一' }, { 怪物: '木妖', 等級: '30' }, { 怪物: '紅蝸牛', 等級: '3' }],
      drops: [{ 怪物: '肥肥頭', 道具: '楓葉', 機率: '0.5%' }, { 怪物: '藍蝸牛', 道具: '藍殼', 機率: '30%' }, { 怪物: '藍蝸牛', 道具: '楓葉', 機率: '1%' }],
    },
    { source: '測試' },
  ).db;

const source = (db) => ({ get: () => ({ db, index: new Index(db) }) });
const make = (over = {}) =>
  buildRoutes({
    config: baseConfig,
    source: source(new Db(rawDb())),
    scores: new Scores(null),
    guessGames: new GuessGames({ rng: seq(0.5) }),
    rng: seq(0.5),
    setTimeout: () => {},
    ...over,
  });

test('/drop: a clear match shows the card; a vague one suggests; empty db says so', async () => {
  const r = make();
  let i = fi({ strings: { name: '肥肥頭' } });
  await r.commands.get('drop')(i);
  assert.match(i.last().content, /\*\*肥肥頭\*\*[\s\S]*楓葉 — 0\.5%/);
  i = fi({ strings: { name: '楓葉' } });
  await r.commands.get('drop')(i);
  assert.match(i.last().content, /\*\*楓葉\*\* 🎒 道具[\s\S]*藍蝸牛 \(Lv\.2\) — 1%/);
  i = fi({ strings: { name: '蝸牛' } });
  await r.commands.get('drop')(i);
  assert.match(i.last().content, /你是不是要找[\s\S]*藍蝸牛[\s\S]*紅蝸牛/);
  i = fi({ strings: { name: 'qqqqzzzz' } });
  await r.commands.get('drop')(i);
  assert.match(i.last().content, /找不到/);
  const empty = make({ source: source(new Db()) });
  i = fi({ strings: { name: '肥肥頭' } });
  await empty.commands.get('drop')(i);
  assert.match(i.last().content, /資料庫還是空的/);
  assert.equal(i.last().flags, 64);
});

test('/map and autocomplete', async () => {
  const r = make();
  let i = fi({ strings: { name: '森林一' } });
  await r.commands.get('map')(i);
  assert.match(i.last().content, /藍蝸牛 \(Lv\.2\)[\s\S]*肥肥頭 \(Lv\.10\)/);
  i = fi({ focused: '肥' });
  await r.autocomplete.get('drop')(i);
  assert.deepEqual(i.last().map((c) => c.value), ['肥肥頭']);
  assert.match(i.last()[0].name, /肥肥頭 👾 怪物/);
  i = fi({ focused: '森' });
  await r.autocomplete.get('map')(i);
  assert.deepEqual(i.last().map((c) => c.value), ['森林一']);
  i = fi({ focused: '' });
  await r.autocomplete.get('drop')(i);
  assert.ok(i.last().length <= 25);
});

test('games and buttons are wired to a shared context', async () => {
  const r = make({ rng: seq(0.0) });
  let i = fi({ user: 'alice' });
  await r.commands.get('rps')(i);
  const btn = fi({ user: 'alice', customId: 'rps:alice:paper' });
  const route = r.components.find((c) => btn.customId.startsWith(c.prefix));
  await route.handler(btn);
  assert.match(btn.last().content, /你贏了/);
  i = fi({});
  await r.commands.get('rank')(i);
  assert.match(i.last().content, /<@alice>/);
  i = fi({});
  await r.commands.get('quiz')(i);
  assert.match(i.calls[0][1].content, /猜怪物/, 'quiz reads the live database');
});

test('/guide is free (search links) and becomes AI-written when AI is configured', async () => {
  const free = make({ config: { ...baseConfig, sources: ['dcard.tw', 'forum.gamer.com.tw'] } });
  const g = fi({ strings: { topic: '轉職 *x*' } });
  await free.commands.get('guide')(g);
  assert.match(g.last().content, /google\.com\/search\?q=site%3Adcard\.tw%20Artale%20%E8%BD%89%E8%81%B7%20\*x\*/);
  assert.match(g.last().content, /forum\.gamer\.com\.tw/);
  assert.ok(!g.last().content.includes('「轉職 *x*」'), 'markdown in the topic is neutralised in the title');
});

test('AI commands exist only when AI is configured', async () => {
  assert.deepEqual(['ask', 'sources'].filter((c) => make().commands.has(c)), []);
  const calls = [];
  const ai = {
    admit: (req) => (req.text === 'blocked' ? { ok: false, message: '查太快了' } : { ok: true }),
    answer: async (req) => (calls.push(req), { ok: true, parts: ['one', 'two'] }),
  };
  const r = make({ ai, config: { ...baseConfig, sources: ['a.com'], dbDomains: ['a.com'] } });
  let i = fi({ strings: { question: '怎麼練' } });
  await r.commands.get('ask')(i);
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit', 'follow']);
  assert.equal(calls[0].kind, 'ask');
  i = fi({ strings: { topic: '轉職' } });
  await r.commands.get('guide')(i);
  assert.equal(calls[1].kind, 'guide');
  i = fi({ strings: { question: 'blocked' } });
  await r.commands.get('ask')(i);
  assert.deepEqual(i.calls.map((c) => c[0]), ['reply']);
  assert.equal(i.last().flags, 64);
  i = fi({});
  await r.commands.get('sources')(i);
  assert.match(i.last().content, /a\.com\(資料庫\)/);
});

test('@mention: free lookup without AI, a question with AI', async () => {
  const r = make();
  assert.match((await r.mention({ text: '肥肥頭', userId: 'u', channelId: 'c' })).parts[0], /\*\*肥肥頭\*\*/);
  assert.match((await r.mention({ text: '  ', userId: 'u', channelId: 'c' })).parts[0], /Artale 小幫手/);
  assert.match((await r.mention({ text: 'zzzzqqqq', userId: 'u', channelId: 'c' })).parts[0], /找不到/);
  const empty = make({ source: source(new Db()) });
  assert.match((await empty.mention({ text: '肥肥頭', userId: 'u', channelId: 'c' })).parts[0], /資料庫還是空的/);
  const ai = { admit: () => ({ ok: true }), answer: async () => ({ ok: true, parts: ['AI 回答'] }) };
  assert.deepEqual((await make({ ai }).mention({ text: '怎麼練', userId: 'u', channelId: 'c' })).parts, ['AI 回答']);
  const gated = { admit: () => ({ ok: false, message: '今天用完了' }), answer: async () => assert.fail('no') };
  assert.deepEqual((await make({ ai: gated }).mention({ text: 'x', userId: 'u', channelId: 'c' })).parts, ['今天用完了']);
});

test('help lists only what is available', () => {
  const src = source(new Db(rawDb()));
  const plain = helpText({ ai: false, musicEnabled: false, source: src });
  assert.match(plain, /\/drop/);
  assert.match(plain, /3 個道具|2 個道具/);
  assert.ok(!plain.includes('/music') && !plain.includes('/ask'));
  const full = helpText({ ai: true, musicEnabled: true, source: src });
  assert.ok(full.includes('/music') && full.includes('/ask'));
  assert.match(helpText({ ai: false, musicEnabled: false, source: source(new Db()) }), /還是空的/);
});

test('music commands are routed when music is configured', async () => {
  const musicCtx = { library: { search: () => [], searchRadio: () => [], radio: [] }, manager: { get: () => null } };
  const r = make({ musicCtx });
  assert.ok(r.commands.has('music') && r.autocomplete.has('music'));
  const i = fi({ sub: 'now' });
  await r.commands.get('music')(i);
  assert.match(i.last().content, /沒有在播放/);
  assert.equal(make().commands.has('music'), false);
});

test('db source reloads when the file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbsrc-'));
  const path = join(dir, 'db.json');
  const src = createDbSource(path);
  assert.equal(src.get().db.empty, true, 'no file yet');
  writeFileSync(path, JSON.stringify(rawDb()));
  const first = src.get();
  assert.equal(first.db.empty, false);
  assert.equal(src.get(), first, 'cached while unchanged');
  const changed = rawDb();
  changed.monsters.push({ id: 'x', name: '新怪', aliases: [], level: 1, hp: null, exp: null, maps: [], note: '' });
  writeFileSync(path, JSON.stringify(changed));
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  assert.ok(src.get().db.monsters.some((m) => m.name === '新怪'));
});
