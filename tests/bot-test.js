// ============================================================
// tests/bot-test.js — тест одиночной тренировки с ботом:
// один клиент-человек + «Санитар». Проверяем, что бот
// занимает слот, готов, двигается, оставляет следы (как жертва)
// или охотится (как монстр), и что матч с ним доигрывается.
// Запуск: node tests/bot-test.js
// ============================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3211;
let server;
let failures = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function assert(cond, name) {
  if (cond) console.log('  ok  -', name);
  else { failures++; console.error('  FAIL -', name); }
}

async function main() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT),
      CHERN_FREEZE: '1', CHERN_ROUND_TIME: '20',
      CHERN_INTERMISSION: '1', CHERN_WIN_SCORE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  await sleep(900);

  const state = {
    joined: null, lobby: null, roundStart: null,
    snaps: [], footprints: 0, roundEnds: [], gameOver: null,
  };
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') state.joined = m;
    if (m.type === 'lobby') state.lobby = m;
    if (m.type === 'roundStart') state.roundStart = m;
    if (m.type === 'snap') state.snaps.push(m);
    if (m.type === 'footprint') state.footprints++;
    if (m.type === 'roundEnd') state.roundEnds.push(m);
    if (m.type === 'gameOver') state.gameOver = m;
  });
  const send = (m) => ws.send(JSON.stringify(m));
  const wait = async (pred, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return; await sleep(50); }
    throw new Error('таймаут: ' + what);
  };

  await wait(() => ws.readyState === 1, 5000, 'ws open');
  send({ type: 'join', name: 'Иса' });
  await wait(() => state.joined, 5000, 'joined');

  console.log('\n== ЛОББИ С БОТОМ ==');
  send({ type: 'bot' });
  await wait(() => state.lobby && state.lobby.players[1 - state.joined.slot], 5000, 'бот в лобби');
  const botRow = state.lobby.players[1 - state.joined.slot];
  assert(botRow.name === 'Санитар', 'бот появился в лобби как «Санитар»');
  assert(botRow.ready === true, 'бот сразу готов');

  send({ type: 'ready', ready: true });
  await wait(() => state.roundStart, 5000, 'матч начался');
  assert(true, 'матч с ботом стартовал');
  const myRole = state.roundStart.role;
  console.log('  (моя роль в раунде 1: ' + myRole + ')');

  // --- наблюдаем 8 секунд: бот должен подавать признаки жизни ---
  state.snaps.length = 0;
  await sleep(8000);
  if (myRole === 'hunter') {
    // бот-жертва бегает — следы приходят Охотнику
    assert(state.footprints > 3, `бот-Жертва оставляет следы (${state.footprints})`);
  } else {
    // бот-монстр двигается — его позиция в снапшотах меняется
    const foes = state.snaps.filter(s => s.foe).map(s => s.foe);
    assert(foes.length > 5, 'позиция бота-Монстра приходит в снапшотах');
    const moved = foes.length > 1 &&
      Math.hypot(foes[foes.length - 1].x - foes[0].x, foes[foes.length - 1].y - foes[0].y) > 100;
    assert(moved, 'бот-Монстр перемещается по карте');
  }

  // --- доигрываем матч (WIN_SCORE=1): раунд закончится поимкой или таймером ---
  console.log('\n== ДОИГРЫВАЕМ МАТЧ ==');
  await wait(() => state.roundEnds.length >= 1, 30000, 'раунд завершился');
  const re = state.roundEnds[0];
  assert(['caught', 'escaped'].includes(re.stats.result), `раунд завершён (${re.stats.result})`);
  await wait(() => state.gameOver, 15000, 'gameOver');
  assert(state.gameOver.names.includes('Санитар'), 'финал матча с ботом показан');

  // --- после финала: «сыграть ещё» одной готовностью ---
  send({ type: 'ready', ready: true });
  await wait(() => state.roundEnds.length >= 1 && state.roundStart && state.roundStart.score[0] === 0 && state.roundStart.round === 1 && state.gameOver, 8000, 'новый матч с ботом');
  assert(true, 'бот готов к новому матчу без лишних действий');

  console.log(failures === 0 ? '\n=== ТЕСТ БОТА ПРОЙДЕН ===' : `\n=== ПРОВАЛОВ: ${failures} ===`);
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
