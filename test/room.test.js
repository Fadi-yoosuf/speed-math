'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, HOST_GRACE_MS, DISCONNECT_TTL_MS, EMPTY_ROOM_TTL_MS } = require('../server/room');
const { RoomRegistry } = require('../server/rooms');
const { STALL_MS, MAX_PLAYERS } = require('../server/protocol');
const { fakeDeps, recorder, car } = require('./helpers');

function setup({ settings, players = ['Ava', 'Ben', 'Cal'], levels = {} } = {}) {
  const deps = fakeDeps();
  const room = new Room({ code: 'FROG', settings: { length: 10, flagTimerSec: 20, ...settings }, deps });
  const rec = recorder(room);
  const ids = {};
  for (const name of players) {
    const r = room.addPlayer({ name, car: car(), level: levels[name] || 1 });
    assert.equal(r.ok, true);
    ids[name] = r.player.id;
  }
  return { deps, room, rec, ids };
}

// Drive the countdown to GO.
function startRace(room, deps, hostId) {
  assert.equal(room.start(hostId).ok, true);
  deps.advance(3000);
  assert.equal(room.phase, 'racing');
}

function answerAll(room, rec, playerId, count) {
  const player = room.getPlayer(playerId);
  const qs = room.questionsFor(player.level);
  for (let i = 0; i < count; i++) {
    const q = rec.lastQuestion(playerId);
    assert.equal(q.index, i);
    assert.equal(q.text, qs[i].text);
    const r = room.answer(playerId, i, qs[i].answer);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.correct, true);
  }
}

test('first player becomes host; later players do not', () => {
  const { room, ids } = setup();
  assert.equal(room.hostId, ids.Ava);
  assert.equal(room.isHost(ids.Ben), false);
  const s = room.toState();
  assert.equal(s.phase, 'lobby');
  assert.equal(s.players.find((p) => p.id === ids.Ava).isHost, true);
  assert.equal(s.players.length, 3);
});

