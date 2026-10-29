import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library, scanLibrary, parseRadio } from '../src/music/library.js';
import { GuildPlayer, MusicManager, MAX_QUEUE } from '../src/music/player.js';
import { music, musicAutocomplete } from '../src/music/commands.js';
import { fakeInteraction as fi } from './helpers-discord.mjs';

const track = (title, extra = {}) => ({ id: `f:${title}`, kind: 'file', title, file: `/m/${title}.mp3`, folder: '', ...extra });

function fakeAdapter() {
  const a = { log: [], play: (t, v) => a.log.push(['play', t.title, v]), stop: () => a.log.push(['stop']), pause: () => a.log.push(['pause']), resume: () => a.log.push(['resume']), setVolume: (v) => a.log.push(['vol', v]), destroy: () => a.log.push(['destroy']) };
  return a;
}
const mkPlayer = (over = {}) => {
  const adapter = fakeAdapter();
  const events = [];
  const timers = [];
  const p = new GuildPlayer({ adapter, onEvent: (e) => events.push(e), setTimeout: (fn) => (timers.push(fn), timers.length), clearTimeout: () => {}, ...over });
  return { p, adapter, events, timers };
};

test('library: scans audio files (nested, no dotfiles, no other types), unique stable ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'music-'));
  mkdirSync(join(dir, 'maple/ost'), { recursive: true });
  writeFileSync(join(dir, 'a.mp3'), '');
  writeFileSync(join(dir, 'B.FLAC'), '');
  writeFileSync(join(dir, 'notes.txt'), '');
  writeFileSync(join(dir, '.hidden.mp3'), '');
  writeFileSync(join(dir, 'maple/ost/Henesys.ogg'), '');
  const t = scanLibrary(dir);
  assert.deepEqual(t.map((x) => x.title).sort(), ['B', 'Henesys', 'a']);
  assert.equal(new Set(t.map((x) => x.id)).size, 3);
  assert.equal(t.find((x) => x.title === 'Henesys').folder, 'maple/ost');
  assert.deepEqual(scanLibrary(join(dir, 'missing')), []);
  assert.deepEqual(scanLibrary(dir).map((x) => x.id), t.map((x) => x.id), 'ids are stable between scans');
});

test('library: find by id or fuzzy name; radio parsing validates', () => {
  const lib = new Library({ dir: 'x', scan: () => [track('Henesys'), track('Ellinia'), track('Perion Rocky')], radio: parseRadio('電台一=https://a.example/live,電台二=http://b.example/s') });
  assert.equal(lib.find('henesys').title, 'Henesys');
  assert.equal(lib.find('f:Ellinia').title, 'Ellinia');
  assert.equal(lib.find('perion').title, 'Perion Rocky');
  assert.equal(lib.find('Henesis').title, 'Henesys', 'a typo still finds it');
  assert.equal(lib.find('zzzzzz'), null);
  assert.deepEqual(lib.search('e').map((t) => t.title).includes('Ellinia'), true);
  assert.equal(lib.findRadio('電台二').url, 'http://b.example/s');
  assert.deepEqual(parseRadio(''), []);
  for (const bad of ['無等號', 'x=ftp://a.b/c', '=https://a.b', 'x=javascript:alert(1)', 'x=file:///etc/passwd']) assert.throws(() => parseRadio(bad), /RADIO_STREAMS/, bad);
});

test('library rescans at most once per ttl', () => {
  let now = 0;
  let scans = 0;
  const lib = new Library({ dir: 'x', ttlMs: 1000, now: () => now, scan: () => (scans++, [track('a')]) });
  lib.search('a');
  lib.search('a');
  now = 1500;
  lib.search('a');
  assert.equal(scans, 2);
  lib.refresh(true);
  assert.equal(scans, 3);
});

test('player: first add plays, later adds queue, end advances', () => {
  const { p, adapter, events } = mkPlayer();
  assert.equal(p.add(track('a')), 0);
  assert.equal(p.add(track('b')), 1);
  assert.equal(p.add(track('c')), 2);
  assert.deepEqual(adapter.log, [['play', 'a', 0.5]]);
  p.ended();
  assert.deepEqual(adapter.log.at(-1), ['play', 'b', 0.5]);
  assert.deepEqual(events.at(-1), { type: 'playing', track: track('b'), auto: true });
  p.ended();
  p.ended();
  assert.equal(p.current, null);
  assert.equal(events.at(-1).type, 'idle');
});

