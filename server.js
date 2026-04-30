const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TICK_HZ = 30;
const TICK_DT = 1 / TICK_HZ;

const COLS = 15;
const ROWS = 13;

const TILE_EMPTY = 0;
const TILE_WALL = 1;        // indestructible
const TILE_BRICK = 2;       // destructible
const TILE_TOMBSTONE = 3;   // indestructible, placed on player death

const BOMB_FUSE = 2.5;                  // seconds
const EXPLOSION_DURATION = 0.35;        // total visual lifetime (seconds)
const EXPLOSION_LETHAL_DURATION = 0.15; // damages players only during this window

// Power-up drop probabilities per destroyed brick (mutually exclusive, single roll)
const DROP_CHANCE_BOMB  = 1/14; // ≈ 7.1% — extra-bomb drop
const DROP_CHANCE_RANGE = 1/8;  // 12.5% — flame-up drop
const DROP_CHANCE_SPEED = 1/8;  // 12.5% — speed-up drop
const DROP_CHANCE_KICK  = 1/12; // ≈ 8.3% — kick drop (push enemy bombs)

// Caps. Base bombs=1, base range=2, base speed=4 tiles/s.
// Bomb can be picked up once (cap 2), range up to 4 times (cap 6),
// speed up to 4 times at +0.5 tiles/s each (cap 6).
// Kick is binary — once acquired, stays for the round.
const BASE_SPEED = 4; // tiles per second
const SPEED_STEP = 0.5;
const MAX_BOMBS = 2;
const MAX_RANGE = 6;
const MAX_SPEED = BASE_SPEED + SPEED_STEP * 4;

const BOMB_SLIDE_SPEED = 6; // tiles per second for kicked bombs

const COLORS = ['#ff5959', '#59a6ff', '#7be86b', '#ffd84d'];
const SPAWNS = [
  { x: 1, y: 1 },
  { x: COLS - 2, y: 1 },
  { x: 1, y: ROWS - 2 },
  { x: COLS - 2, y: ROWS - 2 },
];

// ----- App / WS setup -----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ----- Game state -----
const state = {
  phase: 'lobby', // 'lobby' | 'playing' | 'ended'
  map: makeEmptyMap(),
  players: new Map(),     // id -> player
  hostId: null,           // first joiner; gets the Start Game button
  bombs: [],              // {id, ownerId, x, y, fuse, range}
  explosions: [],         // {tiles:[{x,y}], life}
  powerups: [],           // {x,y,type}
  tombstones: [],         // {x,y,color}
  winnerId: null,
  endTimer: 0,
};

let nextId = 1;
let nextBombId = 1;

function makeEmptyMap() {
  const m = [];
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) row.push(TILE_EMPTY);
    m.push(row);
  }
  return m;
}

function generateMap() {
  const m = makeEmptyMap();
  // Border walls
  for (let x = 0; x < COLS; x++) { m[0][x] = TILE_WALL; m[ROWS - 1][x] = TILE_WALL; }
  for (let y = 0; y < ROWS; y++) { m[y][0] = TILE_WALL; m[y][COLS - 1] = TILE_WALL; }
  // Pillars
  for (let y = 2; y < ROWS - 1; y += 2) {
    for (let x = 2; x < COLS - 1; x += 2) {
      m[y][x] = TILE_WALL;
    }
  }
  // Safe spawn neighbourhoods
  const safe = new Set();
  for (const s of SPAWNS) {
    [[0,0],[1,0],[0,1],[2,0],[0,2]].forEach(([dx,dy]) => {
      const nx = s.x + (s.x === 1 ? dx : -dx);
      const ny = s.y + (s.y === 1 ? dy : -dy);
      safe.add(`${nx},${ny}`);
    });
  }
  // Bricks
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (m[y][x] !== TILE_EMPTY) continue;
      if (safe.has(`${x},${y}`)) continue;
      if (Math.random() < 0.82) m[y][x] = TILE_BRICK;
    }
  }
  return m;
}

