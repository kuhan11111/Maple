import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDice, rollDice, scrollRun, judge, GuessGames, makeQuiz, int, shuffle } from '../src/games/logic.js';
import * as G from '../src/games/commands.js';
import { Players } from '../src/rpg/store.js';
import { START_MESOS } from '../src/rpg/logic.js';
import { Db } from '../src/lookup/store.js';
import { buildDb } from '../src/lookup/import.js';
import { fakeInteraction as fi, seq } from './helpers-discord.mjs';

const mkCtx = (over = {}) => ({ rng: seq(0.5), players: new Players(null), db: new Db(), guess: new GuessGames({ rng: seq(0.499) }), quizzes: new Map(), setTimeout: () => {}, ...over });

test('dice parsing and rolling', () => {
  assert.deepEqual(parseDice('2d6+3'), { count: 2, sides: 6, mod: 3 });
  assert.deepEqual(parseDice('d20'), { count: 1, sides: 20, mod: 0 });
  assert.deepEqual(parseDice(' 3D8 - 2 '), { count: 3, sides: 8, mod: -2 });
  for (const bad of ['', 'abc', '0d6', '21d6', '1d1', '1d5000', null]) assert.equal(parseDice(bad), null, String(bad));
  assert.deepEqual(rollDice({ count: 2, sides: 6, mod: 1 }, seq(0, 0.999)), { rolls: [1, 6], total: 8 });
  assert.equal(int(() => 0.9999, 1, 100), 100);
});

test('scroll runs and rock-paper-scissors rules', () => {
  assert.deepEqual(scrollRun(60, 3, seq(0.1, 0.7, 0.59)), { results: [true, false, true], success: 2 });
  assert.equal(scrollRun(100, 5, () => 0.9999).success, 5);
  assert.equal(scrollRun(10, 5, () => 0.1).success, 0);
  assert.equal(judge('rock', 'scissors'), 1);
  assert.equal(judge('rock', 'paper'), -1);
  assert.equal(judge('paper', 'paper'), 0);
});

test('guess game: hints narrow the range, win awards points, expires', () => {
  let now = 0;
  const g = new GuessGames({ rng: () => 0.499, now: () => now }); // secret 50
  g.start('c');
  assert.deepEqual(g.guess('c', 25), { result: 'low', tries: 1, lo: 26, hi: 100 });
  assert.equal(g.guess('c', 10).result, 'out', 'already ruled out');
  assert.equal(g.guess('c', 0).result, 'invalid');
  assert.equal(g.guess('c', 75).result, 'high');
  const w = g.guess('c', 50);
  assert.deepEqual([w.result, w.tries, w.points], ['win', 3, 3]);
  assert.equal(g.status('c'), null);
  g.start('c');
  now = 31 * 60 * 1000;
  assert.equal(g.status('c'), null);
});

test('/roll /pick /scroll', async () => {
  let i = fi({ strings: { 骰子: '2d6+1' } });
  await G.roll(i, mkCtx({ rng: seq(0, 0.999) }));
  assert.match(i.last().content, /\[1, 6\] \+ 1 = \*\*8\*\*/);
  i = fi({ strings: { 骰子: 'nope' } });
  await G.roll(i, mkCtx());
  assert.equal(i.last().flags, 64);
  i = fi({ strings: { 選項: '麵, 飯，漢堡' } });
  await G.pick(i, mkCtx({ rng: seq(0.99) }));
  assert.match(i.last().content, /漢堡/);
  i = fi({ strings: { 選項: '只有一個' } });
  await G.pick(i, mkCtx());
  assert.equal(i.last().flags, 64);
  i = fi({ ints: { 成功率: 60, 格數: 3 } });
  await G.scroll(i, mkCtx({ rng: seq(0.1, 0.9, 0.2) }));
  assert.match(i.last().content, /✅❌✅/);
  assert.match(i.last().content, /2\/3/);
});

test('/rps: only the starter can press, win scores, buttons disappear', async () => {
  const ctx = mkCtx({ rng: seq(0.0) }); // bot plays rock
  const start = fi({ user: 'alice' });
  await G.rps(start, ctx);
  const buttons = start.last().components[0].components;
  assert.deepEqual(buttons.map((b) => b.custom_id), ['rps:alice:rock', 'rps:alice:paper', 'rps:alice:scissors']);
  const intruder = fi({ user: 'bob', customId: 'rps:alice:paper' });
  await G.rpsButton(intruder, ctx);
  assert.equal(intruder.last().flags, 64);
  const win = fi({ user: 'alice', customId: 'rps:alice:paper' });
  await G.rpsButton(win, ctx);
  assert.match(win.last().content, /你贏了.*\+200 楓幣/);
  assert.deepEqual(win.last().components, []);
  assert.equal(ctx.players.get('g1', 'alice').mesos, START_MESOS + 200);
  const lose = fi({ user: 'alice', customId: 'rps:alice:scissors' });
  await G.rpsButton(lose, ctx);
  assert.match(lose.last().content, /我贏了/);
  assert.equal(ctx.players.get('g1', 'alice').mesos, START_MESOS + 200, 'losing pays nothing');
});

