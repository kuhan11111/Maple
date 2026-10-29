import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, normalizeDomain, DEFAULT_SOURCES } from '../src/config.js';
import { stripPings, splitMessage, sourcesFooter, render, DISCORD_LIMIT } from '../src/format.js';
import { RateLimiter, Semaphore } from '../src/limits.js';
import { Memory } from '../src/memory.js';
import { buildSystem, KINDS } from '../src/prompt.js';
import { buildCommands, TEXT_OPTION } from '../src/commands.js';

test('config: defaults, overrides and validation', () => {
  const base = { DISCORD_TOKEN: 't', DISCORD_APP_ID: 'a' };
  const c = loadConfig(base);
  assert.deepEqual(c.sources, DEFAULT_SOURCES);
  assert.equal(c.model, 'claude-sonnet-5-5');
  assert.equal(c.maxSearches, 3);
  assert.equal(c.ai, false, 'no API key = AI features off, everything else works');
  assert.equal(c.musicEnabled, true);
  assert.deepEqual(c.radio, []);
  assert.match(c.dbPath, /data[\\/]db\.json$/);
  assert.equal(loadConfig({ ...base, ANTHROPIC_API_KEY: 'k' }).ai, true);
  assert.equal(loadConfig({ ...base, ENABLE_MUSIC: '0' }).musicEnabled, false);
  assert.equal(loadConfig({ ...base, DATA_DIR: '/x' }).dbPath, '/x/db.json');
  const d = loadConfig({ ...base, ARTALE_SOURCES: 'https://Example.com/, foo.bar/wiki', MAX_SEARCHES: '5', ALLOWED_CHANNEL_IDS: '1, 2', RADIO_STREAMS: '電台=https://a.example/s' });
  assert.deepEqual(d.sources, ['example.com', 'foo.bar/wiki']);
  assert.equal(d.maxSearches, 5);
  assert.deepEqual(d.allowedChannels, ['1', '2']);
  assert.equal(d.radio[0].title, '電台');
  assert.throws(() => loadConfig({ DISCORD_APP_ID: 'a' }), /DISCORD_TOKEN/);
  assert.throws(() => normalizeDomain('not a domain'), /網域格式/);
  assert.throws(() => loadConfig({ ...base, MAX_SEARCHES: 'lots' }), /MAX_SEARCHES/);
  assert.throws(() => loadConfig({ ...base, RADIO_STREAMS: 'broken' }), /RADIO_STREAMS/);
});

test('format: mentions are defanged', () => {
  const out = stripPings('hi @everyone and @here <@123> <@&456> <#789>');
  assert.ok(!/@everyone|@here/.test(out));
  assert.ok(!/<@\d|<@&\d|<#\d/.test(out));
});

test('format: long text splits under the limit without losing content', () => {
  const para = (n) => `段落${n}:` + '字'.repeat(700);
  const text = [1, 2, 3, 4, 5].map(para).join('\n\n');
  const parts = splitMessage(text);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= DISCORD_LIMIT, `part is ${p.length} long`);
  assert.equal(parts.join('\n\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  assert.deepEqual(splitMessage('short'), ['short']);
  const unbroken = splitMessage('a'.repeat(5000));
  assert.ok(unbroken.every((p) => p.length <= DISCORD_LIMIT) && unbroken.join('').length === 5000);
});

test('format: sources are safe, tidy links', () => {
  const f = sourcesFooter([
    { url: 'https://artalemaplestory.com/mob/1', title: '肥肥頭 [掉落]\n表' },
    { url: 'javascript:alert(1)', title: 'evil' },
    { url: 'https://dcard.tw/p/1', title: null },
  ]);
  assert.match(f, /\[肥肥頭 掉落 表\]\(<https:\/\/artalemaplestory\.com\/mob\/1>\)/);
  assert.ok(!f.includes('javascript'));
  assert.match(f, /\[dcard\.tw\]/);
  assert.equal(sourcesFooter([]), '');
  assert.equal(sourcesFooter(Array.from({ length: 9 }, (_, i) => ({ url: `https://a.com/${i}`, title: 't' }))).split('\n• ').length - 1, 5);
  const parts = render({ text: 'ping @everyone', sources: [{ url: 'https://a.com', title: 'A' }] });
  assert.ok(!parts[0].includes('@everyone') && parts[0].includes('來源'));
});

test('rate limiter: window, day, and recovery', () => {
  let now = 0;
  const rl = new RateLimiter({ perWindow: 2, windowMs: 1000, perDay: 3, now: () => now });
  assert.ok(rl.take('u').ok && rl.take('u').ok);
  const blocked = rl.take('u');
  assert.deepEqual([blocked.ok, blocked.reason], [false, 'window']);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000);
  assert.ok(rl.take('other').ok, 'other users are unaffected');
  now = 1500;
  assert.ok(rl.take('u').ok);
  now = 3000;
  const day = rl.take('u');
  assert.deepEqual([day.ok, day.reason], [false, 'day']);
  now = 25 * 3600 * 1000;
  assert.ok(rl.take('u').ok);
});

test('semaphore caps parallel work and releases on errors', async () => {
  const sem = new Semaphore(2);
  let running = 0;
  let peak = 0;
  const job = async (fail) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 10));
    running--;
    if (fail) throw new Error('x');
  };
  const results = await Promise.allSettled([job(), job(true), job(), job(), job(true)].map((p) => sem.run(() => p)));
  assert.equal(results.length, 5);
  const sem2 = new Semaphore(1);
  let live = 0, max = 0;
  await Promise.allSettled(Array.from({ length: 5 }, (_, i) => sem2.run(async () => { live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 5)); live--; if (i % 2) throw new Error('boom'); })));
  assert.equal(max, 1);
  assert.equal(sem2.free, 1);
});