function startGame() {
  state.map = generateMap();
  state.bombs = [];
  state.explosions = [];
  state.powerups = [];
  state.tombstones = [];
  state.winnerId = null;
  state.endTimer = 0;
  state.phase = 'playing';

  let i = 0;
  for (const p of state.players.values()) {
    const spawn = SPAWNS[i % SPAWNS.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.tileX = spawn.x;
    p.tileY = spawn.y;
    p.moving = false;
    p.facing = i < 2 ? 'down' : 'up';
    p.alive = true;
    p.maxBombs = 1;
    p.bombsActive = 0;
    p.range = 2;
    p.speed = BASE_SPEED;
    p.canKick = false;
    p.color = COLORS[i % COLORS.length];
    p.spawnIndex = i;
    p.deathTime = null;
    i++;
  }
}

function endGame(winnerId) {
  state.phase = 'ended';
  state.winnerId = winnerId;
  state.endTimer = 5; // 5s before back to lobby
  if (winnerId != null) {
    const winner = state.players.get(winnerId);
    if (winner) winner.wins = (winner.wins || 0) + 1;
  }
}

// ----- Input helpers -----
const DIR_DELTAS = {
  up:    { dx: 0,  dy: -1 },
  down:  { dx: 0,  dy: 1  },
  left:  { dx: -1, dy: 0  },
  right: { dx: 1,  dy: 0  },
};

function canStepTo(p, nx, ny) {
  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return false;
  const t = state.map[ny][nx];
  if (t === TILE_WALL || t === TILE_BRICK || t === TILE_TOMBSTONE) return false;
  // Bombs block movement (except the tile we're already standing on, which
  // we'll never re-enter as a destination since we move tile-by-tile away)
  if (state.bombs.some(b => b.tileX === nx && b.tileY === ny)) return false;
  return true;
}

function canBombSlideTo(bomb, nx, ny) {
  if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) return false;
  const t = state.map[ny][nx];
  if (t === TILE_WALL || t === TILE_BRICK || t === TILE_TOMBSTONE) return false;
  // Other bombs block
  if (state.bombs.some(b => b !== bomb && b.tileX === nx && b.tileY === ny)) return false;
  // Players block (use their logical tile — round of visual position)
  for (const p of state.players.values()) {
    if (!p.alive) continue;
    if (Math.round(p.x) === nx && Math.round(p.y) === ny) return false;
    // Also block if a player is moving toward this tile
    if (p.moving && p.tileX === nx && p.tileY === ny) return false;
  }
  return true;
}

function tryKickBomb(p, nx, ny, dx, dy) {
  const bomb = state.bombs.find(b => b.tileX === nx && b.tileY === ny);
  if (!bomb) return;
  if (bomb.moving) return; // already sliding
  const beyondX = nx + dx;
  const beyondY = ny + dy;
  if (!canBombSlideTo(bomb, beyondX, beyondY)) return;
  bomb.tileX = beyondX;
  bomb.tileY = beyondY;
  bomb.moving = true;
  bomb.kickDir = { dx, dy };
}

function advanceBomb(bomb, dt) {
  let timeLeft = dt;
  let safety = 8;
  while (timeLeft > 0 && safety-- > 0 && bomb.moving) {
    const remaining = Math.abs(bomb.tileX - bomb.x) + Math.abs(bomb.tileY - bomb.y);
    if (remaining < 1e-6) {
      // Reached current target tile — try to continue in kickDir
      const nx = bomb.tileX + bomb.kickDir.dx;
      const ny = bomb.tileY + bomb.kickDir.dy;
      if (canBombSlideTo(bomb, nx, ny)) {
        bomb.tileX = nx;
        bomb.tileY = ny;
      } else {
        bomb.moving = false;
        bomb.kickDir = null;
        break;
      }
      continue;
    }
    const stepDist = BOMB_SLIDE_SPEED * timeLeft;
    if (stepDist >= remaining) {
      bomb.x = bomb.tileX;
      bomb.y = bomb.tileY;
      timeLeft -= remaining / BOMB_SLIDE_SPEED;
    } else {
      const sx = Math.sign(bomb.tileX - bomb.x);
      const sy = Math.sign(bomb.tileY - bomb.y);
      bomb.x += sx * stepDist;
      bomb.y += sy * stepDist;
      timeLeft = 0;
    }
  }
}

