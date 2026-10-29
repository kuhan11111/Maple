// Real audio pipeline check: local file and HTTP stream -> ffmpeg -> Opus packets, using the
// system ffmpeg (or ffmpeg-static). Not a Discord voice test - joining a channel needs a live
// Discord connection - but it proves the part that usually breaks (decoding / encoding) works.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeResource } from '../src/music/resource.js';

let wav;
let skip = false;
try {
  const dir = mkdtempSync(join(tmpdir(), 'pipe-'));
  wav = join(dir, 'tone.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '44100', '-ac', '1', wav]);
} catch {
  skip = true;
}

async function countPackets(resource, max = Infinity) {
  let n = 0;
  let bytes = 0;
  const done = new Promise((resolve, reject) => {
    resource.playStream.on('data', (c) => {
      n++;
      bytes += c.length;
      if (n >= max) resource.playStream.destroy();
    });
    resource.playStream.on('end', resolve);
    resource.playStream.on('close', resolve);
    resource.playStream.on('error', reject);
  });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 15000))]);
  return { n, bytes };
}

test('local file -> opus packets (~20 ms each)', { skip }, async () => {
  const r = await countPackets(makeResource({ kind: 'file', file: wav }, 0.5));
  assert.ok(r.n >= 90 && r.n <= 110, `2 s of audio should be ~100 packets, got ${r.n}`);
  assert.ok(r.bytes > 500);
});

test('http radio stream -> opus packets', { skip }, async () => {
  const body = readFileSync(wav);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/live`;
    const r = await countPackets(makeResource({ kind: 'radio', url }, 0.5), 50);
    assert.ok(r.n >= 50, `got ${r.n} packets`);
  } finally {
    server.close();
  }
});

test('volume is applied to the resource', { skip }, () => {
  const r = makeResource({ kind: 'file', file: wav }, 0.25);
  assert.equal(r.volume.volume, 0.25);
  r.playStream.destroy();
});

// Skipping / stopping destroys the stream while data is still flowing; that must never throw.
// Two shapes: the way the real AudioPlayer works (poll read() on a timer, destroy from outside), and
// the harsher one where a 'data' listener destroys the stream from inside the encoder's own push().
async function watchForCrash(fn) {
  const errors = [];
  const onErr = (e) => errors.push(e.message);
  process.on('uncaughtException', onErr);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 600)); // let queued writes drain
  } finally {
    process.off('uncaughtException', onErr);
  }
  return errors;
}

const polling = (resource) =>
  new Promise((resolve) => {
    let n = 0;
    const t = setInterval(() => {
      while (resource.playStream.read() !== null) n++;
      if (n >= 10) {
        clearInterval(t);
        resource.playStream.destroy();
        resolve();
      }
    }, 20);
  });

const insideData = (resource) =>
  new Promise((resolve) => {
    let n = 0;
    resource.playStream.on('data', () => {
      if (++n === 10) {
        resource.playStream.destroy();
        resolve();
      }
    });
  });

const radioServer = async () => {
  const body = readFileSync(wav);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/live` };
};

for (const [name, consume] of [['AudioPlayer-style polling', polling], ["destroyed inside a 'data' listener", insideData]]) {
  test(`stopping a local file midway does not crash (${name})`, { skip }, async () => {
    assert.deepEqual(await watchForCrash(() => consume(makeResource({ kind: 'file', file: wav }, 0.5))), []);
  });
  test(`stopping a radio stream midway does not crash (${name})`, { skip }, async () => {
    const { server, url } = await radioServer();
    try {
      assert.deepEqual(await watchForCrash(() => consume(makeResource({ kind: 'radio', url }, 0.5))), []);
    } finally {
      server.close();
    }
  });
}
