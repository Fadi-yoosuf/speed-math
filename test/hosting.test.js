'use strict';

// Behind a tunnel or a hosted proxy the server sees X-Forwarded-* headers.
// Join links, TV links and QR codes must use the public address, and the
// optional PUBLIC_URL must be offered alongside the Wi-Fi address.

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startServer, normalisePublicUrl } = require('../server/index');

function connect(url, headers) {
  const ws = new WebSocket(url, { headers });
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  const next = (type, ms = 5000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
        if (Date.now() - t0 > ms) return reject(new Error(`no ${type}`));
        setTimeout(poll, 5);
      })();
    });
  const send = (type, payload) => ws.send(JSON.stringify({ type, payload }));
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, next, send })));
}

const identity = { name: 'Ava', car: { emoji: '🚗', colour: '#ef4444' }, level: 1 };

test('join links follow X-Forwarded-Proto / X-Forwarded-Host (tunnel, Render, reverse proxy)', async () => {
  const srv = await startServer({ port: 0, log: () => {} });
  try {
    const c = await connect(`ws://127.0.0.1:${srv.port}/ws`, {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'quiet-river-1234.trycloudflare.com',
      'x-forwarded-for': '203.0.113.9',
    });
    c.send('create_room', identity);
    const w = await c.next('welcome');
    assert.equal(w.joinUrl, `https://quiet-river-1234.trycloudflare.com/join/${w.code}`);
    assert.equal(w.tvUrl, `https://quiet-river-1234.trycloudflare.com/tv/${w.code}`);
    assert.match(w.qrDataUrl, /^data:image\/png;base64,/);
    assert.equal(w.publicJoinUrl, null, 'no PUBLIC_URL configured');
    c.ws.close();
  } finally {
    await srv.close();
  }
});

test('localhost origins are swapped for the LAN address so QR codes work on phones', async () => {
  const srv = await startServer({ port: 0, log: () => {} });
  try {
    const c = await connect(`ws://localhost:${srv.port}/ws`);
    c.send('create_room', identity);
    const w = await c.next('welcome');
    assert.doesNotMatch(w.joinUrl, /localhost|127\.0\.0\.1/);
    assert.match(w.joinUrl, new RegExp(`^http://[0-9.]+:${srv.port}/join/${w.code}$`));
    c.ws.close();
  } finally {
    await srv.close();
  }
});

test('PUBLIC_URL adds a second, public join link and the TV prefers it', async () => {
  const srv = await startServer({ port: 0, log: () => {}, publicUrl: 'https://race.example.com/' });
  try {
    assert.equal(srv.publicUrl, 'https://race.example.com');
    const host = await connect(`ws://127.0.0.1:${srv.port}/ws`, { host: '192.168.1.42:3000' });
    host.send('create_room', identity);
    const w = await host.next('welcome');
    assert.equal(w.joinUrl, `http://192.168.1.42:3000/join/${w.code}`);
    assert.equal(w.publicJoinUrl, `https://race.example.com/join/${w.code}`);
    assert.equal(w.publicTvUrl, `https://race.example.com/tv/${w.code}`);
    assert.match(w.publicQrDataUrl, /^data:image\/png;base64,/);

    // Someone arriving through the public address sees just one link.
    const remote = await connect(`ws://127.0.0.1:${srv.port}/ws`, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'race.example.com' });
    remote.send('join_room', { ...identity, name: 'Ben', code: w.code });
    const w2 = await remote.next('welcome');
    assert.equal(w2.joinUrl, `https://race.example.com/join/${w.code}`);
    assert.equal(w2.publicJoinUrl, null);

    const tv = await connect(`ws://127.0.0.1:${srv.port}/ws`, { host: '192.168.1.42:3000' });
    tv.send('watch_room', { code: w.code });
    const watching = await tv.next('watching');
    assert.equal(watching.joinUrl, `https://race.example.com/join/${w.code}`);
    assert.match(watching.qrDataUrl, /^data:image\/png;base64,/);
    for (const c of [host, remote, tv]) c.ws.close();
  } finally {
    await srv.close();
  }
});

test('ping keeps the connection busy and gets a pong (free-tier keepalive)', async () => {
  const srv = await startServer({ port: 0, log: () => {} });
  try {
    const c = await connect(`ws://127.0.0.1:${srv.port}/ws`);
    c.send('ping');
    assert.equal((await c.next('pong')).type, 'pong');
    c.ws.close();
  } finally {
    await srv.close();
  }
});

test('normalisePublicUrl accepts an origin and rejects junk', () => {
  assert.equal(normalisePublicUrl('https://race.example.com/'), 'https://race.example.com');
  assert.equal(normalisePublicUrl('http://192.168.1.2:3000'), 'http://192.168.1.2:3000');
  assert.equal(normalisePublicUrl(''), null);
  assert.equal(normalisePublicUrl(undefined), null);
  assert.equal(normalisePublicUrl('race.example.com'), null);
  assert.equal(normalisePublicUrl('https://race.example.com/path'), null);
});
