'use strict';

// End-to-end: a real server, three WebSocket clients, one full race.
// This is the "three browser tabs on one laptop" check from PLAN.md, minus the
// browser: the clients speak exactly what public/app.js speaks.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { startServer } = require('../server/index');

function client(url) {
  const ws = new WebSocket(url);
  const c = { ws, inbox: [], all: [], welcome: null, state: null };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    c.inbox.push(m);
    c.all.push(m);
    if (m.type === 'welcome') c.welcome = m;
    if (m.type === 'room_state') c.state = m;
  });
  c.send = (type, payload) => ws.send(JSON.stringify({ type, payload }));
  // Wait for the next message matching `pred`, consuming the inbox up to it.
  c.next = (pred, ms = 6000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll() {
        const i = c.inbox.findIndex(pred);
        if (i >= 0) {
          const [hit] = c.inbox.splice(0, i + 1).slice(-1);
          return resolve(hit);
        }
        if (Date.now() - t0 > ms) return reject(new Error('timed out waiting for message'));
        setTimeout(poll, 5);
      })();
    });
  c.open = () => new Promise((resolve) => ws.on('open', resolve));
  c.close = () => new Promise((resolve) => {
    ws.on('close', resolve);
    ws.close();
  });
  return c;
}

const car = (emoji, colour) => ({ emoji, colour });

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

test('serves the pages', async () => {
  const srv = await startServer({ port: 0, log: () => {} });
  try {
    const home = await get(`${srv.url}/`);
    assert.equal(home.status, 200);
    assert.match(home.body, /Speed Math/);
    const join = await get(`${srv.url}/join/FROG`);
    assert.equal(join.status, 200);
    assert.match(join.body, /screen-home/);
    const tv = await get(`${srv.url}/tv/FROG`);
    assert.equal(tv.status, 200);
    assert.match(tv.body, /tv-track/);
    assert.equal((await get(`${srv.url}/healthz`)).body, 'ok');
    assert.equal((await get(`${srv.url}/app.js`)).status, 200);
  } finally {
    await srv.close();
  }
});

