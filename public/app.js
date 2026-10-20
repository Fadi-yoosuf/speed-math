/* Speed Math — player app. Screens: home → lobby → race → podium. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { LEVELS, CARS, COLOURS, escapeHtml, formatTime, toast, Sounds } = SM;

  const prefStore = SM.storage('local', 'speedmath.prefs');
  const sessionStore = SM.storage('session', 'speedmath.session');

  const prefs = Object.assign(
    { name: '', car: { emoji: CARS[0], colour: COLOURS[Math.floor(Math.random() * COLOURS.length)] }, level: 2, muted: false },
    prefStore.get() || {}
  );
  Sounds.setMuted(prefs.muted);

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
    finishedSelf: false,
    screen: 'home',
    flagLeft: null,
  };

  const lobbyTrack = SM.Track($('lobby-track'));
  const raceTrack = SM.Track($('race-track'));

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
      else if (saved && saved.code && saved.token) sock.send('join_room', { code: saved.code, token: saved.token });
    },
    onClose() {
      $('conn-dot').className = 'conn-dot off';
      $('conn-dot').title = 'Reconnecting…';
    },
    onMessage: handleMessage,
  });

  function handleMessage(msg) {
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
        toast(msg.message);
        if (msg.code === 'ROOM_NOT_FOUND') leaveLocally();
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
    showScreen('home');
  }

  // ---- room state ------------------------------------------------------------
  function onRoomState(room) {
    const prevPhase = state.room ? state.room.phase : null;
    state.room = room;
    state.you = room.you;
    if (room.phase === 'lobby') {
      renderLobby();
      showScreen('lobby');
    } else if (room.phase === 'countdown' || room.phase === 'racing') {
      if (prevPhase !== 'countdown' && prevPhase !== 'racing') {
        state.question = null;
        state.typed = '';
        state.finishedSelf = false;
        state.flagLeft = null;
        $('flag-banner').classList.add('hidden');
      }
      if (room.phase === 'racing' && room.raceElapsedMs !== null) state.raceStartAt = Date.now() - room.raceElapsedMs;
      renderRace();
      showScreen('race');
    } else if (room.phase === 'finished') {
      renderPodium(room.ranking || []);
      showScreen('podium');
    }
  }

  function me() {
    return state.room ? state.room.players.find((p) => p.id === state.you) || null : null;
  }
  function isHost() {
    return Boolean(state.room && state.room.hostId === state.you);
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
  });
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
  function renderShare() {
    const info = state.joinInfo;
    if (!info) return;
    $('room-code').textContent = info.code;
    $('join-url').textContent = info.joinUrl.replace(/^https?:\/\//, '');
    $('join-url').href = info.joinUrl;
    $('tv-url').href = info.tvUrl;
    if (info.qrDataUrl) {
      $('qr-img').src = info.qrDataUrl;
      $('qr-img').hidden = false;
    } else $('qr-img').hidden = true;
  }

  $('copy-link-btn').addEventListener('click', async () => {
    if (!state.joinInfo) return;
    try {
      await navigator.clipboard.writeText(state.joinInfo.joinUrl);
      toast('Link copied!');
    } catch {
      toast(state.joinInfo.joinUrl);
    }
  });

  function renderLobby() {
    const room = state.room;
    const host = isHost();
    $('player-count').textContent = `(${room.players.length}/12)`;
    lobbyTrack.render(room.players, { raceLength: room.raceLength, youId: state.you, hostId: room.hostId, lastWinnerId: room.lastWinnerId, phase: room.phase });
    const self = me();
    $('lobby-level-picker').innerHTML = levelButtons(self ? self.level : prefs.level, Boolean(room.settings.lockLevel));
    $('start-btn').classList.toggle('hidden', !host);
    $('waiting-host').classList.toggle('hidden', host);
    $('settings-card').classList.toggle('readonly', !host);
    $('settings-owner').textContent = host ? '(you are the host ⭐)' : '(set by the host)';
    syncSettingsForm(room.settings);
  }

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
    const lock = card.querySelector('select[name="lockLevel"]');
    if (document.activeElement !== lock) lock.value = s.lockLevel ? String(s.lockLevel) : '';
    const flag = card.querySelector('input[name="flagTimerSec"]');
    if (document.activeElement !== flag) flag.value = s.flagTimerSec;
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
    else if (el.name === 'flagTimerSec') {
      const v = Math.max(5, Math.min(120, Math.round(Number(el.value) / 5) * 5 || 20));
      el.value = v;
      partial.flagTimerSec = v;
    } else return;
    sock.send('update_settings', { settings: partial });
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
    const room = state.room;
    raceTrack.render(room.players, { raceLength: room.raceLength, youId: state.you, hostId: room.hostId, phase: room.phase });
    const self = me();
    const spectator = Boolean(self && self.spectator);
    const finished = Boolean(self && self.finished);
    $('spectator-note').classList.toggle('hidden', !spectator);
    $('question-card').classList.toggle('hidden', spectator || finished);
    $('numpad').classList.toggle('hidden', spectator || finished);
    $('numpad').classList.toggle('auto', Boolean(room.settings.autoSubmit));
    $('end-race-btn').classList.toggle('hidden', !isHost());
    if (finished) {
      $('finished-note').textContent = `🏁 You finished in ${formatTime(self.timeMs)}! Watch the others…`;
      $('finished-note').classList.remove('hidden');
    } else $('finished-note').classList.add('hidden');
    renderQuestion();
    renderStatus();
  }

  function renderStatus() {
    const room = state.room;
    const self = me();
    const progress = self ? self.progress : 0;
    $('race-progress').textContent = `${progress} / ${room ? room.raceLength : 20}`;
    const streak = self ? self.streak : 0;
    $('race-streak').textContent = streak >= 2 ? `🔥 ${streak} in a row` : '';
  }

  function renderQuestion() {
    const q = state.question;
    const auto = state.room && state.room.settings.autoSubmit;
    const slots = $('answer-slots');
    slots.classList.toggle('free', !auto);
    if (!q) {
      $('question-text').textContent = state.room && state.room.phase === 'countdown' ? 'Get ready…' : '…';
      slots.innerHTML = '';
      return;
    }
    $('question-text').textContent = q.text;
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
      Sounds.play('vroom');
      slots.classList.add('correct');
      setTimeout(() => slots.classList.remove('correct'), 200);
      const self = me();
      if (self) {
        self.progress += 1;
        self.streak = r.streak;
      }
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
      if (self) self.streak = 0;
      renderStatus();
    }
  }

  function onProgress(p) {
    raceTrack.update(p.playerId, p);
    if (state.room) {
      const pl = state.room.players.find((x) => x.id === p.playerId);
      if (pl) {
        pl.progress = p.progress;
        pl.streak = p.streak;
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
      banner.textContent = `🏁 ${winner ? escapeHtml(winner.name) : 'Someone'} finished! Race ends in ${left} s`;
      banner.classList.remove('hidden');
      left -= 1;
    };
    tick();
    flagTicker = setInterval(tick, 1000);
  }

  setInterval(() => {
    if (state.screen !== 'race' || !state.raceStartAt || state.room.phase !== 'racing') return;
    const self = me();
    const ms = self && self.finished ? self.timeMs : Date.now() - state.raceStartAt;
    $('race-timer').textContent = formatTime(ms);
  }, 100);

  // ---- answer entry ------------------------------------------------------------
  function canType() {
    if (state.screen !== 'race' || !state.question || state.pending) return false;
    if (!state.room || state.room.phase !== 'racing') return false;
    if (Date.now() < state.lockedUntil) return false;
    const self = me();
    if (!self || self.spectator || self.finished) return false;
    return true;
  }

  function submit() {
    if (!state.typed) return;
    state.pending = true;
    sock.send('answer', { questionIndex: state.question.index, value: state.typed });
  }

  function pressKey(key) {
    if (!canType()) return;
    const auto = state.room.settings.autoSubmit;
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
    renderPodium(msg.ranking);
    showScreen('podium');
    const key = msg.ranking.map((r) => `${r.playerId}:${r.timeMs}`).join(',');
    if (key !== lastPodiumKey) {
      lastPodiumKey = key;
      const winner = msg.ranking[0];
      if (winner && winner.finished && winner.playerId === state.you) {
        SM.confetti($('confetti'));
        Sounds.play('cheer');
      }
    }
  }

  function renderPodium(ranking) {
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const top = ranking.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    $('podium').innerHTML = order
      .map(
        (r) => `<div class="podium-step p${r.place}">
          <div class="medal">${medals[r.place]}</div>
          <div class="car" style="background:${r.car.colour}">${r.car.emoji}</div>
          <div class="pname">${escapeHtml(r.name)}</div>
          <div class="ptime">${r.finished ? formatTime(r.timeMs) : `${r.progress}/${r.total} sums`}</div>
          <div class="block"></div>
        </div>`
      )
      .join('');
    $('results-body').innerHTML = ranking
      .map(
        (r) => `<tr class="${r.playerId === state.you ? 'you' : ''}">
          <td>${medals[r.place] || r.place}</td>
          <td>${r.car.emoji} ${escapeHtml(r.name)} <span class="muted">${LEVELS[r.level].emoji}</span></td>
          <td>${r.finished ? formatTime(r.timeMs) : `${r.progress}/${r.total}`}</td>
          <td>${r.accuracy === null ? '—' : `${Math.round(r.accuracy * 100)}%`}</td>
          <td>${r.bestStreak}</td>
        </tr>`
      )
      .join('');
    const winner = ranking[0];
    const self = me();
    if (winner && winner.playerId === state.you && winner.finished) $('podium-title').textContent = '🏆 You won!';
    else if (self && self.spectator) $('podium-title').textContent = '🏁 Race over! You race next.';
    else $('podium-title').textContent = winner && winner.finished ? `🏁 ${winner.name} wins!` : '🏁 Race over!';
    const host = isHost();
    $('race-again-btn').classList.toggle('hidden', !host);
    $('garage-btn').classList.toggle('hidden', !host);
    $('podium-waiting').classList.toggle('hidden', host);
  }

  $('race-again-btn').addEventListener('click', () => sock.send('race_again'));
  $('garage-btn').addEventListener('click', () => sock.send('back_to_lobby'));

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
})();
