// ============================================================
// tests/bot-slot-test.js — вытеснение бота живым игроком:
// в лобби человек занимает слот «Санитара», в матче — получает
// «переполнено» и не ломает чужую тренировку.
// Запуск: node tests/bot-slot-test.js
// ============================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3213;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function assert(cond, name) {
  if (cond) console.log('  ok  -', name);
  else { failures++; console.error('  FAIL -', name); }
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CHERN_FREEZE: '1', CHERN_ROUND_TIME: '30' },
    stdio: 'ignore',
  });
  await sleep(900);

  // A заходит и зовёт бота
  const A = new WebSocket(`ws://localhost:${PORT}`);
  let aLobby = null, aRound = null;
  A.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'lobby') aLobby = m;
    if (m.type === 'roundStart') aRound = m;
  });
  await new Promise(r => A.on('open', r));
  A.send(JSON.stringify({ type: 'join', name: 'Иса' }));
  await sleep(300);
  A.send(JSON.stringify({ type: 'bot' }));
  await sleep(300);
  assert(aLobby && aLobby.players.some(p => p && p.name === 'Санитар'), 'бот занял слот в лобби');

  // B заходит в лобби — должен вытеснить бота
  const B = new WebSocket(`ws://localhost:${PORT}`);
  let bJoined = null;
  B.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') bJoined = m;
  });
  await new Promise(r => B.on('open', r));
  B.send(JSON.stringify({ type: 'join', name: 'Алина' }));
  await sleep(400);
  assert(bJoined, 'живой игрок вошёл вместо бота');
  assert(aLobby.players.some(p => p && p.name === 'Алина') &&
    !aLobby.players.some(p => p && p.name === 'Санитар'), 'в лобби Алина, бота нет');

  // B уходит, A снова зовёт бота и стартует матч
  B.close();
  await sleep(500);
  A.send(JSON.stringify({ type: 'bot' }));
  await sleep(300);
  A.send(JSON.stringify({ type: 'ready', ready: true }));
  await sleep(700);
  assert(aRound, 'матч с ботом стартовал');

  // C пытается войти во время матча — должен быть отклонён
  const C = new WebSocket(`ws://localhost:${PORT}`);
  let cFull = false, cJoined = false;
  C.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'full') cFull = true;
    if (m.type === 'joined') cJoined = true;
  });
  await new Promise(r => C.on('open', r));
  C.send(JSON.stringify({ type: 'join', name: 'Гость' }));
  await sleep(400);
  assert(cFull && !cJoined, 'гость не может влезть в чужой матч с ботом');

  console.log(failures === 0 ? '\n=== ТЕСТ СЛОТОВ БОТА ПРОЙДЕН ===' : `\n=== ПРОВАЛОВ: ${failures} ===`);
  srv.kill();
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}

main().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });
