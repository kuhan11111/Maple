// The lookup database: data/db.json (imported) plus player reports, rebuilt automatically when
// either changes (so you can re-import while the bot is running).

import { statSync } from 'node:fs';
import { loadDb } from './lookup/store.js';
import { Index } from './lookup/search.js';

export function createDbSource(path, { reports = null, stat = statSync, load = loadDb } = {}) {
  let cache = null;
  let seen = null;
  return {
    /** -> {db, index} */
    get() {
      let stamp = 0;
      try {
        stamp = stat(path).mtimeMs;
      } catch {
        /* no file yet: only player reports, if any */
      }
      const key = `${stamp}:${reports?.version ?? 0}`;
      if (!cache || key !== seen) {
        const db = load(path, reports?.items ?? []);
        cache = { db, index: new Index(db) };
        seen = key;
      }
      return cache;
    },
  };
}
