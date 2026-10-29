// Turning fetched pages into news items {title, url, publishedAt, snippet}: RSS / Atom / JSON Feed,
// or a forum's HTML board page (a list of thread links).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) =>
  String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

export const stripTags = (s) => decode(String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// RSS/Atom bodies are usually HTML that has itself been entity-escaped: unescape first, then drop the tags.
const htmlText = (s) => stripTags(decode(String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')));

const httpUrl = (u, base) => {
  if (!String(u ?? '').trim()) return null; // '' would resolve to the page itself
  try {
    const url = new URL(decode(u).trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};
const ts = (s) => {
  const t = Date.parse(decode(s).trim());
  return Number.isFinite(t) ? t : null;
};

export function looksLikeFeed(text) {
  const head = text.slice(0, 600).trimStart().toLowerCase();
  return head.startsWith('{') || /<(rss|feed|rdf:rdf)\b/.test(head);
}

/** RSS 2.0, RSS 1.0, Atom or JSON Feed -> items (newest first as given). */
export function parseFeed(text, baseUrl) {
  const t = text.trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t);
    return (j.items ?? []).map((i) => ({ title: String(i.title ?? '').trim(), url: httpUrl(i.url ?? i.external_url ?? '', baseUrl), publishedAt: ts(i.date_published ?? i.date_modified ?? ''), snippet: htmlText(i.summary ?? i.content_text ?? i.content_html ?? '').slice(0, 140) })).filter((i) => i.title && i.url);
  }
  const body = t.replace(/<!--[\s\S]*?-->/g, '');
  const field = (block, names) => {
    for (const n of names) {
      const m = new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(block);
      if (m && stripTags(m[1])) return m[1];
    }
    return '';
  };
  const out = [];
  for (const m of body.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const b = m[0];
    const title = stripTags(field(b, ['title']));
    let link = stripTags(field(b, ['link']));
    if (!link) {
      const hrefs = [...b.matchAll(/<link\b[^>]*>/gi)].map((x) => x[0]);
      const alt = hrefs.find((h) => !/rel=["'](?!alternate)/i.test(h)) ?? hrefs[0];
      link = /href=["']([^"']+)["']/i.exec(alt ?? '')?.[1] ?? stripTags(field(b, ['guid']));
    }
    const url = httpUrl(link, baseUrl);
    if (!title || !url) continue;
    out.push({ title, url, publishedAt: ts(stripTags(field(b, ['pubDate', 'published', 'updated', 'dc:date']))), snippet: htmlText(field(b, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 140) });
  }
  return out;
}

const signature = (href) => {
  const u = new URL(href);
  return `${u.host}${u.pathname.replace(/\d+/g, '#')}?${[...u.searchParams.keys()].sort().join('&')}`;
};

/**
 * Thread links on a forum board page. Without `include`, the biggest group of links that share a
 * URL shape (e.g. /C.php?bsn=#&snA=#) is taken to be the thread list; navigation links fall out
 * because each shape only appears a few times.
 */
export function extractLinks(html, baseUrl, { include = null, minTitle = 4, max = 40 } = {}) {
  const seen = new Set();
  const all = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = httpUrl(m[1] ?? m[2], baseUrl);
    const title = stripTags(m[3]);
    if (!url || url.split('#')[0] === baseUrl.split('#')[0] || title.length < minTitle || seen.has(url)) continue;
    seen.add(url);
    all.push({ title, url, sig: signature(url) });
  }
  let picked;
  if (include) {
    const re = new RegExp(include, 'i');
    picked = all.filter((l) => re.test(l.url) || re.test(l.title));
  } else {
    const groups = new Map();
    for (const l of all.filter((x) => x.title.length >= 8)) groups.set(l.sig, [...(groups.get(l.sig) ?? []), l]);
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    picked = best.length >= 3 ? best : [];
  }
  return picked.slice(0, max).map(({ title, url }) => ({ title, url, publishedAt: null, snippet: '' }));
}
