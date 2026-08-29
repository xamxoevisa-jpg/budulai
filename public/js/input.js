// ============================================================
// input.js — ввод: клавиатура (WASD/стрелки, Shift, E),
// мышь (поворот фонарика) и сенсорное управление для iPhone:
// джойстик появляется в точке касания слева,
// кнопки спринта и взаимодействия — справа.
// ============================================================

'use strict';

const Input = (() => {
  const state = {
    dx: 0, dy: 0,        // вектор движения (-1..1)
    sprint: false,
    angle: 0,            // угол фонарика (радианы, мировой)
    interactPressed: false, // одноразовый флаг
    usingTouch: false,
    mouseAim: false,     // управляет ли мышь фонариком
  };

  const keys = {};
  let mouseX = 0, mouseY = 0;

  // --- клавиатура ---
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys[e.code] = true;
    if (e.code === 'KeyE' || e.code === 'Space') state.interactPressed = true;
    // не даём странице скроллиться стрелками
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  // --- мышь: поворот фонарика ---
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX; mouseY = e.clientY;
    if (!state.usingTouch) state.mouseAim = true;
  });

  // --- сенсорное управление ---
  const touchUI = () => document.getElementById('touchUI');
  const joyBase = () => document.getElementById('joyBase');
  const joyKnob = () => document.getElementById('joyKnob');

  let joyTouchId = null;
  let joyCx = 0, joyCy = 0;        // центр джойстика
  const JOY_R = 52;                 // радиус хода ручки

  function onTouchStart(e) {
    state.usingTouch = true;
    state.mouseAim = false;
    for (const t of e.changedTouches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      // кнопки обрабатываются своими слушателями — пропускаем
      if (el && el.classList && el.classList.contains('touch-btn')) continue;
      // джойстик: только левая половина экрана и если ещё не захвачен
      if (joyTouchId === null && t.clientX < window.innerWidth * 0.55) {
        joyTouchId = t.identifier;
        joyCx = t.clientX; joyCy = t.clientY;
        const base = joyBase();
        base.style.left = joyCx + 'px';
        base.style.top = joyCy + 'px';
        base.classList.remove('hidden');
        moveKnob(0, 0);
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
        // мёртвая зона 12px
        if (len < 12) { state.dx = 0; state.dy = 0; }
        else {
          state.dx = dx / JOY_R; state.dy = dy / JOY_R;
          state.angle = Math.atan2(dy, dx); // фонарик — по направлению движения
        }
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  function onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joyTouchId) {
        joyTouchId = null;
        state.dx = 0; state.dy = 0;
        joyBase().classList.add('hidden');
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  function moveKnob(dx, dy) {
    joyKnob().style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }

  function initTouch() {
    // ВАЖНО: слушаем касания только на игровом канвасе, а не на документе.
    // Экраны входа/лобби лежат ПОВЕРХ канваса — их поля и кнопки получают
    // тапы нативно (иначе preventDefault глушил бы клавиатуру и клики на iOS)
    const cnv = document.getElementById('game');
    cnv.addEventListener('touchstart', onTouchStart, { passive: false });
    cnv.addEventListener('touchmove', onTouchMove, { passive: false });
    cnv.addEventListener('touchend', onTouchEnd, { passive: false });
    cnv.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // кнопки
    const bindBtn = (id, down, up) => {
      const el = document.getElementById(id);
      el.addEventListener('touchstart', (e) => { el.classList.add('pressed'); down(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
      el.addEventListener('touchend', (e) => { el.classList.remove('pressed'); if (up) up(); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    };
    bindBtn('btnSprint', () => { state.sprint = true; }, () => { state.sprint = false; });
    bindBtn('btnAct', () => { state.interactPressed = true; });
  }

  // блокировка жестов iOS: пинч-зум и дабл-клик.
  // Двойной тап давит CSS touch-action на body; глобальный preventDefault
  // на touchend НЕЛЬЗЯ — он ломает нажатия кнопок и фокус полей на iPhone
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());

  // --- опрос состояния (вызывается из main каждый кадр) ---
  // cam: {x, y} + canvas — чтобы перевести мышь в мировой угол
  function poll(camera, myPos) {
    if (!state.usingTouch) {
      let dx = 0, dy = 0;
      if (keys['KeyW'] || keys['ArrowUp']) dy -= 1;
      if (keys['KeyS'] || keys['ArrowDown']) dy += 1;
      if (keys['KeyA'] || keys['ArrowLeft']) dx -= 1;
      if (keys['KeyD'] || keys['ArrowRight']) dx += 1;
      const len = Math.hypot(dx, dy);
      if (len > 0) { dx /= len; dy /= len; }
      state.dx = dx; state.dy = dy;
      state.sprint = !!(keys['ShiftLeft'] || keys['ShiftRight']);

      // фонарик: мышь приоритетнее, иначе — направление движения
      if (state.mouseAim && camera && myPos) {
        const wx = camera.x + (mouseX - window.innerWidth / 2);
        const wy = camera.y + (mouseY - window.innerHeight / 2);
        state.angle = Math.atan2(wy - myPos.y, wx - myPos.x);
      } else if (len > 0) {
        state.angle = Math.atan2(dy, dx);
      }
      // если игрок начал двигаться клавишами — движение задаёт угол,
      // пока мышь не шевельнётся снова
      if (len > 0 && !state.mouseAim) state.angle = Math.atan2(dy, dx);
    }
    return state;
  }

  // одноразовое считывание кнопки взаимодействия
  function takeInteract() {
    const v = state.interactPressed;
    state.interactPressed = false;
    return v;
  }

  function showTouchUI() {
    if (state.usingTouch || 'ontouchstart' in window) {
      touchUI().classList.remove('hidden');
    }
  }
  function hideTouchUI() { touchUI().classList.add('hidden'); }

  return { state, poll, takeInteract, initTouch, showTouchUI, hideTouchUI };
})();
