// ============================================================
// map.js — процедурная генерация карты лечебницы «Чернолесье»
// Карта — сетка тайлов. Комнаты разных типов соединены коридорами.
// Генерация детерминирована сидом: сервер генерирует и рассылает
// клиентам сид + готовую сетку (сетку шлём готовой, чтобы клиент
// и сервер гарантированно совпадали).
// ============================================================

'use strict';

// Типы тайлов
const T = {
  VOID: 0,      // пустота за стенами
  FLOOR: 1,     // обычный пол
  WALL: 2,      // стена
  DOOR: 3,      // дверной проём (проходим)
  WINDOW: 4,    // окно во внешней стене (непроходимо, но пропускает молнию)
  RUBBLE: 5,    // разрушенная стена (проходимо, но медленно — визуально обломки)
};

// Типы комнат — влияют на декор и предметы
const ROOM = {
  CORRIDOR: 'corridor',
  WARD: 'ward',            // палата с кроватями
  OPERATING: 'operating',  // операционная
  BOILER: 'boiler',        // котельная
  MORGUE: 'morgue',        // морг
  CHILDREN: 'children',    // детское крыло
  STORAGE: 'storage',      // кладовая
};

const TILE = 48; // размер тайла в пикселях (мировые координаты)

// Простой детерминированный ГПСЧ (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------
// Генерация карты.
// Подход: сетка «ячеек» комнат, соединённых длинными коридорами.
// Центральный горизонтальный коридор + вертикальные ответвления —
// это даёт «больничную» планировку: длинные прямые коридоры,
// по бокам палаты.
// ------------------------------------------------------------
function generateMap(seed) {
  const rand = rng(seed);
  const W = 64, H = 48;
  const grid = new Array(H);
  for (let y = 0; y < H; y++) grid[y] = new Array(W).fill(T.VOID);

  const rooms = [];      // {x,y,w,h,type}
  const hideSpots = [];  // укрытия: {id,x,y,kind} (мировые координаты центра)
  const props = [];      // декор: {x,y,kind,r} — r: поворот/вариант
  let hideId = 0;

  // --- вырезать прямоугольник пола ---
  function carve(x, y, w, h) {
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++)
        if (i > 0 && j > 0 && i < W - 1 && j < H - 1) grid[j][i] = T.FLOOR;
  }

  // --- главный коридор через всю карту (ширина 3) ---
  const mainY = 22 + Math.floor(rand() * 4);
  carve(2, mainY, W - 4, 3);
  rooms.push({ x: 2, y: mainY, w: W - 4, h: 3, type: ROOM.CORRIDOR });

  // --- вертикальные коридоры-ответвления ---
  const branches = [];
  const nBranches = 4;
  for (let b = 0; b < nBranches; b++) {
    const bx = 6 + Math.floor((W - 12) * (b + 0.2 + rand() * 0.6) / nBranches);
    const up = rand() < 0.5 ? 1 : 0;
    // ветка вверх и вниз от главного коридора
    const topY = 3 + Math.floor(rand() * 3);
    const botY = H - 6 - Math.floor(rand() * 3);
    carve(bx, topY, 2, mainY - topY + 1);
    carve(bx, mainY, 2, botY - mainY + 2);
    rooms.push({ x: bx, y: topY, w: 2, h: botY - topY + 2, type: ROOM.CORRIDOR });
    branches.push(bx);
    void up;
  }

  // --- комнаты вдоль коридоров ---
  // Каждому типу — свой список; детское крыло всегда в одном углу
  const roomTypes = [
    ROOM.WARD, ROOM.WARD, ROOM.WARD, ROOM.WARD,
    ROOM.OPERATING, ROOM.BOILER, ROOM.MORGUE,
    ROOM.STORAGE, ROOM.STORAGE, ROOM.WARD,
  ];

  // Пытаемся расставить комнаты, прилегающие к коридорам
  let attempts = 0;
  const placedRooms = [];
  while (roomTypes.length > 0 && attempts < 400) {
    attempts++;
    const rw = 6 + Math.floor(rand() * 5);
    const rh = 5 + Math.floor(rand() * 4);
    const rx = 2 + Math.floor(rand() * (W - rw - 4));
    const ry = 2 + Math.floor(rand() * (H - rh - 4));

    // проверка: не пересекается с уже вырезанным полом, но касается коридора
    let overlaps = false, touchesCorridor = false, doorAt = null;
    for (let j = ry - 1; j <= ry + rh; j++) {
      for (let i = rx - 1; i <= rx + rw; i++) {
        if (j < 1 || i < 1 || j >= H - 1 || i >= W - 1) { overlaps = true; break; }
        const inRoom = i >= rx && i < rx + rw && j >= ry && j < ry + rh;
        if (inRoom && grid[j][i] !== T.VOID) overlaps = true;
      }
      if (overlaps) break;
    }
    if (overlaps) continue;

    // ищем место для двери: клетка коридора, прилегающая к границе комнаты
    const doorCandidates = [];
    for (let i = rx; i < rx + rw; i++) {
      if (ry - 2 >= 0 && grid[ry - 2][i] === T.FLOOR) doorCandidates.push({ x: i, y: ry - 1, side: 'top' });
      if (ry + rh + 1 < H && grid[ry + rh + 1][i] === T.FLOOR) doorCandidates.push({ x: i, y: ry + rh, side: 'bottom' });
    }
    for (let j = ry; j < ry + rh; j++) {
      if (rx - 2 >= 0 && grid[j][rx - 2] === T.FLOOR) doorCandidates.push({ x: rx - 1, y: j, side: 'left' });
      if (rx + rw + 1 < W && grid[j][rx + rw + 1] === T.FLOOR) doorCandidates.push({ x: rx + rw, y: j, side: 'right' });
    }
    if (doorCandidates.length === 0) continue;
    touchesCorridor = true;
    doorAt = doorCandidates[Math.floor(rand() * doorCandidates.length)];
    if (!touchesCorridor) continue;

    const type = roomTypes.pop();
    carve(rx, ry, rw, rh);
    grid[doorAt.y][doorAt.x] = T.FLOOR; // дверной проход
    const room = { x: rx, y: ry, w: rw, h: rh, type, door: doorAt };
    rooms.push(room);
    placedRooms.push(room);
  }

  // --- детское крыло: гарантированная комната в дальнем углу ---
  {
    const cw = 9, ch = 7;
    const corner = rand() < 0.5 ? { x: 3, y: 3 } : { x: W - cw - 3, y: 3 };
    carve(corner.x, corner.y, cw, ch);
    // соединяем с ближайшей веткой коридором
    const bx = branches.reduce((a, b) => Math.abs(b - corner.x) < Math.abs(a - corner.x) ? b : a, branches[0]);
    const cy = corner.y + Math.floor(ch / 2);
    carve(Math.min(corner.x, bx), cy, Math.abs(bx - corner.x) + 2, 2);
    const room = { x: corner.x, y: corner.y, w: cw, h: ch, type: ROOM.CHILDREN };
    rooms.push(room);
    placedRooms.push(room);
  }

  // --- стены вокруг пола ---
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (grid[y][x] !== T.VOID) continue;
      let nearFloor = false;
      for (let dy = -1; dy <= 1 && !nearFloor; dy++)
        for (let dx = -1; dx <= 1 && !nearFloor; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && nx >= 0 && ny < H && nx < W && (grid[ny][nx] === T.FLOOR)) nearFloor = true;
        }
      if (nearFloor) grid[y][x] = T.WALL;
    }
  }

  // --- окна во внешних стенах (для молний) ---
  for (let x = 2; x < W - 2; x++) {
    for (const y of [0, 1, H - 2, H - 1]) {
      if (grid[y] && grid[y][x] === T.WALL && rand() < 0.10) grid[y][x] = T.WINDOW;
    }
  }
  for (let y = 2; y < H - 2; y++) {
    for (const x of [0, 1, W - 2, W - 1]) {
      if (grid[y][x] === T.WALL && rand() < 0.10) grid[y][x] = T.WINDOW;
    }
  }

  // --- разрушенные стены: местами проломы между соседними комнатами ---
  let rubbleCount = 0;
  for (let tries = 0; tries < 300 && rubbleCount < 10; tries++) {
    const x = 2 + Math.floor(rand() * (W - 4));
    const y = 2 + Math.floor(rand() * (H - 4));
    if (grid[y][x] === T.WALL) {
      const horiz = grid[y][x - 1] === T.FLOOR && grid[y][x + 1] === T.FLOOR;
      const vert = grid[y - 1][x] === T.FLOOR && grid[y + 1][x] === T.FLOOR;
      if (horiz || vert) { grid[y][x] = T.RUBBLE; rubbleCount++; }
    }
  }

  // --- расстановка мебели, укрытий и декора по типам комнат ---
  function freeCell(room, margin = 1) {
    // случайная свободная клетка внутри комнаты
    for (let t = 0; t < 30; t++) {
      const x = room.x + margin + Math.floor(rand() * Math.max(1, room.w - margin * 2));
      const y = room.y + margin + Math.floor(rand() * Math.max(1, room.h - margin * 2));
      if (grid[y][x] === T.FLOOR) return { x, y };
    }
    return null;
  }
  const world = (c) => ({ x: (c.x + 0.5) * TILE, y: (c.y + 0.5) * TILE });

  for (const room of placedRooms) {
    const area = room.w * room.h;
    if (room.type === ROOM.WARD) {
      // ржавые кровати вдоль стен + шкаф
      const nBeds = Math.min(4, Math.floor(area / 10));
      for (let i = 0; i < nBeds; i++) {
        const c = freeCell(room); if (!c) continue;
        const p = world(c);
        props.push({ x: p.x, y: p.y, kind: 'bed', r: rand() < 0.5 ? 0 : 1 });
        // под некоторыми кроватями можно прятаться
        if (i < 2) hideSpots.push({ id: hideId++, x: p.x, y: p.y, kind: 'bed' });
      }
      const c = freeCell(room);
      if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'closet', r: 0 }); hideSpots.push({ id: hideId++, x: p.x, y: p.y, kind: 'closet' }); }
    } else if (room.type === ROOM.OPERATING) {
      const cx = (room.x + room.w / 2) * TILE, cy = (room.y + room.h / 2) * TILE;
      props.push({ x: cx, y: cy, kind: 'optable', r: 0 });
      props.push({ x: cx + TILE, y: cy - TILE, kind: 'lamp', r: 0 });
      const c = freeCell(room);
      if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'closet', r: 0 }); hideSpots.push({ id: hideId++, x: p.x, y: p.y, kind: 'closet' }); }
      for (let i = 0; i < 2; i++) { const cc = freeCell(room); if (cc) { const p = world(cc); props.push({ x: p.x, y: p.y, kind: 'tray', r: rand() }); } }
    } else if (room.type === ROOM.BOILER) {
      for (let i = 0; i < 3; i++) { const c = freeCell(room); if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'boiler', r: rand() }); } }
      for (let i = 0; i < 2; i++) { const c = freeCell(room); if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'pipe', r: rand() }); } }
    } else if (room.type === ROOM.MORGUE) {
      for (let i = 0; i < 3; i++) {
        const c = freeCell(room); if (!c) continue;
        const p = world(c);
        props.push({ x: p.x, y: p.y, kind: 'slab', r: 0 });
      }
      const c = freeCell(room);
      if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'fridge', r: 0 }); hideSpots.push({ id: hideId++, x: p.x, y: p.y, kind: 'fridge' }); }
    } else if (room.type === ROOM.CHILDREN) {
      for (let i = 0; i < 5; i++) { const c = freeCell(room); if (c) { const p = world(c); props.push({ x: p.x + (rand() - 0.5) * 20, y: p.y + (rand() - 0.5) * 20, kind: 'toy', r: rand() }); } }
      for (let i = 0; i < 2; i++) {
        const c = freeCell(room); if (!c) continue;
        const p = world(c);
        props.push({ x: p.x, y: p.y, kind: 'crib', r: 0 });
        if (i === 0) hideSpots.push({ id: hideId++, x: p.x, y: p.y, kind: 'bed' });
      }
      const c = freeCell(room);
      if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'closet', r: 0 }); hideSpots.push({ id: hideId++, x: p.x, y: p.y, kind: 'closet' }); }
    } else if (room.type === ROOM.STORAGE) {
      for (let i = 0; i < 2; i++) { const c = freeCell(room); if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'shelf', r: rand() < 0.5 ? 0 : 1 }); } }
      const c = freeCell(room);
      if (c) { const p = world(c); props.push({ x: p.x, y: p.y, kind: 'closet', r: 0 }); hideSpots.push({ id: hideId++, x: p.x, y: p.y, kind: 'closet' }); }
    }
  }

  // --- лужи и битая плитка (декор по всей карте) ---
  for (let i = 0; i < 60; i++) {
    const x = Math.floor(rand() * W), y = Math.floor(rand() * H);
    if (grid[y][x] === T.FLOOR) {
      props.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, kind: rand() < 0.4 ? 'puddle' : 'crack', r: rand() });
    }
  }

  // --- брошенная больничная утварь в коридорах ---
  // инвалидные коляски, каталки, капельницы — стоят у стен
  let junkPlaced = 0;
  for (let tries = 0; tries < 400 && junkPlaced < 12; tries++) {
    const x = 2 + Math.floor(rand() * (W - 4));
    const y = 2 + Math.floor(rand() * (H - 4));
    if (grid[y][x] !== T.FLOOR) continue;
    // только в коридорах (не внутри комнат) и у стены
    const inRoom = rooms.some(r => r.type !== ROOM.CORRIDOR &&
      x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    if (inRoom) continue;
    const nearWall = grid[y - 1][x] === T.WALL || grid[y + 1][x] === T.WALL ||
      grid[y][x - 1] === T.WALL || grid[y][x + 1] === T.WALL;
    if (!nearWall) continue;
    const roll = rand();
    const kind = roll < 0.4 ? 'wheelchair' : roll < 0.7 ? 'gurney' : 'ivstand';
    props.push({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE, kind, r: rand() });
    junkPlaced++;
  }
  // --- подвешенные мешки в морге и операционной ---
  for (const room of placedRooms) {
    if (room.type !== ROOM.MORGUE && room.type !== ROOM.OPERATING) continue;
    for (let i = 0; i < 2; i++) {
      const c = freeCell(room);
      if (c) props.push({ x: (c.x + 0.5) * TILE, y: (c.y + 0.5) * TILE, kind: 'bodybag', r: rand() });
    }
  }

  // --- точки спавна: по разные концы главного коридора ---
  const spawnA = { x: 4.5 * TILE, y: (mainY + 1.5) * TILE };
  const spawnB = { x: (W - 4.5) * TILE, y: (mainY + 1.5) * TILE };

  // детское крыло — для триггера смеха
  const childrenRoom = placedRooms.find(r => r.type === ROOM.CHILDREN);

  return {
    seed, W, H, TILE, grid, rooms, props, hideSpots,
    spawnA, spawnB,
    childrenCenter: childrenRoom
      ? { x: (childrenRoom.x + childrenRoom.w / 2) * TILE, y: (childrenRoom.y + childrenRoom.h / 2) * TILE }
      : spawnA,
  };
}

// Проходимость клетки (для физики на сервере и клиенте)
function isWalkableTile(t) {
  return t === T.FLOOR || t === T.RUBBLE || t === T.DOOR;
}

module.exports = { generateMap, isWalkableTile, T, ROOM, TILE };
