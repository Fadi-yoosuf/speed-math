'use strict';

// Deterministic arithmetic question generator.
//
//   generate(seed, level, ops, count) -> [{ text, answer, op, a, b }, ...]
//
// Same seed + level + ops + count always yields the same questions, so every
// player on the same level races against the same sequence.

const LEVELS = {
  1: { name: 'Rookie', emoji: '🐣' },
  2: { name: 'Driver', emoji: '🚗' },
  3: { name: 'Racer', emoji: '🏎️' },
  4: { name: 'Turbo', emoji: '🚀' },
};

const OPS = ['add', 'sub', 'mul', 'div'];
const OP_SYMBOL = { add: '+', sub: '−', mul: '×', div: '÷' };

// mulberry32: tiny, fast, good-enough PRNG with a 32-bit state.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turn any seed (number or string) into a 32-bit integer.
function toSeedInt(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const str = String(seed);
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed) {
  const next = mulberry32(toSeedInt(seed));
  return {
    // integer in [min, max] inclusive
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    bool() {
      return next() < 0.5;
    },
  };
}

// ---- per-level operand rules ------------------------------------------------

// Addition: pick the result first so the result range is exactly what the
// level promises, then split it into two operands.
function addFor(rng, level) {
  if (level === 4) {
    // up to 3-digit + 2-digit
    const a = rng.int(10, 999);
    const b = rng.int(10, 99);
    return rng.bool() ? [a, b] : [b, a];
  }
  const maxResult = level === 1 ? 10 : level === 2 ? 20 : 100;
  const result = rng.int(1, maxResult);
  const a = rng.int(0, result);
  return [a, result - a];
}

// Subtraction: a − b with a ≥ b, so the answer is never negative.
function subFor(rng, level) {
  if (level === 4) {
    // up to 3-digit − 2-digit
    const a = rng.int(10, 999);
    const b = rng.int(10, Math.min(99, a));
    return [a, b];
  }
  const maxResult = level === 1 ? 10 : level === 2 ? 20 : 100;
  const a = rng.int(1, maxResult);
  const b = rng.int(0, a);
  return [a, b];
}

function mulFor(rng, level) {
  let a;
  let b;
  if (level === 1) {
    a = rng.pick([1, 2, 10]);
    b = rng.int(0, 5);
  } else if (level === 2) {
    a = rng.pick([2, 3, 5, 10]);
    b = rng.int(1, 10);
  } else if (level === 3) {
    a = rng.int(1, 10);
    b = rng.int(1, 10);
  } else if (rng.bool()) {
    a = rng.int(2, 12);
    b = rng.int(2, 12);
  } else {
    a = rng.int(10, 99);
    b = rng.int(2, 9);
  }
  return rng.bool() ? [a, b] : [b, a];
}

// Division: built from the level's multiplication tables, so it always divides
// exactly. dividend ÷ divisor = quotient.
function divFor(rng, level) {
  let divisor;
  let quotient;
  if (level === 1) {
    divisor = rng.pick([1, 2, 10]);
    quotient = rng.int(0, 5);
  } else if (level === 2) {
    divisor = rng.pick([2, 3, 5, 10]);
    quotient = rng.int(1, 10);
  } else if (level === 3) {
    divisor = rng.int(2, 10);
    quotient = rng.int(1, 10);
  } else if (rng.bool()) {
    divisor = rng.int(2, 12);
    quotient = rng.int(2, 12);
  } else {
    divisor = rng.int(2, 9);
    quotient = rng.int(10, 99);
  }
  return [divisor * quotient, divisor];
}

const BUILDERS = { add: addFor, sub: subFor, mul: mulFor, div: divFor };

// Rookies may see "+ 0" (it is part of learning); from Driver up a zero
// operand is a free answer, and 0 + 0 is never asked.
function isTrivial(op, a, b, level) {
  if (op === 'mul' || op === 'div') return false; // ×0, ×1 and ÷1 are legitimate at Rookie level
  if (a === 0 && b === 0) return true;
  return level >= 2 && (a === 0 || b === 0);
}

function compute(op, a, b) {
  if (op === 'add') return a + b;
  if (op === 'sub') return a - b;
  if (op === 'div') return a / b;
  return a * b;
}

function normaliseOps(ops) {
  const list = Array.isArray(ops) ? ops.filter((o) => OPS.includes(o)) : [];
  // keep canonical order and drop duplicates
  return OPS.filter((o) => list.includes(o));
}

function generate(seed, level, ops, count) {
  const lvl = Number(level);
  if (!LEVELS[lvl]) throw new RangeError(`Unknown level: ${level}`);
  const useOps = normaliseOps(ops);
  if (useOps.length === 0) throw new RangeError('At least one operation is required');
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Bad count: ${count}`);

  const rng = makeRng(`${toSeedInt(seed)}:${lvl}:${useOps.join('')}:${n}`);
  const out = [];
  let prevText = null;
  while (out.length < n) {
    const op = rng.pick(useOps);
    const [a, b] = BUILDERS[op](rng, lvl);
    if (isTrivial(op, a, b, lvl)) continue;
    const text = `${a} ${OP_SYMBOL[op]} ${b}`;
    if (text === prevText) continue;
    out.push({ text, answer: compute(op, a, b), op, a, b });
    prevText = text;
  }
  return out;
}

const api = { generate, LEVELS, OPS, OP_SYMBOL, makeRng, toSeedInt };
// Served to the browser as /questions.js for the solo practice mode.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.SMQuestions = api;
