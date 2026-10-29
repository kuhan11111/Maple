// All fixtures are made up; none of this is real Artale news.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeed, extractLinks, looksLikeFeed, stripTags, decode } from '../src/news/parse.js';
import { assertPublicUrl, fetchText } from '../src/news/fetch.js';
import { SourceStore, NewsStore, MAX_SOURCES } from '../src/news/store.js';
import { Refresher, readSource } from '../src/news/refresh.js';
import { delayUntil, scheduleDaily } from '../src/news/schedule.js';
import { renderNews, ago, digestText } from '../src/news/render.js';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title><![CDATA[版本更新 &amp; 修正]]></title><link>https://a.example/p/1</link><pubDate>Wed, 29 Oct 2025 02:00:00 GMT</pubDate><description>&lt;p&gt;新增 &lt;b&gt;地圖&lt;/b&gt;&lt;/p&gt;</description></item>
<item><title>沒有連結的項目</title></item>
<item><title>相對連結</title><link>/p/2</link></item>
<item><title>危險連結</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom 標題</title><link rel="self" href="https://a.example/self"/><link rel="alternate" href="https://a.example/atom/1"/><updated>2025-10-28T10:00:00Z</updated><summary>摘要&#26412;文</summary></entry></feed>`;

test('feed: RSS with CDATA, entities, relative links; unsafe or incomplete items dropped', () => {
  const items = parseFeed(RSS, 'https://a.example/feed');
  assert.deepEqual(items.map((i) => i.title), ['版本更新 & 修正', '相對連結']);
  assert.equal(items[0].url, 'https://a.example/p/1');
  assert.equal(items[0].publishedAt, Date.parse('2025-10-29T02:00:00Z'));
  assert.equal(items[0].snippet, '新增 地圖');
  assert.equal(items[1].url, 'https://a.example/p/2');
  assert.equal(items[1].publishedAt, null);
});

test('feed: Atom prefers the alternate link; JSON Feed works', () => {
  const [a] = parseFeed(ATOM, 'https://a.example/');
  assert.deepEqual([a.title, a.url, a.snippet], ['Atom 標題', 'https://a.example/atom/1', '摘要本文']);
  const j = parseFeed(JSON.stringify({ items: [{ title: 'J', url: 'https://j.example/1', date_published: '2025-10-01T00:00:00Z', summary: 's' }, { title: 'no url' }] }), 'https://j.example/');
  assert.equal(j.length, 1);
  assert.ok(looksLikeFeed(RSS) && looksLikeFeed(ATOM) && looksLikeFeed('{"items":[]}'));
  assert.ok(!looksLikeFeed('<html><body>hi</body></html>'));
  assert.deepEqual(parseFeed('<rss></rss>', 'https://a/'), []);
  assert.equal(decode('&lt;&#x4e2d;&#20013;&unknown;'), '<中中&unknown;');
  assert.equal(stripTags('<script>x()</script><b>粗</b> 體'), '粗 體');
});

const BOARD = `<html><body>
<a href="/">首頁</a><a href="/B.php?bsn=1">看板</a><a href="/B.php?bsn=1&page=2">下一頁</a><a href="#top">回頂端</a>
${Array.from({ length: 6 }, (_, i) => `<a href="C.php?bsn=1&snA=${100 + i}">【情報】第 ${i} 篇新地圖掉落整理</a>`).join('\n')}
<a href="/search?q=1">搜尋功能說明文字很長很長</a>
<a href="https://ads.example/x">這是一則很長的廣告標題文字</a>
</body></html>`;

test('html: the biggest family of same-shaped links is the thread list', () => {
  const items = extractLinks(BOARD, 'https://forum.example/B.php?bsn=1');
  assert.equal(items.length, 6);
  assert.ok(items.every((i) => i.url.startsWith('https://forum.example/C.php?bsn=1&snA=')));
  assert.equal(items[0].title, '【情報】第 0 篇新地圖掉落整理');
  const filtered = extractLinks(BOARD, 'https://forum.example/B.php?bsn=1', { include: 'snA=10[01]$' });
  assert.deepEqual(filtered.map((i) => i.url.slice(-3)), ['100', '101']);
  assert.deepEqual(extractLinks('<a href="/a">短</a>', 'https://x.example/'), []);
  assert.deepEqual(extractLinks('<p>no links</p>', 'https://x.example/'), []);
});

