// ============================================================
// game-logic.js — авторитарная игровая логика «Чернолесья».
// Сервер считает физику, укрытия, поимку, раунды и счёт.
// Клиенты присылают только ввод (направление, спринт, угол фонаря)
// и запросы взаимодействия.
// ============================================================

'use strict';

const { generateMap, isWalkableTile, TILE } = require('./map');
const Bot = require('./bot');

// --- константы баланса ---
const CONST = {
  TICK_RATE: 30,             // тиков симуляции в секунду
  SNAPSHOT_RATE: 15,         // снапшотов в секунду
  PLAYER_RADIUS: 14,         // радиус коллизии игрока, px
  SURVIVOR_SPEED: 150,       // базовая скорость Выжившего, px/с
  SURVIVOR_SPRINT: 225,      // скорость спринта
  HUNTER_SPEED: 172,         // скорость Монстра (чуть выше базовой жертвы)
  RUBBLE_SLOW: 0.55,         // замедление на обломках
  STAMINA_MAX: 100,
  STAMINA_DRAIN: 26,         // расход выносливости в секунду
  STAMINA_REGEN: 16,         // восстановление в секунду
  STAMINA_REGEN_DELAY: 1.2,  // задержка перед восстановлением, с
  CATCH_RADIUS: 30,          // дистанция поимки, px
  HUNTER_SIGHT: 430,         // как далеко Монстр видит Жертву глазами, px
                             // (сквозь стены не видит — проверяется луч)
  // env-переопределения — только для автотестов
  ROUND_TIME: +process.env.CHERN_ROUND_TIME || 180, // длительность раунда, с
  FREEZE_TIME: process.env.CHERN_FREEZE != null ? +process.env.CHERN_FREEZE : 10, // заморозка Монстра, с
  WIN_SCORE: +process.env.CHERN_WIN_SCORE || 5,     // очков до победы в матче
  FOOTPRINT_INTERVAL: 0.33,  // интервал следов при движении, с
  FOOTPRINT_TTL: 5.0,        // время жизни следа, с
  INTERACT_RADIUS: 52,       // радиус взаимодействия с укрытиями, px
  HISTORY_MS: 400,           // сколько истории позиций хранить для лаг-компенсации
  INTERMISSION: process.env.CHERN_INTERMISSION != null ? +process.env.CHERN_INTERMISSION : 7, // пауза между раундами, с
};

// Состояния матча
const PHASE = {
  LOBBY: 'lobby',
  FREEZE: 'freeze',          // отсчёт, Монстр заморожен
  PLAY: 'play',
  INTERMISSION: 'intermission', // экран результатов раунда
  GAMEOVER: 'gameover',
  PAUSED: 'paused',          // один из игроков отключился
};

class Game {
  constructor(broadcast, sendTo) {
    this.broadcast = broadcast; // (msg) => void — отправить обоим
    this.sendTo = sendTo;       // (slot, msg) => void — отправить одному
    this.reset();
  }

  reset() {
    this.phase = PHASE.LOBBY;
    this.map = null;
    this.round = 0;
    this.score = [0, 0];        // [очки игрока 0, очки игрока 1]
    this.hunterSlot = 0;        // кто сейчас Монстр (индекс слота)
    this.roundTimer = 0;
    this.phaseTimer = 0;
    this.pausedFrom = null;     // фаза до паузы
    this.players = [null, null]; // {name, ready, x, y, angle, vx, vy, stamina, hiddenIn, input, history, lastFootprint, ping}
    this.footprints = [];       // {id,x,y,t}  t — серверное время создания
    this.fpId = 0;
    this.now = 0;               // серверное игровое время, с
    this.roundStats = null;
    this.botSlot = null;        // слот бота-«Санитара» (null — бота нет)
    this.botState = null;
  }

  // --- бот для одиночной тренировки ---
  addBot(slot) {
    this.addPlayer(slot, 'Санитар');
    this.players[slot].ready = true;
    this.botSlot = slot;
    this.botState = Bot.freshState();
  }

  removeBot() {
    if (this.botSlot == null) return;
    this.players[this.botSlot] = null;
    this.botSlot = null;
    this.botState = null;
  }

