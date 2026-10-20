'use strict';

// Room: players, phase, settings and timers for one race room.
//
// The room never touches sockets. It emits:
//   'send'      (playerId, message)  → deliver to one player
//   'broadcast' (message)            → deliver to every player and watcher
//   'changed'   ()                   → room_state should be (re)sent to everyone
//
// Timers and the clock are injectable (`deps`) so tests can drive them.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { generate } = require('./questions');
const {
  validateSettings,
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  STALL_MS,
  COUNTDOWN_SECONDS,
} = require('./protocol');

const PHASES = ['lobby', 'countdown', 'racing', 'finished'];
const HOST_GRACE_MS = 5000; // how long a dropped host keeps the badge
const DISCONNECT_TTL_MS = 2 * 60 * 1000; // dropped players are pruned after this
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000; // room deleted after this with nobody connected

const defaultDeps = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  randomSeed: () => crypto.randomInt(0, 2 ** 31),
  randomId: () => crypto.randomBytes(4).toString('hex'),
  randomToken: () => crypto.randomBytes(16).toString('hex'),
};

function ok(extra = {}) {
  return { ok: true, ...extra };
}
function fail(error) {
  return { ok: false, error };
}

class Room extends EventEmitter {
  constructor({ code, settings, deps } = {}) {
    super();
    this.deps = { ...defaultDeps, ...(deps || {}) };
    this.code = code;
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this.phase = 'lobby';
    this.players = new Map(); // id → player
    this.hostId = null;
    this.lastWinnerId = null;
    this.createdAt = this.deps.now();
    this.emptySince = this.createdAt;
    this.seed = null;
    this.questions = new Map(); // level → [{ text, answer }]
    this.raceStartedAt = null;
    this.ranking = null;
    this.timers = { countdown: null, flag: null, hostGrace: null };
    this.endReason = null;
  }

  // ---- players ---------------------------------------------------------------

  get playerCount() {
    return this.players.size;
  }

