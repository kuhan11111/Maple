// Connects discord.js events to the handlers. Takes the client as a parameter so tests can
// drive it with fakes.

import { Events, MessageFlags } from 'discord.js';
import { TEXT_OPTION } from './commands.js';

const NO_PINGS = { parse: [] };

export function attach(discord, { handlers, config, log = () => {} }) {
  discord.once(Events.ClientReady, (c) => log('ready', { user: c.user.tag, guilds: c.guilds.cache.size, sources: config.sources }));

  discord.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand()) return;
    try {
      if (i.commandName === 'sources') {
        const rows = config.sources.map((s) => `• ${s}${config.dbDomains.includes(s) ? '(資料庫)' : ''}`).join('\n');
        await i.reply({
          content: `我會查這些網站:\n${rows}\n\n用法:\`/ask\` 問問題、\`/drop\` 查掉落、\`/guide\` 找攻略,或直接 @我。`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: NO_PINGS,
        });
        return;
      }
      const opt = TEXT_OPTION[i.commandName];
      if (!opt) return;
      const req = { userId: i.user.id, channelId: i.channelId, kind: i.commandName, text: i.options.getString(opt, true) };
      const gate = handlers.admit(req);
      if (!gate.ok) return void (await i.reply({ content: gate.message, flags: MessageFlags.Ephemeral }));
      await i.deferReply(); // a lookup takes longer than Discord's 3 second limit
      const r = await handlers.answer(req);
      if (!r.ok) return void (await i.editReply({ content: r.message }));
      await i.editReply({ content: r.parts[0] });
      for (const part of r.parts.slice(1)) await i.followUp({ content: part });
    } catch (err) {
      log('interaction_error', { command: i.commandName, message: err?.message });
      if (i.deferred || i.replied) await i.editReply({ content: '出了點問題,請稍後再試。' }).catch(() => {});
      else await i.reply({ content: '出了點問題,請稍後再試。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // "@Artale小幫手 肥肥頭哪裡打" - Discord delivers the text of messages that mention the bot
  // even without the privileged Message Content intent.
  discord.on(Events.MessageCreate, async (m) => {
    const me = discord.user;
    if (m.author.bot || !me || !m.mentions.has(me, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) return;
    const req = {
      userId: m.author.id,
      channelId: m.channelId,
      kind: 'ask',
      text: m.content.replace(new RegExp(`<@!?${me.id}>`, 'g'), '').trim(),
    };
    const quiet = { repliedUser: false };
    const gate = handlers.admit(req);
    if (!gate.ok) return void (await m.reply({ content: gate.message, allowedMentions: quiet }).catch(() => {}));
    await m.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => m.channel.sendTyping().catch(() => {}), 8000);
    try {
      const r = await handlers.answer(req);
      const parts = r.ok ? r.parts : [r.message];
      await m.reply({ content: parts[0], allowedMentions: quiet });
      for (const part of parts.slice(1)) await m.channel.send({ content: part, allowedMentions: NO_PINGS });
    } catch (err) {
      log('message_error', { message: err?.message });
    } finally {
      clearInterval(typing);
    }
  });
}
