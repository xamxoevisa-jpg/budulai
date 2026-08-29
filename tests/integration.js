// ============================================================
// tests/integration.js — интеграционный тест сервера:
// два WebSocket-клиента играют настоящий матч.
// Проверяется: лобби, роли, следы (только Охотнику), погоня и
// поимка, укрытие (спрятаться + поимка при проверке укрытия),
// побег по таймеру, смена ролей, счёт, финал, переподключение.
// Запуск: node tests/integration.js
// ============================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3210;
let server;
let failures = 0;

function assert(cond, name) {
  if (cond) console.log('  ok  -', name);
  else { failures++; console.error('  FAIL -', name); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- обёртка клиента ---
class Client {
  constructor(name) {
    this.name = name;
    this.ws = new WebSocket(`ws://localhost:${PORT}`);
    this.inbox = [];
    this.snap = null;
    this.roundStart = null;       // последний roundStart
    this.roundEnds = [];          // все roundEnd (не затираются)
    this.footprints = 0;
    this.gotHide = null;
    this.gameOver = null;
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      this.inbox.push(m);
      if (m.type === 'snap') { this.snap = m; if (m.foe) this.sawFoe = true; }
      if (m.type === 'roundStart') { this.roundStart = m; this.snap = null; }
      if (m.type === 'footprint') this.footprints++;
      if (m.type === 'hide') this.gotHide = m;
      if (m.type === 'roundEnd') this.roundEnds.push(m);
      if (m.type === 'gameOver') this.gameOver = m;
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async wait(pred, timeoutMs = 15000, what = 'условие') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (pred(this)) return true;
      await sleep(40);
    }
    throw new Error(`таймаут ожидания: ${what} (${this.name})`);
  }
}

// --- поиск пути по карте (BFS) ---
function bfsPath(map, from, to) {
  const key = (x, y) => x + ',' + y;
  const walk = (x, y) => x >= 0 && y >= 0 && x < map.W && y < map.H &&
    [1, 3, 5].includes(map.grid[y][x]);
  const prev = new Map([[key(from[0], from[1]), null]]);
  const q = [from];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === to[0] && y === to[1]) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!walk(nx, ny) || prev.has(key(nx, ny))) continue;
      prev.set(key(nx, ny), [x, y]);
      q.push([nx, ny]);
    }
  }
  if (!prev.has(key(to[0], to[1]))) return null;
  const path = [];
  let cur = to;
  while (cur) { path.unshift(cur); cur = prev.get(key(cur[0], cur[1])); }
  return path;
}

// вести игрока к цели; выходит при достижении или срабатывании until()
async function walkTo(client, targetWorld, { timeout = 60000, until = null } = {}) {
  const map = client.roundStart.map;
  const T = map.TILE;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (until && until(client)) { client.send({ type: 'input', dx: 0, dy: 0, sprint: false, angle: 0 }); return 'until'; }
    if (!client.snap) { await sleep(40); continue; }
    const me = client.snap.you;
    const dist = Math.hypot(me.x - targetWorld.x, me.y - targetWorld.y);
    if (dist < 26) { client.send({ type: 'input', dx: 0, dy: 0, sprint: false, angle: 0 }); return 'arrived'; }
    const from = [Math.floor(me.x / T), Math.floor(me.y / T)];
    const to = [Math.floor(targetWorld.x / T), Math.floor(targetWorld.y / T)];
    const path = bfsPath(map, from, to);
    let tx = targetWorld.x, ty = targetWorld.y;
    if (path && path.length > 1) {
      const nxt = path[Math.min(2, path.length - 1)];
      tx = (nxt[0] + 0.5) * T; ty = (nxt[1] + 0.5) * T;
    }
    const dx = tx - me.x, dy = ty - me.y;
    const len = Math.hypot(dx, dy) || 1;
    client.send({ type: 'input', dx: dx / len, dy: dy / len, sprint: true, angle: 0 });
    await sleep(66);
  }
  throw new Error(`walkTo: не дошёл за отведённое время (${client.name})`);
}

