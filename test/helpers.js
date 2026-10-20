'use strict';

// A manual clock + timer queue so room tests can jump through countdowns,
// stalls and flag timers without waiting.
function fakeDeps({ seed = 42 } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  let seedCounter = seed;
  let idCounter = 0;
  let tokenCounter = 0;
  const timers = new Map();
  const deps = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, seq: id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    randomSeed: () => seedCounter++,
    randomId: () => `p${++idCounter}`,
    randomToken: () => `tok${++tokenCounter}`,
    // Advance the clock, firing timers in order as they come due.
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!next || t.at < next.t.at || (t.at === next.t.at && t.seq < next.t.seq))) next = { id, t };
        }
        if (!next) break;
        timers.delete(next.id);
        now = Math.max(now, next.t.at);
        next.t.fn();
      }
      now = target;
    },
    pendingTimers: () => timers.size,
  };
  return deps;
}

// Collects everything a Room emits.
function recorder(room) {
  const sent = []; // { playerId, msg }
  const broadcasts = [];
  let changes = 0;
  room.on('send', (playerId, msg) => sent.push({ playerId, msg }));
  room.on('broadcast', (msg) => broadcasts.push(msg));
  room.on('changed', () => {
    changes += 1;
  });
  return {
    sent,
    broadcasts,
    get changes() {
      return changes;
    },
    sentTo: (playerId, type) => sent.filter((s) => s.playerId === playerId && (!type || s.msg.type === type)).map((s) => s.msg),
    ofType: (type) => broadcasts.filter((m) => m.type === type),
    lastQuestion: (playerId) => {
      const qs = sent.filter((s) => s.playerId === playerId && s.msg.type === 'question');
      return qs.length ? qs[qs.length - 1].msg : null;
    },
    clear() {
      sent.length = 0;
      broadcasts.length = 0;
    },
  };
}

const car = (emoji = '🚗', colour = '#ef4444') => ({ emoji, colour });

module.exports = { fakeDeps, recorder, car };
