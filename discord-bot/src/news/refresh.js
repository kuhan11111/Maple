// Reading every source and merging what is new into the store.

import { parseFeed, extractLinks, looksLikeFeed } from './parse.js';

export async function readSource(source, { fetchText }) {
  const { text, url } = await fetchText(source.url);
  const feed = source.type === 'rss' || (source.type === 'auto' && looksLikeFeed(text));
  let items = feed ? parseFeed(text, url) : extractLinks(text, url, { include: source.include || null });
  if (source.keywords?.length) {
    const kws = source.keywords.map((k) => k.toLowerCase());
    items = items.filter((i) => kws.some((k) => `${i.title} ${i.snippet}`.toLowerCase().includes(k)));
  }
  return { items, via: feed ? 'feed' : 'html' };
}

/**
 * Keeps the news fresh: refreshes at most every `minIntervalMs` when asked, never runs two refreshes
 * at once (concurrent callers share one), and one broken source never stops the others.
 */
export class Refresher {
  constructor({ sources, store, fetchText, minIntervalMs = 30 * 60 * 1000, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { sources, store, fetchText, minIntervalMs, now, log });
    this.inflight = null;
  }

  get stale() {
    return this.store.lastRefresh === null || this.now() - this.store.lastRefresh >= this.minIntervalMs;
  }

  /** Refresh unless it was done recently. -> {results, added, skipped} */
  async ensureFresh() {
    if (!this.stale && !this.inflight) return { results: [], added: [], skipped: true };
    return this.refresh();
  }

  refresh() {
    this.inflight ??= this.#run().finally(() => (this.inflight = null));
    return this.inflight;
  }

  async #run() {
    const results = [];
    const added = [];
    for (const source of [...this.sources.sources]) {
      try {
        const { items, via } = await readSource(source, { fetchText: this.fetchText });
        const fresh = this.store.merge(items, source.name);
        added.push(...fresh);
        results.push({ name: source.name, ok: true, found: items.length, added: fresh.length, via });
      } catch (err) {
        results.push({ name: source.name, ok: false, error: err.message });
        this.log('news_source_error', { source: source.name, message: err.message });
      }
    }
    this.store.markRefreshed();
    this.log('news_refresh', { sources: results.length, added: added.length, failed: results.filter((r) => !r.ok).length });
    return { results, added, skipped: false };
  }
}
