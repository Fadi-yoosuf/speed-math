'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ROOM_WORDS, cleanName, isNameClean, randomRoomWord, NAME_MAX } = require('../server/words');

test('room words are unique four-letter uppercase words', () => {
  assert.ok(ROOM_WORDS.length >= 80);
  assert.equal(new Set(ROOM_WORDS).size, ROOM_WORDS.length);
  for (const w of ROOM_WORDS) assert.match(w, /^[A-Z]{4}$/);
  for (const w of ROOM_WORDS) assert.ok(isNameClean(w), w);
});

test('randomRoomWord picks from the list', () => {
  assert.ok(ROOM_WORDS.includes(randomRoomWord()));
  assert.equal(randomRoomWord(() => 0), ROOM_WORDS[0]);
});

test('cleanName trims, collapses spaces and caps the length', () => {
  assert.equal(cleanName('  Ava   Smith '), 'Ava Smith');
  assert.equal(cleanName('abcdefghijklmnopqrstuvwxyz').length, NAME_MAX);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(42), null);
  assert.equal(cleanName('Zoë 🚗'), 'Zoë 🚗');
});

test('cleanName blocks rude words, including leetspeak and spaced-out forms', () => {
  assert.equal(cleanName('sh1t'), null);
  assert.equal(cleanName('S H I T'), null);
  assert.equal(cleanName('fuckface'), null);
  assert.equal(cleanName('Fadi'), 'Fadi');
  assert.equal(cleanName('Ben'), 'Ben');
});
