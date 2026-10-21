'use strict';

// In-memory registry of rooms: unique kid-safe codes, caps, and expiry sweep.

const { Room } = require('./room');
const { ROOM_WORDS } = require('./words');
const { MAX_ROOMS } = require('./protocol');

const SWEEP_INTERVAL_MS = 60 * 1000;

class RoomRegistry {
  constructor({ deps, maxRooms = MAX_ROOMS } = {}) {
    this.rooms = new Map();
    this.deps = deps || {};
    this.maxRooms = maxRooms;
    this.sweeper = null;
  }

  get size() {
    return this.rooms.size;
  }

  get(code) {
    return this.rooms.get(code) || null;
  }

  pickCode() {
    const free = ROOM_WORDS.filter((w) => !this.rooms.has(w));
    if (free.length > 0) {
      const rnd = this.deps.random || Math.random;
      return free[Math.floor(rnd() * free.length)];
    }
    // Every word is taken: fall back to a random four-letter code.
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  create(settings) {
    if (this.rooms.size >= this.maxRooms) return { ok: false, error: 'the server is full, try again later' };
    const code = this.pickCode();
    if (!code) return { ok: false, error: 'no room codes left' };
    const room = new Room({ code, settings, deps: this.deps });
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  remove(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    room.destroy();
  }

  // Destroy every room (clears all timers). Used on shutdown.
  clear() {
    for (const code of [...this.rooms.keys()]) this.remove(code);
  }

  // Delete rooms that have had nobody connected for EMPTY_ROOM_TTL_MS.
  sweep(now = (this.deps.now || Date.now)()) {
    const removed = [];
    for (const [code, room] of this.rooms) {
      if (room.isExpired(now)) {
        removed.push(code);
        this.remove(code);
      }
    }
    return removed;
  }

  startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}

module.exports = { RoomRegistry, SWEEP_INTERVAL_MS };
