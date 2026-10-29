import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers, friendly } from '../src/handlers.js';
import { RateLimiter, Semaphore } from '../src/limits.js';
import { Memory } from '../src/memory.js';
import { EmptyAnswerError } from '../src/agent.js';
import { fakeClient, text, cite, reply, baseConfig } from './helpers.mjs';

const make = (client, over = {}, cfg = {}) => {
  const logs = [];
  const h = createHandlers({
    config: { ...baseConfig, ...cfg },
    client,
    limiter: over.limiter ?? new RateLimiter({ perWindow: 5, perDay: 50 }),
    semaphore: new Semaphore(2),
    memory: over.memory ?? new Memory(),
    log: (e, d) => logs.push([e, d]),
  });
  return { h, logs };
};
const good = (t = '答案', url = 'https://artalemaplestory.com/m/1') => reply([text(t, [cite(url, '資料庫')])]);
const req = (o = {}) => ({ userId: 'u1', channelId: 'c1', kind: 'ask', text: '肥肥頭哪裡打?', ...o });

test('admit: empty, too long, wrong channel', () => {
  const { h } = make(fakeClient(), {}, { allowedChannels: ['ok'] });
  assert.equal(h.admit(req({ channelId: 'nope' })).ok, false);
  assert.match(h.admit(req({ channelId: 'nope' })).message, /沒有開放/);
  assert.equal(h.admit(req({ channelId: 'ok', text: '   ' })).ok, false);
  assert.match(h.admit(req({ channelId: 'ok', text: 'x'.repeat(301) })).message, /太長/);
  assert.equal(h.admit(req({ channelId: 'ok' })).ok, true);
});

test('admit: counts each request once and reports when to retry', () => {
  const { h } = make(fakeClient(), { limiter: new RateLimiter({ perWindow: 2, perDay: 10 }) });
  assert.ok(h.admit(req()).ok && h.admit(req()).ok);
  const third = h.admit(req());
  assert.equal(third.ok, false);
  assert.match(third.message, /分鐘後/);
  assert.ok(h.admit(req({ userId: 'u2' })).ok);
});

test('answer: renders text with sources, logs usage but not the question', async () => {
  const { h, logs } = make(fakeClient(good('肥肥頭掉落楓葉。')));
  const r = await h.answer(req());
  assert.equal(r.ok, true);
  assert.match(r.parts[0], /肥肥頭掉落楓葉。/);
  assert.match(r.parts[0], /來源/);
  assert.match(r.parts[0], /artalemaplestory\.com\/m\/1/);
  const [event, data] = logs[0];
  assert.equal(event, 'ask');
  assert.deepEqual([data.searches, data.input, data.output], [1, 100, 50]);
  assert.ok(!JSON.stringify(logs).includes('肥肥頭哪裡打'), 'question text stays out of the logs');
});

test('answer: slash kinds change the question; follow-ups carry earlier turns', async () => {
  const client = fakeClient(good('第一個答案'), good('第二個答案'));
  const { h } = make(client);
  await h.answer(req({ kind: 'drop', text: '肥肥頭' }));
  assert.match(client.calls[0].params.messages.at(-1).content, /掉落 \/ 出沒/);
  await h.answer(req({ text: '那它在哪裡掉?' }));
  const msgs = client.calls[1].params.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(msgs[1].content, '第一個答案');
  assert.equal(msgs[2].content, '那它在哪裡掉?');
});

test('answer: memory is per user and channel', async () => {
  const client = fakeClient(good('A'), good('B'));
  const { h } = make(client);
  await h.answer(req());
  await h.answer(req({ userId: 'u2' }));
  assert.equal(client.calls[1].params.messages.length, 1);
});

test('answer: a very long reply becomes several messages, none over the limit', async () => {
  const long = Array.from({ length: 6 }, (_, i) => `第${i}段` + '長'.repeat(600)).join('\n\n');
  const { h } = make(fakeClient(good(long)));
  const r = await h.answer(req());
  assert.ok(r.parts.length > 1);
  assert.ok(r.parts.every((p) => p.length <= 2000));
});

test('errors become friendly messages and never leak details', async () => {
  for (const [err, re] of [
    [Object.assign(new Error('bad key sk-secret'), { status: 401 }), /API 金鑰/],
    [Object.assign(new Error('slow down'), { status: 429 }), /人太多/],
    [Object.assign(new Error('web_search is not enabled'), { status: 400 }), /web search/],
    [Object.assign(new Error('t'), { name: 'APIConnectionTimeoutError' }), /逾時/],
    [new Error('socket hang up'), /出了點問題/],
    [new EmptyAnswerError('empty'), /換個關鍵字/],
    [new EmptyAnswerError('refusal'), /沒辦法回答/],
  ]) {
    const { h, logs } = make(fakeClient(err));
    const r = await h.answer(req());
    assert.equal(r.ok, false);
    assert.match(r.message, re);
    assert.ok(!r.message.includes('sk-secret'));
    assert.equal(logs[0][0], 'error');
  }
  assert.match(friendly(new Error('x')), /稍後/);
});

test('failed lookups are not remembered', async () => {
  const client = fakeClient(new Error('boom'), good('ok'));
  const { h } = make(client);
  await h.answer(req());
  await h.answer(req());
  assert.equal(client.calls[1].params.messages.length, 1);
});
