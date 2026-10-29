// Fetching a page politely and safely: public http(s) hosts only (checked on every redirect), a size
// cap and a timeout. Sources are added by admins, but a typo or a hostile URL must still not be able
// to reach the bot's own network.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const UA = 'Mozilla/5.0 (compatible; ArtaleBot/1.0; +discord bot, daily news digest)';

function privateIp(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') || (v.startsWith('::ffff:') && privateIp(v.slice(7)));
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function assertPublicUrl(url, lookup = dnsLookup) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('網址格式不對');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支援 http / https 網址');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('不能使用內部網址');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(privateIp)) throw new Error('不能使用內部網址');
  return u.href;
}

export async function fetchText(url, { fetch: f = globalThis.fetch, lookup = dnsLookup, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current, lookup);
    const res = await f(current, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'zh-TW,zh;q=0.9' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('頁面太大');
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
    try {
      return { text: new TextDecoder(charset).decode(buf), url: current };
    } catch {
      return { text: buf.toString('utf8'), url: current };
    }
  }
  throw new Error('轉址太多次');
}
