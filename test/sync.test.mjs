import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLog, cleanEntry, keyOf } from '../js/merge.js';
import { Session, PeerTransport, cleanStatus, cleanSnapshot, encodeShare, decodeShare } from '../js/sync.js';
import { mulberry32 } from '../js/sim.js';

const E = (player, level, col, type, t) => ({ player, level, col, type, t, source: 'manual' });
let id = 0;
const next = () => ++id;
const view = (st) => st.log.map((e) => `${keyOf(e)}=${e.type}@${e.t}`).sort().join(' ') + ' | ' + JSON.stringify(Object.entries(st.tomb).sort());

test('cleanEntry rejects malformed or out-of-range entries', () => {
  assert.ok(cleanEntry(E(0, 1, 0, 'ok', 5)));
  for (const bad of [null, 'x', E(4, 1, 0, 'ok', 5), E(0, 0, 0, 'ok', 5), E(0, 11, 0, 'ok', 5), E(0, 1, 4, 'ok', 5), E(0, 1, 0, 'maybe', 5), E(0, 1.5, 0, 'ok', 5), { ...E(0, 1, 0, 'ok', 5), t: 'now' }]) {
    assert.equal(cleanEntry(bad), null, JSON.stringify(bad));
  }
});

test('newest write wins; a late older copy changes nothing', () => {
  let st = { log: [], tomb: {} };
  st = mergeLog(st, { entries: [E(0, 1, 2, 'bad', 10)] }, next);
  st = mergeLog(st, { entries: [E(0, 1, 2, 'ok', 20)] }, next);
  assert.deepEqual(st.log.map((e) => e.type), ['ok']);
  const late = mergeLog(st, { entries: [E(0, 1, 2, 'bad', 10)] }, next);
  assert.equal(late.changed, false);
});

test('a tombstone beats older entries and blocks late arrivals, but not newer ones', () => {
  let st = mergeLog({ log: [], tomb: {} }, { entries: [E(1, 2, 3, 'bad', 10)] }, next);
  st = mergeLog(st, { tombs: { '1:2:3': 15 } }, next);
  assert.equal(st.log.length, 0);
  assert.equal(mergeLog(st, { entries: [E(1, 2, 3, 'bad', 10)] }, next).log.length, 0);
  assert.equal(mergeLog(st, { entries: [E(1, 2, 3, 'ok', 16)] }, next).log.length, 1);
});

test('four devices applying the same messages in different orders converge', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rnd = mulberry32(seed);
    const msgs = [];
    for (let i = 0; i < 40; i++) {
      const p = Math.floor(rnd() * 4), L = 1 + Math.floor(rnd() * 3), c = Math.floor(rnd() * 4), t = 1 + Math.floor(rnd() * 30);
      msgs.push(rnd() < 0.7 ? { entries: [E(p, L, c, rnd() < 0.5 ? 'ok' : 'bad', t)] } : { tombs: { [`${p}:${L}:${c}`]: t } });
    }
    const results = [0, 1, 2, 3].map(() => {
      const order = msgs.slice().sort(() => rnd() - 0.5);
      let st = { log: [], tomb: {} };
      for (const m of order) st = mergeLog(st, m, next);
      for (const m of order.slice(0, 10)) st = mergeLog(st, m, next); // duplicates are harmless
      return view(st);
    });
    assert.ok(results.every((r) => r === results[0]), `seed ${seed} diverged:\n${results.join('\n')}`);
  }
});

test('status and snapshot validation', () => {
  assert.deepEqual(cleanStatus({ slot: 1, level: 3, col: 2, attempt: { level: 4, col: 0 }, intent: null, name: 'abcdefghijklmnopqrstuvwxyz' }), {
    slot: 1, level: 3, col: 2, attempt: { level: 4, col: 0 }, intent: null, name: 'abcdefghijkl',
  });
  assert.equal(cleanStatus({ slot: 9, level: 3 }), null);
  assert.equal(cleanStatus({ slot: 1, level: 99 }), null);
  const snap = cleanSnapshot({ runId: 'r', runTs: 1, entries: [E(0, 1, 1, 'ok', 1), { junk: 1 }], tombs: { '0:1:1': 5, '<script>': 1, '9:9:9': 2 } });
  assert.equal(snap.entries.length, 1);
  assert.deepEqual(snap.tombs, { '0:1:1': 5 });
  assert.equal(cleanSnapshot({ runId: 3 }), null);
});

test('share codes round-trip and reject garbage', () => {
  const snap = { runId: 'abc', runTs: 5, entries: [E(2, 4, 1, 'bad', 99)], tombs: {} };
  const st = { slot: 2, level: 3, col: 0, attempt: null, intent: { level: 4, col: 2 }, name: '小明' };
  const d = decodeShare(`hey team: ${encodeShare(snap, st)} thanks`);
  assert.equal(d.snap.entries[0].col, 1);
  assert.equal(d.status.name, '小明');
  assert.equal(decodeShare('RJ1.@@@'), null);
  assert.equal(decodeShare('hello'), null);
});

