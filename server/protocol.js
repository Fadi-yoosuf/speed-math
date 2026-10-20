'use strict';

// Validation of client → server messages and of room settings.
// Every function returns a plain object; nothing here touches sockets.

const { OPS, LEVELS } = require('./questions');
const { cleanName } = require('./words');

const RACE_LENGTHS = [10, 20, 30];
const FLAG_TIMER_RANGE = [5, 120];
const MAX_PLAYERS = 12;
const MAX_ROOMS = 200;
const STALL_MS = 1500;
const COUNTDOWN_SECONDS = 3;

const CAR_EMOJIS = ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚜', '🏍️', '🛵', '🚲', '🛺', '🚀'];
const CAR_COLOURS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#14b8a6', '#a3e635', '#64748b'];

const DEFAULT_SETTINGS = Object.freeze({
  ops: ['add', 'sub', 'mul'],
  length: 20,
  lockLevel: null, // null = free choice per player, or 1..4
  autoSubmit: true,
  flagTimerSec: 20,
});

function fail(message) {
  return { ok: false, error: message };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Merge a partial settings object over `base` and validate. Unknown keys are
// dropped, bad values are rejected with an error message.
function validateSettings(input, base = DEFAULT_SETTINGS) {
  if (input === undefined || input === null) return { ok: true, settings: { ...base } };
  if (!isPlainObject(input)) return fail('settings must be an object');
  const out = { ...base };

  if ('ops' in input) {
    if (!Array.isArray(input.ops)) return fail('ops must be a list');
    const ops = OPS.filter((o) => input.ops.includes(o));
    if (ops.length === 0) return fail('pick at least one operation');
    out.ops = ops;
  }
  if ('length' in input) {
    const n = Number(input.length);
    if (!RACE_LENGTHS.includes(n)) return fail(`length must be one of ${RACE_LENGTHS.join(', ')}`);
    out.length = n;
  }
  if ('lockLevel' in input) {
    if (input.lockLevel === null || input.lockLevel === 0 || input.lockLevel === '') out.lockLevel = null;
    else {
      const lvl = Number(input.lockLevel);
      if (!LEVELS[lvl]) return fail('lockLevel must be 1-4 or empty');
      out.lockLevel = lvl;
    }
  }
  if ('autoSubmit' in input) {
    out.autoSubmit = Boolean(input.autoSubmit);
  }
  if ('flagTimerSec' in input) {
    const s = Number(input.flagTimerSec);
    if (!Number.isInteger(s) || s < FLAG_TIMER_RANGE[0] || s > FLAG_TIMER_RANGE[1]) {
      return fail(`flagTimerSec must be ${FLAG_TIMER_RANGE[0]}-${FLAG_TIMER_RANGE[1]}`);
    }
    out.flagTimerSec = s;
  }
  return { ok: true, settings: out };
}

function validateLevel(level) {
  const lvl = Number(level);
  if (!LEVELS[lvl]) return fail('level must be 1-4');
  return { ok: true, level: lvl };
}

function validateCar(car) {
  if (!isPlainObject(car)) return fail('car must be an object');
  const emoji = CAR_EMOJIS.includes(car.emoji) ? car.emoji : CAR_EMOJIS[0];
  const colour = CAR_COLOURS.includes(car.colour) ? car.colour : CAR_COLOURS[0];
  return { ok: true, car: { emoji, colour } };
}

function validateCode(code) {
  if (typeof code !== 'string') return fail('room code required');
  const c = code.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(c)) return fail('room code is four letters');
  return { ok: true, code: c };
}

// Validates the { name, car, level } trio used by create_room and join_room.
function validateIdentity(p) {
  const name = cleanName(p.name);
  if (!name) return fail('pick a nickname (letters, up to 12, keep it kind)');
  const car = validateCar(p.car || {});
  if (!car.ok) return car;
  const level = validateLevel(p.level);
  if (!level.ok) return level;
  return { ok: true, name, car: car.car, level: level.level };
}

// Parses raw socket text into { ok, type, payload } with payload already
// validated per message type.
function parseMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return fail('not JSON');
  }
  if (!isPlainObject(msg) || typeof msg.type !== 'string') return fail('message needs a type');
  const p = isPlainObject(msg.payload) ? msg.payload : {};

  switch (msg.type) {
    case 'create_room': {
      const id = validateIdentity(p);
      if (!id.ok) return id;
      const s = validateSettings(p.settings);
      if (!s.ok) return s;
      return { ok: true, type: msg.type, payload: { name: id.name, car: id.car, level: id.level, settings: s.settings } };
    }
    case 'join_room': {
      const code = validateCode(p.code);
      if (!code.ok) return code;
      if (typeof p.token === 'string' && p.token.length > 0 && p.token.length <= 64) {
        // reconnect: identity is optional
        return { ok: true, type: msg.type, payload: { code: code.code, token: p.token } };
      }
      const id = validateIdentity(p);
      if (!id.ok) return id;
      return { ok: true, type: msg.type, payload: { code: code.code, name: id.name, car: id.car, level: id.level } };
    }
    case 'watch_room': {
      const code = validateCode(p.code);
      if (!code.ok) return code;
      return { ok: true, type: msg.type, payload: { code: code.code } };
    }
    case 'update_settings': {
      // partial settings; merged against the room's current settings later
      if (!isPlainObject(p.settings)) return fail('settings must be an object');
      return { ok: true, type: msg.type, payload: { settings: p.settings } };
    }
    case 'set_level': {
      const level = validateLevel(p.level);
      if (!level.ok) return level;
      return { ok: true, type: msg.type, payload: { level: level.level } };
    }
    case 'answer': {
      const index = Number(p.questionIndex);
      if (!Number.isInteger(index) || index < 0) return fail('bad question index');
      const value = typeof p.value === 'number' ? String(p.value) : p.value;
      if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return fail('answer must be digits');
      return { ok: true, type: msg.type, payload: { questionIndex: index, value: Number(value) } };
    }
    case 'start_race':
    case 'end_race':
    case 'race_again':
    case 'back_to_lobby':
    case 'leave_room':
    case 'ping':
      return { ok: true, type: msg.type, payload: {} };
    default:
      return fail(`unknown message type: ${msg.type}`);
  }
}

module.exports = {
  parseMessage,
  validateSettings,
  validateLevel,
  validateCar,
  validateCode,
  DEFAULT_SETTINGS,
  RACE_LENGTHS,
  MAX_PLAYERS,
  MAX_ROOMS,
  STALL_MS,
  COUNTDOWN_SECONDS,
  CAR_EMOJIS,
  CAR_COLOURS,
};
