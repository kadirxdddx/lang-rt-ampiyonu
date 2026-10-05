const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const root = __dirname;
const rooms = new Map();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, requested);
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const wss = new WebSocket.Server({ server, path: '/ws' });
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do { code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function send(peer, message) {
  if (peer && peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message));
}
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  if (room.host === ws) {
    send(room.guest, { type: 'error', message: 'Oda sahibi bağlantıyı kapattı.' });
    rooms.delete(room.code);
  } else if (room.guest === ws) {
    room.guest = null;
    send(room.host, { type: 'error', message: 'Arkadaşının bağlantısı kesildi.' });
  }
  ws.room = null;
}
wss.on('connection', ws => {
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'create') {
      const code = makeCode();
      const room = { code, host: ws, guest: null };
      rooms.set(code, room);
      ws.room = room;
      ws.role = 'host';
      send(ws, { type: 'created', code });
    } else if (message.type === 'join') {
      const code = String(message.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { type: 'error', message: 'Bu kodla açık bir oda bulamadım.' }); return; }
      if (room.guest) { send(ws, { type: 'error', message: 'Bu oda dolu. Yeni bir oda kodu deneyin.' }); return; }
      room.guest = ws;
      ws.room = room;
      ws.role = 'guest';
      send(ws, { type: 'joined', code });
      send(room.host, { type: 'ready' });
      send(ws, { type: 'ready' });
    } else if (message.type === 'state' && ws.role === 'host' && ws.room) {
      send(ws.room.guest, message);
    } else if (message.type === 'input' && ws.role === 'guest' && ws.room) {
      const allowed = ['w', 's', 'ArrowUp', 'ArrowDown', 'a', 'd', 'ArrowLeft', 'ArrowRight'];
      if (allowed.includes(message.key)) send(ws.room.host, { type: 'input', key: message.key, down: Boolean(message.down) });
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Langirt server listening on ${port}`));
