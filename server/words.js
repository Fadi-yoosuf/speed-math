'use strict';

// Kid-safe four-letter words for room codes. Easy to say, easy to type.
const ROOM_WORDS = [
  'FROG', 'MOON', 'JAZZ', 'STAR', 'LION', 'BEAR', 'FISH', 'BIRD', 'DUCK', 'GOAT',
  'KITE', 'BOAT', 'SHIP', 'ROAD', 'RACE', 'FAST', 'ZOOM', 'JUMP', 'HOP', 'SNOW',
  'RAIN', 'WIND', 'SAND', 'ROCK', 'TREE', 'LEAF', 'ROSE', 'LILY', 'MINT', 'LIME',
  'PEAR', 'PLUM', 'KIWI', 'CAKE', 'MILK', 'CORN', 'RICE', 'SOUP', 'TACO', 'PIZZA',
  'BLUE', 'PINK', 'GOLD', 'TEAL', 'RUBY', 'JADE', 'OPAL', 'CUBE', 'BALL', 'RING',
  'BELL', 'DRUM', 'HARP', 'TUBA', 'SONG', 'BEAT', 'DISCO', 'POLO', 'GOLF', 'SURF',
  'SWIM', 'DIVE', 'SAIL', 'ROWS', 'RIDE', 'HIKE', 'CAMP', 'TENT', 'FIRE', 'LAMP',
  'BOOK', 'PAGE', 'PENS', 'INKS', 'MAPS', 'GLOBE', 'HERO', 'KING', 'LORD', 'KNIGHT',
  'WOLF', 'DEER', 'HARE', 'MOLE', 'OWLS', 'CROW', 'SWAN', 'DOVE', 'CRAB', 'SEAL',
  'YETI', 'TROLL', 'ELF', 'PUCK', 'WAND', 'MAGE', 'BOLT', 'VOLT', 'NEON', 'ATOM',
  'MARS', 'VENUS', 'COMET', 'NOVA', 'ORBIT', 'ROVER', 'LUNA', 'SOLAR', 'ECHO', 'PING',
].filter((w) => w.length === 4); // keep strictly four letters

// Minimal profanity list for nickname filtering. Matched as substrings after
// stripping non-letters, so leetspeak-lite like "sh1t" is caught too.
const BLOCKED = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'asshole', 'bastard',
  'slut', 'whore', 'nigg', 'fag', 'twat', 'wank', 'penis', 'vagina', 'boob',
  'sex', 'porn', 'nazi', 'hitler', 'damn', 'crap', 'piss', 'retard',
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };

function normaliseForFilter(name) {
  return String(name)
    .toLowerCase()
    .replace(/[01345788@$!]/g, (c) => LEET[c] || c)
    .replace(/[^a-z]/g, '');
}

function isNameClean(name) {
  const flat = normaliseForFilter(name);
  return !BLOCKED.some((bad) => flat.includes(bad));
}

const NAME_MAX = 12;

// Returns a cleaned nickname or null if unusable.
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (name.length === 0) return null;
  if (!isNameClean(name)) return null;
  return name;
}

function randomRoomWord(rng = Math.random) {
  return ROOM_WORDS[Math.floor(rng() * ROOM_WORDS.length)];
}

module.exports = { ROOM_WORDS, isNameClean, cleanName, randomRoomWord, NAME_MAX };
