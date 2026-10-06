// Team sync. Each player runs their own copy (they are in separate rooms and can only see
// themselves), so results, positions and run resets are exchanged between the four copies.
//
// Transports:
//   PeerTransport      WebRTC mesh through the public PeerJS signalling server. Seats have fixed
//                      ids (rj-<room>-<seat>) so nobody needs a host or any discovery step.
//   BroadcastTransport tabs of the same browser (testing, or several game clients on one PC).
// Share codes are the no-network fallback: copy a code out, paste it into a teammate's copy.

import { cleanEntry } from './merge.js';

const MAX_NAME = 12;

// ---- message validation (everything below arrives from other people's browsers) --------

export function cleanStatus(s) {
  if (!s || typeof s !== 'object') return null;
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(s.slot, 0, 3) || !int(s.level, 0, 10)) return null;
  const col = s.col === null || int(s.col, 0, 3) ? s.col : null;
  const pair = (p) => (p && int(p.level, 1, 10) && int(p.col, 0, 3) ? { level: p.level, col: p.col } : null);
  return {
    slot: s.slot,
    level: s.level,
    col,
    attempt: pair(s.attempt),
    intent: pair(s.intent),
    name: typeof s.name === 'string' ? s.name.slice(0, MAX_NAME) : '',
  };
}

export function cleanSnapshot(s) {
  if (!s || typeof s !== 'object' || typeof s.runId !== 'string' || !Number.isFinite(s.runTs)) return null;
  const tombs = {};
  for (const [k, v] of Object.entries(s.tombs && typeof s.tombs === 'object' ? s.tombs : {})) {
    if (/^[0-3]:\d{1,2}:[0-3]$/.test(k) && Number.isFinite(v)) tombs[k] = v;
  }
  return {
    runId: s.runId.slice(0, 40),
    runTs: s.runTs,
    entries: (Array.isArray(s.entries) ? s.entries.slice(0, 400) : []).map(cleanEntry).filter(Boolean),
    tombs,
  };
}

// ---- protocol -------------------------------------------------------------------------

/**
 * Speaks the protocol over any transport. `hooks` receive already-validated data:
 *   onSnapshot(snap, from)  onFact(entry)  onDel(key, ts)  onReset({runId, runTs})
 *   onStatus(status)        onPeer(slot, online)
 * `snapshot()` supplies this device's full state when a peer says hello.
 */
export class Session {
  constructor(transport, { slot, snapshot, hooks }) {
    this.transport = transport;
    this.slot = slot;
    this.snapshot = snapshot;
    this.hooks = hooks;
    transport.onmessage = (msg, from) => this.#receive(msg, from);
    transport.onpeer = (slot2, online) => {
      hooks.onPeer?.(slot2, online);
      if (online) this.hello(true);
    };
  }

  hello(reply) {
    this.transport.send({ t: 'hello', slot: this.slot, reply, snap: this.snapshot() });
  }

  sendFact(entry) {
    this.transport.send({ t: 'fact', slot: this.slot, e: entry });
  }

  sendDel(key, ts) {
    this.transport.send({ t: 'del', slot: this.slot, key, ts });
  }

  sendReset(runId, runTs) {
    this.transport.send({ t: 'reset', slot: this.slot, runId, runTs });
  }

  sendStatus(status) {
    this.transport.send({ t: 'status', slot: this.slot, s: status });
  }

  close() {
    this.transport.close();
  }

  #receive(msg) {
    if (!msg || typeof msg !== 'object' || msg.slot === this.slot) return;
    const h = this.hooks;
    switch (msg.t) {
      case 'hello': {
        const snap = cleanSnapshot(msg.snap);
        if (snap) h.onSnapshot?.(snap, msg.slot);
        if (msg.reply) this.hello(false);
        break;
      }
      case 'fact': {
        const e = cleanEntry(msg.e);
        if (e) h.onFact?.(e);
        break;
      }
      case 'del':
        if (typeof msg.key === 'string' && /^[0-3]:\d{1,2}:[0-3]$/.test(msg.key) && Number.isFinite(msg.ts)) h.onDel?.(msg.key, msg.ts);
        break;
      case 'reset':
        if (typeof msg.runId === 'string' && Number.isFinite(msg.runTs)) h.onReset?.({ runId: msg.runId.slice(0, 40), runTs: msg.runTs });
        break;
      case 'status': {
        const s = cleanStatus(msg.s);
        if (s && s.slot === msg.slot) h.onStatus?.(s);
        break;
      }
    }
  }
}