test('room holds at most 12 players', () => {
  const { room } = setup({ players: [] });
  for (let i = 0; i < MAX_PLAYERS; i++) assert.equal(room.addPlayer({ name: `P${i}`, car: car(), level: 1 }).ok, true);
  const r = room.addPlayer({ name: 'Late', car: car(), level: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /full/);
});

test('only the host can change settings or start, and not mid-race', () => {
  const { room, ids, deps } = setup();
  assert.equal(room.updateSettings(ids.Ben, { length: 30 }).ok, false);
  assert.equal(room.start(ids.Ben).ok, false);
  assert.equal(room.updateSettings(ids.Ava, { length: 30, ops: ['mul'] }).ok, true);
  assert.equal(room.settings.length, 30);
  assert.deepEqual(room.settings.ops, ['mul']);
  assert.equal(room.updateSettings(ids.Ava, { length: 11 }).ok, false);
  startRace(room, deps, ids.Ava);
  assert.equal(room.updateSettings(ids.Ava, { length: 10 }).ok, false);
  assert.equal(room.start(ids.Ava).ok, false);
});

test('locking the level moves everyone to it and blocks level changes', () => {
  const { room, ids } = setup({ levels: { Ava: 1, Ben: 3, Cal: 4 } });
  assert.equal(room.setLevel(ids.Ben, 2).ok, true);
  assert.equal(room.getPlayer(ids.Ben).level, 2);
  assert.equal(room.updateSettings(ids.Ava, { lockLevel: 3 }).ok, true);
  for (const id of Object.values(ids)) assert.equal(room.getPlayer(id).level, 3);
  assert.equal(room.setLevel(ids.Ben, 1).ok, false);
  const late = room.addPlayer({ name: 'Dee', car: car(), level: 1 });
  assert.equal(late.player.level, 3);
});

test('start runs a 3-2-1-GO countdown, then hands each player their first question', () => {
  const { room, ids, deps, rec } = setup({ levels: { Ava: 1, Ben: 1, Cal: 3 } });
  assert.equal(room.start(ids.Ava).ok, true);
  assert.equal(room.phase, 'countdown');
  assert.deepEqual(rec.ofType('countdown').map((m) => m.secondsLeft), [3]);
  deps.advance(1000);
  assert.deepEqual(rec.ofType('countdown').map((m) => m.secondsLeft), [3, 2]);
  deps.advance(1000);
  deps.advance(999);
  assert.equal(room.phase, 'countdown');
  deps.advance(1);
  assert.equal(room.phase, 'racing');
  assert.deepEqual(rec.ofType('countdown').map((m) => m.secondsLeft), [3, 2, 1, 0]);
  const qa = rec.lastQuestion(ids.Ava);
  const qb = rec.lastQuestion(ids.Ben);
  const qc = rec.lastQuestion(ids.Cal);
  assert.equal(qa.index, 0);
  assert.equal(qa.total, 10);
  assert.equal(qa.text, qb.text, 'same level → same questions');
  assert.ok(qa.answerLength >= 1);
  assert.notEqual(qa.text, qc.text, 'different level → different questions');
  assert.equal(qa.answer, undefined, 'the client never receives the answer');
});

test('correct answers move the car; the last one records a finish time', () => {
  const { room, ids, deps, rec } = setup({ players: ['Ava'] });
  startRace(room, deps, ids.Ava);
  const qs = room.questionsFor(1);
  deps.advance(2500);
  const r = room.answer(ids.Ava, 0, qs[0].answer);
  assert.deepEqual(r, { ok: true, correct: true, stallMs: 0 });
  const prog = rec.ofType('progress');
  assert.equal(prog.length, 1);
  assert.equal(prog[0].progress, 1);
  assert.equal(prog[0].skid, false);
  assert.equal(rec.lastQuestion(ids.Ava).index, 1);
  for (let i = 1; i < 10; i++) room.answer(ids.Ava, i, qs[i].answer);
  const p = room.getPlayer(ids.Ava);
  assert.equal(p.progress, 10);
  assert.equal(p.finishedAt, 2500);
  assert.equal(room.phase, 'finished', 'solo race ends when its only racer finishes');
  assert.equal(room.endReason, 'all');
});

test('a wrong answer skids: stall, streak reset, same question stays', () => {
  const { room, ids, deps, rec } = setup({ players: ['Ava'] });
  startRace(room, deps, ids.Ava);
  const qs = room.questionsFor(1);
  room.answer(ids.Ava, 0, qs[0].answer);
  room.answer(ids.Ava, 1, qs[1].answer);
  assert.equal(room.getPlayer(ids.Ava).streak, 2);
  rec.clear();
  const wrong = room.answer(ids.Ava, 2, qs[2].answer + 1);
  assert.deepEqual(wrong, { ok: true, correct: false, stallMs: STALL_MS });
  const p = room.getPlayer(ids.Ava);
  assert.equal(p.progress, 2);
  assert.equal(p.streak, 0);
  assert.equal(p.bestStreak, 2);
  assert.equal(p.wrong, 1);
  assert.equal(rec.ofType('progress')[0].skid, true);
  assert.equal(rec.sentTo(ids.Ava, 'question').length, 0, 'no new question after a wrong answer');
  // locked during the stall
  deps.advance(STALL_MS - 1);
  assert.equal(room.answer(ids.Ava, 2, qs[2].answer).ok, false);
  deps.advance(1);
  assert.equal(room.answer(ids.Ava, 2, qs[2].answer).correct, true);
});

test('answers are only accepted for the current question index', () => {
  const { room, ids, deps } = setup({ players: ['Ava'] });
  assert.equal(room.answer(ids.Ava, 0, 1).ok, false, 'no race yet');
  startRace(room, deps, ids.Ava);
  const qs = room.questionsFor(1);
  assert.equal(room.answer(ids.Ava, 1, qs[1].answer).ok, false, 'ahead');
  room.answer(ids.Ava, 0, qs[0].answer);
  assert.equal(room.answer(ids.Ava, 0, qs[0].answer).ok, false, 'stale');
  assert.equal(room.answer('nobody', 1, 1).ok, false);
});

test('podium order: finishers by time, then the rest by progress', () => {
  const { room, ids, deps, rec } = setup({ settings: { flagTimerSec: 20 } });
  startRace(room, deps, ids.Ava);
  const qs = room.questionsFor(1);
  // Cal finishes first, Ava second, Ben does 4
  deps.advance(1000);
  answerAll(room, rec, ids.Cal, 10);
  assert.equal(room.phase, 'racing');
  assert.equal(rec.ofType('flag_timer').length, 1);
  assert.equal(rec.ofType('flag_timer')[0].seconds, 20);
  deps.advance(2000);
  answerAll(room, rec, ids.Ava, 10);
  for (let i = 0; i < 4; i++) room.answer(ids.Ben, i, qs[i].answer);
  deps.advance(20000);
  assert.equal(room.phase, 'finished');
  assert.equal(room.endReason, 'flag');
  const ranking = rec.ofType('race_finished')[0].ranking;
  assert.deepEqual(ranking.map((r) => [r.place, r.name, r.finished]), [[1, 'Cal', true], [2, 'Ava', true], [3, 'Ben', false]]);
  assert.equal(ranking[0].timeMs, 1000);
  assert.equal(ranking[1].timeMs, 3000);
  assert.equal(ranking[2].progress, 4);
  assert.equal(ranking[0].accuracy, 1);
  assert.equal(ranking[0].bestStreak, 10);
  assert.equal(room.lastWinnerId, ids.Cal);
  assert.equal(room.toState().ranking.length, 3, 'ranking is part of the finished state for late joiners');
});

test('race ends as soon as every racer has finished', () => {
  const { room, ids, deps, rec } = setup({ players: ['Ava', 'Ben'] });
  startRace(room, deps, ids.Ava);
  answerAll(room, rec, ids.Ava, 10);
  assert.equal(room.phase, 'racing');
  answerAll(room, rec, ids.Ben, 10);
  assert.equal(room.phase, 'finished');
  assert.equal(room.endReason, 'all');
  assert.equal(deps.pendingTimers(), 0, 'flag timer is cleared');
});

test('host can end the race early; ranking reflects progress', () => {
  const { room, ids, deps } = setup();
  startRace(room, deps, ids.Ava);
  const qs = room.questionsFor(1);
  room.answer(ids.Ben, 0, qs[0].answer);
  assert.equal(room.endRace(ids.Ben).ok, false);
  assert.equal(room.endRace(ids.Ava).ok, true);
  assert.equal(room.phase, 'finished');
  assert.equal(room.endReason, 'host');
  assert.equal(room.ranking[0].name, 'Ben');
  assert.equal(room.ranking[0].finished, false);
  assert.equal(room.lastWinnerId, null, 'nobody crossed the line');
});

test('players joining mid-race spectate, cannot answer, and race next time', () => {
  const { room, ids, deps, rec } = setup({ players: ['Ava'] });
  startRace(room, deps, ids.Ava);
  const late = room.addPlayer({ name: 'Dee', car: car(), level: 2 }).player;
  assert.equal(late.spectator, true);
  assert.equal(rec.sentTo(late.id, 'question').length, 0);
  assert.equal(room.answer(late.id, 0, 1).ok, false);
  answerAll(room, rec, ids.Ava, 10);
  assert.equal(room.phase, 'finished');
  assert.deepEqual(room.ranking.map((r) => r.name), ['Ava']);
  assert.equal(room.raceAgain(ids.Ava).ok, true);
  deps.advance(3000);
  assert.equal(late.spectator, false);
  assert.equal(rec.lastQuestion(late.id).index, 0);
});

test('race again uses a new seed; back to garage returns to the lobby', () => {
  const { room, ids, deps, rec } = setup({ players: ['Ava'] });
  startRace(room, deps, ids.Ava);
  const first = room.questionsFor(1).map((q) => q.text);
  answerAll(room, rec, ids.Ava, 10);
  assert.equal(room.raceAgain(ids.Ava).ok, true);
  assert.equal(room.phase, 'countdown');
  deps.advance(3000);
  const second = room.questionsFor(1).map((q) => q.text);
  assert.notDeepEqual(first, second);
  assert.equal(room.getPlayer(ids.Ava).progress, 0);
  assert.equal(room.backToLobby(ids.Ava).ok, false, 'not while racing');
  answerAll(room, rec, ids.Ava, 10);
  assert.equal(room.backToLobby(ids.Ava).ok, true);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.toState().ranking, null);
  assert.equal(room.lastWinnerId, ids.Ava, 'crown carries into the lobby');
});