  // --- лобби ---
  addPlayer(slot, name) {
    this.players[slot] = {
      name, ready: false, connected: true,
      x: 0, y: 0, angle: 0, moving: false,
      stamina: CONST.STAMINA_MAX, staminaWait: 0,
      hiddenIn: -1,             // id укрытия или -1
      input: { dx: 0, dy: 0, sprint: false, angle: 0 },
      history: [],              // [{t,x,y}] для лаг-компенсации
      lastFootprint: 0,
      ping: 0,
      distanceWalked: 0,
      hideCount: 0,
    };
  }

  removePlayer(slot) {
    if (this.players[slot]) this.players[slot].connected = false;
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.GAMEOVER) {
      this.pause();
    } else {
      this.players[slot] = null;
    }
  }

  // возвращение игрока после разрыва
  reconnectPlayer(slot) {
    const p = this.players[slot];
    if (!p) return false;
    p.connected = false; // будет включён сервером после handshake
    return true;
  }

  pause() {
    if (this.phase === PHASE.PAUSED) return;
    this.pausedFrom = this.phase;
    this.phase = PHASE.PAUSED;
  }

  resume() {
    if (this.phase !== PHASE.PAUSED) return;
    this.phase = this.pausedFrom || PHASE.LOBBY;
    this.pausedFrom = null;
  }

  bothReady() {
    return this.players[0] && this.players[1] &&
      this.players[0].ready && this.players[1].ready &&
      this.players[0].connected && this.players[1].connected;
  }

  // --- старт матча / раунда ---
  startMatch() {
    this.score = [0, 0];
    this.round = 0;
    this.hunterSlot = Math.random() < 0.5 ? 0 : 1;
    this.startRound();
  }

  startRound() {
    this.round++;
    this.map = generateMap((Date.now() ^ (this.round * 7919)) >>> 0);
    this.footprints = [];
    if (this.botSlot != null) this.botState = Bot.freshState(); // новая карта — новые планы

    this.phase = PHASE.FREEZE;
    this.phaseTimer = CONST.FREEZE_TIME;
    this.roundTimer = CONST.ROUND_TIME;

    const hunter = this.players[this.hunterSlot];
    const survivor = this.players[1 - this.hunterSlot];
    // Монстр спавнится в точке A, Выживший — в точке B (разные концы карты)
    hunter.x = this.map.spawnA.x; hunter.y = this.map.spawnA.y;
    survivor.x = this.map.spawnB.x; survivor.y = this.map.spawnB.y;
    for (const p of this.players) {
      p.stamina = CONST.STAMINA_MAX;
      p.staminaWait = 0;
      p.hiddenIn = -1;
      p.history = [];
      p.distanceWalked = 0;
      p.hideCount = 0;
      p.angle = 0;
    }

    // рассылаем полное состояние раунда (карта + роли)
    for (let s = 0; s < 2; s++) {
      this.sendTo(s, {
        type: 'roundStart',
        round: this.round,
        role: s === this.hunterSlot ? 'hunter' : 'survivor',
        score: this.score,
        freeze: CONST.FREEZE_TIME,
        roundTime: CONST.ROUND_TIME,
        map: {
          seed: this.map.seed, W: this.map.W, H: this.map.H, TILE,
          grid: this.map.grid, rooms: this.map.rooms,
          props: this.map.props, hideSpots: this.map.hideSpots,
          childrenCenter: this.map.childrenCenter,
        },
        names: [this.players[0].name, this.players[1].name],
        hunterSlot: this.hunterSlot,
        const: {
          staminaMax: CONST.STAMINA_MAX,
          footprintTTL: CONST.FOOTPRINT_TTL,
          interactRadius: CONST.INTERACT_RADIUS,
        },
      });
    }
  }

  // --- обработка ввода ---
  handleInput(slot, msg) {
    const p = this.players[slot];
    if (!p) return;
    // нормализуем вектор ввода (защита от читерского ускорения)
    let dx = +msg.dx || 0, dy = +msg.dy || 0;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    p.input.dx = dx;
    p.input.dy = dy;
    p.input.sprint = !!msg.sprint;
    if (typeof msg.angle === 'number' && isFinite(msg.angle)) p.input.angle = msg.angle;
  }

  handleInteract(slot) {
    if (this.phase !== PHASE.PLAY && this.phase !== PHASE.FREEZE) return;
    const p = this.players[slot];
    if (!p || !this.map) return;
    const isHunter = slot === this.hunterSlot;

    if (!isHunter) {
      // Выживший: спрятаться / вылезти
      if (p.hiddenIn >= 0) {
        p.hiddenIn = -1;
        this.sendTo(slot, { type: 'hide', state: false });
        return;
      }
      const spot = this.nearestSpot(p);
      if (spot) {
        p.hiddenIn = spot.id;
        p.x = spot.x; p.y = spot.y;
        p.hideCount++;
        this.sendTo(slot, { type: 'hide', state: true, kind: spot.kind });
      }
    } else {
      // Монстр: проверить укрытие. Если жертва внутри — мгновенная поимка
      if (this.phase !== PHASE.PLAY) return; // в заморозке нельзя
      const spot = this.nearestSpot(p);
      if (!spot) return;
      const survivor = this.players[1 - this.hunterSlot];
      if (survivor.hiddenIn === spot.id) {
        this.catchSurvivor('hideout');
      } else {
        // пусто — шум для атмосферы обоим
        this.broadcast({ type: 'spotChecked', x: spot.x, y: spot.y, kind: spot.kind });
      }
    }
  }

  nearestSpot(p) {
    let best = null, bd = CONST.INTERACT_RADIUS;
    for (const s of this.map.hideSpots) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // --- физика ---
  movePlayer(p, speed, dt) {
    const dx = p.input.dx * speed * dt;
    const dy = p.input.dy * speed * dt;
    p.moving = (p.input.dx !== 0 || p.input.dy !== 0);
    // раздельное разрешение по осям — скольжение вдоль стен
    const nx = dx !== 0 ? this.resolveAxis(p.x, p.y, dx, 0) : p.x;
    const ny = dy !== 0 ? this.resolveAxis(nx, p.y, 0, dy) : p.y;
    const moved = Math.hypot(nx - p.x, ny - p.y);
    p.distanceWalked += moved;
    p.x = nx; p.y = ny;
    // угол фонаря/взгляда присылает клиент (мышь либо направление движения)
    p.angle = p.input.angle;
  }

  // Разрешение движения по одной оси: если новая позиция упирается в стену —
  // остаёмся на месте по этой оси. Возвращает новую координату сдвигаемой оси.
  resolveAxis(x, y, dx, dy) {
    const r = CONST.PLAYER_RADIUS;
    const nx = x + dx, ny = y + dy;
    const checks = [[-r, 0], [r, 0], [0, -r], [0, r],
      [-r * 0.7, -r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, r * 0.7]];
    for (const [ox, oy] of checks) {
      const tx = Math.floor((nx + ox) / TILE);
      const ty = Math.floor((ny + oy) / TILE);
      if (!this.walkable(tx, ty)) {
        return dx !== 0 ? x : y; // столкновение — откат по этой оси
      }
    }
    return dx !== 0 ? nx : ny;
  }

  // Есть ли прямая видимость между точками? Шагаем по лучу и смотрим,
  // не упёрлись ли в стену. Так Монстр «видит глазами», а не сквозь стены.
  hasLineOfSight(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const steps = Math.ceil(dist / (TILE * 0.35));
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      const tx = Math.floor((x0 + dx * k) / TILE);
      const ty = Math.floor((y0 + dy * k) / TILE);
      if (!this.walkable(tx, ty)) return false;
    }
    return true;
  }

  walkable(tx, ty) {
    if (!this.map) return false;
    if (tx < 0 || ty < 0 || tx >= this.map.W || ty >= this.map.H) return false;
    return isWalkableTile(this.map.grid[ty][tx]);
  }

  tileAt(x, y) {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.map.W || ty >= this.map.H) return 0;
    return this.map.grid[ty][tx];
  }

  // --- главный тик ---
  tick(dt) {
    this.now += dt;
    if (this.phase === PHASE.PAUSED || this.phase === PHASE.LOBBY || this.phase === PHASE.GAMEOVER) return;

    if (this.phase === PHASE.INTERMISSION) {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        if (this.score[0] >= CONST.WIN_SCORE || this.score[1] >= CONST.WIN_SCORE) {
          this.phase = PHASE.GAMEOVER;
          this.broadcast({
            type: 'gameOver',
            score: this.score,
            winner: this.score[0] >= CONST.WIN_SCORE ? 0 : 1,
            names: [this.players[0].name, this.players[1].name],
          });
          // сбрасываем готовность для новой партии (бот всегда готов)
          this.players.forEach((p, i) => { if (p) p.ready = (i === this.botSlot); });
        } else {
          this.hunterSlot = 1 - this.hunterSlot; // смена ролей
          this.startRound();
        }
      }
      return;
    }

    const hunter = this.players[this.hunterSlot];
    const survivor = this.players[1 - this.hunterSlot];
    if (!hunter || !survivor) return;

    // заморозка Монстра в начале раунда
    let hunterFrozen = false;
    if (this.phase === PHASE.FREEZE) {
      this.phaseTimer -= dt;
      hunterFrozen = true;
      if (this.phaseTimer <= 0) {
        this.phase = PHASE.PLAY;
        this.broadcast({ type: 'huntBegins' });
      }
    }

    // бот-«Санитар» выставляет свой ввод как обычный игрок
    if (this.botSlot != null) Bot.update(this, dt);

    // --- Выживший ---
    if (survivor.hiddenIn < 0) {
      let speed = CONST.SURVIVOR_SPEED;
      const wantSprint = survivor.input.sprint && survivor.moving !== false &&
        (survivor.input.dx !== 0 || survivor.input.dy !== 0);
      if (wantSprint && survivor.stamina > 0) {
        speed = CONST.SURVIVOR_SPRINT;
        survivor.stamina = Math.max(0, survivor.stamina - CONST.STAMINA_DRAIN * dt);
        survivor.staminaWait = CONST.STAMINA_REGEN_DELAY;
      } else {
        survivor.staminaWait -= dt;
        if (survivor.staminaWait <= 0) {
          survivor.stamina = Math.min(CONST.STAMINA_MAX, survivor.stamina + CONST.STAMINA_REGEN * dt);
        }
      }
      if (this.tileAt(survivor.x, survivor.y) === 5 /* RUBBLE */) speed *= CONST.RUBBLE_SLOW;
      this.movePlayer(survivor, speed, dt);

      // следы: только когда движется и не прячется
      if (survivor.moving && this.now - survivor.lastFootprint > CONST.FOOTPRINT_INTERVAL) {
        survivor.lastFootprint = this.now;
        const fp = { id: this.fpId++, x: survivor.x, y: survivor.y, t: this.now };
        this.footprints.push(fp);
        // след отправляем только Монстру
        this.sendTo(this.hunterSlot, { type: 'footprint', id: fp.id, x: fp.x, y: fp.y });
      }
    } else {
      // в укрытии выносливость восстанавливается
      survivor.stamina = Math.min(CONST.STAMINA_MAX, survivor.stamina + CONST.STAMINA_REGEN * dt);
    }

    // --- Монстр ---
    if (!hunterFrozen) {
      let hspeed = CONST.HUNTER_SPEED;
      if (this.tileAt(hunter.x, hunter.y) === 5) hspeed *= CONST.RUBBLE_SLOW;
      this.movePlayer(hunter, hspeed, dt);
    } else {
      hunter.moving = false;
    }

    // история позиций Выжившего для лаг-компенсации
    survivor.history.push({ t: this.now, x: survivor.x, y: survivor.y, hidden: survivor.hiddenIn >= 0 });
    const cutoff = this.now - CONST.HISTORY_MS / 1000;
    while (survivor.history.length > 2 && survivor.history[0].t < cutoff) survivor.history.shift();

    // чистим протухшие следы
    this.footprints = this.footprints.filter(f => this.now - f.t < CONST.FOOTPRINT_TTL);

    // --- проверка поимки (с лаг-компенсацией) ---
    if (this.phase === PHASE.PLAY && survivor.hiddenIn < 0) {
      // отматываем позицию Выжившего назад на половину RTT Монстра:
      // Монстр видел жертву там, где она была ping/2 назад
      const rewind = Math.min(CONST.HISTORY_MS / 1000, (hunter.ping || 0) / 2000);
      const past = this.sampleHistory(survivor, this.now - rewind);
      const dNow = Math.hypot(hunter.x - survivor.x, hunter.y - survivor.y);
      const dPast = past ? Math.hypot(hunter.x - past.x, hunter.y - past.y) : dNow;
      if (Math.min(dNow, dPast) < CONST.CATCH_RADIUS) {
        this.catchSurvivor('chase');
      }
    }

    // --- таймер раунда ---
    if (this.phase === PHASE.PLAY) {
      this.roundTimer -= dt;
      if (this.roundTimer <= 0) this.survivorEscaped();
    }
  }

  sampleHistory(p, t) {
    const h = p.history;
    if (h.length === 0) return null;
    if (t <= h[0].t) return h[0];
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].t <= t) {
        const a = h[i], b = h[Math.min(i + 1, h.length - 1)];
        const span = b.t - a.t || 1;
        const k = Math.min(1, Math.max(0, (t - a.t) / span));
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
    }
    return h[h.length - 1];
  }

  catchSurvivor(how) {
    this.score[this.hunterSlot]++;
    this.endRound({
      winnerSlot: this.hunterSlot,
      result: 'caught',
      how, // 'chase' | 'hideout'
    });
  }

  survivorEscaped() {
    const survivorSlot = 1 - this.hunterSlot;
    this.score[survivorSlot]++;
    this.endRound({ winnerSlot: survivorSlot, result: 'escaped' });
  }

  endRound(info) {
    const survivor = this.players[1 - this.hunterSlot];
    const hunter = this.players[this.hunterSlot];
    console.log(`[round ${this.round}] end: ${info.result}/${info.how || ''} ` +
      `hunter=(${hunter.x | 0},${hunter.y | 0}) survivor=(${survivor.x | 0},${survivor.y | 0}) ` +
      `timer=${this.roundTimer.toFixed(1)} phase=${this.phase}`);
    this.phase = PHASE.INTERMISSION;
    this.phaseTimer = CONST.INTERMISSION;
    this.roundStats = {
      ...info,
      round: this.round,
      score: this.score.slice(),
      hunterSlot: this.hunterSlot,
      timeLeft: Math.max(0, this.roundTimer),
      distance: Math.round(survivor.distanceWalked / TILE), // «метров» пройдено
      hides: survivor.hideCount,
      names: [this.players[0].name, this.players[1].name],
      matchOver: this.score[0] >= CONST.WIN_SCORE || this.score[1] >= CONST.WIN_SCORE,
    };
    this.broadcast({ type: 'roundEnd', stats: this.roundStats });
  }

  // --- снапшоты: каждому игроку своя картина мира ---
  buildSnapshot(slot) {
    if (!this.map) return null;
    const p = this.players[slot];
    const foe = this.players[1 - slot];
    if (!p || !foe) return null;
    const isHunter = slot === this.hunterSlot;
    const dist = Math.hypot(p.x - foe.x, p.y - foe.y);

    const snap = {
      type: 'snap',
      t: Math.round(this.now * 1000),
      phase: this.phase,
      freeze: this.phase === PHASE.FREEZE ? Math.max(0, this.phaseTimer) : 0,
      timer: Math.max(0, this.roundTimer),
      you: {
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        st: Math.round(p.stamina),
        hid: p.hiddenIn,
      },
    };

    if (isHunter) {
      // Монстр слышит дыхание по близости (0..1), пока жертва не в укрытии
      const hearRange = 260;
      snap.breath = (foe.hiddenIn < 0 && dist < hearRange) ? +(1 - dist / hearRange).toFixed(2) : 0;
      // ...и ВИДИТ её, если она в пределах тёмного зрения и не за стеной.
      // Позицию шлём только в этот момент: за углом клиент её не знает —
      // значит, и читер ничего не выгадает.
      const visible = foe.hiddenIn < 0 && dist < CONST.HUNTER_SIGHT &&
        this.hasLineOfSight(p.x, p.y, foe.x, foe.y);
      if (visible) {
        snap.foe = {
          x: Math.round(foe.x * 10) / 10,
          y: Math.round(foe.y * 10) / 10,
          a: Math.round(foe.angle * 100) / 100,
          mov: foe.moving ? 1 : 0,
        };
      }
    } else {
      // Выживший видит Монстра (в конусе фонаря — решает клиент при отрисовке)
      snap.foe = {
        x: Math.round(foe.x * 10) / 10,
        y: Math.round(foe.y * 10) / 10,
        a: Math.round(foe.angle * 100) / 100,
        mov: foe.moving ? 1 : 0,
      };
      // пульс: 0 (далеко) .. 1 (вплотную)
      const heartRange = 460;
      snap.heart = dist < heartRange ? +(1 - dist / heartRange).toFixed(2) : 0;
      // «он тебя видит» — честная обратная связь: иначе игрок не поймёт,
      // почему Монстр вдруг побежал прямо на него
      snap.seen = (p.hiddenIn < 0 && dist < CONST.HUNTER_SIGHT &&
        this.hasLineOfSight(foe.x, foe.y, p.x, p.y)) ? 1 : 0;
    }
    return snap;
  }
}

module.exports = { Game, CONST, PHASE };
