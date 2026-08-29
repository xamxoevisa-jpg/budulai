// ============================================================
// render.js — 3D-рендер «Поймай Будулая» от первого лица.
// Классический рейкастинг (как Doom/Wolfenstein) на чистом
// canvas, без библиотек:
//  - по лучу на колонку экрана, DDA по сетке стен, текстуры
//    стен по палитрам комнат, окна, коррекция «рыбьего глаза»
//  - мебель, лампы, следы, Монстр — билборды с перекрытием
//    по z-буферу (сквозь стены ничего не видно)
//  - свет: фонарик-конус от взгляда с мерцанием, туманная тьма,
//    красное зрение Монстра с «венами», молнии в окнах
//  - руки от первого лица (фонарик / когти), покачивание камеры
//  - все хоррор-эффекты: зерно, аберрация, глитч, скримеры,
//    сублиминальные кадры, крысы, тень в конце коридора
// Сервер не изменился: мир по-прежнему клетки x/y — рендер
// просто смотрит на него изнутри.
// ============================================================

'use strict';

const Render = (() => {
  let canvas, ctx;            // видимый канвас
  let frame, fctx;            // промежуточный кадр (для аберрации/глитча)
  let tintA, tctxA, tintB, tctxB; // временные для аберрации
  let veinCanvas = null;      // «вены» для зрения Монстра
  let grainCanvases = [];     // кадры плёночного зерна
  let fogSprite = null;       // мягкое пятно тумана
  let W = 0, H = 0, DPR = 1;

  let map = null;
  let roomOf = null;          // тип комнаты по тайлу (для палитр стен)
  let rngSeedCache = 0;
  let scareImages = [];       // пользовательские фото-скримеры
  let monsterFaceImg = null;  // фото, натянутое на лицо существа (public/monster)

  const T = 48;               // размер клетки мира (px)
  const FOV = 1.15;           // ~66°
  let tanHF = Math.tan(FOV / 2);

  // z-буфер по колонкам и число лучей
  let zBuf = new Float32Array(4);
  let numRays = 4;

  // текстуры стен и спрайты
  const wallTex = {};         // palKey -> canvas 64x64
  let winTex = null, winLitTex = null;
  const SPR = {};             // kind -> {c, wH, wW, ceil?}

  // «камера» (для совместимости со старым кодом)
  const cam = { x: 0, y: 0, shake: 0 };

  // эффекты
  const fx = {
    flicker: 1, flickerTimer: 0,
    lightning: 0, lightningNext: 8, lightningStrobe: 0,
    glitch: 0,
    scareShadow: null,        // {x,y,ttl}
    shadowPending: false,
    faceFlash: 0,
    catchFace: 0,
    catchWasActive: false,
    scareVariant: null,
    rats: [],                 // {x,y,vx,vy,ttl}
    dust: [],                 // экранные пылинки в луче
    fogBlobs: [],             // экранный туман
    lamps: [],                // потолочные лампы {x,y,phase,dead,broken}
    grainIdx: 0, grainTimer: 0,
    bob: 0,                   // фаза шага
  };

  // ---------- инициализация ----------
  function init(cnv) {
    canvas = cnv;
    ctx = canvas.getContext('2d');
    frame = document.createElement('canvas');
    fctx = frame.getContext('2d');
    tintA = document.createElement('canvas'); tctxA = tintA.getContext('2d');
    tintB = document.createElement('canvas'); tctxB = tintB.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 300));

    // экранный туман
    fogSprite = document.createElement('canvas');
    fogSprite.width = fogSprite.height = 256;
    const fg = fogSprite.getContext('2d');
    const g = fg.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(150,160,170,1)');
    g.addColorStop(0.6, 'rgba(150,160,170,0.4)');
    g.addColorStop(1, 'rgba(150,160,170,0)');
    fg.fillStyle = g;
    fg.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 6; i++) {
      fx.fogBlobs.push({
        x: Math.random(), y: 0.3 + Math.random() * 0.6,
        r: 0.25 + Math.random() * 0.3,
        vx: (Math.random() - 0.5) * 0.01,
        a: 0.05 + Math.random() * 0.05,
      });
    }

    // плёночное зерно
    for (let k = 0; k < 4; k++) {
      const gc = document.createElement('canvas');
      gc.width = gc.height = 192;
      const gg = gc.getContext('2d');
      const img = gg.createImageData(192, 192);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 110 + Math.random() * 90 | 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 26 + Math.random() * 26;
      }
      gg.putImageData(img, 0, 0);
      grainCanvases.push(gc);
    }

    // пользовательские фото-скримеры
    fetch('/scares').then(r => r.json()).then(list => {
      for (const url of list) {
        const img = new Image();
        img.src = url;
        scareImages.push(img);
      }
    }).catch(() => {});

    // фото для лица существа: подгрузим и перерисуем спрайты монстра
    fetch('/monsterface').then(r => r.json()).then(list => {
      if (!list.length) return;
      const img = new Image();
      img.onload = () => {
        monsterFaceImg = img;
        SPR.monster0 = makeMonsterSprite('walkA');
        SPR.monster1 = makeMonsterSprite('walkB');
        SPR.monsterTwitch = makeMonsterSprite('twitch');
        SPR.monsterReach = makeMonsterSprite('reach');
      };
      img.src = list[0];
    }).catch(() => {});

    buildSprites();
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(320, Math.floor(window.innerWidth || 0));
    H = Math.max(320, Math.floor(window.innerHeight || 0));
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    frame.width = W * DPR; frame.height = H * DPR;
    tintA.width = tintB.width = W * DPR;
    tintA.height = tintB.height = H * DPR;
    numRays = Math.min(440, Math.max(160, Math.floor(W / 2)));
    zBuf = new Float32Array(numRays);
    buildVeins();
  }

  // «вены» по краям экрана (зрение Монстра)
  function buildVeins() {
    veinCanvas = document.createElement('canvas');
    veinCanvas.width = W; veinCanvas.height = H;
    const c = veinCanvas.getContext('2d');
    c.strokeStyle = 'rgba(120,10,14,0.55)';
    c.lineCap = 'round';
    const edges = [
      () => [Math.random() * W, -4, Math.PI / 2],
      () => [Math.random() * W, H + 4, -Math.PI / 2],
      () => [-4, Math.random() * H, 0],
      () => [W + 4, Math.random() * H, Math.PI],
    ];
    for (let i = 0; i < 26; i++) {
      let [x, y, ang] = edges[i % 4]();
      let w = 4 + Math.random() * 3;
      for (let s = 0; s < 12; s++) {
        const nx = x + Math.cos(ang) * (16 + Math.random() * 22);
        const ny = y + Math.sin(ang) * (16 + Math.random() * 22);
        c.lineWidth = w;
        c.beginPath(); c.moveTo(x, y); c.lineTo(nx, ny); c.stroke();
        if (Math.random() < 0.5 && w > 1.2) {
          const ba = ang + (Math.random() - 0.5) * 1.8;
          c.lineWidth = w * 0.5;
          c.beginPath(); c.moveTo(x, y);
          c.lineTo(x + Math.cos(ba) * 26, y + Math.sin(ba) * 26); c.stroke();
        }
        x = nx; y = ny;
        ang += (Math.random() - 0.5) * 0.9;
        w *= 0.82;
        if (w < 0.8) break;
      }
    }
  }

  function tileRand(x, y) {
    let h = (x * 374761393 + y * 668265263 + rngSeedCache) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  // ---------- палитры комнат ----------
  const PALETTES = {
    corridor: { plaster: [64, 60, 52], paint: [42, 58, 40], grime: [30, 26, 18], floorA: [52, 54, 48], floorB: [42, 44, 38] },
    ward: { plaster: [70, 64, 52], paint: [66, 62, 40], grime: [36, 28, 16], floorA: [58, 52, 42], floorB: [48, 43, 34] },
    operating: { plaster: [60, 70, 68], paint: [40, 66, 62], grime: [22, 32, 30], floorA: [56, 64, 62], floorB: [44, 52, 50] },
    boiler: { plaster: [62, 50, 38], paint: [70, 48, 22], grime: [34, 22, 12], floorA: [48, 40, 32], floorB: [38, 32, 25] },
    morgue: { plaster: [58, 64, 70], paint: [40, 52, 64], grime: [24, 28, 34], floorA: [52, 58, 64], floorB: [42, 47, 53] },
    children: { plaster: [72, 62, 60], paint: [86, 54, 66], grime: [40, 26, 24], floorA: [60, 52, 50], floorB: [48, 42, 40] },
    storage: { plaster: [62, 62, 54], paint: [56, 56, 38], grime: [30, 30, 20], floorA: [50, 50, 44], floorB: [40, 40, 35] },
  };
  const TXS = 128; // размер текстуры

  // списки текстур и карты вариантов по тайлам
  const wallTexList = [];   // [{c, data:Uint32Array}]
  const floorTexList = [];
  const ceilTexList = [];
  const wallTexIdx = {};    // palKey -> [индексы вариантов]
  const floorTexIdx = {};
  let wallMapTex = null;    // Uint8Array(W*H): какая текстура у тайла-стены
  let floorMapTex = null;   // Uint8Array(W*H): какая текстура пола
  let ceilMapTex = null;

  function texData(c) {
    const d = c.getContext('2d').getImageData(0, 0, TXS, TXS);
    return { c, data: new Uint32Array(d.data.buffer) };
  }

  // шум-помощник
  function texNoise(g, alpha, cell) {
    for (let y = 0; y < TXS; y += cell) {
      for (let x = 0; x < TXS; x += cell) {
        const v = Math.random();
        g.fillStyle = `rgba(0,0,0,${(v * alpha).toFixed(3)})`;
        g.fillRect(x, y, cell, cell);
      }
    }
  }

  // --- стена: вариант 0/1 — обычная, 2 — кровь, 3+ — надписи ---
  function makeWallTex(palKey, variant, word) {
    const pal = PALETTES[palKey] || PALETTES.corridor;
    const c = document.createElement('canvas');
    c.width = c.height = TXS;
    const g = c.getContext('2d');
    // штукатурка: вертикальный градиент + шум
    const vg = g.createLinearGradient(0, 0, 0, TXS);
    vg.addColorStop(0, `rgb(${pal.plaster[0] * 0.7 | 0},${pal.plaster[1] * 0.7 | 0},${pal.plaster[2] * 0.7 | 0})`);
    vg.addColorStop(0.4, `rgb(${pal.plaster[0]},${pal.plaster[1]},${pal.plaster[2]})`);
    vg.addColorStop(1, `rgb(${pal.plaster[0] * 0.85 | 0},${pal.plaster[1] * 0.85 | 0},${pal.plaster[2] * 0.85 | 0})`);
    g.fillStyle = vg;
    g.fillRect(0, 0, TXS, TXS);
    texNoise(g, 0.16, 2);
    // нижняя панель краски с бликом по верхней кромке
    const py0 = 66;
    g.fillStyle = `rgba(${pal.paint[0]},${pal.paint[1]},${pal.paint[2]},0.92)`;
    g.fillRect(0, py0, TXS, TXS - py0);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(0, py0 + 2, TXS, 2);
    texNoise(g, 0.1, 3);
    // облупившаяся краска — рваные пятна штукатурки
    const peels = 4 + ((variant * 7) % 4);
    for (let i = 0; i < peels; i++) {
      const r = tileRand(i * 13 + variant * 71, i * 7 + palKey.length);
      const px = r * TXS, py = py0 + 6 + tileRand(i, variant) * (TXS - py0 - 16);
      g.fillStyle = `rgb(${pal.plaster[0] * 0.9 | 0},${pal.plaster[1] * 0.9 | 0},${pal.plaster[2] * 0.9 | 0})`;
      g.beginPath();
      g.moveTo(px, py);
      for (let a = 0; a < 6.3; a += 0.9) {
        const rr = 5 + tileRand(i + a * 10, variant) * 13;
        g.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr * 0.7);
      }
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1;
      g.stroke();
    }
    // разделительная полоса, плинтус, карниз
    g.fillStyle = 'rgba(20,16,12,0.85)';
    g.fillRect(0, py0 - 3, TXS, 3);
    g.fillStyle = 'rgba(10,8,7,0.95)';
    g.fillRect(0, TXS - 7, TXS, 7);
    g.fillStyle = 'rgba(16,13,11,0.75)';
    g.fillRect(0, 0, TXS, 5);
    // потёки грязи
    for (let i = 0; i < 7; i++) {
      const r = tileRand(i * 31 + variant * 17, palKey.length * 7 + i);
      if (r < 0.3) continue;
      g.fillStyle = `rgba(${pal.grime[0]},${pal.grime[1]},${pal.grime[2]},${0.2 + r * 0.35})`;
      const x = r * (TXS - 4);
      const len = 30 + r * 80;
      g.fillRect(x, 5, 2 + r * 4, len);
      g.fillStyle = `rgba(${pal.grime[0]},${pal.grime[1]},${pal.grime[2]},${0.12 + r * 0.2})`;
      g.fillRect(x - 2, 5, 1.5, len * 0.6);
    }
    // трещины с «глубиной» (тёмная + светлый край)
    for (let i = 0; i < 3; i++) {
      const r = tileRand(i + 5 + variant * 3, palKey.length * 3);
      if (r < 0.3) continue;
      let x = r * 110, y = 6;
      const pts = [[x, y]];
      for (let s = 0; s < 5; s++) {
        x += (tileRand(x + s, y + variant) - 0.5) * 26;
        y += 14 + tileRand(y, x) * 14;
        pts.push([x, y]);
      }
      g.strokeStyle = 'rgba(8,6,5,0.8)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) g.lineTo(p[0], p[1]);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.06)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(pts[0][0] + 1.5, pts[0][1]);
      for (const p of pts) g.lineTo(p[0] + 1.5, p[1]);
      g.stroke();
    }
    // плесень по углам
    if (variant % 2 === 1) {
      g.fillStyle = 'rgba(34,48,26,0.4)';
      for (let i = 0; i < 12; i++) {
        const r = tileRand(i * 3, variant * 9 + i);
        g.beginPath();
        g.arc(r < 0.5 ? r * 30 : TXS - (r - 0.5) * 55, 8 + tileRand(i, r * 99) * 26, 2 + r * 7, 0, 7);
        g.fill();
      }
    }
    // КРОВЬ: мазки и отпечаток ладони
    if (variant === 2) {
      g.fillStyle = 'rgba(96,14,10,0.65)';
      g.beginPath();
      g.ellipse(TXS * 0.42, TXS * 0.4, 22, 30, 0.4, 0, 7);
      g.fill();
      // смазанный след волочения вниз
      const sg = g.createLinearGradient(0, TXS * 0.4, 0, TXS);
      sg.addColorStop(0, 'rgba(96,14,10,0.55)');
      sg.addColorStop(1, 'rgba(60,8,6,0.1)');
      g.fillStyle = sg;
      g.fillRect(TXS * 0.34, TXS * 0.42, 30, TXS * 0.5);
      // отпечаток ладони
      g.fillStyle = 'rgba(110,16,12,0.75)';
      const hx = TXS * 0.68, hy = TXS * 0.3;
      g.beginPath(); g.ellipse(hx, hy, 9, 12, 0.15, 0, 7); g.fill();
      for (let f = 0; f < 5; f++) {
        g.beginPath();
        g.ellipse(hx - 8 + f * 4.4, hy - 13 - (f === 2 ? 4 : f === 0 || f === 4 ? -2 : 2), 2, 6.5, (f - 2) * 0.16, 0, 7);
        g.fill();
      }
      // капли
      for (let i = 0; i < 8; i++) {
        const r = tileRand(i * 7, 999);
        g.fillStyle = `rgba(96,14,10,${0.3 + r * 0.4})`;
        g.beginPath();
        g.arc(r * TXS, TXS * 0.3 + tileRand(i, 55) * TXS * 0.5, 1 + r * 3, 0, 7);
        g.fill();
      }
    }
    // НАДПИСЬ, нацарапанная/кровью
    if (word) {
      g.save();
      g.translate(TXS / 2, TXS * 0.34);
      g.rotate((tileRand(word.length, variant) - 0.5) * 0.3);
      g.font = `bold ${TXS * 0.19}px Georgia, serif`;
      g.textAlign = 'center';
      for (const [ox, oy, al] of [[1.5, 1, 0.5], [-1, -0.7, 0.4], [0, 0, 0.8]]) {
        g.fillStyle = `rgba(96,14,12,${al})`;
        g.fillText(word, ox, oy);
      }
      // потёки от букв
      g.strokeStyle = 'rgba(96,14,12,0.5)';
      g.lineWidth = 2;
      for (let i = -2; i <= 2; i++) {
        g.beginPath();
        g.moveTo(i * 20, 6);
        g.lineTo(i * 20 + 2, 20 + tileRand(i + 5, 3) * 22);
        g.stroke();
      }
      g.restore();
    }
    return texData(c);
  }

  // --- окно ---
  function makeWindowTexN(lit) {
    const c = document.createElement('canvas');
    c.width = c.height = TXS;
    const g = c.getContext('2d');
    g.drawImage(wallTexList[wallTexIdx.corridor[0]].c, 0, 0);
    g.fillStyle = lit ? '#cdd6ee' : '#0a0f1c';
    g.fillRect(20, 16, 88, 84);
    if (!lit) {
      const gg = g.createLinearGradient(20, 16, 108, 100);
      gg.addColorStop(0, 'rgba(70,90,130,0.3)');
      gg.addColorStop(0.5, 'rgba(30,40,66,0.15)');
      gg.addColorStop(1, 'rgba(16,20,34,0.1)');
      g.fillStyle = gg;
      g.fillRect(20, 16, 88, 84);
      // силуэт мёртвого дерева за окном
      g.strokeStyle = 'rgba(4,6,10,0.8)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(76, 100); g.lineTo(70, 60); g.lineTo(56, 38);
      g.moveTo(70, 60); g.lineTo(84, 42); g.lineTo(92, 30);
      g.moveTo(84, 42) ; g.lineTo(78, 28);
      g.stroke();
    } else {
      const gg = g.createRadialGradient(64, 52, 4, 64, 52, 60);
      gg.addColorStop(0, '#ffffff');
      gg.addColorStop(1, 'rgba(180,195,235,0.65)');
      g.fillStyle = gg;
      g.fillRect(20, 16, 88, 84);
      // то же дерево — чёрным контражуром
      g.strokeStyle = 'rgba(10,12,18,0.9)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(76, 100); g.lineTo(70, 60); g.lineTo(56, 38);
      g.moveTo(70, 60); g.lineTo(84, 42); g.lineTo(92, 30);
      g.stroke();
    }
    // рама и решётка (лечебница всё-таки)
    g.strokeStyle = '#38301f';
    g.lineWidth = 5;
    g.strokeRect(20, 16, 88, 84);
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(64, 16); g.lineTo(64, 100);
    g.moveTo(20, 58); g.lineTo(108, 58);
    g.stroke();
    g.strokeStyle = 'rgba(30,26,20,0.9)';
    g.lineWidth = 2;
    for (const x of [37, 91]) { g.beginPath(); g.moveTo(x, 16); g.lineTo(x, 100); g.stroke(); }
    // трещины
    g.strokeStyle = lit ? 'rgba(90,100,130,0.8)' : 'rgba(150,170,190,0.4)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(40, 28); g.lineTo(58, 50); g.lineTo(48, 80);
    g.moveTo(80, 24); g.lineTo(88, 48);
    g.stroke();
    // подоконник с потёками
    g.fillStyle = 'rgba(26,22,17,0.9)';
    g.fillRect(16, 100, 96, 7);
    g.fillStyle = 'rgba(20,17,13,0.5)';
    g.fillRect(30, 107, 5, 14);
    g.fillRect(80, 107, 4, 10);
    return texData(c);
  }

  // --- пол: плитка; вариант 1 — битая, 2 — кровавая ---
  function makeFloorTex(palKey, variant) {
    const pal = PALETTES[palKey] || PALETTES.corridor;
    const c = document.createElement('canvas');
    c.width = c.height = TXS;
    const g = c.getContext('2d');
    const half = TXS / 2;
    // 2×2 шахматные плитки на тайл
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const even = (tx + ty) % 2 === 0;
        const base = even ? pal.floorA : pal.floorB;
        const gg = g.createLinearGradient(tx * half, ty * half, tx * half + half, ty * half + half);
        gg.addColorStop(0, `rgb(${base[0]},${base[1]},${base[2]})`);
        gg.addColorStop(1, `rgb(${base[0] * 0.72 | 0},${base[1] * 0.72 | 0},${base[2] * 0.72 | 0})`);
        g.fillStyle = gg;
        g.fillRect(tx * half, ty * half, half, half);
        // блик кромки
        g.strokeStyle = 'rgba(255,255,255,0.05)';
        g.strokeRect(tx * half + 1, ty * half + 1, half - 2, half - 2);
      }
    }
    texNoise(g, 0.18, 2);
    // затирка
    g.strokeStyle = 'rgba(12,11,9,0.9)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(half, 0); g.lineTo(half, TXS);
    g.moveTo(0, half); g.lineTo(TXS, half);
    g.stroke();
    g.strokeRect(0, 0, TXS, TXS);
    // грязь-разводы
    for (let i = 0; i < 5; i++) {
      const r = tileRand(i * 11 + variant * 5, palKey.length * 13 + i);
      g.fillStyle = `rgba(${pal.grime[0]},${pal.grime[1]},${pal.grime[2]},${0.12 + r * 0.22})`;
      g.beginPath();
      g.ellipse(r * TXS, tileRand(i, r * 77) * TXS, 14 + r * 26, 8 + r * 16, r * 6, 0, 7);
      g.fill();
    }
    if (variant === 1) { // битая плитка: сколы до бетона
      g.fillStyle = '#241f19';
      g.beginPath();
      g.moveTo(TXS * 0.55, TXS * 0.2);
      g.lineTo(TXS * 0.9, TXS * 0.35);
      g.lineTo(TXS * 0.8, TXS * 0.7);
      g.lineTo(TXS * 0.5, TXS * 0.55);
      g.closePath(); g.fill();
      texNoise(g, 0.2, 3);
      g.strokeStyle = 'rgba(6,5,4,0.9)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(TXS * 0.1, TXS * 0.75);
      g.lineTo(TXS * 0.35, TXS * 0.6);
      g.lineTo(TXS * 0.3, TXS * 0.35);
      g.stroke();
    }
    if (variant === 2) { // кровавая лужа со следом волочения
      const bg = g.createRadialGradient(TXS * 0.45, TXS * 0.5, 4, TXS * 0.45, TXS * 0.5, TXS * 0.42);
      bg.addColorStop(0, 'rgba(88,10,8,0.85)');
      bg.addColorStop(0.7, 'rgba(70,8,6,0.55)');
      bg.addColorStop(1, 'rgba(50,6,5,0)');
      g.fillStyle = bg;
      g.beginPath();
      g.ellipse(TXS * 0.45, TXS * 0.5, TXS * 0.4, TXS * 0.3, 0.3, 0, 7);
      g.fill();
      g.fillStyle = 'rgba(70,8,6,0.5)';
      g.fillRect(TXS * 0.3, TXS * 0.1, TXS * 0.24, TXS * 0.45);
      for (let i = 0; i < 6; i++) {
        const r = tileRand(i * 9, 313);
        g.fillStyle = `rgba(80,10,8,${0.3 + r * 0.4})`;
        g.beginPath();
        g.arc(r * TXS, tileRand(i, 77) * TXS, 1.5 + r * 4, 0, 7);
        g.fill();
      }
    }
    return texData(c);
  }

  // --- потолок: панели; вариант 1 — пятна, 2 — дыра с проводами ---
  function makeCeilTex(variant) {
    const c = document.createElement('canvas');
    c.width = c.height = TXS;
    const g = c.getContext('2d');
    g.fillStyle = '#3a3730';
    g.fillRect(0, 0, TXS, TXS);
    texNoise(g, 0.2, 3);
    // панели 2×2 с фаской
    const half = TXS / 2;
    g.strokeStyle = 'rgba(14,12,10,0.9)';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(half, 0); g.lineTo(half, TXS);
    g.moveTo(0, half); g.lineTo(TXS, half);
    g.stroke();
    g.strokeRect(0, 0, TXS, TXS);
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 1;
    for (const [px, py] of [[0, 0], [half, 0], [0, half], [half, half]]) {
      g.strokeRect(px + 3, py + 3, half - 6, half - 6);
    }
    if (variant === 1) { // жёлто-бурые пятна протечек
      for (let i = 0; i < 4; i++) {
        const r = tileRand(i * 17, 41 + i);
        const sg = g.createRadialGradient(r * TXS, tileRand(i, 3) * TXS, 2, r * TXS, tileRand(i, 3) * TXS, 18 + r * 30);
        sg.addColorStop(0, 'rgba(70,54,28,0.65)');
        sg.addColorStop(0.7, 'rgba(56,44,24,0.35)');
        sg.addColorStop(1, 'rgba(46,38,22,0)');
        g.fillStyle = sg;
        g.fillRect(0, 0, TXS, TXS);
      }
    }
    if (variant === 2) { // вывалившаяся панель: чернота и провода
      g.fillStyle = '#040404';
      g.fillRect(half + 4, 6, half - 10, half - 12);
      g.strokeStyle = 'rgba(40,36,30,0.9)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(half + 10, 10);
      g.quadraticCurveTo(half + 30, half * 0.7, half + 20, half - 8);
      g.moveTo(half + 40, 8);
      g.quadraticCurveTo(half + 36, half * 0.5, half + 48, half - 10);
      g.stroke();
      // свисающая панель под углом
      g.fillStyle = '#2e2b25';
      g.save();
      g.translate(half + 12, half - 4);
      g.rotate(0.5);
      g.fillRect(0, 0, half * 0.6, 8);
      g.restore();
    }
    return texData(c);
  }

  const WALL_WORDS = ['НЕ СПИ', 'ОНО ВИДИТ', 'БЕГИ', 'ТИШЕ', 'ОНИ ЗДЕСЬ', 'УХОДИ'];

  function buildTextures() {
    if (wallTexList.length) return;
    for (const k of Object.keys(PALETTES)) {
      wallTexIdx[k] = [];
      wallTexIdx[k].push(wallTexList.push(makeWallTex(k, 0)) - 1);
      wallTexIdx[k].push(wallTexList.push(makeWallTex(k, 1)) - 1);
      wallTexIdx[k].push(wallTexList.push(makeWallTex(k, 2)) - 1); // кровь
      floorTexIdx[k] = [];
      floorTexIdx[k].push(floorTexList.push(makeFloorTex(k, 0)) - 1);
      floorTexIdx[k].push(floorTexList.push(makeFloorTex(k, 1)) - 1);
      floorTexIdx[k].push(floorTexList.push(makeFloorTex(k, 2)) - 1); // кровь
    }
    // надписи — на стенах коридоров и детского крыла
    wallTexIdx.words = [];
    for (const w of WALL_WORDS) {
      wallTexIdx.words.push(wallTexList.push(makeWallTex('corridor', 0, w)) - 1);
    }
    ceilTexList.push(makeCeilTex(0), makeCeilTex(1), makeCeilTex(2));
    winTex = makeWindowTexN(false);
    winLitTex = makeWindowTexN(true);
  }

  // ---------- спрайты (билборды) ----------
  // каждый: {c: canvas, wH: высота в мире (T=48 — высота стены), wW: ширина}
  function buildSprites() {
    SPR.closet = spriteCanvas(96, 176, (g, w, h) => {
      g.fillStyle = '#241b10';
      g.fillRect(6, 4, w - 12, h - 8);
      g.fillStyle = '#38291a';
      g.fillRect(10, 8, w - 20, h - 16);
      // фактура дерева
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      for (let i = 14; i < w - 14; i += 9) {
        g.beginPath(); g.moveTo(i, 10); g.lineTo(i + 2, h - 10); g.stroke();
      }
      // приоткрытая створка — внутри чернота
      g.fillStyle = '#050302';
      g.fillRect(w / 2 + 2, 10, w / 2 - 12, h - 22);
      g.strokeStyle = '#120c06';
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(w / 2, 8); g.lineTo(w / 2, h - 10); g.stroke();
      g.strokeRect(6, 4, w - 12, h - 8);
      // ручки
      g.fillStyle = '#0f0a06';
      g.fillRect(w / 2 - 8, h / 2 - 8, 4, 16);
      // из щели виден глаз?.. нет. просто тьма.
    });
    SPR.closet.wH = 46; SPR.closet.wW = 26;

    SPR.bed = spriteCanvas(150, 74, (g, w, h) => {
      // спинки
      g.strokeStyle = '#3c3229'; g.lineWidth = 5;
      g.strokeRect(6, 8, 10, h - 14);
      g.strokeRect(w - 16, 14, 10, h - 20);
      // рама и сетка
      g.fillStyle = '#241d17';
      g.fillRect(10, h - 30, w - 20, 8);
      g.strokeStyle = 'rgba(60,50,40,0.8)'; g.lineWidth = 2;
      for (let i = 16; i < w - 16; i += 10) {
        g.beginPath(); g.moveTo(i, h - 30); g.lineTo(i + 4, h - 12); g.stroke();
      }
      // матрас в пятнах
      g.fillStyle = '#57503f';
      g.fillRect(12, h - 44, w - 26, 16);
      g.fillStyle = 'rgba(80,30,15,0.55)';
      g.beginPath(); g.ellipse(w * 0.4, h - 36, 12, 5, 0.2, 0, 7); g.fill();
      g.fillStyle = 'rgba(30,25,15,0.6)';
      g.beginPath(); g.ellipse(w * 0.65, h - 38, 8, 4, 0, 0, 7); g.fill();
      // ножки
      g.fillStyle = '#1c1610';
      g.fillRect(12, h - 12, 5, 12); g.fillRect(w - 18, h - 12, 5, 12);
    });
    SPR.bed.wH = 20; SPR.bed.wW = 40;

    SPR.crib = spriteCanvas(96, 90, (g, w, h) => {
      g.strokeStyle = '#3a2d1e'; g.lineWidth = 3;
      for (let i = 8; i <= w - 8; i += 10) {
        g.beginPath(); g.moveTo(i, 8); g.lineTo(i, h - 6); g.stroke();
      }
      g.lineWidth = 5;
      g.beginPath(); g.moveTo(4, 10); g.lineTo(w - 4, 10); g.stroke();
      g.beginPath(); g.moveTo(4, h - 8); g.lineTo(w - 4, h - 8); g.stroke();
      // кукла внутри
      g.fillStyle = '#8a7a68';
      g.beginPath(); g.arc(w / 2 + 8, h - 22, 6, 0, 7); g.fill();
      g.fillStyle = '#5c4438';
      g.fillRect(w / 2 - 2, h - 18, 16, 8);
    });
    SPR.crib.wH = 24; SPR.crib.wW = 26;

    SPR.fridge = spriteCanvas(110, 170, (g, w, h) => {
      g.fillStyle = '#20262a';
      g.fillRect(4, 2, w - 8, h - 4);
      g.fillStyle = '#333c42';
      g.fillRect(8, 6, w - 16, h - 12);
      g.strokeStyle = '#12171b'; g.lineWidth = 2;
      g.strokeRect(8, 6, w - 16, h - 12);
      // три дверцы, нижняя приоткрыта
      g.beginPath();
      g.moveTo(8, h / 3); g.lineTo(w - 8, h / 3);
      g.moveTo(8, h * 2 / 3); g.lineTo(w - 8, h * 2 / 3);
      g.stroke();
      g.fillStyle = '#05080a';
      g.fillRect(8, h * 2 / 3 + 2, w - 16, h / 3 - 14);
      // из щели — белая ткань
      g.fillStyle = 'rgba(205,202,190,0.85)';
      g.fillRect(14, h * 2 / 3 + 4, 26, 8);
      // ручки
      g.fillStyle = '#454f56';
      g.fillRect(w - 20, h / 6 - 4, 6, 10);
      g.fillRect(w - 20, h / 2 - 4, 6, 10);
    });
    SPR.fridge.wH = 44; SPR.fridge.wW = 28;

    SPR.optable = spriteCanvas(150, 90, (g, w, h) => {
      g.fillStyle = '#48525a';
      g.fillRect(8, h - 46, w - 16, 12);
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.strokeRect(8, h - 46, w - 16, 12);
      // тёмное пятно и потёк
      g.fillStyle = 'rgba(60,8,8,0.8)';
      g.beginPath(); g.ellipse(w / 2, h - 40, 22, 5, 0, 0, 7); g.fill();
      g.strokeStyle = 'rgba(60,8,8,0.6)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(w / 2 + 10, h - 36); g.lineTo(w / 2 + 12, h - 8); g.stroke();
      // ремни свисают
      g.strokeStyle = '#26201a'; g.lineWidth = 4;
      g.beginPath(); g.moveTo(w * 0.3, h - 36); g.lineTo(w * 0.28, h - 14); g.stroke();
      g.beginPath(); g.moveTo(w * 0.7, h - 36); g.lineTo(w * 0.73, h - 16); g.stroke();
      // ножки
      g.fillStyle = '#2e3436';
      g.fillRect(14, h - 34, 6, 34); g.fillRect(w - 20, h - 34, 6, 34);
    });
    SPR.optable.wH = 24; SPR.optable.wW = 40;

    SPR.slab = spriteCanvas(150, 80, (g, w, h) => {
      g.fillStyle = '#454f56';
      g.fillRect(8, h - 38, w - 16, 10);
      // тело под простынёй
      g.fillStyle = 'rgba(212,208,196,0.95)';
      g.beginPath();
      g.moveTo(14, h - 38);
      g.bezierCurveTo(w * 0.25, h - 58, w * 0.4, h - 46, w * 0.55, h - 52);
      g.bezierCurveTo(w * 0.75, h - 58, w * 0.9, h - 42, w - 14, h - 38);
      g.closePath(); g.fill();
      // свисающая рука
      g.fillStyle = '#9a8a78';
      g.fillRect(w * 0.62, h - 36, 6, 20);
      g.beginPath(); g.arc(w * 0.62 + 3, h - 14, 5, 0, 7); g.fill();
      // бирка
      g.fillStyle = '#a89e6a';
      g.fillRect(w * 0.6, h - 20, 8, 5);
      // ножки
      g.fillStyle = '#2e3436';
      g.fillRect(16, h - 28, 6, 28); g.fillRect(w - 22, h - 28, 6, 28);
    });
    SPR.slab.wH = 24; SPR.slab.wW = 40;

    SPR.boiler = spriteCanvas(120, 170, (g, w, h) => {
      const grd = g.createLinearGradient(8, 0, w - 8, 0);
      grd.addColorStop(0, '#241b12');
      grd.addColorStop(0.5, '#4a3a24');
      grd.addColorStop(1, '#241b12');
      g.fillStyle = grd;
      g.fillRect(12, 6, w - 24, h - 12);
      // швы и заклёпки
      g.strokeStyle = 'rgba(15,10,6,0.8)';
      g.lineWidth = 2;
      for (const yy of [h * 0.3, h * 0.62]) {
        g.beginPath(); g.moveTo(12, yy); g.lineTo(w - 12, yy); g.stroke();
        g.fillStyle = '#584732';
        for (let x = 18; x < w - 14; x += 10) { g.beginPath(); g.arc(x, yy, 1.6, 0, 7); g.fill(); }
      }
      // люк с вентилем
      g.fillStyle = '#1a1510';
      g.beginPath(); g.arc(w / 2, h * 0.45, 12, 0, 7); g.fill();
      g.strokeStyle = '#6a5334'; g.lineWidth = 2;
      g.beginPath(); g.arc(w / 2, h * 0.45, 8, 0, 7); g.stroke();
      g.beginPath();
      g.moveTo(w / 2 - 8, h * 0.45); g.lineTo(w / 2 + 8, h * 0.45);
      g.moveTo(w / 2, h * 0.45 - 8); g.lineTo(w / 2, h * 0.45 + 8);
      g.stroke();
      // ржавые потёки
      g.fillStyle = 'rgba(120,55,20,0.5)';
      g.fillRect(w * 0.3, h * 0.5, 4, h * 0.4);
      g.fillRect(w * 0.66, h * 0.35, 3, h * 0.5);
      // труба вверх
      g.fillStyle = '#33291c';
      g.fillRect(w / 2 - 7, 0, 14, 10);
    });
    SPR.boiler.wH = 42; SPR.boiler.wW = 30;

    SPR.shelf = spriteCanvas(130, 150, (g, w, h) => {
      g.fillStyle = '#241b10';
      g.fillRect(6, 4, w - 12, h - 8);
      g.fillStyle = '#170f08';
      g.fillRect(10, 8, w - 20, h - 14);
      // полки с банками
      for (const yy of [h * 0.3, h * 0.58, h * 0.86]) {
        g.fillStyle = '#33271a';
        g.fillRect(10, yy, w - 20, 5);
        for (let i = 0; i < 4; i++) {
          const r = tileRand(i * 7, yy | 0);
          const colr = [[90, 110, 60], [110, 90, 50], [80, 70, 90], [60, 90, 80]][i % 4];
          g.fillStyle = `rgba(${colr[0]},${colr[1]},${colr[2]},0.6)`;
          const bx = 16 + i * ((w - 36) / 4) + r * 4;
          g.fillRect(bx, yy - 16, 10, 15);
          g.fillStyle = '#1a1610';
          g.fillRect(bx, yy - 19, 10, 4);
          // что-то плавает внутри
          g.fillStyle = 'rgba(200,190,170,0.35)';
          g.beginPath(); g.arc(bx + 5, yy - 9, 2.5, 0, 7); g.fill();
        }
      }
    });
    SPR.shelf.wH = 40; SPR.shelf.wW = 34;

    SPR.toy = spriteCanvas(44, 44, (g, w, h) => {
      // плюшевый мишка без глаза
      g.fillStyle = '#4c3a28';
      g.beginPath(); g.arc(w / 2, h - 14, 11, 0, 7); g.fill();
      g.beginPath(); g.arc(w / 2 - 9, h - 30, 5, 0, 7); g.arc(w / 2 + 9, h - 30, 5, 0, 7); g.fill();
      g.fillStyle = '#5c4a34';
      g.beginPath(); g.arc(w / 2, h - 28, 8, 0, 7); g.fill();
      g.fillStyle = '#100a06';
      g.beginPath(); g.arc(w / 2 - 3, h - 29, 1.5, 0, 7); g.fill();
      g.strokeStyle = '#100a06'; g.lineWidth = 1;
      g.beginPath();
      g.moveTo(w / 2 + 1, h - 31); g.lineTo(w / 2 + 5, h - 27);
      g.moveTo(w / 2 + 5, h - 31); g.lineTo(w / 2 + 1, h - 27);
      g.stroke();
    });
    SPR.toy.wH = 11; SPR.toy.wW = 11;

    SPR.tray = spriteCanvas(70, 90, (g, w, h) => {
      g.fillStyle = '#454f52';
      g.fillRect(8, h * 0.4, w - 16, 6);
      g.strokeStyle = '#8a9294'; g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(14, h * 0.4 - 2); g.lineTo(30, h * 0.4 - 2);
      g.moveTo(34, h * 0.4 - 3); g.lineTo(52, h * 0.4 - 3);
      g.stroke();
      g.strokeStyle = 'rgba(70,10,10,0.8)';
      g.beginPath(); g.moveTo(40, h * 0.4 - 1); g.lineTo(50, h * 0.4 - 1); g.stroke();
      g.strokeStyle = '#31383a'; g.lineWidth = 3;
      g.beginPath();
      g.moveTo(14, h * 0.4 + 6); g.lineTo(10, h - 4);
      g.moveTo(w - 14, h * 0.4 + 6); g.lineTo(w - 10, h - 4);
      g.stroke();
    });
    SPR.tray.wH = 22; SPR.tray.wW = 17;

    SPR.lampceil = spriteCanvas(90, 60, (g, w, h) => {
      // люминесцентная лампа на тросах
      g.strokeStyle = '#22201c'; g.lineWidth = 2;
      g.beginPath();
      g.moveTo(w * 0.25, 0); g.lineTo(w * 0.3, 16);
      g.moveTo(w * 0.75, 0); g.lineTo(w * 0.7, 16);
      g.stroke();
      g.fillStyle = '#1a1a16';
      g.fillRect(w * 0.15, 16, w * 0.7, 10);
      g.fillStyle = '#54523c';
      g.fillRect(w * 0.18, 19, w * 0.64, 5);
    });
    SPR.lampceil.wH = 14; SPR.lampceil.wW = 20; SPR.lampceil.ceil = true;

    // инвалидная коляска (вид сбоку)
    SPR.wheelchair = spriteCanvas(120, 130, (g, w, h) => {
      g.strokeStyle = '#3b3f42'; g.lineWidth = 4; g.lineCap = 'round';
      // большое колесо со спицами
      const wx = w * 0.42, wy = h * 0.72, R = 30;
      g.beginPath(); g.arc(wx, wy, R, 0, 7); g.stroke();
      g.lineWidth = 1.6;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4 + 0.3;
        g.beginPath();
        g.moveTo(wx, wy);
        g.lineTo(wx + Math.cos(a) * R, wy + Math.sin(a) * R);
        g.stroke();
      }
      g.lineWidth = 3;
      g.beginPath(); g.arc(wx, wy, 4, 0, 7); g.stroke();
      // малое колесо
      g.beginPath(); g.arc(w * 0.75, h * 0.87, 9, 0, 7); g.stroke();
      // рама, сиденье, спинка, ручки
      g.strokeStyle = '#4a4f52'; g.lineWidth = 4.5;
      g.beginPath();
      g.moveTo(w * 0.30, h * 0.20);              // ручка
      g.lineTo(w * 0.33, h * 0.52);              // спинка
      g.lineTo(w * 0.72, h * 0.55);              // сиденье
      g.lineTo(w * 0.78, h * 0.78);              // к малому колесу
      g.moveTo(w * 0.33, h * 0.52);
      g.lineTo(w * 0.38, h * 0.72);
      g.stroke();
      g.beginPath();
      g.moveTo(w * 0.28, h * 0.185);
      g.lineTo(w * 0.36, h * 0.175);
      g.stroke();
      // провисшая ткань сиденья/спинки
      g.fillStyle = 'rgba(52,50,44,0.95)';
      g.beginPath();
      g.moveTo(w * 0.34, h * 0.26);
      g.quadraticCurveTo(w * 0.30, h * 0.42, w * 0.35, h * 0.52);
      g.lineTo(w * 0.70, h * 0.545);
      g.quadraticCurveTo(w * 0.55, h * 0.47, w * 0.40, h * 0.50);
      g.quadraticCurveTo(w * 0.40, h * 0.36, w * 0.40, h * 0.27);
      g.closePath(); g.fill();
      // ржавчина
      g.fillStyle = 'rgba(110,55,22,0.5)';
      g.beginPath(); g.arc(wx + R * 0.7, wy - R * 0.5, 4, 0, 7); g.fill();
      g.beginPath(); g.arc(w * 0.34, h * 0.4, 3, 0, 7); g.fill();
    });
    SPR.wheelchair.wH = 34; SPR.wheelchair.wW = 30;

    // каталка с накрытым телом
    SPR.gurney = spriteCanvas(160, 110, (g, w, h) => {
      // колёса
      g.strokeStyle = '#33373a'; g.lineWidth = 3;
      for (const x of [w * 0.22, w * 0.78]) {
        g.beginPath(); g.arc(x, h * 0.9, 8, 0, 7); g.stroke();
      }
      // рама на ножках
      g.lineWidth = 3.5;
      g.beginPath();
      g.moveTo(w * 0.2, h * 0.55); g.lineTo(w * 0.22, h * 0.88);
      g.moveTo(w * 0.8, h * 0.55); g.lineTo(w * 0.78, h * 0.88);
      g.moveTo(w * 0.22, h * 0.72); g.lineTo(w * 0.78, h * 0.72);
      g.stroke();
      // столешница
      g.fillStyle = '#43484c';
      g.fillRect(w * 0.12, h * 0.52, w * 0.76, 6);
      // тело под грязной простынёй
      g.fillStyle = 'rgba(205,200,188,0.95)';
      g.beginPath();
      g.moveTo(w * 0.14, h * 0.52);
      g.bezierCurveTo(w * 0.25, h * 0.30, w * 0.42, h * 0.40, w * 0.52, h * 0.38);
      g.bezierCurveTo(w * 0.68, h * 0.34, w * 0.80, h * 0.46, w * 0.86, h * 0.52);
      g.closePath(); g.fill();
      // пятна проступившей крови
      g.fillStyle = 'rgba(96,14,10,0.6)';
      g.beginPath(); g.ellipse(w * 0.5, h * 0.42, 12, 6, 0.2, 0, 7); g.fill();
      g.fillStyle = 'rgba(96,14,10,0.35)';
      g.beginPath(); g.ellipse(w * 0.3, h * 0.47, 7, 4, 0, 0, 7); g.fill();
      // свисающая рука
      g.strokeStyle = '#9a8a78'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(w * 0.62, h * 0.5);
      g.quadraticCurveTo(w * 0.64, h * 0.62, w * 0.63, h * 0.72);
      g.stroke();
      g.fillStyle = '#9a8a78';
      g.beginPath(); g.arc(w * 0.63, h * 0.74, 4, 0, 7); g.fill();
    });
    SPR.gurney.wH = 26; SPR.gurney.wW = 38;

    // стойка капельницы
    SPR.ivstand = spriteCanvas(70, 190, (g, w, h) => {
      g.strokeStyle = '#4a4e50'; g.lineWidth = 3;
      g.beginPath();
      g.moveTo(w / 2, h * 0.06); g.lineTo(w / 2, h * 0.93);
      // крюки
      g.moveTo(w / 2, h * 0.06);
      g.lineTo(w / 2 - 14, h * 0.10);
      g.moveTo(w / 2, h * 0.06);
      g.lineTo(w / 2 + 14, h * 0.10);
      g.stroke();
      // ножки
      g.beginPath();
      g.moveTo(w / 2, h * 0.93);
      g.lineTo(w / 2 - 16, h * 0.985);
      g.moveTo(w / 2, h * 0.93);
      g.lineTo(w / 2 + 16, h * 0.985);
      g.moveTo(w / 2, h * 0.93);
      g.lineTo(w / 2, h * 0.985);
      g.stroke();
      // пакет с тёмной жидкостью
      g.fillStyle = 'rgba(120,26,20,0.85)';
      g.fillRect(w / 2 - 22, h * 0.11, 16, 26);
      g.fillStyle = 'rgba(150,150,150,0.4)';
      g.fillRect(w / 2 - 22, h * 0.11, 16, 4);
      // трубка вниз, качается
      g.strokeStyle = 'rgba(180,180,170,0.5)'; g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(w / 2 - 14, h * 0.25);
      g.quadraticCurveTo(w / 2 - 8, h * 0.5, w / 2 - 16, h * 0.72);
      g.stroke();
    });
    SPR.ivstand.wH = 42; SPR.ivstand.wW = 16;

    // мешок для тела, подвешенный к потолку
    SPR.bodybag = spriteCanvas(90, 210, (g, w, h) => {
      // верёвка
      g.strokeStyle = 'rgba(120,105,80,0.9)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h * 0.12); g.stroke();
      // узел
      g.fillStyle = 'rgba(100,88,66,0.95)';
      g.beginPath(); g.arc(w / 2, h * 0.13, 5, 0, 7); g.fill();
      // сам мешок — тяжёлый, с формой тела
      const bg2 = g.createLinearGradient(w * 0.2, 0, w * 0.8, 0);
      bg2.addColorStop(0, '#1c1b18');
      bg2.addColorStop(0.5, '#33312c');
      bg2.addColorStop(1, '#181714');
      g.fillStyle = bg2;
      g.beginPath();
      g.moveTo(w / 2, h * 0.13);
      g.bezierCurveTo(w * 0.24, h * 0.22, w * 0.18, h * 0.45, w * 0.26, h * 0.62); // плечи/локти
      g.bezierCurveTo(w * 0.3, h * 0.8, w * 0.4, h * 0.96, w / 2, h * 0.97);
      g.bezierCurveTo(w * 0.6, h * 0.96, w * 0.7, h * 0.8, w * 0.74, h * 0.62);
      g.bezierCurveTo(w * 0.82, h * 0.45, w * 0.76, h * 0.22, w / 2, h * 0.13);
      g.fill();
      // швы-молния
      g.strokeStyle = 'rgba(140,135,120,0.4)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(w / 2, h * 0.16);
      g.lineTo(w / 2 - 2, h * 0.9);
      g.stroke();
      // проступающее лицо?.. просто выпуклость
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.beginPath(); g.ellipse(w * 0.46, h * 0.3, 9, 13, 0.2, 0, 7); g.fill();
      // тёмное мокрое пятно снизу
      g.fillStyle = 'rgba(60,12,10,0.6)';
      g.beginPath(); g.ellipse(w / 2, h * 0.9, 12, 9, 0, 0, 7); g.fill();
    });
    SPR.bodybag.wH = 46; SPR.bodybag.wW = 20; SPR.bodybag.ceil = true;

    // Монстр «Будулай»: кадры ходьбы, судорога, бросок
    SPR.monster0 = makeMonsterSprite('walkA');
    SPR.monster1 = makeMonsterSprite('walkB');
    SPR.monsterTwitch = makeMonsterSprite('twitch');
    SPR.monsterReach = makeMonsterSprite('reach');
    // светящиеся глаза отдельно (не гаснут в темноте)
    // тлеющие зрачки: тусклый уголёк в глубине глазницы, не «фары»
    SPR.monsterEyes = spriteCanvas(64, 32, (g, w, h) => {
      for (const sx of [-1, 1]) {
        const x = w / 2 + sx * 10;
        const gr = g.createRadialGradient(x, h / 2, 0, x, h / 2, 11);
        gr.addColorStop(0, 'rgba(255,110,70,0.95)');
        gr.addColorStop(0.22, 'rgba(220,40,26,0.75)');
        gr.addColorStop(0.55, 'rgba(150,18,12,0.3)');
        gr.addColorStop(1, 'rgba(120,10,8,0)');
        g.fillStyle = gr;
        g.fillRect(x - 11, h / 2 - 11, 22, 22);
        g.fillStyle = 'rgba(255,220,190,0.9)';
        g.beginPath(); g.arc(x, h / 2, 1.1, 0, 7); g.fill();
      }
    });

    SPR.footprint = spriteCanvas(40, 26, (g, w, h) => {
      g.fillStyle = 'rgba(120,255,170,0.95)';
      g.shadowColor = 'rgba(120,255,170,1)';
      g.shadowBlur = 8;
      g.beginPath(); g.ellipse(w / 2 - 8, h / 2 + 3, 4, 7, 0.25, 0, 7); g.fill();
      g.beginPath(); g.ellipse(w / 2 + 8, h / 2 - 3, 4, 7, 0.25, 0, 7); g.fill();
    });
    SPR.footprint.wH = 6; SPR.footprint.wW = 13; // маленькие метки на полу

    SPR.shadowman = spriteCanvas(80, 220, (g, w, h) => {
      g.fillStyle = '#040207';
      g.beginPath();
      g.ellipse(w / 2, h * 0.55, 13, h * 0.4, 0, 0, 7);
      g.fill();
      g.beginPath(); g.arc(w / 2 + 3, h * 0.12, 11, 0, 7); g.fill();
      // тонкие руки до пола
      g.strokeStyle = '#040207'; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(w / 2 - 8, h * 0.3); g.quadraticCurveTo(w * 0.1, h * 0.6, w * 0.16, h * 0.96);
      g.moveTo(w / 2 + 8, h * 0.3); g.quadraticCurveTo(w * 0.9, h * 0.6, w * 0.84, h * 0.96);
      g.stroke();
      g.fillStyle = 'rgba(220,40,30,0.95)';
      g.beginPath(); g.arc(w / 2 - 1, h * 0.11, 1.6, 0, 7); g.arc(w / 2 + 6, h * 0.11, 1.6, 0, 7); g.fill();
    });
    SPR.shadowman.wH = 52; SPR.shadowman.wW = 19;

    SPR.rat = spriteCanvas(52, 24, (g, w, h) => {
      g.fillStyle = 'rgba(14,11,9,0.95)';
      g.beginPath(); g.ellipse(w / 2 + 4, h - 8, 12, 6, 0, 0, 7); g.fill();
      g.beginPath(); g.arc(w / 2 + 15, h - 9, 4.5, 0, 7); g.fill();
      // ухо и хвост
      g.beginPath(); g.arc(w / 2 + 13, h - 14, 2, 0, 7); g.fill();
      g.strokeStyle = 'rgba(20,14,10,0.85)'; g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(w / 2 - 8, h - 8);
      g.quadraticCurveTo(w / 2 - 18, h - 12, w / 2 - 24, h - 6);
      g.stroke();
      g.fillStyle = '#c99';
      g.beginPath(); g.arc(w / 2 + 17, h - 10, 0.8, 0, 7); g.fill();
    });
    SPR.rat.wH = 7; SPR.rat.wW = 15;
  }

  function spriteCanvas(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    return { c, wH: 40, wW: 24 };
  }

  // ---------- «Будулай»: анатомическая модель ----------
  // Рисуется один раз в высоком разрешении (440×800), дальше — билборд.
  // Свет падает от камеры (фонарик), поэтому объём запекаем в текстуру:
  // центр тела светлый, края уходят в тень, во впадинах — окклюзия.
  // kind: walkA | walkB | twitch | reach
  function makeMonsterSprite(kind) {
    const s = spriteCanvas(440, 800, (g, w, h) => {
      const cx = w / 2;
      const reach = kind === 'reach';
      const twitch = kind === 'twitch';
      const legPhase = kind === 'walkA' ? 1 : kind === 'walkB' ? -1 : 0;
      const headTilt = twitch ? -1.3 : reach ? 0.14 : 0.66;

      // --- палитра мёртвой кожи: низкий ключ, сильный контраст.
      // Тело почти целиком в тени, свет цепляет только кость и хрящ —
      // остальное дорисовывает воображение. Так работает хоррор-арт.
      const SK = {
        deep: '#0b0a09', dark: '#221f1b', mid: '#443f37',
        base: '#665f54', lit: '#9c9484', wet: '#c6bda9',
        sub: '#5c342e',              // подкожная краснота
        bruise: '#38293c',           // трупные пятна
      };

      // тонкая конечность: полигон переменной толщины + поперечный градиент
      const limb = (pts, ws, shiftLit) => {
        const left = [], right = [];
        for (let i = 0; i < pts.length; i++) {
          const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
          const a = Math.atan2(next[1] - prev[1], next[0] - prev[0]) + Math.PI / 2;
          const wi = ws[i];
          left.push([pts[i][0] + Math.cos(a) * wi, pts[i][1] + Math.sin(a) * wi]);
          right.push([pts[i][0] - Math.cos(a) * wi, pts[i][1] - Math.sin(a) * wi]);
        }
        g.beginPath();
        g.moveTo(left[0][0], left[0][1]);
        for (const p of left) g.lineTo(p[0], p[1]);
        for (let i = right.length - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
        g.closePath();
        let minX = 1e9, maxX = -1e9;
        for (const p of left.concat(right)) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; }
        const lg = g.createLinearGradient(minX, 0, maxX, 0);
        const k = shiftLit || 0.5;
        lg.addColorStop(0, SK.deep);
        lg.addColorStop(0.18, SK.dark);
        lg.addColorStop(Math.max(0.2, k - 0.06), SK.base);
        lg.addColorStop(k, SK.lit);
        lg.addColorStop(Math.min(0.9, k + 0.22), SK.mid);
        lg.addColorStop(1, SK.deep);
        g.fillStyle = lg;
        g.fill();
      };

      // --- НОГИ: слишком длинные, колени вывернуты внутрь ---
      for (const side of [-1, 1]) {
        const sw = side * legPhase;            // фаза шага
        const hipX = cx + side * 26;
        const kneeX = cx + side * 13 + sw * 6;
        const ankleX = cx + side * 22 + sw * 26;
        // бедро → голень: бедро мясистее, голень истончается до кости
        limb(
          [[hipX, h * 0.545], [(hipX + kneeX) / 2, h * 0.625], [kneeX, h * 0.70],
            [(kneeX + ankleX) / 2, h * 0.82], [ankleX, h * 0.955]],
          [32, 26, 17, 13, 9],
          side < 0 ? 0.62 : 0.42
        );
        // коленная чашечка — костяной бугор
        const kg = g.createRadialGradient(kneeX - 3, h * 0.70 - 3, 1, kneeX, h * 0.70, 15);
        kg.addColorStop(0, SK.wet);
        kg.addColorStop(0.5, SK.base);
        kg.addColorStop(1, 'rgba(120,112,100,0)');
        g.fillStyle = kg;
        g.beginPath(); g.ellipse(kneeX, h * 0.70, 14, 17, 0, 0, 7); g.fill();
        // тень под коленом
        g.fillStyle = 'rgba(20,16,14,0.45)';
        g.beginPath(); g.ellipse(kneeX, h * 0.725, 12, 7, 0, 0, 7); g.fill();
        // вены на голени
        g.strokeStyle = 'rgba(70,60,80,0.35)';
        g.lineWidth = 1.6;
        for (let i = 0; i < 2; i++) {
          g.beginPath();
          g.moveTo(kneeX + (i ? 5 : -4), h * 0.73);
          g.quadraticCurveTo(ankleX + (i ? 7 : -6), h * 0.82, ankleX + (i ? 2 : -3), h * 0.93);
          g.stroke();
        }
        // ступня: длинная, с пальцами
        const fx = ankleX + side * 4, fy = h * 0.962;
        const fg2 = g.createLinearGradient(fx, fy - 8, fx, fy + 10);
        fg2.addColorStop(0, SK.base);
        fg2.addColorStop(1, SK.dark);
        g.fillStyle = fg2;
        g.beginPath();
        g.ellipse(fx + side * 8, fy + 8, 22, 9, side * 0.06, 0, 7);
        g.fill();
        // пальцы с чёрными ногтями
        for (let i = 0; i < 5; i++) {
          const tx = fx + side * (14 + i * 4), ty = fy + 12 + Math.abs(i - 2) * 1.5;
          g.fillStyle = SK.mid;
          g.beginPath(); g.ellipse(tx, ty, 4, 3, 0, 0, 7); g.fill();
          g.fillStyle = 'rgba(28,22,18,0.95)';
          g.beginPath(); g.ellipse(tx + side * 2.5, ty, 2, 2, 0, 0, 7); g.fill();
        }
      }

      // --- ТАЗ: выпирающие подвздошные кости ---
      const pg = g.createLinearGradient(cx - 40, 0, cx + 40, 0);
      pg.addColorStop(0, SK.deep);
      pg.addColorStop(0.3, SK.dark);
      pg.addColorStop(0.5, SK.base);
      pg.addColorStop(0.72, SK.mid);
      pg.addColorStop(1, SK.deep);
      g.fillStyle = pg;
      g.beginPath();
      g.moveTo(cx - 30, h * 0.455);
      g.bezierCurveTo(cx - 40, h * 0.50, cx - 34, h * 0.53, cx - 27, h * 0.565);
      g.lineTo(cx + 27, h * 0.565);
      g.bezierCurveTo(cx + 34, h * 0.53, cx + 40, h * 0.50, cx + 30, h * 0.455);
      g.closePath(); g.fill();
      // гребни подвздошных костей — блик сверху, тень снизу
      for (const side of [-1, 1]) {
        g.strokeStyle = 'rgba(232,226,212,0.35)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(cx + side * 12, h * 0.478);
        g.quadraticCurveTo(cx + side * 30, h * 0.482, cx + side * 35, h * 0.508);
        g.stroke();
        g.strokeStyle = 'rgba(18,14,12,0.5)';
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(cx + side * 12, h * 0.488);
        g.quadraticCurveTo(cx + side * 30, h * 0.492, cx + side * 35, h * 0.518);
        g.stroke();
      }

      // --- ТОРС: рёбра наружу, живот провален ---
      const tg = g.createLinearGradient(cx - 62, 0, cx + 62, 0);
      tg.addColorStop(0, SK.deep);
      tg.addColorStop(0.14, SK.dark);
      tg.addColorStop(0.4, SK.base);
      tg.addColorStop(0.52, SK.lit);
      tg.addColorStop(0.74, SK.mid);
      tg.addColorStop(1, SK.deep);
      g.fillStyle = tg;
      g.beginPath();
      g.moveTo(cx - 47, h * 0.262);                                    // левое плечо
      g.bezierCurveTo(cx - 62, h * 0.30, cx - 58, h * 0.36, cx - 45, h * 0.405); // грудная клетка
      g.bezierCurveTo(cx - 34, h * 0.44, cx - 30, h * 0.47, cx - 31, h * 0.50);  // талия (впалая)
      g.lineTo(cx + 31, h * 0.50);
      g.bezierCurveTo(cx + 30, h * 0.47, cx + 34, h * 0.44, cx + 45, h * 0.405);
      g.bezierCurveTo(cx + 58, h * 0.36, cx + 62, h * 0.30, cx + 47, h * 0.262);
      g.closePath(); g.fill();

      // ключицы
      for (const side of [-1, 1]) {
        g.strokeStyle = 'rgba(238,232,218,0.4)';
        g.lineWidth = 4;
        g.beginPath();
        g.moveTo(cx + side * 4, h * 0.278);
        g.quadraticCurveTo(cx + side * 26, h * 0.272, cx + side * 43, h * 0.285);
        g.stroke();
        g.strokeStyle = 'rgba(16,12,10,0.55)';
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(cx + side * 4, h * 0.289);
        g.quadraticCurveTo(cx + side * 26, h * 0.283, cx + side * 43, h * 0.296);
        g.stroke();
      }
      // ямка между ключицами
      g.fillStyle = 'rgba(12,10,9,0.6)';
      g.beginPath(); g.ellipse(cx, h * 0.272, 7, 5, 0, 0, 7); g.fill();

      // рёбра: 6 пар, тень сверху + блик снизу
      for (let i = 0; i < 6; i++) {
        const yy = h * (0.305 + i * 0.023);
        const sp = 46 - i * 2.5;
        g.strokeStyle = 'rgba(14,11,10,0.5)';
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(cx - sp + 6, yy);
        g.quadraticCurveTo(cx, yy + 13, cx + sp - 6, yy);
        g.stroke();
        g.strokeStyle = 'rgba(228,220,204,0.28)';
        g.lineWidth = 2.6;
        g.beginPath();
        g.moveTo(cx - sp + 7, yy + 4);
        g.quadraticCurveTo(cx, yy + 16.5, cx + sp - 7, yy + 4);
        g.stroke();
      }
      // грудина
      g.strokeStyle = 'rgba(226,218,202,0.22)';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(cx, h * 0.295); g.lineTo(cx, h * 0.415);
      g.stroke();

      // провал живота
      const bg = g.createRadialGradient(cx, h * 0.455, 4, cx, h * 0.458, 40);
      bg.addColorStop(0, 'rgba(10,8,7,0.72)');
      bg.addColorStop(0.6, 'rgba(24,20,17,0.4)');
      bg.addColorStop(1, 'rgba(30,26,22,0)');
      g.fillStyle = bg;
      g.beginPath(); g.ellipse(cx, h * 0.457, 26, 34, 0, 0, 7); g.fill();

      // --- Y-образный секционный разрез со скобами ---
      const inc = [[cx - 34, h * 0.288], [cx - 6, h * 0.372], [cx, h * 0.392],
        [cx + 6, h * 0.372], [cx + 34, h * 0.288]];
      g.strokeStyle = 'rgba(52,10,8,0.9)';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(inc[0][0], inc[0][1]);
      g.lineTo(inc[1][0], inc[1][1]);
      g.moveTo(inc[4][0], inc[4][1]);
      g.lineTo(inc[3][0], inc[3][1]);
      g.moveTo(cx, h * 0.378); g.lineTo(cx + 2, h * 0.50);
      g.stroke();
      // тёмная щель внутри разреза
      g.strokeStyle = 'rgba(20,4,4,0.95)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(inc[0][0], inc[0][1]); g.lineTo(inc[1][0], inc[1][1]);
      g.moveTo(inc[4][0], inc[4][1]); g.lineTo(inc[3][0], inc[3][1]);
      g.moveTo(cx, h * 0.378); g.lineTo(cx + 2, h * 0.50);
      g.stroke();
      // металлические скобы поперёк
      g.strokeStyle = 'rgba(196,192,184,0.85)';
      g.lineWidth = 2.4;
      const staple = (x0, y0, x1, y1, n) => {
        for (let i = 0; i <= n; i++) {
          const k = i / n;
          const px = x0 + (x1 - x0) * k, py = y0 + (y1 - y0) * k;
          const a = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
          g.beginPath();
          g.moveTo(px + Math.cos(a) * 6, py + Math.sin(a) * 6);
          g.lineTo(px - Math.cos(a) * 6, py - Math.sin(a) * 6);
          g.stroke();
        }
      };
      staple(inc[0][0], inc[0][1], inc[1][0], inc[1][1], 5);
      staple(inc[4][0], inc[4][1], inc[3][0], inc[3][1], 5);
      staple(cx, h * 0.378, cx + 2, h * 0.50, 7);

      // трупные пятна и синяки
      g.globalAlpha = 0.4;
      for (const [bx, by, br] of [[-30, 0.34, 15], [26, 0.42, 12], [-18, 0.48, 10], [34, 0.31, 9]]) {
        const bgr = g.createRadialGradient(cx + bx, h * by, 1, cx + bx, h * by, br);
        bgr.addColorStop(0, SK.bruise);
        bgr.addColorStop(1, 'rgba(74,58,78,0)');
        g.fillStyle = bgr;
        g.beginPath(); g.arc(cx + bx, h * by, br, 0, 7); g.fill();
      }
      g.globalAlpha = 1;

      // --- ОБРЫВКИ БОЛЬНИЧНОЙ РУБАХИ на бёдрах ---
      g.fillStyle = 'rgba(96,98,92,0.92)';
      g.beginPath();
      g.moveTo(cx - 33, h * 0.495);
      g.lineTo(cx + 33, h * 0.495);
      g.lineTo(cx + 27, h * 0.585);
      g.lineTo(cx + 12, h * 0.556);
      g.lineTo(cx - 2, h * 0.60);
      g.lineTo(cx - 16, h * 0.552);
      g.lineTo(cx - 28, h * 0.58);
      g.closePath(); g.fill();
      // тень и грязь на ткани
      g.fillStyle = 'rgba(20,18,14,0.4)';
      g.fillRect(cx - 33, h * 0.495, 66, 8);
      g.fillStyle = 'rgba(70,16,12,0.45)';
      g.beginPath(); g.ellipse(cx + 8, h * 0.53, 14, 9, 0.2, 0, 7); g.fill();

      // --- РУКИ ---
      for (const side of [-1, 1]) {
        const shX = cx + side * 44, shY = h * 0.285;
        if (reach) {
          // тянется в камеру: предплечье укорочено, кисть огромная
          limb([[shX, shY], [shX + side * 26, h * 0.345], [shX + side * 16, h * 0.415]],
            [19, 16, 15], side < 0 ? 0.6 : 0.4);
          const hx = shX + side * 20, hy = h * 0.475;
          // пальцы рисуем ПЕРВЫМИ — ладонь ляжет поверх их оснований
          for (let f = 0; f < 5; f++) {
            const fa = (f - 2) * 0.30 + side * 0.30;   // веер пальцев
            const len = f === 2 ? 78 : f === 0 || f === 4 ? 56 : 68;
            const dirX2 = Math.sin(fa), dirY2 = Math.cos(fa * 0.5);
            const midX = hx + dirX2 * len * 0.55, midY = hy + dirY2 * len * 0.5;
            const tipX = hx + dirX2 * len, tipY = hy + dirY2 * len;
            limb([[hx + dirX2 * 12, hy + dirY2 * 10], [midX, midY], [tipX, tipY]],
              [10, 7.5, 4.6], 0.42);
            // тёмный зазор между пальцами
            g.strokeStyle = 'rgba(6,5,5,0.7)';
            g.lineWidth = 2.6;
            g.beginPath();
            g.moveTo(hx + dirX2 * 14, hy + dirY2 * 12);
            g.lineTo(tipX, tipY);
            g.stroke();
            // костяшка сустава
            g.fillStyle = 'rgba(228,220,202,0.2)';
            g.beginPath(); g.ellipse(midX, midY, 7, 6, fa, 0, 7); g.fill();
            // чёрный загнутый ноготь
            g.fillStyle = 'rgba(20,15,13,0.96)';
            g.beginPath(); g.ellipse(tipX + dirX2 * 3, tipY + 4, 4.2, 6.5, fa, 0, 7); g.fill();
          }
          // ладонь: угловатая, с костяшками
          const hgr = g.createRadialGradient(hx - side * 8, hy - 10, 3, hx, hy + 4, 40);
          hgr.addColorStop(0, SK.lit);
          hgr.addColorStop(0.4, SK.base);
          hgr.addColorStop(0.8, SK.mid);
          hgr.addColorStop(1, SK.deep);
          g.fillStyle = hgr;
          g.beginPath();
          g.moveTo(hx - 26, hy - 16);
          g.lineTo(hx + 26, hy - 12);
          g.quadraticCurveTo(hx + 30, hy + 14, hx + 16, hy + 22);
          g.lineTo(hx - 18, hy + 20);
          g.quadraticCurveTo(hx - 30, hy + 6, hx - 26, hy - 16);
          g.closePath(); g.fill();
          // сухожилия на тыльной стороне
          g.strokeStyle = 'rgba(214,206,188,0.18)';
          g.lineWidth = 2.4;
          for (let f = -2; f <= 2; f++) {
            g.beginPath();
            g.moveTo(hx + f * 9, hy - 12);
            g.lineTo(hx + f * 11, hy + 16);
            g.stroke();
          }
          // кисть тонет в тени: она ближе всего к камере, но фонарь бьёт
          // мимо неё — иначе пальцы читаются как белый веер
          g.save();
          g.globalCompositeOperation = 'source-atop';
          const shg = g.createRadialGradient(hx, hy, 12, hx, hy + 46, 95);
          shg.addColorStop(0, 'rgba(10,9,8,0.10)');
          shg.addColorStop(0.55, 'rgba(8,7,6,0.42)');
          shg.addColorStop(1, 'rgba(5,4,4,0.72)');
          g.fillStyle = shg;
          g.fillRect(hx - 110, hy - 40, 220, 180);
          g.restore();
        } else {
          const sway = legPhase * side * 10;
          const tw = twitch ? side * 18 : 0;
          const elbX = shX + side * 20 + sway;
          const wrX = shX + side * 12 + sway + tw;
          limb([[shX, shY], [elbX, h * 0.40], [wrX, h * 0.545], [wrX + side * 4, h * 0.615]],
            [18, 13, 10, 9], side < 0 ? 0.6 : 0.4);
          // локтевой отросток
          g.fillStyle = 'rgba(230,224,208,0.25)';
          g.beginPath(); g.ellipse(elbX + side * 8, h * 0.40, 8, 11, 0, 0, 7); g.fill();
          // кисть с длинными пальцами
          const hx = wrX + side * 5, hy = h * 0.625;
          g.fillStyle = SK.mid;
          g.beginPath(); g.ellipse(hx, hy, 13, 15, 0, 0, 7); g.fill();
          for (let f = 0; f < 5; f++) {
            const off = (f - 2) * 5;
            limb([[hx + off * 0.7, hy + 8], [hx + off, hy + 34], [hx + off * 1.1 + side * 2, hy + 52 + Math.abs(f - 2) * -5]],
              [4.5, 3.6, 2.6], 0.5);
            g.fillStyle = 'rgba(24,18,16,0.95)';
            g.beginPath();
            g.ellipse(hx + off * 1.1 + side * 2, hy + 54 + Math.abs(f - 2) * -5, 2.6, 4, 0, 0, 7);
            g.fill();
          }
        }
        // дельтовидная мышца поверх сустава — иначе плечо выглядит «коробкой»
        const dg = g.createRadialGradient(shX - side * 7, shY - 8, 2, shX, shY + 2, 32);
        dg.addColorStop(0, SK.lit);
        dg.addColorStop(0.4, SK.base);
        dg.addColorStop(0.75, SK.mid);
        dg.addColorStop(1, 'rgba(11,10,9,0)');
        g.fillStyle = dg;
        g.beginPath(); g.ellipse(shX, shY + 6, 22, 27, side * 0.18, 0, 7); g.fill();
        // кость лопатки под кожей
        g.strokeStyle = 'rgba(226,218,200,0.22)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(shX - side * 12, shY - 4);
        g.quadraticCurveTo(shX + side * 6, shY - 10, shX + side * 16, shY + 6);
        g.stroke();

        // кожаный ремень-фиксатор на запястье (разорванный)
        const cuffY = reach ? h * 0.425 : h * 0.585;
        const cuffX = reach ? shX + side * 15 : shX + side * 12 + legPhase * side * 10 + (twitch ? side * 18 : 0);
        g.fillStyle = 'rgba(48,34,24,0.95)';
        g.fillRect(cuffX - 13, cuffY, 26, 11);
        g.fillStyle = 'rgba(28,20,14,0.9)';
        g.fillRect(cuffX - 13, cuffY + 7, 26, 4);
        g.strokeStyle = 'rgba(150,140,120,0.5)';
        g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(cuffX + 2, cuffY + 2); g.lineTo(cuffX + 2, cuffY + 9); g.stroke();
        // оборванный ремешок свисает
        g.strokeStyle = 'rgba(48,34,24,0.9)';
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(cuffX + side * 10, cuffY + 8);
        g.quadraticCurveTo(cuffX + side * 20, cuffY + 26, cuffX + side * 14, cuffY + 44);
        g.stroke();
      }

      // капельница, всё ещё в вене левой руки
      if (!reach) {
        const ivX = cx - 56 + legPhase * -10;
        g.strokeStyle = 'rgba(190,190,180,0.45)';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(ivX, h * 0.42);
        g.quadraticCurveTo(ivX - 24, h * 0.52, ivX - 12, h * 0.64);
        g.stroke();
        g.fillStyle = 'rgba(120,26,20,0.7)';
        g.beginPath(); g.arc(ivX - 12, h * 0.645, 4, 0, 7); g.fill();
      }

      // --- ШЕЯ: натянутые сухожилия ---
      const neckX = cx + (twitch ? -14 : 10);
      limb([[cx, h * 0.278], [neckX, h * 0.232], [neckX + (twitch ? -4 : 3), h * 0.208]],
        [25, 21, 18], 0.45);
      g.strokeStyle = 'rgba(238,230,214,0.3)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(cx - 8, h * 0.268);
      g.quadraticCurveTo(neckX - 6, h * 0.235, neckX - 2, h * 0.205);
      g.moveTo(cx + 9, h * 0.268);
      g.quadraticCurveTo(neckX + 7, h * 0.235, neckX + 5, h * 0.205);
      g.stroke();
      // тень под подбородком
      g.fillStyle = 'rgba(12,10,9,0.6)';
      g.beginPath(); g.ellipse(neckX, h * 0.208, 15, 8, 0, 0, 7); g.fill();

      // --- ГОЛОВА ---
      g.save();
      g.translate(neckX + 2, h * 0.174);
      g.rotate(headTilt);
      const HS = 1.32;   // череп крупнее туловища — детская пропорция «неправильности»
      g.scale(HS, HS);

      // череп, обтянутый кожей
      const skg = g.createRadialGradient(-14, -20, 6, 0, -2, 62);
      skg.addColorStop(0, SK.wet);
      skg.addColorStop(0.35, SK.lit);
      skg.addColorStop(0.62, SK.base);
      skg.addColorStop(0.85, SK.mid);
      skg.addColorStop(1, SK.deep);
      g.fillStyle = skg;
      g.beginPath();
      g.moveTo(0, -54);
      g.bezierCurveTo(28, -53, 38, -36, 37, -14);       // височная кость
      g.bezierCurveTo(36, -2, 31, 6, 26, 12);           // скула
      g.bezierCurveTo(23, 30, 15, 52, 0, 62);           // челюсть, вытянутая вниз
      g.bezierCurveTo(-15, 52, -23, 30, -26, 12);
      g.bezierCurveTo(-31, 6, -36, -2, -37, -14);
      g.bezierCurveTo(-38, -36, -28, -53, 0, -54);
      g.closePath();
      g.fill();

      // фото-лицо пользователя (если положил файл в public/monster).
      // Когда фото есть, процедурные черты НЕ рисуем: они полностью
      // перекрыли бы снимок. Вместо них — мертвенная обработка самого
      // фото и «неправильные» детали по краям.
      const hasFace = !!(monsterFaceImg && monsterFaceImg.complete && monsterFaceImg.naturalWidth);
      if (hasFace) {
        g.save();
        g.beginPath();
        g.ellipse(0, 0, 35, 53, 0, 0, 7);
        g.clip();
        const iw = monsterFaceImg.naturalWidth, ih = monsterFaceImg.naturalHeight;
        // cover-вписывание в овал головы
        const sc = Math.max(70 / iw, 106 / ih) * 1.18;
        g.drawImage(monsterFaceImg, -iw * sc / 2, -ih * sc / 2 - 6, iw * sc, ih * sc);
        // обескровить: снять цвет
        g.globalCompositeOperation = 'saturation';
        g.fillStyle = '#808080';
        g.fillRect(-40, -60, 80, 120);
        // трупный сине-серый тон и провал яркости
        g.globalCompositeOperation = 'multiply';
        g.fillStyle = 'rgba(214,212,204,0.55)';
        g.fillRect(-40, -60, 80, 120);
        // холодный трупный подтон
        g.globalCompositeOperation = 'overlay';
        g.fillStyle = 'rgba(70,74,86,0.35)';
        g.fillRect(-40, -60, 80, 120);
        // виньетка по краю черепа: лицо тонет в тени
        g.globalCompositeOperation = 'source-over';
        const vgn = g.createRadialGradient(0, -4, 12, 0, 0, 46);
        vgn.addColorStop(0, 'rgba(0,0,0,0)');
        vgn.addColorStop(0.66, 'rgba(6,5,5,0.18)');
        vgn.addColorStop(1, 'rgba(4,3,3,0.8)');
        g.fillStyle = vgn;
        g.fillRect(-40, -60, 80, 120);
        // гниль пятнами прямо по лицу
        for (let i = 0; i < 26; i++) {
          g.fillStyle = Math.random() < 0.6
            ? `rgba(12,10,9,${(0.06 + Math.random() * 0.2).toFixed(2)})`
            : `rgba(84,60,44,${(0.05 + Math.random() * 0.16).toFixed(2)})`;
          g.beginPath();
          g.ellipse((Math.random() - 0.5) * 66, (Math.random() - 0.5) * 96,
            2 + Math.random() * 8, 2 + Math.random() * 6, Math.random() * 3, 0, 7);
          g.fill();
        }
        g.restore();
        // швы по краю лица — будто оно пришито к черепу
        g.strokeStyle = 'rgba(46,28,22,0.75)';
        g.lineWidth = 1.5;
        for (let i = 0; i < 22; i++) {
          const a = i / 22 * Math.PI * 2;
          const ex = Math.cos(a) * 35, ey = Math.sin(a) * 53;
          g.beginPath();
          g.moveTo(ex * 0.9, ey * 0.9);
          g.lineTo(ex * 1.06, ey * 1.06);
          g.stroke();
        }
      }

      if (!hasFace) {
      // надбровные дуги: тень сверху, блик по кромке
      g.fillStyle = 'rgba(14,11,10,0.55)';
      g.beginPath();
      g.moveTo(-30, -22);
      g.quadraticCurveTo(0, -30, 30, -22);
      g.quadraticCurveTo(0, -14, -30, -22);
      g.fill();
      g.strokeStyle = 'rgba(240,234,220,0.3)';
      g.lineWidth = 2.4;
      g.beginPath();
      g.moveTo(-29, -25);
      g.quadraticCurveTo(0, -33, 29, -25);
      g.stroke();

      // глазницы: глубокие провалы
      for (const sx of [-1, 1]) {
        const ex = sx * 16, ey = -8;
        const eg = g.createRadialGradient(ex, ey - 3, 2, ex, ey, 18);
        eg.addColorStop(0, '#000000');
        eg.addColorStop(0.55, '#080606');
        eg.addColorStop(1, 'rgba(28,22,20,0)');
        g.fillStyle = eg;
        g.beginPath(); g.ellipse(ex, ey, 15, 17, sx * 0.12, 0, 7); g.fill();
        g.fillStyle = '#050404';
        g.beginPath(); g.ellipse(ex, ey, 10.5, 13, sx * 0.12, 0, 7); g.fill();
        // тёмный ободок вокруг — синяки
        g.strokeStyle = 'rgba(60,34,44,0.5)';
        g.lineWidth = 5;
        g.beginPath(); g.ellipse(ex, ey, 13, 15, sx * 0.12, 0, 7); g.stroke();
      }
      // скуловые дуги — блик
      g.strokeStyle = 'rgba(236,228,212,0.34)';
      g.lineWidth = 4;
      for (const sx of [-1, 1]) {
        g.beginPath();
        g.moveTo(sx * 33, -8);
        g.quadraticCurveTo(sx * 27, 6, sx * 15, 12);
        g.stroke();
      }
      // впалые щёки
      for (const sx of [-1, 1]) {
        const cg = g.createRadialGradient(sx * 20, 20, 2, sx * 20, 20, 20);
        cg.addColorStop(0, 'rgba(10,8,7,0.55)');
        cg.addColorStop(1, 'rgba(20,16,14,0)');
        g.fillStyle = cg;
        g.beginPath(); g.ellipse(sx * 20, 20, 13, 18, 0, 0, 7); g.fill();
      }
      // провал носа
      g.fillStyle = 'rgba(8,6,6,0.95)';
      g.beginPath();
      g.moveTo(-5, 8); g.lineTo(5, 8);
      g.lineTo(0, 20);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(230,222,206,0.2)';
      g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(0, -6); g.lineTo(0, 7); g.stroke();

      // рот: отвисшая челюсть + зашитые уголки (улыбка до ушей)
      const mouthOpen = reach ? 26 : twitch ? 20 : 15;
      g.fillStyle = '#0a0505';
      g.beginPath();
      g.ellipse(0, 38, 17, mouthOpen, 0, 0, 7);
      g.fill();
      // зубы
      g.fillStyle = 'rgba(206,198,178,0.92)';
      for (let i = -3; i <= 3; i++) {
        g.beginPath();
        g.moveTo(i * 5 - 2.2, 38 - mouthOpen + 2);
        g.lineTo(i * 5 + 2.2, 38 - mouthOpen + 2);
        g.lineTo(i * 5, 38 - mouthOpen + 11);
        g.closePath(); g.fill();
      }
      for (let i = -2; i <= 2; i++) {
        g.beginPath();
        g.moveTo(i * 6 - 2.4, 38 + mouthOpen - 2);
        g.lineTo(i * 6 + 2.4, 38 + mouthOpen - 2);
        g.lineTo(i * 6, 38 + mouthOpen - 10);
        g.closePath(); g.fill();
      }
      // разрезы от уголков рта, стянутые нитками
      for (const sx of [-1, 1]) {
        g.strokeStyle = 'rgba(58,10,8,0.85)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(sx * 15, 36);
        g.quadraticCurveTo(sx * 24, 30, sx * 29, 22);
        g.stroke();
        g.strokeStyle = 'rgba(20,16,14,0.9)';
        g.lineWidth = 1.4;
        for (let i = 0; i < 4; i++) {
          const k = i / 3;
          const px = sx * (15 + 14 * k), py = 36 - 14 * k;
          g.beginPath();
          g.moveTo(px - sx * 3, py - 4);
          g.lineTo(px + sx * 3, py + 4);
          g.stroke();
        }
      }
      } // конец процедурных черт (рисуются, только если фото не задано)
      // редкие мокрые пряди волос
      g.strokeStyle = 'rgba(26,22,19,0.9)';
      g.lineCap = 'round';
      const hairN = hasFace ? 5 : 14;
      for (let i = 0; i < hairN; i++) {
        const a = -2.5 + i * (hasFace ? 0.62 : 0.22);
        const rx = Math.cos(a) * 33, ry = -30 + Math.sin(a) * 20;
        g.lineWidth = 1.4 + (i % 3) * 0.9;
        g.beginPath();
        g.moveTo(rx * 0.7, ry);
        g.quadraticCurveTo(rx * 1.25, ry + 26, rx * 1.05 + (i % 2 ? 6 : -6), ry + 58 + (i % 4) * 12);
        g.stroke();
      }
      // мокрый блик на лбу
      g.fillStyle = 'rgba(255,250,238,0.16)';
      g.beginPath(); g.ellipse(-10, -34, 13, 8, -0.4, 0, 7); g.fill();
      // больничный браслет на... нет, это голова. Просто потёк.
      g.strokeStyle = 'rgba(74,12,10,0.55)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(-20, 4); g.lineTo(-23, 26);
      g.stroke();
      g.restore();

      // --- КОЖА: мраморная пятнистость и вены ---
      // ровный градиент читается как пластик; пятна и прожилки —
      // как органика. source-atop, чтобы не залезть на фон.
      g.globalCompositeOperation = 'source-atop';
      for (let i = 0; i < 200; i++) {
        const bx = Math.random() * w;
        const by = h * 0.12 + Math.random() * h * 0.84;
        const br = 3 + Math.random() * 18;
        g.fillStyle = Math.random() < 0.56
          ? `rgba(9,7,6,${(0.05 + Math.random() * 0.14).toFixed(3)})`
          : `rgba(172,162,142,${(0.03 + Math.random() * 0.09).toFixed(3)})`;
        g.beginPath();
        g.ellipse(bx, by, br, br * (0.45 + Math.random() * 0.9), Math.random() * 3, 0, 7);
        g.fill();
      }
      // сетка вен под кожей
      g.strokeStyle = 'rgba(44,36,58,0.3)';
      for (let i = 0; i < 24; i++) {
        let vx = w * (0.26 + Math.random() * 0.48);
        let vy = h * (0.25 + Math.random() * 0.36);
        let vw = 2.3;
        for (let sgm = 0; sgm < 5; sgm++) {
          const nx = vx + (Math.random() - 0.5) * 26;
          const ny = vy + 9 + Math.random() * 17;
          g.lineWidth = vw;
          g.beginPath(); g.moveTo(vx, vy); g.lineTo(nx, ny); g.stroke();
          vx = nx; vy = ny; vw *= 0.74;
        }
      }
      // засохшая грязь на ступнях и голенях
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `rgba(38,28,18,${(0.1 + Math.random() * 0.3).toFixed(2)})`;
        g.beginPath();
        g.ellipse(w * (0.3 + Math.random() * 0.4), h * (0.8 + Math.random() * 0.18),
          3 + Math.random() * 9, 2 + Math.random() * 6, Math.random() * 3, 0, 7);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';

      // --- ЗАПЕЧЁННЫЙ ОБЪЁМ: свет от камеры, края уходят в тень ---
      // source-atop — тень ложится ТОЛЬКО на тело, фон остаётся прозрачным
      g.globalCompositeOperation = 'source-atop';
      const vol = g.createRadialGradient(cx - 10, h * 0.40, 34, cx, h * 0.45, 215);
      vol.addColorStop(0, 'rgba(0,0,0,0)');
      vol.addColorStop(0.42, 'rgba(8,6,6,0.10)');
      vol.addColorStop(0.72, 'rgba(6,5,5,0.40)');
      vol.addColorStop(1, 'rgba(3,2,2,0.74)');
      g.fillStyle = vol;
      g.fillRect(0, 0, w, h);

      // ноги растворяются во мраке — стираем низ спрайта в прозрачность
      g.globalCompositeOperation = 'destination-out';
      const fade = g.createLinearGradient(0, h * 0.88, 0, h);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(1, 'rgba(0,0,0,0.8)');
      g.fillStyle = fade;
      g.fillRect(0, h * 0.86, w, h * 0.14);
      g.globalCompositeOperation = 'source-over';
    });
    s.wH = 62; s.wW = 34;
    // куда крепить светящиеся зрачки (они рисуются отдельным слоем,
    // чтобы гореть даже вне луча фонаря)
    const tw2 = kind === 'twitch';
    s.eye = {
      x: (220 + (tw2 ? -14 : 10) + 2) / 440,
      y: 0.174,
      tilt: tw2 ? -1.3 : (kind === 'reach' ? 0.14 : 0.66),
    };
    return s;
  }

  // ---------- карта ----------
  function setMap(m) {
    map = m;
    rngSeedCache = m.seed | 0;
    // какая комната на тайле — для выбора текстур стен
    roomOf = new Array(m.H);
    for (let y = 0; y < m.H; y++) roomOf[y] = new Array(m.W).fill('corridor');
    for (const r of m.rooms) {
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++)
          if (y >= 0 && x >= 0 && y < m.H && x < m.W) roomOf[y][x] = r.type;
    }
    // текстуры (генерим один раз)
    buildTextures();

    // --- разложить варианты текстур по тайлам ---
    // хэш тайла, чтобы стены/пол не выглядели повторяющимися
    const th = (x, y) => {
      let h = (x * 73856093) ^ (y * 19349663) ^ rngSeedCache;
      h = (h ^ (h >> 13)) * 1274126177;
      return ((h ^ (h >> 16)) >>> 0) / 4294967296;
    };
    const walkT = (x, y) => x >= 0 && y >= 0 && x < m.W && y < m.H &&
      (m.grid[y][x] === 1 || m.grid[y][x] === 3 || m.grid[y][x] === 5);
    wallMapTex = new Uint8Array(m.W * m.H);
    floorMapTex = new Uint8Array(m.W * m.H);
    ceilMapTex = new Uint8Array(m.W * m.H);
    for (let y = 0; y < m.H; y++) {
      for (let x = 0; x < m.W; x++) {
        const idx = y * m.W + x;
        const t = m.grid[y][x];
        const r = th(x, y);
        if (t === 2 || t === 0) {
          // палитра — по прилегающей комнате
          let pal = 'corridor';
          for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            if (walkT(x + dx, y + dy)) { pal = roomOf[y + dy][x + dx]; break; }
          }
          const set = wallTexIdx[pal] || wallTexIdx.corridor;
          if (r > 0.96 && (pal === 'corridor' || pal === 'children')) {
            // редкая стена с нацарапанной надписью
            wallMapTex[idx] = wallTexIdx.words[(r * 1000 | 0) % wallTexIdx.words.length];
          } else if (r > 0.88 || ((pal === 'morgue' || pal === 'operating') && r > 0.72)) {
            wallMapTex[idx] = set[2];              // кровь
          } else {
            wallMapTex[idx] = set[r > 0.5 ? 1 : 0]; // обычные варианты
          }
        } else if (walkT(x, y)) {
          const pal = roomOf[y][x];
          const fset = floorTexIdx[pal] || floorTexIdx.corridor;
          const bloodChance = (pal === 'morgue' || pal === 'operating') ? 0.24 : 0.05;
          if (r < bloodChance) floorMapTex[idx] = fset[2];
          else if (r < bloodChance + 0.22) floorMapTex[idx] = fset[1];
          else floorMapTex[idx] = fset[0];
          // потолок
          const rc = th(x + 999, y + 555);
          ceilMapTex[idx] = rc < 0.1 ? 2 : rc < 0.4 ? 1 : 0;
        }
      }
    }
    // потолочные лампы в коридорах
    fx.lamps = [];
    for (const r of m.rooms) {
      if (r.type !== 'corridor') continue;
      const horiz = r.w >= r.h;
      const len = horiz ? r.w : r.h;
      for (let i = 3; i < len; i += 7) {
        const lx = horiz ? (r.x + i + 0.5) * T : (r.x + r.w / 2) * T;
        const ly = horiz ? (r.y + r.h / 2) * T : (r.y + i + 0.5) * T;
        const seed = tileRand(Math.floor(lx), Math.floor(ly));
        fx.lamps.push({ x: lx, y: ly, dead: seed < 0.3, phase: seed * 20, broken: seed > 0.85 });
      }
    }
  }

  const isWallTile = (t) => t === 0 || t === 2 || t === 4;

  // ---------- пол и потолок: перспективный рендер ----------
  // низкое разрешение + сглаженный апскейл = скорость и «мягкая» картинка
  let lowBuf = null;
  function ensureLowBuf() {
    const w = Math.min(232, Math.max(120, W >> 2));
    const h = Math.min(300, Math.max(150, H >> 2));
    if (lowBuf && lowBuf.w === w && lowBuf.h === h) return;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx2 = cv.getContext('2d');
    const img = cx2.createImageData(w, h);
    lowBuf = { cv, cx2, img, u32: new Uint32Array(img.data.buffer), w, h };
  }

  function floorcast(px, py, dirX, dirY, planeX, planeY, midScr, isHunter) {
    ensureLowBuf();
    const { w, h, u32 } = lowBuf;
    const midLow = midScr / H * h;
    const F = (W / 2) / tanHF;              // фокус в экранных px
    const K = (T / 2) * F * (h / H);        // глаз на половине высоты стены
    const mW = map.W, mH = map.H;
    const amb = isHunter ? 0.10 : 0.03;
    const lightBoost = fx.lightning;
    const flick = fx.flicker;

    for (let y = 0; y < h; y++) {
      const dy = y - midLow;
      const isFloor = dy > 0;
      const ady = Math.abs(dy);
      if (ady < 1.2) { // у горизонта — чернота тумана
        for (let x = 0; x < w; x++) u32[y * w + x] = 0xff000000;
        continue;
      }
      const rowDist = K / ady;
      // затухание света по дистанции (та же кривая, что у стен)
      let fall;
      if (isHunter) fall = Math.max(0, 1 - rowDist / 860) * 0.34 + 0.04;
      else fall = Math.pow(Math.max(0, 1 - rowDist / 530), 1.4) * 1.3 * flick;
      const rowCeilK = isFloor ? 1 : 0.55; // потолок темнее
      let fX = px + rowDist * (dirX - planeX);
      let fY = py + rowDist * (dirY - planeY);
      const stX = rowDist * 2 * planeX / w;
      const stY = rowDist * 2 * planeY / w;
      const rowO = y * w;
      for (let x = 0; x < w; x++) {
        const tX = fX / T | 0, tY = fY / T | 0;
        let out = 0xff000000;
        if (tX >= 0 && tY >= 0 && tX < mW && tY < mH) {
          const mi = tY * mW + tX;
          const list = isFloor ? floorTexList : ceilTexList;
          const ti = isFloor ? floorMapTex[mi] : ceilMapTex[mi];
          const tex = list[ti];
          if (tex) {
            let u = ((fX % T) / T * TXS) | 0; if (u < 0) u += TXS;
            let v = ((fY % T) / T * TXS) | 0; if (v < 0) v += TXS;
            const texel = tex.data[v * TXS + u];
            // конус фонарика по горизонтали
            const camXs = (x / w) * 2 - 1;
            let b;
            if (isHunter) b = fall;
            else b = fall * Math.max(0, 1 - Math.abs(camXs) * 1.3) + amb;
            b = Math.min(1, (b + lightBoost * (isFloor ? 0.35 : 0.2)) * rowCeilK);
            const m8 = (b * 256) | 0;
            const r = ((texel & 255) * m8) >> 8;
            const g = (((texel >> 8) & 255) * m8) >> 8;
            const bl = (((texel >> 16) & 255) * m8) >> 8;
            out = 0xff000000 | (bl << 16) | (g << 8) | r;
          }
        }
        u32[rowO + x] = out;
        fX += stX; fY += stY;
      }
    }
    lowBuf.cx2.putImageData(lowBuf.img, 0, 0);
  }

  // ---------- свет ----------
  // camXs: -1..1 положение на экране; dist: расстояние
  function lightAt(isHunter, camXs, dist, isWindow) {
    let b;
    if (isHunter) {
      // тёмное красное зрение: ровное, но глубже гаснет вдаль
      b = 0.34 * Math.max(0, 1 - dist / 860);
      b += 0.04;
    } else {
      const cone = Math.max(0, 1 - Math.abs(camXs) * 1.3);
      const fall = Math.pow(Math.max(0, 1 - dist / 530), 1.4);
      b = fx.flicker * cone * fall * 1.3 + 0.028;
    }
    if (fx.lightning > 0.05) {
      b = Math.max(b, isWindow ? fx.lightning : fx.lightning * 0.45);
    }
    return Math.min(1, b);
  }

  // ---------- главный кадр ----------
  function drawFrame(dt, view) {
    if (!map) return;
    const t = performance.now() / 1000;
    const isHunter = view.role === 'hunter';
    updateEffects(dt, view);

    cam.x = view.me.x; cam.y = view.me.y; // для совместимости

    const c = fctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);

    // --- в укрытии: вид из шкафа ---
    if (view.me.hidden) {
      drawHiddenView(c, t, view);
      compose(c, view, t, isHunter);
      return;
    }

    // покачивание камеры при ходьбе + дыхание
    if (view.me.moving) fx.bob += dt * (view.me.sprint ? 11 : 7.5);
    const bobY = Math.sin(fx.bob) * (view.me.moving ? 5 : 0) + Math.sin(t * 1.1) * 2;
    let shakeY = 0, shakeX = 0;
    const shakeAmp = cam.shake + (view.heart > 0.6 ? (view.heart - 0.6) * 10 : 0);
    if (shakeAmp > 0.1) {
      shakeX = (Math.random() - 0.5) * shakeAmp * 2;
      shakeY = (Math.random() - 0.5) * shakeAmp * 2;
      cam.shake *= Math.pow(0.02, dt);
    }
    const mid = H / 2 + bobY + shakeY;

    const px = view.me.x, py = view.me.y;
    const ang = view.me.angle;
    const dirX = Math.cos(ang), dirY = Math.sin(ang);
    const planeX = -dirY * tanHF, planeY = dirX * tanHF;
    const proj = (W / 2) / tanHF; // расстояние до плоскости проекции

    // --- потолок и пол: настоящая перспектива с текстурами ---
    floorcast(px, py, dirX, dirY, planeX, planeY, mid, isHunter);
    c.imageSmoothingEnabled = true;
    c.drawImage(lowBuf.cv, 0, 0, lowBuf.w, lowBuf.h, 0, 0, W, H);

    // --- стены (рейкастинг) ---
    const colW = W / numRays;
    for (let i = 0; i < numRays; i++) {
      const camXs = 2 * i / numRays - 1;
      const rdX = dirX + planeX * camXs;
      const rdY = dirY + planeY * camXs;
      let mapX = Math.floor(px / T), mapY = Math.floor(py / T);
      const dDX = Math.abs(T / (rdX || 1e-9)), dDY = Math.abs(T / (rdY || 1e-9));
      const stepX = rdX < 0 ? -1 : 1, stepY = rdY < 0 ? -1 : 1;
      let sDX = rdX < 0 ? (px - mapX * T) / T * dDX : ((mapX + 1) * T - px) / T * dDX;
      let sDY = rdY < 0 ? (py - mapY * T) / T * dDY : ((mapY + 1) * T - py) / T * dDY;
      let side = 0, tile = 0, hit = false;
      let floorX = mapX, floorY = mapY; // последний пол перед стеной
      for (let s = 0; s < 60; s++) {
        if (sDX < sDY) { sDX += dDX; mapX += stepX; side = 0; }
        else { sDY += dDY; mapY += stepY; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= map.W || mapY >= map.H) { tile = 2; hit = true; break; }
        tile = map.grid[mapY][mapX];
        if (isWallTile(tile)) { hit = true; break; }
        floorX = mapX; floorY = mapY;
      }
      if (!hit) { zBuf[i] = 1e9; continue; }
      const perp = side === 0
        ? (mapX * T - px + (1 - stepX) * T / 2) / rdX
        : (mapY * T - py + (1 - stepY) * T / 2) / rdY;
      const dist = Math.max(4, perp);
      zBuf[i] = dist;
      const lineH = (T * proj) / dist;
      const y0 = mid - lineH / 2;

      // координата текстуры
      let wallX = side === 0 ? py + perp * rdY : px + perp * rdX;
      wallX = (wallX % T) / T;
      if (wallX < 0) wallX += 1;
      let texX = Math.floor(wallX * TXS);
      if ((side === 0 && rdX > 0) || (side === 1 && rdY < 0)) texX = TXS - 1 - texX;

      // текстура: окно или вариант стены из карты вариантов
      let tex;
      if (tile === 4) tex = fx.lightning > 0.4 ? winLitTex : winTex;
      else tex = wallTexList[wallMapTex[mapY * map.W + mapX]] || wallTexList[0];

      const x = i * colW;
      c.drawImage(tex.c, texX, 0, 1, TXS, x, y0, colW + 1, lineH);

      // затемнение по свету
      let b = lightAt(isHunter, camXs, dist, tile === 4);
      if (side === 1) b *= 0.78; // грани С/Ю чуть темнее — объём
      const shade = 1 - Math.min(1, b);
      if (shade > 0.01) {
        c.fillStyle = `rgba(0,0,0,${shade.toFixed(3)})`;
        c.fillRect(x, y0 - 1, colW + 1, lineH + 2);
      }
    }

    // --- билборды ---
    drawSprites(c, view, isHunter, px, py, dirX, dirY, planeX, planeY, proj, mid, t);

    // --- пылинки в луче (экранные) ---
    if (!isHunter && fx.flicker > 0.1) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const d of fx.dust) {
        const cone = Math.max(0, 1 - Math.abs((d.x / W) * 2 - 1) * 1.4);
        c.globalAlpha = d.a * fx.flicker * cone * Math.min(1, d.ttl);
        c.fillStyle = '#d8dcd0';
        c.fillRect(d.x, d.y, d.s, d.s);
      }
      c.restore();
      c.globalAlpha = 1;
    }

    // --- экранный туман ---
    for (const b of fx.fogBlobs) {
      c.globalAlpha = b.a * (1 + Math.sin(t * 0.5 + b.x * 9) * 0.3);
      const r = b.r * H;
      c.drawImage(fogSprite, b.x * W - r, b.y * H - r, r * 2, r * 2);
    }
    c.globalAlpha = 1;

    // --- руки от первого лица ---
    drawHands(c, view, isHunter, t, bobY);

    compose(c, view, t, isHunter);
  }

  // ---------- билборды ----------
  function drawSprites(c, view, isHunter, px, py, dirX, dirY, planeX, planeY, proj, mid, t) {
    const list = [];
    const fogDist = isHunter ? 900 : 560;

    // мебель
    for (const p of map.props) {
      const spr = SPR[p.kind];
      if (!spr) continue;
      const dx = p.x - px, dy = p.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 > fogDist * fogDist || d2 < 100) continue;
      list.push({ spr, x: p.x, y: p.y, d2 });
    }
    // лампы
    for (const l of fx.lamps) {
      const dx = l.x - px, dy = l.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 > fogDist * fogDist) continue;
      list.push({ spr: SPR.lampceil, x: l.x, y: l.y, d2, lamp: l });
    }
    // следы (только Монстр)
    if (isHunter && view.footprints) {
      for (const fp of view.footprints) {
        if (fp.age >= 1) continue;
        const dx = fp.x - px, dy = fp.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 > fogDist * fogDist) continue;
        list.push({ spr: SPR.footprint, x: fp.x, y: fp.y, d2, glow: (1 - fp.age), floorMark: true });
      }
    }
    // Монстр (его видит только Выживший)
    if (!isHunter && view.foe) {
      const dx = view.foe.x - px, dy = view.foe.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < fogDist * fogDist) {
        // близко — тянется к тебе; иногда — судорога (дёрганое движение)
        let frame2;
        if (d2 < 150 * 150) frame2 = SPR.monsterReach;
        else if (Math.random() < 0.06) frame2 = SPR.monsterTwitch;
        else frame2 = Math.sin(t * 7) > 0 ? SPR.monster0 : SPR.monster1;
        list.push({ spr: frame2, x: view.foe.x, y: view.foe.y, d2, monster: true });
      }
    }
    // тень-скример
    if (fx.scareShadow && fx.scareShadow.ttl > 0) {
      const s = fx.scareShadow;
      const dx = s.x - px, dy = s.y - py;
      list.push({ spr: SPR.shadowman, x: s.x, y: s.y, d2: dx * dx + dy * dy, alpha: Math.min(0.95, s.ttl * 2.2), noLight: true });
    }
    // крысы
    for (const r of fx.rats) {
      const dx = r.x - px, dy = r.y - py;
      list.push({ spr: SPR.rat, x: r.x, y: r.y, d2: dx * dx + dy * dy });
    }

    list.sort((a, b) => b.d2 - a.d2);

    const invDet = 1 / (planeX * dirY - dirX * planeY);
    const colW = W / numRays;
    for (const it of list) {
      const relX = it.x - px, relY = it.y - py;
      const trX = invDet * (dirY * relX - dirX * relY);   // поперёк экрана
      const trY = invDet * (-planeY * relX + planeX * relY); // глубина
      if (trY < 12) continue;
      const screenX = (W / 2) * (1 + trX / trY);
      const spr = it.spr;
      const hPix = (spr.wH * proj) / trY;
      const wPix = (spr.wW * proj) / trY;
      if (screenX + wPix / 2 < 0 || screenX - wPix / 2 > W) continue;
      // вертикаль: низ — на полу (камера на высоте T/2)
      const floorScr = mid + ((T / 2) * proj) / trY;
      const ceilScr = mid - ((T / 2) * proj) / trY;
      let y0;
      if (spr.ceil) y0 = ceilScr;
      else if (it.floorMark) y0 = floorScr - hPix * 0.6;
      else y0 = floorScr - hPix;

      // освещение спрайта
      const camXs = trX / trY / tanHF;
      let b = lightAt(isHunter, camXs, trY, false);
      if (it.glow != null) b = Math.max(b, 0.85 * it.glow); // следы светятся
      if (it.lamp && !it.lamp.dead) {
        let inten = 0.8 + Math.sin(t * 3 + it.lamp.phase) * 0.15;
        if (it.lamp.broken) inten *= (Math.sin(t * 17 + it.lamp.phase * 9) > 0.4 ? 1 : 0.1);
        b = Math.max(b, 0.35);
        it.lampGlow = inten;
      }
      if (it.noLight) b = it.alpha != null ? 1 : b;
      let alpha = it.alpha != null ? it.alpha : Math.min(1, b * 1.5);
      // Монстр в луче виден отчётливо, вблизи — всегда
      if (it.monster) alpha = Math.min(1, Math.max(alpha, 1.15 - trY / 320));
      if (alpha < 0.02) continue;

      // порисуем колонками с проверкой z-буфера
      const sw = spr.c.width;
      const x0 = Math.max(0, Math.floor(screenX - wPix / 2));
      const x1 = Math.min(W - 1, Math.ceil(screenX + wPix / 2));
      const step = Math.max(1, Math.floor(colW));
      c.globalAlpha = alpha;
      for (let x = x0; x <= x1; x += step) {
        const zi = Math.min(numRays - 1, Math.floor(x / colW));
        if (zBuf[zi] <= trY) continue;
        const u = (x - (screenX - wPix / 2)) / wPix;
        const sx = Math.max(0, Math.min(sw - 1, Math.floor(u * sw)));
        c.drawImage(spr.c, sx, 0, 1, spr.c.height, x, y0, step + 1, hPix);
      }
      c.globalAlpha = 1;

      // сияние лампы + пятно света на полу под ней
      if (it.lampGlow) {
        c.save();
        c.globalCompositeOperation = 'lighter';
        const gr = c.createRadialGradient(screenX, y0 + hPix * 0.6, 0, screenX, y0 + hPix * 0.6, hPix * 2.4);
        gr.addColorStop(0, `rgba(210,220,180,${0.16 * it.lampGlow})`);
        gr.addColorStop(1, 'rgba(210,220,180,0)');
        c.fillStyle = gr;
        c.fillRect(screenX - hPix * 2.4, y0 - hPix, hPix * 4.8, hPix * 4.5);
        // световое пятно на полу
        const poolW = (60 * proj) / trY;
        const pg = c.createRadialGradient(screenX, floorScr, 0, screenX, floorScr, poolW);
        pg.addColorStop(0, `rgba(190,200,160,${0.13 * it.lampGlow})`);
        pg.addColorStop(1, 'rgba(190,200,160,0)');
        c.fillStyle = pg;
        c.save();
        c.translate(screenX, floorScr);
        c.scale(1, 0.35);
        c.translate(-screenX, -floorScr);
        c.fillRect(screenX - poolW, floorScr - poolW, poolW * 2, poolW * 2);
        c.restore();
        c.restore();
      }
      // зрачки Монстра тлеют в глазницах даже вне луча фонаря
      if (it.monster && spr.eye) {
        const ew = (11.2 * proj) / trY;
        c.save();
        c.translate(screenX - wPix / 2 + wPix * spr.eye.x, y0 + hPix * spr.eye.y);
        c.rotate(spr.eye.tilt);
        c.globalAlpha = 0.85 + Math.sin(t * 3.1) * 0.15;
        c.drawImage(SPR.monsterEyes.c, -ew / 2, -ew / 4, ew, ew / 2);
        c.restore();
        c.globalAlpha = 1;
      }
    }
  }

  // ---------- руки от первого лица ----------
  function drawHands(c, view, isHunter, t, bobY) {
    const s = Math.min(W, H) / 400;
    const swayX = Math.sin(fx.bob * 0.5) * 8 * s;
    const swayY = Math.abs(Math.cos(fx.bob * 0.5)) * 6 * s + bobY * 0.4;
    if (isHunter) {
      // две когтистые лапы по краям
      for (const side of [-1, 1]) {
        c.save();
        c.translate(W / 2 + side * (W * 0.34 + swayX * side), H + swayY);
        c.rotate(side * (-0.5 + Math.sin(t * 2.6) * 0.05));
        c.scale(s * 1.5, s * 1.5);
        c.fillStyle = '#0d070c';
        c.beginPath();
        c.moveTo(-22, 60);
        c.quadraticCurveTo(-26, -10, -10, -46);
        c.quadraticCurveTo(0, -58, 8, -48);
        c.quadraticCurveTo(20, -6, 22, 60);
        c.closePath(); c.fill();
        // когти
        c.strokeStyle = '#1c1016'; c.lineWidth = 5; c.lineCap = 'round';
        for (let i = -1; i <= 1; i++) {
          c.beginPath();
          c.moveTo(i * 10, -44);
          c.quadraticCurveTo(i * 14, -66, i * 10 + side * 4, -84);
          c.stroke();
        }
        c.strokeStyle = 'rgba(190,50,50,0.25)';
        c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(-8, 10); c.lineTo(-4, -30); c.stroke();
        c.restore();
      }
    } else {
      // рука с фонариком снизу справа
      c.save();
      c.translate(W * 0.72 + swayX, H + swayY);
      c.rotate(-0.18 + Math.sin(t * 1.1) * 0.012);
      c.scale(s * 1.6, s * 1.6);
      // рукав робы
      c.fillStyle = '#5f6b62';
      c.beginPath();
      c.moveTo(-30, 70);
      c.quadraticCurveTo(-34, 6, -16, -30);
      c.lineTo(16, -22);
      c.quadraticCurveTo(26, 20, 24, 70);
      c.closePath(); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(-30, 30, 56, 8);
      // кисть
      c.fillStyle = '#c9b598';
      c.beginPath(); c.ellipse(0, -34, 15, 12, -0.2, 0, 7); c.fill();
      c.fillStyle = '#b5a084';
      for (let i = -1; i <= 1; i++) {
        c.beginPath(); c.ellipse(i * 8 - 2, -44, 4.5, 8, i * 0.15, 0, 7); c.fill();
      }
      // фонарик
      c.save();
      c.rotate(-0.06);
      c.fillStyle = '#23252a';
      c.fillRect(-9, -78, 18, 40);
      c.fillStyle = '#3a3d44';
      c.fillRect(-11, -84, 22, 10);
      if (fx.flicker > 0.05) {
        const gr = c.createRadialGradient(0, -86, 1, 0, -86, 26);
        gr.addColorStop(0, `rgba(255,240,190,${0.9 * fx.flicker})`);
        gr.addColorStop(1, 'rgba(255,220,150,0)');
        c.fillStyle = gr;
        c.beginPath(); c.arc(0, -86, 26, 0, 7); c.fill();
      }
      c.restore();
      c.restore();
    }
  }

  // ---------- вид из укрытия ----------
  function drawHiddenView(c, t, view) {
    c.fillStyle = '#030202';
    c.fillRect(0, 0, W, H);
    // щели дверцы шкафа — полоски тусклого света
    const breathe = Math.sin(t * 1.8) * 3;
    for (const off of [-0.06, 0.05]) {
      const x = W * (0.5 + off);
      const g = c.createLinearGradient(x - 7, 0, x + 7, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, `rgba(90,84,66,${0.25 + Math.sin(t * 0.7 + off * 30) * 0.06})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x - 7, H * 0.08 + breathe, 14, H * 0.84);
    }
    // сердцебиение сжимает щели
    if (view.heart > 0.4) {
      const p = (Math.sin(t * (4 + view.heart * 8)) * 0.5 + 0.5) * (view.heart - 0.3);
      c.fillStyle = `rgba(60,4,4,${p * 0.5})`;
      c.fillRect(0, 0, W, H);
    }
  }

  // ---------- сборка кадра: оверлеи + вывод ----------
  function compose(c, view, t, isHunter) {
    // цветокор: у Монстра мир в красном; у Жертвы тёплый центр/холодные края
    if (isHunter) {
      c.save();
      c.globalCompositeOperation = 'multiply';
      const pulse = 0.92 + Math.sin(t * 2.2) * 0.08;
      c.fillStyle = `rgb(${172 * pulse | 0},${64 * pulse | 0},${58 * pulse | 0})`;
      c.fillRect(0, 0, W, H);
      c.restore();
    } else if (!view.me.hidden) {
      c.save();
      c.globalCompositeOperation = 'soft-light';
      const gr = c.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
      gr.addColorStop(0, `rgba(255,190,120,${0.5 * fx.flicker})`);
      gr.addColorStop(0.55, 'rgba(120,110,140,0.12)');
      gr.addColorStop(1, 'rgba(40,60,110,0.4)');
      c.fillStyle = gr;
      c.fillRect(0, 0, W, H);
      c.restore();
    }
    // молния — общий засвет
    if (fx.lightning > 0.01 && !view.me.hidden) {
      c.save();
      c.globalCompositeOperation = 'screen';
      c.fillStyle = `rgba(185,195,235,${fx.lightning * 0.32})`;
      c.fillRect(0, 0, W, H);
      c.restore();
    }
    // вены Монстра
    if (isHunter && veinCanvas) {
      c.globalAlpha = 0.5 + Math.sin(t * 2.2) * 0.25;
      c.drawImage(veinCanvas, 0, 0);
      c.globalAlpha = 1;
    }
    // виньетка
    const vg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.30, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.88)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
    // красная пульсация при близком Монстре
    if (view.heart > 0.35 && !isHunter) {
      const pulse = (Math.sin(t * (4 + view.heart * 8)) * 0.5 + 0.5) * (view.heart - 0.3);
      const rg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.7);
      rg.addColorStop(0, 'rgba(120,0,0,0)');
      rg.addColorStop(1, `rgba(150,8,8,${pulse * 0.6})`);
      c.fillStyle = rg;
      c.fillRect(0, 0, W, H);
    }
    // зерно
    fx.grainTimer -= 0.016;
    if (fx.grainTimer <= 0) { fx.grainTimer = 0.045; fx.grainIdx = (fx.grainIdx + 1) % grainCanvases.length; }
    const gp = c.createPattern(grainCanvases[fx.grainIdx], 'repeat');
    c.save();
    c.globalCompositeOperation = 'overlay';
    c.globalAlpha = 0.3;
    c.fillStyle = gp;
    c.fillRect(0, 0, W, H);
    c.restore();

    // сублиминальный кадр и скример поимки
    if (fx.faceFlash > 0) drawCatchFace(c, 0.55, t, true);
    if (fx.catchFace > 0.01) drawCatchFace(c, fx.catchFace, t, false);

    // ---------- вывод (+аберрация/глитч) ----------
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const aberr = Math.min(1, (view.heart > 0.55 && !isHunter ? (view.heart - 0.55) * 2.2 : 0) + fx.glitch * 1.5 + fx.catchFace + fx.faceFlash * 3);
    if (aberr > 0.05) {
      const off = Math.round(2 + aberr * 6);
      tctxA.globalCompositeOperation = 'source-over';
      tctxA.clearRect(0, 0, tintA.width, tintA.height);
      tctxA.drawImage(frame, 0, 0);
      tctxA.globalCompositeOperation = 'multiply';
      tctxA.fillStyle = '#ff0000';
      tctxA.fillRect(0, 0, tintA.width, tintA.height);
      tctxB.globalCompositeOperation = 'source-over';
      tctxB.clearRect(0, 0, tintB.width, tintB.height);
      tctxB.drawImage(frame, 0, 0);
      tctxB.globalCompositeOperation = 'multiply';
      tctxB.fillStyle = '#00ffff';
      tctxB.fillRect(0, 0, tintB.width, tintB.height);
      ctx.drawImage(tintA, -off, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(tintB, off, 0);
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.drawImage(frame, 0, 0);
    }
    if (fx.glitch > 0.05) {
      const n = 3 + Math.floor(fx.glitch * 7);
      for (let i = 0; i < n; i++) {
        const y = Math.random() * canvas.height;
        const h2 = (2 + Math.random() * 16) * DPR;
        const shift = (Math.random() - 0.5) * 70 * fx.glitch * DPR;
        ctx.drawImage(canvas, 0, y, canvas.width, h2, shift, y, canvas.width, h2);
      }
    }
  }

  // ---------- скримеры (морды + фото) ----------
  function pickScareVariant() {
    const pool = [];
    for (const img of scareImages) {
      if (img.complete && img.naturalWidth > 0) {
        pool.push({ type: 'img', img }, { type: 'img', img });
      }
    }
    pool.push({ type: 'proc', id: 0 }, { type: 'proc', id: 1 },
      { type: 'proc', id: 2 }, { type: 'proc', id: 3 });
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function drawCatchFace(c, k, t, subliminal) {
    if (!fx.scareVariant) fx.scareVariant = pickScareVariant();
    const v = fx.scareVariant;
    c.save();
    c.globalAlpha = subliminal ? 0.88 : Math.min(1, k * 3);
    const strobe = !subliminal && Math.floor(t * 26) % 3 === 0;
    c.fillStyle = strobe ? '#1c0000' : '#000';
    c.fillRect(0, 0, W, H);
    const jx = (Math.random() - 0.5) * (subliminal ? 10 : 22);
    const jy = (Math.random() - 0.5) * (subliminal ? 10 : 22);
    if (v.type === 'img') {
      drawPhotoScare(c, v.img, k, t, jx, jy);
    } else {
      const cx = W / 2, cy = H / 2;
      const sc = Math.min(W, H) / 400 * (0.9 + k * 0.3 + Math.random() * 0.05);
      c.translate(cx + jx, cy + jy);
      c.scale(sc, sc);
      if (v.id === 0) scarePale(c, t);
      else if (v.id === 1) scareGrin(c, t);
      else if (v.id === 2) scareEye(c, k, t);
      else scareNurse(c, t);
    }
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.strokeStyle = 'rgba(110,10,10,0.5)';
    c.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const x = ((i * 197 + 61) % W);
      c.lineWidth = 3 + (i % 3) * 2;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x + 6, H * (0.14 + (i % 4) * 0.07));
      c.stroke();
    }
    const vg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.9)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
    c.restore();
    c.globalAlpha = 1;
  }

  function drawPhotoScare(c, img, k, t, jx, jy) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const zoom = 1.04 + k * 0.16 + (Math.floor(t * 26) % 2) * 0.025;
    const s = Math.max(W / iw, H / ih) * zoom;
    const dw = iw * s, dh = ih * s;
    c.drawImage(img, W / 2 - dw / 2 + jx * 1.6, H / 2 - dh / 2 + jy * 1.6, dw, dh);
    const pulse = 0.5 + Math.sin(t * 34) * 0.5;
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = `rgb(${200 + pulse * 55 | 0},${70 + pulse * 60 | 0},${60 + pulse * 50 | 0})`;
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 0; i < 4; i++) {
      if (Math.random() < 0.5) continue;
      const y = Math.random() * H;
      c.fillRect(0, y, W, 2 + Math.random() * 5);
    }
  }

  function scarePale(c, t) {
    c.save();
    c.rotate(0.07 + Math.sin(t * 40) * 0.008);
    const fg = c.createRadialGradient(0, -20, 30, 0, 0, 200);
    fg.addColorStop(0, '#cbb9a6');
    fg.addColorStop(0.7, '#a8968a');
    fg.addColorStop(1, '#5d4c45');
    c.fillStyle = fg;
    c.beginPath();
    c.moveTo(0, -160);
    c.bezierCurveTo(115, -148, 132, -40, 103, 62);
    c.bezierCurveTo(85, 152, 30, 192, -2, 190);
    c.bezierCurveTo(-32, 188, -80, 148, -108, 55);
    c.bezierCurveTo(-128, -45, -105, -152, 0, -160);
    c.fill();
    c.strokeStyle = 'rgba(70,60,80,0.55)';
    c.lineWidth = 1.6;
    for (let i = 0; i < 9; i++) {
      const a0 = i * 0.72 + 0.3;
      c.beginPath();
      c.moveTo(Math.cos(a0) * 100, Math.sin(a0) * 130 - 20);
      c.quadraticCurveTo(Math.cos(a0) * 60, Math.sin(a0) * 80 - 10, Math.cos(a0 + 0.4) * 40, Math.sin(a0 + 0.4) * 50);
      c.stroke();
    }
    const eyes = [[-1, -46, 34, 44], [1, -28, 42, 52]];
    for (const [sxx, ey, ew, eh] of eyes) {
      const eg = c.createRadialGradient(sxx * 48, ey, 4, sxx * 48, ey, eh);
      eg.addColorStop(0, '#000');
      eg.addColorStop(0.75, '#0a0508');
      eg.addColorStop(1, 'rgba(40,25,25,0)');
      c.fillStyle = eg;
      c.beginPath();
      c.ellipse(sxx * 48, ey, ew, eh, sxx * 0.2, 0, 7);
      c.fill();
      c.fillStyle = '#d42020';
      c.shadowColor = '#d42020'; c.shadowBlur = 14;
      c.beginPath();
      c.arc(sxx * 44 + Math.random() * 6 - 3, ey + 4, sxx > 0 ? 6.5 : 4.5, 0, 7);
      c.fill();
      c.shadowBlur = 0;
    }
    c.strokeStyle = '#54423a';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(-62, -108); c.lineTo(52, -92);
    for (let x = -55; x < 50; x += 14) { c.moveTo(x, -116); c.lineTo(x + 6, -88); }
    c.moveTo(60, 10); c.lineTo(95, 55);
    for (let i = 0; i < 4; i++) { c.moveTo(66 + i * 9, 12 + i * 12); c.lineTo(78 + i * 9, 6 + i * 12); }
    c.stroke();
    c.fillStyle = '#0d0508';
    c.beginPath();
    c.ellipse(-8, 98, 56, 72 + Math.random() * 8, -0.08, 0, 7);
    c.fill();
    c.fillStyle = '#cfc4ae';
    for (let i = -4; i <= 4; i++) {
      c.beginPath();
      c.moveTo(i * 12 - 12, 40);
      c.lineTo(i * 12 - 4, 40);
      c.lineTo(i * 12 - 8, 66 + Math.abs(i) * 3);
      c.closePath(); c.fill();
    }
    c.strokeStyle = 'rgba(90,10,10,0.85)';
    c.lineWidth = 6;
    c.beginPath();
    c.moveTo(-34, 132); c.lineTo(-40, 186);
    c.moveTo(20, 144); c.lineTo(26, 192);
    c.stroke();
    c.restore();
  }

  function scareGrin(c, t) {
    const vib = Math.sin(t * 47) * 2;
    c.fillStyle = '#e8e4da';
    c.shadowColor = '#fff'; c.shadowBlur = 18;
    c.beginPath(); c.arc(-55 + vib, -95, 6, 0, 7); c.fill();
    c.beginPath(); c.arc(62 - vib, -118, 7.5, 0, 7); c.fill();
    c.shadowBlur = 0;
    c.fillStyle = '#000';
    c.beginPath(); c.arc(-55 + vib, -95, 2.2, 0, 7); c.fill();
    c.beginPath(); c.arc(62 - vib, -118, 2.6, 0, 7); c.fill();
    c.save();
    c.rotate(-0.06);
    c.fillStyle = '#0a0405';
    c.beginPath();
    c.moveTo(-150, 30);
    c.quadraticCurveTo(0, 190, 150, 20);
    c.quadraticCurveTo(0, 110, -150, 30);
    c.closePath(); c.fill();
    c.fillStyle = '#ddd6c2';
    c.shadowColor = 'rgba(230,220,190,0.6)'; c.shadowBlur = 8;
    for (let i = -7; i <= 7; i++) {
      const x = i * 19 + (i % 2) * 4;
      const baseY = 42 + Math.cos(i * 0.24) * 44;
      const len = 34 + ((i * 7919) % 17) + (i % 2) * 12;
      c.beginPath();
      c.moveTo(x - 6, baseY);
      c.lineTo(x + 6, baseY);
      c.lineTo(x + 1, baseY + len);
      c.closePath(); c.fill();
      c.beginPath();
      c.moveTo(x - 5 + 9, baseY + 74);
      c.lineTo(x + 5 + 9, baseY + 74);
      c.lineTo(x + 9, baseY + 74 - (len * 0.6));
      c.closePath(); c.fill();
    }
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(200,205,190,0.35)';
    c.lineWidth = 1.5;
    for (const x of [-60, -10, 45]) {
      c.beginPath();
      c.moveTo(x, 70);
      c.quadraticCurveTo(x + 4, 95 + Math.sin(t * 9 + x) * 6, x - 2, 118);
      c.stroke();
    }
    c.restore();
  }

  function scareEye(c, k, t) {
    const bg = c.createRadialGradient(0, 0, 20, 0, 0, 195);
    bg.addColorStop(0, '#e9e2d4');
    bg.addColorStop(0.75, '#cdbfa8');
    bg.addColorStop(1, '#6d5648');
    c.fillStyle = bg;
    c.beginPath(); c.ellipse(0, 0, 195, 150, 0, 0, 7); c.fill();
    c.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const a = i * 0.45 + 0.2;
      let x = Math.cos(a) * 185, y = Math.sin(a) * 142;
      let w = 3.2;
      c.strokeStyle = 'rgba(150,20,16,0.65)';
      for (let s = 0; s < 5; s++) {
        const nx = x * 0.62 + (Math.random() - 0.5) * 22;
        const ny = y * 0.62 + (Math.random() - 0.5) * 18;
        c.lineWidth = w;
        c.beginPath(); c.moveTo(x, y); c.lineTo(nx, ny); c.stroke();
        x = nx; y = ny; w *= 0.66;
      }
    }
    const ig = c.createRadialGradient(0, 0, 8, 0, 0, 78);
    ig.addColorStop(0, '#3d0d0d');
    ig.addColorStop(0.75, '#7a1e14');
    ig.addColorStop(1, '#2a0806');
    c.fillStyle = ig;
    c.beginPath(); c.arc(0, 0, 78, 0, 7); c.fill();
    c.strokeStyle = 'rgba(20,4,4,0.5)';
    c.lineWidth = 1.4;
    for (let i = 0; i < 26; i++) {
      const a = i * 0.242;
      c.beginPath();
      c.moveTo(Math.cos(a) * 22, Math.sin(a) * 22);
      c.lineTo(Math.cos(a + 0.08) * 74, Math.sin(a + 0.08) * 74);
      c.stroke();
    }
    const pw = Math.max(4, 26 - k * 20) + Math.sin(t * 30) * 1.5;
    c.fillStyle = '#020101';
    c.beginPath(); c.ellipse(0, 0, pw, 66, 0, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,250,240,0.5)';
    c.beginPath(); c.ellipse(-34, -44, 16, 9, -0.5, 0, 7); c.fill();
    c.fillStyle = '#160c0a';
    c.beginPath();
    c.moveTo(-220, -170); c.quadraticCurveTo(0, -60 - Math.sin(t * 4) * 10, 220, -170);
    c.lineTo(220, -220); c.lineTo(-220, -220);
    c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(-220, 170); c.quadraticCurveTo(0, 66 + Math.sin(t * 4) * 8, 220, 170);
    c.lineTo(220, 220); c.lineTo(-220, 220);
    c.closePath(); c.fill();
    c.strokeStyle = '#0a0605';
    c.lineWidth = 3;
    for (let i = -5; i <= 5; i++) {
      c.beginPath();
      c.moveTo(i * 34, -96 + Math.abs(i) * 7);
      c.lineTo(i * 34 + 6, -66 + Math.abs(i) * 7);
      c.stroke();
    }
  }

  function scareNurse(c, t) {
    c.save();
    c.rotate(-0.22 + Math.sin(t * 38) * 0.01);
    const fg = c.createRadialGradient(0, -30, 20, 0, 0, 190);
    fg.addColorStop(0, '#b9b4ac');
    fg.addColorStop(0.7, '#8d887f');
    fg.addColorStop(1, '#4a453e');
    c.fillStyle = fg;
    c.beginPath();
    c.moveTo(0, -165);
    c.bezierCurveTo(95, -158, 112, -50, 96, 55);
    c.bezierCurveTo(82, 150, 28, 188, 0, 188);
    c.bezierCurveTo(-28, 188, -82, 150, -96, 55);
    c.bezierCurveTo(-112, -50, -95, -158, 0, -165);
    c.fill();
    c.fillStyle = '#050304';
    c.beginPath(); c.ellipse(-44, -52, 30, 38, -0.15, 0, 7); c.fill();
    c.beginPath(); c.ellipse(46, -48, 27, 34, 0.15, 0, 7); c.fill();
    c.fillStyle = '#e8e4da';
    c.shadowColor = '#fff'; c.shadowBlur = 10;
    c.beginPath(); c.arc(48, -46, 3.4, 0, 7); c.fill();
    c.shadowBlur = 0;
    c.fillStyle = '#a9a294';
    c.beginPath();
    c.moveTo(-92, 8);
    c.quadraticCurveTo(0, -14, 92, 8);
    c.quadraticCurveTo(78, 120, 0, 150);
    c.quadraticCurveTo(-78, 120, -92, 8);
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(60,55,45,0.55)';
    c.lineWidth = 2;
    for (const yy of [34, 62, 92]) {
      c.beginPath();
      c.moveTo(-80 + yy * 0.3, yy);
      c.quadraticCurveTo(0, yy + 14, 80 - yy * 0.3, yy);
      c.stroke();
    }
    c.fillStyle = 'rgba(96,12,10,0.75)';
    c.beginPath();
    c.ellipse(4, 66, 52, 26 + Math.sin(t * 6) * 3, 0.05, 0, 7);
    c.fill();
    c.fillStyle = 'rgba(96,12,10,0.45)';
    c.beginPath();
    c.ellipse(-20, 96, 18, 26, 0.3, 0, 7);
    c.fill();
    c.strokeStyle = '#7a7468';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(-90, 14); c.lineTo(-150, -6);
    c.moveTo(90, 14); c.lineTo(150, -6);
    c.stroke();
    c.strokeStyle = 'rgba(14,10,8,0.9)';
    c.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const x0 = -85 + i * 11 + (i % 3) * 3;
      c.lineWidth = 2.5 + (i % 3);
      c.beginPath();
      c.moveTo(x0, -160);
      c.quadraticCurveTo(x0 + 14, -40, x0 + (i % 2 ? 20 : -8), 30 + (i % 5) * 26);
      c.stroke();
    }
    c.restore();
  }

  // ---------- обновление эффектов ----------
  function updateEffects(dt, view) {
    fx.flickerTimer -= dt;
    if (fx.flickerTimer <= 0) {
      if (fx.flicker > 0.5) {
        if (Math.random() < 0.06) { fx.flicker = 0.05; fx.flickerTimer = 0.15 + Math.random() * 0.45; }
        else { fx.flicker = 0.86 + Math.random() * 0.14; fx.flickerTimer = 0.05 + Math.random() * 0.15; }
      } else {
        fx.flicker = 1; fx.flickerTimer = 2 + Math.random() * 6;
      }
    }
    fx.lightning *= Math.pow(0.004, dt);
    fx.lightningNext -= dt;
    if (fx.lightningNext <= 0) {
      fx.lightning = 0.7 + Math.random() * 0.3;
      if (fx.lightningStrobe > 0) {
        fx.lightningStrobe--;
        fx.lightningNext = 0.1 + Math.random() * 0.18;
      } else {
        fx.lightningStrobe = 1 + (Math.random() * 2 | 0);
        fx.lightningNext = 16 + Math.random() * 26;
        if (GameAudio.ready) setTimeout(() => GameAudio.thunder(), 400 + Math.random() * 1000);
      }
    }
    fx.glitch = Math.max(0, fx.glitch - dt * 2.2);
    fx.faceFlash = Math.max(0, fx.faceFlash - dt);
    if (fx.scareShadow) fx.scareShadow.ttl -= dt;
    if (fx.shadowPending) {
      fx.shadowPending = false;
      // тень — впереди по взгляду, за пару клеток
      const d = 220 + Math.random() * 120;
      fx.scareShadow = {
        x: view.me.x + Math.cos(view.me.angle) * d + (Math.random() - 0.5) * 60,
        y: view.me.y + Math.sin(view.me.angle) * d + (Math.random() - 0.5) * 60,
        ttl: 0.8,
      };
    }
    if (view.catchActive) {
      if (!fx.catchWasActive) fx.scareVariant = pickScareVariant();
      fx.catchFace = Math.min(1, fx.catchFace + dt * 5);
    } else {
      fx.catchFace = Math.max(0, fx.catchFace - dt * 3);
    }
    fx.catchWasActive = !!view.catchActive;

    // экранный туман дрейфует
    for (const b of fx.fogBlobs) {
      b.x += b.vx * dt;
      if (b.x < -0.4) b.x += 1.8;
      if (b.x > 1.4) b.x -= 1.8;
    }
    // пылинки в луче — экранные, летят навстречу
    if (view.role === 'survivor' && !view.me.hidden) {
      while (fx.dust.length < 42) {
        fx.dust.push({
          x: W * (0.25 + Math.random() * 0.5),
          y: H * (0.2 + Math.random() * 0.55),
          s: 0.8 + Math.random() * 2,
          a: 0.1 + Math.random() * 0.35,
          vx: (Math.random() - 0.5) * 30,
          vy: 10 + Math.random() * 30,
          ttl: 1.5 + Math.random() * 2,
        });
      }
      for (const d of fx.dust) {
        d.x += d.vx * dt + (d.x - W / 2) * dt * (view.me.moving ? 0.55 : 0.06);
        d.y += d.vy * dt + (d.y - H / 2) * dt * (view.me.moving ? 0.55 : 0.06);
        d.ttl -= dt;
      }
      fx.dust = fx.dust.filter(d => d.ttl > 0 && d.x > -20 && d.x < W + 20 && d.y < H + 20);
    } else {
      fx.dust.length = 0;
    }
    // крысы бегут по миру
    for (const r of fx.rats) { r.x += r.vx * dt; r.y += r.vy * dt; r.ttl -= dt; }
    fx.rats = fx.rats.filter(r => r.ttl > 0);
  }

  // ---------- триггеры ----------
  function trigger(name, data) {
    switch (name) {
      case 'glitch': fx.glitch = 1; break;
      case 'shake': cam.shake = data || 8; break;
      case 'shadow': fx.shadowPending = true; break;
      case 'lightning': fx.lightning = 1; break;
      case 'faceflash':
        fx.scareVariant = pickScareVariant();
        fx.faceFlash = 0.10;
        fx.glitch = Math.max(fx.glitch, 0.8);
        break;
      case 'forceScare': fx.scareVariant = data; break;
      case 'rat': {
        // крыса перебегает перед игроком
        const a = (data && data.angle != null ? data.angle : 0) + Math.PI / 2;
        const ahead = 120 + Math.random() * 120;
        const baseA = data && data.angle != null ? data.angle : 0;
        const cxr = cam.x + Math.cos(baseA) * ahead;
        const cyr = cam.y + Math.sin(baseA) * ahead;
        const dir = Math.random() < 0.5 ? 1 : -1;
        fx.rats.push({
          x: cxr - Math.cos(a) * 90 * dir,
          y: cyr - Math.sin(a) * 90 * dir,
          vx: Math.cos(a) * 150 * dir,
          vy: Math.sin(a) * 150 * dir,
          ttl: 2.2,
        });
        break;
      }
    }
  }

  function snapCamera(x, y) { cam.x = x; cam.y = y; }

  return {
    init, setMap, drawFrame, trigger, snapCamera, cam,
    get canvasSize() { return { W, H }; },
    get sprites() { return SPR; },   // для отладки моделей
  };
})();
