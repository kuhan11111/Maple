// /music ... - Discord-facing music commands. ctx = {library, manager}.

import { stripPings } from '../format.js';

const EPHEMERAL = 64;
const PAGE = 15;
const LOOP = { off: '關閉', one: '單曲循環', all: '整個佇列循環' };
const name = (t) => stripPings(t.title.replace(/([*_`~|>])/g, '\\$1'));
const say = (i, content, ephemeral = false) => i.reply(ephemeral ? { content, flags: EPHEMERAL } : { content });

/** The voice channel the user is in, or an explanation. Also checks the bot can use it. */
function voiceOf(i, ctx) {
  const vc = i.member?.voice?.channel;
  if (!vc) return { error: '先加入一個語音頻道,我才知道要去哪裡唱。' };
  const mine = ctx.manager.get(i.guildId);
  if (mine && mine.channelId !== vc.id) return { error: '我已經在另一個語音頻道播放了,請先加入那個頻道。' };
  const perms = vc.permissionsFor?.(vc.guild?.members?.me);
  if (perms && !perms.has(['Connect', 'Speak'])) return { error: `我在「${vc.name}」沒有「連接」或「說話」的權限。` };
  return { vc };
}

async function enqueue(i, ctx, track) {
  const { vc, error } = voiceOf(i, ctx);
  if (error) return say(i, error, true);
  await i.deferReply();
  let player;
  try {
    player = await ctx.manager.ensure(i.guildId, vc, (e) => notify(i, e));
  } catch (err) {
    return i.editReply({ content: `⚠️ ${err.message}` });
  }
  const pos = player.add(track);
  if (pos < 0) return i.editReply({ content: '佇列滿了(最多 50 首),等等再點吧。' });
  const icon = track.kind === 'radio' ? '📻' : '🎵';
  return i.editReply({ content: pos === 0 ? `▶️ 開始播放:${icon} **${name(track)}**` : `➕ 已加入佇列(第 ${pos} 首):${icon} **${name(track)}**` });
}

// Messages for things that happen without anyone typing a command.
function notify(i, e) {
  const send = (content) => i.channel?.send?.({ content, allowedMentions: { parse: [] } }).catch(() => {});
  if (e.type === 'playing' && e.auto) send(`▶️ 下一首:**${name(e.track)}**`);
  else if (e.type === 'error') send(`⚠️ 「${name(e.track)}」播放失敗,已跳過。`);
}

const SUB = {
  async play(i, ctx) {
    const track = ctx.library.find(i.options.getString('song', true));
    if (!track) return say(i, '找不到這首歌。用 `/music list` 看有哪些。', true);
    return enqueue(i, ctx, track);
  },

  async radio(i, ctx) {
    if (!ctx.library.radio.length) return say(i, '管理員還沒有設定電台(`RADIO_STREAMS`)。', true);
    const track = ctx.library.findRadio(i.options.getString('station', true));
    if (!track) return say(i, `找不到這個電台。可選:${ctx.library.radio.map((r) => r.title).join('、')}`, true);
    return enqueue(i, ctx, track);
  },

  async list(i, ctx) {
    const files = ctx.library.refresh(true);
    if (!files.length) return say(i, '音樂資料夾是空的:把音樂檔(mp3、ogg、flac、wav…)放進機器人的 `music/` 資料夾。', true);
    const pages = Math.ceil(files.length / PAGE);
    const page = Math.min(Math.max(1, i.options.getInteger('page') ?? 1), pages);
    const rows = files.slice((page - 1) * PAGE, page * PAGE).map((t, k) => `${(page - 1) * PAGE + k + 1}. ${name(t)}`);
    const radio = ctx.library.radio.length ? `\n📻 電台:${ctx.library.radio.map((r) => r.title).join('、')}` : '';
    return say(i, `🎶 **音樂庫**(${files.length} 首,第 ${page}/${pages} 頁)\n${rows.join('\n')}${radio}\n用 \`/music play\` 輸入歌名播放。`, true);
  },

  async queue(i, ctx) {
    const p = ctx.manager.get(i.guildId);
    if (!p?.current) return say(i, '現在沒有在播放。', true);
    const next = p.queue.slice(0, 10).map((t, k) => `${k + 1}. ${name(t)}`);
    return say(i, `▶️ **${name(p.current)}**${p.paused ? '(暫停中)' : ''}${next.length ? `\n接下來:\n${next.join('\n')}${p.queue.length > 10 ? `\n…還有 ${p.queue.length - 10} 首` : ''}` : '\n(佇列是空的)'}\n循環:${LOOP[p.loop]} · 音量:${p.volume}`, true);
  },

  async now(i, ctx) {
    const p = ctx.manager.get(i.guildId);
    return say(i, p?.current ? `${p.current.kind === 'radio' ? '📻' : '🎵'} 現在播放:**${name(p.current)}**${p.paused ? '(暫停中)' : ''}` : '現在沒有在播放。', !p?.current);
  },

  async skip(i, ctx) {
    return control(i, ctx, (p) => (p.skip() ? '⏭️ 已跳過。' : '現在沒有在播放。'));
  },
  async pause(i, ctx) {
    return control(i, ctx, (p) => (p.pause() ? '⏸️ 已暫停。' : '沒有可以暫停的歌。'));
  },
  async resume(i, ctx) {
    return control(i, ctx, (p) => (p.resume() ? '▶️ 繼續播放。' : '現在不是暫停狀態。'));
  },
  async stop(i, ctx) {
    return control(i, ctx, (p) => (p.close(), '⏹️ 已停止並離開頻道。'));
  },
  async loop(i, ctx) {
    const mode = i.options.getString('mode', true);
    return control(i, ctx, (p) => (p.setLoop(mode), `🔁 循環模式:${LOOP[mode] ?? mode}`));
  },
  async volume(i, ctx) {
    const v = i.options.getInteger('level', true);
    return control(i, ctx, (p) => (p.setVolume(v), `🔊 音量:${p.volume}`));
  },
};

async function control(i, ctx, fn) {
  const p = ctx.manager.get(i.guildId);
  if (!p) return say(i, '我現在沒有在播放。', true);
  const { error } = voiceOf(i, ctx);
  if (error) return say(i, error, true);
  return say(i, fn(p));
}

export async function music(i, ctx) {
  const sub = SUB[i.options.getSubcommand()];
  if (!sub) return;
  if (!i.guildId) return say(i, '音樂指令只能在伺服器裡用。', true);
  return sub(i, ctx);
}

export async function musicAutocomplete(i, ctx) {
  const focused = i.options.getFocused();
  const sub = i.options.getSubcommand();
  const pool = sub === 'radio' ? ctx.library.searchRadio(focused) : sub === 'play' ? ctx.library.search(focused) : [];
  return i.respond(pool.slice(0, 25).map((t) => ({ name: `${t.kind === 'radio' ? '📻 ' : ''}${t.folder ? `${t.folder}/` : ''}${t.title}`.slice(0, 100), value: t.id })));
}
