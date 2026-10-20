'use strict';

// HTTP + WebSocket wiring for Speed Math.
//
//   node server/index.js            → serves ./public and prints the LAN URL
//   const { startServer } = require('./server'); await startServer({ port: 0 })

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

const { RoomRegistry } = require('./rooms');
const { parseMessage } = require('./protocol');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HEARTBEAT_MS = 30 * 1000;
const JOIN_LIMIT_PER_MIN = 20; // create/join attempts per IP per minute
const MSG_LIMIT_PER_SEC = 30; // messages per connection per second

// First non-internal IPv4 address, for the "open this on your Wi-Fi" line.
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get('/join/:code', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.get(['/tv', '/tv/:code'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tv.html')));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  return app;
}

class RateBucket {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  allow(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
  prune(now = Date.now()) {
    for (const [key, list] of this.hits) {
      const kept = list.filter((t) => now - t < this.windowMs);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}

function startServer({ port = 3000, host = '0.0.0.0', log = console.log, registry } = {}) {
  const rooms = registry || new RoomRegistry();
  const app = createApp();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
  const connectionsByRoom = new Map(); // code → Set<conn>
  const joinBucket = new RateBucket(JOIN_LIMIT_PER_MIN, 60 * 1000);
  const qrCache = new Map();

  function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws, message, code) {
    send(ws, { type: 'error', message, code });
  }

  function connectionsFor(code) {
    if (!connectionsByRoom.has(code)) connectionsByRoom.set(code, new Set());
    return connectionsByRoom.get(code);
  }

  function broadcastState(room) {
    const state = room.toState();
    for (const conn of connectionsFor(room.code)) {
      send(conn.ws, { type: 'room_state', ...state, you: conn.playerId || null });
    }
  }

  function wireRoom(room) {
    room.on('send', (playerId, msg) => {
      for (const conn of connectionsFor(room.code)) {
        if (conn.playerId === playerId) send(conn.ws, msg);
      }
    });
    room.on('broadcast', (msg) => {
      for (const conn of connectionsFor(room.code)) send(conn.ws, msg);
    });
    room.on('changed', () => broadcastState(room));
  }

  async function qrFor(url) {
    if (!qrCache.has(url)) {
      if (qrCache.size > 500) qrCache.clear();
      qrCache.set(url, await QRCode.toDataURL(url, { margin: 1, width: 256, errorCorrectionLevel: 'M' }));
    }
    return qrCache.get(url);
  }

  // Public origin as seen by this client, so join links work on the LAN and
  // behind a tunnel or reverse proxy alike.
  function originFor(req) {
    const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = fwdProto || (req.socket.encrypted ? 'https' : 'http');
    let hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!hostHeader || ['localhost', '127.0.0.1', '::1'].includes(hostname)) {
      const lan = lanAddress();
      if (lan) hostHeader = `${lan}:${server.address().port}`;
    }
    return `${proto}://${hostHeader}`;
  }

  async function welcome(conn, room, player) {
    const joinUrl = `${conn.origin}/join/${room.code}`;
    const tvUrl = `${conn.origin}/tv/${room.code}`;
    let qrDataUrl = null;
    try {
      qrDataUrl = await qrFor(joinUrl);
    } catch (err) {
      log('QR generation failed:', err.message);
    }
    send(conn.ws, { type: 'welcome', playerId: player.id, token: player.token, code: room.code, joinUrl, tvUrl, qrDataUrl });
  }

  function leaveCurrent(conn, { forget } = {}) {
    if (!conn.roomCode) return;
    const room = rooms.get(conn.roomCode);
    connectionsFor(conn.roomCode).delete(conn);
    if (room && conn.playerId) {
      if (forget) room.removePlayer(conn.playerId);
      else room.disconnect(conn.playerId);
    }
    conn.roomCode = null;
    conn.playerId = null;
    conn.role = null;
  }

  async function handle(conn, msg) {
    const { type, payload } = msg;
    const room = conn.roomCode ? rooms.get(conn.roomCode) : null;

    switch (type) {
      case 'create_room': {
        if (!joinBucket.allow(conn.ip)) return sendError(conn.ws, 'too many rooms, slow down');
        leaveCurrent(conn, { forget: true });
        const created = rooms.create(payload.settings);
        if (!created.ok) return sendError(conn.ws, created.error);
        wireRoom(created.room);
        const added = created.room.addPlayer(payload);
        conn.roomCode = created.room.code;
        conn.playerId = added.player.id;
        conn.role = 'player';
        connectionsFor(created.room.code).add(conn);
        await welcome(conn, created.room, added.player);
        broadcastState(created.room);
        log(`room ${created.room.code} created by ${added.player.name}`);
        return;
      }
      case 'join_room': {
        if (!joinBucket.allow(conn.ip)) return sendError(conn.ws, 'too many joins, slow down');
        const target = rooms.get(payload.code);
        if (!target) return sendError(conn.ws, `no race called ${payload.code}`, 'ROOM_NOT_FOUND');
        leaveCurrent(conn, { forget: !payload.token });
        let player = null;
        if (payload.token) {
          player = target.reconnect(payload.token);
          if (!player) return sendError(conn.ws, 'that race has moved on, join again', 'ROOM_NOT_FOUND');
        } else {
          const added = target.addPlayer(payload);
          if (!added.ok) return sendError(conn.ws, added.error);
          player = added.player;
        }
        conn.roomCode = target.code;
        conn.playerId = player.id;
        conn.role = 'player';
        connectionsFor(target.code).add(conn);
        await welcome(conn, target, player);
        broadcastState(target);
        // A reconnecting racer needs their current question back.
        if (target.phase === 'racing' && !player.spectator && player.finishedAt === null) target.sendQuestion(player);
        return;
      }
      case 'watch_room': {
        const target = rooms.get(payload.code);
        if (!target) return sendError(conn.ws, `no race called ${payload.code}`, 'ROOM_NOT_FOUND');
        leaveCurrent(conn);
        conn.roomCode = target.code;
        conn.role = 'watcher';
        connectionsFor(target.code).add(conn);
        const joinUrl = `${conn.origin}/join/${target.code}`;
        let qrDataUrl = null;
        try {
          qrDataUrl = await qrFor(joinUrl);
        } catch {
          /* QR is optional */
        }
        send(conn.ws, { type: 'watching', code: target.code, joinUrl, qrDataUrl });
        send(conn.ws, { type: 'room_state', ...target.toState(), you: null });
        return;
      }
      case 'leave_room':
        leaveCurrent(conn, { forget: true });
        send(conn.ws, { type: 'left' });
        return;
      case 'ping':
        send(conn.ws, { type: 'pong' });
        return;
      default:
        break;
    }

    if (!room || !conn.playerId) return sendError(conn.ws, 'join a race first');
    let result;
    switch (type) {
      case 'update_settings':
        result = room.updateSettings(conn.playerId, payload.settings);
        break;
      case 'set_level':
        result = room.setLevel(conn.playerId, payload.level);
        break;
      case 'start_race':
        result = room.start(conn.playerId);
        break;
      case 'answer':
        result = room.answer(conn.playerId, payload.questionIndex, payload.value);
        // Stale or locked answers are expected during fast play; stay quiet.
        if (!result.ok) return;
        break;
      case 'end_race':
        result = room.endRace(conn.playerId);
        break;
      case 'race_again':
        result = room.raceAgain(conn.playerId);
        break;
      case 'back_to_lobby':
        result = room.backToLobby(conn.playerId);
        break;
      default:
        result = { ok: false, error: 'unknown message' };
    }
    if (!result.ok) sendError(conn.ws, result.error);
  }

  wss.on('connection', (ws, req) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const conn = { ws, ip, origin: originFor(req), roomCode: null, playerId: null, role: null, alive: true, recent: [] };
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data) => {
      const now = Date.now();
      conn.recent = conn.recent.filter((t) => now - t < 1000);
      if (conn.recent.length >= MSG_LIMIT_PER_SEC) return;
      conn.recent.push(now);
      const parsed = parseMessage(data.toString());
      if (!parsed.ok) return sendError(ws, parsed.error);
      handle(conn, parsed).catch((err) => {
        log('handler error:', err);
        sendError(ws, 'something went wrong');
      });
    });
    ws.on('close', () => leaveCurrent(conn));
    ws.on('error', () => leaveCurrent(conn));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = [...connectionsByRoom.values()].flatMap((s) => [...s]).find((c) => c.ws === ws);
      if (conn && !conn.alive) {
        ws.terminate();
        continue;
      }
      if (conn) conn.alive = false;
      ws.ping();
    }
    joinBucket.prune();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Expired rooms: drop their (empty) connection sets too.
  const originalSweep = rooms.sweep.bind(rooms);
  rooms.sweep = (now) => {
    const removed = originalSweep(now);
    for (const code of removed) connectionsByRoom.delete(code);
    if (removed.length) log(`expired rooms: ${removed.join(', ')}`);
    return removed;
  };
  rooms.startSweeper();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      const lan = lanAddress();
      log(`Speed Math is running.`);
      log(`  Local:  http://localhost:${actualPort}`);
      if (lan) log(`  Wi-Fi:  http://${lan}:${actualPort}   ← open this on phones and tablets on this Wi-Fi`);
      resolve({
        server,
        wss,
        rooms,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () =>
          new Promise((res) => {
            clearInterval(heartbeat);
            rooms.stopSweeper();
            for (const ws of wss.clients) ws.terminate();
            rooms.clear();
            connectionsByRoom.clear();
            wss.close(() => server.close(() => res()));
          }),
      });
    });
  });
}

module.exports = { startServer, createApp, lanAddress, RateBucket };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  startServer({ port }).catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}