test('memory: alternating roles, trimmed, expires', () => {
  let now = 0;
  const m = new Memory({ ttlMs: 1000, maxTurns: 2, now: () => now });
  assert.deepEqual(m.get('k'), []);
  m.add('k', 'q1', 'a1');
  m.add('k', 'q2', 'a2');
  m.add('k', 'q3', 'a3');
  assert.deepEqual(m.get('k').map((x) => x.content), ['q2', 'a2', 'q3', 'a3']);
  assert.deepEqual(m.get('k').map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
  now = 2000;
  assert.deepEqual(m.get('k'), []);
});

test('prompt: system mentions sources and date; kinds shape the question', () => {
  const s = buildSystem({ sources: ['a.com', 'b.com'], dbDomains: ['a.com'], today: '2026-10-29' });
  assert.match(s, /a\.com、b\.com/);
  assert.match(s, /2026-10-29/);
  assert.match(s, /不要編造/);
  assert.match(KINDS.drop('肥肥頭'), /肥肥頭/);
  assert.match(KINDS.guide('轉職'), /攻略/);
  assert.equal(KINDS.ask('hello'), 'hello');
});

test('slash commands are valid for Discord and depend on the configuration', () => {
  const names = (cfg) => buildCommands(cfg).map((c) => c.name);
  assert.deepEqual(names({ ai: false, musicEnabled: false }).filter((n) => ['ask', 'sources', 'music'].includes(n)), []);
  assert.ok(names({ ai: false, musicEnabled: true }).includes('music'));
  assert.ok(['ask', 'sources'].every((n) => names({ ai: true }).includes(n)));
  assert.ok(['help', 'drop', 'map', 'guide', 'roll', 'pick', 'scroll', 'rps', 'guess', 'quiz', 'rank'].every((n) => names({}).includes(n)));
  const all = buildCommands({ ai: true, musicEnabled: true });
  assert.equal(new Set(all.map((c) => c.name)).size, all.length, 'no duplicate names');
  assert.ok(all.length <= 100);
  const check = (o) => {
    assert.match(o.name, /^[\p{Ll}\p{N}_-]{1,32}$/u, o.name);
    assert.ok(o.description.length >= 1 && o.description.length <= 100, `${o.name}: description length`);
    for (const ch of o.choices ?? []) assert.ok(String(ch.name).length <= 100);
    (o.options ?? []).forEach(check);
  };
  all.forEach(check);
  // required options come before optional ones (Discord rejects the reverse)
  for (const c of all) {
    const opts = c.options ?? [];
    const firstOptional = opts.findIndex((o) => o.required === false);
    if (firstOptional >= 0) assert.ok(opts.slice(firstOptional).every((o) => o.required === false), `${c.name}: required option after optional`);
  }
  for (const [cmd, opt] of Object.entries(TEXT_OPTION)) {
    assert.ok(all.find((c) => c.name === cmd).options.some((o) => o.name === opt), `${cmd}.${opt}`);
  }
});
