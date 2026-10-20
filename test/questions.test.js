'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generate, LEVELS, OPS } = require('../server/questions');

const ALL = ['add', 'sub', 'mul', 'div'];

function digits(n) {
  return String(Math.abs(n)).length;
}

test('is deterministic for the same seed, level, ops and count', () => {
  const a = generate('race-1', 3, ALL, 20);
  const b = generate('race-1', 3, ALL, 20);
  assert.deepEqual(a, b);
  assert.equal(a.length, 20);
});

test('different seeds give different sequences', () => {
  const a = generate(1, 3, ALL, 20).map((q) => q.text);
  const b = generate(2, 3, ALL, 20).map((q) => q.text);
  assert.notDeepEqual(a, b);
});

test('different levels give different sequences for the same seed', () => {
  const a = generate(7, 1, ALL, 20).map((q) => q.text);
  const b = generate(7, 4, ALL, 20).map((q) => q.text);
  assert.notDeepEqual(a, b);
});

test('answers match the question text', () => {
  for (const level of [1, 2, 3, 4]) {
    for (const q of generate('check', level, ALL, 200)) {
      const expected = q.op === 'add' ? q.a + q.b : q.op === 'sub' ? q.a - q.b : q.op === 'div' ? q.a / q.b : q.a * q.b;
      assert.equal(q.answer, expected, q.text);
      assert.equal(q.text, `${q.a} ${{ add: '+', sub: '−', mul: '×', div: '÷' }[q.op]} ${q.b}`);
    }
  }
});

test('only the requested operations appear', () => {
  for (const q of generate('ops', 3, ['mul'], 100)) assert.equal(q.op, 'mul');
  const addSub = generate('ops', 3, ['add', 'sub'], 100);
  assert.ok(addSub.every((q) => q.op === 'add' || q.op === 'sub'));
  assert.ok(addSub.some((q) => q.op === 'add'));
  assert.ok(addSub.some((q) => q.op === 'sub'));
});

test('subtraction never goes negative, at any level', () => {
  for (const level of [1, 2, 3, 4]) {
    for (const q of generate(`sub-${level}`, level, ['sub'], 300)) {
      assert.ok(q.answer >= 0, `${q.text} at level ${level}`);
    }
  }
});

test('no question repeats back-to-back', () => {
  for (const level of [1, 2, 3, 4]) {
    for (let seed = 0; seed < 20; seed++) {
      const qs = generate(seed, level, ALL, 30);
      for (let i = 1; i < qs.length; i++) assert.notEqual(qs[i].text, qs[i - 1].text);
    }
  }
  // Level 1 with only multiplication has a tiny space; still no repeats.
  const tiny = generate('tiny', 1, ['mul'], 30);
  for (let i = 1; i < tiny.length; i++) assert.notEqual(tiny[i].text, tiny[i - 1].text);
});

test('never produces 0 + 0; zero operands only at Rookie level', () => {
  for (const level of [1, 2, 3, 4]) {
    for (const q of generate(`triv-${level}`, level, ['add', 'sub'], 300)) {
      assert.ok(!(q.a === 0 && q.b === 0), q.text);
      if (level >= 2) assert.ok(q.a !== 0 && q.b !== 0, q.text);
    }
  }
  const rookie = generate('rookie-zero', 1, ['add'], 300);
  assert.ok(rookie.some((q) => q.a === 0 || q.b === 0), 'Rookies still practise + 0');
});

test('level 1 Rookie: results 0–10, × tables 1, 2, 10 with 0–5', () => {
  for (const q of generate('l1', 1, ['add', 'sub'], 300)) {
    assert.ok(q.answer >= 0 && q.answer <= 10, q.text);
  }
  for (const q of generate('l1m', 1, ['mul'], 300)) {
    const [table, other] = [1, 2, 10].includes(q.a) && q.b <= 5 ? [q.a, q.b] : [q.b, q.a];
    assert.ok([1, 2, 10].includes(table), q.text);
    assert.ok(other >= 0 && other <= 5, q.text);
  }
});