test('reconnect by token restores the same player, even mid-race', () => {
  const { room, ids, deps, rec } = setup({ players: ['Ava', 'Ben'] });
  startRace(room, deps, ids.Ava);
  const qs = room.questionsFor(1);
  room.answer(ids.Ben, 0, qs[0].answer);
  const token = room.getPlayer(ids.Ben).token;
  room.disconnect(ids.Ben);
  assert.equal(room.getPlayer(ids.Ben).connected, false);
  assert.equal(room.toState().players.find((p) => p.id === ids.Ben).connected, false);
  deps.advance(10_000);
  assert.equal(room.reconnect('bogus'), null);
  const back = room.reconnect(token);
  assert.equal(back.id, ids.Ben);
  assert.equal(back.connected, true);
  assert.equal(back.progress, 1);
  room.sendQuestion(back);
  assert.equal(rec.lastQuestion(ids.Ben).index, 1);
  assert.equal(room.answer(ids.Ben, 1, qs[1].answer).correct, true);
});

test('dropped players are pruned after the disconnect TTL', () => {
  const { room, ids, deps } = setup();
  room.disconnect(ids.Cal);
  deps.advance(DISCONNECT_TTL_MS - 1);
  assert.ok(room.getPlayer(ids.Cal));
  deps.advance(1);
  assert.equal(room.getPlayer(ids.Cal), null);
  assert.equal(room.playerCount, 2);
});

