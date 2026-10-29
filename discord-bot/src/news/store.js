// News sources (what to read) and the collected items (what was found), both kept in small JSON
// files with atomic writes.

import { createHash } from 'node:crypto';
import { JsonFile as Json, readJson as read } from '../jsonfile.js';

const DAY = 24 * 60 * 60 * 1000;

export const MAX_SOURCES = 20;
const TYPES = ['auto', 'rss', 'html'];

/** The list of places to read from, plus Discord channels whose posts count as news. */
export class SourceStore extends Json {
  constructor(path = null) {
    super(path);
    const d = read(path, {});
    this.sources = Array.isArray(d.sources) ? d.sources : [];
    this.channels = Array.isArray(d.channels) ? d.channels : [];
  }

  data() {
    return { sources: this.sources, channels: this.channels };
  }

  /** -> {ok:true} | {ok:false, message}. Network checks happen when it is tested, not here. */
  add({ name, url, type = 'auto', keywords = '', include = '' }) {
    name = String(name ?? '').trim().slice(0, 30);
    if (!name) return { ok: false, message: '要給這個來源一個名字。' };
    if (!TYPES.includes(type)) return { ok: false, message: `類型要是 ${TYPES.join(' / ')}。` };
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      return { ok: false, message: '網址要以 http:// 或 https:// 開頭。' };
    }
    if (include) {
      try {
        new RegExp(include);
      } catch {
        return { ok: false, message: '「連結篩選」不是有效的正規表示式。' };
      }
    }
    const kw = String(keywords).split(/[,，、\s]+/).map((k) => k.trim()).filter(Boolean).slice(0, 10);
    const i = this.sources.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    if (i < 0 && this.sources.length >= MAX_SOURCES) return { ok: false, message: `來源最多 ${MAX_SOURCES} 個。` };
    const rec = { name, url: String(url).trim(), type, keywords: kw, include: String(include).slice(0, 200) };
    if (i >= 0) this.sources[i] = rec;
    else this.sources.push(rec);
    this.queue();
    return { ok: true, updated: i >= 0 };
  }

  remove(name) {
    const i = this.sources.findIndex((s) => s.name.toLowerCase() === String(name).trim().toLowerCase());
    if (i < 0) return false;
    this.sources.splice(i, 1);
    this.queue();
    return true;
  }

  get(name) {
    return this.sources.find((s) => s.name.toLowerCase() === String(name).trim().toLowerCase()) ?? null;
  }

  addChannel(id, name) {
    if (!this.channels.some((c) => c.id === id)) this.channels.push({ id, name: String(name).slice(0, 50) });
    this.queue();
  }

  removeChannel(id) {
    const n = this.channels.length;
    this.channels = this.channels.filter((c) => c.id !== id);
    this.queue();
    return this.channels.length !== n;
  }

  hasChannel(id) {
    return this.channels.some((c) => c.id === id);
  }
}

export const itemId = (url) => createHash('sha1').update(url).digest('hex').slice(0, 12);

/** Everything found so far, newest first. */
export class NewsStore extends Json {
  constructor(path = null, { now = () => Date.now(), max = 300 } = {}) {
    super(path);
    Object.assign(this, { now, max });
    const d = read(path, {});
    this.items = Array.isArray(d.items) ? d.items : [];
    this.lastRefresh = d.lastRefresh ?? null;
    this.lastDigest = d.lastDigest ?? null;
  }

  data() {
    return { items: this.items, lastRefresh: this.lastRefresh, lastDigest: this.lastDigest };
  }

  #when = (i) => i.publishedAt ?? i.firstSeen;

  /** Adds unseen items (by URL). Returns the ones that were new. */
  merge(items, source) {
    const known = new Set(this.items.map((i) => i.url));
    const t = this.now();
    const fresh = [];
    for (const i of items) {
      if (!i.url || !i.title || known.has(i.url)) continue;
      known.add(i.url);
      fresh.push({ id: itemId(i.url), url: i.url, title: i.title.slice(0, 150), source, publishedAt: i.publishedAt ?? null, firstSeen: t, snippet: (i.snippet ?? '').slice(0, 140) });
    }
    if (fresh.length) {
      this.items = [...fresh, ...this.items].sort((a, b) => this.#when(b) - this.#when(a)).filter((i) => t - this.#when(i) < 90 * DAY).slice(0, this.max);
      this.queue();
    }
    return fresh;
  }

  recent(n = 8, { source = null } = {}) {
    const s = source?.toLowerCase();
    return this.items.filter((i) => !s || i.source.toLowerCase() === s).slice(0, n);
  }

  markRefreshed() {
    this.lastRefresh = this.now();
    this.queue();
  }

  /** New items since the last digest. The very first call only sets the mark, so a fresh install does not dump its whole backlog. */
  takeDigest(max = 10) {
    const since = this.lastDigest;
    this.lastDigest = this.now();
    this.queue();
    if (since === null) return [];
    return this.items.filter((i) => i.firstSeen > since).slice(0, max);
  }
}
