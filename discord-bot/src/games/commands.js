// Discord-facing mini game commands. Each takes an interaction `i` and a context
// {rng, players, db, guess, quizzes, setTimeout}. Buttons carry their state in custom_id.
// Winning pays mesos into the same character the RPG commands use.

import { parseDice, rollDice, scrollRun, MOVES, judge, makeQuiz } from './logic.js';

const EPHEMERAL = 64;
const row = (buttons) => [{ type: 1, components: buttons }];
const button = (custom_id, label, style = 2) => ({ type: 2, style, custom_id, label });
const mention = (id) => `<@${id}>`;

export const REWARD = { rps: 200, guessPerPoint: 300, quiz: 500 };

export async function roll(i, ctx) {
  const expr = i.options.getString('骰子') ?? '1d100';
  const d = parseDice(expr);
  if (!d) return i.reply({ content: '骰子格式不對,例如 `2d6+3`、`d20`(最多 20 顆、1000 面)。', flags: EPHEMERAL });
  const { rolls, total } = rollDice(d, ctx.rng);
  return i.reply({ content: `🎲 ${i.user.displayName ?? '你'} 擲 \`${expr.trim()}\`:${d.count > 1 ? `[${rolls.join(', ')}]` : rolls[0]}${d.mod ? ` ${d.mod > 0 ? '+' : '-'} ${Math.abs(d.mod)}` : ''} = **${total}**` });
}

export async function pick(i, ctx) {
  const options = (i.options.getString('選項') ?? '').split(/[,，、|\n]/).map((s) => s.trim()).filter(Boolean);
  if (options.length < 2) return i.reply({ content: '至少要兩個選項,用逗號隔開,例如:`吃麵, 吃飯, 吃漢堡`', flags: EPHEMERAL });
  if (options.length > 25) return i.reply({ content: '選項太多了(最多 25 個)。', flags: EPHEMERAL });
  return i.reply({ content: `🎯 抽到:**${options[Math.floor(ctx.rng() * options.length)]}**` });
}

export async function scroll(i, ctx) {
  const rate = i.options.getInteger('成功率') ?? 60;
  const slots = i.options.getInteger('格數') ?? 7;
  const { results, success } = scrollRun(rate, Math.min(15, Math.max(1, slots)), ctx.rng);
  const mood = success === results.length ? '全中!神!' : success === 0 ? '一張都沒中…下次會更好' : success * 2 >= results.length ? '手氣不錯' : '再接再厲';
  return i.reply({ content: `🧻 **${rate}% 卷軸** × ${results.length} 格\n${results.map((r) => (r ? '✅' : '❌')).join('')}\n成功 **${success}/${results.length}** — ${mood}` });
}

export async function rps(i) {
  const id = i.user.id;
  return i.reply({ content: `${mention(id)} 來猜拳,出拳吧!`, components: row(Object.entries(MOVES).map(([k, m]) => button(`rps:${id}:${k}`, `${m.icon} ${m.label}`, 1))) });
}

export async function rpsButton(i, ctx) {
  const [, owner, move] = i.customId.split(':');
  if (i.user.id !== owner || !MOVES[move]) return i.reply({ content: '這是別人的對局,用 `/猜拳` 開自己的一局。', flags: EPHEMERAL });
  const bot = Object.keys(MOVES)[Math.floor(ctx.rng() * 3)];
  const r = judge(move, bot);
  if (r === 1) ctx.players.reward(i.guildId, owner, 'rps', REWARD.rps);
  return i.update({ content: `${mention(owner)} ${MOVES[move].icon} vs 我 ${MOVES[bot].icon} — ${r === 1 ? `🎉 你贏了!(+${REWARD.rps} 楓幣)` : r === 0 ? '🤝 平手' : '😈 我贏了'}`, components: [] });
}

