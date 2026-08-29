// ============================================================
// online.js — запускает сервер игры и туннель cloudflared,
// вылавливает публичную ссылку и печатает её крупно в консоль.
// Запуск: npm run online
// ============================================================

'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Windows-консоль по умолчанию не в UTF-8 — русский текст превращается
// в кракозябры. Переключаем кодовую страницу на UTF-8.
if (process.platform === 'win32') {
  try { spawnSync('chcp 65001', { shell: true, stdio: 'ignore' }); } catch {}
}

// --- 1. Сервер игры ---
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) },
});

server.on('exit', (code) => {
  console.error(`\nСервер завершился (код ${code}).`);
  process.exit(code || 0);
});

// --- 2. Туннель cloudflared ---
// cloudflared пишет ссылку вида https://xxx.trycloudflare.com в stderr
function startTunnel() {
  // 127.0.0.1, а не localhost: на Windows localhost может резолвиться
  // в IPv6 ::1, где сервер не слушает — cloudflared отдавал бы 530
  const tun = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PORT}`]);

  let found = false;
  let registered = false;
  let regTimer = null;
  const onData = (chunk) => {
    const text = chunk.toString();
    // туннель реально заработал только после регистрации соединения
    if (!registered && /Registered tunnel connection/.test(text)) {
      registered = true;
      if (regTimer) { clearTimeout(regTimer); regTimer = null; }
      console.log('  Туннель подключён — ссылка выше уже работает.\n');
    }
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !found) {
      found = true;
      // если за 25 секунд соединение не зарегистрировалось — сеть блокирует туннель
      regTimer = setTimeout(() => {
        if (!registered) {
          console.error(`
  ┌──────────────────────────────────────────────────────────────┐
  │  ВНИМАНИЕ: ссылка выдана, но туннель НЕ ПОДКЛЮЧИЛСЯ.         │
  │  Похоже, сеть (роутер/провайдер/файрвол) блокирует           │
  │  исходящий порт 7844 — ссылка будет отдавать ошибку 530.     │
  │                                                              │
  │  Что делать:                                                 │
  │   1. Попробовать с другой сети (раздать интернет с телефона) │
  │   2. Использовать ngrok (см. README.md — работает через 443) │
  │   3. Лучший вариант: деплой на Render — «Вариант 2» в README │
  └──────────────────────────────────────────────────────────────┘`);
        }
      }, 25000);
      const url = m[0];
      const line = '█'.repeat(66);
      console.log('\n\n');
      console.log('  ' + line);
      console.log('  ██' + ' '.repeat(62) + '██');
      console.log('  ██   ПУБЛИЧНАЯ ССЫЛКА НА ИГРУ — отправь её второму игроку:   ██');
      console.log('  ██' + ' '.repeat(62) + '██');
      console.log(`  ██   >>>   ${url.padEnd(48)}  ██`);
      console.log('  ██' + ' '.repeat(62) + '██');
      console.log('  ██   Открой её и сам(а) — играть можно с этой же ссылки.     ██');
      console.log('  ██   На iPhone: открыть в Safari.                            ██');
      console.log('  ██' + ' '.repeat(62) + '██');
      console.log('  ' + line);
      console.log('\n\n');
    }
  };
  tun.stdout.on('data', onData);
  tun.stderr.on('data', onData);

  tun.on('error', () => {
    printNoCloudflared();
  });
  tun.on('exit', (code) => {
    if (!found) printNoCloudflared(code);
  });
}

function printNoCloudflared() {
  console.error(`
  ┌──────────────────────────────────────────────────────────────┐
  │  cloudflared не найден!                                      │
  │                                                              │
  │  Установка:                                                  │
  │   Windows:  winget install Cloudflare.cloudflared            │
  │   Mac:      brew install cloudflared                         │
  │   Linux:    см. README.md (раздел «cloudflared»)             │
  │                                                              │
  │  После установки перезапусти терминал и снова:               │
  │   npm run online                                             │
  │                                                              │
  │  Запасной вариант — ngrok (см. README.md):                   │
  │   ngrok http ${PORT}                                            │
  │                                                              │
  │  Сервер продолжает работать локально:                        │
  │   http://localhost:${PORT}                                      │
  └──────────────────────────────────────────────────────────────┘
`);
}

startTunnel();

// корректное завершение обоих процессов по Ctrl+C
process.on('SIGINT', () => {
  server.kill();
  process.exit(0);
});
