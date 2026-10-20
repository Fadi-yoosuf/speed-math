/* Speed Math — player app. Screens: home → lobby → race → podium, plus a solo
   practice mode that runs entirely in the browser. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { LEVELS, CARS, COLOURS, NITRO_STREAK, spriteFor, applyTheme, escapeHtml, formatTime, formatFast, toast, Sounds } = SM;

  const prefStore = SM.storage('local', 'speedmath.prefs');
  const sessionStore = SM.storage('session', 'speedmath.session');
  const bestStore = SM.storage('local', 'speedmath.best'); // practice personal bests per level

  const prefs = Object.assign(
    { name: '', car: { emoji: CARS[0], colour: COLOURS[Math.floor(Math.random() * COLOURS.length)] }, level: 2, muted: false },
    prefStore.get() || {}
  );
  Sounds.setMuted(prefs.muted);

  const PRACTICE_LENGTH = 20;
  const PRACTICE_SETTINGS = { ops: ['add', 'sub', 'mul'], length: PRACTICE_LENGTH, autoSubmit: true, nitro: false, mode: 'race', theme: 'cars', sprintSec: 60 };

  const state = {
    room: null,
    you: null,
    token: null,
    code: null,
    joinInfo: null,
    question: null,
    typed: '',
    pending: false,
    lockedUntil: 0,
    raceStartAt: null,
    sprintEndsAt: null,
    finishedSelf: false,
    screen: 'home',
    practice: null, // solo mode, no room
  };

  const lobbyTrack = SM.Track($('lobby-track'));
  const raceTrack = SM.Track($('race-track'));

  // What the race screen is showing: a room, or a practice session.
  function ctx() {
    if (state.practice) return { settings: state.practice.settings, raceLength: PRACTICE_LENGTH, mode: 'race', phase: state.practice.finished ? 'finished' : 'racing' };
    if (state.room) return { settings: state.room.settings, raceLength: state.room.raceLength, mode: state.room.mode || state.room.settings.mode, phase: state.room.phase };
    return { settings: PRACTICE_SETTINGS, raceLength: 20, mode: 'race', phase: 'lobby' };
  }

  // ---- screens ---------------------------------------------------------------
  function showScreen(name) {
    if (state.screen === name) return;
    state.screen = name;
    for (const s of ['home', 'lobby', 'race', 'podium']) $(`screen-${s}`).classList.toggle('hidden', s !== name);
    window.scrollTo(0, 0);
    if (name === 'lobby') lobbyTrack.measure();
    if (name === 'race') raceTrack.measure();
  }

  // ---- socket ----------------------------------------------------------------
  const sock = SM.connect({
    onOpen() {
      $('conn-dot').className = 'conn-dot on';
      $('conn-dot').title = 'Connected';
      const saved = sessionStore.get();
      if (state.code && state.token) sock.send('join_room', { code: state.code, token: state.token });
      else if (saved && saved.code && saved.token && !state.practice) sock.send('join_room', { code: saved.code, token: saved.token });
    },
    onClose() {
      $('conn-dot').className = 'conn-dot off';
      $('conn-dot').title = 'Reconnecting…';
    },
    onMessage: handleMessage,
  });

  function handleMessage(msg) {
    if (state.practice && msg.type !== 'error') return; // practice ignores room traffic
    switch (msg.type) {
      case 'welcome':
        state.you = msg.playerId;
        state.token = msg.token;
        state.code = msg.code;
        state.joinInfo = msg;
        sessionStore.set({ code: msg.code, token: msg.token });
        renderShare();
        break;
      case 'room_state':
        onRoomState(msg);
        break;
      case 'countdown':
        onCountdown(msg.secondsLeft);
        break;
      case 'question':
        onQuestion(msg);
        break;
      case 'answer_result':
        onAnswerResult(msg);
        break;
      case 'progress':
        onProgress(msg);
        break;
      case 'flag_timer':
        onFlagTimer(msg);
        break;
      case 'race_finished':
        onRaceFinished(msg);
        break;
      case 'left':
        leaveLocally();
        break;
      case 'error':
        toast(msg.message, msg.code === 'KICKED' ? 5000 : 2600);
        if (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'KICKED') leaveLocally();
        break;
      default:
        break;
    }
  }

  function leaveLocally() {
    sessionStore.clear();
    state.room = null;
    state.you = null;
    state.token = null;
    state.code = null;
    state.question = null;
    state.joinInfo = null;
    applyTheme('cars');
    showScreen('home');
  }

  // ---- room state ------------------------------------------------------------
  function onRoomState(room) {
    const prevPhase = state.room ? state.room.phase : null;
    state.room = room;
    state.you = room.you;
    applyTheme(room.settings.theme);
    if (room.phase === 'lobby') {
      renderLobby();
      showScreen('lobby');
    } else if (room.phase === 'countdown' || room.phase === 'racing') {
      if (prevPhase !== 'countdown' && prevPhase !== 'racing') {
        state.question = null;
        state.typed = '';
        state.finishedSelf = false;
        state.sprintEndsAt = null;
        $('flag-banner').classList.add('hidden');
      }
      if (room.phase === 'racing' && room.raceElapsedMs !== null) state.raceStartAt = Date.now() - room.raceElapsedMs;
      if (room.phase === 'racing' && room.sprintRemainingMs !== null) state.sprintEndsAt = Date.now() + room.sprintRemainingMs;
      renderRace();
      showScreen('race');
    } else if (room.phase === 'finished') {
      renderPodium(room.ranking || [], { mode: room.mode, season: room.season });
      showScreen('podium');
    }
  }

  function me() {
    if (state.practice) return practicePlayer();
    return state.room ? state.room.players.find((p) => p.id === state.you) || null : null;
  }
  function isHost() {
    return Boolean(state.room && !state.practice && state.room.hostId === state.you);
  }

  // ---- home ------------------------------------------------------------------
  function renderPickers() {
    $('car-picker').innerHTML = CARS.map((c) => `<button type="button" data-emoji="${c}" class="${c === prefs.car.emoji ? 'selected' : ''}">${c}</button>`).join('');
    $('colour-picker').innerHTML = COLOURS.map((c) => `<button type="button" data-colour="${c}" style="background:${c}" class="${c === prefs.car.colour ? 'selected' : ''}" aria-label="colour"></button>`).join('');
    $('level-picker').innerHTML = levelButtons(prefs.level);
  }
  function levelButtons(selected, disabled) {
    return Object.entries(LEVELS)
      .map(([n, l]) => `<button type="button" data-level="${n}" class="${Number(n) === Number(selected) ? 'selected' : ''}" ${disabled ? 'disabled' : ''}><span class="lvl-emoji">${l.emoji}</span>${l.name}</button>`)
      .join('');
  }
  function savePrefs() {
    prefStore.set(prefs);
  }

  $('name-input').value = prefs.name;
  renderPickers();
  $('car-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-emoji]');
    if (!b) return;
    prefs.car.emoji = b.dataset.emoji;
    savePrefs();
    renderPickers();
  });
  $('colour-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-colour]');
    if (!b) return;
    prefs.car.colour = b.dataset.colour;
    savePrefs();
    renderPickers();
  });
  $('level-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-level]');
    if (!b) return;
    prefs.level = Number(b.dataset.level);
    savePrefs();
    renderPickers();
    renderPracticeBest();
  });

  function bestFor(level) {
    const all = bestStore.get() || {};
    return all[level] || null;
  }
  function renderPracticeBest() {
    const best = bestFor(prefs.level);
    const el = $('practice-best');
    el.classList.toggle('hidden', !best);
    if (best) el.textContent = `Your best practice run at ${LEVELS[prefs.level].emoji} ${LEVELS[prefs.level].name}: ${formatTime(best.timeMs)}`;
  }
  renderPracticeBest();
  $('name-input').addEventListener('input', () => {
    prefs.name = $('name-input').value;
    savePrefs();
  });

  function identity() {
    const name = $('name-input').value.trim();
    if (!name) {
      toast('Pick a nickname first');
      $('name-input').focus();
      return null;
    }
    return { name, car: prefs.car, level: prefs.level };
  }
  $('new-race-btn').addEventListener('click', () => {
    const id = identity();
    if (!id) return;
    if (!sock.isOpen()) return toast('Not connected yet…');
    sock.send('create_room', id);
  });
  function joinWithCode() {
    const id = identity();
    if (!id) return;
    const code = $('code-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      toast('Room codes are four letters');
      $('code-input').focus();
      return;
    }
    if (!sock.isOpen()) return toast('Not connected yet…');
    sock.send('join_room', { ...id, code });
  }
  $('join-btn').addEventListener('click', joinWithCode);
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinWithCode();
  });
  $('name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && $('code-input').value.trim()) joinWithCode();
  });
  $('practice-btn').addEventListener('click', startPractice);

  // Prefill the code from /join/FROG or ?code=FROG
  (function prefill() {
    const m = location.pathname.match(/^\/join\/([A-Za-z]{4})/);
    const q = new URLSearchParams(location.search).get('code');
    const code = (m && m[1]) || q;
    if (code) {
      $('code-input').value = code.toUpperCase();
      history.replaceState(null, '', '/');
      if (!prefs.name) $('name-input').focus();
    }
  })();

  // ---- lobby -----------------------------------------------------------------
  function shareBlock({ title, joinUrl, tvUrl, qrDataUrl, cls }) {
    const pretty = joinUrl.replace(/^https?:\/\//, '');
    return `<div class="share-block ${cls}">
      <h3>${title}</h3>
      ${qrDataUrl ? `<img class="qr" alt="QR code to join" src="${qrDataUrl}">` : ''}
      <a class="join-url" href="${escapeHtml(joinUrl)}" target="_blank" rel="noopener">${escapeHtml(pretty)}</a>
      <button class="btn btn-small copy-link-btn" type="button" data-url="${escapeHtml(joinUrl)}">Copy link</button>
      <a class="btn btn-small btn-ghost" href="${escapeHtml(tvUrl)}" target="_blank" rel="noopener">📺 TV view</a>
    </div>`;
  }

  function renderShare() {
    const info = state.joinInfo;
    if (!info) return;
    $('room-code').textContent = info.code;
    const blocks = [];
    if (info.publicJoinUrl) {
      blocks.push(shareBlock({ title: 'On this Wi-Fi', joinUrl: info.joinUrl, tvUrl: info.tvUrl, qrDataUrl: info.qrDataUrl, cls: 'local' }));
      blocks.push(shareBlock({ title: 'From anywhere', joinUrl: info.publicJoinUrl, tvUrl: info.publicTvUrl, qrDataUrl: info.publicQrDataUrl, cls: 'public' }));
    } else {
      blocks.push(shareBlock({ title: 'Friends join at', joinUrl: info.joinUrl, tvUrl: info.tvUrl, qrDataUrl: info.qrDataUrl, cls: 'local' }));
    }
    $('share-blocks').innerHTML = blocks.join('');
  }

  $('share-blocks').addEventListener('click', async (e) => {
    const b = e.target.closest('.copy-link-btn');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.url);
      toast('Link copied!');
    } catch {
      toast(b.dataset.url);
    }
  });

  function trackOpts(room) {
    return { raceLength: room.raceLength, youId: state.you, hostId: room.hostId, lastWinnerId: room.lastWinnerId, phase: room.phase, theme: room.settings.theme, mode: room.mode, nitro: room.settings.nitro };
  }

  function renderLobby() {
    const room = state.room;
    const host = isHost();
    $('player-count').textContent = `(${room.players.length}/12)`;
    lobbyTrack.render(room.players, trackOpts(room));
    const self = me();
    $('lobby-level-picker').innerHTML = levelButtons(self ? self.level : prefs.level, Boolean(room.settings.lockLevel));
    $('start-btn').classList.toggle('hidden', !host);
    $('waiting-host').classList.toggle('hidden', host);
    $('settings-card').classList.toggle('readonly', !host);
    $('settings-owner').textContent = host ? '(you are the host ⭐)' : '(set by the host)';
    syncSettingsForm(room.settings);
    renderPlayersPanel();
    renderSeason($('season'), room.season, { host, lobby: true });
  }

  // Season standings: points over the races played in this room.
  function renderSeason(box, season, { host = false, lobby = false } = {}) {
    if (!season || season.races === 0) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    const theme = ctx().settings.theme;
    const rows = season.standings
      .map(
        (s, i) => `<div class="season-row ${s.playerId === state.you ? 'you' : ''}">
          <span class="pos">${i + 1}.</span>
          <span class="who">${spriteFor(s.car, theme)} ${escapeHtml(s.name)}</span>
          <span class="pts">${s.points} pt${s.points === 1 ? '' : 's'}</span>
          <span class="wins">${s.wins > 0 ? `🏆×${s.wins}` : ''}</span>
        </div>`
      )
      .join('');
    box.innerHTML = `<h3>🏆 Season standings <span class="muted">after ${season.races} race${season.races === 1 ? '' : 's'}</span></h3>${rows}${
      host && lobby ? '<button id="new-season-btn" class="btn btn-small btn-ghost" type="button">Start a new season</button>' : ''
    }`;
    box.classList.remove('hidden');
  }
  $('season').addEventListener('click', (e) => {
    if (!e.target.closest('#new-season-btn')) return;
    if (confirm('Reset everyone\'s season points?')) sock.send('reset_season');
  });

  function syncSettingsForm(s) {
    const card = $('settings-card');
    card.querySelectorAll('input[name="op"]').forEach((el) => {
      el.checked = s.ops.includes(el.value);
    });
    card.querySelectorAll('input[name="length"]').forEach((el) => {
      el.checked = Number(el.value) === s.length;
    });
    card.querySelectorAll('input[name="autoSubmit"]').forEach((el) => {
      el.checked = (el.value === '1') === Boolean(s.autoSubmit);
    });
    card.querySelectorAll('input[name="mode"]').forEach((el) => {
      el.checked = el.value === s.mode;
    });
    card.querySelector('input[name="nitro"]').checked = Boolean(s.nitro);
    card.querySelector('input[name="mystery"]').checked = Boolean(s.mystery);
    const sprint = card.querySelector('select[name="sprintSec"]');
    if (document.activeElement !== sprint) sprint.value = String(s.sprintSec);
    const theme = card.querySelector('select[name="theme"]');
    if (document.activeElement !== theme) theme.value = s.theme;
    const lock = card.querySelector('select[name="lockLevel"]');
    if (document.activeElement !== lock) lock.value = s.lockLevel ? String(s.lockLevel) : '';
    const flag = card.querySelector('input[name="flagTimerSec"]');
    if (document.activeElement !== flag) flag.value = s.flagTimerSec;
    $('length-legend').textContent = s.mode === 'sprint' ? 'Lap length' : 'Race length';
  }

  $('settings-card').addEventListener('change', (e) => {
    if (!isHost()) return;
    const card = $('settings-card');
    const el = e.target;
    const partial = {};
    if (el.name === 'op') {
      partial.ops = [...card.querySelectorAll('input[name="op"]:checked')].map((x) => x.value);
      if (partial.ops.length === 0) {
        toast('Keep at least one kind of sum');
        syncSettingsForm(state.room.settings);
        return;
      }
    } else if (el.name === 'length') partial.length = Number(el.value);
    else if (el.name === 'lockLevel') partial.lockLevel = el.value ? Number(el.value) : null;
    else if (el.name === 'autoSubmit') partial.autoSubmit = el.value === '1';
    else if (el.name === 'mode') partial.mode = el.value;
    else if (el.name === 'sprintSec') {
      partial.sprintSec = Number(el.value);
      partial.mode = 'sprint';
    } else if (el.name === 'nitro') partial.nitro = el.checked;
    else if (el.name === 'mystery') partial.mystery = el.checked;
    else if (el.name === 'theme') partial.theme = el.value;
    else if (el.name === 'flagTimerSec') {
      const v = Math.max(5, Math.min(120, Math.round(Number(el.value) / 5) * 5 || 20));
      el.value = v;
      partial.flagTimerSec = v;
    } else return;
    sock.send('update_settings', { settings: partial });
  });

  // Host-only player panel: head starts (race mode) and removing a player.
  function renderPlayersPanel() {
    const room = state.room;
    const box = $('handicaps');
    const race = room.settings.mode === 'race';
    const show = isHost() && room.players.length > 1;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    box.innerHTML =
      `<h3>Players${race ? ' · head starts (segments)' : ''}</h3>` +
      room.players
        .map(
          (p) => `<div class="handicap-row ${race ? '' : 'no-handicap'}" data-id="${p.id}">
            <span>${spriteFor(p.car, room.settings.theme)} ${escapeHtml(p.name)}${p.id === state.you ? ' <span class="muted">(you)</span>' : ''}</span>
            <button type="button" class="hbtn" data-delta="-1" ${p.handicap <= 0 ? 'disabled' : ''} ${race ? '' : 'hidden'}>−</button>
            <span class="hval" ${race ? '' : 'hidden'}>${p.handicap > 0 ? `+${p.handicap}` : '0'}</span>
            <button type="button" class="hbtn" data-delta="1" ${p.handicap >= 5 ? 'disabled' : ''} ${race ? '' : 'hidden'}>+</button>
            ${p.id === state.you ? '<span></span>' : `<button type="button" class="kbtn" data-kick="1" title="Remove ${escapeHtml(p.name)}">✕</button>`}
          </div>`
        )
        .join('');
  }
  $('handicaps').addEventListener('click', (e) => {
    if (!isHost()) return;
    const row = e.target.closest('.handicap-row');
    if (!row) return;
    const player = state.room.players.find((p) => p.id === row.dataset.id);
    if (!player) return;
    const kick = e.target.closest('button[data-kick]');
    if (kick) {
      if (confirm(`Remove ${player.name} from the race?`)) sock.send('kick_player', { playerId: player.id });
      return;
    }
    const b = e.target.closest('button[data-delta]');
    if (!b) return;
    const segments = Math.max(0, Math.min(5, player.handicap + Number(b.dataset.delta)));
    sock.send('set_handicap', { playerId: player.id, segments });
  });

  $('lobby-level-picker').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-level]');
    if (!b || b.disabled) return;
    prefs.level = Number(b.dataset.level);
    savePrefs();
    sock.send('set_level', { level: prefs.level });
  });

  $('start-btn').addEventListener('click', () => sock.send('start_race'));
  $('leave-btn').addEventListener('click', () => {
    sock.send('leave_room');
    leaveLocally();
  });

  // ---- race ------------------------------------------------------------------
  function renderRace() {
    const c = ctx();
    if (state.practice) {
      const p = state.practice;
      raceTrack.render([practicePlayer()], { raceLength: PRACTICE_LENGTH, youId: 'you', phase: 'racing', theme: p.settings.theme, mode: 'race', nitro: false });
    } else {
      raceTrack.render(state.room.players, trackOpts(state.room));
    }
    const self = me();
    const spectator = Boolean(self && self.spectator);
    const finished = Boolean(self && self.finished);
    $('spectator-note').classList.toggle('hidden', !spectator);
    $('question-card').classList.toggle('hidden', spectator || finished);
    $('numpad').classList.toggle('hidden', spectator || finished);
    $('numpad').classList.toggle('auto', Boolean(c.settings.autoSubmit));
    $('end-race-btn').classList.toggle('hidden', !isHost());
    $('quit-practice-btn').classList.toggle('hidden', !state.practice);
    if (finished) {
      $('finished-note').textContent = `🏁 You finished in ${formatTime(self.timeMs)}! Watch the others…`;
      $('finished-note').classList.remove('hidden');
    } else $('finished-note').classList.add('hidden');
    renderQuestion();
    renderStatus();
  }

  function renderStatus() {
    const c = ctx();
    const self = me();
    const progress = self ? self.progress || 0 : 0;
    if (c.mode === 'sprint') {
      const correct = self ? self.correct || 0 : 0;
      const lap = Math.floor(correct / c.raceLength) + 1;
      $('race-progress').textContent = `${correct} ✓ · lap ${lap}`;
    } else {
      $('race-progress').textContent = `${progress} / ${c.raceLength}`;
    }
    const streak = self ? self.streak || 0 : 0;
    const flame = c.settings.nitro && c.mode === 'race' && streak >= NITRO_STREAK;
    $('race-streak').textContent = streak >= 2 ? `${flame ? '🔥 NITRO ' : '🔥 '}${streak} in a row` : '';
    renderTimer();
  }

  function renderTimer() {
    const c = ctx();
    if (c.mode === 'sprint') {
      if (!state.sprintEndsAt) {
        $('race-timer').textContent = `⏱ ${c.settings.sprintSec} s`;
        return;
      }
      const left = Math.max(0, state.sprintEndsAt - Date.now());
      $('race-timer').textContent = `⏱ ${Math.ceil(left / 1000)} s`;
      return;
    }
    const self = me();
    if (!state.raceStartAt) {
      $('race-timer').textContent = '0.0 s';
      return;
    }
    const ms = self && self.finished ? self.timeMs : Date.now() - state.raceStartAt;
    $('race-timer').textContent = formatTime(ms);
  }

  function renderQuestion() {
    const q = state.question;
    const auto = ctx().settings.autoSubmit;
    const slots = $('answer-slots');
    slots.classList.toggle('free', !auto);
    if (!q) {
      $('question-text').textContent = ctx().phase === 'countdown' || (state.practice && !state.raceStartAt) ? 'Get ready…' : '…';
      slots.innerHTML = '';
      return;
    }
    $('question-text').textContent = q.text;
    $('question-text').classList.toggle('long', q.text.length > 8);
    if (auto) {
      slots.innerHTML = Array.from({ length: q.answerLength }, (_, i) => {
        const ch = state.typed[i] || '';
        const cls = ch ? 'slot filled' : i === state.typed.length ? 'slot cursor' : 'slot';
        return `<div class="${cls}">${ch}</div>`;
      }).join('');
    } else {
      slots.innerHTML = `<div class="slot ${state.typed ? 'filled' : 'cursor'}">${state.typed || '&nbsp;'}</div>`;
    }
  }

  function onCountdown(n) {
    const el = $('countdown');
    const num = $('countdown-num');
    clearTimeout(onCountdown.hide);
    el.classList.remove('hidden');
    el.classList.toggle('go', n === 0);
    num.textContent = n === 0 ? 'GO!' : String(n);
    num.style.animation = 'none';
    void num.offsetWidth;
    num.style.animation = '';
    Sounds.play(n === 0 ? 'go' : 'tick');
    if (n === 0) {
      state.raceStartAt = Date.now();
      const c = ctx();
      if (c.mode === 'sprint') state.sprintEndsAt = Date.now() + c.settings.sprintSec * 1000;
      onCountdown.hide = setTimeout(() => el.classList.add('hidden'), 900);
    }
  }

  function onQuestion(q) {
    state.question = q;
    state.typed = '';
    state.pending = false;
    renderQuestion();
    renderStatus();
  }

  function onAnswerResult(r) {
    state.pending = false;
    const slots = $('answer-slots');
    if (r.correct) {
      Sounds.play(r.nitro ? 'nitro' : 'vroom');
      slots.classList.add('correct');
      setTimeout(() => slots.classList.remove('correct'), 200);
      const self = me();
      if (self && !state.practice) {
        self.progress += r.nitro ? 2 : 1;
        self.correct = (self.correct || 0) + 1;
        self.streak = r.streak;
      }
      if (r.nitro) nitroBurst();
      renderStatus();
    } else {
      Sounds.play('skid');
      slots.classList.add('wrong');
      $('skid-flash').classList.add('on');
      setTimeout(() => $('skid-flash').classList.remove('on'), 180);
      state.lockedUntil = Date.now() + r.stallMs;
      $('race-panel').classList.add('locked');
      setTimeout(() => {
        slots.classList.remove('wrong');
        state.typed = '';
        renderQuestion();
      }, 450);
      setTimeout(() => {
        $('race-panel').classList.remove('locked');
        state.typed = '';
        renderQuestion();
      }, r.stallMs);
      const self = me();
      if (self && !state.practice) self.streak = 0;
      renderStatus();
    }
  }

  function nitroBurst() {
    const el = $('nitro-burst');
    el.classList.remove('hidden');
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(nitroBurst.hide);
    nitroBurst.hide = setTimeout(() => el.classList.add('hidden'), 950);
  }

  function onProgress(p) {
    raceTrack.update(p.playerId, p);
    if (state.room) {
      const pl = state.room.players.find((x) => x.id === p.playerId);
      if (pl) {
        pl.progress = p.progress;
        pl.streak = p.streak;
        pl.correct = p.correct;
        if (p.finished) {
          pl.finished = true;
          pl.timeMs = p.timeMs;
        }
      }
    }
    if (p.playerId === state.you && p.finished) {
      state.finishedSelf = true;
      Sounds.play('cheer');
      renderRace();
    }
  }

  let flagTicker = null;
  function onFlagTimer({ seconds, winnerId }) {
    clearInterval(flagTicker);
    const winner = state.room && state.room.players.find((p) => p.id === winnerId);
    let left = seconds;
    const banner = $('flag-banner');
    const tick = () => {
      if (left < 0 || state.screen !== 'race') return clearInterval(flagTicker);
      banner.textContent = `🏁 ${winner ? winner.name : 'Someone'} finished! Race ends in ${left} s`;
      banner.classList.remove('hidden');
      left -= 1;
    };
    tick();
    flagTicker = setInterval(tick, 1000);
  }

  setInterval(() => {
    if (state.screen !== 'race') return;
    if (ctx().phase !== 'racing') return;
    renderTimer();
  }, 100);

  // ---- answer entry ------------------------------------------------------------
  function canType() {
    if (state.screen !== 'race' || !state.question || state.pending) return false;
    if (ctx().phase !== 'racing') return false;
    if (Date.now() < state.lockedUntil) return false;
    const self = me();
    if (!self || self.spectator || self.finished) return false;
    return true;
  }

  function submit() {
    if (!state.typed) return;
    state.pending = true;
    if (state.practice) practiceCheck(state.typed);
    else sock.send('answer', { questionIndex: state.question.index, value: state.typed });
  }

  function pressKey(key) {
    if (!canType()) return;
    const auto = ctx().settings.autoSubmit;
    if (key === 'back') {
      state.typed = state.typed.slice(0, -1);
    } else if (key === 'go') {
      if (!auto) submit();
    } else if (/^\d$/.test(key)) {
      const max = auto ? state.question.answerLength : 6;
      if (state.typed.length >= max) return;
      state.typed += key;
      if (auto && state.typed.length === state.question.answerLength) submit();
    }
    renderQuestion();
  }

  $('numpad').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b) return;
    e.preventDefault();
    pressKey(b.dataset.key);
  });
  document.addEventListener('keydown', (e) => {
    if (state.screen !== 'race') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^\d$/.test(e.key)) pressKey(e.key);
    else if (e.key === 'Backspace') pressKey('back');
    else if (e.key === 'Enter') pressKey('go');
    else return;
    e.preventDefault();
  });

  $('end-race-btn').addEventListener('click', () => {
    if (confirm('End the race for everyone?')) sock.send('end_race');
  });

  // ---- podium -----------------------------------------------------------------
  let lastPodiumKey = null;
  function onRaceFinished(msg) {
    renderPodium(msg.ranking, { mode: msg.mode, season: msg.season });
    showScreen('podium');
    const key = msg.ranking.map((r) => `${r.playerId}:${r.timeMs}:${r.correct}`).join(',');
    if (key !== lastPodiumKey) {
      lastPodiumKey = key;
      const winner = msg.ranking[0];
      const won = winner && winner.playerId === state.you && (winner.finished || (msg.mode === 'sprint' && winner.correct > 0));
      if (won) {
        SM.confetti($('confetti'));
        Sounds.play('cheer');
      }
    }
  }

  function scoreText(r, mode) {
    if (mode === 'sprint') return `${r.correct} correct`;
    return r.finished ? formatTime(r.timeMs) : `${r.progress}/${r.total} segments`;
  }

  function renderPodium(ranking, { mode = 'race', practice = false, season = null, best = null } = {}) {
    const theme = ctx().settings.theme;
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const top = ranking.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    $('podium').innerHTML = order
      .map(
        (r) => `<div class="podium-step p${r.place}">
          <div class="medal">${medals[r.place]}</div>
          <div class="car" style="background:${r.car.colour}">${spriteFor(r.car, theme)}</div>
          <div class="pname">${escapeHtml(r.name)}</div>
          <div class="ptime">${scoreText(r, mode)}</div>
          <div class="block"></div>
        </div>`
      )
      .join('');
    $('results-score-head').textContent = mode === 'sprint' ? 'Correct' : 'Time';
    $('results-body').innerHTML = ranking
      .map(
        (r) => `<tr class="${r.playerId === state.you ? 'you' : ''}">
          <td>${medals[r.place] || r.place}</td>
          <td>${spriteFor(r.car, theme)} ${escapeHtml(r.name)} <span class="muted">${LEVELS[r.level].emoji}${r.handicap > 0 ? ` +${r.handicap}` : ''}${r.nitros > 0 ? ` 🔥${r.nitros}` : ''}</span></td>
          <td>${mode === 'sprint' ? r.correct : r.finished ? formatTime(r.timeMs) : `${r.progress}/${r.total}`}</td>
          <td>${r.accuracy === null ? '—' : `${Math.round(r.accuracy * 100)}%`}</td>
          <td>${r.bestStreak}</td>
          <td class="col-fast">${formatFast(r.fastestMs)}</td>
        </tr>`
      )
      .join('');
    const fastest = ranking.filter((r) => r.fastestMs !== null && r.fastestMs !== undefined).sort((a, b) => a.fastestMs - b.fastestMs)[0];
    $('podium-fastest').classList.toggle('hidden', !fastest);
    if (fastest) $('podium-fastest').textContent = `⚡ Fastest answer: ${fastest.name}, ${formatFast(fastest.fastestMs)}`;
    $('podium-best').classList.toggle('hidden', !best);
    if (best) $('podium-best').textContent = best;
    if (practice || !season) {
      $('podium-season').classList.add('hidden');
      $('podium-season').innerHTML = '';
    } else renderSeason($('podium-season'), season);

    const winner = ranking[0];
    const self = me();
    const winnerReal = winner && (winner.finished || (mode === 'sprint' && winner.correct > 0));
    if (practice) $('podium-title').textContent = '🎯 Practice done!';
    else if (winnerReal && winner.playerId === state.you) $('podium-title').textContent = '🏆 You won!';
    else if (self && self.spectator) $('podium-title').textContent = '🏁 Race over! You race next.';
    else $('podium-title').textContent = winnerReal ? `🏁 ${winner.name} wins!` : '🏁 Race over!';
    const host = isHost();
    $('race-again-btn').classList.toggle('hidden', practice || !host);
    $('garage-btn').classList.toggle('hidden', practice || !host);
    $('practice-again-btn').classList.toggle('hidden', !practice);
    $('practice-home-btn').classList.toggle('hidden', !practice);
    $('podium-waiting').classList.toggle('hidden', practice || host);
  }

  $('race-again-btn').addEventListener('click', () => sock.send('race_again'));
  $('garage-btn').addEventListener('click', () => sock.send('back_to_lobby'));

  // ---- practice: solo, no room, checked in the browser -------------------------
  function practicePlayer() {
    const p = state.practice;
    return { id: 'you', name: p.name, car: p.car, level: p.level, progress: p.progress, correct: p.correct, streak: p.streak, finished: p.finished, timeMs: p.timeMs, spectator: false, connected: true };
  }

  function startPractice() {
    const id = identity();
    if (!id) return;
    if (!window.SMQuestions) return toast('Practice mode did not load; refresh the page');
    if (state.room) {
      sock.send('leave_room');
      sessionStore.clear();
      state.room = null;
      state.code = null;
      state.token = null;
    }
    const settings = { ...PRACTICE_SETTINGS, theme: prefs.theme || 'cars' };
    state.practice = {
      settings,
      questions: SMQuestions.generate(Date.now(), id.level, settings.ops, PRACTICE_LENGTH),
      name: id.name,
      car: id.car,
      level: id.level,
      index: 0,
      progress: 0,
      correct: 0,
      wrong: 0,
      streak: 0,
      best: 0,
      fastest: null,
      shownAt: null,
      finished: false,
      timeMs: null,
    };
    state.question = null;
    state.typed = '';
    state.pending = false;
    state.lockedUntil = 0;
    state.raceStartAt = null;
    state.sprintEndsAt = null;
    $('flag-banner').classList.add('hidden');
    applyTheme(settings.theme);
    renderRace();
    showScreen('race');
    let n = 3;
    const tick = () => {
      if (!state.practice) return;
      onCountdown(n);
      if (n === 0) practiceNext();
      else {
        n -= 1;
        state.practice.countdownTimer = setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function practiceNext() {
    const p = state.practice;
    const q = p.questions[p.index];
    if (!q) return practiceFinish();
    state.question = { index: p.index, text: q.text, answerLength: String(q.answer).length, total: p.questions.length };
    p.shownAt = Date.now();
    state.typed = '';
    state.pending = false;
    renderQuestion();
    renderStatus();
  }

  function practiceCheck(value) {
    const p = state.practice;
    const q = p.questions[p.index];
    const correct = Number(value) === q.answer;
    if (correct) {
      p.index += 1;
      p.correct += 1;
      p.progress += 1;
      p.streak += 1;
      p.best = Math.max(p.best, p.streak);
      const dt = Date.now() - p.shownAt;
      if (p.fastest === null || dt < p.fastest) p.fastest = dt;
    } else {
      p.wrong += 1;
      p.streak = 0;
    }
    const finished = correct && p.progress >= PRACTICE_LENGTH;
    onAnswerResult({ index: state.question.index, correct, stallMs: correct ? 0 : 1500, streak: p.streak, nitro: false });
    raceTrack.update('you', { progress: p.progress, total: PRACTICE_LENGTH, streak: p.streak, skid: !correct, finished });
    if (finished) {
      p.finished = true;
      p.timeMs = Date.now() - state.raceStartAt;
      Sounds.play('cheer');
      setTimeout(practiceFinish, 350);
    } else if (correct) practiceNext();
  }

  function practiceFinish() {
    const p = state.practice;
    if (!p) return;
    p.finished = true;
    const ranking = [
      {
        place: 1,
        playerId: 'you',
        name: p.name,
        car: p.car,
        level: p.level,
        finished: p.progress >= PRACTICE_LENGTH,
        timeMs: p.timeMs,
        progress: p.progress,
        total: PRACTICE_LENGTH,
        correct: p.correct,
        wrong: p.wrong,
        accuracy: p.correct + p.wrong > 0 ? p.correct / (p.correct + p.wrong) : null,
        bestStreak: p.best,
        fastestMs: p.fastest,
        nitros: 0,
        handicap: 0,
      },
    ];
    // Personal best per level, kept on this device only.
    let best = null;
    if (p.progress >= PRACTICE_LENGTH) {
      const prev = bestFor(p.level);
      const all = bestStore.get() || {};
      if (!prev || p.timeMs < prev.timeMs) {
        all[p.level] = { timeMs: p.timeMs, at: Date.now() };
        bestStore.set(all);
        best = prev ? `🏅 New personal best! ${formatTime(p.timeMs)} (was ${formatTime(prev.timeMs)})` : `🏅 First run at this level: ${formatTime(p.timeMs)}. Beat it next time!`;
      } else {
        best = `Your best at this level: ${formatTime(prev.timeMs)}. This run: ${formatTime(p.timeMs)}`;
      }
      renderPracticeBest();
    }
    renderPodium(ranking, { mode: 'race', practice: true, best });
    showScreen('podium');
    if (p.progress >= PRACTICE_LENGTH) SM.confetti($('confetti'), { count: 90, durationMs: 2500 });
  }

  function stopPractice() {
    if (state.practice && state.practice.countdownTimer) clearTimeout(state.practice.countdownTimer);
    state.practice = null;
    state.question = null;
    state.raceStartAt = null;
    $('countdown').classList.add('hidden');
    applyTheme('cars');
    showScreen('home');
  }
  $('quit-practice-btn').addEventListener('click', stopPractice);
  $('practice-home-btn').addEventListener('click', stopPractice);
  $('practice-again-btn').addEventListener('click', () => {
    stopPractice();
    startPractice();
  });

  // ---- sound / mute ----------------------------------------------------------
  function renderMute() {
    $('mute-btn').textContent = Sounds.muted ? '🔇' : '🔊';
  }
  renderMute();
  $('mute-btn').addEventListener('click', () => {
    Sounds.init();
    Sounds.setMuted(!Sounds.muted);
    prefs.muted = Sounds.muted;
    savePrefs();
    renderMute();
    if (!Sounds.muted) Sounds.play('join');
  });
  const unlockAudio = () => {
    Sounds.init();
    document.removeEventListener('pointerdown', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  };
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  // Installable app: the service worker keeps the pages cached so the app
  // opens from the home screen and practice works offline.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
