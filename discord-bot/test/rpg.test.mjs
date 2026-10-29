// Game balance numbers here are the game's own, not Artale data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as L from '../src/rpg/logic.js';
import * as R from '../src/rpg/commands.js';
import { Players } from '../src/rpg/store.js';
import { Db } from '../src/lookup/store.js';
import { buildDb } from '../src/lookup/import.js';
import { fakeInteraction as fi, seq } from './helpers-discord.mjs';

const emptyDb = new Db();
const mkCtx = (over = {}) => {
  let t = 1_000_000;
  const ctx = { rng: seq(0.5), players: new Players(null), now: () => t, db: emptyDb, advance: (ms) => (t += ms), ...over };
  return ctx;
};

test('levels: exp curve, level ups carry over, cap', () => {
  assert.equal(L.expNeeded(1), 75);
  const p = { level: 1, exp: 0 };
  assert.equal(L.gainExp(p, 80), 1);
  assert.deepEqual([p.level, p.exp], [2, 5]);
  const big = { level: 1, exp: 0 };
  assert.ok(L.gainExp(big, 10_000) >= 3, 'several level ups at once');
  const top = { level: L.MAX_LEVEL, exp: 5 };
  assert.equal(L.gainExp(top, 1e9), 0);
  assert.deepEqual([top.level, top.exp], [L.MAX_LEVEL, 0]);
  const loss = { level: 3, exp: 2 };
  L.gainExp(loss, -50);
  assert.equal(loss.exp, 0, 'exp never goes negative');
});

test('hunting: win chance follows the level gap; results are consistent', () => {
  assert.ok(L.winChance(20, 5) > L.winChance(5, 5) && L.winChance(5, 5) > L.winChance(1, 20));
  assert.equal(L.winChance(1, 100), 0.08);
  assert.equal(L.winChance(100, 1), 0.97);
  const m = { name: 'x', level: 5, exp: null, drops: [{ name: 'a', rate: 1 }, { name: 'b', rate: 0 }, { name: 'c', rate: null }] };
  const win = L.resolveHunt({ level: 5, exp: 10 }, m, seq(0.0, 0.5, 0.0, 0.5, 0.5));
  assert.equal(win.won, true);
  assert.equal(win.exp, Math.round(6 + 5 ** 1.7));
  assert.ok(win.mesos >= 25 && win.mesos <= 55);
  assert.deepEqual(win.drops, ['a'], 'rate 1 always drops, rate 0 never, unknown rate defaults to 3%');
  const fixed = L.resolveHunt({ level: 5, exp: 0 }, { ...m, exp: 77, drops: [] }, seq(0.0, 0.5));
  assert.equal(fixed.exp, 77, 'a database exp value wins over the formula');
  const lose = L.resolveHunt({ level: 1, exp: 100 }, { ...m, level: 50 }, seq(0.99));
  assert.deepEqual([lose.won, lose.mesos, lose.drops], [false, 0, []]);
  assert.ok(lose.exp < 0 && -lose.exp <= 100);
  assert.equal(L.resolveHunt({ level: 1, exp: 0 }, { ...m, level: 50 }, seq(0.99)).exp, 0, 'nothing to lose at 0 exp');
});

test('monster sources: built-in fallback, or the imported database', () => {
  const builtin = L.monsterSource(emptyDb);
  assert.ok(builtin.length >= 5 && builtin.every((m) => Number.isFinite(m.level) && m.drops.length));
  assert.ok(L.monsterPool(builtin, 1).every((m) => m.level <= 5));
  assert.ok(L.monsterPool(builtin, 500).length === 3, 'far above everything: the closest few');
  const db = new Db(buildDb({ monsters: [{ 怪物: '甲', 等級: '10', 經驗: '33' }, { 怪物: '乙', 等級: '' }], drops: [{ 怪物: '甲', 道具: '寶', 機率: '50%' }] }).db);
  const from = L.monsterSource(db);
  assert.deepEqual(from.map((m) => m.name), ['甲'], 'monsters without a level are not used');
  assert.deepEqual(from[0].drops, [{ name: '寶', rate: 0.5 }]);
  assert.equal(from[0].exp, 33);
});