function advancePlayer(p, dt) {
  let timeLeft = dt;
  let safety = 8; // chain at most a handful of tile steps in one tick
  while (timeLeft > 0 && safety-- > 0) {
    if (p.moving) {
      const remaining = Math.abs(p.tileX - p.x) + Math.abs(p.tileY - p.y);
      const stepDist = p.speed * timeLeft;
      if (stepDist >= remaining) {
        p.x = p.tileX;
        p.y = p.tileY;
        p.moving = false;
        timeLeft -= remaining / p.speed;
        // On arrival, pick up any powerup at the tile.
        // If the player is already capped on that stat, the pickup is left
        // for someone else to grab.
        const puIdx = state.powerups.findIndex(pu => pu.x === p.tileX && pu.y === p.tileY);
        if (puIdx >= 0) {
          const pu = state.powerups[puIdx];
          let consumed = false;
          if (pu.type === 'bomb' && p.maxBombs < MAX_BOMBS) {
            p.maxBombs += 1;
            consumed = true;
          } else if (pu.type === 'range' && p.range < MAX_RANGE) {
            p.range += 1;
            consumed = true;
          } else if (pu.type === 'speed' && p.speed < MAX_SPEED) {
            p.speed += SPEED_STEP;
            consumed = true;
          } else if (pu.type === 'kick' && !p.canKick) {
            p.canKick = true;
            consumed = true;
          }
          if (consumed) state.powerups.splice(puIdx, 1);
        }
      } else {
        const sx = Math.sign(p.tileX - p.x);
        const sy = Math.sign(p.tileY - p.y);
        p.x += sx * stepDist;
        p.y += sy * stepDist;
        timeLeft = 0;
      }
    } else {
      const dir = p.keys && p.keys.dir;
      if (!dir) break;
      p.facing = dir;
      const { dx, dy } = DIR_DELTAS[dir];
      const nx = p.tileX + dx;
      const ny = p.tileY + dy;
      if (!canStepTo(p, nx, ny)) {
        // Blocked. If it's a bomb and we have kick, push it.
        if (p.canKick) tryKickBomb(p, nx, ny, dx, dy);
        break;
      }
      p.tileX = nx;
      p.tileY = ny;
      p.moving = true;
    }
  }
}

function placeBomb(p) {
  if (!p.alive) return;
  if (p.bombsActive >= p.maxBombs) return;
  // Bomb drops at the tile the player is currently standing on (or the tile
  // they're heading toward if mid-step — Math.round picks whichever is closer).
  const bx = Math.round(p.x);
  const by = Math.round(p.y);
  if (state.map[by][bx] !== TILE_EMPTY) return;
  if (state.bombs.some(b => b.tileX === bx && b.tileY === by)) return;
  const bomb = {
    id: nextBombId++,
    ownerId: p.id,
    x: bx, y: by,           // visual position (float when sliding)
    tileX: bx, tileY: by,   // logical tile (integer; destination when sliding)
    fuse: BOMB_FUSE,
    range: p.range,
    moving: false,
    kickDir: null,
  };
  state.bombs.push(bomb);
  p.bombsActive++;
}

function explodeBomb(bomb, processedIds) {
  if (processedIds.has(bomb.id)) return;
  processedIds.add(bomb.id);
  // Bomb may be mid-slide; explode at its claimed logical tile.
  const ox = bomb.tileX;
  const oy = bomb.tileY;
  const tiles = [{ x: ox, y: oy }];
  const destroyedBricks = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  for (const [dx, dy] of dirs) {
    for (let i = 1; i <= bomb.range; i++) {
      const tx = ox + dx * i;
      const ty = oy + dy * i;
      if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) break;
      const t = state.map[ty][tx];
      if (t === TILE_WALL || t === TILE_TOMBSTONE) break;
      tiles.push({ x: tx, y: ty });
      if (t === TILE_BRICK) {
        state.map[ty][tx] = TILE_EMPTY;
        destroyedBricks.push({ x: tx, y: ty });
        break;
      }
      // chain detonate other bombs in path
      const other = state.bombs.find(b => b.tileX === tx && b.tileY === ty && !processedIds.has(b.id));
      if (other) {
        explodeBomb(other, processedIds);
      }
    }
  }
  // remove bomb, decrement owner active count
  const owner = state.players.get(bomb.ownerId);
  if (owner) owner.bombsActive = Math.max(0, owner.bombsActive - 1);

  // Wipe pre-existing powerups caught in this blast — must happen BEFORE we
  // drop new ones, otherwise the brick's tile (which is in `tiles`) would
  // immediately wipe the powerup we just dropped on it.
  state.powerups = state.powerups.filter(pu => !tiles.some(t => t.x === pu.x && t.y === pu.y));

  // Drop new powerups from bricks destroyed by this blast
  for (const b of destroyedBricks) {
    const r = Math.random();
    let cum = 0;
    if (r < (cum += DROP_CHANCE_BOMB)) {
      state.powerups.push({ x: b.x, y: b.y, type: 'bomb' });
    } else if (r < (cum += DROP_CHANCE_RANGE)) {
      state.powerups.push({ x: b.x, y: b.y, type: 'range' });
    } else if (r < (cum += DROP_CHANCE_SPEED)) {
      state.powerups.push({ x: b.x, y: b.y, type: 'speed' });
    } else if (r < (cum += DROP_CHANCE_KICK)) {
      state.powerups.push({ x: b.x, y: b.y, type: 'kick' });
    }
  }

  state.explosions.push({ tiles, life: EXPLOSION_DURATION, lethal: EXPLOSION_LETHAL_DURATION });
}

