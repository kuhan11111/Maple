// What the bot is allowed to play: audio files in the music folder, and internet radio streams the
// operator listed. Users pick from these by name; they cannot supply their own files or URLs.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, basename, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { norm, similarity } from '../lookup/search.js';

export const EXTS = ['.mp3', '.ogg', '.opus', '.flac', '.wav', '.m4a', '.aac'];

export function scanLibrary(dir, { maxDepth = 3 } = {}) {
  const out = [];
  const walk = (d, depth) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) depth < maxDepth && walk(p, depth + 1);
      else if (EXTS.includes(extname(name).toLowerCase())) {
        const rel = relative(dir, p).split(sep).join('/');
        out.push({ id: `f:${createHash('sha1').update(rel).digest('hex').slice(0, 10)}`, kind: 'file', title: basename(name, extname(name)), file: p, folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' });
      }
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return out;
}

/** "電台A=https://a.example/stream,電台B=https://b.example/live" -> radio tracks */
export function parseRadio(spec) {
  const out = [];
  for (const part of (spec ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    const title = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim();
    if (eq < 1 || !title || !/^https?:\/\/\S+$/i.test(url)) throw new Error(`RADIO_STREAMS 格式不對:「${part}」(要寫成 名稱=https://...)`);
    out.push({ id: `r:${createHash('sha1').update(url).digest('hex').slice(0, 10)}`, kind: 'radio', title, url });
  }
  return out;
}

export class Library {
  constructor({ dir, radio = [], ttlMs = 30_000, now = () => Date.now(), scan = scanLibrary }) {
    Object.assign(this, { dir, radio, ttlMs, now, scan });
    this.files = [];
    this.at = -Infinity;
  }

  refresh(force = false) {
    if (force || this.now() - this.at > this.ttlMs) {
      this.files = this.scan(this.dir);
      this.at = this.now();
    }
    return this.files;
  }

  get(id) {
    return [...this.refresh(), ...this.radio].find((t) => t.id === id) ?? null;
  }

  #rank(pool, q, limit) {
    const nq = norm(q);
    if (!nq) return pool.slice(0, limit);
    return pool
      .map((t) => {
        const n = norm(t.title);
        const s = n === nq ? 1 : n.startsWith(nq) ? 0.9 : n.includes(nq) ? 0.8 : similarity(nq, n) * 0.7;
        return { t, s };
      })
      .filter((x) => x.s >= 0.4)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.t);
  }

  /** A track by id (from autocomplete) or by typed name. */
  find(query) {
    return this.get(query) ?? this.#rank(this.refresh(), query, 1)[0] ?? null;
  }

  findRadio(query) {
    return this.get(query) ?? this.#rank(this.radio, query, 1)[0] ?? null;
  }

  search(query, limit = 25) {
    return this.#rank(this.refresh(), query, limit);
  }

  searchRadio(query, limit = 25) {
    return this.#rank(this.radio, query, limit);
  }
}
