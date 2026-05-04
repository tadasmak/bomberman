(() => {
  const TILE = 40;
  const DEATH_ANIM_MS  = 900;
  const OVERLAY_DELAY_MS = 1800;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const lobby = document.getElementById('lobby');
  const lobbyList = document.getElementById('lobbyList');
  const lobbyMsg = document.getElementById('lobbyMsg');
  const nameInput = document.getElementById('nameInput');
  const joinBtn = document.getElementById('joinBtn');
  const readyBtn = document.getElementById('readyBtn');
  const startBtn = document.getElementById('startBtn');
  const soloBtn = document.getElementById('soloBtn');
  const overlay = document.getElementById('overlay');
  const endScreen = document.getElementById('endScreen');
  const endText = document.getElementById('endText');
  const endCountdown = document.getElementById('endCountdown');
  const hud = document.getElementById('hud');
  const winsHud = document.getElementById('winsHud');
  const statsHud = document.getElementById('statsHud');

  // Restore name
  nameInput.value = localStorage.getItem('bomberman_name') || '';

  let myId = null;
  let joined = false;
  let ready = false;
  let kickedReason = null;
  let lastState = null;
  let showLabels = localStorage.getItem('bomberman_labels') !== 'false';
  const playerDeathTimes = new Map();
  let prevDrawPhase = null;
  let phaseEndedAt = null;

  // ----- WebSocket -----
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${wsProto}://${location.host}`);

  ws.addEventListener('open', () => {
    lobbyMsg.textContent = 'Connected. Pick a name and join.';
  });
  ws.addEventListener('close', () => {
    lobbyMsg.textContent = kickedReason
      ? `${kickedReason} Refresh to rejoin.`
      : 'Disconnected. Refresh to reconnect.';
    if (kickedReason) {
      overlay.style.display = 'flex';
      lobby.classList.remove('hidden');
      endScreen.classList.add('hidden');
      hud.classList.add('hidden');
    }
  });
  ws.addEventListener('error', () => {
    lobbyMsg.textContent = 'Connection error.';
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') {
      myId = msg.id;
    } else if (msg.type === 'state') {
      lastState = msg;
      updateUI(msg);
    } else if (msg.type === 'error') {
      lobbyMsg.textContent = msg.error;
    } else if (msg.type === 'kicked') {
      kickedReason = msg.reason || 'You were kicked.';
      lobbyMsg.textContent = kickedReason;
    }
  });

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || `P${myId || ''}`;
    localStorage.setItem('bomberman_name', name);
    send({ type: 'join', name });
    joined = true;
    joinBtn.classList.add('hidden');
    nameInput.disabled = true;
    // Lobby buttons (ready / start / solo) are shown contextually by updateUI
    // once the next state arrives.
  });

  readyBtn.addEventListener('click', () => {
    ready = !ready;
    readyBtn.textContent = ready ? 'Unready' : 'Ready';
    send({ type: 'ready', ready });
  });

  startBtn.addEventListener('click', () => {
    send({ type: 'start_game' });
  });

  soloBtn.addEventListener('click', () => {
    send({ type: 'start_solo' });
  });

  lobbyList.addEventListener('click', (e) => {
    const btn = e.target.closest('.kick-btn');
    if (!btn) return;
    const targetId = Number(btn.dataset.kickId);
    if (!Number.isInteger(targetId)) return;
    send({ type: 'kick', targetId });
  });

  // ----- Input -----
  // Track held direction keys as a stack so the most recently pressed
  // direction wins (last-key-wins). Bomb is a separate boolean.
  const heldDirs = [];
  let bombHeld = false;

  const DIR_FOR_CODE = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
  };

  function sendInput() {
    const dir = heldDirs[heldDirs.length - 1] || null;
    send({ type: 'input', dir, bomb: bombHeld });
  }

  function setDir(dir, val) {
    const idx = heldDirs.indexOf(dir);
    if (val) {
      if (idx < 0) heldDirs.push(dir);
    } else {
      if (idx >= 0) heldDirs.splice(idx, 1);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!joined) return;
    if (e.repeat) return;
    if ((e.code === 'Enter' || e.code === 'Space') && !readyBtn.classList.contains('hidden')) {
      e.preventDefault();
      readyBtn.click();
      return;
    }
    if (DIR_FOR_CODE[e.code]) {
      e.preventDefault();
      setDir(DIR_FOR_CODE[e.code], true);
      sendInput();
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (!bombHeld) { bombHeld = true; sendInput(); }
    }
  });
  document.addEventListener('keyup', (e) => {
    if (!joined) return;
    if (DIR_FOR_CODE[e.code]) {
      setDir(DIR_FOR_CODE[e.code], false);
      sendInput();
    } else if (e.code === 'Space') {
      if (bombHeld) { bombHeld = false; sendInput(); }
    }
  });
  window.addEventListener('blur', () => {
    heldDirs.length = 0;
    bombHeld = false;
    sendInput();
  });

  // ----- UI updates -----
  function updateUI(s) {
    updateControlsColor(s);
    if (s.phase === 'lobby') {
      phaseEndedAt = null;
      overlay.style.display = 'flex';
      lobby.classList.remove('hidden');
      endScreen.classList.add('hidden');
      hud.classList.add('hidden');

      const isHost = s.hostId === myId;

      lobbyList.innerHTML = '';
      for (const p of s.players) {
        const row = document.createElement('div');
        row.className = 'lobby-row';
        const isThisHost = p.id === s.hostId;
        const statusHtml = isThisHost
          ? '<span class="host-tag">👑 Host</span>'
          : `<span class="${p.ready ? 'ready' : 'waiting'}">${p.ready ? '✓ Ready' : 'Waiting...'}</span>`;
        const kickHtml = (isHost && p.id !== myId)
          ? `<button class="kick-btn" data-kick-id="${p.id}" title="Kick player">×</button>`
          : '';
        row.innerHTML = `
          <span>
            <span class="dot" style="background:${p.color}"></span>
            ${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}
            ${isThisHost ? '<em class="host-badge">host</em>' : ''}
          </span>
          <span class="lobby-row-right">
            ${statusHtml}
            ${kickHtml}
          </span>
        `;
        lobbyList.appendChild(row);
      }
      if (joined) {
        if (s.players.length < 2) {
          lobbyMsg.textContent = isHost
            ? 'Waiting for at least 2 players — or hit Solo Practice to test alone.'
            : 'Waiting for more players...';
          soloBtn.classList.toggle('hidden', !isHost);
          readyBtn.classList.add('hidden');
          startBtn.classList.add('hidden');
        } else {
          soloBtn.classList.add('hidden');
          // Only non-host players have a meaningful ready state.
          const allReady = s.players.every(p => p.id === s.hostId || p.ready);
          if (isHost) {
            readyBtn.classList.add('hidden');
            startBtn.classList.remove('hidden');
            startBtn.disabled = !allReady;
            lobbyMsg.textContent = allReady
              ? 'Everyone is ready — press Start Game!'
              : 'Waiting for all players to ready up.';
          } else {
            startBtn.classList.add('hidden');
            readyBtn.classList.remove('hidden');
            lobbyMsg.textContent = 'Press Ready when you\'re set — the host will start the game.';
          }
        }
      }
    } else if (s.phase === 'playing') {
      overlay.style.display = 'none';
      hud.classList.remove('hidden');
      renderHud(s);
    } else if (s.phase === 'ended') {
      if (!phaseEndedAt) phaseEndedAt = Date.now();
      hud.classList.remove('hidden');
      renderHud(s);
      if (Date.now() - phaseEndedAt >= OVERLAY_DELAY_MS) {
        overlay.style.display = 'flex';
        lobby.classList.add('hidden');
        endScreen.classList.remove('hidden');
        const winner = s.players.find(p => p.id === s.winnerId);
        if (winner) {
          endText.textContent = winner.id === myId ? '🏆 You win!' : `🏆 ${winner.name} wins!`;
        } else {
          endText.textContent = '💀 Draw — everyone exploded.';
        }
        endCountdown.textContent = `Returning to lobby in ${Math.ceil(s.endTimer)}s...`;
        if (ready) { ready = false; readyBtn.textContent = 'Ready'; }
      } else {
        overlay.style.display = 'none';
        endScreen.classList.add('hidden');
        lobby.classList.add('hidden');
      }
    }
  }

  function renderHud(s) {
    // Wins tab — every player, visible to everyone
    winsHud.innerHTML = '';
    for (const p of s.players) {
      const div = document.createElement('div');
      div.className = 'hud-player' + (p.alive ? '' : ' dead');
      const isMe = p.id === myId;
      div.innerHTML = `
        <span class="dot" style="background:${p.color}"></span>
        <span>${escapeHtml(p.name)}${isMe ? ' (you)' : ''}</span>
        <span class="wins">🏆${p.wins || 0}</span>
      `;
      winsHud.appendChild(div);
    }

    // Power-ups tab — only the local player's own loadout
    const me = s.players.find(p => p.id === myId);
    if (me) {
      statsHud.innerHTML = `
        <div class="hud-stats${showLabels ? '' : ' labels-hidden'}">
          <div class="stat-item">
            <span>💣 ${me.maxBombs}</span>
            <span class="stat-label">extra bomb</span>
          </div>
          <div class="stat-item">
            <span>🔥 ${me.range}</span>
            <span class="stat-label">wider blast</span>
          </div>
          <div class="stat-item">
            <span>👟 ${formatSpeed(me.speed)}</span>
            <span class="stat-label">move faster</span>
          </div>
          <div class="stat-item kick ${me.canKick ? 'active' : 'inactive'}">
            <span>🥾</span>
            <span class="stat-label">${me.canKick ? 'shove bombs' : 'no kick'}</span>
          </div>
          <button class="stat-toggle" title="Toggle labels">${showLabels ? '×' : 'ℹ'}</button>
        </div>
      `;
    } else {
      statsHud.innerHTML = '';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function formatSpeed(s) {
    return Number.isInteger(s) ? String(s) : s.toFixed(1);
  }

  // ----- Rendering -----
  function draw() {
    requestAnimationFrame(draw);
    if (!lastState) return;
    const s = lastState;
    canvas.width = s.cols * TILE;
    canvas.height = s.rows * TILE;

    // Background
    ctx.fillStyle = '#3a8c3a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Tiles
    for (let y = 0; y < s.rows; y++) {
      for (let x = 0; x < s.cols; x++) {
        const t = s.map[y][x];
        const px = x * TILE, py = y * TILE;
        // Grass alternation
        ctx.fillStyle = (x + y) % 2 === 0 ? '#3a8c3a' : '#388438';
        ctx.fillRect(px, py, TILE, TILE);

        if (t === 1) drawWall(px, py);
        else if (t === 2) drawBrick(px, py);
      }
    }

    // Tombstones (drawn after tiles, before powerups and players)
    if (s.tombstones) {
      for (const ts of s.tombstones) drawTombstone(ts.x * TILE, ts.y * TILE, ts.color);
    }

    // Power-ups
    for (const pu of s.powerups) {
      drawPowerup(pu.x * TILE, pu.y * TILE, pu.type);
    }

    // Bombs
    for (const b of s.bombs) {
      drawBomb(b.x * TILE, b.y * TILE, b.fuse);
    }

    // Players (sort by y so lower ones overlap)
    const nowMs = performance.now();

    if (s.phase === 'playing' && prevDrawPhase !== 'playing') playerDeathTimes.clear();
    prevDrawPhase = s.phase;

    for (const p of s.players) {
      if (!p.alive && !playerDeathTimes.has(p.id)) {
        playerDeathTimes.set(p.id, nowMs);
        if (p.id === myId) triggerDeathFlash();
      }
    }

    const sorted = [...s.players].sort((a, b) => a.y - b.y);
    for (const p of sorted) {
      const deathTime = playerDeathTimes.get(p.id);
      const animT = deathTime ? (nowMs - deathTime) / DEATH_ANIM_MS : 1;
      if (p.alive) {
        drawCharacter(p.x * TILE, p.y * TILE, p.color, p.name, p.facing || 'down', !!p.moving, p.id === myId);
      } else if (animT < 1) {
        drawDeathAnimation(p, animT);
      } else if (s.phase === 'playing') {
        drawGhost(p.x * TILE, p.y * TILE, p.color, p.name);
      }
    }

    // Explosions on top
    // Server stops ticking explosions when phase becomes 'ended', so continue
    // fading them on the client using elapsed time since the phase transition.
    const explosionOffset = s.phase === 'ended' && phaseEndedAt
      ? (Date.now() - phaseEndedAt) / 1000
      : 0;
    for (const e of s.explosions) {
      const life = e.life - explosionOffset;
      if (life > 0) drawExplosion({ ...e, life });
    }
  }

  function drawWall(px, py) {
    ctx.fillStyle = '#5a5e6e';
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = '#7a7e8e';
    ctx.fillRect(px + 2, py + 2, TILE - 8, TILE - 8);
    ctx.strokeStyle = '#2a2d36';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
  }

  function drawBrick(px, py) {
    ctx.fillStyle = '#a04a25';
    ctx.fillRect(px, py, TILE, TILE);
    ctx.strokeStyle = '#5e2a14';
    ctx.lineWidth = 1;
    // Brick pattern
    for (let i = 0; i < 4; i++) {
      const y = py + i * (TILE / 4);
      ctx.beginPath();
      ctx.moveTo(px, y);
      ctx.lineTo(px + TILE, y);
      ctx.stroke();
      const offset = (i % 2 === 0) ? 0 : TILE / 2;
      for (let j = 0; j <= 1; j++) {
        const x = px + offset + j * TILE;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + TILE / 4);
        ctx.stroke();
      }
    }
  }

  function drawBomb(tx, ty, fuse) {
    const cx = tx + TILE / 2;
    const cy = ty + TILE / 2;
    // pulsate
    const t = Date.now() / 1000;
    const pulse = 1 + 0.08 * Math.sin(t * (10 - fuse * 2));
    const r = TILE * 0.32 * pulse;
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.25, 0, Math.PI * 2);
    ctx.fill();
    // fuse
    ctx.strokeStyle = '#aa7733';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.6, cy - r * 0.6);
    ctx.quadraticCurveTo(cx + r, cy - r * 1.2, cx + r * 1.1, cy - r * 1.4);
    ctx.stroke();
    // spark
    if (Math.floor(t * 10) % 2 === 0) {
      ctx.fillStyle = '#ffeb3b';
      ctx.beginPath();
      ctx.arc(cx + r * 1.1, cy - r * 1.4, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawExplosion(e) {
    // Total visual life is 0.35s on the server. The first ~0.15s is the
    // dangerous "flash" — render at full brightness. The remaining ~0.20s
    // is just a fade where the player can safely walk through.
    const FADE_PHASE = 0.20;
    const alpha = e.life > FADE_PHASE ? 1 : Math.max(0, e.life / FADE_PHASE);
    for (const t of e.tiles) {
      const px = t.x * TILE, py = t.y * TILE;
      ctx.fillStyle = `rgba(255, 200, 0, ${alpha})`;
      ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = `rgba(255, 80, 0, ${alpha * 0.7})`;
      ctx.fillRect(px + 6, py + 6, TILE - 12, TILE - 12);
      ctx.fillStyle = `rgba(255, 255, 200, ${alpha})`;
      ctx.fillRect(px + 12, py + 12, TILE - 24, TILE - 24);
    }
  }

  function drawCharacter(tx, ty, color, name, facing, moving, isMe) {
    const cx = tx + TILE / 2;
    const cy = ty + TILE / 2;
    const t = performance.now();
    const stepPhase = moving ? (Math.floor(t / 110) % 2) : 0;
    const bob = moving ? Math.sin(t / 70) * 1 : 0;

    // Shadow (fixed at ground level)
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 13, 11, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // "Me" indicator: little arrow / ring around shadow
    if (isMe) {
      ctx.strokeStyle = 'rgba(255, 235, 59, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 13, 13, 5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    const by = cy + bob;

    // ----- Feet -----
    ctx.fillStyle = '#1f1f24';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    if (facing === 'left' || facing === 'right') {
      const back  = stepPhase ? -3 : 3;
      const front = -back;
      drawFoot(cx + back,  by + 12, 4, 2.5);
      drawFoot(cx + front, by + 13, 4, 2.5);
    } else {
      const dy = stepPhase ? -1 : 1;
      drawFoot(cx - 4, by + 12 + dy, 3.5, 2.5);
      drawFoot(cx + 4, by + 12 - dy, 3.5, 2.5);
    }

    // ----- Body / suit -----
    ctx.fillStyle = color;
    roundRect(cx - 7, by - 1, 14, 13, 4);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Belt
    ctx.fillStyle = '#1f1f24';
    ctx.fillRect(cx - 7, by + 7, 14, 2);
    // Belt buckle
    ctx.fillStyle = '#ffd84d';
    ctx.fillRect(cx - 1.5, by + 7, 3, 2);

    // Arms (small bumps on either side of body)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx - 7, by + 4, 2.5, 0, Math.PI * 2);
    ctx.arc(cx + 7, by + 4, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Hands
    ctx.fillStyle = '#f4d2a3';
    ctx.beginPath();
    ctx.arc(cx - 7, by + 6.2, 1.6, 0, Math.PI * 2);
    ctx.arc(cx + 7, by + 6.2, 1.6, 0, Math.PI * 2);
    ctx.fill();

    // ----- Head -----
    const hx = cx;
    const hy = by - 7;
    // Skin
    ctx.fillStyle = '#f4d2a3';
    ctx.beginPath();
    ctx.arc(hx, hy, 6.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // Helmet (top half, player color)
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(hx, hy, 6.2, Math.PI * 1.05, Math.PI * 1.95, false);
    ctx.lineTo(hx + 6.2 * Math.cos(Math.PI * 1.95), hy);
    ctx.lineTo(hx - 6.2, hy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    // Helmet trim (horizontal line)
    ctx.beginPath();
    ctx.moveTo(hx - 6, hy);
    ctx.lineTo(hx + 6, hy);
    ctx.stroke();
    // Helmet antenna / nub
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(hx, hy - 6.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();

    // Eyes / face based on facing
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.8;
    if (facing === 'down') {
      drawEye(hx - 2.4, hy + 2.2);
      drawEye(hx + 2.4, hy + 2.2);
    } else if (facing === 'left') {
      drawEye(hx - 2.6, hy + 2.2);
    } else if (facing === 'right') {
      drawEye(hx + 2.6, hy + 2.2);
    }
    // facing 'up' = back of head, no eyes

    // ----- Name -----
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(name, cx, ty - 2);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, cx, ty - 2);
    ctx.lineWidth = 1;
  }

  function drawFoot(cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  function drawEye(cx, cy) {
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(cx, cy + 0.3, 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function drawTombstone(px, py, color) {
    const cx = px + TILE / 2;
    const w  = TILE * 0.64;
    const h  = TILE * 0.76;
    const left   = cx - w / 2;
    const right  = cx + w / 2;
    const bottom = py + TILE * 0.86;
    const top    = bottom - h;
    const archR  = w / 2;
    const archMidY = top + archR;

    // Drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(cx + 2, bottom + 2, w * 0.46, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Stone shape — flat bottom, arched top
    ctx.beginPath();
    ctx.moveTo(left, bottom);
    ctx.lineTo(left, archMidY);
    ctx.arcTo(left, top, cx, top, archR);
    ctx.arcTo(right, top, right, archMidY, archR);
    ctx.lineTo(right, bottom);
    ctx.closePath();

    ctx.fillStyle = '#8d95a8';
    ctx.fill();

    // Player-color tint
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.2;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Outline
    ctx.strokeStyle = '#555d70';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Left-edge highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + 2, bottom - 2);
    ctx.lineTo(left + 2, archMidY);
    ctx.arcTo(left + 2, top + 2, cx, top + 2, archR - 2);
    ctx.stroke();

    // Cross
    const crossCy = archMidY + (bottom - archMidY) * 0.28;
    ctx.fillStyle = '#555d70';
    ctx.fillRect(cx - 1.5, crossCy - 8, 3, 13);
    ctx.fillRect(cx - 6,   crossCy - 3, 12, 3);

    // "RIP" label
    ctx.font = 'bold 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#555d70';
    ctx.fillText('RIP', cx, crossCy + 10);
  }

  function drawGhost(tx, ty, color, name) {
    const cx = tx + TILE / 2;
    const cy = ty + TILE / 2;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, TILE * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.fillText('💀', cx, cy + 4);
  }

  function drawPowerup(tx, ty, type) {
    const cx = tx + TILE / 2;
    const cy = ty + TILE / 2;
    const t = Date.now() / 1000;
    const bob = Math.sin(t * 3) * 2;
    // Background circle
    const bgColor = type === 'bomb'  ? '#444'
                  : type === 'range' ? '#ff6b3d'
                  : type === 'speed' ? '#59a6ff'
                  : type === 'kick'  ? '#9b6bff'
                  : '#666';
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.arc(cx, cy + bob, TILE * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const icon = type === 'bomb'  ? '💣'
               : type === 'range' ? '🔥'
               : type === 'speed' ? '👟'
               : type === 'kick'  ? '🥾'
               : '?';
    ctx.fillText(icon, cx, cy + bob);
    ctx.textBaseline = 'alphabetic';
  }

  // ----- Canvas sizing -----
  function resizeCanvas() {
    const LOGICAL_W = 600;
    const LOGICAL_H = 520;
    const isMobile = window.innerWidth <= 768;
    const controlsH = isMobile ? 230 : 0;
    const topH = isMobile ? 72 : 12;
    const pad = 8;
    const availW = window.innerWidth - pad * 2;
    const availH = window.innerHeight - controlsH - topH - pad;
    const scale = Math.min(availW / LOGICAL_W, availH / LOGICAL_H, 1);
    canvas.style.width  = Math.floor(LOGICAL_W * scale) + 'px';
    canvas.style.height = Math.floor(LOGICAL_H * scale) + 'px';
  }

  // ----- Mobile controls -----
  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function updateControlsColor(s) {
    const controls = document.getElementById('mobile-controls');
    if (!controls) return;
    const me = s.players.find(p => p.id === myId);
    if (!me) return;
    controls.style.setProperty('--player-color', me.color);
    controls.style.setProperty('--player-color-mid', hexToRgba(me.color, 0.4));
    controls.style.setProperty('--player-color-dim', hexToRgba(me.color, 0.15));
  }

  function setupMobileControls() {
    const dirMap = { 'btn-up': 'up', 'btn-down': 'down', 'btn-left': 'left', 'btn-right': 'right' };
    for (const [id, dir] of Object.entries(dirMap)) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        btn.classList.add('pressed');
        setDir(dir, true);
        sendInput();
      });
      const up = () => { btn.classList.remove('pressed'); setDir(dir, false); sendInput(); };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    }
    const bombBtn = document.getElementById('btn-bomb');
    if (!bombBtn) return;
    bombBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bombBtn.setPointerCapture(e.pointerId);
      bombBtn.classList.add('pressed');
      if (!bombHeld) { bombHeld = true; sendInput(); }
    });
    const releaseBomb = () => {
      bombBtn.classList.remove('pressed');
      if (bombHeld) { bombHeld = false; sendInput(); }
    };
    bombBtn.addEventListener('pointerup', releaseBomb);
    bombBtn.addEventListener('pointercancel', releaseBomb);
  }

  // Toggle stat labels on/off
  statsHud.addEventListener('click', (e) => {
    if (!e.target.closest('.stat-toggle')) return;
    showLabels = !showLabels;
    localStorage.setItem('bomberman_labels', showLabels);
  });

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  setupMobileControls();

  function triggerDeathFlash() {
    const el = document.getElementById('death-flash');
    if (!el) return;
    el.classList.remove('active');
    void el.offsetWidth;
    el.classList.add('active');
  }

  function drawDeathAnimation(p, t) {
    const cx = p.x * TILE + TILE / 2;
    const cy = p.y * TILE + TILE / 2;

    // Outward particles (first half of animation)
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const dist = t * TILE * 1.3;
      ctx.globalAlpha = Math.max(0, (1 - t * 2.2) * 0.9);
      ctx.fillStyle = i % 2 === 0 ? p.color : '#fff8b0';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, 3.5 * (1 - t) + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Spinning + shrinking character
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * Math.PI * 3.5);
    ctx.scale(1 - t, 1 - t);
    ctx.globalAlpha = Math.max(0, 1 - t * 1.4);

    // Body
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(0, 3, TILE * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Head
    ctx.fillStyle = '#f4d2a3';
    ctx.beginPath();
    ctx.arc(0, -TILE * 0.16, TILE * 0.155, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // X eyes
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'round';
    for (const ex of [-3.5, 3.5]) {
      const ey = -TILE * 0.16 + 1.5;
      ctx.beginPath();
      ctx.moveTo(ex - 2.2, ey - 2.2); ctx.lineTo(ex + 2.2, ey + 2.2);
      ctx.moveTo(ex + 2.2, ey - 2.2); ctx.lineTo(ex - 2.2, ey + 2.2);
      ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  draw();
})();