// ----- Tick -----
function tick(dt) {
  if (state.phase === 'playing') {
    // Player movement (tile-based) + bomb input
    for (const p of state.players.values()) {
      if (!p.alive) continue;
      advancePlayer(p, dt);

      const k = p.keys || {};
      if (k.bomb && !p.bombHeld) {
        p.bombHeld = true;
        placeBomb(p);
      } else if (!k.bomb) {
        p.bombHeld = false;
      }
    }

    // Advance any kicked bombs sliding across the grid
    for (const bomb of state.bombs) {
      if (bomb.moving) advanceBomb(bomb, dt);
    }

    // Bombs fuse
    const exploding = [];
    for (const b of state.bombs) {
      b.fuse -= dt;
      if (b.fuse <= 0) exploding.push(b);
    }
    if (exploding.length) {
      const processed = new Set();
      for (const b of exploding) explodeBomb(b, processed);
      state.bombs = state.bombs.filter(b => !processed.has(b.id));
    }

    // Explosions lifetime + damage
    for (const ex of state.explosions) {
      // Damage anyone overlapping any tile, but only during the lethal window
      // (the bright initial flash). Once the explosion starts to fade visually,
      // players can safely walk through it.
      if (ex.lethal > 0) {
        for (const p of state.players.values()) {
          if (!p.alive) continue;
          const tx = Math.round(p.x);
          const ty = Math.round(p.y);
          if (ex.tiles.some(t => t.x === tx && t.y === ty)) {
            p.alive = false;
            p.deathTime = Date.now();
            if (state.map[ty][tx] === TILE_EMPTY) {
              state.map[ty][tx] = TILE_TOMBSTONE;
              state.tombstones.push({ x: tx, y: ty, color: p.color });
              state.powerups = state.powerups.filter(pu => !(pu.x === tx && pu.y === ty));
            }
          }
        }
        ex.lethal -= dt;
      }
      ex.life -= dt;
    }
    state.explosions = state.explosions.filter(e => e.life > 0);

    // Win check
    const alive = [...state.players.values()].filter(p => p.alive);
    const total = state.players.size;
    if (total >= 2 && alive.length <= 1) {
      endGame(alive.length === 1 ? alive[0].id : null);
    } else if (total === 1 && alive.length === 0) {
      endGame(null);
    }
  } else if (state.phase === 'ended') {
    state.endTimer -= dt;
    if (state.endTimer <= 0) {
      state.phase = 'lobby';
      state.bombs = [];
      state.explosions = [];
      state.powerups = [];
      state.tombstones = [];
      state.map = makeEmptyMap();
      state.winnerId = null;
      for (const p of state.players.values()) {
        p.alive = false;
        // Reset readiness for the next round. Host doesn't need a ready
        // flag — their Start Game click handles it.
        p.ready = false;
      }
    }
  }
}

