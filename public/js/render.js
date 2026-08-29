// ============================================================
// render.js — отрисовка «Чернолесья», версия 2 («инди-хоррор»).
// Главное:
//  - карта пре-рендерится один раз за раунд в большой офскрин:
//    палитры по типам комнат, грязь и плесень (value-noise),
//    ambient occlusion у стен, кровавые следы, надписи, осколки
//  - фонарик: НАСТОЯЩИЕ тени — конус рейкастится по сетке стен
//    (DDA), свет не проходит сквозь стены; тёплое объёмное свечение
//  - монстр: тёмное зрение с пульсирующими «венами» по краям
//  - персонажи с анимацией ходьбы, монстр с дымом и дрожью
//  - плёночное зерно, дыхание камеры, молнии, туман, пылинки,
//    крысы, сублиминальные кадры, глитч, хроматическая аберрация
// ============================================================

'use strict';

const Render = (() => {
  let canvas, ctx;            // видимый канвас
  let frame, fctx;            // промежуточный кадр (для аберрации/глитча)
  let light, lctx;            // канвас тьмы (в половинном разрешении)
  let tintA, tctxA, tintB, tctxB; // временные для аберрации
  let mapCanvas = null;       // пре-рендер всей карты
  let veinCanvas = null;      // «вены» для зрения Монстра
  let grainCanvases = [];     // кадры плёночного зерна
  let fogSprite = null;       // спрайт пятна тумана
  let W = 0, H = 0, DPR = 1;
  const LIGHT_SCALE = 0.5;

  let map = null;
  let rngSeedCache = 0;
  let scareImages = []; // пользовательские фото-скримеры из /scares

  // камера
  const cam = { x: 0, y: 0, shake: 0 };

  // состояния эффектов
  const fx = {
    flicker: 1,               // 0..1 яркость фонаря
    flickerTimer: 0,
    lightning: 0,             // 0..1 вспышка
    lightningNext: 8,
    lightningStrobe: 0,       // счётчик мульти-вспышки
    glitch: 0,
    scareShadow: null,        // {x,y,ttl,ang} — силуэт в темноте
    faceFlash: 0,             // сублиминальный кадр с мордой
    catchFace: 0,             // 0..1 сила скримера поимки
    catchWasActive: false,    // для выбора нового варианта на каждую поимку
    scareVariant: null,       // {type:'img',img} | {type:'proc',id}
    fogBlobs: [],
    dust: [],
    rats: [],                 // бегущие крысы
    lampSeeds: [],            // мигание потолочных ламп
    grainIdx: 0,
    grainTimer: 0,
  };

  // ---------- инициализация ----------
  function init(cnv) {
    canvas = cnv;
    ctx = canvas.getContext('2d');
    frame = document.createElement('canvas');
    fctx = frame.getContext('2d');
    light = document.createElement('canvas');
    lctx = light.getContext('2d');
    tintA = document.createElement('canvas'); tctxA = tintA.getContext('2d');
    tintB = document.createElement('canvas'); tctxB = tintB.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 300));

    // подхватываем пользовательские фото-скримеры из public/scares
    fetch('/scares').then(r => r.json()).then(list => {
      for (const url of list) {
        const img = new Image();
        img.src = url;
        scareImages.push(img);
      }
    }).catch(() => {});

    // туман: несколько дрейфующих пятен
    for (let i = 0; i < 9; i++) {
      fx.fogBlobs.push({
        x: Math.random() * 2000, y: Math.random() * 1500,
        r: 200 + Math.random() * 300,
        vx: (Math.random() - 0.5) * 10, vy: (Math.random() - 0.5) * 7,
        a: 0.045 + Math.random() * 0.06,
      });
    }

    // спрайт тумана (градиент рисуем один раз, дальше только drawImage)
    fogSprite = document.createElement('canvas');
    fogSprite.width = fogSprite.height = 256;
    const fg = fogSprite.getContext('2d');
    const g = fg.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(170,180,190,1)');
    g.addColorStop(0.6, 'rgba(170,180,190,0.45)');
    g.addColorStop(1, 'rgba(170,180,190,0)');
    fg.fillStyle = g;
    fg.fillRect(0, 0, 256, 256);

    // кадры плёночного зерна
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
  }

  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    // защита от нулевого вьюпорта (свёрнутое/фоновое окно)
    W = Math.max(320, Math.floor(window.innerWidth));
    H = Math.max(320, Math.floor(window.innerHeight));
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    frame.width = W * DPR; frame.height = H * DPR;
    light.width = Math.floor(W * DPR * LIGHT_SCALE);
    light.height = Math.floor(H * DPR * LIGHT_SCALE);
    tintA.width = tintB.width = W * DPR;
    tintA.height = tintB.height = H * DPR;
    buildVeins();
  }

  // «кровеносные вены» по краям экрана — для зрения Монстра
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
      const len = 6 + Math.random() * 8;
      for (let s = 0; s < len; s++) {
        const nx = x + Math.cos(ang) * (16 + Math.random() * 22);
        const ny = y + Math.sin(ang) * (16 + Math.random() * 22);
        c.lineWidth = w;
        c.beginPath(); c.moveTo(x, y); c.lineTo(nx, ny); c.stroke();
        // ответвление
        if (Math.random() < 0.5 && w > 1.2) {
          const ba = ang + (Math.random() - 0.5) * 1.8;
          const bx = x + Math.cos(ba) * 26, by = y + Math.sin(ba) * 26;
          c.lineWidth = w * 0.5;
          c.beginPath(); c.moveTo(x, y); c.lineTo(bx, by); c.stroke();
        }
        x = nx; y = ny;
        ang += (Math.random() - 0.5) * 0.9;
        w *= 0.82;
        if (w < 0.8) break;
      }
    }
  }

  // детерминированный мини-ГПСЧ для декора тайлов
  function tileRand(x, y) {
    let h = (x * 374761393 + y * 668265263 + rngSeedCache) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  // value-noise (для органичных пятен грязи)
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const a = tileRand(xi, yi), b = tileRand(xi + 1, yi);
    const c0 = tileRand(xi, yi + 1), d = tileRand(xi + 1, yi + 1);
    const top = a + (b - a) * sx, bot = c0 + (d - c0) * sx;
    return top + (bot - top) * sy;
  }

  // ---------- палитры комнат ----------
  const PALETTES = {
    corridor: { floorA: '#232722', floorB: '#1d211c', grout: '#101310', grime: '60,55,35', paint: '#25301f' },
    ward: { floorA: '#28251d', floorB: '#221f18', grout: '#131109', grime: '70,55,30', paint: '#2c2a1c' },
    operating: { floorA: '#26302e', floorB: '#202927', grout: '#111716', grime: '40,60,55', paint: '#1f2e2c' },
    boiler: { floorA: '#2a221a', floorB: '#241d16', grout: '#140f0a', grime: '80,45,20', paint: '#33220f' },
    morgue: { floorA: '#252a2e', floorB: '#1f2428', grout: '#101418', grime: '45,50,60', paint: '#1e2731' },
    children: { floorA: '#2b2422', floorB: '#25201e', grout: '#141010', grime: '85,60,50', paint: '#3a2530' },
    storage: { floorA: '#242420', floorB: '#1e1e1a', grout: '#121210', grime: '60,60,40', paint: '#28281c' },
  };

  // ---------- пре-рендер карты ----------
  function setMap(m) {
    map = m;
    rngSeedCache = m.seed | 0;
    const T = m.TILE;
    mapCanvas = document.createElement('canvas');
    mapCanvas.width = m.W * T;
    mapCanvas.height = m.H * T;
    const c = mapCanvas.getContext('2d');

    // карта «какая комната на тайле» (для палитр)
    const roomOf = new Array(m.H);
    for (let y = 0; y < m.H; y++) roomOf[y] = new Array(m.W).fill('corridor');
    for (const r of m.rooms) {
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++)
          if (y >= 0 && x >= 0 && y < m.H && x < m.W) roomOf[y][x] = r.type;
    }

    const walk = (x, y) => x >= 0 && y >= 0 && x < m.W && y < m.H &&
      (m.grid[y][x] === 1 || m.grid[y][x] === 3 || m.grid[y][x] === 5);

    // === ПРОХОД 1: пол ===
    for (let y = 0; y < m.H; y++) {
      for (let x = 0; x < m.W; x++) {
        const t = m.grid[y][x];
        if (t !== 1 && t !== 3 && t !== 5) continue;
        const px = x * T, py = y * T;
        const pal = PALETTES[roomOf[y][x]] || PALETTES.corridor;
        const r = tileRand(x, y);

        // плитка в шахматном порядке
        c.fillStyle = (x + y) % 2 === 0 ? pal.floorA : pal.floorB;
        c.fillRect(px, py, T, T);
        // неровный тон каждой плитки
        c.fillStyle = `rgba(0,0,0,${(r * 0.18).toFixed(3)})`;
        c.fillRect(px, py, T, T);
        // затирка между плитками
        c.strokeStyle = pal.grout;
        c.lineWidth = 2;
        c.strokeRect(px + 1, py + 1, T - 2, T - 2);
        // блик на краю плитки
        c.strokeStyle = 'rgba(255,255,255,0.028)';
        c.lineWidth = 1;
        c.beginPath(); c.moveTo(px + 2, py + T - 2); c.lineTo(px + 2, py + 2); c.lineTo(px + T - 2, py + 2); c.stroke();

        // органичная грязь (2 слоя value-noise)
        const n1 = vnoise(x * 0.55 + 7, y * 0.55);
        if (n1 > 0.52) {
          c.fillStyle = `rgba(${pal.grime},${((n1 - 0.52) * 0.75).toFixed(3)})`;
          c.beginPath();
          c.ellipse(px + T / 2 + (r - 0.5) * 20, py + T / 2 + (n1 - 0.5) * 20, T * (0.3 + n1 * 0.45), T * (0.24 + r * 0.3), r * 6, 0, 7);
          c.fill();
        }
        const n2 = vnoise(x * 1.3 + 133, y * 1.3 + 55);
        if (n2 > 0.62) {
          c.fillStyle = `rgba(12,10,6,${((n2 - 0.62) * 0.9).toFixed(3)})`;
          c.beginPath();
          c.ellipse(px + T * r, py + T * n2 % T, T * 0.24, T * 0.16, n2 * 6, 0, 7);
          c.fill();
        }
        // плесень у стен
        let nearWall = !walk(x - 1, y) || !walk(x + 1, y) || !walk(x, y - 1) || !walk(x, y + 1);
        if (nearWall && r > 0.55) {
          c.fillStyle = `rgba(40,58,30,${(0.10 + r * 0.16).toFixed(3)})`;
          c.beginPath();
          c.ellipse(px + T / 2, py + T / 2, T * 0.5, T * 0.4, r * 3, 0, 7);
          c.fill();
        }

        // битая плитка: трещины и сколы
        if (r > 0.78) {
          c.strokeStyle = 'rgba(0,0,0,0.55)';
          c.lineWidth = 1.5;
          c.beginPath();
          let cx = px + T * 0.2, cy = py + T * (0.2 + r * 0.4);
          c.moveTo(cx, cy);
          for (let s = 0; s < 4; s++) {
            cx += T * (0.12 + tileRand(x + s, y - s) * 0.2);
            cy += T * (tileRand(x - s, y + s) - 0.45) * 0.4;
            c.lineTo(cx, cy);
          }
          c.stroke();
          if (r > 0.9) { // скол — виден тёмный бетон
            c.fillStyle = '#151310';
            c.beginPath();
            c.moveTo(px + T * 0.55, py + T * 0.3);
            c.lineTo(px + T * 0.85, py + T * 0.45);
            c.lineTo(px + T * 0.7, py + T * 0.75);
            c.closePath(); c.fill();
          }
        }

        if (t === 5) { // пролом стены: груда обломков
          c.fillStyle = 'rgba(20,17,13,0.5)';
          c.fillRect(px, py, T, T);
          for (let i = 0; i < 9; i++) {
            const rr = tileRand(x * 7 + i, y * 3 + i);
            const rr2 = tileRand(y + i * 3, x - i);
            c.fillStyle = ['#3b352b', '#2e2a22', '#46403433'][i % 3];
            c.save();
            c.translate(px + rr * T, py + rr2 * T);
            c.rotate(rr * 6);
            c.fillRect(-4 - rr * 5, -3 - rr2 * 4, 8 + rr * 10, 6 + rr2 * 8);
            c.restore();
          }
        }
      }
    }

    // === ПРОХОД 2: ambient occlusion — мягкая тень пола у стен ===
    const AO = 14;
    for (let y = 0; y < m.H; y++) {
      for (let x = 0; x < m.W; x++) {
        if (!walk(x, y)) continue;
        const px = x * T, py = y * T;
        if (!walk(x, y - 1)) { const g = c.createLinearGradient(0, py, 0, py + AO); g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(px, py, T, AO); }
        if (!walk(x, y + 1)) { const g = c.createLinearGradient(0, py + T, 0, py + T - AO); g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(px, py + T - AO, T, AO); }
        if (!walk(x - 1, y)) { const g = c.createLinearGradient(px, 0, px + AO, 0); g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(px, py, AO, T); }
        if (!walk(x + 1, y)) { const g = c.createLinearGradient(px + T, 0, px + T - AO, 0); g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(px + T - AO, py, AO, T); }
      }
    }

    // === ПРОХОД 3: стены ===
    for (let y = 0; y < m.H; y++) {
      for (let x = 0; x < m.W; x++) {
        const t = m.grid[y][x];
        if (t !== 2 && t !== 4) continue;
        const px = x * T, py = y * T;
        const r = tileRand(x, y);
        // какая комната прилегает (для цвета краски)
        let pal = PALETTES.corridor;
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const nx = x + dx, ny = y + dy;
          if (walk(nx, ny)) { pal = PALETTES[roomOf[ny][nx]] || pal; break; }
        }

        // тёмная основа
        c.fillStyle = '#0c0a09';
        c.fillRect(px, py, T, T);
        // штукатурка с шумом
        const n = vnoise(x * 0.8 + 31, y * 0.8 + 17);
        c.fillStyle = `rgb(${34 + n * 14 | 0},${30 + n * 12 | 0},${26 + n * 9 | 0})`;
        c.fillRect(px + 2, py + 2, T - 4, T - 4);
        // больничная краска (панель) — облупленная
        c.fillStyle = pal.paint;
        c.globalAlpha = 0.5 + n * 0.2;
        c.fillRect(px + 2, py + 2, T - 4, T - 4);
        c.globalAlpha = 1;
        if (r < 0.5) { // облупившиеся пятна — видна штукатурка
          for (let i = 0; i < 3; i++) {
            const rr = tileRand(x * 11 + i, y * 5 - i);
            if (rr < 0.5) continue;
            c.fillStyle = `rgba(${52 + rr * 26 | 0},${46 + rr * 20 | 0},${38 + rr * 14 | 0},0.9)`;
            c.save();
            c.translate(px + rr * T, py + tileRand(y + i, x + i) * T);
            c.rotate(rr * 3);
            c.fillRect(-6 - rr * 6, -4 - rr * 4, 12 + rr * 10, 8 + rr * 8);
            c.restore();
          }
        }
        // потёки сверху вниз
        if (r > 0.55) {
          c.fillStyle = 'rgba(8,7,5,0.55)';
          const sx = px + r * T * 0.8;
          c.fillRect(sx, py + 2, 2 + r * 3, T - 4);
          c.fillStyle = 'rgba(8,7,5,0.3)';
          c.fillRect(sx - 2, py + 2, 1.5, T * 0.6);
        }
        // трещины стены
        if (r > 0.8) {
          c.strokeStyle = 'rgba(5,4,3,0.7)';
          c.lineWidth = 1.5;
          c.beginPath();
          c.moveTo(px + T * 0.2, py + T * r);
          c.lineTo(px + T * 0.5, py + T * (r * 0.7));
          c.lineTo(px + T * 0.85, py + T * (r * 0.9));
          c.stroke();
        }
        // грань, обращённая к полу — подсветка кромки
        c.strokeStyle = 'rgba(0,0,0,0.85)';
        c.lineWidth = 2;
        c.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          if (!walk(x + dx, y + dy)) continue;
          c.strokeStyle = 'rgba(120,105,80,0.22)';
          c.lineWidth = 2;
          c.beginPath();
          if (dy === 1) { c.moveTo(px + 2, py + T - 2); c.lineTo(px + T - 2, py + T - 2); }
          else if (dy === -1) { c.moveTo(px + 2, py + 2); c.lineTo(px + T - 2, py + 2); }
          else if (dx === 1) { c.moveTo(px + T - 2, py + 2); c.lineTo(px + T - 2, py + T - 2); }
          else { c.moveTo(px + 2, py + 2); c.lineTo(px + 2, py + T - 2); }
          c.stroke();
        }

        if (t === 4) { // окно: рама, треснувшее стекло, ночь за ним
          c.fillStyle = '#060a12';
          c.fillRect(px + 7, py + 7, T - 14, T - 14);
          const wg = c.createLinearGradient(px, py, px + T, py + T);
          wg.addColorStop(0, 'rgba(70,90,130,0.16)');
          wg.addColorStop(1, 'rgba(20,26,40,0.1)');
          c.fillStyle = wg;
          c.fillRect(px + 7, py + 7, T - 14, T - 14);
          c.strokeStyle = '#38301f';
          c.lineWidth = 3;
          c.strokeRect(px + 7, py + 7, T - 14, T - 14);
          c.beginPath();
          c.moveTo(px + T / 2, py + 7); c.lineTo(px + T / 2, py + T - 7);
          c.moveTo(px + 7, py + T / 2); c.lineTo(px + T - 7, py + T / 2);
          c.stroke();
          // трещины и дыра
          c.strokeStyle = 'rgba(150,170,190,0.4)';
          c.lineWidth = 1;
          c.beginPath();
          const hx = px + T * (0.3 + r * 0.4), hy = py + T * (0.3 + r * 0.3);
          for (let i = 0; i < 5; i++) {
            const a = r * 7 + i * 1.25;
            c.moveTo(hx, hy);
            c.lineTo(hx + Math.cos(a) * (6 + r * 10), hy + Math.sin(a) * (6 + r * 10));
          }
          c.stroke();
          if (r > 0.6) { c.fillStyle = '#04060c'; c.beginPath(); c.arc(hx, hy, 4, 0, 7); c.fill(); }
        }
      }
    }

    // === ПРОХОД 4: кровавые следы (волочение к моргу/операционной) ===
    const bloodRooms = m.rooms.filter(r => r.type === 'morgue' || r.type === 'operating');
    const trails = 4 + bloodRooms.length * 2;
    for (let i = 0; i < trails; i++) {
      const rr = tileRand(i * 17, i * 31 + 5);
      let sx, sy;
      if (bloodRooms.length && i < bloodRooms.length * 2) {
        const room = bloodRooms[i % bloodRooms.length];
        sx = (room.x + 1 + rr * (room.w - 2)) * T;
        sy = (room.y + 1 + tileRand(i, i * 3) * (room.h - 2)) * T;
      } else {
        sx = rr * m.W * T; sy = tileRand(i * 7, i) * m.H * T;
        if (!walk(Math.floor(sx / T), Math.floor(sy / T))) continue;
      }
      let ang = rr * Math.PI * 2;
      c.strokeStyle = 'rgba(70,10,10,0.5)';
      c.lineCap = 'round';
      for (let s = 0; s < 14; s++) {
        const step = 14 + tileRand(i + s, s) * 22;
        const nx = sx + Math.cos(ang) * step, ny = sy + Math.sin(ang) * step;
        if (!walk(Math.floor(nx / T), Math.floor(ny / T))) break;
        c.lineWidth = 5 * (1 - s / 16) + 1;
        c.globalAlpha = 0.5 * (1 - s / 18);
        c.beginPath(); c.moveTo(sx, sy); c.lineTo(nx, ny); c.stroke();
        // капли рядом
        if (tileRand(s, i) > 0.5) {
          c.fillStyle = 'rgba(70,10,10,0.45)';
          c.beginPath();
          c.arc(nx + (tileRand(s + 1, i) - 0.5) * 14, ny + (tileRand(s, i + 1) - 0.5) * 14, 1.5 + tileRand(s, s + i) * 2.5, 0, 7);
          c.fill();
        }
        sx = nx; sy = ny;
        ang += (tileRand(i * 3 + s, s * 2) - 0.5) * 1.1;
      }
      c.globalAlpha = 1;
      // лужа крови в начале
      c.fillStyle = 'rgba(66,8,8,0.55)';
      c.beginPath();
      c.ellipse(sx, sy, 10 + rr * 12, 7 + rr * 8, rr * 3, 0, 7);
      c.fill();
    }

    // === ПРОХОД 5: надписи на полу (нацарапанные) ===
    const PHRASES = ['не спи', 'оно видит', 'беги', 'тише', 'они здесь', 'уходи', '6:06', 'не смотри'];
    let placed = 0;
    for (let tries = 0; tries < 300 && placed < 6; tries++) {
      const x = Math.floor(tileRand(tries, tries * 7 + 3) * m.W);
      const y = Math.floor(tileRand(tries * 3, tries) * m.H);
      if (!walk(x, y) || !walk(x + 1, y)) continue;
      const phrase = PHRASES[placed % PHRASES.length];
      const r = tileRand(x + tries, y);
      c.save();
      c.translate((x + 1) * T, (y + 0.5) * T);
      c.rotate((r - 0.5) * 0.8);
      c.font = `${15 + r * 8}px Georgia, serif`;
      c.textAlign = 'center';
      // «нацарапано»: несколько сдвинутых штрихов
      for (const [ox, oy, al] of [[0.8, 0.4, 0.5], [-0.5, -0.3, 0.4], [0, 0, 0.65]]) {
        c.fillStyle = `rgba(88,16,14,${al})`;
        c.fillText(phrase, ox, oy);
      }
      c.restore();
      placed++;
    }

    // === ПРОХОД 6: мусор — бумаги, осколки, шприцы ===
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(tileRand(i * 13, i * 5 + 1) * m.W);
      const y = Math.floor(tileRand(i * 3 + 7, i * 11) * m.H);
      if (!walk(x, y)) continue;
      const r = tileRand(x * 3 + i, y * 7);
      const px = (x + tileRand(i, x)) * T, py = (y + tileRand(y, i)) * T;
      c.save();
      c.translate(px, py);
      c.rotate(r * 6.28);
      if (r < 0.45) { // лист бумаги
        c.fillStyle = 'rgba(140,132,110,0.5)';
        c.fillRect(-6, -8, 12, 16);
        c.strokeStyle = 'rgba(60,55,45,0.5)';
        c.lineWidth = 0.7;
        for (let l = -5; l < 6; l += 3) { c.beginPath(); c.moveTo(-4, l); c.lineTo(4, l); c.stroke(); }
      } else if (r < 0.75) { // осколок стекла
        c.fillStyle = 'rgba(120,140,150,0.28)';
        c.beginPath();
        c.moveTo(0, -5); c.lineTo(4, 3); c.lineTo(-3, 4);
        c.closePath(); c.fill();
      } else { // шприц/склянка
        c.fillStyle = 'rgba(150,150,140,0.4)';
        c.fillRect(-6, -1.2, 12, 2.4);
        c.fillRect(5, -0.6, 4, 1.2);
      }
      c.restore();
    }

    // === ПРОХОД 7: мебель и декор ===
    for (const p of m.props) drawProp(c, p);

    // потолочные лампы в коридорах (свет мигает в реальном времени)
    fx.lampSeeds = [];
    for (const r of m.rooms) {
      if (r.type !== 'corridor') continue;
      const horiz = r.w >= r.h;
      const len = horiz ? r.w : r.h;
      for (let i = 3; i < len; i += 7) {
        const lx = horiz ? (r.x + i + 0.5) * T : (r.x + r.w / 2) * T;
        const ly = horiz ? (r.y + r.h / 2) * T : (r.y + i + 0.5) * T;
        const seed = tileRand(Math.floor(lx), Math.floor(ly));
        fx.lampSeeds.push({ x: lx, y: ly, dead: seed < 0.3, phase: seed * 20, broken: seed > 0.85 });
        // сам плафон
        c.save();
        c.translate(lx, ly);
        c.fillStyle = '#1a1a16';
        c.fillRect(-13, -5, 26, 10);
        c.fillStyle = seed < 0.3 ? '#26251c' : '#54523c';
        c.fillRect(-11, -3.5, 22, 7);
        c.restore();
      }
    }
  }

  // ---------- мебель и декор (top-down, детализированные) ----------
  function drawProp(c, p) {
    c.save();
    c.translate(p.x, p.y);
    const shadow = (w, h) => {
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.beginPath(); c.ellipse(3, 4, w, h, 0, 0, 7); c.fill();
    };
    switch (p.kind) {
      case 'bed': { // ржавая больничная койка
        if (p.r) c.rotate(Math.PI / 2);
        shadow(26, 18);
        c.fillStyle = '#241d17';
        c.fillRect(-24, -15, 48, 30); // рама
        c.fillStyle = '#3c322a';
        c.fillRect(-21, -12, 42, 24); // панцирная сетка
        c.strokeStyle = 'rgba(0,0,0,0.5)';
        c.lineWidth = 1;
        for (let i = -18; i <= 18; i += 4) { c.beginPath(); c.moveTo(i, -12); c.lineTo(i, 12); c.stroke(); }
        for (let j = -9; j <= 9; j += 4) { c.beginPath(); c.moveTo(-21, j); c.lineTo(21, j); c.stroke(); }
        // матрас, сползший и в пятнах
        c.save();
        c.rotate(0.06);
        c.fillStyle = '#57503f';
        c.fillRect(-19, -10, 30, 20);
        c.fillStyle = 'rgba(80,30,15,0.5)'; // пятно
        c.beginPath(); c.ellipse(-6, 2, 8, 5, 0.5, 0, 7); c.fill();
        c.fillStyle = 'rgba(30,25,15,0.6)';
        c.beginPath(); c.ellipse(4, -4, 5, 3, 0, 0, 7); c.fill();
        c.restore();
        // подушка
        c.fillStyle = '#6a6250';
        c.fillRect(-19, -9, 10, 18);
        // ржавчина на раме
        c.fillStyle = 'rgba(110,50,20,0.55)';
        c.beginPath(); c.arc(20, 12, 4, 0, 7); c.arc(-22, -13, 3, 0, 7); c.fill();
        break;
      }
      case 'crib': { // детская кроватка с прутьями
        shadow(18, 14);
        c.fillStyle = '#2b2118';
        c.fillRect(-17, -13, 34, 26);
        c.fillStyle = '#171009';
        c.fillRect(-14, -10, 28, 20);
        c.strokeStyle = '#3a2d1e';
        c.lineWidth = 2.5;
        for (let i = -12; i <= 12; i += 5) { c.beginPath(); c.moveTo(i, -13); c.lineTo(i, 13); c.stroke(); }
        c.strokeRect(-17, -13, 34, 26);
        // брошенная кукла внутри
        c.fillStyle = '#8a7a68';
        c.beginPath(); c.arc(4, 2, 3.5, 0, 7); c.fill();
        c.fillStyle = '#5c4438';
        c.fillRect(1, 4, 6, 7);
        break;
      }
      case 'closet': { // шкаф-укрытие, приоткрытый
        shadow(18, 22);
        c.fillStyle = '#1d150d';
        c.fillRect(-17, -21, 34, 42);
        c.fillStyle = '#33261a';
        c.fillRect(-15, -19, 30, 38);
        // фактура дерева
        c.strokeStyle = 'rgba(0,0,0,0.35)';
        c.lineWidth = 1;
        for (let i = -12; i <= 12; i += 5) { c.beginPath(); c.moveTo(i, -18); c.lineTo(i + 1, 18); c.stroke(); }
        // створки, одна приоткрыта — внутри чернота
        c.fillStyle = '#0a0603';
        c.fillRect(2, -17, 11, 34);
        c.strokeStyle = '#0f0a06';
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(0, -19); c.lineTo(0, 19); c.stroke();
        c.fillStyle = '#0f0a06';
        c.fillRect(-6, -3, 3, 7); c.fillRect(3, -3, 3, 7); // ручки
        break;
      }
      case 'fridge': { // холодильная камера морга
        shadow(20, 24);
        c.fillStyle = '#20262a';
        c.fillRect(-19, -23, 38, 46);
        c.fillStyle = '#333c42';
        c.fillRect(-17, -21, 34, 42);
        c.strokeStyle = '#12171b'; c.lineWidth = 2;
        c.strokeRect(-17, -21, 34, 42);
        // три ячейки, одна приоткрыта
        c.beginPath(); c.moveTo(-17, -7); c.lineTo(17, -7); c.moveTo(-17, 7); c.lineTo(17, 7); c.stroke();
        c.fillStyle = '#05080a';
        c.fillRect(-17, 7, 34, 14);
        c.fillStyle = '#454f56';
        for (const yy of [-14, 0]) { c.beginPath(); c.arc(12, yy, 2.5, 0, 7); c.fill(); }
        // из приоткрытой торчит белая ткань
        c.fillStyle = 'rgba(200,198,188,0.75)';
        c.fillRect(-14, 15, 12, 5);
        break;
      }
      case 'optable': { // операционный стол
        shadow(28, 14);
        c.fillStyle = '#2e3436';
        c.fillRect(-27, -13, 54, 26);
        c.fillStyle = '#48525a';
        c.fillRect(-25, -11, 50, 22);
        c.strokeStyle = 'rgba(255,255,255,0.06)';
        c.lineWidth = 1;
        c.strokeRect(-25, -11, 50, 22);
        // ремни
        c.fillStyle = '#26201a';
        c.fillRect(-14, -13, 5, 26); c.fillRect(8, -13, 5, 26);
        // тёмное засохшее пятно
        c.fillStyle = 'rgba(60,8,8,0.7)';
        c.beginPath(); c.ellipse(2, 0, 14, 7, 0.3, 0, 7); c.fill();
        c.fillStyle = 'rgba(60,8,8,0.4)';
        c.beginPath(); c.ellipse(-8, 6, 5, 3, 0, 0, 7); c.fill();
        // сток крови по краю
        c.strokeStyle = 'rgba(60,8,8,0.5)';
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(20, 8); c.lineTo(27, 15); c.stroke();
        break;
      }
      case 'lamp': { // хирургическая лампа на штативе
        shadow(8, 6);
        c.strokeStyle = '#2c2c2c'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(0, 0); c.lineTo(9, -13); c.stroke();
        c.fillStyle = '#3c4244';
        c.beginPath(); c.arc(12, -16, 9, 0, 7); c.fill();
        c.fillStyle = '#20262a';
        c.beginPath(); c.arc(12, -16, 5, 0, 7); c.fill();
        c.fillStyle = '#1a1a18';
        c.beginPath(); c.arc(0, 0, 4, 0, 7); c.fill();
        break;
      }
      case 'tray': { // столик с инструментами
        c.rotate(p.r * 6);
        shadow(11, 8);
        c.fillStyle = '#31383a';
        c.fillRect(-11, -8, 22, 16);
        c.fillStyle = '#454f52';
        c.fillRect(-10, -7, 20, 14);
        // скальпели, зажимы
        c.strokeStyle = '#8a9294'; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(-6, -4); c.lineTo(6, -3); c.moveTo(-5, 0); c.lineTo(5, 1); c.stroke();
        c.strokeStyle = 'rgba(70,10,10,0.7)';
        c.beginPath(); c.moveTo(-4, 4); c.lineTo(4, 5); c.stroke();
        break;
      }
      case 'boiler': { // котёл с трубами
        shadow(18, 16);
        c.fillStyle = '#241b12';
        c.beginPath(); c.arc(0, 0, 17, 0, 7); c.fill();
        c.fillStyle = '#3c2f1e';
        c.beginPath(); c.arc(0, 0, 14, 0, 7); c.fill();
        c.strokeStyle = '#14100a'; c.lineWidth = 2;
        c.beginPath(); c.arc(0, 0, 17, 0, 7); c.stroke();
        // заклёпки по кругу
        c.fillStyle = '#584732';
        for (let a = 0; a < 6.2; a += 0.8) { c.beginPath(); c.arc(Math.cos(a) * 15.5, Math.sin(a) * 15.5, 1.3, 0, 7); c.fill(); }
        // люк и вентиль
        c.fillStyle = '#1a1510';
        c.beginPath(); c.arc(0, 0, 6, 0, 7); c.fill();
        c.strokeStyle = '#6a5334'; c.lineWidth = 1.5;
        c.beginPath(); c.arc(0, 0, 4, 0, 7); c.moveTo(-4, 0); c.lineTo(4, 0); c.moveTo(0, -4); c.lineTo(0, 4); c.stroke();
        // ржавые потёки
        c.fillStyle = 'rgba(120,55,20,0.5)';
        c.beginPath(); c.ellipse(8, 10, 5, 3, 0.8, 0, 7); c.fill();
        break;
      }
      case 'pipe': { // труба с вентилем
        c.rotate(p.r * 3);
        c.fillStyle = 'rgba(0,0,0,0.4)';
        c.fillRect(-25, 2, 50, 6);
        c.fillStyle = '#33291c';
        c.fillRect(-25, -5, 50, 10);
        c.fillStyle = '#4a3c28';
        c.fillRect(-25, -5, 50, 4);
        // фланцы
        c.fillStyle = '#241c12';
        c.fillRect(-16, -7, 5, 14); c.fillRect(10, -7, 5, 14);
        // вентиль
        c.strokeStyle = '#5c4a2e'; c.lineWidth = 2;
        c.beginPath(); c.arc(0, -8, 5, 0, 7); c.stroke();
        c.beginPath(); c.moveTo(0, -3); c.lineTo(0, -5); c.stroke();
        // капающая ржавая вода
        c.fillStyle = 'rgba(90,70,40,0.5)';
        c.beginPath(); c.arc(0, 8, 2, 0, 7); c.fill();
        break;
      }
      case 'slab': { // стол морга с телом под простынёй
        shadow(24, 12);
        c.fillStyle = '#333a3e';
        c.fillRect(-23, -11, 46, 22);
        c.fillStyle = '#454f56';
        c.fillRect(-21, -9, 42, 18);
        // тело под простынёй
        c.fillStyle = 'rgba(215,212,200,0.9)';
        c.beginPath();
        c.moveTo(-18, -7);
        c.bezierCurveTo(-10, -10, 8, -9, 17, -6);
        c.lineTo(18, 6);
        c.bezierCurveTo(8, 9, -10, 8, -18, 6);
        c.closePath(); c.fill();
        // рельеф: голова и ступни
        c.fillStyle = 'rgba(150,148,138,0.7)';
        c.beginPath(); c.ellipse(-12, 0, 5, 6, 0, 0, 7); c.fill();
        c.beginPath(); c.ellipse(13, -2, 3, 2.5, 0, 0, 7); c.ellipse(13, 3, 3, 2.5, 0, 0, 7); c.fill();
        // бирка на ноге
        c.fillStyle = '#a89e6a';
        c.fillRect(15, 1, 4, 3);
        // свисающая рука...
        if (p.r > 0.5) {
          c.fillStyle = '#9a8a78';
          c.fillRect(2, 9, 3, 8);
          c.beginPath(); c.arc(3.5, 18, 2.5, 0, 7); c.fill();
        }
        break;
      }
      case 'shelf': { // стеллаж с банками
        if (p.r) c.rotate(Math.PI / 2);
        shadow(26, 10);
        c.fillStyle = '#241b10';
        c.fillRect(-25, -9, 50, 18);
        c.fillStyle = '#33271733';
        c.fillRect(-23, -7, 46, 14);
        c.strokeStyle = '#140e07'; c.lineWidth = 2;
        c.strokeRect(-25, -9, 50, 18);
        c.beginPath(); c.moveTo(-9, -9); c.lineTo(-9, 9); c.moveTo(8, -9); c.lineTo(8, 9); c.stroke();
        // банки с «чем-то»
        for (const [bx, colr] of [[-18, '90,110,60'], [-13, '110,90,50'], [1, '80,70,90'], [13, '60,90,80'], [19, '100,60,50']]) {
          c.fillStyle = `rgba(${colr},0.55)`;
          c.fillRect(bx - 2.5, -5, 5, 8);
          c.fillStyle = '#1a1610';
          c.fillRect(bx - 2.5, -6.5, 5, 2);
        }
        break;
      }
      case 'toy': { // игрушки детского крыла
        c.rotate(p.r * 6);
        const kind = Math.floor(p.r * 4) % 4;
        if (kind === 0) { // плюшевый мишка без глаза
          shadow(7, 6);
          c.fillStyle = '#4c3a28';
          c.beginPath(); c.arc(0, 1, 6, 0, 7); c.fill();
          c.beginPath(); c.arc(-4.5, -5, 3, 0, 7); c.arc(4.5, -5, 3, 0, 7); c.fill();
          c.fillStyle = '#5c4a34';
          c.beginPath(); c.arc(0, -3.5, 4.5, 0, 7); c.fill();
          c.fillStyle = '#100a06';
          c.beginPath(); c.arc(-1.8, -4, 0.9, 0, 7); c.fill();
          // вместо второго глаза — крестик ниток
          c.strokeStyle = '#100a06'; c.lineWidth = 0.8;
          c.beginPath(); c.moveTo(1, -5); c.lineTo(3, -3); c.moveTo(3, -5); c.lineTo(1, -3); c.stroke();
        } else if (kind === 1) { // кубики
          shadow(6, 5);
          c.fillStyle = '#5c3a3a';
          c.fillRect(-6, -6, 8, 8);
          c.fillStyle = '#3a4a5c';
          c.fillRect(0, -1, 7, 7);
          c.strokeStyle = 'rgba(0,0,0,0.5)';
          c.strokeRect(-6, -6, 8, 8); c.strokeRect(0, -1, 7, 7);
          c.fillStyle = 'rgba(220,210,190,0.6)';
          c.font = '6px Georgia';
          c.fillText('А', -4.5, 0);
        } else if (kind === 2) { // мячик
          shadow(6, 5);
          c.fillStyle = '#46324c';
          c.beginPath(); c.arc(0, 0, 5.5, 0, 7); c.fill();
          c.strokeStyle = '#2a1a30'; c.lineWidth = 1.5;
          c.beginPath(); c.arc(0, 0, 5.5, -0.6, 2.2); c.stroke();
          c.strokeStyle = 'rgba(255,255,255,0.12)';
          c.beginPath(); c.arc(-1.5, -1.5, 2, 3.5, 5.6); c.stroke();
        } else { // деревянная лошадка на боку
          shadow(8, 5);
          c.fillStyle = '#4a3826';
          c.beginPath();
          c.ellipse(0, 0, 8, 4, 0.2, 0, 7);
          c.fill();
          c.fillRect(4, -6, 3, 5);
          c.fillStyle = '#38281a';
          c.beginPath(); c.arc(6.5, -7, 2.5, 0, 7); c.fill();
          c.strokeStyle = '#2c1e12'; c.lineWidth = 1.5;
          c.beginPath(); c.moveTo(-7, 4); c.quadraticCurveTo(0, 7, 7, 4); c.stroke();
        }
        break;
      }
      case 'puddle': { // лужа с отражением
        c.rotate(p.r * 6);
        const rw = 17 + p.r * 13, rh = 10 + p.r * 8;
        c.fillStyle = 'rgba(16,26,34,0.65)';
        c.beginPath(); c.ellipse(0, 0, rw, rh, 0, 0, 7); c.fill();
        c.fillStyle = 'rgba(40,60,75,0.35)';
        c.beginPath(); c.ellipse(-rw * 0.15, -rh * 0.15, rw * 0.7, rh * 0.6, 0.2, 0, 7); c.fill();
        // блик
        c.fillStyle = 'rgba(140,170,190,0.14)';
        c.beginPath(); c.ellipse(-rw * 0.3, -rh * 0.3, rw * 0.25, rh * 0.16, 0.4, 0, 7); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.4)';
        c.lineWidth = 1;
        c.beginPath(); c.ellipse(0, 0, rw, rh, 0, 0, 7); c.stroke();
        break;
      }
      case 'crack': { // разлом плитки с торчащей арматурой
        c.rotate(p.r * 6);
        c.strokeStyle = 'rgba(0,0,0,0.65)';
        c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(-16, -7); c.lineTo(-5, -1); c.lineTo(-9, 9);
        c.moveTo(-5, -1); c.lineTo(9, 4); c.lineTo(16, -3);
        c.stroke();
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(-5, -1); c.lineTo(-1, -9);
        c.moveTo(9, 4); c.lineTo(11, 11);
        c.stroke();
        if (p.r > 0.6) {
          c.strokeStyle = 'rgba(90,60,30,0.6)';
          c.lineWidth = 1.5;
          c.beginPath(); c.moveTo(-3, 0); c.lineTo(4, -4); c.stroke();
        }
        break;
      }
    }
    c.restore();
  }

  // ---------- персонажи ----------
  function drawSurvivor(c, x, y, angle, moving, t) {
    c.save();
    c.translate(x, y);
    // тень
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.beginPath(); c.ellipse(0, 3, 13, 7, 0, 0, 7); c.fill();
    c.rotate(angle);
    const walk = moving ? Math.sin(t * 11) : 0;
    // ноги (шаркают при ходьбе)
    c.fillStyle = '#5a5148';
    c.beginPath(); c.ellipse(3 + walk * 4, -5, 4, 3, 0, 0, 7); c.fill();
    c.beginPath(); c.ellipse(3 - walk * 4, 5, 4, 3, 0, 0, 7); c.fill();
    // тело — больничная роба, застиранная
    const grd = c.createRadialGradient(-2, 0, 2, 0, 0, 12);
    grd.addColorStop(0, '#8d9a8e');
    grd.addColorStop(1, '#67746a');
    c.fillStyle = grd;
    c.beginPath(); c.ellipse(walk * 0.5, 0, 9.5, 11.5, 0, 0, 7); c.fill();
    // пятно на робе
    c.fillStyle = 'rgba(70,45,30,0.4)';
    c.beginPath(); c.ellipse(-3, 4, 4, 3, 0.5, 0, 7); c.fill();
    // руки: одна с фонарём вперёд, другая машет
    c.fillStyle = '#5d6960';
    c.beginPath(); c.arc(4, -9 + walk * 1.5, 3.6, 0, 7); c.fill();
    c.beginPath(); c.arc(7, 8 - walk * 1, 3.6, 0, 7); c.fill();
    // кисть с фонариком
    c.fillStyle = '#c9b598';
    c.beginPath(); c.arc(10, 7 - walk * 0.6, 2.6, 0, 7); c.fill();
    c.fillStyle = '#23252a';
    c.save();
    c.translate(12, 6.5 - walk * 0.5);
    c.fillRect(-2, -2, 10, 4);
    c.fillStyle = '#ffe9b0';
    c.fillRect(7.4, -1.6, 1.8, 3.2); // светящаяся линза
    c.restore();
    // голова
    c.fillStyle = '#c9b598';
    c.beginPath(); c.arc(3.5, 0, 6.2, 0, 7); c.fill();
    // растрёпанные волосы
    c.fillStyle = '#2b2118';
    c.beginPath(); c.arc(1.5, 0, 6.4, Math.PI * 0.55, Math.PI * 1.45); c.fill();
    for (const [hx, hy] of [[-3, -6], [-4.5, -3], [-5, 1], [-4.5, 4], [-3, 6.5]]) {
      c.beginPath(); c.ellipse(hx, hy, 2.4, 1.4, Math.atan2(hy, hx), 0, 7); c.fill();
    }
    // ухо
    c.fillStyle = '#b5a084';
    c.beginPath(); c.arc(2, -5.5, 1.5, 0, 7); c.fill();
    c.restore();
  }

  function drawMonster(c, x, y, angle, moving, t) {
    c.save();
    c.translate(x, y);
    // дымные клочья позади
    for (let i = 0; i < 5; i++) {
      const a = t * 1.7 + i * 1.3;
      const dx = -Math.cos(angle) * (10 + i * 7) + Math.sin(a * 1.7) * 6;
      const dy = -Math.sin(angle) * (10 + i * 7) + Math.cos(a * 1.3) * 6;
      c.fillStyle = `rgba(8,4,8,${0.34 - i * 0.055})`;
      c.beginPath(); c.arc(dx, dy, 8 + i * 3.5 + Math.sin(a) * 2, 0, 7); c.fill();
    }
    // тень
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.beginPath(); c.ellipse(0, 5, 18, 9, 0, 0, 7); c.fill();
    c.rotate(angle);
    const tw = moving ? Math.sin(t * 9) * 2.4 : Math.sin(t * 2) * 0.8;
    const breathe = Math.sin(t * 2.6) * 1.2;

    // длинные когтистые руки, тянущиеся вперёд
    c.strokeStyle = '#0a0709';
    c.lineWidth = 5.5;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(-2, -8);
    c.quadraticCurveTo(11, -18 + tw, 24, -13 + tw);
    c.moveTo(-2, 8);
    c.quadraticCurveTo(11, 18 - tw, 24, 13 - tw);
    c.stroke();
    // локтевые шипы
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(10, -15 + tw); c.lineTo(12, -20 + tw);
    c.moveTo(10, 15 - tw); c.lineTo(12, 20 - tw);
    c.stroke();
    // кисти с когтями
    c.fillStyle = '#0d0a0c';
    for (const s of [-1, 1]) {
      const hy = s * (13 - tw * s);
      c.beginPath(); c.arc(24, hy, 3.6, 0, 7); c.fill();
      c.lineWidth = 1.8;
      for (let i = 0; i < 4; i++) {
        c.beginPath();
        c.moveTo(24, hy);
        const ca = (i - 1.5) * 0.34;
        c.lineTo(24 + Math.cos(ca) * (9 + (i % 2) * 3), hy + Math.sin(ca) * 9 + s * 2);
        c.stroke();
      }
    }
    // тело — рваный силуэт с «дышащими» краями
    c.fillStyle = '#150a10';
    c.strokeStyle = 'rgba(190,50,50,0.3)';
    c.lineWidth = 1.5;
    c.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.32) {
      const rr = 12.5 + breathe + Math.sin(a * 4 + t * 3.2) * 2.4 + Math.sin(a * 7 - t * 2) * 1.2;
      const vx = Math.cos(a) * rr - 2, vy = Math.sin(a) * rr;
      if (a === 0) c.moveTo(vx, vy); else c.lineTo(vx, vy);
    }
    c.closePath(); c.fill(); c.stroke();
    // хребет с шипами
    c.strokeStyle = '#050305';
    c.lineWidth = 2;
    for (let i = -2; i <= 2; i++) {
      c.beginPath();
      c.moveTo(-4 + i * 3, 0);
      c.lineTo(-6 + i * 3, i % 2 ? -4 : 4);
      c.stroke();
    }
    // голова — дёргается
    const jerk = Math.sin(t * 13.7) > 0.93 ? (Math.random() - 0.5) * 5 : 0;
    c.save();
    c.translate(7, jerk * 0.4);
    c.rotate(jerk * 0.12 + Math.sin(t * 0.9) * 0.07);
    c.fillStyle = '#1c0e14';
    c.beginPath(); c.ellipse(0, 0, 7.5, 6, 0, 0, 7); c.fill();
    // пасть — рваная щель
    c.strokeStyle = '#3d0a0a';
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(3, -2.5);
    c.quadraticCurveTo(7, 0, 3, 2.5);
    c.stroke();
    // глаза с заревом
    c.fillStyle = '#ff2018';
    c.shadowColor = '#ff2018';
    c.shadowBlur = 12;
    c.beginPath(); c.arc(3, -2.8, 1.7, 0, 7); c.arc(3, 2.8, 1.7, 0, 7); c.fill();
    c.shadowBlur = 4;
    c.fillStyle = '#ffd0c0';
    c.beginPath(); c.arc(3.3, -2.8, 0.6, 0, 7); c.arc(3.3, 2.8, 0.6, 0, 7); c.fill();
    c.shadowBlur = 0;
    c.restore();
    c.restore();
  }

  // ---------- рейкастинг конуса фонаря (тени от стен) ----------
  function castRay(px, py, ang, maxDist) {
    // DDA по сетке тайлов
    const T = map.TILE;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let tX = Math.floor(px / T), tY = Math.floor(py / T);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
    const tDeltaX = Math.abs(T / (dx || 1e-9)), tDeltaY = Math.abs(T / (dy || 1e-9));
    let tMaxX = dx > 0 ? ((tX + 1) * T - px) / dx : (tX * T - px) / dx;
    let tMaxY = dy > 0 ? ((tY + 1) * T - py) / dy : (tY * T - py) / dy;
    if (!isFinite(tMaxX)) tMaxX = Infinity;
    if (!isFinite(tMaxY)) tMaxY = Infinity;
    let dist = 0;
    for (let i = 0; i < 40; i++) {
      if (tMaxX < tMaxY) { dist = tMaxX; tMaxX += tDeltaX; tX += stepX; }
      else { dist = tMaxY; tMaxY += tDeltaY; tY += stepY; }
      if (dist >= maxDist) return maxDist;
      if (tX < 0 || tY < 0 || tX >= map.W || tY >= map.H) return dist;
      const t = map.grid[tY][tX];
      if (t === 0 || t === 2 || t === 4) return Math.min(maxDist, dist + 6); // чуть внутрь стены, чтобы стена была освещена
    }
    return maxDist;
  }

  // строит полигон света (мировые координаты)
  function buildLightPolygon(px, py, ang, halfCone, reach) {
    const pts = [];
    const N = 46;
    for (let i = 0; i <= N; i++) {
      const a = ang - halfCone + (halfCone * 2) * (i / N);
      const d = castRay(px, py, a, reach);
      pts.push([px + Math.cos(a) * d, py + Math.sin(a) * d]);
    }
    return pts;
  }

  // ---------- главный кадр ----------
  function drawFrame(dt, view) {
    if (!map || !mapCanvas) return;
    const t = performance.now() / 1000;
    const isHunter = view.role === 'hunter';

    updateEffects(dt, view);

    // --- камера: сглаживание + дрожь + «дыхание» ---
    const k = 1 - Math.pow(0.001, dt);
    cam.x += (view.me.x - cam.x) * k;
    cam.y += (view.me.y - cam.y) * k;
    let shakeX = 0, shakeY = 0;
    const shakeAmp = cam.shake + (view.heart > 0.6 ? (view.heart - 0.6) * 9 : 0);
    if (shakeAmp > 0.1) {
      shakeX = (Math.random() - 0.5) * shakeAmp * 2;
      shakeY = (Math.random() - 0.5) * shakeAmp * 2;
      cam.shake *= Math.pow(0.02, dt);
    }
    const breatheScale = 1 + Math.sin(t * 0.7) * 0.004;

    // полигоны фонаря: три вложенных конуса для мягких краёв
    let lightPolys = null;
    const flOn = !isHunter && !view.me.hidden && fx.flicker > 0.05;
    if (flOn) {
      const reach = 315 * (0.9 + fx.flicker * 0.1);
      lightPolys = [
        { poly: buildLightPolygon(view.me.x, view.me.y, view.me.angle, 0.50, reach), a: 0.42 },
        { poly: buildLightPolygon(view.me.x, view.me.y, view.me.angle, 0.40, reach), a: 0.62 },
        { poly: buildLightPolygon(view.me.x, view.me.y, view.me.angle, 0.28, reach), a: 1.0 },
      ];
    }

    const c = fctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);

    c.save();
    c.translate(W / 2, H / 2);
    c.scale(breatheScale, breatheScale);
    c.translate(-cam.x + shakeX, -cam.y + shakeY);

    // --- мир: видимый кусок пре-рендера ---
    const vx = cam.x - W / 2 - 80, vy = cam.y - H / 2 - 80;
    const vw = W + 160, vh = H + 160;
    const sx = Math.max(0, vx), sy = Math.max(0, vy);
    const sw = Math.min(mapCanvas.width - sx, vw - (sx - vx));
    const sh = Math.min(mapCanvas.height - sy, vh - (sy - vy));
    if (sw > 0 && sh > 0) c.drawImage(mapCanvas, sx, sy, sw, sh, sx, sy, sw, sh);

    // --- проверенное укрытие (вспышка-отметка) ---
    if (view.spotFlash && view.spotFlash.ttl > 0) {
      const a = Math.min(1, view.spotFlash.ttl);
      c.strokeStyle = `rgba(255,80,60,${a * 0.8})`;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(view.spotFlash.x, view.spotFlash.y, 30 * (2 - a), 0, 7);
      c.stroke();
    }

    // --- крысы ---
    for (const r of fx.rats) {
      c.save();
      c.translate(r.x, r.y);
      c.rotate(Math.atan2(r.vy, r.vx));
      c.fillStyle = 'rgba(12,10,8,0.92)';
      c.beginPath(); c.ellipse(0, 0, 7, 3.2, 0, 0, 7); c.fill();
      c.beginPath(); c.arc(6, 0, 2.2, 0, 7); c.fill();
      // хвост извивается
      c.strokeStyle = 'rgba(20,14,10,0.8)';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(-6, 0);
      c.quadraticCurveTo(-11, Math.sin(t * 22) * 3, -15, Math.sin(t * 22 + 1) * 4);
      c.stroke();
      c.restore();
    }

    // --- персонажи ---
    if (view.foe && view.foe.visible) {
      if (isHunter) drawSurvivor(c, view.foe.x, view.foe.y, view.foe.angle, view.foe.moving, t);
      else drawMonster(c, view.foe.x, view.foe.y, view.foe.angle, view.foe.moving, t);
    }
    if (!view.me.hidden) {
      if (isHunter) drawMonster(c, view.me.x, view.me.y, view.me.angle, view.me.moving, t);
      else drawSurvivor(c, view.me.x, view.me.y, view.me.angle, view.me.moving, t);
    }

    // --- тень-скример: высокий худой силуэт с горящими глазами ---
    if (fx.scareShadow && fx.scareShadow.ttl > 0) {
      const s = fx.scareShadow;
      c.save();
      c.globalAlpha = Math.min(0.9, s.ttl * 2.2);
      c.translate(s.x, s.y);
      c.fillStyle = '#030205';
      // вытянутое тело
      c.beginPath(); c.ellipse(0, 0, 7, 30, 0, 0, 7); c.fill();
      // тонкие длинные руки
      c.strokeStyle = '#030205';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(0, -14); c.quadraticCurveTo(-14, 4, -12, 26);
      c.moveTo(0, -14); c.quadraticCurveTo(14, 4, 12, 26);
      c.stroke();
      // голова, наклонённая набок
      c.save();
      c.translate(0, -34);
      c.rotate(0.35);
      c.beginPath(); c.ellipse(0, 0, 6.5, 8, 0, 0, 7); c.fill();
      c.fillStyle = 'rgba(220,40,30,0.9)';
      c.beginPath(); c.arc(-2, -1, 1, 0, 7); c.arc(2.5, -1, 1, 0, 7); c.fill();
      c.restore();
      c.restore();
    }

    // --- туман: два слоя разной скорости ---
    for (let i = 0; i < fx.fogBlobs.length; i++) {
      const b = fx.fogBlobs[i];
      c.globalAlpha = b.a * (1 + Math.sin(t * 0.5 + i) * 0.3);
      c.drawImage(fogSprite, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    }
    c.globalAlpha = 1;

    // --- пылинки в луче фонаря ---
    if (flOn) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const d of fx.dust) {
        c.globalAlpha = d.a * fx.flicker * Math.min(1, d.ttl);
        c.fillStyle = '#d8dcd0';
        c.fillRect(d.x, d.y, d.s, d.s);
      }
      c.restore();
      c.globalAlpha = 1;
    }

    // --- тёплое объёмное свечение фонаря (аддитивно, по полигону) ---
    if (flOn && lightPolys) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      const g = c.createRadialGradient(view.me.x, view.me.y, 12, view.me.x, view.me.y, 315);
      g.addColorStop(0, `rgba(255,205,130,${0.13 * fx.flicker})`);
      g.addColorStop(0.45, `rgba(215,170,100,${0.06 * fx.flicker})`);
      g.addColorStop(1, 'rgba(170,130,75,0)');
      c.fillStyle = g;
      const mid = lightPolys[1].poly;
      c.beginPath();
      c.moveTo(view.me.x, view.me.y);
      for (const [lx, ly] of mid) c.lineTo(lx, ly);
      c.closePath();
      c.fill();
      c.restore();
    }

    c.restore(); // конец мировых координат

    // --- красное зрение Монстра ---
    if (isHunter) {
      c.save();
      c.globalCompositeOperation = 'multiply';
      const pulse = 0.92 + Math.sin(t * 2.2) * 0.08;
      c.fillStyle = `rgb(${170 * pulse | 0},${58 * pulse | 0},${52 * pulse | 0})`;
      c.fillRect(0, 0, W, H);
      c.restore();
    }

    // --- следы Выжившего (видит только Монстр, светятся сквозь тьму) ---
    if (isHunter && view.footprints && view.footprints.length) {
      c.save();
      c.translate(W / 2, H / 2);
      c.scale(breatheScale, breatheScale);
      c.translate(-cam.x + shakeX, -cam.y + shakeY);
      for (const fp of view.footprints) {
        const age = fp.age;
        if (age >= 1) continue;
        const alpha = (1 - age) * 0.9;
        c.save();
        c.translate(fp.x, fp.y);
        c.fillStyle = `rgba(120,255,170,${alpha})`;
        c.shadowColor = `rgba(120,255,170,${alpha})`;
        c.shadowBlur = 12;
        c.beginPath(); c.ellipse(-4, -5, 3, 5.5, 0.3, 0, 7); c.fill();
        c.beginPath(); c.ellipse(4, 5, 3, 5.5, 0.3, 0, 7); c.fill();
        c.restore();
      }
      c.restore();
      c.shadowBlur = 0;
    }

    // --- слой тьмы и света ---
    drawLighting(view, isHunter, shakeX, shakeY, lightPolys, breatheScale, t);
    c.drawImage(light, 0, 0, light.width, light.height, 0, 0, W, H);

    // --- молния ---
    if (fx.lightning > 0.01) {
      c.save();
      c.globalCompositeOperation = 'screen';
      c.fillStyle = `rgba(185,195,235,${fx.lightning * 0.5})`;
      c.fillRect(0, 0, W, H);
      c.restore();
    }

    // --- «вены» Монстра ---
    if (isHunter && veinCanvas) {
      c.globalAlpha = 0.5 + Math.sin(t * 2.2) * 0.25;
      c.drawImage(veinCanvas, 0, 0);
      c.globalAlpha = 1;
    }

    // --- виньетка + красная пульсация при опасности ---
    const vg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.30, W / 2, H / 2, Math.max(W, H) * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.86)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);

    if (view.heart > 0.35 && !isHunter) {
      const pulse = (Math.sin(t * (4 + view.heart * 8)) * 0.5 + 0.5) * (view.heart - 0.3);
      const rg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.7);
      rg.addColorStop(0, 'rgba(120,0,0,0)');
      rg.addColorStop(1, `rgba(150,8,8,${pulse * 0.6})`);
      c.fillStyle = rg;
      c.fillRect(0, 0, W, H);
    }

    // --- плёночное зерно ---
    fx.grainTimer -= dt;
    if (fx.grainTimer <= 0) { fx.grainTimer = 0.045; fx.grainIdx = (fx.grainIdx + 1) % grainCanvases.length; }
    const gp = c.createPattern(grainCanvases[fx.grainIdx], 'repeat');
    c.save();
    c.globalCompositeOperation = 'overlay';
    c.globalAlpha = 0.32;
    c.fillStyle = gp;
    c.fillRect(0, 0, W, H);
    c.restore();

    // --- сублиминальный кадр ---
    if (fx.faceFlash > 0) drawCatchFace(c, 0.55, t, true);

    // --- скример поимки ---
    if (fx.catchFace > 0.01) drawCatchFace(c, fx.catchFace, t, false);

    // ---------- вывод кадра (+аберрация/глитч) ----------
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

    // глитч: рваные полосы
    if (fx.glitch > 0.05) {
      const n = 3 + Math.floor(fx.glitch * 7);
      for (let i = 0; i < n; i++) {
        const y = Math.random() * canvas.height;
        const h = (2 + Math.random() * 16) * DPR;
        const shift = (Math.random() - 0.5) * 70 * fx.glitch * DPR;
        ctx.drawImage(canvas, 0, y, canvas.width, h, shift, y, canvas.width, h);
      }
      if (Math.random() < fx.glitch * 0.5) {
        ctx.fillStyle = `rgba(${Math.random() * 255 | 0},255,255,0.07)`;
        ctx.fillRect(0, Math.random() * canvas.height, canvas.width, 2 * DPR);
      }
    }
  }

  // ---------- освещение ----------
  function drawLighting(view, isHunter, shakeX, shakeY, lightPolys, bs, t) {
    const lw = light.width, lh = light.height;
    const s = LIGHT_SCALE * DPR;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';

    // базовая тьма
    const darkAlpha = Math.max(0.15, (isHunter ? 0.90 : 0.972) - fx.lightning * 0.8);
    lctx.fillStyle = isHunter ? `rgba(10,0,0,${darkAlpha})` : `rgba(1,1,4,${darkAlpha})`;
    lctx.fillRect(0, 0, lw, lh);

    // мировые координаты -> координаты канваса света
    const wx = (x) => (W / 2 + (x - cam.x + shakeX) * bs) * s;
    const wy = (y) => (H / 2 + (y - cam.y + shakeY) * bs) * s;

    const px = wx(view.me.x), py = wy(view.me.y);

    lctx.globalCompositeOperation = 'destination-out';

    // тусклые лампы в коридорах, мигающие
    for (const lamp of fx.lampSeeds) {
      const dx = lamp.x - cam.x, dy = lamp.y - cam.y;
      if (Math.abs(dx) > W / 2 + 260 || Math.abs(dy) > H / 2 + 260) continue;
      if (lamp.dead) continue;
      let inten = 0.16 + Math.sin(t * 3 + lamp.phase) * 0.03;
      if (lamp.broken) { // сломанная — резко мигает
        inten *= (Math.sin(t * 17 + lamp.phase * 9) > 0.4 ? 1 : 0.12);
      }
      const lx = wx(lamp.x), ly = wy(lamp.y);
      const r = 120 * s;
      const g = lctx.createRadialGradient(lx, ly, 0, lx, ly, r);
      g.addColorStop(0, `rgba(0,0,0,${inten})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.beginPath(); lctx.arc(lx, ly, r, 0, 7); lctx.fill();
    }

    if (isHunter) {
      // тёмное зрение: широкий круг
      const r = 345 * s;
      const g = lctx.createRadialGradient(px, py, r * 0.1, px, py, r);
      g.addColorStop(0, 'rgba(0,0,0,0.95)');
      g.addColorStop(0.6, 'rgba(0,0,0,0.6)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = g;
      lctx.beginPath(); lctx.arc(px, py, r, 0, 7); lctx.fill();
    } else if (!view.me.hidden) {
      if (lightPolys) {
        // три вложенных конуса с тенями от стен — мягкие края
        const reach = 315 * s;
        for (const { poly, a } of lightPolys) {
          const g = lctx.createRadialGradient(px, py, 8 * s, px, py, reach);
          g.addColorStop(0, `rgba(0,0,0,${(0.92 * a * fx.flicker).toFixed(3)})`);
          g.addColorStop(0.6, `rgba(0,0,0,${(0.66 * a * fx.flicker).toFixed(3)})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          lctx.fillStyle = g;
          lctx.beginPath();
          lctx.moveTo(px, py);
          for (const [lx2, ly2] of poly) lctx.lineTo(wx(lx2), wy(ly2));
          lctx.closePath();
          lctx.fill();
        }
      }
      // ореол вокруг игрока
      const ar = 74 * s;
      const ag = lctx.createRadialGradient(px, py, 0, px, py, ar);
      ag.addColorStop(0, 'rgba(0,0,0,0.8)');
      ag.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = ag;
      lctx.beginPath(); lctx.arc(px, py, ar, 0, 7); lctx.fill();
    } else {
      // в укрытии: щёлка света
      const ar = 46 * s;
      const ag = lctx.createRadialGradient(px, py, 0, px, py, ar);
      ag.addColorStop(0, 'rgba(0,0,0,0.5)');
      ag.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = ag;
      lctx.beginPath(); lctx.arc(px, py, ar, 0, 7); lctx.fill();
    }

    // окна при молнии прорезают тьму
    if (fx.lightning > 0.05 && map) {
      const T = map.TILE;
      const x0 = Math.max(0, Math.floor((cam.x - W / 2) / T) - 1);
      const y0 = Math.max(0, Math.floor((cam.y - H / 2) / T) - 1);
      const x1 = Math.min(map.W - 1, Math.ceil((cam.x + W / 2) / T) + 1);
      const y1 = Math.min(map.H - 1, Math.ceil((cam.y + H / 2) / T) + 1);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (map.grid[ty][tx] !== 4) continue;
          const cx2 = wx((tx + 0.5) * T), cy2 = wy((ty + 0.5) * T);
          const r = 170 * s * fx.lightning;
          const g = lctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, r);
          g.addColorStop(0, `rgba(0,0,0,${fx.lightning})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          lctx.fillStyle = g;
          lctx.beginPath(); lctx.arc(cx2, cy2, r, 0, 7); lctx.fill();
        }
      }
    }
  }

  // ==========================================================
  // СКРИМЕРЫ: на каждую поимку — случайный вариант.
  // Пользовательские фото из public/scares участвуют в лотерее
  // с двойным весом; всегда есть 4 процедурных морды.
  // ==========================================================
  function pickScareVariant() {
    const pool = [];
    for (const img of scareImages) {
      if (img.complete && img.naturalWidth > 0) {
        pool.push({ type: 'img', img }, { type: 'img', img }); // двойной вес
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
    // стробящий фон: чёрный / глубоко-красный
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

    // общий слой: кровавые вертикальные подтёки по экрану
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
    // виньетка поверх
    const vg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.22, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.9)');
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
    c.restore();
    c.globalAlpha = 1;
  }

  // --- фото-скример: во весь экран, с рывками зума и красным стробом ---
  function drawPhotoScare(c, img, k, t, jx, jy) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    // cover: заполняем экран с сохранением пропорций + дёргающийся зум
    const zoom = 1.04 + k * 0.16 + (Math.floor(t * 26) % 2) * 0.025;
    const s = Math.max(W / iw, H / ih) * zoom;
    const dw = iw * s, dh = ih * s;
    c.drawImage(img, W / 2 - dw / 2 + jx * 1.6, H / 2 - dh / 2 + jy * 1.6, dw, dh);
    // красный строб-мультипляй
    const pulse = 0.5 + Math.sin(t * 34) * 0.5;
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = `rgb(${200 + pulse * 55 | 0},${70 + pulse * 60 | 0},${60 + pulse * 50 | 0})`;
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
    // рваные тёмные полосы (глитч телекамеры)
    c.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 0; i < 4; i++) {
      if (Math.random() < 0.5) continue;
      const y = Math.random() * H;
      c.fillRect(0, y, W, 2 + Math.random() * 5);
    }
  }

  // --- вариант 0: «Бледный» — асимметричное лицо со швами ---
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
    // прожилки
    c.strokeStyle = 'rgba(70,60,80,0.55)';
    c.lineWidth = 1.6;
    for (let i = 0; i < 9; i++) {
      const a0 = i * 0.72 + 0.3;
      c.beginPath();
      c.moveTo(Math.cos(a0) * 100, Math.sin(a0) * 130 - 20);
      c.quadraticCurveTo(Math.cos(a0) * 60, Math.sin(a0) * 80 - 10, Math.cos(a0 + 0.4) * 40, Math.sin(a0 + 0.4) * 50);
      c.stroke();
    }
    // впадины глаз: правый ниже и крупнее — асимметрия пугает
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
    // швы через лоб и щёку
    c.strokeStyle = '#54423a';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(-62, -108); c.lineTo(52, -92);
    for (let x = -55; x < 50; x += 14) { c.moveTo(x, -116); c.lineTo(x + 6, -88); }
    c.moveTo(60, 10); c.lineTo(95, 55);
    for (let i = 0; i < 4; i++) { c.moveTo(66 + i * 9, 12 + i * 12); c.lineTo(78 + i * 9, 6 + i * 12); }
    c.stroke();
    // разинутый рот со сдвигом
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

  // --- вариант 1: «Ухмылка во тьме» — только зубы и глаза ---
  function scareGrin(c, t) {
    const vib = Math.sin(t * 47) * 2;
    // глаза-точки на разной высоте
    c.fillStyle = '#e8e4da';
    c.shadowColor = '#fff'; c.shadowBlur = 18;
    c.beginPath(); c.arc(-55 + vib, -95, 6, 0, 7); c.fill();
    c.beginPath(); c.arc(62 - vib, -118, 7.5, 0, 7); c.fill();
    c.shadowBlur = 0;
    c.fillStyle = '#000';
    c.beginPath(); c.arc(-55 + vib, -95, 2.2, 0, 7); c.fill();
    c.beginPath(); c.arc(62 - vib, -118, 2.6, 0, 7); c.fill();
    // огромная серповидная ухмылка
    c.save();
    c.rotate(-0.06);
    c.fillStyle = '#0a0405';
    c.beginPath();
    c.moveTo(-150, 30);
    c.quadraticCurveTo(0, 190, 150, 20);
    c.quadraticCurveTo(0, 110, -150, 30);
    c.closePath(); c.fill();
    // длинные тонкие зубы, неровные
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
      // нижний ряд навстречу
      c.beginPath();
      c.moveTo(x - 5 + 9, baseY + 74);
      c.lineTo(x + 5 + 9, baseY + 74);
      c.lineTo(x + 9, baseY + 74 - (len * 0.6));
      c.closePath(); c.fill();
    }
    c.shadowBlur = 0;
    // нити слюны
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

  // --- вариант 2: «Глаз» — гигантское налитое кровью око ---
  function scareEye(c, k, t) {
    // белок
    const bg = c.createRadialGradient(0, 0, 20, 0, 0, 195);
    bg.addColorStop(0, '#e9e2d4');
    bg.addColorStop(0.75, '#cdbfa8');
    bg.addColorStop(1, '#6d5648');
    c.fillStyle = bg;
    c.beginPath(); c.ellipse(0, 0, 195, 150, 0, 0, 7); c.fill();
    // кровавые сосуды от краёв к центру
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
    // радужка — мутно-красная
    const ig = c.createRadialGradient(0, 0, 8, 0, 0, 78);
    ig.addColorStop(0, '#3d0d0d');
    ig.addColorStop(0.75, '#7a1e14');
    ig.addColorStop(1, '#2a0806');
    c.fillStyle = ig;
    c.beginPath(); c.arc(0, 0, 78, 0, 7); c.fill();
    // волокна радужки
    c.strokeStyle = 'rgba(20,4,4,0.5)';
    c.lineWidth = 1.4;
    for (let i = 0; i < 26; i++) {
      const a = i * 0.242;
      c.beginPath();
      c.moveTo(Math.cos(a) * 22, Math.sin(a) * 22);
      c.lineTo(Math.cos(a + 0.08) * 74, Math.sin(a + 0.08) * 74);
      c.stroke();
    }
    // вертикальный зрачок-щель, сужается по мере скримера
    const pw = Math.max(4, 26 - k * 20) + Math.sin(t * 30) * 1.5;
    c.fillStyle = '#020101';
    c.beginPath(); c.ellipse(0, 0, pw, 66, 0, 0, 7); c.fill();
    // мокрый блик
    c.fillStyle = 'rgba(255,250,240,0.5)';
    c.beginPath(); c.ellipse(-34, -44, 16, 9, -0.5, 0, 7); c.fill();
    // веки, сжимающие глаз
    c.fillStyle = '#160c0a';
    c.beginPath();
    c.moveTo(-220, -170); c.quadraticCurveTo(0, -60 - Math.sin(t * 4) * 10, 220, -170);
    c.lineTo(220, -220); c.lineTo(-220, -220);
    c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(-220, 170); c.quadraticCurveTo(0, 66 + Math.sin(t * 4) * 8, 220, 170);
    c.lineTo(220, 220); c.lineTo(-220, 220);
    c.closePath(); c.fill();
    // ресницы-иглы
    c.strokeStyle = '#0a0605';
    c.lineWidth = 3;
    for (let i = -5; i <= 5; i++) {
      c.beginPath();
      c.moveTo(i * 34, -96 + Math.abs(i) * 7);
      c.lineTo(i * 34 + 6, -66 + Math.abs(i) * 7);
      c.stroke();
    }
  }

  // --- вариант 3: «Медсестра» — маска в пятнах, волосы на лице ---
  function scareNurse(c, t) {
    c.save();
    c.rotate(-0.22 + Math.sin(t * 38) * 0.01);
    // серое измождённое лицо
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
    // глазницы: левая пустая чёрная, правая с белой точкой
    c.fillStyle = '#050304';
    c.beginPath(); c.ellipse(-44, -52, 30, 38, -0.15, 0, 7); c.fill();
    c.beginPath(); c.ellipse(46, -48, 27, 34, 0.15, 0, 7); c.fill();
    c.fillStyle = '#e8e4da';
    c.shadowColor = '#fff'; c.shadowBlur = 10;
    c.beginPath(); c.arc(48, -46, 3.4, 0, 7); c.fill();
    c.shadowBlur = 0;
    // марлевая маска на нижней половине
    c.fillStyle = '#a9a294';
    c.beginPath();
    c.moveTo(-92, 8);
    c.quadraticCurveTo(0, -14, 92, 8);
    c.quadraticCurveTo(78, 120, 0, 150);
    c.quadraticCurveTo(-78, 120, -92, 8);
    c.closePath(); c.fill();
    // складки маски
    c.strokeStyle = 'rgba(60,55,45,0.55)';
    c.lineWidth = 2;
    for (const yy of [34, 62, 92]) {
      c.beginPath();
      c.moveTo(-80 + yy * 0.3, yy);
      c.quadraticCurveTo(0, yy + 14, 80 - yy * 0.3, yy);
      c.stroke();
    }
    // проступающее пятно там, где рот... слишком широкое
    c.fillStyle = 'rgba(96,12,10,0.75)';
    c.beginPath();
    c.ellipse(4, 66, 52, 26 + Math.sin(t * 6) * 3, 0.05, 0, 7);
    c.fill();
    c.fillStyle = 'rgba(96,12,10,0.45)';
    c.beginPath();
    c.ellipse(-20, 96, 18, 26, 0.3, 0, 7);
    c.fill();
    // завязки маски
    c.strokeStyle = '#7a7468';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(-90, 14); c.lineTo(-150, -6);
    c.moveTo(90, 14); c.lineTo(150, -6);
    c.stroke();
    // свисающие пряди волос поверх лица
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
    // мерцание фонаря
    fx.flickerTimer -= dt;
    if (fx.flickerTimer <= 0) {
      if (fx.flicker > 0.5) {
        if (Math.random() < 0.06) { fx.flicker = 0.05; fx.flickerTimer = 0.15 + Math.random() * 0.45; }
        else { fx.flicker = 0.86 + Math.random() * 0.14; fx.flickerTimer = 0.05 + Math.random() * 0.15; }
      } else {
        fx.flicker = 1; fx.flickerTimer = 2 + Math.random() * 6;
      }
    }

    // молния: серия из 2-3 вспышек
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
    if (view.catchActive) {
      if (!fx.catchWasActive) fx.scareVariant = pickScareVariant(); // новая морда на каждую поимку
      fx.catchFace = Math.min(1, fx.catchFace + dt * 5);
    } else {
      fx.catchFace = Math.max(0, fx.catchFace - dt * 3);
    }
    fx.catchWasActive = !!view.catchActive;

    // туман дрейфует вокруг камеры
    for (const b of fx.fogBlobs) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < cam.x - W) b.x += W * 2;
      if (b.x > cam.x + W) b.x -= W * 2;
      if (b.y < cam.y - H) b.y += H * 2;
      if (b.y > cam.y + H) b.y -= H * 2;
    }

    // пылинки в конусе
    if (view.role === 'survivor' && !view.me.hidden) {
      while (fx.dust.length < 48) {
        const d = 40 + Math.random() * 250;
        const a = view.me.angle + (Math.random() - 0.5) * 0.86;
        fx.dust.push({
          x: view.me.x + Math.cos(a) * d,
          y: view.me.y + Math.sin(a) * d,
          s: 0.8 + Math.random() * 2,
          a: 0.14 + Math.random() * 0.4,
          vx: (Math.random() - 0.5) * 7,
          vy: (Math.random() - 0.5) * 7 - 2,
          ttl: 2 + Math.random() * 3,
        });
      }
      for (const d of fx.dust) { d.x += d.vx * dt; d.y += d.vy * dt; d.ttl -= dt; }
      fx.dust = fx.dust.filter(d => d.ttl > 0);
    } else {
      fx.dust.length = 0;
    }

    // крысы бегут
    for (const r of fx.rats) { r.x += r.vx * dt; r.y += r.vy * dt; r.ttl -= dt; }
    fx.rats = fx.rats.filter(r => r.ttl > 0);
  }

  // ---------- триггеры эффектов ----------
  function trigger(name, data) {
    switch (name) {
      case 'glitch': fx.glitch = 1; break;
      case 'shake': cam.shake = data || 8; break;
      case 'shadow': {
        const a = Math.random() * Math.PI * 2;
        fx.scareShadow = {
          x: cam.x + Math.cos(a) * 250,
          y: cam.y + Math.sin(a) * 250,
          ttl: 0.7,
        };
        break;
      }
      case 'lightning': fx.lightning = 1; break;
      case 'faceflash':
        fx.scareVariant = pickScareVariant(); // каждый раз другая морда
        fx.faceFlash = 0.10;
        fx.glitch = Math.max(fx.glitch, 0.8);
        break;
      case 'forceScare': // для отладки/тестов: зафиксировать вариант
        fx.scareVariant = data;
        break;
      case 'rat': {
        // крыса перебегает экран по горизонтали
        const side = Math.random() < 0.5 ? -1 : 1;
        fx.rats.push({
          x: cam.x + side * (W / 2 + 30),
          y: cam.y + (Math.random() - 0.5) * H * 0.6,
          vx: -side * (160 + Math.random() * 120),
          vy: (Math.random() - 0.5) * 30,
          ttl: 5,
        });
        break;
      }
    }
  }

  function snapCamera(x, y) { cam.x = x; cam.y = y; }

  return { init, setMap, drawFrame, trigger, snapCamera, cam, get canvasSize() { return { W, H }; } };
})();