test('fetch: private and internal addresses are refused, public ones pass', async () => {
  const pub = async () => [{ address: '93.184.216.34' }];
  const priv = async () => [{ address: '10.0.0.5' }];
  await assertPublicUrl('https://example.com/x', pub);
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://192.168.1.1/', 'http://nas.local/', 'ftp://example.com/', 'file:///etc/passwd', 'not a url']) {
    await assert.rejects(assertPublicUrl(bad, pub), /內部網址|只支援|格式/, bad);
  }
  await assert.rejects(assertPublicUrl('https://sneaky.example/', priv), /內部網址/, 'a public name that resolves to a private address');
});

const res = (body, { status = 200, headers = {} } = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), body: (async function* () { yield Buffer.from(body); })() });
const pub = async () => [{ address: '93.184.216.34' }];

test('fetch: follows redirects (checking each hop), caps size, decodes charsets', async () => {
  const seen = [];
  const f = async (url) => (seen.push(url), url.endsWith('/a') ? res('', { status: 302, headers: { location: '/b' } }) : res('ok'));
  assert.equal((await fetchText('https://x.example/a', { fetch: f, lookup: pub })).text, 'ok');
  assert.deepEqual(seen, ['https://x.example/a', 'https://x.example/b']);
  const evil = async (url) => (url.includes('start') ? res('', { status: 302, headers: { location: 'http://169.254.169.254/' } }) : res('secret'));
  await assert.rejects(fetchText('https://x.example/start', { fetch: evil, lookup: pub }), /內部網址/);
  const loop = async () => res('', { status: 302, headers: { location: '/again' } });
  await assert.rejects(fetchText('https://x.example/', { fetch: loop, lookup: pub }), /轉址太多/);
  await assert.rejects(fetchText('https://x.example/', { fetch: async () => res('x'.repeat(100)), lookup: pub, maxBytes: 10 }), /太大/);
  await assert.rejects(fetchText('https://x.example/', { fetch: async () => res('', { status: 503 }), lookup: pub }), /HTTP 503/);
  const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]); // 中文 in Big5
  const r = await fetchText('https://x.example/', { fetch: async () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'text/html; charset=big5' }), body: (async function* () { yield big5; })() }), lookup: pub });
  assert.equal(r.text, '中文');
});

test('source store: validation, replace by name, limits, channels', () => {
  const s = new SourceStore(null);
  assert.equal(s.add({ name: '', url: 'https://a.example' }).ok, false);
  assert.equal(s.add({ name: 'x', url: 'ftp://a.example' }).ok, false);
  assert.equal(s.add({ name: 'x', url: 'https://a.example', type: 'xml' }).ok, false);
  assert.equal(s.add({ name: 'x', url: 'https://a.example', include: '(' }).ok, false);
  assert.deepEqual(s.add({ name: 'PTT', url: 'https://a.example/b', keywords: 'Artale, 阿泰爾' }), { ok: true, updated: false });
  assert.deepEqual(s.get('ptt').keywords, ['Artale', '阿泰爾']);
  assert.equal(s.add({ name: 'ptt', url: 'https://a.example/c' }).updated, true);
  assert.equal(s.sources.length, 1);
  assert.equal(s.remove('PTT'), true);
  assert.equal(s.remove('PTT'), false);
  for (let i = 0; i < MAX_SOURCES; i++) assert.ok(s.add({ name: `s${i}`, url: 'https://a.example' }).ok);
  assert.match(s.add({ name: 'one more', url: 'https://a.example' }).message, /最多/);
  s.addChannel('1', '情報');
  s.addChannel('1', '情報');
  assert.equal(s.channels.length, 1);
  assert.ok(s.hasChannel('1'));
  assert.ok(s.removeChannel('1') && !s.removeChannel('1'));
});

