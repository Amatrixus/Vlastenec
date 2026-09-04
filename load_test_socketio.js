'use strict';

// INQUIZITOR Socket.IO load test
// Usage:
//   node load_test_socketio.js https://inquizitor.cz 25 150 120
// args: URL, virtual clients, ramp delay ms, test duration seconds
// Requires: npm i -D socket.io-client

const { io } = require('socket.io-client');

const TARGET = process.argv[2] || 'http://localhost:3000';
const CLIENTS = Math.max(1, Number(process.argv[3] || 25));
const RAMP_MS = Math.max(0, Number(process.argv[4] || 150));
const DURATION_SEC = Math.max(10, Number(process.argv[5] || 120));

const sockets = [];
const stats = {
  launched: 0,
  connected: 0,
  connectErrors: 0,
  disconnects: 0,
  roomsReady: 0,
  gamesStarted: 0,
  mcQuestions: 0,
  numericQuestions: 0,
  uiAcks: 0,
  roomErrors: 0
};

function liveTransportCounts() {
  const out = { websocket: 0, polling: 0, other: 0 };
  for (const socket of sockets) {
    if (!socket.connected) continue;
    const name = socket.io?.engine?.transport?.name || 'other';
    if (name === 'websocket' || name === 'polling') out[name] += 1;
    else out.other += 1;
  }
  return out;
}

function printStats(prefix = 'STAT') {
  const t = liveTransportCounts();
  console.log(
    `[${prefix}] launched=${stats.launched}/${CLIENTS} connected=${stats.connected} ` +
    `rooms=${stats.roomsReady} games=${stats.gamesStarted} ` +
    `ws=${t.websocket} polling=${t.polling} ` +
    `mc=${stats.mcQuestions} num=${stats.numericQuestions} ` +
    `connErr=${stats.connectErrors} disconnects=${stats.disconnects} roomErr=${stats.roomErrors}`
  );
}