test('player: skip, pause/resume, volume, loop modes', () => {
  const { p, adapter } = mkPlayer();
  p.add(track('a'));
  p.add(track('b'));
  assert.equal(p.pause(), true);
  assert.equal(p.pause(), false);
  assert.equal(p.resume(), true);
  assert.equal(p.resume(), false);
  p.setVolume(250);
  assert.equal(p.volume, 100);
  p.setVolume(0);
  assert.equal(p.volume, 1);
  assert.equal(p.skip(), true);
  assert.equal(p.current.title, 'b');

  p.setLoop('one');
  p.ended();
  assert.equal(p.current.title, 'b', 'single loop repeats');
  assert.equal(p.skip(), true);
  assert.equal(p.current, null, 'skip leaves a single loop');

  const q = mkPlayer();
  q.p.setLoop('all');
  q.p.add(track('x'));
  q.p.add(track('y'));
  q.p.ended();
  assert.equal(q.p.current.title, 'y');
  q.p.ended();
  assert.equal(q.p.current.title, 'x', 'queue loops');
  q.p.skip();
  assert.equal(q.p.current.title, 'y');
  q.p.skip();
  assert.equal(q.p.current.title, 'x', 'skipping keeps the track in rotation when looping all');
  assert.ok(adapter.log.some((l) => l[0] === 'pause'));
});

test('player: a failing track is skipped, never retried, even in a loop', () => {
  const { p, events } = mkPlayer();
  p.setLoop('one');
  p.add(track('bad'));
  p.add(track('good'));
  p.ended(new Error('decode failed'));
  assert.equal(p.current.title, 'good');
  assert.equal(events.find((e) => e.type === 'error').track.title, 'bad');
  const throwing = mkPlayer();
  throwing.adapter.play = (t) => {
    if (t.title === 'x') throw new Error('boom');
  };
  throwing.p.add(track('x'));
  throwing.p.add(track('y'));
  assert.equal(throwing.p.current.title, 'y');
});

test('player: leaves after idling, and on close; queue is capped', () => {
  const { p, adapter, timers } = mkPlayer();
  let closed = 0;
  p.onClose = () => closed++;
  p.add(track('a'));
  p.ended();
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(adapter.log.at(-1), ['destroy']);
  assert.equal(closed, 1);
  p.close();
  assert.equal(closed, 1);
  p.ended();
  assert.equal(adapter.log.filter((l) => l[0] === 'play').length, 1, 'closed players ignore late callbacks');
  const full = mkPlayer();
  for (let k = 0; k < MAX_QUEUE + 1; k++) assert.ok(full.p.add(track(`t${k}`)) >= 0, 'one playing + MAX_QUEUE waiting');
  assert.equal(full.p.add(track('one too many')), -1);
});

test('manager: one player per server; adapter callbacks reach it; closing frees the slot', async () => {
  let made = 0;
  let hooks;
  const adapter = fakeAdapter();
  const m = new MusicManager({ createAdapter: async (vc, h) => (made++, (hooks = h), adapter), setTimeout: () => 1, clearTimeout: () => {} });
  const a = await m.ensure('g', { id: 'vc1' });
  const b = await m.ensure('g', { id: 'vc1' });
  assert.equal(a, b);
  assert.equal(made, 1);
  assert.equal(a.channelId, 'vc1');
  a.add(track('a'));
  a.add(track('b'));
  hooks.onEnd();
  assert.equal(a.current.title, 'b');
  hooks.onDisconnect();
  assert.equal(m.get('g'), null);
  assert.ok(adapter.log.some((l) => l[0] === 'destroy'));
  await assert.rejects(new MusicManager({ createAdapter: async () => { throw new Error('連不上'); } }).ensure('g2', { id: 'x' }), /連不上/);
});

// ---- commands ------------------------------------------------------------------------

function setup({ inVoice = true, perms = true, botIn = null } = {}) {
  const adapter = fakeAdapter();
  const manager = new MusicManager({ createAdapter: async () => adapter, setTimeout: () => 1, clearTimeout: () => {} });
  const library = new Library({ dir: 'x', scan: () => [track('Henesys'), track('Ellinia', { folder: 'ost' })], radio: parseRadio('電台一=https://a.example/live') });
  const vc = { id: 'vc1', name: '大廳', guild: { members: { me: {} } }, permissionsFor: () => ({ has: () => perms }) };
  const member = { voice: { channel: inVoice ? vc : null } };
  return { ctx: { library, manager }, adapter, manager, member, vc };
}

test('/music play: needs a voice channel and permissions, then plays and queues', async () => {
  const s = setup({ inVoice: false });
  let i = fi({ sub: 'play', strings: { song: 'henesys' }, member: s.member });
  await music(i, s.ctx);
  assert.match(i.last().content, /先加入/);
  assert.equal(i.last().flags, 64);

  const noPerm = setup({ perms: false });
  i = fi({ sub: 'play', strings: { song: 'henesys' }, member: noPerm.member });
  await music(i, noPerm.ctx);
  assert.match(i.last().content, /權限/);

  const ok = setup();
  i = fi({ sub: 'play', strings: { song: 'henesys' }, member: ok.member });
  await music(i, ok.ctx);
  assert.deepEqual(i.calls.map((c) => c[0]), ['defer', 'edit']);
  assert.match(i.last().content, /開始播放.*Henesys/);
  assert.deepEqual(ok.adapter.log[0].slice(0, 2), ['play', 'Henesys']);
  i = fi({ sub: 'play', strings: { song: 'ellinia' }, member: ok.member });
  await music(i, ok.ctx);
  assert.match(i.last().content, /已加入佇列\(第 1 首\).*Ellinia/);
  i = fi({ sub: 'play', strings: { song: 'qqqqqqqq' }, member: ok.member });
  await music(i, ok.ctx);
  assert.match(i.last().content, /找不到/);
});

