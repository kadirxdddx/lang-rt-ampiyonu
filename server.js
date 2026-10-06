import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { createGame, applyInput, stepGame, snapshot, pauseGame, beginGame } from './shared/game.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['scene.js', 'text/javascript; charset=utf-8']],
  ['/shared/game.js', ['shared/game.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.module.js', ['node_modules/three/build/three.module.js', 'text/javascript; charset=utf-8']],
  ['/vendor/three.core.js', ['node_modules/three/build/three.core.js', 'text/javascript; charset=utf-8']],
]);
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createFoosballServer({ reconnectMs = 60_000, heartbeatMs = 15_000, maxRooms = 500 } = {}) {
  const rooms = new Map();
  const server = http.createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { res.writeHead(400).end('Bad request'); return; }
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-cache' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end(); return;
    }
    if (pathname === '/health') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, rooms: rooms.size })); return;
    }
    const asset = assets.get(pathname);
    if (!asset) { res.writeHead(404, headers).end('Not found'); return; }
    try {
      const data = await fs.readFile(path.join(root, asset[0]));
      res.writeHead(200, { ...headers, 'Content-Type': asset[1] });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404, headers).end('Not found'); }
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });
  let chatId = 0;
  let closing = false;

  function send(ws, message, disposable = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 128 * 1024) {
      if (!disposable) ws.close(1013, 'Connection too slow');
      return;
    }
    ws.send(JSON.stringify(message));
  }
  function broadcast(room, message, disposable = false) { room.players.forEach(player => send(player?.ws, message, disposable)); }
  function roomStatus(room) {
    broadcast(room, { type: 'room', code: room.code, connected: room.players.map(player => Boolean(player?.ws)), ready: room.ready.slice() });
  }
  function sendState(room) { broadcast(room, { type: 'state', time: performance.now(), state: snapshot(room.game) }, true); }
  function error(ws, message) { send(ws, { type: 'error', message }); }
  function detach(ws, explicit = false) {
    const room = ws.room;
    if (!room) return;
    const team = ws.team;
    const player = room.players[team];
    ws.room = null;
    if (player?.ws !== ws) return;
    player.ws = null;
    player.expires = Date.now() + reconnectMs;
    if (explicit) room.players[team] = null;
    room.ready = [false, false];
    pauseGame(room.game);
    if (room.players.every(entry => !entry)) rooms.delete(room.code);
    else { roomStatus(room); sendState(room); }
  }
  function attach(ws, room, team, existing = null) {
    const player = existing || { token: randomBytes(24).toString('hex'), ws: null, expires: 0 };
    if (!existing) {
      room.game.ack[team] = -1;
      for (let index = team * 3; index < team * 3 + 3; index++) room.game.kickSeq[index] = 0;
    }
    if (player.ws && player.ws !== ws) {
      player.ws.room = null;
      player.ws.close(4001, 'Session resumed in another tab');
    }
    player.ws = ws;
    player.expires = 0;
    room.players[team] = player;
    ws.room = room;
    ws.team = team;
    send(ws, { type: 'joined', code: room.code, team, token: player.token,
      inputSeq: room.game.ack[team], kickSeq: room.game.kickSeq.slice(team * 3, team * 3 + 3) });
    roomStatus(room); sendState(room);
  }
  function code() {
    let value;
    do { value = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(value));
    return value;
  }
  function rateLimit(ws, key, limit, windowMs) {
    const now = performance.now();
    let slot = ws.rates[key];
    if (!slot || now - slot.start >= windowMs) slot = ws.rates[key] = { start: now, count: 0 };
    return ++slot.count <= limit;
  }
  wss.on('connection', ws => {
    ws.room = null; ws.alive = true; ws.rates = Object.create(null);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      if (!rateLimit(ws, 'all', 180, 1000)) return;
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'ping') {
        if (rateLimit(ws, 'ping', 4, 1000) && Number.isFinite(message.sentAt)) send(ws, { type: 'pong', sentAt: message.sentAt });
        return;
      }
      if (message.type === 'create') {
        if (!rateLimit(ws, 'lobby', 8, 10_000)) return;
        if (rooms.size >= maxRooms) { error(ws, 'Sunucu şu an dolu, biraz sonra tekrar dene.'); return; }
        detach(ws, true);
        const room = { code: code(), players: [null, null], ready: [false, false], game: createGame() };
        rooms.set(room.code, room); attach(ws, room, 0); return;
      }
      if (message.type === 'join') {
        if (!rateLimit(ws, 'lobby', 8, 10_000)) return;
        const room = rooms.get(String(message.code || '').trim().toUpperCase());
        if (!room) { error(ws, 'Bu oda bulunamadı. Oda kodunu kontrol et.'); return; }
        let team = -1;
        if (typeof message.token === 'string') team = room.players.findIndex(player => player?.token === message.token);
        if (team >= 0) {
          if (ws.room && ws.room !== room) detach(ws, true);
          attach(ws, room, team, room.players[team]); return;
        }
        if (ws.room === room) { error(ws, 'Zaten bu odadasın.'); return; }
        team = room.players.findIndex(player => !player);
        if (team < 0) { error(ws, 'Oda dolu veya bağlantısı kesilen oyuncu için bekliyor.'); return; }
        detach(ws, true); attach(ws, room, team); return;
      }
      if (message.type === 'leave') { detach(ws, true); send(ws, { type: 'left' }); return; }
      const room = ws.room;
      if (!room) return;
      if (message.type === 'ready') {
        if (!rateLimit(ws, 'ready', 6, 1000)) return;
        if (!['waiting', 'paused', 'finished'].includes(room.game.phase)) return;
        room.ready[ws.team] = message.ready === true;
        if (room.ready.every(Boolean) && room.players.every(player => player?.ws)) beginGame(room.game);
        roomStatus(room); sendState(room);
      } else if (message.type === 'input') {
        if (rateLimit(ws, 'input', 100, 1000)) applyInput(room.game, ws.team, message);
      } else if (message.type === 'chat') {
        if (!rateLimit(ws, 'chat', 5, 5000)) return;
        const text = typeof message.text === 'string' ? message.text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 240) : '';
        if (text) broadcast(room, { type: 'chat', id: ++chatId, team: ws.team, text });
      }
    });
    ws.on('close', () => detach(ws));
    ws.on('error', () => detach(ws));
  });

  let previous = performance.now(), accumulator = 0, stateAccumulator = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    const elapsed = Math.min((now - previous) / 1000, 0.1);
    previous = now; accumulator += elapsed; stateAccumulator += elapsed;
    while (accumulator >= 1 / 120) {
      for (const room of rooms.values()) {
        const before = room.game.phase;
        stepGame(room.game, 1 / 120);
        if (room.game.phase === 'finished' && before !== 'finished') {
          room.ready = [false, false];
          roomStatus(room);
        }
      }
      accumulator -= 1 / 120;
    }
    if (stateAccumulator >= 1 / 30) {
      stateAccumulator %= 1 / 30;
      for (const room of rooms.values()) sendState(room);
    }
  }, 4);
  ticker.unref();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      room.players.forEach((player, team) => {
        if (player && !player.ws && player.expires <= now) { room.players[team] = null; roomStatus(room); }
      });
      if (room.players.every(player => !player)) rooms.delete(room.code);
    }
  }, Math.min(1000, reconnectMs));
  cleanup.unref();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(ticker); clearInterval(cleanup); clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); });
    rooms.clear();
  }
  return { server, wss, rooms, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = createFoosballServer();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => console.log(`Langırt Arena listening on port ${port}`));
  const shutdown = () => app.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
