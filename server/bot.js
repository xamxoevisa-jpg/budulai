// ============================================================
// bot.js — «Санитар», серверный бот для одиночной тренировки.
// Управляется как обычный игрок: каждый тик выставляет input
// (dx, dy, sprint, angle) и дергает handleInteract — вся физика
// и правила остаются общими с живыми игроками.
//
// Честность: бот-Монстр НЕ знает позицию жертвы — он идёт по
// следам, «слышит дыхание» вблизи (как человек по индикатору)
// и проверяет укрытия там, где след оборвался. Бот-Жертва
// убегает, когда Монстр близко (её сердцебиение), иначе
// патрулирует и прячется.
// ============================================================

'use strict';

const { isWalkableTile, TILE } = require('./map');

// --- BFS-путь по тайлам ---
function bfsPath(map, fromX, fromY, toX, toY) {
  const key = (x, y) => x * 1000 + y;
  const walk = (x, y) => x >= 0 && y >= 0 && x < map.W && y < map.H &&
    isWalkableTile(map.grid[y][x]);
  if (!walk(toX, toY) || !walk(fromX, fromY)) return null;
  const prev = new Map([[key(fromX, fromY), null]]);
  const q = [[fromX, fromY]];
  let qi = 0;
  while (qi < q.length) {
    const [x, y] = q[qi++];
    if (x === toX && y === toY) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!walk(nx, ny) || prev.has(key(nx, ny))) continue;
      prev.set(key(nx, ny), [x, y]);
      q.push([nx, ny]);
    }
  }
  if (!prev.has(key(toX, toY))) return null;
  const path = [];
  let cur = [toX, toY];
  while (cur) { path.unshift(cur); cur = prev.get(key(cur[0], cur[1])); }
  return path;
}

// случайный проходимый тайл
function randomTile(map, rnd = Math.random) {
  for (let i = 0; i < 60; i++) {
    const x = 1 + Math.floor(rnd() * (map.W - 2));
    const y = 1 + Math.floor(rnd() * (map.H - 2));
    if (isWalkableTile(map.grid[y][x])) return [x, y];
  }
  return null;
}

function freshState() {
  return {
    path: null,        // текущий путь (массив тайлов)
    pathIdx: 0,
    repath: 0,         // таймер перепрокладки пути
    goal: null,        // цель [tx, ty]
    goalKind: 'idle',  // idle | patrol | footprint | hunt | flee | tospot
    dwell: 0,          // сколько стоим у цели
    hideTimer: 0,      // сколько ещё сидеть в укрытии
    hideCooldown: 0,   // пауза до следующего пряток
    checkDelay: 0,     // задержка перед проверкой укрытия (Монстр)
    lastFootprintId: -1,
  };
}

// выставить input бота в сторону следующей точки пути
function steer(game, bot, st, sprint) {
  if (!st.path || st.pathIdx >= st.path.length) {
    bot.input.dx = 0; bot.input.dy = 0; bot.input.sprint = false;
    return true; // пришли
  }
  const [tx, ty] = st.path[Math.min(st.pathIdx + 1, st.path.length - 1)];
  const wx = (tx + 0.5) * TILE, wy = (ty + 0.5) * TILE;
  const dx = wx - bot.x, dy = wy - bot.y;
  const d = Math.hypot(dx, dy);
  if (d < TILE * 0.45) {
    st.pathIdx++;
    if (st.pathIdx >= st.path.length - 1 && d < TILE * 0.4) {
      bot.input.dx = 0; bot.input.dy = 0;
      return true;
    }
  }
  bot.input.dx = dx / (d || 1);
  bot.input.dy = dy / (d || 1);
  bot.input.sprint = !!sprint;
  bot.input.angle = Math.atan2(dy, dx);
  return false;
}

function setGoal(game, bot, st, tile, kind) {
  st.goal = tile;
  st.goalKind = kind;
  st.path = tile ? bfsPath(game.map, Math.floor(bot.x / TILE), Math.floor(bot.y / TILE), tile[0], tile[1]) : null;
  st.pathIdx = 0;
}

// ------------------------------------------------------------
// Главный апдейт бота, вызывается из game.tick
// ------------------------------------------------------------
function update(game, dt) {
  const slot = game.botSlot;
  if (slot == null) return;
  const bot = game.players[slot];
  if (!bot || !game.map) return;
  if (!game.botState) game.botState = freshState();
  const st = game.botState;
  const isHunter = slot === game.hunterSlot;
  const foe = game.players[1 - slot];
  if (!foe) return;

  st.repath -= dt;
  st.hideCooldown -= dt;

  if (isHunter) updateHunter(game, bot, foe, st, dt);
  else updateSurvivor(game, bot, foe, st, dt);
}