// an in-memory stand-in for the transports
class Hub {
  constructor() { this.ends = []; }
  end(slot) {
    const hub = this;
    const t = { slot, onmessage: null, onpeer: null, send(m) { for (const o of hub.ends) if (o !== t) queueMicrotask(() => o.onmessage?.(JSON.parse(JSON.stringify(m)))); }, close() {} };
    this.ends.push(t);
    return t;
  }
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('sessions: facts flow, own echoes and junk are ignored, hello brings late joiners up to date', async () => {
  const hub = new Hub();
  const got = { a: [], b: [] };
  const mk = (slot, snap, sink) => new Session(hub.end(slot), { slot, snapshot: () => snap, hooks: { onFact: (e) => sink.push(['fact', e.player]), onSnapshot: (s) => sink.push(['snap', s.entries.length]), onStatus: (s) => sink.push(['status', s.slot]) } });
  const a = mk(0, { runId: 'r', runTs: 1, entries: [E(0, 1, 1, 'ok', 1)], tombs: {} }, got.a);
  const b = mk(1, { runId: 'r', runTs: 1, entries: [], tombs: {} }, got.b);
  a.sendFact(E(0, 2, 2, 'bad', 2));
  a.sendStatus({ slot: 0, level: 1, col: 1, attempt: null, intent: null, name: 'A' });
  b.transport.onmessage({ t: 'fact', slot: 2, e: { player: 99 } }); // junk
  b.transport.onmessage({ t: 'status', slot: 2, s: { slot: 3, level: 1 } }); // slot mismatch
  await tick();
  assert.deepEqual(got.b, [['fact', 0], ['status', 0]]);
  assert.deepEqual(got.a, []);
  b.hello(true); // late joiner announces itself: A replies with its snapshot
  await tick();
  assert.ok(got.a.some((x) => x[0] === 'snap'));
  assert.ok(got.b.some((x) => x[0] === 'snap' && x[1] === 1));
});

// minimal PeerJS look-alike
function fakePeerLib() {
  const registry = new Map();
  class Conn {
    constructor(peer, other) { this.peer = peer; this.other = other; this.h = {}; this.open = false; }
    on(ev, f) { (this.h[ev] ||= []).push(f); }
    emit(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)); }
    send(d) { const o = this.twin; queueMicrotask(() => o.emit('data', JSON.parse(JSON.stringify(d)))); }
    close() { if (!this.open) return; this.open = this.twin.open = false; this.emit('close'); this.twin.emit('close'); }
  }
  class Peer {
    constructor(id) {
      this.id = id; this.h = {};
      setTimeout(() => {
        if (registry.has(id)) this.emit('error', { type: 'unavailable-id' });
        else { registry.set(id, this); this.emit('open', id); }
      }, 1);
    }
    on(ev, f) { (this.h[ev] ||= []).push(f); }
    emit(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)); }
    connect(otherId) {
      const mine = new Conn(otherId, this.id);
      const target = registry.get(otherId);
      if (!target) { setTimeout(() => this.emit('error', { type: 'peer-unavailable' }), 1); return mine; }
      const theirs = new Conn(this.id, otherId);
      mine.twin = theirs; theirs.twin = mine;
      setTimeout(() => { target.emit('connection', theirs); mine.open = theirs.open = true; mine.emit('open'); theirs.emit('open'); }, 1);
      return mine;
    }
    destroy() { registry.delete(this.id); }
  }
  return Peer;
}

test('PeerTransport: seats find each other with no host, one link per pair, messages broadcast', async () => {
  const Peer = fakePeerLib();
  const ts = [0, 1, 2].map((slot) => new PeerTransport('room1', slot, Peer));
  const got = ts.map(() => []);
  const online = ts.map(() => new Set());
  ts.forEach((t, i) => {
    t.onmessage = (m, from) => got[i].push([m.n, from]);
    t.onpeer = (s, on) => (on ? online[i].add(s) : online[i].delete(s));
  });
  for (const t of ts) await t.open(); // seat 0 first: nobody to dial yet
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([...online[0]].sort(), [1, 2]);
  assert.deepEqual([...online[1]].sort(), [0, 2]);
  assert.deepEqual([...online[2]].sort(), [0, 1]);
  ts[1].send({ n: 'hi' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got[0], [['hi', 1]]);
  assert.deepEqual(got[2], [['hi', 1]]);
  assert.deepEqual(got[1], []);
  // a dropped link is noticed
  ts[2].peer.destroy();
  ts[0].conns.get(2).close();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!online[0].has(2));
  ts.forEach((t) => t.close());
});

test('PeerTransport: the same seat in the same room is refused', async () => {
  const Peer = fakePeerLib();
  const a = new PeerTransport('room2', 1, Peer);
  await a.open();
  const b = new PeerTransport('room2', 1, Peer);
  await assert.rejects(b.open(), /座位 2/);
  a.close();
});