// ----- Networking -----
function snapshot() {
  return {
    type: 'state',
    phase: state.phase,
    hostId: state.hostId,
    cols: COLS,
    rows: ROWS,
    map: state.map,
    players: [...state.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x, y: p.y,
      facing: p.facing || 'down',
      moving: !!p.moving,
      alive: p.alive,
      maxBombs: p.maxBombs,
      range: p.range,
      speed: p.speed,
      canKick: !!p.canKick,
      wins: p.wins || 0,
      ready: p.ready,
    })),
    bombs: state.bombs.map(b => ({ id: b.id, x: b.x, y: b.y, fuse: b.fuse })),
    explosions: state.explosions.map(e => ({ tiles: e.tiles, life: e.life })),
    powerups: state.powerups,
    tombstones: state.tombstones,
    winnerId: state.winnerId,
    endTimer: state.endTimer,
  };
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  const id = nextId++;
  ws.playerId = id;
  send(ws, { type: 'welcome', id });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || `P${id}`).slice(0, 16);
      if (state.players.size >= 4) {
        send(ws, { type: 'error', error: 'Game is full (max 4 players).' });
        return;
      }
      if (state.phase !== 'lobby') {
        send(ws, { type: 'error', error: 'Game in progress, please wait for next round.' });
        return;
      }
      const idx = state.players.size;
      const becomingHost = state.hostId === null;
      const player = {
        id, name,
        color: COLORS[idx % COLORS.length],
        x: SPAWNS[idx].x, y: SPAWNS[idx].y,
        tileX: SPAWNS[idx].x, tileY: SPAWNS[idx].y,
        moving: false,
        facing: 'down',
        alive: false,
        ready: false, // everyone (including host) starts not-ready; host's Start Game click acts as their ready
        keys: {},
        bombHeld: false,
        maxBombs: 1, bombsActive: 0,
        range: 2, speed: BASE_SPEED,
        canKick: false,
        wins: 0, // accumulates across the session for as long as they stay connected
      };
      state.players.set(id, player);
      if (becomingHost) state.hostId = id;
    } else if (msg.type === 'input') {
      const p = state.players.get(id);
      if (!p) return;
      const dir = ['up','down','left','right'].includes(msg.dir) ? msg.dir : null;
      p.keys = { dir, bomb: !!msg.bomb };
      // Start a step immediately on a fresh direction press so very brief
      // taps (shorter than one server tick) still register.
      if (dir && state.phase === 'playing' && p.alive && !p.moving) {
        p.facing = dir;
        const { dx, dy } = DIR_DELTAS[dir];
        const nx = p.tileX + dx;
        const ny = p.tileY + dy;
        if (canStepTo(p, nx, ny)) {
          p.tileX = nx;
          p.tileY = ny;
          p.moving = true;
        } else if (p.canKick) {
          tryKickBomb(p, nx, ny, dx, dy);
        }
      }
    } else if (msg.type === 'ready') {
      const p = state.players.get(id);
      if (!p) return;
      // Host is always ready by construction; ignore Ready toggles from them.
      if (state.hostId === id) return;
      p.ready = !!msg.ready;
    } else if (msg.type === 'start_game') {
      if (state.phase !== 'lobby') return;
      if (id !== state.hostId) return;
      const all = [...state.players.values()];
      if (all.length < 2) return;
      // Only non-host players need to be ready — the host's Start Game
      // click is itself the ready signal.
      if (!all.every(pl => pl.id === state.hostId || pl.ready)) return;
      startGame();
    } else if (msg.type === 'start_solo') {
      const p = state.players.get(id);
      if (!p) return;
      if (state.phase !== 'lobby') return;
      if (state.players.size !== 1) return;
      startGame();
    } else if (msg.type === 'rename') {
      const p = state.players.get(id);
      if (!p) return;
      p.name = String(msg.name || p.name).slice(0, 16);
    }
  });

  ws.on('close', () => {
    state.players.delete(id);
    // Transfer host to another player if the host left. The new host
    // keeps whatever ready state they had — their Start Game click is
    // what advances the lobby, ready flag is irrelevant for the host.
    if (state.hostId === id) {
      const next = state.players.keys().next().value;
      state.hostId = next ?? null;
    }
    if (state.phase === 'playing') {
      const alive = [...state.players.values()].filter(p => p.alive);
      if (state.players.size === 0) {
        state.phase = 'lobby';
      } else if (alive.length <= 1 && state.players.size >= 1) {
        endGame(alive.length === 1 ? alive[0].id : null);
      }
    }
  });
});

// ----- Main loop -----
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  tick(dt);
  broadcast(snapshot());
}, 1000 / TICK_HZ);

// ----- Listen -----
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nBomberman LAN server running on port ${PORT}`);
  const ifaces = os.networkInterfaces();
  console.log('Share these URLs with friends on your network:');
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) {
        console.log(`  http://${i.address}:${PORT}`);
      }
    }
  }
  console.log(`  http://localhost:${PORT}\n`);
});
