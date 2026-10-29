// Fixtures are made up; not real Artale data or news.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, helpText } from '../src/routes.js';
import { createDbSource } from '../src/dbsource.js';
import { Reports } from '../src/lookup/reports.js';
import { buildDb } from '../src/lookup/import.js';
import { Players } from '../src/rpg/store.js';
import { GuessGames } from '../src/games/logic.js';
import { SourceStore, NewsStore } from '../src/news/store.js';
import { Refresher } from '../src/news/refresh.js';
import { fakeInteraction as fi, seq } from './helpers-discord.mjs';
import { baseConfig } from './helpers.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NOW = Date.UTC(2025, 9, 30, 8, 0);
const RSS = `<rss><channel><item><title>版本更新公告</title><link>https://a.example/p/1</link><pubDate>Thu, 30 Oct 2025 06:00:00 GMT</pubDate></item><item><title>新地圖掉落整理</title><link>https://a.example/p/2</link></item></channel></rss>`;
const rawDb = () =>
  buildDb(
    {
      monsters: [{ 怪物: '藍寶', 等級: '12', 地圖: '舊森林', 別名: '小藍' }, { 怪物: '紅寶', 等級: '14', 地圖: '舊森林' }, { 怪物: '木妖', 等級: '30' }, { 怪物: '石頭人', 等級: '31' }],
      drops: [{ 怪物: '藍寶', 道具: '藍色水滴', 機率: '20%' }, { 怪物: '藍寶', 道具: '黏稠水晶', 機率: '1%' }, { 怪物: '紅寶', 道具: '紅色水滴', 機率: '20%' }, { 怪物: '紅寶', 道具: '紅色碎片', 機率: '5%' }],
    },
    { source: '測試' },
  ).db;

function make({ db = rawDb(), pages = { 'https://a.example/feed': RSS }, ai = null, config = {}, intel = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'routes-'));
  const dbPath = join(dir, 'db.json');
  if (db) writeFileSync(dbPath, JSON.stringify(db));
  const reports = new Reports(null);
  const sources = new SourceStore(null);
  const news = new NewsStore(null, { now: () => NOW });
  const fetched = [];
  const fetchText = async (url) => {
    fetched.push(url);
    const p = pages[url];
    if (p === undefined) throw new Error('HTTP 404');
    if (p instanceof Error) throw p;
    return { text: p, url };
  };
  const refresher = new Refresher({ sources, store: news, fetchText, now: () => NOW, minIntervalMs: 30 * 60_000 });
  const cfg = { ...baseConfig, newsDailyAt: '06:00', tzOffsetHours: 8, channelIntel: intel, ...config };
  const players = new Players(null);
  const routes = buildRoutes({ config: cfg, source: createDbSource(dbPath, { reports }), reports, players, guessGames: new GuessGames({ rng: seq(0.5) }), sources, news, refresher, fetchText, ai, rng: seq(0.0), now: () => NOW, setTimeout: () => {} });
  return { routes, reports, sources, news, refresher, fetched, players, cfg };
}
const run = async (m, name, over) => {
  const i = fi({ name, ...over });
  await m.routes.commands.get(name)(i);
  return i;
};

test('/掉落物: alias and clear matches show the card, vague ones suggest, empty db says so', async () => {
  const m = make();
  let i = await run(m, '掉落物', { strings: { 名稱: '小藍' } });
  assert.match(i.last().content, /\*\*藍寶\*\*[\s\S]*Lv\.12[\s\S]*藍色水滴 — 20%/);
  i = await run(m, '掉落物', { strings: { 名稱: '藍色水滴' } });
  assert.match(i.last().content, /\*\*藍色水滴\*\* 🎒 道具[\s\S]*藍寶/);
  i = await run(m, '掉落物', { strings: { 名稱: '寶' } });
  assert.match(i.last().content, /你是不是要找[\s\S]*藍寶[\s\S]*紅寶/);
  i = await run(m, '掉落物', { strings: { 名稱: 'qqqqzzzz' } });
  assert.match(i.last().content, /找不到.*\/回報/s, 'a miss invites a report: it may simply be new');
  const empty = make({ db: null });
  i = await run(empty, '掉落物', { strings: { 名稱: '藍寶' } });
  assert.match(i.last().content, /資料庫還是空的/);
  assert.equal(i.last().flags, 64);
  i = await run(m, '地圖', { strings: { 名稱: '舊森林' } });
  assert.match(i.last().content, /藍寶 \(Lv\.12\)[\s\S]*紅寶 \(Lv\.14\)/);
});