test('news store: dedupes by url, sorts by date, prunes, digest never dumps the backlog', () => {
  let now = Date.UTC(2025, 9, 29);
  const st = new NewsStore(null, { now: () => now, max: 3 });
  const a = st.merge([{ title: 'old post', url: 'https://x/1', publishedAt: now - 5 * 86400_000 }, { title: 'no date', url: 'https://x/2' }], 'S1');
  assert.equal(a.length, 2);
  assert.equal(st.merge([{ title: 'again', url: 'https://x/1' }], 'S2').length, 0);
  assert.deepEqual(st.recent(5).map((i) => i.title), ['no date', 'old post'], 'undated items sort by when they were first seen');
  assert.deepEqual(st.takeDigest(), [], 'first digest only sets the mark');
  now += 1000;
  st.merge([{ title: 'fresh', url: 'https://x/3' }, { title: 'fresher', url: 'https://x/4' }], 'S1');
  assert.deepEqual(st.takeDigest().map((i) => i.title).sort(), ['fresh', 'fresher']);
  assert.deepEqual(st.takeDigest(), [], 'nothing new since the last digest');
  assert.equal(st.items.length, 3, 'capped');
  assert.deepEqual(st.recent(5, { source: 's2' }), []);
  const old = new NewsStore(null, { now: () => now });
  old.merge([{ title: 'ancient', url: 'https://x/9', publishedAt: now - 100 * 86400_000 }, { title: 'recent', url: 'https://x/8', publishedAt: now }], 'S');
  assert.deepEqual(old.items.map((i) => i.title), ['recent'], 'older than 90 days is dropped');
});

test('stores persist to disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-'));
  const sp = join(dir, 'sources.json');
  const np = join(dir, 'news.json');
  const s = new SourceStore(sp);
  s.add({ name: 'A', url: 'https://a.example' });
  const n = new NewsStore(np);
  n.merge([{ title: 't', url: 'https://x/1' }], 'A');
  n.markRefreshed();
  s.flush();
  n.flush();
  assert.equal(new SourceStore(sp).get('a').url, 'https://a.example');
  const back = new NewsStore(np);
  assert.equal(back.items.length, 1);
  assert.ok(back.lastRefresh);
});

const mkRefresher = (pages, over = {}) => {
  const sources = new SourceStore(null);
  const store = new NewsStore(null, { now: over.now ?? (() => Date.UTC(2025, 9, 30)) });
  const calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    const p = pages[url];
    if (p instanceof Error) throw p;
    return { text: p, url };
  };
  return { sources, store, calls, r: new Refresher({ sources, store, fetchText, now: over.now ?? (() => Date.UTC(2025, 9, 30)), minIntervalMs: 1000 }) };
};

test('refresh: feed and html sources, keyword filter, one broken source does not stop the rest', async () => {
  const { r, sources, store } = mkRefresher({ 'https://a.example/feed': RSS, 'https://b.example/board': BOARD, 'https://c.example/': new Error('HTTP 503') });
  sources.add({ name: 'feed', url: 'https://a.example/feed' });
  sources.add({ name: 'board', url: 'https://b.example/board', keywords: '新地圖' });
  sources.add({ name: 'down', url: 'https://c.example/' });
  const out = await r.refresh();
  assert.deepEqual(out.results.map((x) => [x.name, x.ok, x.found]), [['feed', true, 2], ['board', true, 6], ['down', false, undefined]]);
  assert.equal(out.results[0].via, 'feed');
  assert.equal(out.results[1].via, 'html');
  assert.match(out.results[2].error, /503/);
  assert.equal(store.items.length, 8);
  const second = await r.refresh();
  assert.equal(second.added.length, 0, 'nothing new the second time');
});

test('refresh: recent refreshes are skipped, concurrent ones share a single run', async () => {
  let now = 0;
  const { r, sources, calls } = mkRefresher({ 'https://a.example/feed': RSS }, { now: () => now });
  sources.add({ name: 'feed', url: 'https://a.example/feed' });
  const [x, y] = await Promise.all([r.ensureFresh(), r.ensureFresh()]);
  assert.equal(x, y);
  assert.equal(calls.length, 1);
  now = 500;
  assert.equal((await r.ensureFresh()).skipped, true);
  now = 2000;
  assert.equal((await r.ensureFresh()).skipped, false);
  assert.equal(calls.length, 2);
  const { items } = await readSource({ type: 'rss', url: 'https://a.example/feed', keywords: ['不存在的字'] }, { fetchText: async (u) => ({ text: RSS, url: u }) });
  assert.deepEqual(items, []);
});

