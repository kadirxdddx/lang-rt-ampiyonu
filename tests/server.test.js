import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createFoosballServer } from '../server.js';

async function connect(url) {
  const ws = new WebSocket(url);
  const queue = [], waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex(waiter => waiter.predicate(message));
    if (index >= 0) { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
    else queue.push(message);
  });
  await once(ws, 'open');
  return {
    ws,
    send(message) { ws.send(JSON.stringify(message)); },
    next(predicate, timeout = 5000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Timed out waiting for WebSocket message')); }, timeout) };
        waiters.push(waiter);
      });
    },
  };
}
async function setup(t, options) {
  const app = createFoosballServer(options);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const port = app.server.address().port;
  return { app, url: `ws://127.0.0.1:${port}/ws`, http: `http://127.0.0.1:${port}` };
}

test('two clients create/join, ready together, share authoritative input and chat', async t => {
  const { app, url } = await setup(t);
  const host = await connect(url), guest = await connect(url);
  host.send({ type: 'create' });
  const joined = await host.next(message => message.type === 'joined');
  assert.equal(joined.team, 0);
  assert.match(joined.code, /^[A-Z2-9]{6}$/);
  guest.send({ type: 'join', code: joined.code });
  const guestJoined = await guest.next(message => message.type === 'joined');
  assert.equal(guestJoined.team, 1);
  host.send({ type: 'ready', ready: true });
  await host.next(message => message.type === 'room' && message.ready[0]);
  assert.equal(app.rooms.get(joined.code).game.phase, 'waiting');
  guest.send({ type: 'ready', ready: true });
  await guest.next(message => message.type === 'state' && message.state.phase === 'countdown');
  const playing = await host.next(message => message.type === 'state' && message.state.phase === 'playing');
  assert.equal(playing.state.scores[0], 0);
  guest.send({ type: 'input', seq: 1, positions: [0.7, -0.5, 0.2], kick: [1, 0, 0] });
  const update = await host.next(message => message.type === 'state' && message.state.ack[1] === 1 && message.state.rods[3] > 0);
  assert.deepEqual(update.state.rods.slice(0, 3), [0, 0, 0]);
  const canonical = app.rooms.get(joined.code).game;
  host.send({ type: 'state', state: { scores: [99, 0] } });
  guest.send({ type: 'chat', text: '  Selam\u0000 arkadaş!  ' });
  const chatHost = await host.next(message => message.type === 'chat');
  const chatGuest = await guest.next(message => message.type === 'chat');
  assert.equal(chatHost.text, 'Selam arkadaş!');
  assert.equal(chatHost.id, chatGuest.id);
  assert.equal(chatHost.team, 1);
  assert.notEqual(canonical.scores[0], 99);
  host.send({ type: 'ping', sentAt: 12345 });
  assert.equal((await host.next(message => message.type === 'pong')).sentAt, 12345);
});

test('a dropped player can reclaim their seat and preserved match using its token', async t => {
  const { app, url } = await setup(t);
  const host = await connect(url), guest = await connect(url);
  host.send({ type: 'create' });
  const joined = await host.next(message => message.type === 'joined');
  guest.send({ type: 'join', code: joined.code });
  const guestSeat = await guest.next(message => message.type === 'joined');
  const room = app.rooms.get(joined.code);
  room.game.phase = 'playing'; room.game.scores = [2, 1]; room.ready = [true, true];
  guest.ws.close();
  await host.next(message => message.type === 'state' && message.state.phase === 'paused');
  assert.equal(room.game.phase, 'paused');
  assert.deepEqual(room.ready, [false, false]);
  const resumed = await connect(url);
  resumed.send({ type: 'join', code: joined.code, token: guestSeat.token });
  const seat = await resumed.next(message => message.type === 'joined');
  assert.equal(seat.team, 1); assert.equal(seat.token, guestSeat.token);
  const paused = await resumed.next(message => message.type === 'state');
  assert.deepEqual(paused.state.scores, [2, 1]);
  assert.equal(paused.state.phase, 'paused');
  host.send({ type: 'ready', ready: true }); resumed.send({ type: 'ready', ready: true });
  await resumed.next(message => message.type === 'state' && message.state.phase === 'countdown');
  assert.deepEqual(room.game.scores, [2, 1]);
});

test('HTTP serves only game assets and health, keeping server and project sources private', async t => {
  const { http } = await setup(t);
  const health = await fetch(`${http}/health`);
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  for (const privatePath of ['/server.js', '/package.json', '/project.godot', '/.git/config', '/driving_3d.gd']) {
    const response = await fetch(`${http}${privatePath}`);
    assert.equal(response.status, 404, privatePath);
  }
  const shared = await fetch(`${http}/shared/game.js`);
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get('content-type'), /javascript/);
});