test('host badge passes to the longest-connected player if the host drops', () => {
  const { room, ids, deps } = setup();
  room.disconnect(ids.Ava);
  assert.equal(room.hostId, ids.Ava, 'grace period: still host');
  deps.advance(HOST_GRACE_MS);
  assert.equal(room.hostId, ids.Ben);
  assert.equal(room.toState().players.find((p) => p.id === ids.Ben).isHost, true);
  // the old host comes back as a regular player
  room.reconnect(room.getPlayer(ids.Ava).token);
  assert.equal(room.hostId, ids.Ben);
});

test('a host who refreshes within the grace period keeps the badge', () => {
  const { room, ids, deps } = setup();
  room.disconnect(ids.Ava);
  deps.advance(HOST_GRACE_MS - 1);
  room.reconnect(room.getPlayer(ids.Ava).token);
  deps.advance(HOST_GRACE_MS);
  assert.equal(room.hostId, ids.Ava);
});

test('if everyone drops, the first to come back becomes host', () => {
  const { room, ids, deps } = setup({ players: ['Ava', 'Ben'] });
  room.disconnect(ids.Ava);
  room.disconnect(ids.Ben);
  deps.advance(HOST_GRACE_MS);
  room.reconnect(room.getPlayer(ids.Ben).token);
  assert.equal(room.hostId, ids.Ben);
});

test('removing the host hands over immediately', () => {
  const { room, ids } = setup();
  room.removePlayer(ids.Ava);
  assert.equal(room.hostId, ids.Ben);
  room.removePlayer(ids.Ben);
  room.removePlayer(ids.Cal);
  assert.equal(room.hostId, null);
  assert.equal(room.playerCount, 0);
});

test('room expires 30 minutes after the last player disconnects', () => {
  const { room, ids, deps } = setup({ players: ['Ava'] });
  assert.equal(room.isExpired(), false);
  room.disconnect(ids.Ava);
  deps.advance(EMPTY_ROOM_TTL_MS - 1);
  assert.equal(room.isExpired(), false);
  deps.advance(1);
  assert.equal(room.isExpired(), true);
  // Ava was pruned long ago; a new arrival revives the room.
  assert.equal(room.getPlayer(ids.Ava), null);
  room.addPlayer({ name: 'Ben', car: car(), level: 1 });
  assert.equal(room.isExpired(), false);
});

test('registry hands out unique kid-safe codes, caps rooms and sweeps expired ones', () => {
  const deps = fakeDeps();
  const registry = new RoomRegistry({ deps, maxRooms: 3 });
  const a = registry.create().room;
  const b = registry.create().room;
  const c = registry.create().room;
  assert.match(a.code, /^[A-Z]{4}$/);
  assert.equal(new Set([a.code, b.code, c.code]).size, 3);
  assert.equal(registry.create().ok, false);
  assert.equal(registry.get(a.code), a);
  const p = a.addPlayer({ name: 'Ava', car: car(), level: 1 }).player;
  deps.advance(EMPTY_ROOM_TTL_MS + 1);
  // b and c never had anyone; a has Ava connected
  assert.deepEqual(registry.sweep().sort(), [b.code, c.code].sort());
  assert.equal(registry.size, 1);
  a.disconnect(p.id);
  deps.advance(EMPTY_ROOM_TTL_MS);
  assert.deepEqual(registry.sweep(), [a.code]);
  assert.equal(registry.size, 0);
});
