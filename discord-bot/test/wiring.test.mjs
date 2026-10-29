import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, MessageFlags } from 'discord.js';
import { attach } from '../src/wiring.js';
import { baseConfig } from './helpers.mjs';

function setup(handlers) {
  const discord = new EventEmitter();
  discord.once = (ev, fn) => EventEmitter.prototype.once.call(discord, ev, fn);
  discord.user = { id: '999', tag: 'bot#1' };
  attach(discord, { handlers, config: baseConfig });
  return discord;
}

function interaction(name, value) {
  const calls = [];
  const rec = (n) => async (x) => void calls.push([n, x]);
  return {
    calls,
    commandName: name,
    user: { id: 'u1' },
    channelId: 'c1',
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: { getString: () => value },
    reply: rec('reply'),
    deferReply: async function (x) {
      this.deferred = true;
      calls.push(['defer', x]);
    },
    editReply: rec('edit'),
    followUp: rec('follow'),
  };
}

const ok = (parts) => ({ admit: () => ({ ok: true }), answer: async () => ({ ok: true, parts }) });

test('slash command: gate first, then defer, then edit and follow up for extra parts', async () => {
  const d = setup(ok(['one', 'two', 'three']));
  const i = interaction('drop', '肥肥頭');
  await d.listeners(Events.InteractionCreate)[0](i);
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit', 'follow', 'follow']);
  assert.equal(i.calls[1][1].content, 'one');
  assert.equal(i.calls[3][1].content, 'three');
});

test('slash command: rejected requests get a private reply and never defer', async () => {
  const d = setup({ admit: () => ({ ok: false, message: '查太快了' }), answer: async () => assert.fail('must not run') });
  const i = interaction('ask', 'x');
  await d.listeners(Events.InteractionCreate)[0](i);
  assert.deepEqual(i.calls.map((c) => c[0]), ['reply']);
  assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
});

test('slash command: a failed lookup is shown as the reply text', async () => {
  const d = setup({ admit: () => ({ ok: true }), answer: async () => ({ ok: false, message: '查詢逾時了' }) });
  const i = interaction('guide', 'x');
  await d.listeners(Events.InteractionCreate)[0](i);
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit']);
  assert.equal(i.calls[1][1].content, '查詢逾時了');
});

test('slash command: /sources lists sites privately; unknown commands are ignored', async () => {
  const d = setup(ok(['x']));
  const s = interaction('sources');
  await d.listeners(Events.InteractionCreate)[0](s);
  assert.match(s.calls[0][1].content, /artalemaplestory\.com\(資料庫\)/);
  assert.equal(s.calls[0][1].flags, MessageFlags.Ephemeral);
  const u = interaction('whatever', 'x');
  await d.listeners(Events.InteractionCreate)[0](u);
  assert.deepEqual(u.calls, []);
});

test('slash command: an exception inside never leaves the user hanging', async () => {
  const d = setup({ admit: () => ({ ok: true }), answer: async () => { throw new Error('boom'); } });
  const i = interaction('ask', 'x');
  await d.listeners(Events.InteractionCreate)[0](i);
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit']);
  assert.match(i.calls[1][1].content, /出了點問題/);
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
  const d = setup({ admit: () => ({ ok: true }), answer: async (r) => ((seen = r), { ok: true, parts: ['a', 'b'] }) });
  const m = message('<@999> 肥肥頭哪裡打?');
  await d.listeners(Events.MessageCreate)[0](m);
  assert.equal(seen.text, '肥肥頭哪裡打?');
  assert.equal(m.calls[0][0], 'reply');
  assert.deepEqual(m.calls[0][1].allowedMentions, { repliedUser: false });
  assert.deepEqual(m.calls[1][1].allowedMentions, { parse: [] });
});

test('mention: ignores bots and messages that do not mention the bot; gate failures reply politely', async () => {
  const d = setup({ admit: () => ({ ok: false, message: '今天用完了' }), answer: async () => assert.fail('no') });
  const handler = d.listeners(Events.MessageCreate)[0];
  const bot = message('<@999> hi', { bot: true });
  const other = message('hello', { mentions: false });
  await handler(bot);
  await handler(other);
  assert.deepEqual([bot.calls, other.calls], [[], []]);
  const m = message('<@999> hi');
  await handler(m);
  assert.equal(m.calls[0][1].content, '今天用完了');
});