test('prices: rarer is worth more; built-in prices only without a database', () => {
  const db = new Db(buildDb({ monsters: [{ 怪物: '甲', 等級: '10' }], drops: [{ 怪物: '甲', 道具: '常見', 機率: '50%' }, { 怪物: '甲', 道具: '稀有', 機率: '0.5%' }, { 怪物: '甲', 道具: '不明' }] }).db);
  assert.ok(L.priceOf('稀有', db) > L.priceOf('常見', db) * 10);
  assert.equal(L.priceOf('不明', db), 40);
  assert.equal(L.priceOf('楓葉', emptyDb), 90);
  assert.equal(L.priceOf('沒聽過', emptyDb), 40);
  assert.ok(L.priceOf('稀有', db) <= 80_000 && L.priceOf('常見', db) >= 5);
});

test('daily check-in: once a day, streaks grow and reset (Taiwan time)', () => {
  const p = { level: 5, lastDaily: '', streak: 0, mesos: 0 };
  const day = (n) => Date.UTC(2025, 9, 28) + n * 86400_000;
  const a = L.checkIn(p, day(0) + 2 * 3600_000);
  assert.deepEqual([a.ok, a.streak, a.mesos], [true, 1, 500 + 100 + 100]);
  assert.equal(L.checkIn(p, day(0) + 10 * 3600_000).ok, false, 'same day');
  assert.equal(L.checkIn(p, day(1) + 2 * 3600_000).streak, 2);
  assert.equal(L.checkIn(p, day(5)).streak, 1, 'a missed day resets it');
  const edge = { level: 1, lastDaily: '', streak: 0, mesos: 0 };
  L.checkIn(edge, Date.UTC(2025, 9, 28, 15, 59)); // 23:59 on the 28th in Taiwan
  assert.equal(edge.lastDaily, '2025-10-28');
  assert.equal(L.checkIn(edge, Date.UTC(2025, 9, 28, 16, 1)).streak, 2, '00:01 on the 29th in Taiwan is a new day');
  assert.equal(L.dayKey(Date.UTC(2025, 9, 28, 16, 1), 8), '2025-10-29');
});

test('dice gamble: pays 1:1, a 7 loses both sides', () => {
  const roll = (a, b) => seq((a - 1) / 6 + 0.01, (b - 1) / 6 + 0.01);
  assert.deepEqual(L.diceGamble(100, 'big', roll(6, 4)), { dice: [6, 4], total: 10, won: true, delta: 100 });
  assert.equal(L.diceGamble(100, 'small', roll(6, 4)).delta, -100);
  assert.equal(L.diceGamble(100, 'small', roll(3, 4)).delta, -100, 'seven');
  assert.equal(L.diceGamble(100, 'big', roll(3, 4)).delta, -100, 'seven');
  assert.equal(L.diceGamble(50, 'small', roll(1, 2)).delta, 50);
});

test('slot machine: payouts, and the exact return to player stays below 100%', () => {
  assert.equal(L.slotPayout(['🍒', '🍒', '🍒']), 4);
  assert.equal(L.slotPayout(['7️⃣', '7️⃣', '7️⃣']), 150);
  assert.equal(L.slotPayout(['🍒', '🍒', '🍋']), 2);
  assert.equal(L.slotPayout(['🍒', '🍋', '🍒']), 2);
  assert.equal(L.slotPayout(['🍒', '🍋', '🔔']), 0);
  const total = L.SLOT_SYMBOLS.reduce((a, s) => a + s.weight, 0);
  let rtp = 0;
  for (const a of L.SLOT_SYMBOLS) for (const b of L.SLOT_SYMBOLS) for (const c of L.SLOT_SYMBOLS) {
    rtp += ((a.weight * b.weight * c.weight) / total ** 3) * L.slotPayout([a.icon, b.icon, c.icon]);
  }
  assert.ok(rtp > 0.8 && rtp < 0.97, `RTP ${rtp.toFixed(3)}: the house must win in the long run, but not absurdly`);
  const spin = L.slotGamble(10, seq(0.0, 0.0, 0.0));
  assert.deepEqual([spin.reels.join(''), spin.mult, spin.delta], ['🍒🍒🍒', 4, 30]);
  assert.equal(L.slotGamble(10, seq(0.99, 0.99, 0.99)).reels[0], '7️⃣');
});