async function main() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT),
      CHERN_FREEZE: '1',
      CHERN_ROUND_TIME: '25',
      CHERN_INTERMISSION: '1',
      CHERN_WIN_SCORE: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  server.stderr.on('data', d => process.stderr.write('  [srv!] ' + d));
  await sleep(900);

  console.log('\n== ЛОББИ ==');
  const A = new Client('Иса');
  const B = new Client('Алина');
  await A.wait(c => c.ws.readyState === 1, 5000, 'ws open A');
  await B.wait(c => c.ws.readyState === 1, 5000, 'ws open B');
  A.send({ type: 'join', name: 'Иса' });
  B.send({ type: 'join', name: 'Алина' });
  await A.wait(c => c.inbox.some(m => m.type === 'joined'), 5000, 'joined A');
  await B.wait(c => c.inbox.some(m => m.type === 'joined'), 5000, 'joined B');
  assert(A.inbox.find(m => m.type === 'joined').slot === 0, 'Иса получил слот 0');
  const lobbyB = B.inbox.filter(m => m.type === 'lobby').pop();
  assert(lobbyB && lobbyB.players[0] && lobbyB.players[0].name === 'Иса', 'лобби видит обоих');

  A.send({ type: 'ready', ready: true });
  B.send({ type: 'ready', ready: true });
  await A.wait(c => c.roundStart, 5000, 'roundStart A');
  await B.wait(c => c.roundStart, 5000, 'roundStart B');
  assert(A.roundStart.role !== B.roundStart.role, 'роли разные');
  assert(A.roundStart.map && A.roundStart.map.grid.length === A.roundStart.map.H, 'карта пришла');
  assert(A.roundStart.map.hideSpots.length >= 4, 'есть укрытия');

  let hunter = A.roundStart.role === 'hunter' ? A : B;
  let survivor = hunter === A ? B : A;
  const r1HunterSlot = A.roundStart.hunterSlot;

  console.log('\n== РАУНД 1: погоня и поимка ==');
  await survivor.wait(c => c.snap, 5000, 'первый снапшот');
  await hunter.wait(c => c.snap, 5000, 'первый снапшот охотника');
  assert(survivor.snap.foe && typeof survivor.snap.foe.x === 'number', 'Выживший видит позицию Монстра');
  assert(!hunter.snap.foe, 'Монстр не видит Выжившего через всю карту');

  const sx0 = survivor.snap.you.x;
  survivor.send({ type: 'input', dx: -1, dy: 0, sprint: false, angle: Math.PI });
  await sleep(2000);
  survivor.send({ type: 'input', dx: 0, dy: 0, sprint: false, angle: 0 });
  assert(hunter.footprints > 2, `Охотник получил следы (${hunter.footprints})`);
  assert(survivor.footprints === 0, 'Выживший следов не получает');
  assert(survivor.snap.you.x !== sx0, 'Выживший переместился');

  // Охотник идёт к жертве; walkTo прервётся, как только раунд кончится
  await walkTo(hunter, { x: survivor.snap.you.x, y: survivor.snap.you.y },
    { until: c => c.roundEnds.length >= 1 });
  await hunter.wait(c => c.roundEnds.length >= 1, 8000, 'поимка');
  assert(hunter.sawFoe, 'Монстр УВИДЕЛ Выжившего вблизи (прямая видимость)');
  const re1 = hunter.roundEnds[0];
  assert(re1.stats.result === 'caught', 'раунд закончился поимкой');
  assert(re1.stats.how === 'chase', 'поимка в погоне');
  assert(re1.stats.score[r1HunterSlot] === 1, 'очко Монстру');

  console.log('\n== РАУНД 2: укрытие ==');
  await A.wait(c => c.roundStart && c.roundStart.round === 2, 10000, 'раунд 2 A');
  await B.wait(c => c.roundStart && c.roundStart.round === 2, 10000, 'раунд 2 B');
  assert(A.roundStart.hunterSlot === 1 - r1HunterSlot, 'роли сменились');
  hunter = A.roundStart.role === 'hunter' ? A : B;
  survivor = hunter === A ? B : A;

  await survivor.wait(c => c.snap, 5000, 'снапшот р2');
  await hunter.wait(c => c.snap, 5000, 'снапшот охотника р2');
  const spots = survivor.roundStart.map.hideSpots;
  const you = survivor.snap.you;
  const spot = spots.reduce((a, b) =>
    Math.hypot(b.x - you.x, b.y - you.y) < Math.hypot(a.x - you.x, a.y - you.y) ? b : a);
  await walkTo(survivor, spot);
  survivor.send({ type: 'interact' });
  await survivor.wait(c => c.gotHide && c.gotHide.state === true, 3000, 'спрятался');
  await survivor.wait(c => c.snap && c.snap.you.hid >= 0, 3000, 'снапшот показывает укрытие');
  assert(true, 'Выживший спрятался в укрытии');

  const fpBefore = hunter.footprints;
  await sleep(1200);
  assert(hunter.footprints === fpBefore, 'в укрытии следов нет');

  await walkTo(hunter, spot, { until: c => c.roundEnds.length >= 2 });
  hunter.send({ type: 'interact' });
  await hunter.wait(c => c.roundEnds.length >= 2, 4000, 'поимка в укрытии');
  const re2 = hunter.roundEnds[1];
  assert(re2.stats.how === 'hideout', 'поимка типа «найден в укрытии»');
  assert(re2.stats.score[0] === 1 && re2.stats.score[1] === 1, 'счёт 1:1');

  console.log('\n== РАУНД 3: побег по таймеру и конец матча ==');
  await A.wait(c => c.roundStart && c.roundStart.round === 3, 10000, 'раунд 3');
  // никто не двигается — Выживший должен дожить до конца (25 с)
  await A.wait(c => c.roundEnds.length >= 3, 40000, 'таймер раунда истёк');
  const re3 = A.roundEnds[2];
  assert(re3.stats.result === 'escaped', 'Выживший сбежал по таймеру');
  const r3SurvSlot = 1 - re3.stats.hunterSlot;
  assert(re3.stats.score[r3SurvSlot] === 2, 'очко Выжившему, счёт 2');
  assert(re3.stats.matchOver === true, 'матч окончен');
  await A.wait(c => c.gameOver, 8000, 'gameOver');
  assert(A.gameOver.winner === r3SurvSlot, 'победитель верный');

  console.log('\n== ПЕРЕПОДКЛЮЧЕНИЕ ==');
  A.send({ type: 'ready', ready: true });
  B.send({ type: 'ready', ready: true });
  await A.wait(c => c.roundStart && c.roundStart.score[0] === 0 && c.roundStart.round === 1, 8000, 'новый матч');
  await B.wait(c => c.roundStart && c.roundStart.round === 1 && c.roundStart.score[0] === 0, 8000, 'новый матч B');
  const tokenB = B.inbox.find(m => m.type === 'joined').token;
  B.ws.close();
  await A.wait(c => c.inbox.some(m => m.type === 'peerLost'), 5000, 'peerLost у A');
  const B2 = new Client('Алина');
  await B2.wait(c => c.ws.readyState === 1, 5000, 'ws open B2');
  B2.send({ type: 'join', name: 'Алина', token: tokenB });
  await B2.wait(c => c.inbox.some(m => m.type === 'joined' && m.reconnected), 5000, 'reconnected');
  await A.wait(c => c.inbox.some(m => m.type === 'resumed'), 5000, 'resumed у A');
  await B2.wait(c => c.roundStart, 5000, 'roundStart после реконнекта');
  assert(B2.roundStart.round >= 1, 'вернулся в текущий раунд');
  assert(B2.roundStart.names.includes('Иса') && B2.roundStart.names.includes('Алина'), 'имена сохранены');

  console.log(failures === 0 ? '\n=== ВСЕ ТЕСТЫ ПРОЙДЕНЫ ===' : `\n=== ПРОВАЛОВ: ${failures} ===`);
  cleanup(failures === 0 ? 0 : 1);
}

function cleanup(code) {
  try { server.kill(); } catch {}
  setTimeout(() => process.exit(code), 300);
}

main().catch((e) => {
  console.error('\nОШИБКА ТЕСТА:', e.message);
  cleanup(1);
});
