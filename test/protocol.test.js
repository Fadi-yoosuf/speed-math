'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, validateSettings, DEFAULT_SETTINGS, CAR_EMOJIS, CAR_COLOURS } = require('../server/protocol');

const raw = (type, payload) => JSON.stringify({ type, payload });
const identity = { name: 'Ava', car: { emoji: '🚕', colour: '#22c55e' }, level: 2 };

test('rejects non-JSON and untyped messages', () => {
  assert.equal(parseMessage('nope').ok, false);
  assert.equal(parseMessage('{}').ok, false);
  assert.equal(parseMessage('[]').ok, false);
  assert.equal(parseMessage(raw('fly_away', {})).ok, false);
});

test('create_room validates identity and merges default settings', () => {
  const r = parseMessage(raw('create_room', { ...identity, settings: { ops: ['mul'], length: 10 } }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.name, 'Ava');
  assert.deepEqual(r.payload.car, { emoji: '🚕', colour: '#22c55e' });
  assert.equal(r.payload.level, 2);
  assert.deepEqual(r.payload.settings, { ...DEFAULT_SETTINGS, ops: ['mul'], length: 10 });
});

test('create_room rejects a missing or rude name and a bad level', () => {
  assert.equal(parseMessage(raw('create_room', { ...identity, name: '' })).ok, false);
  assert.equal(parseMessage(raw('create_room', { ...identity, name: 'shit' })).ok, false);
  assert.equal(parseMessage(raw('create_room', { ...identity, level: 9 })).ok, false);
});

test('unknown cars fall back to the first emoji and colour', () => {
  const r = parseMessage(raw('create_room', { ...identity, car: { emoji: '🦄', colour: 'red' } }));
  assert.deepEqual(r.payload.car, { emoji: CAR_EMOJIS[0], colour: CAR_COLOURS[0] });
});

test('join_room upper-cases the code and accepts a reconnect token without identity', () => {
  const fresh = parseMessage(raw('join_room', { ...identity, code: 'frog' }));
  assert.equal(fresh.ok, true);
  assert.equal(fresh.payload.code, 'FROG');
  const back = parseMessage(raw('join_room', { code: 'FROG', token: 'abc123' }));
  assert.equal(back.ok, true);
  assert.deepEqual(back.payload, { code: 'FROG', token: 'abc123' });
  assert.equal(parseMessage(raw('join_room', { ...identity, code: 'FR0G' })).ok, false);
  assert.equal(parseMessage(raw('join_room', { ...identity, code: 'FROGS' })).ok, false);
});

test('answer requires a non-negative index and digits only', () => {
  const r = parseMessage(raw('answer', { questionIndex: 3, value: '42' }));
  assert.deepEqual(r.payload, { questionIndex: 3, value: 42 });
  assert.equal(parseMessage(raw('answer', { questionIndex: 3, value: 7 })).payload.value, 7);
  assert.equal(parseMessage(raw('answer', { questionIndex: -1, value: '1' })).ok, false);
  assert.equal(parseMessage(raw('answer', { questionIndex: 0, value: '4x' })).ok, false);
  assert.equal(parseMessage(raw('answer', { questionIndex: 0, value: '' })).ok, false);
  assert.equal(parseMessage(raw('answer', { questionIndex: 0, value: '1234567' })).ok, false);
});

test('validateSettings merges partial changes over the current settings', () => {
  const base = { ...DEFAULT_SETTINGS, length: 30 };
  const r = validateSettings({ ops: ['sub', 'add', 'add'], lockLevel: '3', autoSubmit: 0, flagTimerSec: 45 }, base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.settings, { ...DEFAULT_SETTINGS, ops: ['add', 'sub'], length: 30, lockLevel: 3, autoSubmit: false, flagTimerSec: 45 });
  assert.equal(validateSettings({ length: 15 }).ok, false);
  assert.equal(validateSettings({ ops: [] }).ok, false);
  assert.equal(validateSettings({ ops: ['mod'] }).ok, false);
  assert.equal(validateSettings({ lockLevel: 7 }).ok, false);
  assert.equal(validateSettings({ flagTimerSec: 2 }).ok, false);
  assert.equal(validateSettings({ flagTimerSec: 1000 }).ok, false);
  assert.equal(validateSettings('x').ok, false);
  assert.deepEqual(validateSettings(undefined).settings, DEFAULT_SETTINGS);
  assert.equal(validateSettings({ lockLevel: '' }).settings.lockLevel, null);
});

test('milestone 4 settings: nitro, mode, sprintSec, theme, division', () => {
  assert.equal(DEFAULT_SETTINGS.nitro, true);
  assert.equal(DEFAULT_SETTINGS.mode, 'race');
  assert.equal(DEFAULT_SETTINGS.sprintSec, 60);
  assert.equal(DEFAULT_SETTINGS.theme, 'cars');
  assert.deepEqual(DEFAULT_SETTINGS.ops, ['add', 'sub', 'mul'], 'division is opt-in');
  const r = validateSettings({ nitro: 0, mode: 'sprint', sprintSec: '90', theme: 'boats', ops: ['div', 'add'] });
  assert.equal(r.ok, true);
  assert.equal(r.settings.nitro, false);
  assert.equal(r.settings.mode, 'sprint');
  assert.equal(r.settings.sprintSec, 90);
  assert.equal(r.settings.theme, 'boats');
  assert.deepEqual(r.settings.ops, ['add', 'div']);
  assert.equal(validateSettings({ mode: 'marathon' }).ok, false);
  assert.equal(validateSettings({ sprintSec: 45 }).ok, false);
  assert.equal(validateSettings({ theme: 'dragons' }).ok, false);
});

test('set_handicap takes a player id and 0-5 segments', () => {
  const r = parseMessage(raw('set_handicap', { playerId: 'abc123', segments: '3' }));
  assert.deepEqual(r.payload, { playerId: 'abc123', segments: 3 });
  assert.equal(parseMessage(raw('set_handicap', { playerId: 'abc123', segments: 6 })).ok, false);
  assert.equal(parseMessage(raw('set_handicap', { playerId: 'abc123', segments: -1 })).ok, false);
  assert.equal(parseMessage(raw('set_handicap', { playerId: '', segments: 1 })).ok, false);
});

test('milestone 5: mystery setting, kick_player and reset_season messages', () => {
  assert.equal(DEFAULT_SETTINGS.mystery, false);
  assert.equal(validateSettings({ mystery: 1 }).settings.mystery, true);
  assert.deepEqual(parseMessage(raw('kick_player', { playerId: 'abc' })).payload, { playerId: 'abc' });
  assert.equal(parseMessage(raw('kick_player', { playerId: '' })).ok, false);
  assert.equal(parseMessage(raw('kick_player', { playerId: 42 })).ok, false);
  assert.equal(parseMessage(raw('reset_season', {})).ok, true);
});
