// Distances are metres and time is in seconds. Heading zero points along +Z.
export const ROAD_WIDTH = 24;
export const BOUNDS = Object.freeze({ minX: -90, maxX: 90, minZ: -116, maxZ: 116 });
const route = [[-50, 12], [-48, 65], [-26, 88], [28, 82], [53, 56], [52, 6], [45, -58], [16, -78], [-30, -74], [-50, -48]];
export const CHECKPOINTS = route.map(([x, z], i) => {
  const before = route[(i + route.length - 1) % route.length];
  const after = route[(i + 1) % route.length];
  return { x, z, heading: Math.atan2(after[0] - before[0], after[1] - before[1]) };
});

function box(type, x, z, width, length, heading = 0) {
  return { type, x, z, width, length, heading, r: Math.hypot(width, length) / 2 };
}
function round(type, x, z, r) {
  return { type, x, z, width: r * 2, length: r * 2, heading: 0, r };
}

export const PROPS = [
  box('factory', 6, 7, 33, 46), box('workshop', -8, -37, 18, 16),
  box('container', -25, -47, 6, 13, 0.12),
  round('tank', 12, 50, 7), round('tank', -6, 50, 6), round('tank', 24, -29, 5.5),
  box('barrier', -24, 3, 2, 12, -0.13), box('barrier', 31, 9, 2, 10, 0.04),
  round('drums', -27, 34, 2), round('drums', -22, -15, 2), round('drums', 24, -46, 2),
  box('container', -76, 22, 6, 19), box('container', -76, -3, 6, 19),
  box('container', 77, 35, 6, 19, 0.08), box('container', 76, -24, 6, 19, 0.04),
  box('container', -43, -99, 6, 18, 1.58), round('tank', 49, 94, 7),
  round('drums', -70, 75, 2), round('drums', 64, -76, 2),
];

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const CAR_RADIUS = 2.05;
const GATE_RADIUS = 13.7;
const LAPS = 2;

function car(id, name, x, z, color) {
  return { id, name, color, x, z, heading: 0, vx: 0, vz: 0, speed: 0, health: 100,
    nitro: 100, boosting: false, skid: 0, alive: true, steering: 0, checkpoint: 0,
    passed: 0, stuck: 0, backing: 0, lastImpact: -10, turnRate: 0 };
}

export function createGame() {
  const player = car('player', 'Player', -50, -48, '#ff542d');
  const rivals = [car('rival-1', 'Rivet', -45.6, -37, '#ffc33f'),
    car('rival-2', 'Static', -54.6, -32, '#56bbbd'),
    car('rival-3', 'Hex', -49.3, -24, '#ab7cda')];
  return { player, rivals, checkpoint: 0, passed: 0, lap: 1, laps: LAPS,
    totalCheckpoints: LAPS * CHECKPOINTS.length, place: 4, time: 48, elapsed: 0,
    score: 0, wrecks: 0, status: 'playing', reason: '', events: [], contacts: new Map() };
}

function event(game, type, text, x, z, intensity = 1) {
  game.events.push({ type, text, x, z, intensity });
}

