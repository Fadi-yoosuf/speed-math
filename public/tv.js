/* TV / projector view: read-only, big fonts, shows the join code and QR. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const track = SM.Track($('tv-track'));
  let code = null;
  let room = null;
  let raceLength = 20;

  function codeFromUrl() {
    const m = location.pathname.match(/^\/tv\/([A-Za-z]{4})/);
    return m ? m[1].toUpperCase() : null;
  }

  const sock = SM.connect({
    onOpen() {
      if (code) sock.send('watch_room', { code });
    },
    onMessage(msg) {
      switch (msg.type) {
        case 'watching':
          $('tv-enter').classList.add('hidden');
          $('tv-room').classList.remove('hidden');
          $('tv-room-code').textContent = msg.code;
          $('tv-join-url').textContent = msg.joinUrl.replace(/^https?:\/\//, '');
          if (msg.qrDataUrl) {
            $('tv-qr').src = msg.qrDataUrl;
            $('tv-qr').hidden = false;
          }
          break;
        case 'room_state':
          room = msg;
          raceLength = msg.raceLength;
          renderRoom();
          break;
        case 'countdown':
          showCountdown(msg.secondsLeft);
          break;
        case 'progress':
          track.update(msg.playerId, msg);
          if (room) {
            const pl = room.players.find((x) => x.id === msg.playerId);
            if (pl) {
              pl.progress = msg.progress;
              pl.correct = msg.correct;
              pl.streak = msg.streak;
            }
          }
          if (msg.finished && room) {
            const p = room.players.find((x) => x.id === msg.playerId);
            if (p) $('tv-status').textContent = `🏁 ${p.name} finished in ${SM.formatTime(msg.timeMs)}!`;
          }
          break;
        case 'flag_timer':
          startFlagTicker(msg.seconds);
          break;
        case 'race_finished':
          clearInterval(sprintTicker);
          renderPodium(msg.ranking, { mode: msg.mode });
          break;
        case 'error':
          SM.toast(msg.message);
          if (msg.code === 'ROOM_NOT_FOUND') {
            code = null;
            $('tv-room').classList.add('hidden');
            $('tv-enter').classList.remove('hidden');
          }
          break;
        default:
          break;
      }
    },
  });

  let flagTimer = null;
  function startFlagTicker(seconds) {
    clearInterval(flagTimer);
    let left = seconds;
    const tick = () => {
      if (left <= 0) return clearInterval(flagTimer);
      $('tv-status').textContent = `🏁 First car is home! Race ends in ${left} s`;
      left -= 1;
    };
    tick();
    flagTimer = setInterval(tick, 1000);
  }

  let sprintTicker = null;
  function startSprintTicker(remainingMs) {
    clearInterval(sprintTicker);
    const endsAt = Date.now() + remainingMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      $('tv-status').textContent = `⏱ ${left} s left · most sums wins`;
      if (left <= 0) clearInterval(sprintTicker);
    };
    tick();
    sprintTicker = setInterval(tick, 250);
  }

  function renderRoom() {
    const phase = room.phase;
    const mode = room.mode || room.settings.mode;
    SM.applyTheme(room.settings.theme);
    track.render(room.players, { raceLength, hostId: room.hostId, lastWinnerId: room.lastWinnerId, phase, theme: room.settings.theme, mode, nitro: room.settings.nitro });
    $('tv-track').classList.toggle('hidden', phase === 'finished');
    $('tv-podium').classList.toggle('hidden', phase !== 'finished');
    if (phase !== 'racing') clearInterval(sprintTicker);
    if (phase === 'lobby') {
      clearInterval(flagTimer);
      const n = room.players.length;
      const what = mode === 'sprint' ? `Sprint: most sums in ${room.settings.sprintSec} s.` : `Race to ${raceLength} segments.`;
      $('tv-status').textContent = n ? `${n} racer${n === 1 ? '' : 's'} on the grid. ${what} Waiting for the host…` : 'Waiting for racers…';
    } else if (phase === 'countdown') {
      $('tv-status').textContent = 'Get ready…';
    } else if (phase === 'racing') {
      if (mode === 'sprint' && room.sprintRemainingMs !== null) startSprintTicker(room.sprintRemainingMs);
      else if (mode === 'sprint') startSprintTicker(room.settings.sprintSec * 1000);
      else $('tv-status').textContent = '🏎️ Racing!';
    } else if (phase === 'finished') {
      clearInterval(flagTimer);
      $('tv-status').textContent = '🏁 Race over!';
      if (room.ranking) renderPodium(room.ranking, { quiet: true, mode });
    }
  }

  let lastPodiumKey = null;
  function renderPodium(ranking, { quiet, mode = 'race' } = {}) {
    const key = ranking.map((r) => r.playerId).join(',') + ranking.map((r) => `${r.timeMs}:${r.correct}`).join(',');
    const theme = room ? room.settings.theme : 'cars';
    $('tv-podium').classList.remove('hidden');
    $('tv-track').classList.add('hidden');
    const top = ranking.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
    $('tv-podium').innerHTML = order
      .map(
        (r) => `<div class="podium-step p${r.place}">
          <div class="medal">${medals[r.place]}</div>
          <div class="car" style="background:${r.car.colour}">${SM.spriteFor(r.car, theme)}</div>
          <div class="pname">${SM.escapeHtml(r.name)}</div>
          <div class="ptime">${mode === 'sprint' ? `${r.correct} correct` : r.finished ? SM.formatTime(r.timeMs) : `${r.progress}/${r.total} segments`}</div>
          <div class="block"></div>
        </div>`
      )
      .join('');
    const fastest = ranking.filter((r) => r.fastestMs !== null && r.fastestMs !== undefined).sort((a, b) => a.fastestMs - b.fastestMs)[0];
    if (fastest) $('tv-podium').insertAdjacentHTML('beforeend', `<div class="podium-fastest tv-fastest">⚡ Fastest answer: ${SM.escapeHtml(fastest.name)}, ${SM.formatFast(fastest.fastestMs)}</div>`);
    if (!quiet && key !== lastPodiumKey) SM.confetti($('tv-confetti'));
    lastPodiumKey = key;
  }

  let hideTimer = null;
  function showCountdown(n) {
    const el = $('tv-countdown');
    const num = $('tv-countdown-num');
    clearTimeout(hideTimer);
    el.classList.remove('hidden');
    el.classList.toggle('go', n === 0);
    num.textContent = n === 0 ? 'GO!' : String(n);
    num.style.animation = 'none';
    void num.offsetWidth;
    num.style.animation = '';
    if (n === 0) hideTimer = setTimeout(() => el.classList.add('hidden'), 900);
  }

  function watch(c) {
    code = c;
    history.replaceState(null, '', `/tv/${code}`);
    if (sock.isOpen()) sock.send('watch_room', { code });
  }

  $('tv-watch-btn').addEventListener('click', () => {
    const c = $('tv-code-input').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(c)) return SM.toast('Room codes are four letters');
    watch(c);
  });
  $('tv-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('tv-watch-btn').click();
  });
  document.addEventListener('dblclick', () => {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
  });

  const initial = codeFromUrl();
  if (initial) {
    code = initial;
    $('tv-code-input').value = initial;
  }
})();
