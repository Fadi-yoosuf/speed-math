/* Shared client helpers for the player app and the TV view. No build step. */
(function () {
  'use strict';

  const LEVELS = {
    1: { name: 'Rookie', emoji: '🐣' },
    2: { name: 'Driver', emoji: '🚗' },
    3: { name: 'Racer', emoji: '🏎️' },
    4: { name: 'Turbo', emoji: '🚀' },
  };
  const CARS = ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚜', '🏍️', '🛵', '🚲', '🛺', '🚀'];
  const COLOURS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#14b8a6', '#a3e635', '#64748b'];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatTime(ms) {
    if (ms === null || ms === undefined) return '—';
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  }

  let toastTimer = null;
  function toast(message, ms = 2600) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---- WebSocket with auto-reconnect ----------------------------------------
  // `wss://` is picked automatically when the page itself is served over https
  // (e.g. through a Cloudflare tunnel); plain `ws://` on the LAN.
  function connect({ onOpen, onClose, onMessage }) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    let ws = null;
    let closedByUs = false;
    let attempt = 0;
    let timer = null;

    function open() {
      ws = new WebSocket(url);
      ws.addEventListener('open', () => {
        attempt = 0;
        if (onOpen) onOpen();
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (onMessage) onMessage(msg);
      });
      ws.addEventListener('close', () => {
        if (onClose) onClose();
        if (closedByUs) return;
        attempt += 1;
        const delay = Math.min(5000, 400 * 2 ** Math.min(attempt, 4));
        timer = setTimeout(open, delay);
      });
      ws.addEventListener('error', () => {
        /* close follows */
      });
    }
    open();

    return {
      send(type, payload) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload: payload || {} }));
      },
      isOpen() {
        return Boolean(ws && ws.readyState === WebSocket.OPEN);
      },
      close() {
        closedByUs = true;
        clearTimeout(timer);
        if (ws) ws.close();
      },
    };
  }

  // ---- Track renderer ---------------------------------------------------------
  // Keeps one .lane per player keyed by id so position transitions stay smooth
  // across re-renders.
  function Track(container) {
    const lanes = new Map(); // playerId → { lane, car }
    let raceLength = 20;

    function measure() {
      const road = container.querySelector('.lane-road');
      if (road) container.style.setProperty('--road-w', `${road.clientWidth}px`);
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(container);
    window.addEventListener('resize', measure);

    function laneFor(p) {
      let entry = lanes.get(p.id);
      if (!entry) {
        const lane = document.createElement('div');
        lane.className = 'lane';
        lane.dataset.id = p.id;
        lane.innerHTML = '<div class="lane-name"></div><div class="lane-road"><div class="car"><span class="badge"></span></div></div>';
        entry = { lane, car: lane.querySelector('.car'), name: lane.querySelector('.lane-name'), badge: lane.querySelector('.badge') };
        lanes.set(p.id, entry);
      }
      return entry;
    }

    function render(players, { raceLength: len, youId, hostId, lastWinnerId, phase } = {}) {
      if (len) raceLength = len;
      const seen = new Set();
      const empty = container.querySelector('.track-empty');
      if (empty) empty.remove();
      players.forEach((p) => {
        seen.add(p.id);
        const entry = laneFor(p);
        const lvl = LEVELS[p.level] || LEVELS[1];
        const bits = [];
        if (p.id === hostId) bits.push('<span title="Host">⭐</span>');
        if (p.id === lastWinnerId && phase === 'lobby') bits.push('<span title="Last winner">👑</span>');
        entry.name.innerHTML = `${bits.join('')}<span class="lvl" title="${lvl.name}">${lvl.emoji}</span> ${escapeHtml(p.name)}`;
        entry.lane.classList.toggle('you', p.id === youId);
        entry.lane.classList.toggle('disconnected', !p.connected);
        entry.lane.classList.toggle('spectator', Boolean(p.spectator) && (phase === 'countdown' || phase === 'racing'));
        entry.car.textContent = '';
        entry.car.append(document.createTextNode(p.car.emoji));
        entry.car.append(entry.badge);
        entry.car.style.background = p.car.colour;
        entry.car.classList.toggle('finished', Boolean(p.finished));
        entry.badge.textContent = p.finished ? '🏁' : '';
        setProgress(entry.car, p.progress || 0);
        container.append(entry.lane);
      });
      for (const [id, entry] of lanes) {
        if (!seen.has(id)) {
          entry.lane.remove();
          lanes.delete(id);
        }
      }
      if (players.length === 0) {
        const el = document.createElement('div');
        el.className = 'track-empty';
        el.textContent = 'Nobody here yet';
        container.append(el);
      }
      measure();
    }

    function setProgress(car, progress) {
      car.style.setProperty('--p', Math.max(0, Math.min(1, progress / raceLength)));
    }

    function update(playerId, { progress, total, skid, finished }) {
      const entry = lanes.get(playerId);
      if (!entry) return;
      if (total) raceLength = total;
      setProgress(entry.car, progress);
      if (skid) {
        entry.car.classList.remove('skid');
        void entry.car.offsetWidth; // restart the animation
        entry.car.classList.add('skid');
        setTimeout(() => entry.car.classList.remove('skid'), 650);
      }
      if (finished) {
        entry.car.classList.add('finished');
        entry.badge.textContent = '🏁';
      }
    }

    return { render, update, measure };
  }

  // ---- Sounds: tiny synthesised effects via Web Audio (no files needed) ----
  const Sounds = {
    ctx: null,
    muted: false,
    init() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    },
    setMuted(m) {
      this.muted = Boolean(m);
    },
    play(name) {
      if (this.muted || !this.ctx || !SYNTH[name]) return;
      try {
        SYNTH[name](this.ctx);
      } catch {
        /* audio is best-effort */
      }
    },
  };

  function tone(ctx, { type = 'sine', from = 440, to = from, start = 0, dur = 0.15, gain = 0.25 }) {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise(ctx, { start = 0, dur = 0.3, gain = 0.3, freq = 1200, q = 0.8 }) {
    const t0 = ctx.currentTime + start;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(t0);
  }

  const SYNTH = {
    tick: (ctx) => tone(ctx, { from: 880, dur: 0.12, gain: 0.2 }),
    go: (ctx) => tone(ctx, { from: 1320, dur: 0.45, gain: 0.25 }),
    vroom: (ctx) => {
      tone(ctx, { type: 'sawtooth', from: 110, to: 520, dur: 0.28, gain: 0.12 });
      tone(ctx, { type: 'square', from: 220, to: 660, dur: 0.2, gain: 0.04 });
    },
    skid: (ctx) => {
      noise(ctx, { dur: 0.4, gain: 0.35, freq: 900, q: 0.6 });
      tone(ctx, { type: 'sawtooth', from: 300, to: 80, dur: 0.35, gain: 0.08 });
    },
    cheer: (ctx) => {
      [523, 659, 784, 1047].forEach((f, i) => tone(ctx, { type: 'triangle', from: f, start: i * 0.11, dur: 0.3, gain: 0.2 }));
      noise(ctx, { start: 0.05, dur: 1.4, gain: 0.12, freq: 2500, q: 0.3 });
    },
    join: (ctx) => {
      tone(ctx, { from: 660, dur: 0.1, gain: 0.15 });
      tone(ctx, { from: 990, start: 0.1, dur: 0.14, gain: 0.15 });
    },
  };

  // ---- Confetti ------------------------------------------------------------
  function confetti(canvas, { durationMs = 4500, count = 180 } = {}) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const parts = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: -20 - Math.random() * H * 0.5,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      vx: (Math.random() - 0.5) * 2,
      vy: 2 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.2,
      colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
    }));
    const t0 = performance.now();
    function frame(now) {
      const elapsed = now - t0;
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.x += p.vx + Math.sin((now + p.y) / 300) * 0.6;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < durationMs) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }

  function storage(kind, key) {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage;
    return {
      get() {
        try {
          return JSON.parse(store.getItem(key)) || null;
        } catch {
          return null;
        }
      },
      set(v) {
        try {
          store.setItem(key, JSON.stringify(v));
        } catch {
          /* private mode */
        }
      },
      clear() {
        try {
          store.removeItem(key);
        } catch {
          /* ignore */
        }
      },
    };
  }

  window.SM = { LEVELS, CARS, COLOURS, escapeHtml, formatTime, toast, connect, Track, Sounds, confetti, storage };
})();