test('players store: profiles, rewards, ranking, persistence', async () => {
  const same = new Players(null);
  assert.equal(same.get('g', 'a'), same.get('g', 'a'), 'the same object every time, so references never go stale');
  const old = new Players(null);
  old.guilds = { g: { a: { level: 7, mesos: 5 } } };
  assert.deepEqual([old.get('g', 'a').level, old.get('g', 'a').exp, Array.isArray(old.get('g', 'a').items)], [7, 0, false], 'older saves gain missing fields');
  const dir = mkdtempSync(join(tmpdir(), 'players-'));
  const path = join(dir, 'p.json');
  const s = new Players(path);
  const a = s.get('g', 'a');
  assert.equal(a.mesos, L.START_MESOS);
  a.level = 5;
  s.reward('g', 'b', 'quiz', 500);
  s.get('g', 'c').level = 5;
  s.get('g', 'c').exp = 10;
  s.get('other', 'z');
  assert.deepEqual(s.top('g').map((x) => x.userId), ['c', 'a', 'b']);
  assert.equal(s.get('g', 'b').minigames.quiz, 1);
  assert.equal(s.get(null, 'u').mesos, L.START_MESOS, 'DMs share a bucket');
  s.save();
  s.flush();
  const back = new Players(path);
  assert.equal(back.get('g', 'b').mesos, L.START_MESOS + 500);
  assert.equal(new Players(join(dir, 'missing.json')).top('g').length, 0);
});

test('/打怪: cooldown, win rewards, level up, defeat, map choice', async () => {
  const ctx = mkCtx({ rng: seq(0.0) });
  let i = fi({});
  await R.hunt(i, ctx);
  assert.match(i.last().content, /遇到 \*\*.*\*\*.*勝利/s);
  const p = ctx.players.get('g1', 'u1');
  assert.ok(p.mesos > L.START_MESOS && p.hunts === 1 && p.wins === 1);
  i = fi({});
  await R.hunt(i, ctx);
  assert.match(i.last().content, /秒後再去打/);
  assert.equal(i.last().flags, 64);
  assert.equal(p.hunts, 1, 'a cooldown does not count');
  ctx.advance(16_000);
  p.exp = L.expNeeded(1) - 1;
  i = fi({});
  await R.hunt(i, ctx);
  assert.match(i.last().content, /升級了!Lv\.\d+/);
  assert.ok(p.level >= 2);
  ctx.advance(16_000);
  const weak = mkCtx({ rng: seq(0.99), now: ctx.now });
  weak.players = ctx.players;
  p.exp = 30;
  i = fi({});
  await R.hunt(i, weak);
  assert.match(i.last().content, /被打倒了/);
  assert.equal(p.losses, 1);

  const db = new Db(buildDb({ monsters: [{ 怪物: '地圖怪', 等級: '3', 地圖: '測試地' }, { 怪物: '別處怪', 等級: '3', 地圖: '別處' }], drops: [{ 怪物: '地圖怪', 道具: '戰利品', 機率: '100%' }] }).db);
  const c2 = mkCtx({ rng: seq(0.0), db });
  i = fi({ strings: { 地圖: '測試地' } });
  await R.hunt(i, c2);
  assert.match(i.last().content, /地圖怪/);
  assert.match(i.last().content, /戰利品/);
  assert.equal(c2.players.get('g1', 'u1').items['戰利品'], 1);
  c2.advance(16_000);
  i = fi({ strings: { 地圖: '不存在' } });
  await R.hunt(i, c2);
  assert.match(i.last().content, /沒有可以打的怪物資料/);
});