// --- бот-Монстр ---
function updateHunter(game, bot, foe, st, dt) {
  const dist = Math.hypot(foe.x - bot.x, foe.y - bot.y);
  const hearRange = 260; // как snap.breath у живого Монстра

  // 1) слышит дыхание — идёт на звук; неточность прицела тает с дистанцией
  if (foe.hiddenIn < 0 && dist < hearRange) {
    if (st.repath <= 0 || st.goalKind !== 'hunt') {
      const jitter = Math.max(0, dist - 120) * 0.6; // вблизи — точно на цель
      const jx = Math.floor((foe.x + (Math.random() - 0.5) * jitter) / TILE);
      const jy = Math.floor((foe.y + (Math.random() - 0.5) * jitter) / TILE);
      setGoal(game, bot, st, [jx, jy], 'hunt');
      if (!st.path) setGoal(game, bot, st, [Math.floor(foe.x / TILE), Math.floor(foe.y / TILE)], 'hunt');
      st.repath = 0.45;
    }
    // на финальном сближении идём прямо на жертву, без сетки тайлов
    if (dist < TILE * 1.6) {
      const dx = foe.x - bot.x, dy = foe.y - bot.y;
      const d = Math.hypot(dx, dy) || 1;
      bot.input.dx = dx / d; bot.input.dy = dy / d;
      bot.input.angle = Math.atan2(dy, dx);
      return;
    }
    steer(game, bot, st, false);
    return;
  }

  // 2) свежие следы — идёт к самому новому
  const fps = game.footprints;
  if (fps.length > 0) {
    const newest = fps[fps.length - 1];
    if (newest.id !== st.lastFootprintId || st.goalKind !== 'footprint' || st.repath <= 0) {
      st.lastFootprintId = newest.id;
      setGoal(game, bot, st, [Math.floor(newest.x / TILE), Math.floor(newest.y / TILE)], 'footprint');
      st.repath = 0.6;
    }
    const arrived = steer(game, bot, st, false);
    if (arrived) st.goalKind = 'cold'; // след закончился здесь
    return;
  }

  // 3) след оборвался — проверить укрытия поблизости
  if (st.goalKind === 'cold' || st.goalKind === 'tospot') {
    // ближайшее укрытие в радиусе 6 тайлов от места обрыва
    let best = null, bd = TILE * 6;
    for (const s of game.map.hideSpots) {
      const d = Math.hypot(s.x - bot.x, s.y - bot.y);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) {
      const near = Math.hypot(best.x - bot.x, best.y - bot.y) < 46;
      if (near) {
        st.checkDelay += dt;
        bot.input.dx = 0; bot.input.dy = 0;
        if (st.checkDelay > 0.5) {   // «заглянуть» — пауза перед рывком дверцы
          st.checkDelay = 0;
          game.handleInteract(game.botSlot);
          st.goalKind = 'patrol';    // дальше патруль
          setGoal(game, bot, st, randomTile(game.map), 'patrol');
        }
        return;
      }
      if (st.goalKind !== 'tospot') {
        setGoal(game, bot, st, [Math.floor(best.x / TILE), Math.floor(best.y / TILE)], 'tospot');
      }
      steer(game, bot, st, false);
      return;
    }
    st.goalKind = 'patrol';
  }

  // 4) патруль по случайным точкам
  if (st.goalKind !== 'patrol' || !st.path || steer(game, bot, st, false)) {
    setGoal(game, bot, st, randomTile(game.map), 'patrol');
    st.goalKind = 'patrol';
  }
}

// --- бот-Жертва ---
function updateSurvivor(game, bot, foe, st, dt) {
  const dist = Math.hypot(foe.x - bot.x, foe.y - bot.y);

  // сидим в укрытии
  if (bot.hiddenIn >= 0) {
    st.hideTimer -= dt;
    // паника: Монстр вплотную — выпрыгнуть и бежать
    if (dist < 110 || st.hideTimer <= 0) {
      game.handleInteract(game.botSlot);   // вылезти
      st.hideCooldown = 16 + Math.random() * 10;
      setGoal(game, bot, st, null, 'idle');
    }
    return;
  }

  // 1) Монстр близко — убегать (сердцебиение подсказывает)
  if (dist < 430) {
    if (st.repath <= 0 || st.goalKind !== 'flee') {
      // выбрать из случайных точек ту, что дальше всего от Монстра
      let best = null, bd = -1;
      for (let i = 0; i < 14; i++) {
        const t = randomTile(game.map);
        if (!t) continue;
        const wx = (t[0] + 0.5) * TILE, wy = (t[1] + 0.5) * TILE;
        // и от Монстра подальше, и от себя не слишком далеко
        const dFoe = Math.hypot(wx - foe.x, wy - foe.y);
        const dMe = Math.hypot(wx - bot.x, wy - bot.y);
        const score = dFoe - dMe * 0.35;
        if (score > bd) { bd = score; best = t; }
      }
      setGoal(game, bot, st, best, 'flee');
      st.repath = 0.8;
    }
    steer(game, bot, st, bot.stamina > 12); // спринт, пока есть силы
    return;
  }

  // 2) Монстр далеко и рядом укрытие — спрятаться
  if (st.hideCooldown <= 0 && dist > 650) {
    let best = null, bd = TILE * 4;
    for (const s of game.map.hideSpots) {
      const d = Math.hypot(s.x - bot.x, s.y - bot.y);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) {
      if (bd < 46) {
        game.handleInteract(game.botSlot); // спрятаться
        st.hideTimer = 7 + Math.random() * 8;
        return;
      }
      if (st.goalKind !== 'tohide') {
        setGoal(game, bot, st, [Math.floor(best.x / TILE), Math.floor(best.y / TILE)], 'tohide');
      }
      steer(game, bot, st, false);
      return;
    }
  }

  // 3) обычное блуждание (не сидеть на месте — Монстру нужны следы...
  //    но и жертве полезно менять позицию)
  if (st.goalKind !== 'wander' || !st.path || steer(game, bot, st, false)) {
    setGoal(game, bot, st, randomTile(game.map), 'wander');
    st.goalKind = 'wander';
  }
}

module.exports = { update, freshState };
