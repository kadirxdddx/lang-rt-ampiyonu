import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELD, ROD_LAYOUT, ROD_SPEED, BALL_MAX_SPEED, WIN_SCORE, createGame, applyInput, stepGame, snapshot, beginGame, pauseGame } from '../shared/game.js';

function playing() { const game = createGame(); game.phase = 'playing'; return game; }
function advance(game, seconds) { for (let i = 0; i < Math.ceil(seconds * 120); i++) stepGame(game, 1 / 120); }

test('both front and back collisions rebound on their actual contact side', () => {
  for (const [rodIndex, side] of [[2, -1], [2, 1], [3, -1], [3, 1]]) {
    const game = playing();
    const x = ROD_LAYOUT[rodIndex].x;
    Object.assign(game.ball, { x: x + side * 0.35, z: 0, vx: -side * 2, vz: 0 });
    game.kicks[rodIndex] = 1;
    stepGame(game, 1 / 120);
    assert.ok((game.ball.x - x) * side > 0, 'ball remains on its original side of the player');
    assert.ok(game.ball.vx * side > 0, 'ball rebounds away from the contact');
  }
});

test('goals require the whole ball crossing inside the actual opening', () => {
  const beside = playing();
  Object.assign(beside.ball, { x: 5.25, z: 1.9, vx: 5, vz: 0 });
  advance(beside, 0.1);
  assert.deepEqual(beside.scores, [0, 0]);
  assert.ok(beside.ball.vx < 0);
  const partial = playing();
  Object.assign(partial.ball, { x: FIELD.halfLength + FIELD.ballRadius / 2, z: 0.6, vx: 0, vz: 0 });
  stepGame(partial, 1 / 120);
  assert.deepEqual(partial.scores, [0, 0]);
  const goal = playing();
  Object.assign(goal.ball, { x: 5.5, z: 0.6, vx: 5, vz: 0 });
  advance(goal, 0.04);
  assert.deepEqual(goal.scores, [1, 0]);
  assert.equal(goal.phase, 'goal');
});

test('chamfered corners rebound into the table without awarding goals', () => {
  const game = playing();
  Object.assign(game.ball, { x: 5.09, z: 2.56, vx: 4, vz: 4 });
  stepGame(game, 1 / 120);
  assert.ok(game.ball.vx < 0 && game.ball.vz < 0);
  assert.deepEqual(game.scores, [0, 0]);
  assert.ok(game.ball.x + game.ball.z <= FIELD.halfLength + FIELD.halfWidth - 0.52);
});

test('inputs are bounded, sequential, and restricted to the sender team', () => {
  const game = playing();
  assert.equal(applyInput(game, 1, { seq: 1, positions: [2, -2, 0.5], kick: [0, 0, 0] }), true);
  assert.deepEqual(game.targets, [0, 0, 0, 1, -1, 0.5]);
  assert.equal(applyInput(game, 1, { seq: 0, positions: [0, 0, 0], kick: [0, 0, 0] }), false);
  assert.equal(applyInput(game, 1, { seq: 2, positions: [NaN, 0, 0], kick: [0, 0, 0] }), false);
  stepGame(game, 1 / 120);
  assert.ok(Math.abs(game.rods[3] * ROD_LAYOUT[3].travel) <= ROD_SPEED / 120 + 1e-9);
  assert.deepEqual(game.rods.slice(0, 3), [0, 0, 0]);
});

test('ball speed stays capped and a stopped ball gets a gentle restart', () => {
  const game = playing();
  Object.assign(game.ball, { x: 0, z: 0.7, vx: 100, vz: 100 });
  stepGame(game, 1 / 120);
  assert.ok(Math.hypot(game.ball.vx, game.ball.vz) <= BALL_MAX_SPEED + 1e-9);
  Object.assign(game.ball, { x: 0, z: 0.7, vx: 0, vz: 0 });
  advance(game, 2.55);
  assert.ok(Math.hypot(game.ball.vx, game.ball.vz) > 1);
  assert.ok(Math.abs(game.ball.x) < 0.2, 'restart does not teleport the ball');
});

test('disconnect pause preserves scores, time and ball until both resume', () => {
  const game = playing();
  game.scores = [2, 3];
  Object.assign(game.ball, { x: 0.2, z: 0.6, vx: 2, vz: 1 });
  pauseGame(game);
  const before = snapshot(game);
  advance(game, 5);
  assert.deepEqual(game.ball, before.ball);
  assert.equal(game.timer, before.timer);
  beginGame(game);
  advance(game, 0.5);
  pauseGame(game);
  beginGame(game);
  advance(game, 3.01);
  assert.equal(game.phase, 'playing');
  assert.deepEqual(game.scores, [2, 3]);
  assert.ok(Math.abs(game.ball.x - before.ball.x) < 0.05);
});

test('winning score finishes and a rematch resets scores through countdown', () => {
  const game = playing();
  game.scores = [WIN_SCORE - 1, 3];
  Object.assign(game.ball, { x: 5.55, z: 0, vx: 1, vz: 0 });
  stepGame(game, 1 / 120);
  assert.equal(game.phase, 'finished');
  assert.equal(game.winner, 0);
  beginGame(game);
  assert.equal(game.phase, 'countdown');
  assert.deepEqual(game.scores, [0, 0]);
  assert.equal(game.winner, null);
});
