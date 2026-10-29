// What each command, autocomplete, button, @mention and intel-channel post does. Functions of the
// context only, so the Discord plumbing (wiring.js) stays thin and everything here can be tested with
// fake interactions.

import { renderEntity, renderSuggestions, EMPTY_DB, kindLabel } from './lookup/render.js';
import { COMMAND_HANDLERS, BUTTONS } from './games/commands.js';
import { RPG_HANDLERS } from './rpg/commands.js';
import { AI_OPTION } from './commands.js';
import { guideLinks } from './guide.js';
import { stripPings } from './format.js';
import { renderNews, NO_SOURCES, NO_ITEMS } from './news/render.js';
import { readSource } from './news/refresh.js';

const EPHEMERAL = 64;
const esc = (s) => String(s ?? '').replace(/([*_`~|\\])/g, '\\$1');
const isAdmin = (i) => !!i.memberPermissions?.has?.('ManageGuild');
const say = (i, content, ephemeral = false) => i.reply({ content: stripPings(content), ...(ephemeral ? { flags: EPHEMERAL } : {}) });
const preview = (items, n = 3) => items.slice(0, n).map((x) => `\n• ${esc(x.title).slice(0, 80)}`).join('');
const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

export function helpText({ ai, source, config }) {
  const { db } = source.get();
  const data = db.empty ? '資料庫還是空的(管理員請先匯入,或大家用 `/回報` 補充)' : `資料庫:${db.monsters.length} 隻怪物、${db.items.length} 個道具、${db.drops.length} 筆掉落`;
  return [
    '**Artale 小幫手**',
    `🔎 \`/掉落物 名稱\` 查掉落(怪物 → 掉什麼;道具 → 誰掉)、\`/地圖 名稱\`。也可以直接 @我 + 名稱。\n   ${data}\n   (未知) = 還沒有資料;〔玩家回報〕 = 玩家分享、尚未證實。有消息請用 \`/回報\`。`,
    `📰 \`/更新情報\` 看最新的更新與情報(每天 ${config.newsDailyAt} 自動收集)、\`/攻略 主題\` 找攻略`,
    '⚔️ 楓之谷風格小遊戲:`/打怪` `/角色` `/背包` `/賣出` `/簽到` `/賭博` `/排行榜`',
    '🎲 `/擲骰` `/抽籤` `/衝捲` `/猜拳` `/猜數字` `/猜怪物`(贏了有楓幣)',
    ai ? '🤖 `/問答` 問問題(AI,會查網站)' : null,
  ].filter(Boolean).join('\n');
}

export function buildRoutes({ config, source, reports, players, guessGames, sources, news, refresher, fetchText, ai = null, rng = Math.random, now = () => Date.now(), setTimeout: st = setTimeout }) {
  const ctx = {
    rng,
    players,
    guess: guessGames,
    quizzes: new Map(),
    setTimeout: st,
    now,
    get db() {
      return source.get().db;
    },
  };

  // ---- lookup -------------------------------------------------------------------------
  const lookup = (kinds) => async (i) => {
    const { db, index } = source.get();
    if (db.empty) return say(i, EMPTY_DB, true);
    const q = i.options.getString('名稱', true);
    const { hit, others } = index.best(q, { kinds });
    return say(i, hit ? renderEntity(db, hit) : renderSuggestions(q, others));
  };
  const suggest = (kinds, getValue = (i) => i.options.getFocused()) => async (i) => {
    const { index } = source.get();
    const q = getValue(i);
    const found = String(q).trim() ? index.search(q, { kinds, limit: 25 }) : index.browse({ kinds, limit: 25 });
    return i.respond(found.map((r) => ({ name: `${r.name} ${kindLabel(r.kind)}`.slice(0, 100), value: r.name.slice(0, 100) })));
  };

  // ---- player reports -----------------------------------------------------------------
  const report = async (i) => {
    const o = (k) => i.options.getString(k);
    const r = reports.add({ monster: o('怪物'), item: o('道具'), rate: o('機率'), map: o('地圖'), source: o('來源'), userId: i.user.id });
    if (!r.ok) return say(i, r.message, true);
    const rate = o('機率') ? `(${esc(o('機率'))})` : '';
    return say(i, `✅ 已${r.updated ? '更新' : '記錄'}回報 #${r.id}:**${esc(o('怪物'))}** 掉 **${esc(o('道具'))}**${rate}${o('地圖') ? ` · ${esc(o('地圖'))}` : ''}\n查詢時會標示為〔玩家回報〕,大家知道還沒證實。要撤回:\`/回報刪除 編號:${r.id}\``);
  };
  const unreport = async (i) => {
    const r = reports.remove(i.options.getInteger('編號', true), { userId: i.user.id, admin: isAdmin(i) });
    return say(i, r.ok ? `🗑️ 已刪除回報 #${r.report.id}。` : r.message, true);
  };

  // ---- news -----------------------------------------------------------------------------
  const latest = async (i) => {
    if (!sources.sources.length && !sources.channels.length) return say(i, NO_SOURCES, true);
    await i.deferReply();
    if (sources.sources.length && refresher.stale) await Promise.race([refresher.ensureFresh().catch(() => {}), timeout(20_000)]);
    const src = i.options.getString('來源');
    const items = news.recent(i.options.getInteger('數量') ?? 8, { source: src });
    return i.editReply({ content: stripPings(items.length ? renderNews(items, { now: now(), lastRefresh: news.lastRefresh, offsetHours: config.tzOffsetHours, source: src }) : NO_ITEMS) });
  };

  const manageSources = async (i) => {
    if (!isAdmin(i)) return say(i, '需要「管理伺服器」權限才能設定情報來源。', true);
    const sub = i.options.getSubcommand();
    const name = () => i.options.getString('名稱', true);
    if (sub === '列表') {
      const rows = sources.sources.map((s) => `• **${esc(s.name)}** — ${s.type}${s.keywords.length ? ` · 關鍵字:${s.keywords.map(esc).join('、')}` : ''}\n  <${s.url}>`);
      const chans = sources.channels.map((c) => `📡 <#${c.id}>`);
      return say(i, [`📰 **情報來源**(每天 ${config.newsDailyAt} 自動更新,上次:${news.lastRefresh ? new Date(news.lastRefresh + config.tzOffsetHours * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : '尚未'})`, ...(rows.length ? rows : ['(沒有網站來源)']), ...chans].join('\n'), true);
    }
    if (sub === '新增' || sub === '測試') {
      let s;
      if (sub === '新增') {
        const r = sources.add({ name: name(), url: i.options.getString('網址', true), type: i.options.getString('類型') ?? 'auto', keywords: i.options.getString('關鍵字') ?? '', include: i.options.getString('連結篩選') ?? '' });
        if (!r.ok) return say(i, `❌ ${r.message}`, true);
        s = sources.get(name());
      } else {
        s = sources.get(name());
        if (!s) return say(i, `找不到來源「${esc(name())}」。`, true);
      }
      await i.deferReply({ flags: EPHEMERAL });
      try {
        const { items, via } = await readSource(s, { fetchText });
        const verb = sub === '新增' ? '已儲存' : '測試';
        return i.editReply({ content: stripPings(`✅ ${verb}「${esc(s.name)}」:抓到 ${items.length} 則(${via === 'feed' ? 'RSS' : '網頁連結'})${items.length ? preview(items, 5) : '\n沒抓到內容:網址可能不對、網站擋機器人,或是要設「關鍵字 / 連結篩選」。'}`) });
      } catch (err) {
        return i.editReply({ content: stripPings(`⚠️ ${sub === '新增' ? `已儲存「${esc(s.name)}」,但` : ''}抓取失敗:${esc(err.message)}。${sub === '新增' ? '可用 `/情報來源 移除` 刪掉。' : ''}`) });
      }
    }
    if (sub === '移除') return say(i, sources.remove(name()) ? `🗑️ 已移除「${esc(name())}」。` : `找不到來源「${esc(name())}」。`, true);
    if (sub === '立即更新') {
      if (!sources.sources.length) return say(i, NO_SOURCES, true);
      await i.deferReply({ flags: EPHEMERAL });
      const { results, added } = await refresher.refresh();
      return i.editReply({ content: stripPings(`📰 更新完成,新增 ${added.length} 則:\n${results.map((r) => (r.ok ? `✅ ${esc(r.name)}:找到 ${r.found}、新增 ${r.added}` : `❌ ${esc(r.name)}:${esc(r.error)}`)).join('\n')}`) });
    }
    if (sub === '頻道加入' || sub === '頻道移除') {
      const ch = i.options.getChannel('頻道', true);
      if (sub === '頻道加入') {
        sources.addChannel(ch.id, ch.name);
        return say(i, `📡 已把 <#${ch.id}> 當成情報來源。${config.channelIntel ? '' : '\n⚠️ 目前沒有啟用這個功能:要在 `.env` 設 `ENABLE_CHANNEL_INTEL=1`,並到 Discord Developer Portal → Bot 開啟 **Message Content Intent**,然後重啟機器人。'}\n小提醒:要收其他社群的公告,可以在那個社群的公告頻道用 Discord 的「追蹤」功能,把公告轉進這個頻道。`, true);
      }
      return say(i, sources.removeChannel(ch.id) ? `🗑️ 不再把 <#${ch.id}> 當成情報來源。` : '那個頻道本來就不是情報來源。', true);
    }
  };

  // ---- optional AI -----------------------------------------------------------------------
  const aiSlash = (cmd) => async (i) => {
    const { option, kind } = AI_OPTION[cmd];
    const req = { userId: i.user.id, channelId: i.channelId, kind, text: i.options.getString(option, true) };
    const gate = ai.admit(req);
    if (!gate.ok) return say(i, gate.message, true);
    await i.deferReply(); // a lookup takes longer than Discord's 3 second limit
    const r = await ai.answer(req);
    if (!r.ok) return i.editReply({ content: r.message });
    await i.editReply({ content: r.parts[0] });
    for (const part of r.parts.slice(1)) await i.followUp({ content: part });
  };

  const commands = new Map([
    ['說明', (i) => say(i, helpText({ ai: !!ai, source, config }), true)],
    ['掉落物', lookup(['monster', 'item'])],
    ['地圖', lookup(['map'])],
    ['攻略', (i) => say(i, guideLinks(i.options.getString('主題', true), config.sources))],
    ['更新情報', latest],
    ['回報', report],
    ['回報刪除', unreport],
    ['情報來源', manageSources],
    ...Object.entries({ ...COMMAND_HANDLERS, ...RPG_HANDLERS }).map(([name, fn]) => [name, (i) => fn(i, ctx)]),
  ]);

  const names = (list, focused) => list.filter((n) => n.toLowerCase().includes(focused.toLowerCase())).slice(0, 25).map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) }));
  const autocomplete = new Map([
    ['掉落物', suggest(['monster', 'item'])],
    ['地圖', suggest(['map'])],
    ['打怪', suggest(['map'])],
    ['更新情報', (i) => i.respond(names(sources.sources.map((s) => s.name), i.options.getFocused()))],
    ['情報來源', (i) => i.respond(names(sources.sources.map((s) => s.name), i.options.getFocused()))],
    ['賣出', (i) => i.respond(names(['全部', ...Object.keys(players.get(i.guildId, i.user.id).items)], i.options.getFocused()))],
    [
      '回報',
      (i) => {
        const f = i.options.getFocused(true);
        const kinds = { 怪物: ['monster'], 道具: ['item'], 地圖: ['map'] }[f.name];
        return kinds ? suggest(kinds, () => f.value)(i) : i.respond([]);
      },
    ],
  ]);

  if (ai) {
    commands.set('問答', aiSlash('問答'));
    commands.set('攻略', aiSlash('攻略'));
    commands.set('ai來源', (i) => say(i, `AI 會查這些網站:\n${config.sources.map((s) => `• ${s}${config.dbDomains.includes(s) ? '(資料庫)' : ''}`).join('\n')}`, true));
  }
  const components = BUTTONS.map(({ prefix, handler }) => ({ prefix, handler: (i) => handler(i, ctx) }));

  /** "@bot something" -> {parts}. With AI configured it is a question; without, a name to look up. */
  async function mention({ text, userId, channelId }) {
    const q = text.trim();
    if (ai) {
      const req = { userId, channelId, kind: 'ask', text: q };
      const gate = ai.admit(req);
      if (!gate.ok) return { parts: [gate.message] };
      const r = await ai.answer(req);
      return { parts: r.ok ? r.parts : [r.message] };
    }
    if (!q) return { parts: [stripPings(helpText({ ai: false, source, config }))] };
    const { db, index } = source.get();
    if (db.empty) return { parts: [EMPTY_DB] };
    const { hit, others } = index.best(q);
    return { parts: [stripPings(hit ? renderEntity(db, hit) : renderSuggestions(q, others))] };
  }

  /** A message in a registered intel channel becomes a news item (title = its first line). */
  function intel(m, selfId) {
    const ch = sources.channels.find((c) => c.id === m.channelId);
    if (!ch || m.author?.id === selfId) return false;
    const embed = m.embeds?.[0];
    const text = [m.content, embed?.title, embed?.description].filter(Boolean).join('\n').trim();
    if (!text) return false;
    const [first, ...rest] = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return news.merge([{ title: first.replace(/\s+/g, ' ').slice(0, 120), url: m.url ?? embed?.url, publishedAt: m.createdTimestamp ?? null, snippet: rest.join(' ') }], `#${ch.name}`).length > 0;
  }

  return { commands, autocomplete, components, mention, intel, ctx };
}