function distanceFromRoad(x, z) {
  let best = Infinity;
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const a = CHECKPOINTS[i], b = CHECKPOINTS[(i + 1) % CHECKPOINTS.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
    best = Math.min(best, (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2);
  }
  return Math.sqrt(best);
}

function drive(vehicle, input, dt, ai) {
  const throttle = clamp(Number(input.throttle) || 0, 0, 1);
  const brake = clamp(Number(input.brake) || 0, 0, 1);
  const steer = clamp(Number(input.steer) || 0, -1, 1);
  const sin = Math.sin(vehicle.heading), cos = Math.cos(vehicle.heading);
  let forward = vehicle.vx * sin + vehicle.vz * cos;
  let lateral = vehicle.vx * cos - vehicle.vz * sin;
  const speed = Math.abs(forward);
  const handbrake = Boolean(input.handbrake) && speed > 4;
  const onDirt = distanceFromRoad(vehicle.x, vehicle.z) > ROAD_WIDTH / 2 + 1;
  const canBoost = !vehicle.boosting ? vehicle.nitro > 6 : vehicle.nitro > 0.1;
  vehicle.boosting = Boolean(input.boost) && canBoost && throttle > 0.2 && brake < 0.2 && forward > -1;
  vehicle.nitro = clamp(vehicle.nitro + (vehicle.boosting ? -25 : 4.2) * dt, 0, 100);
  vehicle.steering += (steer - vehicle.steering) * (1 - Math.exp(-dt * 9));

  // Keeping lateral momentum across a yaw change creates a continuous tire slip angle.
  const handling = clamp(speed / 4.8, 0.12, 1) * (1.80 - Math.min(speed / 100, 0.52));
  const intendedTurn = -vehicle.steering * handling * (forward < -0.7 ? -1 : 1) * (handbrake ? 1.52 : 1);
  vehicle.turnRate += (intendedTurn - vehicle.turnRate) * (1 - Math.exp(-dt * 9));
  const heading = vehicle.heading + vehicle.turnRate * dt;
  const grip = handbrake ? 2.35 : (onDirt ? 5.4 : 8.5);
  lateral *= Math.exp(-grip * dt);
  let acceleration = throttle * (forward < -0.6 ? 22 : (ai ? 13.8 : 15.2));
  acceleration -= brake * (forward > 0.6 ? 29 : 9.8);
  if (vehicle.boosting) acceleration += 22;
  const drag = (onDirt ? 0.020 : 0.0105) * forward * speed + forward * 0.055;
  forward += (acceleration - drag) * dt;
  if (handbrake) forward *= Math.exp(-0.29 * dt);
  if (!throttle && !brake && Math.abs(forward) < 0.2) forward = 0;
  forward = clamp(forward, -10, vehicle.boosting ? 55 : 53);
  vehicle.vx = sin * forward + cos * lateral;
  vehicle.vz = cos * forward - sin * lateral;
  vehicle.heading = Math.atan2(Math.sin(heading), Math.cos(heading));
  vehicle.x += vehicle.vx * dt;
  vehicle.z += vehicle.vz * dt;
  vehicle.speed = forward;
  vehicle.skid = clamp((Math.abs(lateral) - 1.4) / 9 + (handbrake ? 0.34 : 0), 0, 1);
}

function circuitInput(game, racer, i, dt) {
  const gate = CHECKPOINTS[racer.checkpoint];
  const offset = [-3.4, 3.1, -0.7][i];
  let tx = gate.x + Math.cos(gate.heading) * offset;
  let tz = gate.z - Math.sin(gate.heading) * offset;
  const player = game.player;
  const dx = player.x - racer.x, dz = player.z - racer.z;
  const separation = Math.hypot(dx, dz);
  const playerAhead = dx * Math.sin(racer.heading) + dz * Math.cos(racer.heading);
  // One bruiser occasionally cuts across the racing line when the player is close ahead.
  if (i === 0 && playerAhead > 4 && separation < 25 && game.elapsed > 6) {
    tx = player.x + player.vx * 0.22;
    tz = player.z + player.vz * 0.22;
  }
  const turn = angleDelta(Math.atan2(tx - racer.x, tz - racer.z), racer.heading);
  const targetSpeed = [26, 24.8, 25.5][i] - Math.min(Math.abs(turn), 1.9) * 6.6;
  racer.stuck = Math.abs(racer.speed) < 2.2 && game.elapsed > 3 ? racer.stuck + dt : 0;
  if (racer.stuck > 1.15) { racer.backing = 0.88; racer.stuck = 0; }
  if (racer.backing > 0) {
    racer.backing -= dt;
    return { brake: 1, steer: Math.sign(turn) || 1 };
  }
  return { steer: clamp(-turn * 1.8, -1, 1), throttle: clamp((targetSpeed + 2 - racer.speed) / 4, 0, 1),
    brake: clamp((racer.speed - targetSpeed - 2) / 9, 0, 0.82), handbrake: Math.abs(turn) > 1.15 && racer.speed > 13 };
}

function obstacleContact(vehicle, prop) {
  const dx = vehicle.x - prop.x, dz = vehicle.z - prop.z;
  if (dx * dx + dz * dz >= (prop.r + CAR_RADIUS) ** 2) return;
  if (prop.type === 'tank' || prop.type === 'drums') {
    const d = Math.hypot(dx, dz);
    return { nx: d ? dx / d : 1, nz: d ? dz / d : 0, depth: CAR_RADIUS + prop.r - d };
  }
  const c = Math.cos(prop.heading), s = Math.sin(prop.heading);
  const x = dx * c - dz * s, z = dx * s + dz * c;
  const hw = prop.width / 2, hl = prop.length / 2;
  let nx = x - clamp(x, -hw, hw), nz = z - clamp(z, -hl, hl);
  const distance = Math.hypot(nx, nz);
  if (distance >= CAR_RADIUS) return;
  let depth = CAR_RADIUS - distance;
  if (distance > 0) { nx /= distance; nz /= distance; }
  else if (hw - Math.abs(x) < hl - Math.abs(z)) { nx = Math.sign(x) || 1; nz = 0; depth += hw - Math.abs(x); }
  else { nx = 0; nz = Math.sign(z) || 1; depth += hl - Math.abs(z); }
  return { nx: nx * c + nz * s, nz: -nx * s + nz * c, depth };
}

function damage(game, vehicle, amount, playerCaused) {
  if (!vehicle.alive) return;
  vehicle.health = Math.max(0, vehicle.health - amount);
  if (vehicle.health > 0) return;
  vehicle.alive = false;
  vehicle.boosting = false;
  vehicle.skid = 0;
  vehicle.vx = vehicle.vz = vehicle.speed = 0;
  if (vehicle !== game.player) {
    game.wrecks++;
    if (playerCaused) { game.score += 1000; game.time += 6; }
    event(game, 'wreck', `${vehicle.name.toUpperCase()} WRECKED`, vehicle.x, vehicle.z);
  }
}

function hitSolid(game, vehicle, nx, nz, depth) {
  vehicle.x += nx * depth;
  vehicle.z += nz * depth;
  const approach = -(vehicle.vx * nx + vehicle.vz * nz);
  if (approach <= 0) return;
  vehicle.vx += nx * approach * 1.2;
  vehicle.vz += nz * approach * 1.2;
  if (approach < 7 || game.elapsed - vehicle.lastImpact < 0.6) return;
  vehicle.lastImpact = game.elapsed;
  // Skilled glancing blows cost little; a full-speed head-on impact still leaves a way back.
  damage(game, vehicle, Math.min(20, (approach - 6) * 0.47), false);
  if (vehicle === game.player) event(game, 'impact', 'BODY DAMAGE', vehicle.x, vehicle.z, Math.min(1, approach / 32));
}

function collideWorld(game, vehicle) {
  for (const prop of PROPS) {
    const contact = obstacleContact(vehicle, prop);
    if (contact) hitSolid(game, vehicle, contact.nx, contact.nz, contact.depth);
  }
  const r = CAR_RADIUS;
  if (vehicle.x < BOUNDS.minX + r) hitSolid(game, vehicle, 1, 0, BOUNDS.minX + r - vehicle.x);
  if (vehicle.x > BOUNDS.maxX - r) hitSolid(game, vehicle, -1, 0, vehicle.x - BOUNDS.maxX + r);
  if (vehicle.z < BOUNDS.minZ + r) hitSolid(game, vehicle, 0, 1, BOUNDS.minZ + r - vehicle.z);
  if (vehicle.z > BOUNDS.maxZ - r) hitSolid(game, vehicle, 0, -1, vehicle.z - BOUNDS.maxZ + r);
}

function collideCars(game, a, b) {
  if (!a.alive && !b.alive) return;
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
  if (d >= CAR_RADIUS * 2) return;
  const nx = d ? dx / d : 1, nz = d ? dz / d : 0;
  const depth = CAR_RADIUS * 2 - d;
  const shareA = !a.alive ? 0 : (!b.alive ? 1 : 0.5);
  a.x -= nx * depth * shareA; a.z -= nz * depth * shareA;
  b.x += nx * depth * (1 - shareA); b.z += nz * depth * (1 - shareA);
  const attackA = a.vx * nx + a.vz * nz, attackB = -(b.vx * nx + b.vz * nz);
  const impact = attackA + attackB;
  if (impact <= 0) return;
  a.vx -= nx * impact * 1.22 * shareA; a.vz -= nz * impact * 1.22 * shareA;
  b.vx += nx * impact * 1.22 * (1 - shareA); b.vz += nz * impact * 1.22 * (1 - shareA);
  const key = `${a.id}/${b.id}`;
  if (impact < 3 || game.elapsed - (game.contacts.get(key) ?? -10) < 0.65) return;
  game.contacts.set(key, game.elapsed);
  const includesPlayer = a === game.player || b === game.player;
  const harm = (impact - 2) * 1.65;
  const damageA = harm * (attackA >= attackB ? 0.43 : 1.25) * (b.boosting ? 1.65 : 1);
  const damageB = harm * (attackB >= attackA ? 0.43 : 1.25) * (a.boosting ? 1.65 : 1);
  if (includesPlayer) {
    const rival = a === game.player ? b : a, amount = a === game.player ? damageB : damageA;
    if (rival.alive) {
      const points = Math.max(10, Math.round(Math.min(rival.health, amount) * 3));
      game.score += points;
      const remaining = Math.max(0, Math.ceil(rival.health - amount));
      const target = remaining ? ` · ${rival.name.toUpperCase()} ${remaining}% ARMOR` : '';
      event(game, 'ram', `RAM +${points}${target}`, (a.x + b.x) / 2, (a.z + b.z) / 2, clamp(impact / 24, 0.25, 1));
    }
  }
  damage(game, a, damageA * (a === game.player ? 0.53 : 1), includesPlayer);
  damage(game, b, damageB * (b === game.player ? 0.53 : 1), includesPlayer);
}

function passGate(game, vehicle) {
  const gate = CHECKPOINTS[vehicle.checkpoint];
  const dx = vehicle.x - gate.x, dz = vehicle.z - gate.z;
  const along = dx * Math.sin(gate.heading) + dz * Math.cos(gate.heading);
  const across = dx * Math.cos(gate.heading) - dz * Math.sin(gate.heading);
  // The front bumper triggers the physical gate line between the two visible pylons.
  if (along < -2.8 || along > 5 || Math.abs(across) > GATE_RADIUS) return;
  vehicle.passed = Math.min(vehicle.passed + 1, game.totalCheckpoints);
  vehicle.checkpoint = (vehicle.checkpoint + 1) % CHECKPOINTS.length;
  if (vehicle !== game.player) return;
  game.passed = vehicle.passed;
  game.checkpoint = vehicle.checkpoint;
  game.lap = Math.min(game.laps, Math.floor(game.passed / CHECKPOINTS.length) + 1);
  game.time += 3;
  game.score += 200;
  vehicle.nitro = Math.min(100, vehicle.nitro + 8);
  const newLap = vehicle.checkpoint === 0 && game.passed < game.totalCheckpoints;
  event(game, 'checkpoint', newLap ? `LAP ${game.lap} / ${game.laps}` : 'CHECKPOINT +3 SEC', gate.x, gate.z, 0.65);
}

function raceProgress(vehicle) {
  const target = CHECKPOINTS[vehicle.checkpoint];
  const prior = CHECKPOINTS[(vehicle.checkpoint + CHECKPOINTS.length - 1) % CHECKPOINTS.length];
  return vehicle.passed + 1 - Math.min(1, Math.hypot(target.x - vehicle.x, target.z - vehicle.z) /
    Math.hypot(target.x - prior.x, target.z - prior.z));
}

function advance(game, input, dt) {
  game.elapsed += dt;
  game.time -= dt;
  const cars = [game.player, ...game.rivals];
  const wasBoosting = game.player.boosting;
  for (let i = 0; i < cars.length; i++) {
    const v = cars[i];
    if (!v.alive) continue;
    drive(v, i === 0 ? input : circuitInput(game, v, i - 1, dt), dt, i > 0);
    if (i === 0 && v.boosting && !wasBoosting) event(game, 'boost', 'NITRO', v.x, v.z, 0.4);
    collideWorld(game, v);
  }
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) collideCars(game, cars[i], cars[j]);
  }
  for (const vehicle of cars) {
    if (!vehicle.alive) continue;
    vehicle.speed = vehicle.vx * Math.sin(vehicle.heading) + vehicle.vz * Math.cos(vehicle.heading);
    passGate(game, vehicle);
  }
  const player = game.player;
  const progress = raceProgress(player);
  game.place = 1 + game.rivals.filter(rival => rival.alive && (rival.passed >= game.totalCheckpoints || raceProgress(rival) > progress)).length;
  if (!player.alive) { game.status = 'lost'; game.reason = 'Vehicle wrecked'; }
  else if (game.wrecks === game.rivals.length) { game.status = 'won'; game.reason = 'All rivals wrecked'; }
  else if (game.passed >= game.totalCheckpoints) { game.status = 'won'; game.reason = 'Circuit complete'; }
  else if (game.time <= 0) { game.time = 0; game.status = 'lost'; game.reason = 'Time expired'; }
  if (game.status !== 'playing') event(game, 'finish', game.reason.toUpperCase(), player.x, player.z);
}

export function stepGame(game, input = {}, dtSeconds = 0) {
  game.events.length = 0;
  const seconds = clamp(Number(dtSeconds) || 0, 0, 0.16);
  const steps = Math.ceil(seconds * 60);
  for (let i = 0; i < steps && game.status === 'playing'; i++) advance(game, input, seconds / steps);
  return game;
}
