// Shared table geometry. The server owns match state and advances this simulation.
export const FIELD = Object.freeze({ halfLength: 5.4, halfWidth: 2.9, goalHalfWidth: 1.5, ballRadius: 0.13 });
export const PLAYER_SPACING = 1.65;
export const PLAYER_RADIUS = 0.23;
export const ROD_SPEED = 7.5;
export const BALL_MAX_SPEED = 14;
export const MATCH_SECONDS = 180;
export const WIN_SCORE = 7;
export const ROD_LAYOUT = [-4.65, -2.8, -1, 1, 2.8, 4.65].map((x, index) => {
  const count = [1, 2, 3, 3, 2, 1][index];
  return Object.freeze({ x, count, team: index < 3 ? 0 : 1, travel: FIELD.halfWidth - PLAYER_RADIUS - 0.06 - (count - 1) * PLAYER_SPACING / 2 });
});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function createGame() {
  return {
    rods: Array(6).fill(0), targets: Array(6).fill(0), rodVelocity: Array(6).fill(0),
    kicks: Array(6).fill(0), kickCooldown: Array(6).fill(0), kickSeq: Array(6).fill(0),
    ack: [-1, -1], ball: { x: 0, z: 0, vx: 0, vz: 0 }, scores: [0, 0],
    phase: 'waiting', timer: MATCH_SECONDS, countdown: 0, winner: null,
    eventId: 0, serveTeam: 0, idleTime: 0, resumePhase: null, resumeCountdown: 0,
  };
}

export function resetMatch(game) {
  const nextEventId = game.eventId + 1;
  const ack = game.ack.slice();
  const kickSeq = game.kickSeq.slice();
  Object.assign(game, createGame(), { eventId: nextEventId, ack, kickSeq });
}

export function pauseGame(game) {
  if (game.phase === 'waiting' || game.phase === 'paused' || game.phase === 'finished') return;
  if (game.phase !== 'countdown' || !game.resumePhase) {
    game.resumePhase = game.phase;
    game.resumeCountdown = game.countdown;
  }
  game.phase = 'paused';
  game.kicks.fill(0);
  game.rodVelocity.fill(0);
  game.targets = game.rods.slice();
}

export function beginGame(game) {
  if (game.phase === 'finished') resetMatch(game);
  if (game.phase === 'waiting') {
    game.resumePhase = null;
    game.phase = 'countdown';
    game.countdown = 3;
  } else if (game.phase === 'paused') {
    game.phase = 'countdown';
    game.countdown = 3;
  }
}

// Each player controls only the three rods belonging to that team.
export function applyInput(game, team, input) {
  if ((team !== 0 && team !== 1) || !input || !Number.isSafeInteger(input.seq) || input.seq <= game.ack[team]) return false;
  if (!Array.isArray(input.positions) || input.positions.length !== 3 || !input.positions.every(finite)) return false;
  if (!Array.isArray(input.kick) || input.kick.length !== 3 || !input.kick.every(value => Number.isSafeInteger(value) && value >= 0)) return false;
  game.ack[team] = input.seq;
  input.positions.forEach((position, localIndex) => {
    const index = team * 3 + localIndex;
    game.targets[index] = clamp(position, -1, 1);
    if (input.kick[localIndex] > game.kickSeq[index]) {
      game.kickSeq[index] = input.kick[localIndex];
      if (game.phase === 'playing' && game.kickCooldown[index] <= 0) {
        game.kicks[index] = 1;
        game.kickCooldown[index] = 0.25;
      }
    }
  });
  return true;
}

function limitBall(ball) {
  const speed = Math.hypot(ball.vx, ball.vz);
  if (speed > BALL_MAX_SPEED) {
    ball.vx *= BALL_MAX_SPEED / speed;
    ball.vz *= BALL_MAX_SPEED / speed;
  }
}

function kickoff(game) {
  const direction = game.serveTeam === 0 ? 1 : -1;
  const diagonal = game.eventId % 2 ? 1 : -1;
  Object.assign(game.ball, { x: 0, z: diagonal * 0.18, vx: direction * 2.6, vz: diagonal * 1.8 });
  game.idleTime = 0;
  game.eventId++;
}

function finish(game) {
  game.phase = 'finished';
  game.winner = game.scores[0] === game.scores[1] ? 'draw' : game.scores[0] > game.scores[1] ? 0 : 1;
  game.ball.vx = game.ball.vz = 0;
  game.eventId++;
}

function score(game, team) {
  game.scores[team]++;
  game.serveTeam = 1 - team;
  game.ball.vx = game.ball.vz = 0;
  game.eventId++;
  if (game.scores[team] >= WIN_SCORE) finish(game);
  else { game.phase = 'goal'; game.countdown = 1.7; }
}

function collideWall(ball, nx, nz, penetration, bounce = 0.86) {
  if (penetration <= 0) return;
  ball.x += nx * penetration;
  ball.z += nz * penetration;
  const into = ball.vx * nx + ball.vz * nz;
  if (into < 0) {
    ball.vx -= (1 + bounce) * into * nx;
    ball.vz -= (1 + bounce) * into * nz;
  }
}

