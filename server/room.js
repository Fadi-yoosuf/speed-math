'use strict';

// Room: players, phase, settings and timers for one race room.
//
// The room never touches sockets. It emits:
//   'send'      (playerId, message)  → deliver to one player
//   'broadcast' (message)            → deliver to every player and watcher
//   'changed'   ()                   → room_state should be (re)sent to everyone
//
// Timers and the clock are injectable (`deps`) so tests can drive them.
//
// Two modes:
//   race   – first car to `length` segments wins. A correct answer moves one
//            segment; every NITRO_STREAK correct in a row adds a bonus segment
//            (if nitro is on). Head starts put a car some segments ahead.
//   sprint – most correct answers in `sprintSec` seconds. Cars lap the track.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { generate } = require('./questions');
const {
  validateSettings,
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  MAX_HANDICAP,
  NITRO_STREAK,
  STALL_MS,
  COUNTDOWN_SECONDS,
} = require('./protocol');

const PHASES = ['lobby', 'countdown', 'racing', 'finished'];
const HOST_GRACE_MS = 5000; // how long a dropped host keeps the badge
const DISCONNECT_TTL_MS = 2 * 60 * 1000; // dropped players are pruned after this
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000; // room deleted after this with nobody connected

// Sprint races need more questions than anyone can answer in the time.
function sprintQuestionCount(seconds) {
  return Math.min(300, seconds * 2 + 20);
}

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
    this.sprintEndsAt = null;
    this.ranking = null;
    this.timers = { countdown: null, flag: null, sprint: null, hostGrace: null };
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

  get mode() {
    return this.settings.mode;
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
      handicap: 0,
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

  get inRace() {
    return this.phase === 'countdown' || this.phase === 'racing';
  }

  updateSettings(playerId, partial) {
    if (!this.isHost(playerId)) return fail('only the host can change settings');
    if (this.inRace) return fail('wait for the race to end');
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
    if (this.inRace) return fail('wait for the race to end');
    if (this.settings.lockLevel && level !== this.settings.lockLevel) return fail('the host locked the level');
    player.level = level;
    this.emit('changed');
    return ok();
  }

  // Head start: the host can put a car a few segments ahead for the next race.
  setHandicap(hostId, playerId, segments) {
    if (!this.isHost(hostId)) return fail('only the host can give head starts');
    if (this.inRace) return fail('wait for the race to end');
    const player = this.players.get(playerId);
    if (!player) return fail('no such player');
    if (!Number.isInteger(segments) || segments < 0 || segments > MAX_HANDICAP) return fail(`head start must be 0-${MAX_HANDICAP}`);
    player.handicap = segments;
    this.emit('changed');
    return ok();
  }

  // ---- race lifecycle ----------------------------------------------------------

  start(playerId) {
    if (!this.isHost(playerId)) return fail('only the host can start');
    if (this.inRace) return fail('race already running');
    this.beginCountdown();
    return ok();
  }

  beginCountdown() {
    this.clearRaceTimers();
    this.phase = 'countdown';
    this.endReason = null;
    this.ranking = null;
    this.raceStartedAt = null;
    this.sprintEndsAt = null;
    this.seed = this.deps.randomSeed();
    this.questions = new Map();
    for (const p of this.players.values()) {
      Object.assign(p, freshRaceStats());
      p.spectator = false;
      if (this.mode === 'race') p.progress = Math.min(p.handicap, this.settings.length - 1);
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
    if (this.mode === 'sprint') {
      const ms = this.settings.sprintSec * 1000;
      this.sprintEndsAt = this.raceStartedAt + ms;
      this.timers.sprint = this.deps.setTimeout(() => {
        this.timers.sprint = null;
        this.finish('time');
      }, ms);
    }
    this.emit('changed');
    for (const p of this.players.values()) {
      if (!p.spectator) this.sendQuestion(p);
    }
  }

  questionCount() {
    return this.mode === 'sprint' ? sprintQuestionCount(this.settings.sprintSec) : this.settings.length;
  }

  questionsFor(level) {
    if (!this.questions.has(level)) {
      this.questions.set(level, generate(this.seed, level, this.settings.ops, this.questionCount()));
    }
    return this.questions.get(level);
  }

  sendQuestion(player) {
    const list = this.questionsFor(player.level);
    const q = list[player.qIndex];
    if (!q) return;
    player.questionSentAt = this.deps.now();
    this.emit('send', player.id, {
      type: 'question',
      index: player.qIndex,
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
    if (questionIndex !== player.qIndex) return fail('stale question');
    const now = this.deps.now();
    if (player.lockedUntil && now < player.lockedUntil) return fail('skidding');

    const q = this.questionsFor(player.level)[questionIndex];
    const correct = value === q.answer;
    let stallMs = 0;
    let nitro = false;
    if (correct) {
      player.qIndex += 1;
      player.correct += 1;
      player.progress += 1;
      player.streak += 1;
      if (player.streak > player.bestStreak) player.bestStreak = player.streak;
      const dt = now - player.questionSentAt;
      if (player.fastestMs === null || dt < player.fastestMs) player.fastestMs = dt;
      if (this.settings.nitro && this.mode === 'race' && player.streak % NITRO_STREAK === 0) {
        player.progress += 1;
        player.nitros += 1;
        nitro = true;
      }
      player.lockedUntil = 0;
    } else {
      player.wrong += 1;
      player.streak = 0;
      stallMs = STALL_MS;
      player.lockedUntil = now + stallMs;
    }
    const total = this.settings.length;
    const finished = this.mode === 'race' && player.progress >= total;
    if (finished) {
      player.progress = total;
      player.finishedAt = now - this.raceStartedAt;
    }

    this.emit('send', playerId, { type: 'answer_result', index: questionIndex, correct, stallMs, streak: player.streak, nitro });
    this.emit('broadcast', {
      type: 'progress',
      playerId,
      progress: player.progress,
      total,
      streak: player.streak,
      correct: player.correct,
      skid: !correct,
      nitro,
      finished,
      timeMs: finished ? player.finishedAt : null,
    });

    if (finished) {
      this.onPlayerFinished(player);
    } else if (correct) {
      this.sendQuestion(player);
    }
    return ok({ correct, stallMs, nitro });
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
    if (this.phase !== 'racing' || this.mode !== 'race') return;
    const racers = [...this.players.values()].filter((p) => !p.spectator);
    if (racers.length > 0 && racers.every((p) => p.finishedAt !== null)) this.finish('all');
  }

  endRace(playerId) {
    if (!this.isHost(playerId)) return fail('only the host can end the race');
    if (!this.inRace) return fail('no race running');
    this.finish('host');
    return ok();
  }

  finish(reason) {
    if (!this.inRace) return;
    this.clearRaceTimers();
    this.phase = 'finished';
    this.endReason = reason;
    this.ranking = this.computeRanking();
    const top = this.ranking[0];
    if (top && (top.finished || (this.mode === 'sprint' && top.correct > 0))) this.lastWinnerId = top.playerId;
    this.emit('broadcast', { type: 'race_finished', reason, mode: this.mode, ranking: this.ranking });
    this.emit('changed');
  }

  computeRanking() {
    const racers = [...this.players.values()].filter((p) => !p.spectator);
    const byFastest = (a, b) => {
      if (a.fastestMs === b.fastestMs) return 0;
      if (a.fastestMs === null) return 1;
      if (b.fastestMs === null) return -1;
      return a.fastestMs - b.fastestMs;
    };
    if (this.mode === 'sprint') {
      racers.sort((a, b) => b.correct - a.correct || a.wrong - b.wrong || byFastest(a, b) || a.joinedAt - b.joinedAt);
    } else {
      racers.sort((a, b) => {
        const af = a.finishedAt !== null;
        const bf = b.finishedAt !== null;
        if (af && bf) return a.finishedAt - b.finishedAt;
        if (af !== bf) return af ? -1 : 1;
        if (b.progress !== a.progress) return b.progress - a.progress;
        if (b.correct !== a.correct) return b.correct - a.correct;
        return a.joinedAt - b.joinedAt;
      });
    }
    const total = this.settings.length;
    return racers.map((p, i) => ({
      place: i + 1,
      playerId: p.id,
      name: p.name,
      car: p.car,
      level: p.level,
      finished: p.finishedAt !== null,
      timeMs: p.finishedAt,
      progress: p.progress,
      total,
      laps: this.mode === 'sprint' ? Math.floor(p.correct / total) : 0,
      correct: p.correct,
      wrong: p.wrong,
      accuracy: p.correct + p.wrong > 0 ? p.correct / (p.correct + p.wrong) : null,
      bestStreak: p.bestStreak,
      fastestMs: p.fastestMs,
      nitros: p.nitros,
      handicap: this.mode === 'race' ? p.handicap : 0,
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
    this.sprintEndsAt = null;
    for (const p of this.players.values()) {
      Object.assign(p, freshRaceStats());
      p.spectator = false;
    }
    this.emit('changed');
    return ok();
  }

  clearRaceTimers() {
    for (const key of ['countdown', 'flag', 'sprint']) {
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
    const racing = this.phase === 'racing';
    return {
      code: this.code,
      phase: this.phase,
      settings: this.settings,
      mode: this.mode,
      hostId: this.hostId,
      lastWinnerId: this.lastWinnerId,
      raceLength: this.settings.length,
      raceElapsedMs: racing && this.raceStartedAt !== null ? now - this.raceStartedAt : null,
      sprintRemainingMs: racing && this.sprintEndsAt !== null ? Math.max(0, this.sprintEndsAt - now) : null,
      endReason: this.endReason,
      ranking: this.phase === 'finished' ? this.ranking : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        car: p.car,
        level: p.level,
        progress: p.progress,
        correct: p.correct,
        streak: p.streak,
        finished: p.finishedAt !== null,
        timeMs: p.finishedAt,
        isHost: p.id === this.hostId,
        connected: p.connected,
        spectator: p.spectator,
        handicap: p.handicap,
      })),
    };
  }
}

function freshRaceStats() {
  return {
    progress: 0, // segments along the track
    qIndex: 0, // next question to answer
    correct: 0,
    wrong: 0,
    streak: 0,
    bestStreak: 0,
    nitros: 0,
    fastestMs: null,
    questionSentAt: 0,
    finishedAt: null,
    lockedUntil: 0,
  };
}

module.exports = { Room, PHASES, HOST_GRACE_MS, DISCONNECT_TTL_MS, EMPTY_ROOM_TTL_MS, sprintQuestionCount };
