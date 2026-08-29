// ============================================================
// tests/bot-catch-test.js — проверка, что бот-Монстр реально
// выслеживает по следам и ловит. Матч до 2 очков: в раунде,
// где клиент — Жертва, он оставляет след и встаёт у стены;
// «Санитар» обязан прийти по следам и поймать.
// Запуск: node tests/bot-catch-test.js
// ============================================================

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3212;
let server;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function assert(cond, name) {
  if (cond) console.log('  ok  -', name);
  else { failures++; console.error('  FAIL -', name); }
}

async function main() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT),
      CHERN_FREEZE: '1', CHERN_ROUND_TIME: '45',
      CHERN_INTERMISSION: '1', CHERN_WIN_SCORE: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write('  [srv] ' + d));
  await sleep(900);

  const state = { joined: null, roundStart: null, roundEnds: [], gameOver: null, snap: null };
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') state.joined = m;
    if (m.type === 'roundStart') state.roundStart = m;
    if (m.type === 'roundEnd') state.roundEnds.push(m);
    if (m.type === 'gameOver') state.gameOver = m;
    if (m.type === 'snap') state.snap = m;
  });
  const send = (m) => ws.send(JSON.stringify(m));
  const wait = async (pred, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return; await sleep(60); }
    throw new Error('таймаут: ' + what);
  };

  await wait(() => ws.readyState === 1, 5000, 'ws');
  send({ type: 'join', name: 'Иса' });
  await wait(() => state.joined, 5000, 'joined');
  send({ type: 'bot' });
  send({ type: 'ready', ready: true });
  await wait(() => state.roundStart, 6000, 'старт');

  let survivorRoundChecked = false;
  for (let round = 1; round <= 3 && !state.gameOver; round++) {
    await wait(() => state.roundStart && state.roundStart.round === round, 60000, 'раунд ' + round);
    const role = state.roundStart.role;
    console.log(`\n== РАУНД ${round}: я — ${role} ==`);
    const endsBefore = state.roundEnds.length;

    if (role === 'survivor') {
      // оставить след: идти влево 4 с, затем упереться в стену и стоять
      send({ type: 'input', dx: -1, dy: 0, sprint: false, angle: Math.PI });
      const t0 = Date.now();
      // держим ввод, ждём конца раунда
      while (state.roundEnds.length === endsBefore && Date.now() - t0 < 55000) {
        send({ type: 'input', dx: -1, dy: 0, sprint: false, angle: Math.PI });
        await sleep(300);
      }
      send({ type: 'input', dx: 0, dy: 0, sprint: false, angle: 0 });
      const re = state.roundEnds[state.roundEnds.length - 1];
      assert(state.roundEnds.length > endsBefore, 'раунд завершился');
      assert(re.stats.result === 'caught', `Санитар выследил и поймал (${re.stats.result}/${re.stats.how || ''})`);
      survivorRoundChecked = true;
    } else {
      // я — монстр: стою, жертва-бот должна дожить (escaped)
      await wait(() => state.roundEnds.length > endsBefore, 60000, 'конец раунда ' + round);
      const re = state.roundEnds[state.roundEnds.length - 1];
      assert(re.stats.result === 'escaped', 'бот-Жертва дожила до конца раунда против неподвижного Монстра');
    }
    await sleep(1500); // интермиссия
  }

  assert(survivorRoundChecked, 'сценарий «бот ловит по следам» был проверен');
  console.log(failures === 0 ? '\n=== ТЕСТ ПОИМКИ БОТОМ ПРОЙДЕН ===' : `\n=== ПРОВАЛОВ: ${failures} ===`);
  cleanup(failures === 0 ? 0 : 1);
}

function cleanup(code) {
  try { server.kill(); } catch {}
  setTimeout(() => process.exit(code), 300);
}

main().catch((e) => { console.error('\nОШИБКА ТЕСТА:', e.message); cleanup(1); });
