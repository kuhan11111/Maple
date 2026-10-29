// The lookup database, reloaded automatically when data/db.json changes (so you can re-import while
// the bot is running).

import { statSync } from 'node:fs';
import { loadDb } from './lookup/store.js';
import { Index } from './lookup/search.js';

export function createDbSource(path, { stat = statSync, load = loadDb } = {}) {
  let cache = null;
  let seen = null;
  return {
    /** -> {db, index} */
    get() {
      let stamp = 0;
      try {
        stamp = stat(path).mtimeMs;
      } catch {
        /* no file yet: an empty database */
      }
      if (!cache || stamp !== seen) {
        const db = load(path);
        cache = { db, index: new Index(db) };
        seen = stamp;
      }
      return cache;
    },
  };
}
