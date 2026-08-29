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
    corridor: { plaster: [64, 60, 52], paint: [42, 58, 40], grime: [30, 26, 18] },
    ward: { plaster: [70, 64, 52], paint: [66, 62, 40], grime: [36, 28, 16] },
    operating: { plaster: [60, 70, 68], paint: [40, 66, 62], grime: [22, 32, 30] },
    boiler: { plaster: [62, 50, 38], paint: [70, 48, 22], grime: [34, 22, 12] },
    morgue: { plaster: [58, 64, 70], paint: [40, 52, 64], grime: [24, 28, 34] },
    children: { plaster: [72, 62, 60], paint: [86, 54, 66], grime: [40, 26, 24] },
    storage: { plaster: [62, 62, 54], paint: [56, 56, 38], grime: [30, 30, 20] },
  };

  // ---------- текстуры стен ----------
  function makeWallTex(palKey) {
    const pal = PALETTES[palKey] || PALETTES.corridor;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    // штукатурка с шумом
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x += 4) {
        const n = tileRand(x + palKey.length * 91, y * 3) * 0.5 + 0.5;
        const k = 0.75 + n * 0.4;
        g.fillStyle = `rgb(${pal.plaster[0] * k | 0},${pal.plaster[1] * k | 0},${pal.plaster[2] * k | 0})`;
        g.fillRect(x, y, 4, 1);
      }
    }
    // нижняя панель — больничная краска
    g.fillStyle = `rgba(${pal.paint[0]},${pal.paint[1]},${pal.paint[2]},0.9)`;
    g.fillRect(0, 34, 64, 26);
    // облупившиеся пятна на краске (видна штукатурка)
    for (let i = 0; i < 7; i++) {
      const r = tileRand(i * 13 + palKey.length, i * 7);
      if (r < 0.3) continue;
      const k = 0.8 + r * 0.3;
      g.fillStyle = `rgb(${pal.plaster[0] * k | 0},${pal.plaster[1] * k | 0},${pal.plaster[2] * k | 0})`;
      const px = r * 60, py = 36 + tileRand(i, i * 3) * 20;
      g.beginPath();
      g.ellipse(px, py, 3 + r * 6, 2 + r * 4, r * 3, 0, 7);
      g.fill();
    }
    // разделительная полоса и плинтус
    g.fillStyle = 'rgba(20,16,12,0.8)';
    g.fillRect(0, 33, 64, 2);
    g.fillStyle = 'rgba(12,10,8,0.95)';
    g.fillRect(0, 60, 64, 4);
    // потолочный карниз
    g.fillStyle = 'rgba(18,15,12,0.7)';
    g.fillRect(0, 0, 64, 3);
    // грязные потёки сверху вниз
    for (let i = 0; i < 5; i++) {
      const r = tileRand(i * 31, palKey.length * 7 + i);
      if (r < 0.35) continue;
      g.fillStyle = `rgba(${pal.grime[0]},${pal.grime[1]},${pal.grime[2]},${0.25 + r * 0.3})`;
      const x = r * 62;
      g.fillRect(x, 3, 1.5 + r * 2, 20 + r * 38);
    }
    // трещины
    g.strokeStyle = 'rgba(10,8,6,0.6)';
    g.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const r = tileRand(i + 5, palKey.length * 3);
      if (r < 0.4) continue;
      g.beginPath();
      let x = r * 55, y = 4;
      g.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        x += (tileRand(x + s, y) - 0.5) * 14; y += 8 + tileRand(y, x) * 8;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    return c;
  }

  function makeWindowTex(lit) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.drawImage(wallTex.corridor, 0, 0);
    // проём
    g.fillStyle = lit ? '#cdd6ee' : '#0a0f1c';
    g.fillRect(10, 8, 44, 42);
    if (!lit) {
      const gg = g.createLinearGradient(10, 8, 54, 50);
      gg.addColorStop(0, 'rgba(70,90,130,0.25)');
      gg.addColorStop(1, 'rgba(20,26,40,0.12)');
      g.fillStyle = gg;
      g.fillRect(10, 8, 44, 42);
    } else {
      const gg = g.createRadialGradient(32, 28, 2, 32, 28, 30);
      gg.addColorStop(0, '#ffffff');
      gg.addColorStop(1, 'rgba(180,195,235,0.6)');
      g.fillStyle = gg;
      g.fillRect(10, 8, 44, 42);
    }
    // рама
    g.strokeStyle = '#38301f';
    g.lineWidth = 3;
    g.strokeRect(10, 8, 44, 42);
    g.beginPath();
    g.moveTo(32, 8); g.lineTo(32, 50);
    g.moveTo(10, 29); g.lineTo(54, 29);
    g.stroke();
    // трещины стекла
    g.strokeStyle = lit ? 'rgba(90,100,130,0.8)' : 'rgba(150,170,190,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(20, 14); g.lineTo(30, 26); g.lineTo(24, 40);
    g.moveTo(40, 12); g.lineTo(44, 24);
    g.stroke();
    return c;
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

    // Монстр: два кадра — руки в стороны / руки тянутся
    SPR.monster0 = makeMonsterSprite(0);
    SPR.monster1 = makeMonsterSprite(1);
    // светящиеся глаза отдельно (не гаснут в темноте)
    SPR.monsterEyes = spriteCanvas(64, 32, (g, w, h) => {
      for (const sx of [-1, 1]) {
        const x = w / 2 + sx * 10;
        const gr = g.createRadialGradient(x, h / 2, 0, x, h / 2, 9);
        gr.addColorStop(0, 'rgba(255,60,40,1)');
        gr.addColorStop(0.3, 'rgba(255,30,20,0.9)');
        gr.addColorStop(1, 'rgba(255,20,10,0)');
        g.fillStyle = gr;
        g.fillRect(x - 9, h / 2 - 9, 18, 18);
        g.fillStyle = '#ffd9c8';
        g.beginPath(); g.arc(x, h / 2, 1.6, 0, 7); g.fill();
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

  function makeMonsterSprite(frameNo) {
    const s = spriteCanvas(150, 240, (g, w, h) => {
      const t = frameNo * 0.9;
      // дымная аура
      for (let i = 0; i < 6; i++) {
        g.fillStyle = `rgba(8,4,10,${0.25 - i * 0.03})`;
        g.beginPath();
        g.arc(w / 2 + Math.sin(i * 2.3 + t) * 16, h * 0.45 + i * 16, 22 + i * 5, 0, 7);
        g.fill();
      }
      // худое вытянутое тело с рваными краями
      // (не чёрное: в луче фонаря силуэт должен читаться)
      const bodyGrad = g.createLinearGradient(w / 2 - 20, 0, w / 2 + 20, 0);
      bodyGrad.addColorStop(0, '#241420');
      bodyGrad.addColorStop(0.5, '#382030');
      bodyGrad.addColorStop(1, '#1c1018');
      g.fillStyle = bodyGrad;
      g.beginPath();
      g.moveTo(w / 2 - 14, h * 0.2);
      for (let i = 0; i <= 20; i++) {
        const yy = h * 0.2 + (h * 0.78) * (i / 20);
        const wob = Math.sin(i * 1.7 + t * 3) * 4 + Math.sin(i * 3.1) * 2;
        g.lineTo(w / 2 - 13 - wob - (i > 16 ? (i - 16) * 2 : 0), yy);
      }
      for (let i = 20; i >= 0; i--) {
        const yy = h * 0.2 + (h * 0.78) * (i / 20);
        const wob = Math.sin(i * 1.9 - t * 3) * 4;
        g.lineTo(w / 2 + 13 + wob + (i > 16 ? (i - 16) * 2 : 0), yy);
      }
      g.closePath(); g.fill();
      // рёбра, проступающие сквозь кожу
      g.strokeStyle = 'rgba(90,70,85,0.5)';
      g.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const yy = h * 0.32 + i * 14;
        g.beginPath();
        g.moveTo(w / 2 - 11, yy);
        g.quadraticCurveTo(w / 2, yy + 5, w / 2 + 11, yy);
        g.stroke();
      }
      // красноватый контур-обводка
      g.strokeStyle = 'rgba(200,60,55,0.35)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(w / 2 - 14, h * 0.22);
      g.quadraticCurveTo(w / 2 - 22, h * 0.5, w / 2 - 16, h * 0.9);
      g.moveTo(w / 2 + 14, h * 0.22);
      g.quadraticCurveTo(w / 2 + 22, h * 0.5, w / 2 + 16, h * 0.9);
      g.stroke();
      // длинные руки с когтями
      g.strokeStyle = '#1d1219';
      g.lineWidth = 7; g.lineCap = 'round';
      const reach = frameNo ? 30 : 12; // кадр 1 — тянется к тебе
      g.beginPath();
      g.moveTo(w / 2 - 10, h * 0.3);
      g.quadraticCurveTo(w / 2 - 44, h * 0.42, w / 2 - 34 - reach * 0.4, h * 0.62 + reach * 0.2);
      g.moveTo(w / 2 + 10, h * 0.3);
      g.quadraticCurveTo(w / 2 + 44, h * 0.42, w / 2 + 34 + reach * 0.4, h * 0.62 + reach * 0.2);
      g.stroke();
      g.lineWidth = 2.4;
      for (const sx of [-1, 1]) {
        const hx = w / 2 + sx * (34 + reach * 0.4), hy = h * 0.62 + reach * 0.2;
        for (let i = 0; i < 4; i++) {
          g.beginPath();
          g.moveTo(hx, hy);
          g.lineTo(hx + sx * (6 + i * 3), hy + 10 + i * 4);
          g.stroke();
        }
      }
      // голова, чуть набок
      g.save();
      g.translate(w / 2 + 2, h * 0.14);
      g.rotate(frameNo ? 0.24 : -0.12);
      const hg = g.createRadialGradient(-3, -4, 2, 0, 0, 17);
      hg.addColorStop(0, '#3a222e');
      hg.addColorStop(1, '#1c0e16');
      g.fillStyle = hg;
      g.beginPath(); g.ellipse(0, 0, 13, 17, 0, 0, 7); g.fill();
      // рваная пасть
      g.strokeStyle = '#3d0a0a'; g.lineWidth = 2;
      g.beginPath();
      g.moveTo(-6, 8); g.quadraticCurveTo(0, 13, 7, 7);
      g.stroke();
      g.restore();
      // хребет-шипы
      g.strokeStyle = '#060308'; g.lineWidth = 3;
      for (let i = 0; i < 5; i++) {
        const yy = h * 0.28 + i * 24;
        g.beginPath();
        g.moveTo(w / 2, yy);
        g.lineTo(w / 2 + (i % 2 ? 8 : -8), yy - 10);
        g.stroke();
      }
    });
    s.wH = 58; s.wW = 34;
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
    if (!wallTex.corridor) {
      for (const k of Object.keys(PALETTES)) wallTex[k] = makeWallTex(k);
      winTex = makeWindowTex(false);
      winLitTex = makeWindowTex(true);
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

    // --- потолок и пол ---
    let g = c.createLinearGradient(0, 0, 0, mid);
    g.addColorStop(0, isHunter ? '#170505' : '#08070a');
    g.addColorStop(1, '#010101');
    c.fillStyle = g;
    c.fillRect(0, 0, W, Math.max(0, mid));
    g = c.createLinearGradient(0, mid, 0, H);
    g.addColorStop(0, '#010101');
    g.addColorStop(1, isHunter ? '#1c0908' : '#100e0c');
    c.fillStyle = g;
    c.fillRect(0, mid, W, H - mid);
    // пятно фонарика на полу
    if (!isHunter && fx.flicker > 0.05) {
      const fg2 = c.createRadialGradient(W / 2 + shakeX, H + 40, 20, W / 2 + shakeX, H + 40, H * 0.9);
      fg2.addColorStop(0, `rgba(255,214,150,${0.14 * fx.flicker})`);
      fg2.addColorStop(0.5, `rgba(200,160,100,${0.05 * fx.flicker})`);
      fg2.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = fg2;
      c.fillRect(0, mid, W, H - mid);
    }
    if (fx.lightning > 0.05) {
      c.fillStyle = `rgba(180,190,230,${fx.lightning * 0.12})`;
      c.fillRect(0, mid, W, H - mid);
    }

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
      let texX = Math.floor(wallX * 64);
      if ((side === 0 && rdX > 0) || (side === 1 && rdY < 0)) texX = 63 - texX;

      // выбор текстуры по комнате за стеной
      let tex;
      if (tile === 4) tex = fx.lightning > 0.4 ? winLitTex : winTex;
      else tex = wallTex[roomOf[floorY] ? roomOf[floorY][floorX] : 'corridor'] || wallTex.corridor;

      const x = i * colW;
      c.drawImage(tex, texX, 0, 1, 64, x, y0, colW + 1, lineH);

      // затемнение по свету
      let b = lightAt(isHunter, camXs, dist, tile === 4);
      if (side === 1) b *= 0.78; // грани С/Ю чуть темнее — объём
      const shade = 1 - Math.min(1, b);
      if (shade > 0.01) {
        c.fillStyle = `rgba(0,0,0,${shade.toFixed(3)})`;
        c.fillRect(x, y0 - 1, colW + 1, lineH + 2);
      }
      // красный тон для Монстра — прямо на колонку
      if (isHunter && b > 0.02) {
        c.fillStyle = `rgba(120,10,10,${(b * 0.5).toFixed(3)})`;
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
        const frame2 = Math.sin(t * 6) > 0 ? SPR.monster0 : SPR.monster1;
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

      // сияние лампы
      if (it.lampGlow) {
        c.save();
        c.globalCompositeOperation = 'lighter';
        const gr = c.createRadialGradient(screenX, y0 + hPix * 0.6, 0, screenX, y0 + hPix * 0.6, hPix * 2.4);
        gr.addColorStop(0, `rgba(210,220,180,${0.16 * it.lampGlow})`);
        gr.addColorStop(1, 'rgba(210,220,180,0)');
        c.fillStyle = gr;
        c.fillRect(screenX - hPix * 2.4, y0 - hPix, hPix * 4.8, hPix * 4.5);
        c.restore();
      }
      // глаза Монстра светятся всегда
      if (it.monster) {
        const ew = (18 * proj) / trY;
        c.drawImage(SPR.monsterEyes.c, screenX - ew / 2 + wPix * 0.02, y0 + hPix * 0.10, ew, ew / 2);
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

  return { init, setMap, drawFrame, trigger, snapCamera, cam, get canvasSize() { return { W, H }; } };
})();