test('/回報: shows up in lookups at once, tagged; deleting works for the owner and admins only', async () => {
  const m = make();
  let i = await run(m, '回報', { user: 'alice', strings: { 怪物: '新地圖怪', 道具: '新材料', 機率: '1%', 地圖: '新地圖' } });
  assert.match(i.last().content, /已記錄回報 #1.*新地圖怪.*新材料.*\(1%\).*新地圖/s);
  assert.ok(!i.last().flags);
  i = await run(m, '掉落物', { strings: { 名稱: '新地圖怪' } });
  assert.match(i.last().content, /新地圖怪\*\* 👾 怪物 〔玩家回報〕[\s\S]*Lv\.\(未知\)[\s\S]*新材料 — 1% 〔玩家回報×1〕[\s\S]*尚未證實/);
  await run(m, '回報', { user: 'bob', strings: { 怪物: '新地圖怪', 道具: '新材料' } });
  i = await run(m, '掉落物', { strings: { 名稱: '新地圖怪' } });
  assert.match(i.last().content, /〔玩家回報×2〕/);
  i = await run(m, '回報', { user: 'alice', strings: { 怪物: '新地圖怪', 道具: '新材料', 機率: '2%' } });
  assert.match(i.last().content, /已更新回報 #1/);
  i = await run(m, '回報刪除', { user: 'mallory', ints: { 編號: 1 } });
  assert.match(i.last().content, /只能刪除自己的/);
  i = await run(m, '回報刪除', { user: 'alice', ints: { 編號: 1 } });
  assert.match(i.last().content, /已刪除回報 #1/);
  i = await run(m, '回報刪除', { user: 'owner', admin: true, ints: { 編號: 2 } });
  assert.match(i.last().content, /已刪除/);
  i = await run(m, '掉落物', { strings: { 名稱: '新地圖怪' } });
  assert.match(i.last().content, /找不到/);
  i = await run(m, '回報', { strings: { 怪物: '@everyone', 道具: '**x**' } });
  assert.ok(!i.last().content.includes('@everyone'));
  i = await run(m, '回報', { strings: { 怪物: ' ', 道具: 'x' } });
  assert.equal(i.last().flags, 64);
});

test('/更新情報: needs sources; refreshes when stale; filters and limits', async () => {
  const m = make();
  let i = await run(m, '更新情報');
  assert.match(i.last().content, /還沒有設定情報來源/);
  assert.equal(i.last().flags, 64);
  m.sources.add({ name: '巴哈', url: 'https://a.example/feed' });
  i = await run(m, '更新情報');
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit']);
  assert.match(i.last().content, /Artale 最新情報/);
  assert.match(i.last().content, /\[版本更新公告\]\(<https:\/\/a\.example\/p\/1>\) — 巴哈 · 2 小時前/);
  assert.match(i.last().content, /新地圖掉落整理.*\(收錄時間\)/);
  assert.deepEqual(m.fetched, ['https://a.example/feed']);
  i = await run(m, '更新情報', { ints: { 數量: 1 } });
  assert.equal((i.last().content.match(/^• /gm) ?? []).length, 1);
  assert.equal(m.fetched.length, 1, 'a recent refresh is reused, sites are not hit again');
  i = await run(m, '更新情報', { strings: { 來源: '不存在' } });
  assert.match(i.last().content, /還沒有收集到情報/);
  i = await run(m, '更新情報', { strings: { 來源: '巴哈' } });
  assert.match(i.last().content, /（?巴哈|\(巴哈\)/);
});

test('/更新情報: a dead source never breaks the command', async () => {
  const m = make({ pages: { 'https://a.example/feed': new Error('HTTP 503') } });
  m.sources.add({ name: '巴哈', url: 'https://a.example/feed' });
  const i = await run(m, '更新情報');
  assert.match(i.last().content, /還沒有收集到情報/);
  m.news.merge([{ title: '舊的', url: 'https://old.example/1' }], '手動');
  assert.match((await run(m, '更新情報')).last().content, /舊的/, 'what was collected earlier is still shown');
});

test('/情報來源: admin only; add (with a live test), list, test, remove, refresh now', async () => {
  const m = make();
  let i = await run(m, '情報來源', { sub: '列表' });
  assert.match(i.last().content, /管理伺服器/);
  const admin = (sub, strings = {}, extra = {}) => run(m, '情報來源', { sub, admin: true, strings, ...extra });
  i = await admin('新增', { 名稱: '壞網址', 網址: 'ftp://x.example' });
  assert.match(i.last().content, /❌ 網址要以 http/);
  i = await admin('新增', { 名稱: '巴哈', 網址: 'https://a.example/feed', 關鍵字: '地圖' });
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit']);
  assert.equal(i.calls[0][1].flags, 64, 'answers privately');
  assert.match(i.last().content, /已儲存「巴哈」:抓到 1 則\(RSS\)\n• 新地圖掉落整理/);
  i = await admin('新增', { 名稱: '壞掉的', 網址: 'https://dead.example/' });
  assert.match(i.last().content, /已儲存「壞掉的」,但抓取失敗:HTTP 404/);
  i = await admin('列表');
  assert.match(i.last().content, /\*\*巴哈\*\* — auto · 關鍵字:地圖[\s\S]*\*\*壞掉的\*\*/);
  i = await admin('測試', { 名稱: '巴哈' });
  assert.match(i.last().content, /測試「巴哈」:抓到 1 則/);
  i = await admin('測試', { 名稱: '沒這個' });
  assert.match(i.last().content, /找不到來源/);
  i = await admin('移除', { 名稱: '壞掉的' });
  assert.match(i.last().content, /已移除/);
  i = await admin('立即更新');
  assert.match(i.last().content, /更新完成,新增 1 則[\s\S]*✅ 巴哈:找到 1、新增 1/);
  i = await admin('頻道加入', {}, { channels: { 頻道: { id: '777', name: '情報' } } });
  assert.match(i.last().content, /<#777>[\s\S]*ENABLE_CHANNEL_INTEL=1[\s\S]*Message Content Intent[\s\S]*追蹤/);
  assert.ok(m.sources.hasChannel('777'));
  i = await admin('頻道移除', {}, { channels: { 頻道: { id: '777', name: '情報' } } });
  assert.match(i.last().content, /不再把/);
  const none = make();
  assert.match((await run(none, '情報來源', { sub: '立即更新', admin: true })).last().content, /還沒有設定情報來源/);
});

test('intel channels: posts become news; own posts, other channels and empty posts are ignored', () => {
  const m = make({ intel: true });
  m.sources.addChannel('c-intel', '情報');
  const msg = (o) => ({ channelId: 'c-intel', author: { id: 'someone' }, content: '', embeds: [], url: 'https://discord.com/channels/1/2/3', createdTimestamp: NOW - 60_000, ...o });
  assert.equal(m.routes.intel(msg({ content: '新地圖「測試地」的怪物掉落整理\n第二行有細節' }), 'bot'), true);
  const [item] = m.news.items;
  assert.deepEqual([item.title, item.source, item.url, item.publishedAt, item.snippet], ['新地圖「測試地」的怪物掉落整理', '#情報', 'https://discord.com/channels/1/2/3', NOW - 60_000, '第二行有細節']);
  assert.equal(m.routes.intel(msg({ content: '同一則' }), 'bot'), false, 'the same message link is not added twice');
  assert.equal(m.routes.intel(msg({ content: 'x', url: 'https://discord.com/channels/1/2/4', author: { id: 'bot' } }), 'bot'), false, 'its own messages');
  assert.equal(m.routes.intel(msg({ content: 'x', url: 'https://discord.com/channels/1/2/5', channelId: 'other' }), 'bot'), false);
  assert.equal(m.routes.intel(msg({ url: 'https://discord.com/channels/1/2/6' }), 'bot'), false, 'nothing to read');
  assert.equal(m.routes.intel(msg({ url: 'https://discord.com/channels/1/2/7', embeds: [{ title: '公告標題', description: '公告內容' }] }), 'bot'), true, 'followed announcements arrive as embeds');
  assert.equal(m.news.items.find((x) => x.title === '公告標題').snippet, '公告內容');
});

test('autocomplete: monsters, items, maps, sources, inventory', async () => {
  const m = make();
  m.sources.add({ name: '巴哈', url: 'https://a.example/feed' });
  m.players.get('g1', 'u1').items = { 藍色水滴: 2 };
  const ac = async (name, over) => {
    const i = fi({ name, ...over });
    await m.routes.autocomplete.get(name)(i);
    return i.last();
  };
  assert.deepEqual((await ac('掉落物', { focused: '藍' })).map((c) => c.value), ['藍寶', '藍色水滴']);
  assert.deepEqual((await ac('地圖', { focused: '舊' })).map((c) => c.value), ['舊森林']);
  assert.deepEqual((await ac('打怪', { focused: '' })).map((c) => c.value), ['舊森林']);
  assert.deepEqual((await ac('更新情報', { focused: '' })).map((c) => c.value), ['巴哈']);
  assert.deepEqual((await ac('情報來源', { focused: '巴' })).map((c) => c.value), ['巴哈']);
  assert.deepEqual((await ac('賣出', { focused: '' })).map((c) => c.value), ['全部', '藍色水滴']);
  assert.deepEqual((await ac('賣出', { focused: '藍' })).map((c) => c.value), ['藍色水滴']);
  assert.deepEqual((await ac('回報', { focusedName: '怪物', focused: '紅' })).map((c) => c.value), ['紅寶']);
  assert.deepEqual((await ac('回報', { focusedName: '道具', focused: '紅' })).map((c) => c.value).sort(), ['紅色水滴', '紅色碎片']);
  assert.deepEqual((await ac('回報', { focusedName: '地圖', focused: '舊' })).map((c) => c.value), ['舊森林']);
  assert.deepEqual(await ac('回報', { focusedName: '機率', focused: '1' }), []);
  assert.ok((await ac('掉落物', { focused: '' })).length > 0 && (await ac('掉落物', { focused: '' })).length <= 25, 'an empty box still offers choices');
});

test('RPG and games are routed with a shared context (one character, mesos from games)', async () => {
  const m = make({ db: null });
  let i = await run(m, '簽到');
  assert.match(i.last().content, /簽到成功/);
  i = await run(m, '猜拳', { user: 'alice' });
  const btn = fi({ user: 'alice', customId: 'rps:alice:paper' });
  await m.routes.components.find((c) => btn.customId.startsWith(c.prefix)).handler(btn);
  assert.match(btn.last().content, /你贏了/);
  assert.equal(m.players.get('g1', 'alice').mesos, 300 + 200);
  i = await run(m, '打怪', { user: 'alice' });
  assert.match(i.last().content, /勝利/, 'works with no database: the built-in monsters');
  i = await run(m, '排行榜');
  assert.match(i.last().content, /<@alice>/);
  i = await run(m, '賭博', { user: 'alice', sub: '拉霸', ints: { 金額: 100 } });
  assert.match(i.last().content, /楓幣/);
  const quiz = fi({});
  await m.routes.commands.get('猜怪物')(quiz);
  assert.equal(quiz.last().flags, 64, 'the quiz needs a database');
  const withDb = make();
  const q = fi({});
  await withDb.routes.commands.get('猜怪物')(q);
  assert.match(q.calls[0][1].content, /猜怪物/, 'and reads the live database');
});

test('/攻略 is free (search links); AI replaces it and adds /問答', async () => {
  const free = make({ config: { sources: ['dcard.tw', 'forum.gamer.com.tw'] } });
  const g = await run(free, '攻略', { strings: { 主題: '轉職 *x*' } });
  assert.match(g.last().content, /google\.com\/search\?q=site%3Adcard\.tw%20Artale%20%E8%BD%89%E8%81%B7%20\*x\*/);
  assert.ok(!free.routes.commands.has('問答') && !free.routes.commands.has('ai來源'));
  const calls = [];
  const ai = {
    admit: (req) => (req.text === 'blocked' ? { ok: false, message: '查太快了' } : { ok: true }),
    answer: async (req) => (calls.push(req), { ok: true, parts: ['one', 'two'] }),
  };
  const m = make({ ai, config: { sources: ['a.com'], dbDomains: ['a.com'] } });
  let i = await run(m, '問答', { strings: { 問題: '怎麼練' } });
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit', 'follow']);
  assert.equal(calls[0].kind, 'ask');
  i = await run(m, '攻略', { strings: { 主題: '轉職' } });
  assert.equal(calls[1].kind, 'guide');
  i = await run(m, '問答', { strings: { 問題: 'blocked' } });
  assert.deepEqual(i.calls.map((c) => c[0]), ['reply']);
  assert.equal(i.last().flags, 64);
  i = await run(m, 'ai來源');
  assert.match(i.last().content, /a\.com\(資料庫\)/);
});

test('@mention: a free lookup without AI, a question with AI', async () => {
  const m = make();
  const say = async (r, text) => (await r.routes.mention({ text, userId: 'u', channelId: 'c' })).parts[0];
  assert.match(await say(m, '小藍'), /\*\*藍寶\*\*/);
  assert.match(await say(m, '  '), /Artale 小幫手/);
  assert.match(await say(m, 'zzzzqqqq'), /找不到/);
  assert.match(await say(make({ db: null }), '藍寶'), /資料庫還是空的/);
  const ai = { admit: () => ({ ok: true }), answer: async () => ({ ok: true, parts: ['AI 回答'] }) };
  assert.equal(await say(make({ ai }), '怎麼練'), 'AI 回答');
  const gated = { admit: () => ({ ok: false, message: '今天用完了' }), answer: async () => assert.fail('no') };
  assert.equal(await say(make({ ai: gated }), 'x'), '今天用完了');
});

test('/說明 lists what exists, and only what exists', async () => {
  const m = make();
  const text = (await run(m, '說明')).last().content;
  for (const c of ['/掉落物', '/更新情報', '/回報', '/打怪', '/賭博', '/猜拳']) assert.ok(text.includes(c), c);
  assert.match(text, /\(未知\).*〔玩家回報〕/s);
  assert.match(text, /每天 06:00/);
  assert.ok(!text.includes('/問答'));
  assert.match(text, /4 隻怪物/);
  assert.ok(helpText({ ai: true, source: { get: () => ({ db: { monsters: [], items: [], drops: [], empty: true } }) }, config: { newsDailyAt: '06:00' } }).includes('/問答'));
  assert.match(helpText({ ai: false, source: { get: () => ({ db: { monsters: [], items: [], drops: [], empty: true } }) }, config: { newsDailyAt: '06:00' } }), /還是空的/);
});