export async function guess(i, ctx) {
  const games = ctx.guess;
  const n = i.options.getInteger('數字');
  const ch = i.channelId;
  const g = games.status(ch);
  if (!g) {
    games.start(ch);
    if (n === null) return i.reply({ content: '🔢 我想好了一個 1~100 的數字,用 `/猜數字 數字` 來猜!' });
  } else if (n === null) {
    return i.reply({ content: `🔢 這個頻道有一局進行中:已猜 ${g.tries} 次,答案在 **${g.lo}~${g.hi}** 之間。`, flags: EPHEMERAL });
  }
  const r = games.guess(ch, n);
  const who = mention(i.user.id);
  if (r.result === 'invalid') return i.reply({ content: '請猜 1~100 的整數。', flags: EPHEMERAL });
  if (r.result === 'out') return i.reply({ content: `${n} 已經不可能了,答案在 **${r.lo}~${r.hi}** 之間。`, flags: EPHEMERAL });
  if (r.result === 'win') {
    const mesos = r.points * REWARD.guessPerPoint;
    ctx.players.reward(i.guildId, i.user.id, 'guess', mesos);
    return i.reply({ content: `🎉 ${who} 猜中了!答案是 **${r.secret}**,全場共猜 ${r.tries} 次(+${mesos} 楓幣)。再來一局:\`/猜數字\`` });
  }
  return i.reply({ content: `${who} 猜 ${n}:${r.result === 'low' ? '📈 太小了' : '📉 太大了'}(現在是 **${r.lo}~${r.hi}**,第 ${r.tries} 次)` });
}

let quizSeq = 0;
const QUIZ_MS = 60_000;

export async function quiz(i, ctx) {
  const { db, quizzes, rng } = ctx;
  const q = makeQuiz(db, rng);
  if (!q) return i.reply({ content: '怪物資料不夠(至少要 4 隻怪物、其中有掉落資料的),先匯入資料庫再玩。', flags: EPHEMERAL });
  const open = [...quizzes.values()].find((x) => x.channelId === i.channelId && !x.closed);
  if (open) return i.reply({ content: '這個頻道還有一題沒答完,先把它解決吧!', flags: EPHEMERAL });
  const id = ++quizSeq;
  const text = `🧩 **猜怪物!** 哪隻怪物會掉這些?\n${q.drops.map((d) => `• ${d}`).join('\n')}\n(${QUIZ_MS / 1000} 秒內,每人只能答一次)`;
  const state = { channelId: i.channelId, q, text, tried: new Set(), closed: false };
  quizzes.set(id, state);
  await i.reply({ content: text, components: row(q.options.map((name, k) => button(`quiz:${id}:${k}`, name, 2))) });
  ctx.setTimeout(async () => {
    if (state.closed) return;
    state.closed = true;
    quizzes.delete(id);
    await i.editReply({ content: `${text}\n⏰ 時間到,答案是 **${q.answer}**`, components: [] }).catch(() => {});
  }, QUIZ_MS);
}

export async function quizButton(i, ctx) {
  const [, idStr, kStr] = i.customId.split(':');
  const state = ctx.quizzes.get(Number(idStr));
  if (!state || state.closed) return i.reply({ content: '這題已經結束了。', flags: EPHEMERAL });
  if (state.tried.has(i.user.id)) return i.reply({ content: '你已經答過這題了。', flags: EPHEMERAL });
  state.tried.add(i.user.id);
  const k = Number(kStr);
  if (k !== state.q.answerIndex) return i.reply({ content: `❌ 不是 ${state.q.options[k]}`, flags: EPHEMERAL });
  state.closed = true;
  ctx.quizzes.delete(Number(idStr));
  ctx.players.reward(i.guildId, i.user.id, 'quiz', REWARD.quiz);
  return i.update({ content: `${state.text}\n🎉 ${mention(i.user.id)} 答對了!答案是 **${state.q.answer}**(+${REWARD.quiz} 楓幣)`, components: [] });
}

export const BUTTONS = [
  { prefix: 'rps:', handler: rpsButton },
  { prefix: 'quiz:', handler: quizButton },
];
export const COMMAND_HANDLERS = { 擲骰: roll, 抽籤: pick, 衝捲: scroll, 猜拳: rps, 猜數字: guess, 猜怪物: quiz };