test('three clients race to the finish and the podium shows the right order', async () => {
  const srv = await startServer({ port: 0, log: () => {} });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const [ava, ben, cal] = [client(url), client(url), client(url)];
  try {
    await Promise.all([ava.open(), ben.open(), cal.open()]);

    ava.send('create_room', { name: 'Ava', car: car('🚗', '#ef4444'), level: 1, settings: { length: 10, flagTimerSec: 10 } });
    const welcome = await ava.next((m) => m.type === 'welcome');
    assert.match(welcome.code, /^[A-Z]{4}$/);
    assert.match(welcome.joinUrl, new RegExp(`/join/${welcome.code}$`));
    assert.match(welcome.tvUrl, new RegExp(`/tv/${welcome.code}$`));
    assert.match(welcome.qrDataUrl, /^data:image\/png;base64,/);
    const code = welcome.code;

    assert.equal(ava.state.players.length, 1);
    const bad = client(url);
    await bad.open();
    bad.send('join_room', { code: 'ZZZZ', name: 'X', car: car('🚗', '#ef4444'), level: 1 });
    const err = await bad.next((m) => m.type === 'error');
    assert.equal(err.code, 'ROOM_NOT_FOUND');
    await bad.close();

    ben.send('join_room', { code, name: 'Ben', car: car('🚕', '#22c55e'), level: 2 });
    cal.send('join_room', { code: code.toLowerCase(), name: 'Cal', car: car('🏎️', '#3b82f6'), level: 1 });
    await ben.next((m) => m.type === 'welcome');
    await cal.next((m) => m.type === 'welcome');
    const lobby = await ava.next((m) => m.type === 'room_state' && m.players.length === 3);
    assert.equal(lobby.phase, 'lobby');
    assert.equal(lobby.you, welcome.playerId);
    assert.equal(lobby.hostId, welcome.playerId);

    // Non-host cannot start; host can.
    ben.send('start_race');
    assert.match((await ben.next((m) => m.type === 'error')).message, /host/);
    ava.send('start_race');
    for (const c of [ava, ben, cal]) {
      for (const n of [3, 2, 1, 0]) {
        const cd = await c.next((m) => m.type === 'countdown');
        assert.equal(cd.secondsLeft, n);
      }
    }
    const room = srv.rooms.get(code);
    assert.equal(room.phase, 'racing');
    const racing = await ava.next((m) => m.type === 'room_state' && m.phase === 'racing');
    assert.equal(typeof racing.raceElapsedMs, 'number');

    // Everyone gets a question; the answer itself never travels to the client.
    const qa = await ava.next((m) => m.type === 'question');
    const qb = await ben.next((m) => m.type === 'question');
    const qc = await cal.next((m) => m.type === 'question');
    assert.equal(qa.index, 0);
    assert.equal(qa.text, qc.text, 'same level, same sequence');
    assert.notEqual(qa.text, qb.text, 'different level, different sequence');
    assert.equal('answer' in qa, false);

    const answersFor = (c) => room.questionsFor(c.state.players.find((p) => p.id === c.welcome.playerId).level);

    async function play(c, { count, wrongAt = -1, firstQuestion }) {
      const qs = answersFor(c);
      let q = firstQuestion;
      for (let i = 0; i < count; i++) {
        assert.equal(q.index, i);
        assert.equal(q.answerLength, String(qs[i].answer).length);
        if (i === wrongAt) {
          c.send('answer', { questionIndex: i, value: String(qs[i].answer + 1) });
          const r = await c.next((m) => m.type === 'answer_result');
          assert.equal(r.correct, false);
          assert.equal(r.stallMs, 1500);
          // Answering during the stall is ignored (no reply at all).
          c.send('answer', { questionIndex: i, value: String(qs[i].answer) });
          await new Promise((res) => setTimeout(res, r.stallMs + 30));
          assert.equal(c.inbox.some((m) => m.type === 'answer_result'), false);
        }
        c.send('answer', { questionIndex: i, value: String(qs[i].answer) });
        const r = await c.next((m) => m.type === 'answer_result');
        assert.equal(r.correct, true, `question ${i}`);
        if (i < count - 1) q = await c.next((m) => m.type === 'question');
      }
    }

    await play(ava, { count: 10, firstQuestion: qa });
    const flag = await cal.next((m) => m.type === 'flag_timer');
    assert.equal(flag.seconds, 10);
    assert.equal(flag.winnerId, welcome.playerId);
    await Promise.all([play(ben, { count: 10, wrongAt: 2, firstQuestion: qb }), play(cal, { count: 4, firstQuestion: qc })]);
    // Cal stops at 4; the flag timer closes the race.
    const fin = await cal.next((m) => m.type === 'race_finished', 15000);
    assert.equal(fin.reason, 'flag');
    assert.deepEqual(fin.ranking.map((r) => [r.place, r.name, r.finished]), [[1, 'Ava', true], [2, 'Ben', true], [3, 'Cal', false]]);
    assert.ok(fin.ranking[0].timeMs < fin.ranking[1].timeMs);
    assert.equal(fin.ranking[1].wrong, 1);
    assert.equal(Math.round(fin.ranking[1].accuracy * 100), 91);
    assert.equal(fin.ranking[2].progress, 4);
    const podium = await ava.next((m) => m.type === 'room_state' && m.phase === 'finished');
    assert.equal(podium.ranking.length, 3);
    assert.equal(podium.lastWinnerId, welcome.playerId);

    // Everyone saw every car move.
    const moves = ben.all.filter((m) => m.type === 'progress');
    assert.equal(moves.filter((m) => m.playerId === welcome.playerId).length, 10);
    assert.equal(moves.some((m) => m.skid), true);

    // Ben refreshes: same player, same car, after reconnecting with the token.
    const token = ben.welcome.token;
    await ben.close();
    await ava.next((m) => m.type === 'room_state' && m.players.some((p) => p.name === 'Ben' && !p.connected));
    const ben2 = client(url);
    await ben2.open();
    ben2.send('join_room', { code, token });
    const w2 = await ben2.next((m) => m.type === 'welcome');
    assert.equal(w2.playerId, ben.welcome.playerId);
    const back = await ben2.next((m) => m.type === 'room_state');
    assert.equal(back.phase, 'finished');
    assert.equal(back.players.filter((p) => p.name === 'Ben').length, 1);

    // A TV joins and sees the finished state with the ranking.
    const tv = client(url);
    await tv.open();
    tv.send('watch_room', { code });
    const watching = await tv.next((m) => m.type === 'watching');
    assert.equal(watching.code, code);
    const tvState = await tv.next((m) => m.type === 'room_state');
    assert.equal(tvState.you, null);
    assert.equal(tvState.ranking.length, 3);

    // Race again → new countdown for players and TV alike.
    ava.send('race_again');
    assert.equal((await tv.next((m) => m.type === 'countdown')).secondsLeft, 3);
    assert.equal((await ben2.next((m) => m.type === 'countdown')).secondsLeft, 3);
    ava.send('end_race');
    assert.equal((await tv.next((m) => m.type === 'race_finished')).reason, 'host');

    // Back to garage, leave.
    ava.send('back_to_lobby');
    assert.equal((await cal.next((m) => m.type === 'room_state' && m.phase === 'lobby')).phase, 'lobby');
    cal.send('leave_room');
    await cal.next((m) => m.type === 'left');
    await ava.next((m) => m.type === 'room_state' && m.players.length === 2);
    await tv.close();
    await ben2.close();
  } finally {
    await Promise.all([ava, ben, cal].map((c) => (c.ws.readyState === WebSocket.OPEN ? c.close() : null)));
    await srv.close();
  }
});

test('rejects garbage and unknown messages without dropping the connection', async () => {
  const srv = await startServer({ port: 0, log: () => {} });
  const c = client(`ws://127.0.0.1:${srv.port}/ws`);
  try {
    await c.open();
    c.ws.send('not json');
    assert.match((await c.next((m) => m.type === 'error')).message, /JSON/);
    c.send('start_race');
    assert.match((await c.next((m) => m.type === 'error')).message, /join a race first/);
    c.send('create_room', { name: 'crap', car: {}, level: 1 });
    assert.match((await c.next((m) => m.type === 'error')).message, /nickname/);
    c.send('ping');
    assert.equal((await c.next((m) => m.type === 'pong')).type, 'pong');
  } finally {
    await c.close();
    await srv.close();
  }
});
