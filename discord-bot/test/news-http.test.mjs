// The news pipeline over real HTTP: a local server plays a forum board, an RSS feed and a redirect,
// and Node's real fetch streams the bodies. The SSRF guard is satisfied with a fake public DNS answer,
// and the hostname is mapped to the local server by a thin fetch wrapper.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchText } from '../src/news/fetch.js';
import { SourceStore, NewsStore } from '../src/news/store.js';
import { Refresher } from '../src/news/refresh.js';

const board = (n) => `<html><head><meta charset="utf-8"></head><body><a href="/">首頁</a>${Array.from({ length: n }, (_, i) => `<a href="/thread/${100 + i}">【情報】新地圖第 ${i} 篇掉落整理</a>`).join('')}</body></html>`;
const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><item><title>官方更新公告</title><link>http://news.example/post/1</link><pubDate>Thu, 30 Oct 2025 02:00:00 GMT</pubDate><description>&lt;p&gt;新增地圖&lt;/p&gt;</description></item></channel></rss>`;

async function withServer(fn) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/board') res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(board(5));
    else if (req.url === '/feed') res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(feed);
    else if (req.url === '/old') res.writeHead(301, { location: '/feed' }).end();
    else if (req.url === '/big') res.writeHead(200).end('x'.repeat(3 * 1024 * 1024));
    else if (req.url === '/big5') res.writeHead(200, { 'content-type': 'text/html; charset=big5' }).end(Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]));
    else res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const toLocal = (url, init) => fetch(url.replace('http://news.example', `http://127.0.0.1:${port}`), init);
  const fetcher = (url) => fetchText(url, { fetch: toLocal, lookup: async () => [{ address: '93.184.216.34' }], maxBytes: 2 * 1024 * 1024 });
  try {
    await fn({ fetcher, hits: () => hits });
  } finally {
    server.close();
  }
}

test('real HTTP: forum board, feed, redirect, charset, size cap, 404', async () => {
  await withServer(async ({ fetcher }) => {
    assert.match((await fetcher('http://news.example/board')).text, /新地圖第 4 篇/);
    assert.match((await fetcher('http://news.example/feed')).text, /官方更新公告/);
    const redirected = await fetcher('http://news.example/old');
    assert.equal(redirected.url, 'http://news.example/feed');
    assert.equal((await fetcher('http://news.example/big5')).text, '中文');
    await assert.rejects(fetcher('http://news.example/big'), /太大/);
    await assert.rejects(fetcher('http://news.example/missing'), /HTTP 404/);
  });
});

test('real HTTP: a refresh collects the board and the feed, and a second one adds nothing', async () => {
  await withServer(async ({ fetcher, hits }) => {
    const sources = new SourceStore(null);
    sources.add({ name: '論壇', url: 'http://news.example/board', keywords: '情報' });
    sources.add({ name: '官方', url: 'http://news.example/feed' });
    const store = new NewsStore(null, { now: () => Date.UTC(2025, 9, 30) });
    const r = new Refresher({ sources, store, fetchText: fetcher, now: () => Date.UTC(2025, 9, 30), minIntervalMs: 0 });
    const first = await r.refresh();
    assert.deepEqual(first.results.map((x) => [x.name, x.ok, x.found, x.via]), [['論壇', true, 5, 'html'], ['官方', true, 1, 'feed']]);
    assert.equal(store.items.length, 6);
    assert.equal(store.items.find((i) => i.title === '官方更新公告').snippet, '新增地圖');
    assert.equal(store.recent(1)[0].title, '官方更新公告', 'dated items come before undated ones from the same moment');
    assert.equal((await r.refresh()).added.length, 0);
    assert.equal(hits(), 4);
  });
});