function launchClient(index) {
  const name = `Load_${String(index + 1).padStart(3, '0')}`;
  let roomId = null;
  let seat = 1;
  let startRequested = false;

  const socket = io(TARGET, {
    autoConnect: true,
    transports: ['polling', 'websocket'],
    upgrade: true,
    rememberUpgrade: true,
    reconnection: false,
    timeout: 15000
  });
  sockets.push(socket);
  stats.launched += 1;

  socket.on('connect', () => {
    stats.connected += 1;
    socket.emit('createRoom', {
      settings: {
        name,
        mode: 'bots',
        cats: [1,2,3,4,5,6,7,8,9]
      }
    });
  });

  socket.on('connect_error', err => {
    stats.connectErrors += 1;
    console.error(`[${name}] connect_error: ${err.message}`);
  });

  socket.on('disconnect', reason => {
    stats.disconnects += 1;
    stats.connected = Math.max(0, stats.connected - 1);
    if (reason !== 'io client disconnect') console.warn(`[${name}] disconnect: ${reason}`);
  });

  socket.on('roomReady', payload => {
    roomId = payload?.room || payload?.roomId || roomId;
    stats.roomsReady += 1;
  });

  socket.on('assignPlayerNumber', payload => {
    if (Number(payload?.number)) seat = Number(payload.number);
    roomId = payload?.roomId || roomId;
  });

  socket.on('lobby:state', state => {
    roomId = state?.roomId || roomId;
    if (!startRequested && state?.canStart && roomId) {
      startRequested = true;
      socket.emit('lobby:start', { roomId });
    }
  });

  socket.on('startGame', () => {
    stats.gamesStarted += 1;
    // Simuluj dokončení úvodní animace klienta, ať load test netráví 16 s timeoutem.
    for (const playerNumber of [1,2,3]) socket.emit('baseSettled', { playerNumber });
    setTimeout(() => {
      if (roomId && socket.connected) socket.emit('basesAnimationDone', { roomId });
    }, 20);
  });

  // Výběr regionu lidského seat-u.
  function chooseRegion(payload = {}) {
    const regions = Array.isArray(payload.regions) ? payload.regions : [];
    if (!regions.length) return;
    socket.emit('claimRegion', {
      round: Number(payload.round || 0),
      region: regions[Math.floor(Math.random() * regions.length)]
    });
  }
  socket.on('availableRegions', chooseRegion);
  socket.on('battleAvailableRegions', chooseRegion);

  socket.on('multipleChoiceQuestion', q => {
    stats.mcQuestions += 1;
    if (!q?.canAnswer || !roomId) return;
    const count = Array.isArray(q.options) ? q.options.length : 4;
    const answerIndex = Math.max(0, Math.floor(Math.random() * Math.max(1, count)));
    setTimeout(() => {
      if (socket.connected) socket.emit('playerAnswered', { room: roomId, player: seat, answerIndex });
    }, 80 + Math.floor(Math.random() * 220));
  });

  function answerNumeric() {
    if (!roomId) return;
    const answer = Math.floor(Math.random() * 5000);
    setTimeout(() => {
      if (socket.connected) socket.emit('playerNumericAnswer', { room: roomId, player: seat, answer });
    }, 100 + Math.floor(Math.random() * 250));
  }

  socket.on('numericQuestion', q => {
    stats.numericQuestions += 1;
    answerNumeric(q);
  });
  socket.on('numericQuestionForTwo', q => {
    stats.numericQuestions += 1;
    if ([Number(q?.attacker), Number(q?.defender)].includes(seat)) answerNumeric(q);
  });

  function ackUi(payload = {}) {
    if (!roomId || !payload?.uiToken) return;
    stats.uiAcks += 1;
    socket.emit('battleUiAck', {
      roomId,
      uiToken: payload.uiToken,
      stage: payload.uiStage
    });
  }
  socket.on('multipleChoiceResults', ackUi);
  socket.on('numericQuestionResultsForTwo', ackUi);
  socket.on('numericQuestionResults', ackUi);
  socket.on('destroyTower', ackUi);

  socket.on('roomError', err => {
    stats.roomErrors += 1;
    console.error(`[${name}] roomError: ${err?.message || err}`);
  });
}

console.log(`INQUIZITOR load test → ${TARGET}`);
console.log(`clients=${CLIENTS}, ramp=${RAMP_MS}ms, duration=${DURATION_SEC}s`);

for (let i = 0; i < CLIENTS; i++) {
  setTimeout(() => launchClient(i), i * RAMP_MS);
}

const statTimer = setInterval(() => printStats(), 5000);
const totalMs = Math.max(1000, (CLIENTS - 1) * RAMP_MS) + DURATION_SEC * 1000;

setTimeout(async () => {
  clearInterval(statTimer);
  printStats('FINAL');

  // Pokud je k dispozici diagnostický token, smaž na serveru všechny Load_XXX
  // místnosti ještě před odpojením socketů. Produkční hry to nezasáhne.
  const token = process.env.SERVER_STATUS_TOKEN || '';
  if (token) {
    try {
      const response = await fetch(`${TARGET.replace(/\/$/, '')}/api/server-status/cleanup-load-test`, {
        method: 'POST',
        headers: { 'X-Server-Status-Token': token }
      });
      const result = await response.json().catch(() => ({}));
      console.log(`[CLEANUP] HTTP ${response.status}, removed=${result.removed ?? '?'}`);
    } catch (err) {
      console.warn(`[CLEANUP] failed: ${err.message}`);
    }
  } else {
    console.log('[CLEANUP] SERVER_STATUS_TOKEN není nastaven; load-test rooms se nesmazaly okamžitě.');
  }

  for (const socket of sockets) socket.disconnect();
  setTimeout(() => process.exit(stats.connectErrors || stats.roomErrors ? 2 : 0), 500);
}, totalMs);
