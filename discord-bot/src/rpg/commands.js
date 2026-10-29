// RPG commands. ctx = {players, rng, now(), db}

import { HUNT_COOLDOWN_MS, GAMBLE_COOLDOWN_MS, MIN_BET, MAX_BET, MAX_LEVEL, expNeeded, monsterSource, monsterPool, resolveHunt, gainExp, priceOf, checkIn, diceGamble, slotGamble, bar } from './logic.js';

const EPHEMERAL = 64;
const mention = (id) => `<@${id}>`;
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/([*_`~|\\])/g, '\\$1');

export async function hunt(i, ctx) {
  const p = ctx.players.get(i.guildId, i.user.id);
  const now = ctx.now();
  const wait = HUNT_COOLDOWN_MS - (now - p.lastHunt);
  if (wait > 0) return i.reply({ content: `⏳ 還在休息,${Math.ceil(wait / 1000)} 秒後再去打。`, flags: EPHEMERAL });

  const all = monsterSource(ctx.db);
  const mapName = i.options.getString('地圖');
  let pool;
  if (mapName) {
    const inMap = new Set(ctx.db.monstersIn(mapName).map((m) => m.id));
    pool = all.filter((m) => inMap.has(m.id));
    if (!pool.length) return i.reply({ content: `「${esc(mapName)}」這張地圖沒有可以打的怪物資料(需要資料庫裡有那些怪物的等級)。`, flags: EPHEMERAL });
  } else pool = monsterPool(all, p.level);

  const monster = pool[Math.floor(ctx.rng() * pool.length)];
  const r = resolveHunt(p, monster, ctx.rng);
  p.lastHunt = now;
  p.hunts++;
  const head = `⚔️ ${mention(i.user.id)} 遇到 **${esc(monster.name)}** (Lv.${monster.level})`;
  if (!r.won) {
    p.losses++;
    p.exp += r.exp;
    ctx.players.save();
    return i.reply({ content: `${head}\n💀 被打倒了…${r.exp ? `損失 ${-r.exp} EXP` : ''}(Lv.${p.level} 勝率 ${Math.round(100 * (p.wins / Math.max(1, p.hunts)))}%)` });
  }
  p.wins++;
  p.mesos += r.mesos;
  for (const d of r.drops) p.items[d] = (p.items[d] ?? 0) + 1;
  const ups = gainExp(p, r.exp);
  ctx.players.save();
  const lines = [`${head} — **勝利!**`, `+${r.exp} EXP · +${fmt(r.mesos)} 楓幣`];
  if (r.drops.length) lines.push(`🎁 掉落:${[...new Set(r.drops)].map((d) => `${esc(d)}${r.drops.filter((x) => x === d).length > 1 ? ` ×${r.drops.filter((x) => x === d).length}` : ''}`).join('、')}`);
  if (ups) lines.push(`🎉 **升級了!Lv.${p.level}**`);
  return i.reply({ content: lines.join('\n') });
}

export async function profile(i, ctx) {
  const target = i.options.getUser?.('玩家') ?? i.user;
  const p = ctx.players.get(i.guildId, target.id);
  const need = expNeeded(p.level);
  const frac = p.level >= MAX_LEVEL ? 1 : p.exp / need;
  const items = Object.values(p.items).reduce((a, b) => a + b, 0);
  return i.reply({
    content: [
      `🍁 **${mention(target.id)} 的角色**`,
      `Lv.**${p.level}**  ${bar(frac)} ${p.level >= MAX_LEVEL ? 'MAX' : `${p.exp}/${need}`}`,
      `💰 ${fmt(p.mesos)} 楓幣 · 🎒 ${items} 件道具`,
      `⚔️ 打怪 ${p.hunts} 次(勝 ${p.wins} / 敗 ${p.losses}) · 📅 連續簽到 ${p.streak} 天`,
      p.gambleWon + p.gambleLost ? `🎰 賭博累計:贏 ${fmt(p.gambleWon)} / 輸 ${fmt(p.gambleLost)}` : null,
    ].filter(Boolean).join('\n'),
  });
}

export async function bag(i, ctx) {
  const p = ctx.players.get(i.guildId, i.user.id);
  const entries = Object.entries(p.items).filter(([, n]) => n > 0).map(([name, n]) => ({ name, n, price: priceOf(name, ctx.db) })).sort((a, b) => b.price * b.n - a.price * a.n);
  if (!entries.length) return i.reply({ content: '🎒 背包是空的,用 `/打怪` 去找點戰利品吧。', flags: EPHEMERAL });
  const total = entries.reduce((a, e) => a + e.price * e.n, 0);
  const lines = entries.slice(0, 20).map((e) => `• ${esc(e.name)} ×${e.n} — 每個 ${fmt(e.price)} 楓幣`);
  return i.reply({ content: `🎒 **背包**(全賣約 ${fmt(total)} 楓幣)\n${lines.join('\n')}${entries.length > 20 ? `\n…還有 ${entries.length - 20} 種` : ''}`, flags: EPHEMERAL });
}

export async function sell(i, ctx) {
  const p = ctx.players.get(i.guildId, i.user.id);
  const name = (i.options.getString('道具') ?? '').trim();
  const count = i.options.getInteger('數量');
  if (name === '全部') {
    const total = Object.entries(p.items).reduce((a, [n, c]) => a + c * priceOf(n, ctx.db), 0);
    const kinds = Object.keys(p.items).length;
    if (!kinds) return i.reply({ content: '背包是空的。', flags: EPHEMERAL });
    p.items = {};
    p.mesos += total;
    ctx.players.save();
    return i.reply({ content: `💰 全部賣掉了(${kinds} 種),得到 **${fmt(total)}** 楓幣。` });
  }
  const have = p.items[name] ?? 0;
  if (!have) return i.reply({ content: `背包裡沒有「${esc(name)}」。`, flags: EPHEMERAL });
  const n = Math.min(have, count ?? have);
  const gain = n * priceOf(name, ctx.db);
  if (have - n > 0) p.items[name] = have - n;
  else delete p.items[name];
  p.mesos += gain;
  ctx.players.save();
  return i.reply({ content: `💰 賣出 ${esc(name)} ×${n},得到 **${fmt(gain)}** 楓幣。` });
}

export async function daily(i, ctx) {
  const p = ctx.players.get(i.guildId, i.user.id);
  const r = checkIn(p, ctx.now());
  if (!r.ok) return i.reply({ content: '📅 你今天已經簽到過了,明天再來。', flags: EPHEMERAL });
  ctx.players.save();
  return i.reply({ content: `📅 ${mention(i.user.id)} 簽到成功!連續 **${r.streak}** 天,獲得 **${fmt(r.mesos)}** 楓幣。` });
}

export async function gamble(i, ctx) {
  const p = ctx.players.get(i.guildId, i.user.id);
  const bet = i.options.getInteger('金額');
  const now = ctx.now();
  if (!Number.isInteger(bet) || bet < MIN_BET) return i.reply({ content: `最少要押 ${MIN_BET} 楓幣。`, flags: EPHEMERAL });
  if (bet > MAX_BET) return i.reply({ content: `一次最多押 ${fmt(MAX_BET)} 楓幣。`, flags: EPHEMERAL });
  if (bet > p.mesos) return i.reply({ content: `你只有 ${fmt(p.mesos)} 楓幣,押不起 ${fmt(bet)}。可以先 \`/打怪\` 或 \`/簽到\`。`, flags: EPHEMERAL });
  const wait = GAMBLE_COOLDOWN_MS - (now - p.lastGamble);
  if (wait > 0) return i.reply({ content: `🎰 別急,${Math.ceil(wait / 1000)} 秒後再賭。`, flags: EPHEMERAL });

  const kind = i.options.getSubcommand();
  let head;
  let r;
  if (kind === '拉霸') {
    r = slotGamble(bet, ctx.rng);
    head = `🎰 ${r.reels.join(' ')}  ${r.mult ? `**中了!×${r.mult}**` : '沒中'}`;
  } else {
    const side = i.options.getString('押注') === '大' ? 'big' : 'small';
    r = diceGamble(bet, side, ctx.rng);
    head = `🎲 ${r.dice.join(' + ')} = **${r.total}**(押${side === 'big' ? '大' : '小'})${r.total === 7 ? ' — 7 點莊家通吃' : ''} ${r.won ? '**贏了!**' : '輸了'}`;
  }
  p.lastGamble = now;
  p.mesos += r.delta;
  if (r.delta > 0) p.gambleWon += r.delta;
  else p.gambleLost += -r.delta;
  ctx.players.save();
  return i.reply({ content: `${mention(i.user.id)} ${head}\n${r.delta >= 0 ? `+${fmt(r.delta)}` : `-${fmt(-r.delta)}`} 楓幣,現在有 ${fmt(p.mesos)}。\n-# 楓幣是這個機器人裡的虛擬貨幣,沒有任何現實價值。` });
}

export async function leaderboard(i, ctx) {
  const top = ctx.players.top(i.guildId, 10);
  if (!top.length) return i.reply({ content: '還沒有人開始冒險,用 `/打怪` 開始吧!' });
  const lines = top.map((u, k) => `${['🥇', '🥈', '🥉'][k] ?? `${k + 1}.`} ${mention(u.userId)} — Lv.**${u.level}** · ${fmt(u.mesos)} 楓幣`);
  return i.reply({ content: `🏆 **排行榜**\n${lines.join('\n')}` });
}

export const RPG_HANDLERS = { 打怪: hunt, 角色: profile, 背包: bag, 賣出: sell, 簽到: daily, 賭博: gamble, 排行榜: leaderboard };