// ---- transports ------------------------------------------------------------------------

export class BroadcastTransport {
  constructor(room, slot) {
    this.slot = slot;
    this.ch = new BroadcastChannel(`rj-${room}`);
    this.ch.onmessage = (e) => this.onmessage?.(e.data);
    this.seen = new Set();
  }

  /** Announce presence so tabs that were already open notice us (and we them). */
  open() {
    this.ch.postMessage({ t: 'ping', slot: this.slot });
    const prev = this.ch.onmessage;
    this.ch.onmessage = (e) => {
      const m = e.data;
      if (m && m.slot !== undefined && m.slot !== this.slot && !this.seen.has(m.slot)) {
        this.seen.add(m.slot);
        this.onpeer?.(m.slot, true);
        if (m.t === 'ping') this.ch.postMessage({ t: 'ping', slot: this.slot });
      }
      if (m && m.t !== 'ping') prev(e);
    };
    return Promise.resolve();
  }

  send(msg) {
    this.ch.postMessage(msg);
  }

  close() {
    this.ch.close();
  }
}

export function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS 載入失敗')));
    s.onerror = () => reject(new Error('無法載入連線元件(網路或擋廣告外掛?)'));
    document.head.append(s);
  });
}

/**
 * Full mesh over WebRTC. To keep exactly one connection per pair, a seat only dials the seats
 * below it; the lower seats just wait for the call. A retry timer redials dropped links.
 */
export class PeerTransport {
  constructor(room, slot, Peer) {
    this.room = room;
    this.slot = slot;
    this.Peer = Peer;
    this.conns = new Map(); // seat -> open DataConnection
    this.dialing = new Set();
  }

  id(seat) {
    return `rj-${this.room}-${seat}`;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.peer = new this.Peer(this.id(this.slot));
      this.peer.on('open', () => {
        this.peer.on('connection', (c) => this.#adopt(c, this.#seatOf(c.peer)));
        this.#dial();
        this.timer = setInterval(() => this.#dial(), 3000);
        resolve();
      });
      this.peer.on('error', (err) => {
        if (err && err.type === 'unavailable-id') reject(new Error(`座位 ${this.slot + 1} 已經有人在用了(房間代碼相同)`));
        else if (err && err.type !== 'peer-unavailable') this.onerror?.(err);
      });
    });
  }

  #seatOf(peerId) {
    const m = new RegExp(`^rj-${this.room.replace(/[^\w-]/g, '')}-([0-3])$`).exec(peerId || '');
    return m ? Number(m[1]) : null;
  }

  #dial() {
    for (let seat = 0; seat < this.slot; seat++) {
      if (this.conns.has(seat) || this.dialing.has(seat)) continue;
      this.dialing.add(seat);
      const c = this.peer.connect(this.id(seat), { reliable: true });
      this.#adopt(c, seat);
    }
  }

  #adopt(conn, seat) {
    if (seat === null || seat === this.slot) return conn.close();
    conn.on('open', () => {
      this.dialing.delete(seat);
      this.conns.get(seat)?.close();
      this.conns.set(seat, conn);
      this.onpeer?.(seat, true);
    });
    conn.on('data', (d) => this.onmessage?.(d, seat));
    const gone = () => {
      this.dialing.delete(seat);
      if (this.conns.get(seat) === conn) {
        this.conns.delete(seat);
        this.onpeer?.(seat, false);
      }
    };
    conn.on('close', gone);
    conn.on('error', gone);
    // a dial that never opens (the other side is not there yet) must not block retries
    setTimeout(() => this.dialing.delete(seat), 4000);
  }

  send(msg) {
    for (const c of this.conns.values()) if (c.open) c.send(msg);
  }

  close() {
    clearInterval(this.timer);
    this.peer?.destroy();
    this.conns.clear();
  }
}

// ---- share codes (no-network fallback) -----------------------------------------------------

const toB64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fromB64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

export function encodeShare(snapshot, status) {
  return `RJ1.${toB64(JSON.stringify({ snap: snapshot, status }))}`;
}

/** Returns {snap, status} or null if the text is not a valid share code. */
export function decodeShare(text) {
  try {
    const m = /RJ1\.([A-Za-z0-9+/=]+)/.exec(String(text));
    if (!m) return null;
    const d = JSON.parse(fromB64(m[1]));
    const snap = cleanSnapshot(d.snap);
    return snap ? { snap, status: cleanStatus(d.status) } : null;
  } catch {
    return null;
  }
}
