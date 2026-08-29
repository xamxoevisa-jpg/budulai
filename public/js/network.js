// ============================================================
// network.js — связь с сервером.
// Автоматически выбирает ws:// или wss:// по протоколу страницы
// (через туннель cloudflared страница открыта по https —
// значит нужен wss). Хост берём относительный (location.host),
// никаких захардкоженных IP.
// Автопереподключение с токеном слота.
// ============================================================

'use strict';

const Network = (() => {
  let ws = null;
  let handlers = {};        // type -> [fn]
  let connected = false;
  let ping = 0;             // текущий RTT, мс
  let reconnectTimer = null;
  let pingTimer = null;
  let wantReconnect = false;
  let joinName = null;      // имя для повторного join при реконнекте

  function url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  }

  function emit(type, msg) {
    for (const fn of handlers[type] || []) fn(msg);
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    ws = new WebSocket(url());

    ws.onopen = () => {
      connected = true;
      emit('_open');
      // если имя уже задано (первый вход или реконнект) — заходим в слот
      if (joinName) {
        send({ type: 'join', name: joinName, token: sessionStorage.getItem('chern_token') });
      }
      // прикладной пинг каждые 2 с
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        send({ type: 'ping', ct: performance.now(), rtt: ping });
      }, 2000);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'pong') {
        ping = Math.round(performance.now() - msg.ct);
        emit('ping', ping);
        return;
      }
      if (msg.type === 'joined') {
        sessionStorage.setItem('chern_token', msg.token);
        sessionStorage.setItem('chern_name', msg.name);
        joinName = msg.name;
        wantReconnect = true; // теперь при обрывах будем возвращаться сами
      }
      emit(msg.type, msg);
    };

    ws.onclose = () => {
      connected = false;
      clearInterval(pingTimer);
      emit('_close');
      // автопереподключение, пока игрок в игре
      if (wantReconnect) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1500);
      }
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // первый вход по кнопке
  function join(name) {
    joinName = name;
    wantReconnect = true;
    if (connected) {
      send({ type: 'join', name, token: sessionStorage.getItem('chern_token') });
    } else {
      connect(); // join уйдёт в onopen
    }
  }

  function off(type, fn) {
    handlers[type] = (handlers[type] || []).filter(f => f !== fn);
  }

  return {
    connect, join, send, on, off,
    get ping() { return ping; },
    get connected() { return connected; },
  };
})();