test('level 2 Driver: results 0–20, × tables 2, 3, 5, 10', () => {
  for (const q of generate('l2', 2, ['add', 'sub'], 300)) {
    assert.ok(q.answer >= 0 && q.answer <= 20, q.text);
  }
  for (const q of generate('l2m', 2, ['mul'], 300)) {
    assert.ok([2, 3, 5, 10].includes(q.a) || [2, 3, 5, 10].includes(q.b), q.text);
    assert.ok(q.a >= 1 && q.a <= 10 && q.b >= 1 && q.b <= 10, q.text);
  }
});

test('level 3 Racer: results 0–100, × tables 1–10', () => {
  for (const q of generate('l3', 3, ['add', 'sub'], 300)) {
    assert.ok(q.answer >= 0 && q.answer <= 100, q.text);
  }
  for (const q of generate('l3m', 3, ['mul'], 300)) {
    assert.ok(q.a >= 1 && q.a <= 10 && q.b >= 1 && q.b <= 10, q.text);
  }
});

test('level 4 Turbo: up to 3-digit ± 2-digit, up to 12 × 12 and 2-digit × 1-digit', () => {
  for (const q of generate('l4', 4, ['add', 'sub'], 300)) {
    const [big, small] = q.a >= q.b ? [q.a, q.b] : [q.b, q.a];
    assert.ok(big >= 10 && big <= 999 && small >= 10 && small <= 99, q.text);
  }
  for (const q of generate('l4m', 4, ['mul'], 300)) {
    const ok12 = q.a >= 2 && q.a <= 12 && q.b >= 2 && q.b <= 12;
    const ok2x1 = (digits(q.a) === 2 && q.b >= 2 && q.b <= 9) || (digits(q.b) === 2 && q.a >= 2 && q.a <= 9);
    assert.ok(ok12 || ok2x1, q.text);
  }
});

test('operands are shuffled: both 3 × 7 and 7 × 3 shapes appear', () => {
  const qs = generate('shuffle', 2, ['mul'], 400);
  const tableFirst = qs.filter((q) => [2, 3, 5, 10].includes(q.a) && ![2, 3, 5, 10].includes(q.b));
  const tableSecond = qs.filter((q) => [2, 3, 5, 10].includes(q.b) && ![2, 3, 5, 10].includes(q.a));
  assert.ok(tableFirst.length > 50 && tableSecond.length > 50);
});

test('division always divides exactly, never by zero, from the level tables', () => {
  for (const level of [1, 2, 3, 4]) {
    for (const q of generate(`div-${level}`, level, ['div'], 300)) {
      assert.equal(q.op, 'div');
      assert.notEqual(q.b, 0, q.text);
      assert.equal(q.a % q.b, 0, q.text);
      assert.ok(Number.isInteger(q.answer) && q.answer >= 0, q.text);
      if (level === 1) assert.ok([1, 2, 10].includes(q.b) && q.answer <= 5, q.text);
      if (level === 2) assert.ok([2, 3, 5, 10].includes(q.b) && q.answer >= 1 && q.answer <= 10, q.text);
      if (level === 3) assert.ok(q.b >= 2 && q.b <= 10 && q.answer >= 1 && q.answer <= 10, q.text);
      if (level === 4) assert.ok((q.b >= 2 && q.b <= 12 && q.answer >= 2 && q.answer <= 12) || (q.b >= 2 && q.b <= 9 && q.answer >= 10 && q.answer <= 99), q.text);
    }
  }
});

test('rejects bad input', () => {
  assert.throws(() => generate(1, 5, ALL, 10), RangeError);
  assert.throws(() => generate(1, 1, [], 10), RangeError);
  assert.throws(() => generate(1, 1, ['mod'], 10), RangeError);
  assert.throws(() => generate(1, 1, ALL, 0), RangeError);
  assert.equal(Object.keys(LEVELS).length, 4);
  assert.deepEqual(OPS, ['add', 'sub', 'mul', 'div']);
});