test('/guess: start, hint, status, win', async () => {
  const ctx = mkCtx();
  let i = fi({});
  await G.guess(i, ctx);
  assert.match(i.last().content, /想好了/);
  i = fi({ ints: { 數字: 30 } });
  await G.guess(i, ctx);
  assert.match(i.last().content, /太小了.*31~100/);
  i = fi({});
  await G.guess(i, ctx);
  assert.match(i.last().content, /已猜 1 次/);
  i = fi({ user: 'carol', ints: { 數字: 50 } });
  await G.guess(i, ctx);
  assert.match(i.last().content, /猜中了.*\+900 楓幣/);
  assert.equal(ctx.players.get('g1', 'carol').mesos, START_MESOS + 900);
  i = fi({ ints: { 數字: 200 } });
  await G.guess(i, ctx);
  assert.match(i.last().content, /想好了|1~100/);
});

const quizDb = () =>
  new Db(buildDb({
    drops: [
      { 怪物: 'A', 道具: 'x1' }, { 怪物: 'A', 道具: 'x2' }, { 怪物: 'A', 道具: 'x3' },
      { 怪物: 'B', 道具: 'y1' }, { 怪物: 'B', 道具: 'y2' },
      { 怪物: 'C', 道具: 'z1' }, { 怪物: 'D', 道具: 'w1' },
    ],
  }).db);

test('quiz question: answer is among four options and drops belong to it', () => {
  const db = quizDb();
  for (let s = 0; s < 20; s++) {
    let k = s;
    const q = makeQuiz(db, () => ((k = (k * 7 + 3) % 10) / 10));
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options).size, 4);
    assert.equal(q.options[q.answerIndex], q.answer);
    const own = db.dropsOf(db.monsters.find((m) => m.name === q.answer).id).map((d) => d.item.name);
    assert.ok(q.drops.length >= 2 && q.drops.every((d) => own.includes(d)));
  }
  assert.equal(makeQuiz(new Db(), seq(0.5)), null);
  assert.deepEqual(shuffle([1, 2, 3], seq(0, 0, 0)).sort(), [1, 2, 3]);
});

test('/quiz: wrong answers are private, first right answer wins, timeout reveals', async () => {
  let timer;
  const ctx = mkCtx({ db: quizDb(), rng: seq(0.1, 0.4, 0.7, 0.2, 0.9), setTimeout: (fn) => (timer = fn) });
  const start = fi({});
  await G.quiz(start, ctx);
  const { components, content } = start.calls[0][1];
  assert.match(content, /猜怪物/);
  const ids = components[0].components.map((b) => b.custom_id);
  assert.equal(ids.length, 4);
  const [state] = [...ctx.quizzes.values()];
  const right = ids[state.q.answerIndex];
  const wrong = ids[(state.q.answerIndex + 1) % 4];

  const second = fi({ channel: 'c1' });
  await G.quiz(second, ctx);
  assert.match(second.last().content, /還有一題沒答完/);

  const w = fi({ user: 'bob', customId: wrong });
  await G.quizButton(w, ctx);
  assert.equal(w.last().flags, 64);
  const again = fi({ user: 'bob', customId: right });
  await G.quizButton(again, ctx);
  assert.match(again.last().content, /答過/);
  const win = fi({ user: 'alice', customId: right });
  await G.quizButton(win, ctx);
  assert.match(win.last().content, /<@alice> 答對了/);
  assert.deepEqual(win.last().components, []);
  assert.equal(ctx.players.get('g1', 'alice').mesos, START_MESOS + 500);
  assert.match(win.last().content, /\+500 楓幣/);
  const late = fi({ user: 'dave', customId: right });
  await G.quizButton(late, ctx);
  assert.match(late.last().content, /已經結束/);
  await timer(); // expiry after a win does nothing
  assert.equal(start.calls.filter((c) => c[0] === 'edit').length, 0);

  const ctx2 = mkCtx({ db: quizDb(), setTimeout: (fn) => (timer = fn) });
  const s2 = fi({});
  await G.quiz(s2, ctx2);
  await timer();
  assert.match(s2.calls.at(-1)[1].content, /時間到,答案是/);
  assert.equal(ctx2.quizzes.size, 0);

  const empty = fi({});
  await G.quiz(empty, mkCtx());
  assert.equal(empty.last().flags, 64);
});
