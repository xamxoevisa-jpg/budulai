// ============================================================
// audio.js — весь звук «Чернолесья» синтезируется на лету
// через Web Audio API: без единого аудиофайла.
//  - низкий гул-эмбиент (осцилляторы + фильтр)
//  - капающая вода со случайным стерео-панорамированием
//  - скрипы, хлопки дверей, шёпот, детский смех
//  - сердцебиение с динамическим темпом
//  - дыхание жертвы (для Монстра), рёв при поимке
// На iOS контекст запускается только после первого касания.
// ============================================================

'use strict';

const GameAudio = (() => {
  let ctx = null;
  let master = null;
  let unlocked = false;

  // непрерывные узлы
  let droneNodes = null;
  let heartbeat = { timer: null, level: 0 };
  let breath = { gain: null, level: 0 };
  let dripTimer = null;
  let creakTimer = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(ctx.destination);
  }

  // Разблокировка звука первым касанием (требование iOS)
  function unlock() {
    init();
    if (ctx.state === 'suspended') ctx.resume();
    if (!unlocked) {
      // тихий «пустой» буфер — надёжный способ разбудить iOS
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(master);
      src.start(0);
      unlocked = true;
    }
  }

  const now = () => ctx ? ctx.currentTime : 0;

  // --- вспомогательные генераторы ---

  // источник белого шума
  function noiseSource(dur = 1) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  // ============ ЭМБИЕНТ ============
  // Низкий гул: два расстроенных осциллятора + медленная модуляция
  function startAmbient(volume = 1) {
    if (!ctx || droneNodes) return;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.10 * volume, now() + 4);

    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth'; o1.frequency.value = 38;
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth'; o2.frequency.value = 38.7; // биения ~0.7 Гц

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 120; filt.Q.value = 2;

    // медленная модуляция фильтра — «дышащий» гул
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 45;
    lfo.connect(lfoGain); lfoGain.connect(filt.frequency);

    // слой «ветра»: фильтрованный шум
    const wind = noiseSource(4);
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass'; wf.frequency.value = 300; wf.Q.value = 0.6;
    const wg = ctx.createGain(); wg.gain.value = 0.018 * volume;
    wind.connect(wf); wf.connect(wg); wg.connect(master);

    o1.connect(filt); o2.connect(filt); filt.connect(g); g.connect(master);
    o1.start(); o2.start(); lfo.start(); wind.start();
    droneNodes = { o1, o2, lfo, wind, g, wg };

    // случайные капли и скрипы
    scheduleDrip();
    scheduleCreak();
  }

  function stopAmbient() {
    if (!droneNodes) return;
    const t = now();
    droneNodes.g.gain.linearRampToValueAtTime(0, t + 1);
    droneNodes.wg.gain.linearRampToValueAtTime(0, t + 1);
    const d = droneNodes;
    setTimeout(() => { try { d.o1.stop(); d.o2.stop(); d.lfo.stop(); d.wind.stop(); } catch {} }, 1200);
    droneNodes = null;
    clearTimeout(dripTimer); dripTimer = null;
    clearTimeout(creakTimer); creakTimer = null;
  }

  // ============ КАПЛИ (случайная позиция в стерео) ============
  function scheduleDrip() {
    dripTimer = setTimeout(() => {
      if (ctx && droneNodes) drip((Math.random() * 2 - 1) * 0.9);
      if (droneNodes) scheduleDrip();
    }, 1500 + Math.random() * 5000);
  }

  function drip(pan = 0) {
    const t = now();
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 900 + Math.random() * 900;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; o.connect(g); g.connect(p); p.connect(master); }
    else { o.connect(g); g.connect(master); }
    o.start(t); o.stop(t + 0.4);
  }

  // ============ СКРИПЫ ============
  function scheduleCreak() {
    creakTimer = setTimeout(() => {
      if (ctx && droneNodes) creak();
      if (droneNodes) scheduleCreak();
    }, 9000 + Math.random() * 18000);
  }

  function creak() {
    const t = now();
    const src = noiseSource(1.2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 25;
    f.frequency.setValueAtTime(300 + Math.random() * 300, t);
    f.frequency.linearRampToValueAtTime(150 + Math.random() * 200, t + 1.0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.25);
    g.gain.linearRampToValueAtTime(0, t + 1.1);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = Math.random() * 2 - 1; src.connect(f); f.connect(g); g.connect(p); p.connect(master); }
    else { src.connect(f); f.connect(g); g.connect(master); }
    src.start(t);
  }

  // ============ СЕРДЦЕБИЕНИЕ ============
  // level 0..1 — близость Монстра; темп и громкость растут
  function setHeartbeat(level) {
    heartbeat.level = level;
    if (!ctx) return;
    if (level > 0.02 && !heartbeat.timer) heartbeatLoop();
  }

  function heartbeatLoop() {
    if (!ctx || heartbeat.level <= 0.02) { heartbeat.timer = null; return; }
    const lv = heartbeat.level;
    thump(0.14 + lv * 0.30);                 // «тук»
    setTimeout(() => thump(0.10 + lv * 0.2), 140); // «тук-тук»
    const bpm = 55 + lv * 95;                // 55..150 ударов
    heartbeat.timer = setTimeout(heartbeatLoop, 60000 / bpm);
    // вибрация iPhone в такт (если поддерживается)
    if (navigator.vibrate && lv > 0.45) navigator.vibrate(30 + lv * 40);
  }

  function thump(vol) {
    const t = now();
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(58, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.25);
  }

  // ============ ДЫХАНИЕ ЖЕРТВЫ (слышит Монстр) ============
  function setBreath(level) {
    if (!ctx) return;
    if (!breath.gain) {
      const src = noiseSource(2.7);
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 1.6;
      const g = ctx.createGain(); g.gain.value = 0;
      // ритм вдох-выдох
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.45;
      const lg = ctx.createGain(); lg.gain.value = 0.5;
      const off = ctx.createConstantSource ? ctx.createConstantSource() : null;
      const depth = ctx.createGain(); depth.gain.value = 0;
      lfo.connect(lg); lg.connect(depth.gain);
      src.connect(f); f.connect(depth); depth.connect(g); g.connect(master);
      lfo.start(); src.start();
      if (off) { off.offset.value = 0.5; off.connect(depth.gain); off.start(); }
      breath.gain = g; breath.depth = depth;
    }
    breath.gain.gain.linearRampToValueAtTime(level * 0.10, now() + 0.3);
  }

  // ============ СОБЫТИЯ-СКРИМЕРЫ ============

  // хлопнувшая дверь
  function doorSlam() {
    const t = now();
    const src = noiseSource(0.4);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
    // низкий удар
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.7, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(og); og.connect(master);
    o.start(t); o.stop(t + 0.45);
  }

  // детский смех — FM-блики с вибрато, зловеще «неправильный»
  function childLaugh(pan = 0) {
    const t0 = now();
    const notes = [880, 990, 880, 790, 700, 620];
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const out = p || master;
    if (p) { p.pan.value = pan; p.connect(master); }
    notes.forEach((f0, i) => {
      const t = t0 + i * 0.16 + Math.random() * 0.03;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f0 * (0.98 + Math.random() * 0.04), t);
      o.frequency.linearRampToValueAtTime(f0 * 0.8, t + 0.13);
      const vib = ctx.createOscillator(); vib.frequency.value = 9;
      const vg = ctx.createGain(); vg.gain.value = 18;
      vib.connect(vg); vg.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.10, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + 0.2); vib.start(t); vib.stop(t + 0.2);
    });
  }

  // шёпот — модулированный узкополосный шум
  function whisper() {
    const t = now();
    const src = noiseSource(2.2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 3;
    // формантная модуляция — похоже на неразборчивую речь
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 7;
    const lg = ctx.createGain(); lg.gain.value = 900;
    lfo.connect(lg); lg.connect(f.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.4);
    g.gain.linearRampToValueAtTime(0.02, t + 1.6);
    g.gain.linearRampToValueAtTime(0, t + 2.1);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = Math.random() < 0.5 ? -0.8 : 0.8; src.connect(f); f.connect(g); g.connect(p); p.connect(master); }
    else { src.connect(f); f.connect(g); g.connect(master); }
    src.start(t); lfo.start(t); lfo.stop(t + 2.3);
  }

  // рёв Монстра при поимке — громкий, с дисторшном
  function roar() {
    const t = now();
    const dist = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(x * 6);
    }
    dist.curve = curve;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.0, t + 0.06);
    g.gain.setValueAtTime(1.0, t + 0.8);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    dist.connect(g); g.connect(master);

    for (const base of [55, 82, 110]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * 1.6, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.7, t + 1.2);
      const og = ctx.createGain(); og.gain.value = 0.33;
      o.connect(og); og.connect(dist);
      o.start(t); o.stop(t + 1.7);
    }
    // шумовой рык поверх
    const n = noiseSource(1.5);
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass'; nf.frequency.value = 900;
    const ng = ctx.createGain(); ng.gain.value = 0.5;
    n.connect(nf); nf.connect(ng); ng.connect(dist);
    n.start(t);
    if (navigator.vibrate) navigator.vibrate([120, 40, 300]);
  }

  // нарастающий тревожный свелл (расстроенные струнные)
  function swell() {
    const t = now();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.10, t + 2.6);
    g.gain.linearRampToValueAtTime(0, t + 4.2);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    f.connect(g); g.connect(master);
    for (const base of [174, 176.5, 233, 349.6]) { // тритонная гроздь
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * 0.99, t);
      o.frequency.linearRampToValueAtTime(base * 1.012, t + 4);
      const og = ctx.createGain(); og.gain.value = 0.22;
      o.connect(og); og.connect(f);
      o.start(t); o.stop(t + 4.3);
    }
  }

  // писк пробегающей крысы + шуршание
  function ratSqueak(pan = 0) {
    const t = now();
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const out = p || master;
    if (p) { p.pan.value = pan; p.connect(master); }
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.09;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(2600 + Math.random() * 800, tt);
      o.frequency.exponentialRampToValueAtTime(1800, tt + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.05, tt + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.06);
      o.connect(g); g.connect(out);
      o.start(tt); o.stop(tt + 0.07);
    }
    // шуршание лапок
    const n = noiseSource(0.5);
    const nf = ctx.createBiquadFilter();
    nf.type = 'highpass'; nf.frequency.value = 3500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.03, t);
    ng.gain.linearRampToValueAtTime(0, t + 0.5);
    n.connect(nf); nf.connect(ng); ng.connect(out);
    n.start(t);
  }

  // испуганное дыхание самой Жертвы — учащается с ужасом
  let fear = { gain: null, timer: null, level: 0 };
  function setFear(level) {
    if (!ctx) return;
    fear.level = level;
    if (level > 0.05 && !fear.timer) fearLoop();
  }
  function fearLoop() {
    if (!ctx || fear.level <= 0.05) { fear.timer = null; return; }
    const t = now();
    const lv = fear.level;
    // вдох-выдох: два шумовых свипа
    const breathOne = (t0, up) => {
      const src = noiseSource(0.5);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 1.2;
      f.frequency.setValueAtTime(up ? 500 : 900, t0);
      f.frequency.linearRampToValueAtTime(up ? 1100 : 400, t0 + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.026 + lv * 0.05, t0 + 0.1);
      g.gain.linearRampToValueAtTime(0, t0 + 0.34);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0);
    };
    breathOne(t, true);
    breathOne(t + 0.4 - lv * 0.12, false);
    const period = 1.6 - lv * 0.8; // от спокойного к паническому
    fear.timer = setTimeout(fearLoop, period * 1000);
  }

  // короткий рык Монстра неподалёку (слышит Жертва)
  function growl() {
    const t = now();
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(48 + Math.random() * 14, t);
    o.frequency.linearRampToValueAtTime(34, t + 0.9);
    const trem = ctx.createOscillator(); trem.frequency.value = 15 + Math.random() * 8;
    const tg = ctx.createGain(); tg.gain.value = 0.5;
    const dep = ctx.createGain(); dep.gain.value = 0;
    trem.connect(tg); tg.connect(dep.gain);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(dep); dep.connect(f); f.connect(g); g.connect(master);
    const off = ctx.createConstantSource ? ctx.createConstantSource() : null;
    if (off) { off.offset.value = 0.5; off.connect(dep.gain); off.start(t); }
    o.start(t); o.stop(t + 1.2); trem.start(t); trem.stop(t + 1.2);
  }

  // «давление» — низкочастотный гул, когда Монстр рядом (для Выжившего)
  let dread = null;
  function setDread(level) {
    if (!ctx) return;
    if (!dread) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = 31;
      const o2 = ctx.createOscillator();
      o2.type = 'sine'; o2.frequency.value = 33.5; // биения
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(g); o2.connect(g); g.connect(master);
      o.start(); o2.start();
      dread = g;
    }
    dread.gain.linearRampToValueAtTime(Math.min(0.4, level * 0.4), now() + 0.35);
  }

  // пронзительный визг для скримера — каждый раз чуть другой
  function scream() {
    const t = now();
    const kind = Math.floor(Math.random() * 3);
    if (kind === 0) {
      // визг-глиссандо: кластер расстроенных пил падает с высоты
      for (const det of [1, 1.03, 0.97, 1.06]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime((1500 + Math.random() * 400) * det, t);
        o.frequency.exponentialRampToValueAtTime(320 * det, t + 0.9);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.Q.value = 2;
        f.frequency.setValueAtTime(1800, t);
        f.frequency.exponentialRampToValueAtTime(500, t + 0.9);
        o.connect(f); f.connect(g); g.connect(master);
        o.start(t); o.stop(t + 1.05);
      }
    } else if (kind === 1) {
      // «детский» крик: высокий тремолирующий тон с изломами
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(880, t);
      o.frequency.linearRampToValueAtTime(1240, t + 0.18);
      o.frequency.linearRampToValueAtTime(700, t + 0.55);
      o.frequency.linearRampToValueAtTime(990, t + 0.75);
      const vib = ctx.createOscillator(); vib.frequency.value = 13;
      const vg = ctx.createGain(); vg.gain.value = 60;
      vib.connect(vg); vg.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 500;
      o.connect(f); f.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.95); vib.start(t); vib.stop(t + 0.95);
    } else {
      // скрежет: узкополосный шум, мечущийся по частоте
      const src = noiseSource(1.1);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 14;
      f.frequency.setValueAtTime(2400, t);
      f.frequency.exponentialRampToValueAtTime(700, t + 0.35);
      f.frequency.exponentialRampToValueAtTime(3100, t + 0.6);
      f.frequency.exponentialRampToValueAtTime(420, t + 1.0);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.34, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t);
    }
  }

  // короткий «штынг» для скримера-тени
  function sting() {
    const t = now();
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(1800, t);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 250;
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.6);
  }

  // гром для молнии
  function thunder() {
    const t = now();
    const src = noiseSource(2.6);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(60, t + 2.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.4);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  }

  // шаги (свои) — тихий глухой стук
  function footstep(sprinting) {
    const t = now();
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(sprinting ? 160 : 120, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(sprinting ? 0.07 : 0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.1);
  }

  // скрип дверцы шкафа (прятание)
  function closetCreak() {
    const t = now();
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(320, t);
    o.frequency.linearRampToValueAtTime(180, t + 0.4);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 8; f.frequency.value = 400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.05);
    g.gain.linearRampToValueAtTime(0, t + 0.45);
    o.connect(f); f.connect(g); g.connect(master);
    o.start(t); o.stop(t + 0.5);
  }

  return {
    init, unlock, startAmbient, stopAmbient,
    setHeartbeat, setBreath, setDread, setFear, growl,
    doorSlam, childLaugh, whisper, roar, scream, sting, thunder, footstep, closetCreak,
    swell, ratSqueak,
    get ready() { return unlocked; },
  };
})();
