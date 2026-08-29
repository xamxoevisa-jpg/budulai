// ============================================================
// main.js — сборка всего: состояние игры, сетевые события,
// локальное предсказание своего движения + сглаживание к
// авторитарной позиции сервера, интерполяция/экстраполяция
// позиций соперника, планировщик скримеров, игровой цикл.
// ============================================================

'use strict';

(() => {
  // --- зеркала серверных констант (для предсказания движения) ---
  const SURVIVOR_SPEED = 150, SURVIVOR_SPRINT = 225, HUNTER_SPEED = 172;
  const PLAYER_RADIUS = 14, RUBBLE_SLOW = 0.55;
  const INTERP_DELAY = 120;   // мс — буфер интерполяции соперника
  const MAX_EXTRAP = 200;     // мс — максимум экстраполяции при потере пакетов

  // --- состояние клиента ---
  const G = {
    screen: 'login',       // login | lobby | game
    mySlot: -1,
    names: ['', ''],
    role: null,            // 'hunter' | 'survivor'
    map: null,
    phase: 'lobby',
    freeze: 0,
    timer: 180,
    score: [0, 0],
    heart: 0, breath: 0,
    stamina: 100, staminaMax: 100,
    hidden: false,
    footprintTTL: 5,
    interactRadius: 52,
    me: { x: 0, y: 0, angle: 0, moving: false },
    serverMe: { x: 0, y: 0 },      // последняя авторитарная позиция
    foeBuf: [],                     // буфер снапшотов соперника
    footprints: [],                 // {x,y,born}
    spotFlash: null,
    catchActive: false,
    lastSnapAt: 0,
    idleTime: 0,
    scareTimer: 15 + Math.random() * 15,
    laughCooldown: 0,
    stepTimer: 0,
    ended: false,                   // раунд завершён (ждём интермиссию)
  };

  const canvas = document.getElementById('game');
  Render.init(canvas);
  Input.initTouch();

  // ============ ЗВУК: разблокировка первым касанием (iOS) ============
  let soundHintShown = false;
  function tryUnlock() {
    GameAudio.unlock();
    if (GameAudio.ready) {
      document.getElementById('tapForSound').classList.add('hidden');
      if (G.screen !== 'login') GameAudio.startAmbient();
    }
  }
  for (const ev of ['touchstart', 'mousedown', 'keydown']) {
    document.addEventListener(ev, tryUnlock, { passive: true });
  }

  // ============ ЭКРАН ВХОДА ============
  const nameInput = UI.$('nameInput');
  UI.$('enterBtn').addEventListener('click', doJoin);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  function doJoin() {
    const name = nameInput.value.trim() || 'Пациент';
    UI.$('loginStatus').textContent = 'связь с лечебницей...';
    Network.join(name);
  }

  // ============ ЛОББИ ============
  let myReady = false;
  UI.$('readyBtn').addEventListener('click', () => {
    myReady = !myReady;
    Network.send({ type: 'ready', ready: myReady });
    UI.$('readyBtn').textContent = myReady ? 'ОТМЕНИТЬ ГОТОВНОСТЬ' : 'Я ГОТОВ(А)';
  });

  // тренировка с ботом: «Санитар» занимает второй слот и всегда готов
  UI.$('botBtn').addEventListener('click', () => {
    Network.send({ type: 'bot' });
  });

  // ============ СЕТЕВЫЕ СОБЫТИЯ ============
  Network.on('joined', (msg) => {
    G.mySlot = msg.slot;
    if (G.screen === 'login') {
      G.screen = 'lobby';
      UI.showLobby();
      if (GameAudio.ready) GameAudio.startAmbient();
      else if (!soundHintShown) {
        soundHintShown = true;
        document.getElementById('tapForSound').classList.remove('hidden');
      }
    }
    UI.setDisconnected(false);
  });

  Network.on('full', () => {
    UI.$('loginStatus').textContent = 'лечебница переполнена: уже два пациента внутри';
  });

  Network.on('lobby', (msg) => {
    G.names = msg.players.map(p => p ? p.name : '');
    if (G.screen === 'lobby') UI.renderLobby(msg.players, G.mySlot);
  });

  Network.on('roundStart', (msg) => {
    G.screen = 'game';
    G.role = msg.role;
    G.map = msg.map;
    G.score = msg.score;
    G.names = msg.names;
    G.freeze = msg.freeze;
    G.timer = msg.roundTime;
    G.phase = msg.freeze > 0 ? 'freeze' : 'play';
    G.staminaMax = msg.const.staminaMax;
    G.footprintTTL = msg.const.footprintTTL;
    G.interactRadius = msg.const.interactRadius;
    G.footprints = [];
    G.foeBuf = [];
    G.hidden = false;
    G.catchActive = false;
    G.ended = false;
    G.heart = 0; G.breath = 0;
    myReady = false;
    UI.$('readyBtn').textContent = 'Я ГОТОВ(А)';

    // стартовые позиции: жертва — spawnB, монстр — spawnA (как на сервере)
    const spawn = msg.role === 'hunter' ? { x: 0, y: 0 } : { x: 0, y: 0 };
    // сервер пришлёт точную позицию в первом снапшоте; ставим по центру карты
    G.me.x = G.serverMe.x = (msg.map.W / 2) * msg.map.TILE;
    G.me.y = G.serverMe.y = (msg.map.H / 2) * msg.map.TILE;
    void spawn;

    Render.setMap(msg.map);
    UI.showGame();
    UI.setRole(msg.role);
    // у Монстра нет спринта — прячем кнопку «БЕГ»
    UI.$('btnSprint').style.display = msg.role === 'hunter' ? 'none' : 'flex';
    UI.setScore(msg.names, msg.score, G.mySlot);
    UI.hideRoundEnd();
    Input.showTouchUI();
    if (GameAudio.ready) GameAudio.startAmbient();
  });

  Network.on('snap', (msg) => {
    G.phase = msg.phase;
    G.freeze = msg.freeze;
    G.timer = msg.timer;
    G.lastSnapAt = performance.now();

    // своя авторитарная позиция
    G.serverMe.x = msg.you.x;
    G.serverMe.y = msg.you.y;
    G.stamina = msg.you.st;
    const wasHidden = G.hidden;
    G.hidden = msg.you.hid >= 0;
    if (G.hidden && !wasHidden) { G.me.x = msg.you.x; G.me.y = msg.you.y; }

    // первый снапшот раунда: жёстко ставим позицию и камеру
    if (G.foeBuf.length === 0 && !G._gotFirstSnap) {
      G.me.x = msg.you.x; G.me.y = msg.you.y;
      Render.snapCamera(msg.you.x, msg.you.y);
      G._gotFirstSnap = true;
    }

    if (msg.foe) {
      G.foeBuf.push({ at: performance.now(), x: msg.foe.x, y: msg.foe.y, a: msg.foe.a, mov: msg.foe.mov });
      if (G.foeBuf.length > 30) G.foeBuf.shift();
    }
    G.heart = msg.heart || 0;
    G.breath = msg.breath || 0;
  });

  Network.on('footprint', (msg) => {
    G.footprints.push({ x: msg.x, y: msg.y, born: performance.now() });
  });

  Network.on('hide', (msg) => {
    G.hidden = msg.state;
    if (GameAudio.ready) GameAudio.closetCreak();
  });

  Network.on('spotChecked', (msg) => {
    G.spotFlash = { x: msg.x, y: msg.y, ttl: 1 };
    if (GameAudio.ready) GameAudio.doorSlam();
    Render.trigger('shake', 5);
  });

  Network.on('huntBegins', () => {
    if (GameAudio.ready) GameAudio.sting();
    Render.trigger('glitch');
  });

  Network.on('roundEnd', (msg) => {
    G.ended = true;
    const caught = msg.stats.result === 'caught';
    if (caught) {
      // скример: случайная морда + рёв с визгом, потом протокол раунда
      G.catchActive = true;
      if (GameAudio.ready) { GameAudio.roar(); GameAudio.scream(); }
      Render.trigger('shake', 16);
      Render.trigger('glitch');
      setTimeout(() => {
        G.catchActive = false;
        UI.showRoundEnd(msg.stats, G.mySlot);
      }, 1400);
    } else {
      UI.showRoundEnd(msg.stats, G.mySlot);
    }
    G._gotFirstSnap = false;
    GameAudio.setHeartbeat(0);
    GameAudio.setBreath(0);
    GameAudio.setDread(0);
    UI.setFreeze(0);
  });

  Network.on('gameOver', (msg) => {
    G._gotFirstSnap = false;
    const iWon = msg.winner === G.mySlot;
    setTimeout(() => {
      UI.showGameOver(msg.names[msg.winner], iWon, msg.score, msg.names, () => {
        // «сыграть ещё»: возвращаемся в лобби и готовимся
        G.screen = 'lobby';
        UI.showLobby();
        myReady = true;
        Network.send({ type: 'ready', ready: true });
        UI.$('readyBtn').textContent = 'ОТМЕНИТЬ ГОТОВНОСТЬ';
      });
    }, 1600);
  });

  Network.on('peerLost', () => {
    UI.setDisconnected(true, 'СВЯЗЬ С ПАЦИЕНТОМ ПОТЕРЯНА...');
  });

  Network.on('resumed', () => {
    UI.setDisconnected(false);
  });

  Network.on('matchAborted', () => {
    UI.setDisconnected(false);
    G.screen = 'lobby';
    myReady = false;
    UI.$('readyBtn').textContent = 'Я ГОТОВ(А)';
    UI.showLobby();
  });

  Network.on('_close', () => {
    if (G.screen !== 'login') {
      UI.setDisconnected(true, 'СОЕДИНЕНИЕ ПРЕРВАНО... ПЕРЕПОДКЛЮЧЕНИЕ');
    }
  });

  Network.on('ping', (ms) => UI.setPing(ms));

  // ============ ЛОКАЛЬНАЯ ФИЗИКА (зеркало серверной) ============
  function walkable(tx, ty) {
    const m = G.map;
    if (!m) return false;
    if (tx < 0 || ty < 0 || tx >= m.W || ty >= m.H) return false;
    const t = m.grid[ty][tx];
    return t === 1 || t === 3 || t === 5;
  }

  function resolveAxis(x, y, dx, dy) {
    const r = PLAYER_RADIUS, T = G.map.TILE;
    const nx = x + dx, ny = y + dy;
    const checks = [[-r, 0], [r, 0], [0, -r], [0, r],
      [-r * 0.7, -r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, r * 0.7]];
    for (const [ox, oy] of checks) {
      if (!walkable(Math.floor((nx + ox) / T), Math.floor((ny + oy) / T))) {
        return dx !== 0 ? x : y;
      }
    }
    return dx !== 0 ? nx : ny;
  }

  function tileAtMe() {
    const T = G.map.TILE;
    const tx = Math.floor(G.me.x / T), ty = Math.floor(G.me.y / T);
    if (tx < 0 || ty < 0 || tx >= G.map.W || ty >= G.map.H) return 0;
    return G.map.grid[ty][tx];
  }

  // ============ ПОДСКАЗКА ВЗАИМОДЕЙСТВИЯ ============
  function nearestSpotDist() {
    let best = Infinity;
    if (!G.map) return best;
    for (const s of G.map.hideSpots) {
      const d = Math.hypot(s.x - G.me.x, s.y - G.me.y);
      if (d < best) best = d;
    }
    return best;
  }

  // ============ СКРИМЕРЫ ============
  function updateScares(dt) {
    if (G.phase !== 'play' && G.phase !== 'freeze') return;
    G.laughCooldown -= dt;

    // детский смех при приближении к детскому крылу
    if (G.map && G.laughCooldown <= 0) {
      const cc = G.map.childrenCenter;
      if (Math.hypot(cc.x - G.me.x, cc.y - G.me.y) < 320) {
        if (GameAudio.ready) GameAudio.childLaugh((Math.random() - 0.5) * 1.6);
        G.laughCooldown = 45;
      }
    }

    // шёпот, если стоишь на месте слишком долго
    if (!G.me.moving && !G.hidden) {
      G.idleTime += dt;
      if (G.idleTime > 14) {
        if (GameAudio.ready) GameAudio.whisper();
        Render.trigger('glitch');
        G.idleTime = 0;
      }
    } else G.idleTime = 0;

    // случайные события по таймеру
    G.scareTimer -= dt;
    if (G.scareTimer <= 0) {
      G.scareTimer = 16 + Math.random() * 22;
      const roll = Math.random();
      if (roll < 0.24) {
        Render.trigger('shadow');
        if (GameAudio.ready) GameAudio.sting();
      } else if (roll < 0.42) {
        if (GameAudio.ready) GameAudio.doorSlam();
        Render.trigger('shake', 4);
      } else if (roll < 0.56) {
        Render.trigger('glitch');
        if (GameAudio.ready) GameAudio.swell();
      } else if (roll < 0.72) {
        Render.trigger('rat');
        if (GameAudio.ready) GameAudio.ratSqueak((Math.random() - 0.5) * 1.6);
      } else if (roll < 0.86) {
        if (GameAudio.ready) GameAudio.whisper();
      } else {
        // сублиминальный кадр — реже всего, самый страшный
        Render.trigger('faceflash');
        if (GameAudio.ready) GameAudio.sting();
      }
    }
  }

  // ============ ОТПРАВКА ВВОДА ============
  // Отдельный таймер (не rAF): в свёрнутой вкладке rAF замирает,
  // а setInterval продолжает работать — ввод не «залипает»
  setInterval(() => {
    if (G.screen !== 'game' || !G.map) return;
    const inGame = G.phase === 'play' || G.phase === 'freeze';
    if (!inGame) return;
    const frozen = G.role === 'hunter' && G.phase === 'freeze';
    const inp = Input.state;
    Network.send({
      type: 'input',
      dx: (frozen || G.hidden || G.ended) ? 0 : inp.dx,
      dy: (frozen || G.hidden || G.ended) ? 0 : inp.dy,
      sprint: inp.sprint,
      angle: inp.angle,
    });
  }, 50);

  // ============ ГЛАВНЫЙ ЦИКЛ ============
  let lastFrame = performance.now();

  function loop() {
    requestAnimationFrame(loop);
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - lastFrame) / 1000);
    lastFrame = nowMs;

    if (G.screen !== 'game' || !G.map) return;

    const inGame = G.phase === 'play' || G.phase === 'freeze';
    const frozen = G.role === 'hunter' && G.phase === 'freeze';

    // --- ввод ---
    const inp = Input.poll(Render.cam, G.me);
    if (Input.takeInteract() && inGame && !G.ended) {
      Network.send({ type: 'interact' });
    }

    // --- локальное предсказание своего движения ---
    if (inGame && !G.hidden && !frozen && !G.ended) {
      let speed = G.role === 'hunter' ? HUNTER_SPEED : SURVIVOR_SPEED;
      if (G.role === 'survivor' && inp.sprint && G.stamina > 0) speed = SURVIVOR_SPRINT;
      if (tileAtMe() === 5) speed *= RUBBLE_SLOW;
      const dx = inp.dx * speed * dt, dy = inp.dy * speed * dt;
      if (dx !== 0) G.me.x = resolveAxis(G.me.x, G.me.y, dx, 0);
      if (dy !== 0) G.me.y = resolveAxis(G.me.x, G.me.y, 0, dy);
      G.me.moving = (inp.dx !== 0 || inp.dy !== 0);

      // звук шагов
      if (G.me.moving) {
        G.stepTimer -= dt;
        if (G.stepTimer <= 0) {
          const sprinting = inp.sprint && G.stamina > 0;
          if (GameAudio.ready) GameAudio.footstep(sprinting);
          G.stepTimer = sprinting ? 0.26 : 0.4;
        }
      }
    } else {
      G.me.moving = false;
    }
    G.me.angle = inp.angle;

    // --- сглаживание к авторитарной позиции сервера ---
    const errX = G.serverMe.x - G.me.x, errY = G.serverMe.y - G.me.y;
    const err = Math.hypot(errX, errY);
    if (err > 140) { // сильное расхождение — телепорт
      G.me.x = G.serverMe.x; G.me.y = G.serverMe.y;
    } else if (err > 1) {
      const k = 1 - Math.pow(0.05, dt); // плавная подтяжка
      G.me.x += errX * k;
      G.me.y += errY * k;
    }

    // --- интерполяция/экстраполяция соперника ---
    let foeView = null;
    if (G.foeBuf.length > 0) {
      const renderAt = nowMs - INTERP_DELAY;
      const buf = G.foeBuf;
      let a = null, b = null;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].at <= renderAt) { a = buf[i]; b = buf[i + 1] || null; break; }
      }
      if (!a) { a = buf[0]; b = buf[1] || null; }
      let fx, fy, fa, fm;
      if (b) {
        const k = Math.min(1, Math.max(0, (renderAt - a.at) / (b.at - a.at || 1)));
        fx = a.x + (b.x - a.x) * k;
        fy = a.y + (b.y - a.y) * k;
        fa = lerpAngle(a.a, b.a, k);
        fm = b.mov;
      } else {
        // экстраполяция по последним двум точкам (не дальше MAX_EXTRAP)
        const prev = buf[buf.length - 2];
        const lastP = buf[buf.length - 1];
        const over = Math.min(MAX_EXTRAP, renderAt - lastP.at);
        if (prev && over > 0) {
          const span = lastP.at - prev.at || 1;
          fx = lastP.x + (lastP.x - prev.x) / span * over;
          fy = lastP.y + (lastP.y - prev.y) / span * over;
        } else { fx = lastP.x; fy = lastP.y; }
        fa = lastP.a; fm = lastP.mov;
      }
      foeView = { x: fx, y: fy, angle: fa, moving: !!fm, visible: true };
    }

    // --- звук близости ---
    if (inGame && !G.ended) {
      if (G.role === 'survivor') {
        GameAudio.setHeartbeat(G.heart);
        // низкочастотное «давление», когда Монстр совсем рядом
        GameAudio.setDread(G.heart > 0.45 ? (G.heart - 0.45) * 1.8 : 0);
      } else {
        GameAudio.setBreath(G.breath);
      }
    } else {
      GameAudio.setDread(0);
    }

    // --- скримеры ---
    if (!G.ended) updateScares(dt);

    // --- следы: возраст ---
    const fpTTL = G.footprintTTL * 1000;
    G.footprints = G.footprints.filter(f => nowMs - f.born < fpTTL);
    const fps = G.footprints.map(f => ({ x: f.x, y: f.y, age: (nowMs - f.born) / fpTTL }));

    if (G.spotFlash) G.spotFlash.ttl -= dt;

    // --- HUD ---
    UI.setTimer(G.timer);
    UI.setStamina(G.stamina, G.staminaMax, G.role === 'hunter');
    UI.setFreeze(G.freeze, G.role);
    if (G.ended) UI.setInteractHint(null);
    else if (G.hidden) UI.setInteractHint(Input.state.usingTouch ? '✚ — ВЫБРАТЬСЯ' : 'E — ВЫБРАТЬСЯ ИЗ УКРЫТИЯ');
    else if (nearestSpotDist() < G.interactRadius) {
      UI.setInteractHint(G.role === 'hunter'
        ? (Input.state.usingTouch ? '✚ — ПРОВЕРИТЬ УКРЫТИЕ' : 'E — ПРОВЕРИТЬ УКРЫТИЕ')
        : (Input.state.usingTouch ? '✚ — СПРЯТАТЬСЯ' : 'E — СПРЯТАТЬСЯ'));
    } else UI.setInteractHint(null);

    // --- кадр ---
    Render.drawFrame(dt, {
      role: G.role,
      me: { x: G.me.x, y: G.me.y, angle: G.me.angle, moving: G.me.moving, hidden: G.hidden },
      foe: foeView,
      footprints: fps,
      spotFlash: G.spotFlash,
      heart: G.heart,
      catchActive: G.catchActive,
    });
  }

  function lerpAngle(a, b, k) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * k;
  }

  requestAnimationFrame(loop);

  // отладочный доступ (используется автотестами вёрстки)
  window.CHERN = { get G() { return G; } };

  // подключаемся к серверу заранее (join уйдёт по кнопке)
  Network.connect();

  // если страницу обновили посреди игры — возвращаемся в свой слот
  // автоматически, без повторного ввода имени
  const savedName = sessionStorage.getItem('chern_name');
  if (savedName && sessionStorage.getItem('chern_token')) {
    nameInput.value = savedName;
    UI.$('loginStatus').textContent = 'возвращаемся в палату...';
    Network.join(savedName);
  }
})();
