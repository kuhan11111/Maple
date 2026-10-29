// Connects discord.js events to the routes. Takes the client as a parameter so tests can drive it
// with fakes.

import { Events, MessageFlags } from 'discord.js';

const NO_PINGS = { parse: [] };
const SORRY = '出了點問題,請稍後再試。';

export function attach(discord, { routes, log = () => {} }) {
  discord.once(Events.ClientReady, (c) => log('ready', { user: c.user.tag, guilds: c.guilds.cache.size, commands: [...routes.commands.keys()] }));

  discord.on(Events.InteractionCreate, async (i) => {
    let run;
    let label;
    if (i.isChatInputCommand()) [run, label] = [routes.commands.get(i.commandName), i.commandName];
    else if (i.isAutocomplete()) [run, label] = [routes.autocomplete.get(i.commandName), `${i.commandName}:autocomplete`];
    else if (i.isButton()) [run, label] = [routes.components.find((c) => i.customId.startsWith(c.prefix))?.handler, `button:${i.customId.split(':')[0]}`];
    if (!run) return;
    try {
      await run(i);
    } catch (err) {
      log('interaction_error', { where: label, message: err?.message });
      if (i.isAutocomplete()) return;
      if (i.deferred || i.replied) await i.editReply({ content: SORRY }).catch(() => {});
      else await i.reply({ content: SORRY, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // "@Artale小幫手 肥肥頭" - Discord delivers the text of messages that mention the bot even without
  // the privileged Message Content intent.
  discord.on(Events.MessageCreate, async (m) => {
    const me = discord.user;
    if (m.author.bot || !me || !m.mentions.has(me, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) return;
    const quiet = { repliedUser: false };
    await m.channel.sendTyping().catch(() => {});
    const typing = setInterval(() => m.channel.sendTyping().catch(() => {}), 8000);
    try {
      const text = m.content.replace(new RegExp(`<@!?${me.id}>`, 'g'), '').trim();
      const { parts } = await routes.mention({ text, userId: m.author.id, channelId: m.channelId });
      await m.reply({ content: parts[0], allowedMentions: quiet });
      for (const part of parts.slice(1)) await m.channel.send({ content: part, allowedMentions: NO_PINGS });
    } catch (err) {
      log('message_error', { message: err?.message });
      await m.reply({ content: SORRY, allowedMentions: quiet }).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });
}