test('/角色 /背包 /賣出', async () => {
  const ctx = mkCtx();
  const p = ctx.players.get('g1', 'u1');
  p.items = { 楓葉: 2, 黏液: 5 };
  p.level = 3;
  let i = fi({});
  await R.profile(i, ctx);
  assert.match(i.last().content, /Lv\.\*\*3\*\*.*█|░/s);
  assert.match(i.last().content, /7 件道具/);
  i = fi({ users: { 玩家: { id: 'other' } } });
  await R.profile(i, ctx);
  assert.match(i.last().content, /<@other>/);
  i = fi({});
  await R.bag(i, ctx);
  assert.match(i.last().content, /楓葉 ×2 — 每個 90 楓幣[\s\S]*黏液 ×5/);
  assert.equal(i.last().flags, 64);
  i = fi({ strings: { 道具: '黏液' }, ints: { 數量: 2 } });
  await R.sell(i, ctx);
  assert.match(i.last().content, /賣出 黏液 ×2.*16/);
  assert.equal(p.items.黏液, 3);
  i = fi({ strings: { 道具: '黏液' }, ints: { 數量: 99 } });
  await R.sell(i, ctx);
  assert.equal(p.items.黏液, undefined, 'asking for more than you have sells what you have');
  i = fi({ strings: { 道具: '不存在' } });
  await R.sell(i, ctx);
  assert.match(i.last().content, /背包裡沒有/);
  const before = p.mesos;
  i = fi({ strings: { 道具: '全部' } });
  await R.sell(i, ctx);
  assert.deepEqual(p.items, {});
  assert.equal(p.mesos, before + 180);
  i = fi({ strings: { 道具: '全部' } });
  await R.sell(i, ctx);
  assert.match(i.last().content, /背包是空的/);
  i = fi({});
  await R.bag(i, ctx);
  assert.match(i.last().content, /背包是空的/);
});

test('/簽到 and /排行榜', async () => {
  const ctx = mkCtx({ now: () => Date.UTC(2025, 9, 28, 2, 0) });
  let i = fi({});
  await R.daily(i, ctx);
  assert.match(i.last().content, /簽到成功.*連續 \*\*1\*\* 天/);
  i = fi({});
  await R.daily(i, ctx);
  assert.match(i.last().content, /已經簽到過/);
  const lb = fi({});
  await R.leaderboard(lb, mkCtx());
  assert.match(lb.last().content, /還沒有人/);
  ctx.players.get('g1', 'strong').level = 9;
  i = fi({});
  await R.leaderboard(i, ctx);
  assert.match(i.last().content, /🥇 <@strong> — Lv\.\*\*9\*\*/);
});

test('/賭博: bet limits, cooldown, both games, bookkeeping, virtual-money notice', async () => {
  const ctx = mkCtx({ rng: seq(0.99) });
  const p = ctx.players.get('g1', 'u1');
  p.mesos = 1000;
  const bet = async (sub, ints, strings = {}) => {
    const i = fi({ sub, ints, strings });
    await R.gamble(i, ctx);
    return i;
  };
  assert.match((await bet('拉霸', { 金額: 5 })).last().content, /最少要押 10/);
  assert.match((await bet('拉霸', { 金額: 60_000 })).last().content, /最多押 50,000/);
  assert.match((await bet('拉霸', { 金額: 5000 })).last().content, /只有 1,000 楓幣/);
  assert.equal(p.mesos, 1000, 'rejected bets cost nothing');

  let i = await bet('拉霸', { 金額: 100 }); // rng .99 -> 7️⃣ 7️⃣ 7️⃣
  assert.match(i.last().content, /7️⃣ 7️⃣ 7️⃣.*×150/);
  assert.equal(p.mesos, 1000 + 100 * 150 - 100);
  assert.match(i.last().content, /沒有任何現實價值/);
  assert.match((await bet('拉霸', { 金額: 100 })).last().content, /秒後再賭/);
  ctx.advance(5000);
  p.mesos = 1000;
  ctx.rng = seq(0.01, 0.01); // dice 1 + 1 = 2 -> small wins
  i = await bet('骰子', { 金額: 200 }, { 押注: '小' });
  assert.match(i.last().content, /1 \+ 1 = \*\*2\*\*.*押小.*贏了/);
  assert.equal(p.mesos, 1200);
  assert.equal(p.gambleWon, 14_900 + 200, 'the slot win earlier counts too');
  ctx.advance(5000);
  ctx.rng = seq(0.01, 0.01);
  i = await bet('骰子', { 金額: 300 }, { 押注: '大' });
  assert.match(i.last().content, /輸了/);
  assert.equal(p.mesos, 900);
  assert.equal(p.gambleLost, 300);
  ctx.advance(5000);
  ctx.rng = seq(0.4, 0.4); // 3 + 3 = 6... use 3 + 4
  ctx.rng = seq(0.4, 0.6);
  i = await bet('骰子', { 金額: 100 }, { 押注: '大' });
  assert.match(i.last().content, /7 點莊家通吃/);
});