function boundaries(game) {
  const ball = game.ball;
  const { halfLength, halfWidth, ballRadius, goalHalfWidth } = FIELD;
  const side = Math.sign(ball.x) || 1;
  const inGoal = Math.abs(ball.z) <= goalHalfWidth - ballRadius;
  // The entire ball must pass the line inside the actual goal opening.
  if (inGoal && Math.abs(ball.x) >= halfLength + ballRadius) {
    score(game, ball.x > 0 ? 0 : 1);
    return;
  }
  collideWall(ball, 0, -1, ball.z - (halfWidth - ballRadius));
  collideWall(ball, 0, 1, -ball.z - (halfWidth - ballRadius));
  if (!inGoal) collideWall(ball, -side, 0, Math.abs(ball.x) - (halfLength - ballRadius));
  for (const x of [-halfLength, halfLength]) {
    for (const z of [-goalHalfWidth, goalHalfWidth]) {
      const dx = ball.x - x, dz = ball.z - z;
      const distance = Math.hypot(dx, dz), radius = ballRadius + 0.08;
      if (distance < radius && distance > 0.000001) collideWall(ball, dx / distance, dz / distance, radius - distance, 0.8);
    }
  }
  const corner = 0.52;
  const absX = Math.abs(ball.x), absZ = Math.abs(ball.z);
  if (absX > halfLength - corner - ballRadius && absZ > halfWidth - corner - ballRadius) {
    const penetration = (absX + absZ - (halfLength + halfWidth - corner)) / Math.SQRT2 + ballRadius;
    collideWall(ball, -(Math.sign(ball.x) || 1) / Math.SQRT2, -(Math.sign(ball.z) || 1) / Math.SQRT2, penetration);
  }
}

function players(game) {
  const ball = game.ball;
  const radius = FIELD.ballRadius + PLAYER_RADIUS;
  for (let index = 0; index < ROD_LAYOUT.length; index++) {
    const rod = ROD_LAYOUT[index];
    const direction = rod.team === 0 ? 1 : -1;
    const center = game.rods[index] * rod.travel;
    const rodVz = game.rodVelocity[index];
    for (let player = 0; player < rod.count; player++) {
      const z = center + (player - (rod.count - 1) / 2) * PLAYER_SPACING;
      const dx = ball.x - rod.x, dz = ball.z - z;
      const distance = Math.hypot(dx, dz);
      if (distance >= radius) continue;
      // Use the actual contact normal, including a player's back. Never snap
      // the ball onto the attacking side just because a particular team hit it.
      const nx = distance > 0.000001 ? dx / distance : -(Math.sign(ball.vx) || direction);
      const nz = distance > 0.000001 ? dz / distance : 0;
      const depth = radius - distance + 0.00001;
      ball.x += nx * depth;
      ball.z += nz * depth;
      const relativeNormal = ball.vx * nx + (ball.vz - rodVz) * nz;
      if (relativeNormal < 0) {
        ball.vx -= 1.76 * relativeNormal * nx;
        ball.vz -= 1.76 * relativeNormal * nz;
        const tangentSlip = rodVz - ball.vz;
        ball.vz += clamp(tangentSlip * 0.08, -0.5, 0.5);
      }
      if (game.kicks[index] > 0.45 && nx * direction > 0.3) {
        ball.vx = direction * Math.max(Math.abs(ball.vx), 9.8 * Math.abs(nx));
        ball.vz += nz * 3.0 + clamp(rodVz * 0.24, -1.5, 1.5);
        game.kicks[index] = 0.44;
      }
      limitBall(ball);
    }
  }
}

export function stepGame(game, dt) {
  if (!finite(dt) || dt <= 0) return;
  dt = Math.min(dt, 1 / 60);
  const moving = game.phase === 'playing' || game.phase === 'countdown';
  for (let index = 0; index < 6; index++) {
    const rod = ROD_LAYOUT[index];
    const before = game.rods[index];
    if (moving) game.rods[index] += clamp(game.targets[index] - before, -ROD_SPEED * dt / rod.travel, ROD_SPEED * dt / rod.travel);
    game.rodVelocity[index] = (game.rods[index] - before) * rod.travel / dt;
    game.kicks[index] = Math.max(0, game.kicks[index] - dt / 0.23);
    game.kickCooldown[index] = Math.max(0, game.kickCooldown[index] - dt);
  }
  if (game.phase === 'countdown') {
    game.countdown = Math.max(0, game.countdown - dt);
    if (game.countdown === 0) {
      const resumePhase = game.resumePhase;
      game.resumePhase = null;
      if (resumePhase === 'goal') {
        game.phase = 'goal'; game.countdown = game.resumeCountdown;
      } else {
        game.phase = 'playing';
        if (resumePhase !== 'playing') kickoff(game);
      }
    }
    return;
  }
  if (game.phase === 'goal') {
    game.countdown = Math.max(0, game.countdown - dt);
    if (game.countdown === 0) { kickoff(game); game.phase = 'playing'; }
    return;
  }
  if (game.phase !== 'playing') return;
  game.timer = Math.max(0, game.timer - dt);
  if (game.timer === 0) { finish(game); return; }
  const ball = game.ball;
  const drag = Math.exp(-0.2 * dt);
  ball.vx *= drag; ball.vz *= drag;
  limitBall(ball);
  ball.x += ball.vx * dt; ball.z += ball.vz * dt;
  boundaries(game);
  if (game.phase !== 'playing') return;
  players(game);
  boundaries(game);
  if (game.phase !== 'playing') return;
  game.idleTime = Math.hypot(ball.vx, ball.vz) < 0.28 ? game.idleTime + dt : 0;
  if (game.idleTime > 2.5) {
    ball.vx = (ball.x <= 0 ? 1 : -1) * 1.8;
    ball.vz = (ball.z <= 0 ? 1 : -1) * 1.2;
    game.idleTime = 0;
  }
}

export function snapshot(game) {
  return {
    rods: game.rods.slice(), kicks: game.kicks.slice(), ball: { ...game.ball },
    scores: game.scores.slice(), phase: game.phase, timer: game.timer,
    countdown: game.countdown, winner: game.winner, eventId: game.eventId, ack: game.ack.slice(),
  };
}
