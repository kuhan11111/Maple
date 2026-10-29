// What each command, autocomplete, button and @mention does. Pure functions of the context, so the
// Discord plumbing (wiring.js) stays thin and everything here can be tested with fake interactions.

import { renderEntity, renderSuggestions, EMPTY_DB, kindLabel } from './lookup/render.js';
import { COMMAND_HANDLERS, BUTTONS } from './games/commands.js';
import { music, musicAutocomplete } from './music/commands.js';
import { TEXT_OPTION } from './commands.js';
import { guideLinks } from './guide.js';

const EPHEMERAL = 64;

export function helpText({ ai, musicEnabled, source }) {
  const { db } = source.get();
  const data = db.empty ? '資料庫還是空的(管理員請先匯入,見 README)' : `資料庫:${db.meta.counts?.monsters ?? db.monsters.length} 隻怪物、${db.meta.counts?.items ?? db.items.length} 個道具、${db.meta.counts?.drops ?? db.drops.length} 筆掉落`;
  return [
    '**Artale 小幫手**',
    `🔎 \`/drop 名稱\` 查掉落(怪物 → 掉什麼;道具 → 誰掉)、\`/map 地圖\` 查地圖怪物。也可以直接 @我 + 名稱。\n   ${data}`,
    '🎲 小遊戲:`/roll` `/pick` `/scroll`(衝捲)`/rps`(猜拳)`/guess`(猜數字)`/quiz`(猜怪物)`/rank`(排行榜)',
    musicEnabled ? '🎵 `/music play 歌名`、`/music radio`、`/music queue`、`/music skip`…(先進語音頻道)' : null,
    ai ? '🤖 `/ask` 問問題、`/guide` 找攻略(AI,會查網站)' : null,
  ].filter(Boolean).join('\n');
}

export function buildRoutes({ config, source, scores, guessGames, musicCtx = null, ai = null, rng = Math.random, setTimeout: st = setTimeout }) {
  const gameCtx = {
    rng,
    scores,
    guess: guessGames,
    quizzes: new Map(),
    setTimeout: st,
    get db() {
      return source.get().db;
    },
  };
  const features = { ai: !!ai, musicEnabled: !!musicCtx, source };

  // ---- lookup -------------------------------------------------------------------------
  const lookup = (kinds) => async (i) => {
    const { db, index } = source.get();
    if (db.empty) return i.reply({ content: EMPTY_DB, flags: EPHEMERAL });
    const q = i.options.getString('name', true);
    const { hit, others } = index.best(q, { kinds });
    return i.reply({ content: hit ? renderEntity(db, hit) : renderSuggestions(q, others) });
  };
  const suggest = (kinds) => async (i) => {
    const { index } = source.get();
    return i.respond(index.search(i.options.getFocused(), { kinds, limit: 25 }).map((r) => ({ name: `${r.name} ${kindLabel(r.kind)}`.slice(0, 100), value: r.name.slice(0, 100) })));
  };

  // ---- optional AI -----------------------------------------------------------------------
  const aiSlash = (kind) => async (i) => {
    const req = { userId: i.user.id, channelId: i.channelId, kind, text: i.options.getString(TEXT_OPTION[kind], true) };
    const gate = ai.admit(req);
    if (!gate.ok) return i.reply({ content: gate.message, flags: EPHEMERAL });
    await i.deferReply(); // a lookup takes longer than Discord's 3 second limit
    const r = await ai.answer(req);
    if (!r.ok) return i.editReply({ content: r.message });
    await i.editReply({ content: r.parts[0] });
    for (const part of r.parts.slice(1)) await i.followUp({ content: part });
  };

  const commands = new Map([
    ['help', (i) => i.reply({ content: helpText({ config, ...features }), flags: EPHEMERAL })],
    ['drop', lookup(['monster', 'item'])],
    ['map', lookup(['map'])],
    ['guide', (i) => i.reply({ content: guideLinks(i.options.getString('topic', true), config.sources) })],
    ...Object.entries(COMMAND_HANDLERS).map(([name, fn]) => [name, (i) => fn(i, gameCtx)]),
  ]);
  const autocomplete = new Map([
    ['drop', suggest(['monster', 'item'])],
    ['map', suggest(['map'])],
  ]);
  if (musicCtx) {
    commands.set('music', (i) => music(i, musicCtx));
    autocomplete.set('music', (i) => musicAutocomplete(i, musicCtx));
  }
  if (ai) {
    commands.set('ask', aiSlash('ask'));
    commands.set('guide', aiSlash('guide'));
    commands.set('sources', (i) =>
      i.reply({
        content: `AI 會查這些網站:\n${config.sources.map((s) => `• ${s}${config.dbDomains.includes(s) ? '(資料庫)' : ''}`).join('\n')}`,
        flags: EPHEMERAL,
      }),
    );
  }
  const components = BUTTONS.map(({ prefix, handler }) => ({ prefix, handler: (i) => handler(i, gameCtx) }));

  /**
   * "@bot something". Returns {parts} to send, or {message} for a polite refusal.
   * With AI configured the text is a question; without, it is a name to look up.
   */
  async function mention({ text, userId, channelId }) {
    const q = text.trim();
    if (ai) {
      const req = { userId, channelId, kind: 'ask', text: q };
      const gate = ai.admit(req);
      if (!gate.ok) return { parts: [gate.message] };
      const r = await ai.answer(req);
      return { parts: r.ok ? r.parts : [r.message] };
    }
    if (!q) return { parts: [helpText({ config, ...features })] };
    const { db, index } = source.get();
    if (db.empty) return { parts: [EMPTY_DB] };
    const { hit, others } = index.best(q);
    return { parts: [hit ? renderEntity(db, hit) : renderSuggestions(q, others)] };
  }

  return { commands, autocomplete, components, mention, gameCtx };
}
