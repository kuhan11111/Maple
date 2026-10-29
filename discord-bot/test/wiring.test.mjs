import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, MessageFlags } from 'discord.js';
import { attach } from '../src/wiring.js';
import { fakeInteraction } from './helpers-discord.mjs';

function setup(routes = {}) {
  const discord = new EventEmitter();
  discord.user = { id: '999', tag: 'bot#1' };
  const r = { commands: new Map(), autocomplete: new Map(), components: [], mention: async () => ({ parts: ['x'] }), ...routes };
  attach(discord, { routes: r });
  return { discord, handler: (ev) => discord.listeners(ev)[0] };
}

const as = (i, kind) => Object.assign(i, { isChatInputCommand: () => kind === 'command', isAutocomplete: () => kind === 'auto', isButton: () => kind === 'button' });

test('commands, autocomplete and buttons are dispatched to their routes', async () => {
  const seen = [];
  const { handler } = setup({
    commands: new Map([['drop', async (i) => seen.push(['cmd', i.commandName])]]),
    autocomplete: new Map([['drop', async () => seen.push(['auto'])]]),
    components: [{ prefix: 'rps:', handler: async (i) => seen.push(['btn', i.customId]) }, { prefix: 'quiz:', handler: async () => seen.push(['quiz']) }],
  });
  const h = handler(Events.InteractionCreate);
  await h(as(fakeInteraction({ name: 'drop' }), 'command'));
  await h(as(fakeInteraction({ name: 'drop' }), 'auto'));
  await h(as(fakeInteraction({ customId: 'rps:a:rock' }), 'button'));
  await h(as(fakeInteraction({ name: 'unknown' }), 'command'));
  await h(as(fakeInteraction({ customId: 'zzz:1' }), 'button'));
  assert.deepEqual(seen, [['cmd', 'drop'], ['auto'], ['btn', 'rps:a:rock']]);
});

test('an exception never leaves the user hanging', async () => {
  const boom = async () => {
    throw new Error('boom');
  };
  const { handler } = setup({ commands: new Map([['x', boom]]), autocomplete: new Map([['x', boom]]) });
  const h = handler(Events.InteractionCreate);
  const fresh = as(fakeInteraction({ name: 'x' }), 'command');
  await h(fresh);
  assert.equal(fresh.calls[0][0], 'reply');
  assert.equal(fresh.calls[0][1].flags, MessageFlags.Ephemeral);
  const deferred = as(fakeInteraction({ name: 'x' }), 'command');
  deferred.deferred = true;
  await h(deferred);
  assert.equal(deferred.calls[0][0], 'edit');
  const auto = as(fakeInteraction({ name: 'x' }), 'auto');
  await h(auto);
  assert.deepEqual(auto.calls, [], 'autocomplete failures are silent');
});

function message(content, { bot = false, mentions = true } = {}) {
  const calls = [];
  return {
    calls,
    author: { id: 'u1', bot },
    channelId: 'c1',
    content,
    mentions: { has: () => mentions },
    reply: async (x) => void calls.push(['reply', x]),
    channel: { sendTyping: async () => {}, send: async (x) => void calls.push(['send', x]) },
  };
}

test('mention: strips the mention, replies without pinging, sends extra parts to the channel', async () => {
  let seen;
  const { handler } = setup({ mention: async (r) => ((seen = r), { parts: ['a', 'b'] }) });
  const m = message('<@999> 肥肥頭哪裡打?');
  await handler(Events.MessageCreate)(m);
  assert.deepEqual(seen, { text: '肥肥頭哪裡打?', userId: 'u1', channelId: 'c1' });
  assert.equal(m.calls[0][0], 'reply');
  assert.deepEqual(m.calls[0][1].allowedMentions, { repliedUser: false });
  assert.deepEqual(m.calls[1][1].allowedMentions, { parse: [] });
});

test('mention: ignores bots and messages that do not mention the bot', async () => {
  const { handler } = setup({ mention: async () => assert.fail('must not run') });
  const h = handler(Events.MessageCreate);
  const bot = message('<@999> hi', { bot: true });
  const other = message('hello', { mentions: false });
  await h(bot);
  await h(other);
  assert.deepEqual([bot.calls, other.calls], [[], []]);
});

test('mention: a failing route answers politely instead of crashing', async () => {
  const { handler } = setup({
    mention: async () => {
      throw new Error('boom');
    },
  });
  const m = message('<@999> hi');
  await handler(Events.MessageCreate)(m);
  assert.match(m.calls[0][1].content, /出了點問題/);
});

test('intel: every message is offered to the intel route with the bot id, and failures never break the bot', async () => {
  const seen = [];
  let boom = false;
  const { handler } = setup({
    intel: (m, id) => {
      seen.push([m.content, id]);
      if (boom) throw new Error('boom');
    },
    mention: async () => ({ parts: ['x'] }),
  });
  const h = handler(Events.MessageCreate);
  await h(message('plain chatter', { mentions: false }));
  await h(message('<@999> hi', { bot: true })); // other bots / followed announcements are offered too
  assert.deepEqual(seen, [['plain chatter', '999'], ['<@999> hi', '999']]);
  boom = true;
  const m = message('<@999> still answered');
  await h(m);
  assert.equal(m.calls[0][0], 'reply', 'a crashing intel hook does not stop the normal reply');
});
