// ============================================================
// input.js — управление видом от первого лица.
// Десктоп: W/S — вперёд/назад, A/D — шаг вбок, ←/→ — поворот,
//          мышь (клик по экрану включает захват) — поворот головы,
//          Shift — спринт, E/пробел — взаимодействие.
// Телефон: палец слева — джойстик ходьбы (вверх = вперёд),
//          свайп по правой половине — поворот головы,
//          кнопки «БЕГ» и «✚» справа.
// Слушатели касаний висят ТОЛЬКО на игровом канвасе — экраны
// входа/лобби получают тапы нативно (важно для iOS).
// ============================================================

'use strict';

const Input = (() => {
  const state = {
    moveX: 0,            // шаг вбок: -1 влево .. +1 вправо (относительно взгляда)
    moveY: 0,            // вперёд/назад: +1 вперёд .. -1 назад
    turnHeld: 0,         // зажат поворот клавишами: -1/0/+1
    turnDelta: 0,        // накопленный поворот мышью/свайпом (радианы)
    sprint: false,
    interactPressed: false,
    usingTouch: false,
  };

  const keys = {};

  // --- клавиатура ---
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys[e.code] = true;
    if (e.code === 'KeyE' || e.code === 'Space') state.interactPressed = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // --- мышь: поворот головы через Pointer Lock ---
  function initMouse(canvas) {
    canvas.addEventListener('click', () => {
      if (state.usingTouch) return;
      if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        canvas.requestPointerLock();
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) {
        state.turnDelta += e.movementX * 0.0021;
      }
    });
  }

  // --- сенсорное управление ---
  const joyBase = () => document.getElementById('joyBase');
  const joyKnob = () => document.getElementById('joyKnob');

  let joyTouchId = null;
  let joyCx = 0, joyCy = 0;
  const JOY_R = 52;
  let lookTouchId = null;
  let lookLastX = 0;

  function onTouchStart(e) {
    state.usingTouch = true;
    for (const t of e.changedTouches) {
      if (joyTouchId === null && t.clientX < window.innerWidth * 0.5) {
        // левая половина — джойстик ходьбы
        joyTouchId = t.identifier;
        joyCx = t.clientX; joyCy = t.clientY;
        const base = joyBase();
        base.style.left = joyCx + 'px';
        base.style.top = joyCy + 'px';
        base.classList.remove('hidden');
        moveKnob(0, 0);
      } else if (lookTouchId === null && t.clientX >= window.innerWidth * 0.5) {
        // правая половина — поворот головы свайпом
        lookTouchId = t.identifier;
        lookLastX = t.clientX;
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  function onTouchMove(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        let dx = t.clientX - joyCx, dy = t.clientY - joyCy;
        const len = Math.hypot(dx, dy);
        if (len > JOY_R) { dx = dx / len * JOY_R; dy = dy / len * JOY_R; }
        moveKnob(dx, dy);
        if (len < 12) { state.moveX = 0; state.moveY = 0; }
        else {
          state.moveX = dx / JOY_R;        // вбок
          state.moveY = -dy / JOY_R;       // вверх = вперёд
        }
      } else if (t.identifier === lookTouchId) {
        state.turnDelta += (t.clientX - lookLastX) * 0.0075;
        lookLastX = t.clientX;
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  function onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        joyTouchId = null;
        state.moveX = 0; state.moveY = 0;
        joyBase().classList.add('hidden');
      } else if (t.identifier === lookTouchId) {
        lookTouchId = null;
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  function moveKnob(dx, dy) {
    joyKnob().style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  function initTouch() {
    // касания — только на игровом канвасе: оверлеи входа/лобби
    // получают тапы нативно (iOS-клавиатура, кнопки)
    const cnv = document.getElementById('game');
    cnv.addEventListener('touchstart', onTouchStart, { passive: false });
    cnv.addEventListener('touchmove', onTouchMove, { passive: false });
    cnv.addEventListener('touchend', onTouchEnd, { passive: false });
    cnv.addEventListener('touchcancel', onTouchEnd, { passive: false });

    const bindBtn = (id, down, up) => {
      const el = document.getElementById(id);
      el.addEventListener('touchstart', (e) => { el.classList.add('pressed'); down(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
      el.addEventListener('touchend', (e) => { el.classList.remove('pressed'); if (up) up(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    };
    bindBtn('btnSprint', () => { state.sprint = true; }, () => { state.sprint = false; });
    bindBtn('btnAct', () => { state.interactPressed = true; });

    initMouse(cnv);
  }

  // пинч-зум и дабл-клик глушим; тапы по кнопкам не трогаем
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());

  // --- опрос (каждый кадр из main) ---
  function poll() {
    if (!state.usingTouch) {
      let mx = 0, my = 0, turn = 0;
      if (keys['KeyW'] || keys['ArrowUp']) my += 1;
      if (keys['KeyS'] || keys['ArrowDown']) my -= 1;
      if (keys['KeyA']) mx -= 1;
      if (keys['KeyD']) mx += 1;
      if (keys['ArrowLeft']) turn -= 1;
      if (keys['ArrowRight']) turn += 1;
      const len = Math.hypot(mx, my);
      if (len > 1) { mx /= len; my /= len; }
      state.moveX = mx; state.moveY = my;
      state.turnHeld = turn;
      state.sprint = !!(keys['ShiftLeft'] || keys['ShiftRight']);
    } else {
      state.turnHeld = 0;
    }
    return state;
  }

  // одноразовые считывания
  function takeInteract() {
    const v = state.interactPressed;
    state.interactPressed = false;
    return v;
  }
  function takeTurnDelta() {
    const v = state.turnDelta;
    state.turnDelta = 0;
    return v;
  }

  function showTouchUI() {
    if (state.usingTouch || 'ontouchstart' in window) {
      document.getElementById('touchUI').classList.remove('hidden');
    }
  }
  function hideTouchUI() { document.getElementById('touchUI').classList.add('hidden'); }

  return { state, poll, takeInteract, takeTurnDelta, initTouch, showTouchUI, hideTouchUI };
})();
