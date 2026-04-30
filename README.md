# 💣 Bomberman LAN

A multiplayer Bomberman-style game for your local network. Top-down grid, destructible walls, power-ups, last bomber standing wins. Server-authoritative WebSocket multiplayer for 2–4 players.

## Requirements

- Node.js 18+ (any recent LTS)
- All players on the same local network (Wi‑Fi or LAN)

## Install

```bash
cd bomberman
npm install
```

## Run

```bash
npm start
```

On startup the server prints all your LAN addresses, e.g.:

```
Bomberman LAN server running on port 3000
Share these URLs with friends on your network:
  http://192.168.1.42:3000
  http://localhost:3000
```

Share the LAN address (not `localhost`) with your friends. Everyone opens it in a browser, types a name, and hits **Join**.

The first player to join becomes the **host** (👑 in the lobby list). The flow is:

- **Non-hosts** click **Ready** when they're set.
- **Host** clicks **Start Game** to begin the round — it's only enabled once every other player is ready and there are at least 2 players in the lobby (max 4).

If the host disconnects, host status automatically transfers to another player still in the lobby.

### Solo practice / debugging

If you're alone in the lobby a **Solo Practice** button appears next to **Ready**. Click it to start a single-player round — useful for testing bombs, power-ups, and movement without needing a second browser. The round ends when you blow yourself up (or you can just close the tab); afterwards you're returned to the lobby.

To run on a custom port:

```bash
PORT=8080 npm start
```

## Controls

| Action | Keys |
|--------|------|
| Move   | `WASD` or `Arrow keys` |
| Drop bomb | `Space` |

## Gameplay

- **Map**: 15×13 grid. Grey pillars are indestructible, brown bricks are destructible.
- **Spawns**: up to 4 players, one in each corner.
- **Movement**: tile-based — each press (or held key) moves the player exactly one tile, with a smooth glide between tiles and a walking animation. Holding a direction chains steps; the most recently pressed direction wins if you hold multiple. Brief taps still register reliably.
- **Character**: a little Bomberman-style sprite per player — colored helmet/suit (matching your player color), animated feet, and eyes that face whichever way you're walking. A yellow ring under your shadow marks "you" on the map.
- **Bombs**: 2.5 second fuse, cross-shaped explosion, chain-detonate other bombs in the blast.
- **Power-ups** drop from destroyed bricks. Each brick has these independent (mutually exclusive) chances:

  | Icon | Type | Drop chance | Cap (per player) | Effect |
  |------|------|-------------|------------------|--------|
  | 💣 | Extra bomb | **1/14** (≈7.1%) | +1, **once per player** | Place an additional bomb at the same time |
  | 🔥 | Flame range | **1/8** (12.5%) | +1, **up to 4 times** (max range 6) | Bigger explosion cross |
  | 👟 | Speed | **1/8** (12.5%) | +0.5, **up to 4 times** (max speed 6 tiles/s) | Faster tile-step animation |
  | 🥾 | Kick | **1/12** (≈8.3%) | once per player | Walk into a bomb to push it; it slides until it hits a wall, brick, another bomb, or a player |

  If a player walks onto a power-up they're already capped on, it stays on the tile for someone else to grab. Power-ups caught in a blast are destroyed.
- **Win condition**: last bomber standing wins. If everyone dies on the same tick, it's a draw.
- After each round, a **5-second end screen** shows the winner, then everyone returns to the lobby and re-readies for the next round on a freshly randomised map.

## Architecture

- `server.js` — Authoritative game server (Node.js + `ws`). Runs the game loop at 30 Hz, processes inputs, simulates physics/bombs/explosions/power-ups, and broadcasts full state snapshots to all clients.
- `public/index.html` — Lobby UI + game canvas.
- `public/game.js` — Input forwarding, Canvas rendering, lobby/HUD/end-screen UI.
- `public/style.css` — Dark theme UI.

The client is a thin renderer: it sends keyboard inputs, receives state, and draws. All game logic (movement collision, bomb fuses, explosion propagation, win detection) lives on the server.

### WebSocket protocol

Client → server:
- `{ type: 'join', name }` — join the lobby
- `{ type: 'ready', ready: bool }` — toggle ready state (ignored from the host, who is implicitly ready)
- `{ type: 'start_game' }` — host-only; starts the round when 2+ players are present and all non-host players are ready
- `{ type: 'start_solo' }` — start a 1-player practice round (only valid in lobby with exactly one player)
- `{ type: 'input', dir, bomb }` — `dir` is `'up'|'down'|'left'|'right'|null` (the most recently pressed direction key still held); `bomb` is the current state of Space
- `{ type: 'rename', name }` — change name

Server → client:
- `{ type: 'welcome', id }` — assigned player id on connect
- `{ type: 'state', ... }` — full game snapshot (sent at ~30 Hz). Players include `x`, `y` (interpolated tile position), `facing`, `moving`, `maxBombs`, `range`, `speed`, `alive`.
- `{ type: 'error', error }` — join rejected (game full / in progress)

## Troubleshooting

- **Friends can't connect**: check your firewall allows inbound TCP on port 3000. On Linux: `sudo ufw allow 3000/tcp`. Make sure everyone is on the same subnet (same router) — VPNs and guest Wi‑Fi will block it.
- **"Game in progress"**: the round started before you joined. Wait for the next round (auto-restarts after a round ends).
- **"Game is full"**: max 4 players per server.
- **Page shows "Disconnected"**: server stopped or connection dropped — refresh the page.

## Customising

Tweak constants at the top of `server.js`:

- `COLS`, `ROWS` — map dimensions
- `BOMB_FUSE` — bomb fuse time (seconds)
- `EXPLOSION_DURATION` — how long blast tiles damage (seconds)
- `DROP_CHANCE_BOMB`, `DROP_CHANCE_RANGE`, `DROP_CHANCE_SPEED`, `DROP_CHANCE_KICK` — mutually exclusive per-brick drop probabilities (single roll picks at most one)
- `MAX_BOMBS`, `MAX_RANGE`, `MAX_SPEED` — power-up caps
- `BASE_SPEED` — starting movement speed (tiles/sec)
- `BOMB_SLIDE_SPEED` — how fast a kicked bomb slides (tiles/sec)