test('schedule: next run time in Taiwan time, repeats, errors do not stop it', async () => {
  const h = 3600_000;
  const at = (iso) => Date.parse(iso);
  assert.equal(delayUntil('06:00', 8, at('2025-10-29T00:00:00Z')), 22 * h, '08:00 in Taiwan -> next 06:00 is tomorrow');
  assert.equal(delayUntil('06:00', 8, at('2025-10-28T20:00:00Z')), 2 * h, '04:00 in Taiwan');
  assert.equal(delayUntil('06:00', 8, at('2025-10-28T22:00:00Z')), 24 * h, 'exactly 06:00 waits a full day');
  assert.equal(delayUntil('23:59', 0, at('2025-10-29T00:00:00Z')), 23 * h + 59 * 60_000);
  for (const bad of ['6', '25:00', '06:60', 'abc']) assert.throws(() => delayUntil(bad, 8, 0), /時間格式/);

  let now = at('2025-10-28T20:00:00Z');
  const armed = [];
  const errors = [];
  let runs = 0;
  const job = scheduleDaily({ at: '06:00', offsetHours: 8, now: () => now, setTimeout: (fn, ms) => (armed.push({ fn, ms }), armed.length), clearTimeout: () => {} }, async () => {
    runs++;
    if (runs === 1) throw new Error('boom');
  }, (e) => errors.push(e.message));
  assert.equal(armed[0].ms, 2 * h);
  now += 2 * h;
  await armed[0].fn();
  assert.deepEqual([runs, errors], [1, ['boom']]);
  assert.equal(armed.length, 2, 'a failing run still schedules the next one');
  assert.equal(armed[1].ms, 24 * h);
  job.stop();
  now += 24 * h;
  await armed[1].fn();
  assert.equal(armed.length, 2, 'stopped: no more runs armed');
});

test('render: relative times and the news message', () => {
  const now = Date.UTC(2025, 9, 29, 8, 0); // 16:00 Taiwan, 29 Oct
  assert.equal(ago(now - 10_000, now), '剛剛');
  assert.equal(ago(now - 5 * 60_000, now), '5 分鐘前');
  assert.equal(ago(now - 3 * 3600_000, now), '3 小時前');
  assert.equal(ago(Date.UTC(2025, 9, 28, 10, 0), now), '22 小時前');
  assert.equal(ago(Date.UTC(2025, 9, 28, 6, 0), now), '昨天');
  assert.equal(ago(Date.UTC(2025, 9, 20, 10, 0), now), '10/20');
  assert.equal(ago(Date.UTC(2025, 9, 26, 23, 0), now), '10/27', '23:00Z is already the next day in Taiwan');
  const items = [
    { title: '更新 [公告] *重要*', url: 'https://a.example/1', source: '巴哈', publishedAt: now - 3600_000, firstSeen: now },
    { title: '玩家分享', url: 'https://a.example/2', source: 'PTT', publishedAt: null, firstSeen: now - 120_000 },
  ];
  const text = renderNews(items, { now, lastRefresh: now - 60_000 });
  assert.ok(text.includes('[更新 公告 \\*重要\\*](<https://a.example/1>) — 巴哈 · 1 小時前\n'), text);
  assert.ok(text.includes('[玩家分享](<https://a.example/2>) — PTT · 2 分鐘前(收錄時間)'), text);
  assert.match(text, /更新於 1 分鐘前/);
  assert.match(renderNews(items, { now, source: 'PTT' }), /\(PTT\)/);
  assert.match(digestText(items, { now }), /今日情報/);
  assert.ok(renderNews(Array.from({ length: 15 }, (_, i) => ({ title: 'x'.repeat(200), url: `https://a.example/${i}`, source: 's', firstSeen: now })), { now }).length < 2000);
});