test('/music: joining failure is reported, other channel is refused', async () => {
  const s = setup();
  s.ctx.manager.createAdapter = async () => { throw new Error('連不上語音頻道'); };
  const i = fi({ sub: 'play', strings: { song: 'henesys' }, member: s.member });
  await music(i, s.ctx);
  assert.match(i.last().content, /連不上語音頻道/);

  const t = setup();
  await music(fi({ sub: 'play', strings: { song: 'henesys' }, member: t.member }), t.ctx);
  const elsewhere = { voice: { channel: { ...t.vc, id: 'vc2' } } };
  const i2 = fi({ sub: 'skip', member: elsewhere });
  await music(i2, t.ctx);
  assert.match(i2.last().content, /另一個語音頻道/);
});

test('/music controls: skip, pause, resume, loop, volume, queue, now, stop', async () => {
  const s = setup();
  const run = async (sub, extra = {}) => {
    const i = fi({ sub, member: s.member, ...extra });
    await music(i, s.ctx);
    return i.last().content;
  };
  assert.match(await run('now'), /沒有在播放/);
  await run('play', { strings: { song: 'henesys' } });
  await run('play', { strings: { song: 'ellinia' } });
  assert.match(await run('now'), /Henesys/);
  assert.match(await run('queue'), /接下來:\n1\. Ellinia/);
  assert.match(await run('pause'), /已暫停/);
  assert.match(await run('now'), /暫停中/);
  assert.match(await run('resume'), /繼續/);
  assert.match(await run('loop', { strings: { mode: 'all' } }), /整個佇列循環/);
  assert.match(await run('volume', { ints: { level: 80 } }), /音量:80/);
  assert.match(await run('skip'), /已跳過/);
  assert.match(await run('now'), /Ellinia/);
  assert.match(await run('stop'), /已停止/);
  assert.equal(s.manager.get('g1'), null);
  assert.match(await run('skip'), /沒有在播放/);
});

test('/music list and radio', async () => {
  const s = setup();
  let i = fi({ sub: 'list', member: s.member });
  await music(i, s.ctx);
  assert.match(i.last().content, /2 首[\s\S]*1\. Henesys[\s\S]*電台:電台一/);
  const empty = setup();
  empty.ctx.library.scan = () => [];
  i = fi({ sub: 'list', member: empty.member });
  await music(i, empty.ctx);
  assert.match(i.last().content, /資料夾是空的/);
  i = fi({ sub: 'radio', strings: { station: '電台一' }, member: s.member });
  await music(i, s.ctx);
  assert.match(i.last().content, /📻 \*\*電台一\*\*/);
  assert.equal(s.adapter.log[0][1], '電台一');
  const none = setup();
  none.ctx.library.radio = [];
  i = fi({ sub: 'radio', strings: { station: 'x' }, member: none.member });
  await music(i, none.ctx);
  assert.match(i.last().content, /還沒有設定電台/);
});

test('titles cannot ping or break formatting; auto-advance announces in the channel', async () => {
  const s = setup();
  s.ctx.library.scan = () => [track('@everyone **boom**')];
  const i = fi({ sub: 'play', strings: { song: 'everyone' }, member: s.member });
  await music(i, s.ctx);
  assert.ok(!i.last().content.includes('@everyone'));
  assert.match(i.last().content, /\\\*\\\*boom\\\*\\\*/);

  const t = setup();
  t.ctx.library.scan = () => [track('one'), track('two')];
  const a = fi({ sub: 'play', strings: { song: 'one' }, member: t.member });
  await music(a, t.ctx);
  await music(fi({ sub: 'play', strings: { song: 'two' }, member: t.member }), t.ctx);
  t.manager.get('g1').ended(); // first track finishes by itself
  await new Promise((r) => setImmediate(r));
  assert.ok(a.calls.some((c) => c[0] === 'send' && /下一首.*two/.test(c[1].content)));
  t.manager.get('g1').ended(new Error('x'));
  await new Promise((r) => setImmediate(r));
  assert.ok(a.calls.some((c) => c[0] === 'send' && /播放失敗/.test(c[1].content)));
});

test('autocomplete suggests at most 25 tracks with short labels', async () => {
  const s = setup();
  s.ctx.library.scan = () => Array.from({ length: 40 }, (_, k) => track(`Song ${k} ${'x'.repeat(120)}`, { id: `f:${k}` }));
  const i = fi({ sub: 'play', focused: 'song', member: s.member });
  await musicAutocomplete(i, s.ctx);
  const choices = i.last();
  assert.equal(choices.length, 25);
  assert.ok(choices.every((c) => c.name.length <= 100 && c.value.length <= 100));
  const r = fi({ sub: 'radio', focused: '電台', member: s.member });
  await musicAutocomplete(r, setup().ctx);
  assert.match(r.last()[0].name, /^📻/);
});
