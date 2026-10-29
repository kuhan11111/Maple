// Fake interactions for testing commands without Discord.
export function fakeInteraction({ user = 'u1', guild = 'g1', channel = 'c1', strings = {}, ints = {}, customId, name, sub, member, focused = '', channelSend } = {}) {
  const calls = [];
  const rec = (n) => async (x) => void calls.push([n, x]);
  return {
    calls,
    commandName: name,
    customId,
    user: { id: user, displayName: `user-${user}` },
    guildId: guild,
    channelId: channel,
    member,
    channel: { send: async (x) => void calls.push(['send', x]) },
    deferred: false,
    replied: false,
    options: {
      getString: (k) => strings[k] ?? null,
      getInteger: (k) => ints[k] ?? null,
      getSubcommand: () => sub,
      getFocused: () => focused,
    },
    reply: rec('reply'),
    update: rec('update'),
    deferReply: async function (x) {
      this.deferred = true;
      calls.push(['defer', x]);
    },
    editReply: rec('edit'),
    followUp: rec('follow'),
    respond: rec('respond'),
    last: () => calls.at(-1)[1],
  };
}

// deterministic rng from a list of numbers (cycles)
export const seq = (...v) => {
  let i = 0;
  return () => v[i++ % v.length];
};
