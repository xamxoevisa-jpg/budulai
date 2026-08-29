// ============================================================
// server.js — HTTP + WebSocket сервер «Чернолесья».
// Раздаёт статику из public/ и держит одну игровую комнату
// на двух игроков. Вся симуляция — в game-logic.js.
// ============================================================

'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game, CONST, PHASE } = require('./game-logic');

const PORT = process.env.PORT || 3000;

// Windows-консоль по умолчанию не в UTF-8 — чиним вывод русского текста
if (process.platform === 'win32') {
  try { require('child_process').spawnSync('chcp 65001', { shell: true, stdio: 'ignore' }); } catch {}
}

const app = express();

// список пользовательских скримеров из public/scares
// (кинь туда свои страшные картинки — клиент подхватит сам).
// ВАЖНО: маршрут стоит ДО статики, иначе её редирект на папку победит
app.get('/scares', (req, res) => {
  const dir = path.join(__dirname, '..', 'public', 'scares');
  let files = [];
  try {
    files = require('fs').readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .map(f => '/scares/' + f);
  } catch { /* папки может не быть — это нормально */ }
  res.json(files);
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ------------------------------------------------------------
// Одна комната на двоих. slots[i] = { ws, token, alive }
// token позволяет игроку вернуться в свой слот после разрыва.
// ------------------------------------------------------------
const slots = [null, null];
const RECONNECT_GRACE = 60_000; // сколько держим слот отключившегося, мс
const reconnectTimers = [null, null];

const game = new Game(
  (msg) => { // broadcast обоим
    const data = JSON.stringify(msg);
    for (const s of slots) if (s && s.ws.readyState === 1) s.ws.send(data);
  },
  (slot, msg) => { // адресно
    const s = slots[slot];
    if (s && s.ws.readyState === 1) s.ws.send(JSON.stringify(msg));
  }
);

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Состояние лобби для рассылки
function lobbyState() {
  return {
    type: 'lobby',
    players: game.players.map(p => p ? { name: p.name, ready: p.ready, connected: p.connected } : null),
    phase: game.phase,
  };
}

function broadcastLobby() {
  const data = JSON.stringify(lobbyState());
  for (const s of slots) if (s && s.ws.readyState === 1) s.ws.send(data);
}

wss.on('connection', (ws) => {
  let mySlot = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // --- вход в игру ---
      case 'join': {
        const name = String(msg.name || 'Пациент').slice(0, 16).trim() || 'Пациент';

        // попытка переподключения по токену
        if (msg.token) {
          const idx = slots.findIndex(s => s && s.token === msg.token && !s.alive);
          if (idx >= 0 && game.players[idx]) {
            mySlot = idx;
            slots[idx].ws = ws;
            slots[idx].alive = true;
            if (reconnectTimers[idx]) { clearTimeout(reconnectTimers[idx]); reconnectTimers[idx] = null; }
            game.players[idx].connected = true;
            send(ws, { type: 'joined', slot: idx, token: slots[idx].token, name: game.players[idx].name, reconnected: true });
            // если игра была на паузе и оба на месте — продолжаем
            if (game.phase === PHASE.PAUSED && game.players[0].connected && game.players[1].connected) {
              game.resume();
              game.broadcast({ type: 'resumed' });
              // повторно шлём состояние раунда вернувшемуся
              resendRound(idx);
            } else if (game.phase !== PHASE.LOBBY) {
              resendRound(idx);
            }
            broadcastLobby();
            return;
          }
        }

        // без валидного токена: если есть «мёртвый» слот с тем же именем —
        // это тот же игрок с потерянной сессией, возвращаем его
        const dead = slots.findIndex((s, i) => s && !s.alive && game.players[i] &&
          game.players[i].name === name);
        if (dead >= 0) {
          mySlot = dead;
          slots[dead].ws = ws;
          slots[dead].alive = true;
          slots[dead].token = crypto.randomBytes(12).toString('hex');
          if (reconnectTimers[dead]) { clearTimeout(reconnectTimers[dead]); reconnectTimers[dead] = null; }
          game.players[dead].connected = true;
          send(ws, { type: 'joined', slot: dead, token: slots[dead].token, name, reconnected: true });
          if (game.phase === PHASE.PAUSED && game.players[0].connected && game.players[1].connected) {
            game.resume();
            game.broadcast({ type: 'resumed' });
          }
          if (game.phase !== PHASE.LOBBY) resendRound(dead);
          broadcastLobby();
          return;
        }

        // новый игрок — ищем свободный слот (слот бота свободным не считается)
        let free = slots.findIndex((s, i) => s === null && !game.players[i]);
        if (free === -1 && game.botSlot != null && slots[game.botSlot] === null &&
          (game.phase === PHASE.LOBBY || game.phase === PHASE.GAMEOVER)) {
          // в лобби живой игрок вытесняет бота-«Санитара»
          const botSlot = game.botSlot;
          game.removeBot();
          free = botSlot;
        }
        if (free === -1) {
          send(ws, { type: 'full' });
          ws.close();
          return;
        }
        mySlot = free;
        const token = crypto.randomBytes(12).toString('hex');
        slots[free] = { ws, token, alive: true };
        game.addPlayer(free, name);
        send(ws, { type: 'joined', slot: free, token, name });
        broadcastLobby();
        break;
      }

      // тренировка с ботом: занять свободный слот «Санитаром»
      case 'bot': {
        if (mySlot < 0) return;
        if (game.phase !== PHASE.LOBBY && game.phase !== PHASE.GAMEOVER) return;
        if (game.botSlot != null) return;
        const free = slots.findIndex((s, i) => s === null && !game.players[i]);
        if (free === -1) return; // оба слота заняты людьми
        game.addBot(free);
        broadcastLobby();
        if (game.bothReady()) game.startMatch();
        break;
      }

      case 'ready': {
        if (mySlot < 0 || !game.players[mySlot]) return;
        game.players[mySlot].ready = !!msg.ready;
        broadcastLobby();
        if (game.bothReady() && (game.phase === PHASE.LOBBY || game.phase === PHASE.GAMEOVER)) {
          game.startMatch();
        }
        break;
      }

      case 'input':
        if (mySlot >= 0) game.handleInput(mySlot, msg);
        break;

      case 'interact':
        if (mySlot >= 0) game.handleInteract(mySlot);
        break;

      // пинг-понг на прикладном уровне: клиент шлёт свой timestamp
      case 'ping': {
        send(ws, { type: 'pong', ct: msg.ct });
        if (mySlot >= 0 && game.players[mySlot] && typeof msg.rtt === 'number') {
          game.players[mySlot].ping = Math.min(1000, Math.max(0, msg.rtt));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (mySlot < 0 || !slots[mySlot]) return;
    slots[mySlot].alive = false;
    const slot = mySlot;

    if (game.phase === PHASE.LOBBY || game.phase === PHASE.GAMEOVER) {
      // в лобби просто освобождаем слот
      slots[slot] = null;
      game.players[slot] = null;
      // остался только бот — распускаем и его
      if (!slots.some(s => s)) game.reset();
      broadcastLobby();
      return;
    }

    // во время игры — пауза и ожидание переподключения
    game.removePlayer(slot);
    game.broadcast({ type: 'peerLost', slot });
    broadcastLobby();
    reconnectTimers[slot] = setTimeout(() => {
      // не вернулся — сбрасываем матч в лобби
      slots[slot] = null;
      game.reset();
      // второй игрок (если есть) возвращается в лобби
      for (let i = 0; i < 2; i++) {
        if (slots[i] && slots[i].alive) {
          // пересоздаём его запись в лобби
          const oldName = slots[i].nameCache || 'Пациент';
          game.addPlayer(i, oldName);
          send(slots[i].ws, { type: 'matchAborted' });
        }
      }
      broadcastLobby();
    }, RECONNECT_GRACE);
  });

  ws.on('error', () => { /* закрытие обработает close */ });
});

// кэшируем имена, чтобы восстановить лобби после сброса матча
setInterval(() => {
  for (let i = 0; i < 2; i++) {
    if (slots[i] && game.players[i]) slots[i].nameCache = game.players[i].name;
  }
}, 2000);

// повторная отправка состояния текущего раунда (для вернувшихся)
function resendRound(slot) {
  if (!game.map) return;
  game.sendTo(slot, {
    type: 'roundStart',
    round: game.round,
    role: slot === game.hunterSlot ? 'hunter' : 'survivor',
    score: game.score,
    freeze: game.phase === PHASE.FREEZE ? game.phaseTimer : 0,
    roundTime: CONST.ROUND_TIME,
    resumed: true,
    map: {
      seed: game.map.seed, W: game.map.W, H: game.map.H, TILE: 48,
      grid: game.map.grid, rooms: game.map.rooms,
      props: game.map.props, hideSpots: game.map.hideSpots,
      childrenCenter: game.map.childrenCenter,
    },
    names: [game.players[0].name, game.players[1].name],
    hunterSlot: game.hunterSlot,
    const: {
      staminaMax: CONST.STAMINA_MAX,
      footprintTTL: CONST.FOOTPRINT_TTL,
      interactRadius: CONST.INTERACT_RADIUS,
    },
  });
}

// ------------------------------------------------------------
// Циклы: симуляция и рассылка снапшотов
// ------------------------------------------------------------
const TICK_MS = 1000 / CONST.TICK_RATE;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000); // защита от больших скачков
  last = now;
  game.tick(dt);
}, TICK_MS);

setInterval(() => {
  if (game.phase !== PHASE.FREEZE && game.phase !== PHASE.PLAY) return;
  for (let s = 0; s < 2; s++) {
    const snap = game.buildSnapshot(s);
    if (snap) game.sendTo(s, snap);
  }
}, 1000 / CONST.SNAPSHOT_RATE);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ПОЙМАЙ БУДУЛАЯ — сервер запущен');
  console.log(`  Локально:  http://localhost:${PORT}`);
  console.log('');
});
