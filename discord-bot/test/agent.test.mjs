import test from 'node:test';
import assert from 'node:assert/strict';
import { ask, buildTools, answerBlocks, collectSources, EmptyAnswerError } from '../src/agent.js';
import { fakeClient, text, search, fetched, toolUse, cite, reply } from './helpers.mjs';

const tools = buildTools({ sources: ['artalemaplestory.com'], maxSearches: 3, maxFetches: 2, maxContentTokens: 9000 });
const run = (client, extra = {}) => ask({ client, model: 'm', system: 'sys', tools, messages: [{ role: 'user', content: 'q' }], ...extra });

test('tools are limited to the allowed sites and capped', () => {
  assert.deepEqual(tools.map((t) => t.name), ['web_search', 'web_fetch']);
  for (const t of tools) assert.deepEqual(t.allowed_domains, ['artalemaplestory.com']);
  assert.equal(tools[0].max_uses, 3);
  assert.equal(tools[1].max_uses, 2);
  assert.equal(tools[1].max_content_tokens, 9000);
});

test('the answer is the text after the last tool result, not the "let me search" preamble', () => {
  const content = [text('我來查查看。'), toolUse('web_search'), search(['https://a.com', 'A']), text('肥肥頭掉落楓葉。')];
  assert.deepEqual(answerBlocks(content).map((b) => b.text), ['肥肥頭掉落楓葉。']);
  assert.deepEqual(answerBlocks([text('直接回答')]).map((b) => b.text), ['直接回答']);
  assert.deepEqual(answerBlocks([text('只有前言'), search(['https://a.com', 'A'])]).map((b) => b.text), ['只有前言']);
});

test('sources: cited first, then fetched, deduped; search hits only as a fallback', () => {
  const answer = [text('x', [cite('https://c.com/1', 'Cited'), cite('https://c.com/1', 'Cited again')])];
  const resp = [{ content: [search(['https://s.com/1', 'S1'], ['https://s.com/2', 'S2']), fetched('https://f.com/1', 'Fetched'), fetched('https://c.com/1', 'dup')] }];
  assert.deepEqual(collectSources(resp, answer).map((s) => s.url), ['https://c.com/1', 'https://f.com/1']);
  assert.deepEqual(collectSources([{ content: [search(['https://s.com/1', 'S1'], ['https://s.com/2', 'S2'])] }], [text('x')]).map((s) => s.url), ['https://s.com/1', 'https://s.com/2']);
  assert.deepEqual(collectSources([{ content: [] }], [text('x')]), []);
});

test('ask: sends system/tools/limits and returns text, sources and summed usage', async () => {
  const client = fakeClient(reply([text('先查'), toolUse('web_search'), search(['https://artalemaplestory.com/m/1', '肥肥頭']), text('肥肥頭掉落楓葉。', [cite('https://artalemaplestory.com/m/1', '肥肥頭 - 資料庫')])]));
  const r = await run(client, { maxTokens: 777, timeoutMs: 1234 });
  assert.equal(r.text, '肥肥頭掉落楓葉。');
  assert.deepEqual(r.sources, [{ url: 'https://artalemaplestory.com/m/1', title: '肥肥頭 - 資料庫' }]);
  assert.deepEqual(r.usage, { input: 100, output: 50, searches: 1, fetches: 0 });
  const { params, opts } = client.calls[0];
  assert.equal(params.model, 'm');
  assert.equal(params.max_tokens, 777);
  assert.equal(params.system, 'sys');
  assert.equal(params.tools, tools);
  assert.equal(opts.timeout, 1234);
});

test('ask: pause_turn is resumed by sending the partial assistant turn back', async () => {
  const partial = [text('查詢中'), toolUse('web_search')];
  const client = fakeClient(reply(partial, { stop_reason: 'pause_turn' }), reply([search(['https://a.com', 'A']), text('最終答案')]));
  const r = await run(client);
  assert.equal(r.text, '最終答案');
  assert.equal(r.rounds, 2);
  assert.equal(client.calls.length, 2);
  const second = client.calls[1].params.messages;
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant']);
  assert.equal(second[1].content, partial);
  assert.equal(r.usage.input, 200);
});

test('ask: gives up resuming after the limit instead of looping forever', async () => {
  const stuck = () => reply([toolUse('web_search')], { stop_reason: 'pause_turn' });
  const client = fakeClient(stuck(), stuck(), stuck());
  await assert.rejects(run(client, { maxContinuations: 2 }), EmptyAnswerError);
  assert.equal(client.calls.length, 3);
});

test('ask: empty, refused and truncated answers', async () => {
  await assert.rejects(run(fakeClient(reply([toolUse('web_search')]))), (e) => e instanceof EmptyAnswerError && e.message === 'empty');
  await assert.rejects(run(fakeClient(reply([], { stop_reason: 'refusal' }))), (e) => e instanceof EmptyAnswerError && e.message === 'refusal');
  const cut = await run(fakeClient(reply([text('很長的答案')], { stop_reason: 'max_tokens' })));
  assert.match(cut.text, /被截斷/);
});

test('ask: API errors propagate for the handler to translate', async () => {
  const err = Object.assign(new Error('rate'), { status: 429 });
  await assert.rejects(run(fakeClient(err)), (e) => e.status === 429);
});