  get connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n += 1;
    return n;
  }

  isHost(playerId) {
    return playerId === this.hostId;
  }

  getPlayer(playerId) {
    return this.players.get(playerId) || null;
  }

  findByToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  addPlayer({ name, car, level }) {
    if (this.players.size >= MAX_PLAYERS) return fail('room is full (12 players)');
    const now = this.deps.now();
    const player = {
      id: this.deps.randomId(),
      token: this.deps.randomToken(),
      name,
      car,
      level: this.settings.lockLevel || level,
      connected: true,
      joinedAt: now,
      connectedSince: now,
      disconnectedAt: null,
      pruneTimer: null,
      spectator: this.phase === 'countdown' || this.phase === 'racing',
      ...freshRaceStats(),
    };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.touchEmpty();
    this.ensureHost();
    this.emit('changed');
    return ok({ player });
  }

  // Reconnect a player by token. Returns the player or null.
  reconnect(token) {
    const player = this.findByToken(token);
    if (!player) return null;
    player.connected = true;
    player.connectedSince = this.deps.now();
    player.disconnectedAt = null;
    if (player.pruneTimer) {
      this.deps.clearTimeout(player.pruneTimer);
      player.pruneTimer = null;
    }
    this.touchEmpty();
    this.ensureHost();
    this.emit('changed');
    return player;
  }

  disconnect(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.connected) return;
    player.connected = false;
    player.disconnectedAt = this.deps.now();
    player.pruneTimer = this.deps.setTimeout(() => {
      player.pruneTimer = null;
      if (!player.connected) this.removePlayer(player.id);
    }, DISCONNECT_TTL_MS);
    if (player.id === this.hostId) {
      if (this.timers.hostGrace) this.deps.clearTimeout(this.timers.hostGrace);
      this.timers.hostGrace = this.deps.setTimeout(() => {
        this.timers.hostGrace = null;
        this.ensureHost();
        this.emit('changed');
      }, HOST_GRACE_MS);
    }
    this.touchEmpty();
    this.emit('changed');
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.pruneTimer) this.deps.clearTimeout(player.pruneTimer);
    this.players.delete(playerId);
    if (this.hostId === playerId) {
      this.hostId = null;
      this.ensureHost();
    }
    this.touchEmpty();
    if (this.phase === 'racing') this.checkAllFinished();
    this.emit('changed');
  }

  // Make sure the host badge sits on a connected player (longest-connected wins)
  // unless the current host is only briefly gone (grace timer pending).
  ensureHost() {
    const host = this.hostId ? this.players.get(this.hostId) : null;
    if (host && host.connected) return;
    if (host && !host.connected && this.timers.hostGrace) return; // give them a moment
    let best = null;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (!best || p.connectedSince < best.connectedSince) best = p;
    }
    if (best) {
      this.hostId = best.id;
      if (this.timers.hostGrace) {
        this.deps.clearTimeout(this.timers.hostGrace);
        this.timers.hostGrace = null;
      }
    } else if (!host) {
      this.hostId = null;
    }
  }

  // Track when the room last became empty; pruning already-dropped players
  // must not restart that clock.
  touchEmpty() {
    if (this.connectedCount > 0) this.emptySince = null;
    else if (this.emptySince === null) this.emptySince = this.deps.now();
  }

  isExpired(now = this.deps.now()) {
    return this.emptySince !== null && now - this.emptySince >= EMPTY_ROOM_TTL_MS;
  }

  // ---- lobby actions -----------------------------------------------------------

  updateSettings(playerId, partial) {
    if (!this.isHost(playerId)) return fail('only the host can change settings');
    if (this.phase === 'countdown' || this.phase === 'racing') return fail('wait for the race to end');
    const v = validateSettings(partial, this.settings);
    if (!v.ok) return v;
    this.settings = v.settings;
    if (this.settings.lockLevel) {
      for (const p of this.players.values()) p.level = this.settings.lockLevel;
    }
    this.emit('changed');
    return ok({ settings: this.settings });
  }

  setLevel(playerId, level) {
    const player = this.players.get(playerId);
    if (!player) return fail('not in this room');
    if (this.phase === 'countdown' || this.phase === 'racing') return fail('wait for the race to end');
    if (this.settings.lockLevel && level !== this.settings.lockLevel) return fail('the host locked the level');
    player.level = level;
    this.emit('changed');
    return ok();
  }

  // ---- race lifecycle ----------------------------------------------------------

  start(playerId) {
    if (!this.isHost(playerId)) return fail('only the host can start');
    if (this.phase === 'countdown' || this.phase === 'racing') return fail('race already running');
    this.beginCountdown();
    return ok();
  }

  beginCountdown() {
    this.clearRaceTimers();
    this.phase = 'countdown';
    this.endReason = null;
    this.ranking = null;
    this.raceStartedAt = null;
    this.seed = this.deps.randomSeed();
    this.questions = new Map();
    for (const p of this.players.values()) {
      Object.assign(p, freshRaceStats());
      p.spectator = false;
      this.questionsFor(p.level);
    }
    this.emit('changed');
    this.tickCountdown(COUNTDOWN_SECONDS);
  }

  tickCountdown(secondsLeft) {
    this.emit('broadcast', { type: 'countdown', secondsLeft });
    if (secondsLeft === 0) {
      this.beginRacing();
      return;
    }
    this.timers.countdown = this.deps.setTimeout(() => {
      this.timers.countdown = null;
      this.tickCountdown(secondsLeft - 1);
    }, 1000);
  }

  beginRacing() {
    this.phase = 'racing';
    this.raceStartedAt = this.deps.now();
    this.emit('changed');
    for (const p of this.players.values()) {
      if (!p.spectator) this.sendQuestion(p);
    }
  }

  questionsFor(level) {
    if (!this.questions.has(level)) {
      this.questions.set(level, generate(this.seed, level, this.settings.ops, this.settings.length));
    }
    return this.questions.get(level);
  }

  sendQuestion(player) {
    const list = this.questionsFor(player.level);
    const q = list[player.progress];
    if (!q) return;
    this.emit('send', player.id, {
      type: 'question',
      index: player.progress,
      text: q.text,
      answerLength: String(q.answer).length,
      total: list.length,
    });
  }

  answer(playerId, questionIndex, value) {
    const player = this.players.get(playerId);
    if (!player) return fail('not in this room');
    if (this.phase !== 'racing') return fail('no race running');
    if (player.spectator) return fail('you joined mid-race; wait for the next one');
    if (player.finishedAt !== null) return fail('you already finished');
    if (questionIndex !== player.progress) return fail('stale question');
    const now = this.deps.now();
    if (player.lockedUntil && now < player.lockedUntil) return fail('skidding');

    const q = this.questionsFor(player.level)[questionIndex];
    const correct = value === q.answer;
    let stallMs = 0;
    if (correct) {
      player.progress += 1;
      player.correct += 1;
      player.streak += 1;
      if (player.streak > player.bestStreak) player.bestStreak = player.streak;
      player.lockedUntil = 0;
    } else {
      player.wrong += 1;
      player.streak = 0;
      stallMs = STALL_MS;
      player.lockedUntil = now + stallMs;
    }
    const total = this.settings.length;
    const finished = player.progress >= total;
    if (finished) player.finishedAt = now - this.raceStartedAt;

    this.emit('send', playerId, { type: 'answer_result', index: questionIndex, correct, stallMs, streak: player.streak });
    this.emit('broadcast', {
      type: 'progress',
      playerId,
      progress: player.progress,
      total,
      streak: player.streak,
      skid: !correct,
      finished,
      timeMs: finished ? player.finishedAt : null,
    });

    if (finished) {
      this.onPlayerFinished(player);
    } else if (correct) {
      this.sendQuestion(player);
    }
    return ok({ correct, stallMs });
  }

  onPlayerFinished(player) {
    const finishers = [...this.players.values()].filter((p) => p.finishedAt !== null);
    if (finishers.length === 1) {
      this.lastWinnerId = player.id;
      const seconds = this.settings.flagTimerSec;
      this.emit('broadcast', { type: 'flag_timer', seconds, winnerId: player.id });
      this.timers.flag = this.deps.setTimeout(() => {
        this.timers.flag = null;
        this.finish('flag');
      }, seconds * 1000);
    }
    this.checkAllFinished();
  }

  checkAllFinished() {
    if (this.phase !== 'racing') return;
    const racers = [...this.players.values()].filter((p) => !p.spectator);
    if (racers.length > 0 && racers.every((p) => p.finishedAt !== null)) this.finish('all');
  }

  endRace(playerId) {
    if (!this.isHost(playerId)) return fail('only the host can end the race');
    if (this.phase !== 'racing' && this.phase !== 'countdown') return fail('no race running');
    this.finish('host');
    return ok();
  }

  finish(reason) {
    if (this.phase !== 'racing' && this.phase !== 'countdown') return;
    this.clearRaceTimers();
    this.phase = 'finished';
    this.endReason = reason;
    this.ranking = this.computeRanking();
    if (this.ranking.length > 0 && this.ranking[0].finished) this.lastWinnerId = this.ranking[0].playerId;
    this.emit('broadcast', { type: 'race_finished', reason, ranking: this.ranking });
    this.emit('changed');
  }

  computeRanking() {
    const racers = [...this.players.values()].filter((p) => !p.spectator);
    racers.sort((a, b) => {
      const af = a.finishedAt !== null;
      const bf = b.finishedAt !== null;
      if (af && bf) return a.finishedAt - b.finishedAt;
      if (af !== bf) return af ? -1 : 1;
      if (b.progress !== a.progress) return b.progress - a.progress;
      if (b.correct !== a.correct) return b.correct - a.correct;
      return a.joinedAt - b.joinedAt;
    });
    return racers.map((p, i) => ({
      place: i + 1,
      playerId: p.id,
      name: p.name,
      car: p.car,
      level: p.level,
      finished: p.finishedAt !== null,
      timeMs: p.finishedAt,
      progress: p.progress,
      total: this.settings.length,
      correct: p.correct,
      wrong: p.wrong,
      accuracy: p.correct + p.wrong > 0 ? p.correct / (p.correct + p.wrong) : null,
      bestStreak: p.bestStreak,
    }));
  }

  raceAgain(playerId) {
    if (!this.isHost(playerId)) return fail('only the host can restart');
    if (this.phase !== 'finished') return fail('finish the race first');
    this.beginCountdown();
    return ok();
  }

  backToLobby(playerId) {
    if (!this.isHost(playerId)) return fail('only the host can do that');
    if (this.phase !== 'finished') return fail('finish the race first');
    this.phase = 'lobby';
    this.ranking = null;
    this.raceStartedAt = null;
    for (const p of this.players.values()) {
      Object.assign(p, freshRaceStats());
      p.spectator = false;
    }
    this.emit('changed');
    return ok();
  }

  clearRaceTimers() {
    for (const key of ['countdown', 'flag']) {
      if (this.timers[key]) {
        this.deps.clearTimeout(this.timers[key]);
        this.timers[key] = null;
      }
    }
  }

  destroy() {
    this.clearRaceTimers();
    if (this.timers.hostGrace) this.deps.clearTimeout(this.timers.hostGrace);
    for (const p of this.players.values()) if (p.pruneTimer) this.deps.clearTimeout(p.pruneTimer);
    this.players.clear();
    this.removeAllListeners();
  }

  // ---- snapshot ----------------------------------------------------------------

  toState() {
    const now = this.deps.now();
    return {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      hostId: this.hostId,
      lastWinnerId: this.lastWinnerId,
      raceLength: this.settings.length,
      raceElapsedMs: this.phase === 'racing' && this.raceStartedAt !== null ? now - this.raceStartedAt : null,
      endReason: this.endReason,
      ranking: this.phase === 'finished' ? this.ranking : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        car: p.car,
        level: p.level,
        progress: p.progress,
        streak: p.streak,
        finished: p.finishedAt !== null,
        timeMs: p.finishedAt,
        isHost: p.id === this.hostId,
        connected: p.connected,
        spectator: p.spectator,
      })),
    };
  }
}

function freshRaceStats() {
  return {
    progress: 0,
    correct: 0,
    wrong: 0,
    streak: 0,
    bestStreak: 0,
    finishedAt: null,
    lockedUntil: 0,
  };
}

module.exports = { Room, PHASES, HOST_GRACE_MS, DISCONNECT_TTL_MS, EMPTY_ROOM_TTL_MS };
