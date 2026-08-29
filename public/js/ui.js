// ============================================================
// ui.js — интерфейс: экраны входа/лобби, HUD, пинг,
// оверлеи заморозки, конца раунда и финала, разрыв связи.
// ============================================================

'use strict';

const UI = (() => {
  const $ = (id) => document.getElementById(id);

  // ---------- переключение экранов ----------
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }

  function showLogin() { show('login'); hide('lobby'); hide('hud'); hide('roundOverlay'); }
  function showLobby() { hide('login'); show('lobby'); hide('hud'); hide('roundOverlay'); }
  function showGame() { hide('login'); hide('lobby'); show('hud'); hide('roundOverlay'); }

  // ---------- лобби ----------
  function renderLobby(players, mySlot) {
    const list = $('lobbyList');
    list.innerHTML = '';
    // кнопка «позвать санитара» видна, пока второй слот пуст
    const emptySlots = players.filter(p => !p).length;
    $('botBtn').classList.toggle('hidden', emptySlots === 0);
    for (let i = 0; i < 2; i++) {
      const p = players[i];
      const row = document.createElement('div');
      row.className = 'lobby-row';
      if (!p) {
        row.innerHTML = `<span class="pname" style="opacity:0.4">— пусто —</span><span class="pstate empty">ожидание...</span>`;
      } else {
        const me = i === mySlot ? ' (вы)' : '';
        const state = !p.connected ? '<span class="pstate wait">СВЯЗЬ ПОТЕРЯНА</span>'
          : p.ready ? '<span class="pstate ready">ГОТОВ(А)</span>'
          : '<span class="pstate wait">НЕ ГОТОВ(А)</span>';
        row.innerHTML = `<span class="pname">${escapeHtml(p.name)}${me}</span>${state}`;
      }
      list.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // ---------- HUD ----------
  function setRole(role) {
    const el = $('roleLabel');
    if (role === 'hunter') {
      el.textContent = 'ВЫ — МОНСТР. НАЙДИ ЕЁ ПО СЛЕДАМ';
      el.className = 'hunter';
    } else {
      el.textContent = 'ВЫ — ЖЕРТВА. ПРОДЕРЖИСЬ 3 МИНУТЫ';
      el.className = '';
    }
  }

  function setTimer(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const el = $('timerLabel');
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('low', sec < 30);
  }

  function setScore(names, score, mySlot) {
    const tally = (n) => n === 0 ? '—' : '‖'.repeat(Math.floor(n / 2)) + (n % 2 ? '|' : '');
    $('scoreCard').innerHTML =
      `<div class="sc-title">КАРТА НАБЛЮДЕНИЙ · до 5</div>` +
      `<div class="sc-row">${escapeHtml(names[0])}${mySlot === 0 ? ' (вы)' : ''}: <span class="tally">${tally(score[0])}</span> ${score[0]}</div>` +
      `<div class="sc-row">${escapeHtml(names[1])}${mySlot === 1 ? ' (вы)' : ''}: <span class="tally">${tally(score[1])}</span> ${score[1]}</div>`;
  }

  function setStamina(v, max, isHunter) {
    $('staminaWrap').style.display = isHunter ? 'none' : 'block';
    const bar = $('staminaBar');
    bar.style.width = (v / max * 100) + '%';
    bar.classList.toggle('low', v < max * 0.3);
  }

  function setPing(ms) {
    $('pingLabel').textContent = ms + ' мс';
    $('pingLabel').style.color = ms > 150 ? 'rgba(200,60,60,0.7)' : 'rgba(216,205,180,0.4)';
  }

  function setInteractHint(text) {
    const el = $('interactHint');
    if (text) { el.textContent = text; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  // ---------- заморозка ----------
  function setFreeze(sec, role) {
    const ov = $('freezeOverlay');
    if (sec > 0) {
      ov.classList.remove('hidden');
      $('freezeText').textContent = role === 'hunter'
        ? 'ЖЕРТВА ПРЯЧЕТСЯ. ЖДИ...'
        : 'МОНСТР ПРОСНЁТСЯ ЧЕРЕЗ';
      $('freezeCount').textContent = Math.ceil(sec);
    } else {
      ov.classList.add('hidden');
    }
  }

  // ---------- конец раунда ----------
  // stats: см. game-logic endRound
  function showRoundEnd(stats, mySlot) {
    const iWon = stats.winnerSlot === mySlot;
    const caught = stats.result === 'caught';
    const title = caught
      ? (iWon ? 'ПОЙМАНА' : 'ВАС ПОЙМАЛИ')
      : (iWon ? 'ВЫ ВЫЖИЛИ' : 'ЖЕРТВА СБЕЖАЛА');
    const how = stats.how === 'hideout' ? 'найдена в укрытии' : caught ? 'настигнута в коридорах' : 'продержалась до рассвета';
    const el = $('roundOverlay');
    el.innerHTML = `
      <div class="paper">
        <div class="stamp">ПРОТОКОЛ РАУНДА № ${stats.round}</div>
        <div class="ro-result">${title}</div>
        <table class="ro-stats">
          <tr><td>исход:</td><td>${how}</td></tr>
          <tr><td>осталось времени:</td><td>${Math.floor(stats.timeLeft / 60)}:${String(Math.floor(stats.timeLeft % 60)).padStart(2, '0')}</td></tr>
          <tr><td>пройдено жертвой:</td><td>${stats.distance} м</td></tr>
          <tr><td>пряталась:</td><td>${stats.hides} раз(а)</td></tr>
          <tr><td>счёт:</td><td>${escapeHtml(stats.names[0])} ${stats.score[0]} : ${stats.score[1]} ${escapeHtml(stats.names[1])}</td></tr>
        </table>
        <div class="ro-note">${stats.matchOver ? 'заключение готовится...' : 'роли меняются. следующий раунд скоро...'}</div>
      </div>`;
    el.classList.remove('hidden');
  }

  function hideRoundEnd() { hide('roundOverlay'); }

  // ---------- финал матча ----------
  function showGameOver(winnerName, iWon, score, names, onAgain) {
    const el = $('roundOverlay');
    el.innerHTML = `
      <div class="paper">
        <div class="stamp">ЗАКЛЮЧЕНИЕ КОМИССИИ</div>
        <div class="ro-result">${iWon ? 'ВЫ ПОБЕДИЛИ' : 'ВЫ ПРОИГРАЛИ'}</div>
        <table class="ro-stats">
          <tr><td>победитель:</td><td>${escapeHtml(winnerName)}</td></tr>
          <tr><td>итоговый счёт:</td><td>${escapeHtml(names[0])} ${score[0]} : ${score[1]} ${escapeHtml(names[1])}</td></tr>
        </table>
        <button id="againBtn" class="blood-btn">СЫГРАТЬ ЕЩЁ</button>
        <div class="ro-note">пациенты возвращаются в приёмный покой</div>
      </div>`;
    el.classList.remove('hidden');
    $('againBtn').addEventListener('click', onAgain);
  }

  // ---------- разрыв связи ----------
  function setDisconnected(on, text) {
    const ov = $('dcOverlay');
    if (on) {
      ov.querySelector('.dc-text').textContent = text || 'СВЯЗЬ С ПАЦИЕНТОМ ПОТЕРЯНА...';
      ov.classList.remove('hidden');
    } else ov.classList.add('hidden');
  }

  return {
    $, showLogin, showLobby, showGame, renderLobby,
    setRole, setTimer, setScore, setStamina, setPing, setInteractHint,
    setFreeze, showRoundEnd, hideRoundEnd, showGameOver, setDisconnected,
  };
})();
