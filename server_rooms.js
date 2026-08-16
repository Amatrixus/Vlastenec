const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');




const app = express();
app.use(express.static('public')); // servíruje index.html a další soubory

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } }); // (později si omezíš)



const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Server běží na', PORT);
  console.log('🧪 VLASTENEC BUILD: 2026-08-16-region-fix-v3');
});






const MAX_PLAYERS_PER_ROOM = 3;
const rooms = {}; // roomId -> { players, scores, bases, regions, regionValues, defenseBonuses }
const regionValuesByRoom = {};



// ——— helpers pro "friends" room ———
function genRoomCode(n = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function makeFriendsRoomId() {
  for (let i = 0; i < 50; i++) {
    const id = `room_${genRoomCode(6)}`;
    if (!rooms[id]) return id;
  }
  return `room_${Date.now()}`;
}



function sanitizeRoomId(s) {
  const code = String(s || '').replace(/^room_/i, '').trim();
  const m = code.match(/^[A-Z0-9]{6}$/i);          // ← změna
  return m ? `room_${m[0].toUpperCase()}` : '';
}



// --- Kategorie: jednoduchý filtr podle nastavení room ---
function allowedCategorySet(room) {
  const s = room.settings || {};
  const fromNames = Array.isArray(s.catNames) ? s.catNames : [];
  const fromIds = Array.isArray(s.cats) ? s.cats : [];

  // podle tvých 9 kategorií v pořadí
  const CATEGORY_SLUGS = [
    'vedy','literatura','technologie','geografie','historie',
    'kultura','sport','osobnosti','politika'
  ];

  const idSlugs = fromIds
    .map(n => CATEGORY_SLUGS[(parseInt(n,10) || 0) - 1])
    .filter(Boolean);

  return new Set([...fromNames, ...idSlugs]);
}

// Vyfiltruj otázky podle kategorií, fallback = celý pool
function filterQuestionsByRoomCategories(allQs, room) {
  const allowed = allowedCategorySet(room);
  if (!allowed.size) return allQs;

  const filtered = allQs.filter(q => {
    const cats = Array.isArray(q.categories) ? q.categories : [q.category];
    if (!cats) return false;
    return cats.some(c => allowed.has(c));
  });

  return filtered.length ? filtered : allQs;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}






function sanitizeSettings(incoming = {}) {
  const out = { ...(incoming || {}) };

  // cats: jen 1..9 (máš 9 dlaždic)
  if (Array.isArray(out.cats)) {
    out.cats = out.cats
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 9);
  }

  // catNames: neprázdné stringy
  if (Array.isArray(out.catNames)) {
    out.catNames = out.catNames
      .map(s => String(s || '').trim())
      .filter(Boolean);
  }

  // mode (nepovinné): jen známé hodnoty
  if (out.mode && !['random','friends','bots','liga'].includes(out.mode)) {
    delete out.mode;
  }

  return out;
}




// === SNAPSHOT: sestavení stavu místnosti pro rehydrataci klienta ===
function buildRoomSnapshot(room, roomId) {
  const allNames = {};
  for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
    const p = room.players[i];
    allNames[i + 1] = (p && p.name) ? p.name : `Robot ${i + 1}`;
  }

  const displayNames = {
    1: displayName(room, 1, true),
    2: displayName(room, 2, true),
    3: displayName(room, 3, true)
  };


  return {
    roomId,
    allNames,
    displayNames,
    hasStarted: !!room.hasStarted,
    phase: room.phase,
    round: room.round,
    bases: room.bases,
    regions: room.regions,
    regionValues: room.regionValues,
    scores: room.scores,
    defenseBonuses: room.defenseBonuses,
    seatControllers: room.seatControllers,
    expansionPlan: room.expansionPlan || null,
    battlePlan: room.battlePlan || null,
    chat: room.chat || [],
    settings: room.settings || {}
  };
}








// nahoru k ostatním helperům
function occupiedSeatCount(room) {
  return (room.players || []).filter(Boolean).length; // počítá jen skutečně obsazená sedadla
}








function makeEmptyRoom(roomId, mode = 'random') {
  rooms[roomId] = {
    mode,                  // ← důležité
    players: [],
    scores: { 1: 0, 2: 0, 3: 0 },
    bases: {},
    regions: { Player1regions: [], Player2regions: [], Player3regions: [] },
    regionValues: { ...defaultRegionValues },
    defenseBonuses: { Player1: 0, Player2: 0, Player3: 0 },
    playerLives: { Player1: 3, Player2: 3, Player3: 3 },
    chat: [],
    settings: {},           // volitelné – můžeš sem ukládat cats/catNames



     // 🔽 NOVÉ:
    hasStarted: false,
    phase: "lobby",          // lobby | settle | expansion | conquest | battle
    round: 0,
    reconnectHolds: new Map(),     // map<seatNumber, timeoutId>
    playerTokens: {},              // {1: "abc", 2: "...", 3: "..."}
    seatControllers: {             // kdo právě ovládá sedadlo
      1: "human", 2: "human", 3: "human"   // "human" | "bot"
    }


  };
  return rooms[roomId];
}




// 🔴 NEW – helpery pro řízení životního cyklu místnosti
function markRoomClosed(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.__closed = true;
}

function isRoomAlive(roomId) {
  const room = rooms[roomId];
  return !!room && room.__closed !== true;
}

// Volitelné: místo běžného delay použijeme cancellable delay
async function delayAlive(roomId, ms) {
  const step = 50;
  let waited = 0;
  while (waited < ms) {
    if (!isRoomAlive(roomId)) return false; // zrušeno
    await new Promise(r => setTimeout(r, Math.min(step, ms - waited)));
    waited += step;
  }
  return true; // doběhlo celé
}


// NEW: zjistí číslo hráče (1..3) v dané room podle socket.id
function getSeatNumber(room, socketId) {
  if (!room) return null;
  const ix = room.players.findIndex(p => p && p.id === socketId);
  return ix >= 0 ? (ix + 1) : null;
}


// Najdi sedadlo pro navrátilce (podle jména) nebo volné/bot sedadlo
function findSeatForReturningOrBot(room, name) {
  for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
    if (room.players[i] && room.players[i].name === name) return i + 1;
  }
  for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
    if (!room.players[i] || room.players[i].id == null) return i + 1;
  }
  return null;
}





function roomAddPlayerAndBroadcast(roomId, socket, name) {
  const room = rooms[roomId];
  if (!room) return;

  // Už tam jsem? → jen pošli stav
  if (room.players.some(p => p && p.id === socket.id)) {
    const allNames = {};
    room.players.forEach((p, idx) => { if (p) allNames[idx + 1] = p.name; });
    socket.emit("assignPlayerNumber", {
      number: getSeatNumber(room, socket.id),
      allNames,
      scores: room.scores,
      roomId
    });


    const displayNames = {
      1: displayName(room, 1, true),
      2: displayName(room, 2, true),
      3: displayName(room, 3, true)
    };

    io.to(roomId).emit("updatePlayers", { allNames, displayNames, seatControllers: room.seatControllers });
    io.to(roomId).emit("updateScores", { scores: room.scores });
    return;
  }

  // Najdi sedadlo pro navrátilce nebo volné/bot sedadlo
  const myNumber = findSeatForReturningOrBot(room, name);
  if (!myNumber) {
    socket.emit("roomError", { message: "Room is full" });
    return;
  }

  // Připoj socket do room a obsad' konkrétní sedadlo
  socket.join(roomId);
  while (room.players.length < MAX_PLAYERS_PER_ROOM) room.players.push(undefined);
  room.players[myNumber - 1] = { id: socket.id, name };

  room.seatControllers = room.seatControllers || {1:"human",2:"human",3:"human"};
  room.seatControllers[myNumber] = "human";

  // Ulož si do socketu
  socket.data = socket.data || {};
  socket.data.seat   = myNumber;
  socket.data.roomId = roomId;
  socket.data.name   = name;

  // Rozposlat lobby + skóre
  const allNames = {};
  room.players.forEach((p, idx) => { if (p) allNames[idx + 1] = p.name; });

  socket.emit("assignPlayerNumber", {
    number: myNumber, allNames, scores: room.scores, roomId
  });
  
  
  const displayNames = {
      1: displayName(room, 1, true),
      2: displayName(room, 2, true),
      3: displayName(room, 3, true)
    };

  io.to(roomId).emit("updatePlayers", { allNames, displayNames, seatControllers: room.seatControllers });
  io.to(roomId).emit("updateScores", { scores: room.scores });

  // 5) Start hry pouze jednou (zbytek nech tak, jak už máš – hasStarted guard)
  if (room.players.filter(Boolean).length === MAX_PLAYERS_PER_ROOM && !room.hasStarted) {
    const possibleBases = ['Rho', 'Omega', 'Theta'];
    const shuffled = possibleBases.sort(() => Math.random() - 0.5);

    room.bases[1] = shuffled[0];
    room.bases[2] = shuffled[1];
    room.bases[3] = shuffled[2];

    room.regions.Player1regions = [room.bases[1]];
    room.regions.Player2regions = [room.bases[2]];
    room.regions.Player3regions = [room.bases[3]];

    room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

    room.hasStarted = true;
    room.phase = "settle";
    room.round = 0;

    io.to(roomId).emit("startGame", {
      bases: room.bases,
      regions: room.regions,
      regionValues: room.regionValues
    });

    io.to(roomId).emit("updateScores", { scores: room.scores });
    if (isRoomAlive(roomId)) runGameScenario(roomId);
  } else if (room.hasStarted) {
    // Pozdější vstup/reconnect = jen snapshot (pokud tu funkci máš)
    if (typeof buildRoomSnapshot === 'function') {
      socket.emit("stateSync", { myNumber, snapshot: buildRoomSnapshot(room, roomId) });
    }
  }
}





//BOTS ADDED
function isBot(room, seat) {
  return room?.seatControllers?.[seat] === "bot";
}

function randInt(a, b) { // včetně
  return a + Math.floor(Math.random() * (b - a + 1));
}




const ROBOT_NAMES = { 1: "Robot Emil", 2: "Robot Jirka", 3: "Robot Honza" };

function displayName(room, seat, withGear = false) {
  const isBotSeat = room?.seatControllers?.[seat] === "bot";
  const base = isBotSeat
    ? (ROBOT_NAMES[seat] || `Robot ${seat}`)
    : (room.players[seat - 1]?.name || `Hráč ${seat}`);
  return withGear && isBotSeat ? `${base} ⚙️` : base;
}

























const defaultRegionValues = {
  Alpha: 0,
  Delta: 0,
  Epsilon: 0,
  Zeta: 0,
  Eta: 0,
  Theta: 0,
  Kappa: 0,
  Lambda: 0,
  Mu: 0,
  Nu: 0,
  Omicron: 0,
  Pi: 0,
  Rho: 0,
  Sigma: 0,
  Omega: 0
};

// Jediný autoritativní seznam skutečných polí mapy.
// Nikdy neodvozujeme počet regionů z room.regionValues, protože dynamický
// klíč (např. "undefined") by se jinak mohl začít tvářit jako další pole.
const REGION_IDS = Object.freeze(Object.keys(defaultRegionValues));
const REGION_ID_SET = new Set(REGION_IDS);

// Opraví/ověří mapový stav místnosti. Tohle je obranná pojistka:
// i kdyby se do regionValues nebo seznamu vlastněných polí dostal technický
// klíč (např. "undefined"), před herní fází ho odstraníme.
function sanitizeRoomRegionState(room, roomId = '') {
  if (!room) return;

  room.regionValues = room.regionValues || {};

  for (const key of Object.keys(room.regionValues)) {
    if (!REGION_ID_SET.has(key)) {
      console.warn(`🧹 [${roomId || 'room'}] Odstraňuji neplatný region z regionValues: ${key}`);
      delete room.regionValues[key];
    }
  }

  for (const region of REGION_IDS) {
    if (typeof room.regionValues[region] !== 'number') {
      room.regionValues[region] = 0;
    }
  }

  room.regions = room.regions || {};
  for (let seat = 1; seat <= 3; seat++) {
    const key = `Player${seat}regions`;
    const current = Array.isArray(room.regions[key]) ? room.regions[key] : [];
    const cleaned = [...new Set(current.filter(region => REGION_ID_SET.has(region)))];
    if (cleaned.length !== current.length) {
      console.warn(`🧹 [${roomId || 'room'}] Čistím neplatné regiony hráče ${seat}:`, current, '→', cleaned);
    }
    room.regions[key] = cleaned;
  }

  if (room.bases) {
    for (let seat = 1; seat <= 3; seat++) {
      if (room.bases[seat] != null && !REGION_ID_SET.has(room.bases[seat])) {
        console.warn(`🧹 [${roomId || 'room'}] Mažu neplatnou základnu Player${seat}: ${String(room.bases[seat])}`);
        delete room.bases[seat];
      }
    }
  }
}

const adjacencyInfo = {
  Alpha: ['Sigma', 'Zeta', 'Epsilon', 'Pi', 'Omicron', 'Nu', 'Mu', 'Eta'],
  Delta: ['Theta', 'Eta', 'Mu', 'Omicron'],
  Epsilon: ['Alpha','Zeta', 'Kappa', 'Rho', 'Pi'],
  Zeta: ['Alpha','Sigma', 'Epsilon'],
  Eta: ['Alpha','Sigma', 'Delta', 'Theta', 'Mu'],
  Theta: ['Eta', 'Delta'],
  Kappa: ['Omega', 'Lambda', 'Rho', 'Epsilon'],
  Lambda: ['Omega', 'Kappa', 'Rho'],
  Mu: ['Alpha', 'Delta', 'Eta', 'Omicron', 'Nu'],
  Nu: ['Alpha','Mu'],
  Omicron: ['Alpha','Delta', 'Mu', 'Pi', 'Rho'],
  Pi: ['Alpha','Rho', 'Epsilon', 'Omicron'],
  Rho: ['Lambda', 'Kappa','Epsilon','Pi','Omicron'],
  Sigma: ['Alpha','Eta','Zeta'],
  Omega: ['Kappa', 'Lambda']
};




// Spočítá skóre hráčů
function calculateScores(regions, values, bonuses) {
  const scores = { 1: 0, 2: 0, 3: 0 };
  for (let p = 1; p <= 3; p++) {
    const key = `Player${p}regions`;
    const owned = regions[key] || [];
    owned.forEach(region => {
      scores[p] += values[region] || 0;
    });
    scores[p] += bonuses[`Player${p}`] || 0;
  }
  return scores;
}

// Generuje plán rozšiřování (pořadí hráčů)
function generateExpansionPlan() {
  const baseOrders = [
    [1, 2, 3],
    [2, 3, 1],
    [3, 1, 2],
    [2, 1, 3],
    [3, 2, 1],
    [1, 3, 2]
  ];
  const shuffledRounds = [];
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * baseOrders.length);
    shuffledRounds.push([...baseOrders[randomIndex]]);
  }
  return shuffledRounds;
}


// Generuje plán bitev (pořadí hráčů)
function generateBattlePlan() {
  const baseOrders = [
    [1, 2, 3],
    [2, 3, 1],
    [3, 1, 2],
    [2, 1, 3],
    [3, 2, 1],
    [1, 3, 2]
  ];
  const shuffledRounds = [];
  for (let i = 0; i < 6; i++) {
    const randomIndex = Math.floor(Math.random() * baseOrders.length);
    shuffledRounds.push([...baseOrders[randomIndex]]);
  }
  return shuffledRounds;
}


// Funkce na počítání obsazených polí
function countOccupiedRegions(room) {
  return (
    room.regions.Player1regions.length +
    room.regions.Player2regions.length +
    room.regions.Player3regions.length
  );
}

// Autoritativní seznam skutečně volných polí.
// Konec fází odvozujeme od mapy, ne od pomocného počítadla.
function getFreeRegions(room) {
  const occupied = new Set([
    ...room.regions.Player1regions,
    ...room.regions.Player2regions,
    ...room.regions.Player3regions
  ]);

  return REGION_IDS.filter(region => !occupied.has(region));
}

// Pomocná delay funkce
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}




// OTÁZKY


const questionsPath = path.join(__dirname, 'joltiple_choice.json');
const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));


// --- Numeric Qs (CJS) ---
const numericQuestionsPath = path.join(__dirname, 'jolumeric_questions.json');
const numericQuestions = JSON.parse(fs.readFileSync(numericQuestionsPath, 'utf8'));


module.exports = { questions }; // pokud exportuješ dál






function runMultipleChoice(roomId, participatingPlayers = [1, 2, 3]) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve([]);

    const pool = filterQuestionsByRoomCategories(questions, room);
    const question = pickRandom(pool);
    console.log(`🧠 MC otázka z kategorie: ${question.category}`);

    const correctPlayers = [];

    room.answers = {};

    const isDuel = participatingPlayers.length === 2;
    const attacker = isDuel ? participatingPlayers[0] : null;
    const defender = isDuel ? participatingPlayers[1] : null;

    // Pošli otázku všem (canAnswer = jen účastníci)
    room.players.forEach((p, index) => {
      if (!p || !p.id) return;
      const playerNumber = index + 1;
      io.to(p.id).emit("multipleChoiceQuestion", {
        question: question.question,
        options: question.options,
        time: 10,
        attacker,
        defender,
        attackerName: isDuel ? displayName(room, attacker, true) : "",
        defenderName: isDuel ? displayName(room, defender, true) : "",
        canAnswer: participatingPlayers.includes(playerNumber)
      });
    });

    // BOT odpovědi
    try {
      const BOT_CORRECT_PROB = 0.55;
      const BOT_MIN_DELAY_MS = 600;
      const BOT_MAX_DELAY_MS = 2200;

      participatingPlayers.forEach((seat) => {
        if (!isBot(room, seat)) return;
        const botDelay = randInt(BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS);

        setTimeout(() => {
          const r = rooms[roomId];
          if (!r || !isRoomAlive(roomId)) return;
          if (!isBot(r, seat)) return;
          if (r.answers?.[seat] !== undefined) return;

          const indices = question.options.map((_, i) => i);
          const wrong   = indices.filter(i => i !== question.correct);
          const shouldBeCorrect = Math.random() < BOT_CORRECT_PROB;

          // jediná proměnná pick (žádné stínění)
          let pick = shouldBeCorrect
            ? question.correct
            : (wrong.length ? wrong[randInt(0, wrong.length - 1)] : question.correct);

          r.answers = r.answers || {};
          r.answers[seat] = pick;
          console.log(`🤖 BOT ${seat} odpověděl MC: ${pick}`);
        }, botDelay);
      });
    } catch (e) { console.warn('BOT MC error', e); }

    // ⏲️ Timeout + vyhodnocení + resolve (VRÁCENO)
    setTimeout(() => {
      if (!isRoomAlive(roomId)) return resolve([]);

      for (const player in room.answers) {
        if (room.answers[player] === question.correct) {
          correctPlayers.push(Number(player));
        }
      }

      io.to(roomId).emit("multipleChoiceResults", {
        correctAnswer: question.correct,
        answersByPlayer: room.answers
      });

      resolve(correctPlayers);
    }, 10000);
  });
}




function runNumericQuestionForTwo(roomId, [player1, player2]) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve(null);

    const npool = filterQuestionsByRoomCategories(numericQuestions, room);
    const nq = pickRandom(npool);
    console.log(`🔢 Numeric otázka z kategorie: ${nq.category}`);


    const correctAnswer = Number.isInteger(nq.answer) ? nq.answer : parseInt(nq.answer, 10);

    room.numericAnswers = {};
    room.numericStartTime = Date.now();

    io.to(roomId).emit("numericQuestionForTwo", {
      question: nq.question,
      time: 15,
      attacker: player1,
      defender: player2,
      attackerName: displayName(room, player1, true),
      defenderName: displayName(room, player2, true)
    });

    // BOT odpovědi
    try {
      const BOT_MIN_DELAY_MS = 700;
      const BOT_MAX_DELAY_MS = 2400;

      [player1, player2].forEach((seat) => {
        if (!isBot(room, seat)) return;
        const botDelay = randInt(BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS);

        setTimeout(() => {
          const r = rooms[roomId];
          if (!r || !isRoomAlive(roomId)) return;
          if (!isBot(r, seat)) return;
          if (r.numericAnswers?.[seat]) return;

          const noise = Math.round((Math.random() - 0.5) * 0.2 * Math.max(10, Math.abs(correctAnswer)));
          const guess = correctAnswer + noise;

          r.numericAnswers = r.numericAnswers || {};
          r.numericAnswers[seat] = { num: guess, time: Date.now() - r.numericStartTime };
          console.log(`🤖 BOT ${seat} odpověděl NUM (duel): ${guess}`);
        }, botDelay);
      });
    } catch (e) { console.warn('BOT duel numeric error', e); }

    // ⏲️ Timeout + vyhodnocení + resolve
    setTimeout(() => {
      if (!isRoomAlive(roomId)) return resolve(null);

      // doplň chybějící odpovědi
      [player1, player2].forEach(p => {
        if (!room.numericAnswers[p]) {
          room.numericAnswers[p] = { num: 0, time: 15000 };
          console.log(`⏳ Hráč ${p} nestihl → 0 (15 s)`);
        }
      });

      const sorted = Object.entries(room.numericAnswers)
        .map(([player, data]) => ({
          player: Number(player),
          num: parseInt(data.num, 10),
          diff: Math.abs(parseInt(data.num, 10) - correctAnswer),
          time: data.time
        }))
        .sort((a, b) => (a.diff !== b.diff ? a.diff - b.diff : a.time - b.time));

      const winner = sorted[0].player;

      io.to(roomId).emit("numericQuestionResultsForTwo", {
        correctAnswer,
        attacker: player1,
        defender: player2,
        answers: sorted.map(a => ({
          player: a.player,
          num: a.num,
          time: a.time,
          name: room.players[a.player - 1].name
        }))
      });

      resolve(winner);
    }, 15000);
  });
}





function runNumericQuestionForThree(roomId) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve(null);

    const npool = filterQuestionsByRoomCategories(numericQuestions, room);
    const nq = pickRandom(npool);
    console.log(`🔢 Numeric (3p) otázka z kategorie: ${nq.category}`);


    const correctAnswer = Number.isInteger(nq.answer) ? nq.answer : parseInt(nq.answer, 10);

    room.numericAnswers = {};
    room.numericStartTime = Date.now();

    io.to(roomId).emit("numericQuestion", {
      question: nq.question,
      time: 15
    });

    // BOT odpovědi
    try {
      const BOT_MIN_DELAY_MS = 700;
      const BOT_MAX_DELAY_MS = 2400;

      [1,2,3].forEach((seat) => {
        if (!isBot(room, seat)) return;
        const botDelay = randInt(BOT_MIN_DELAY_MS, BOT_MAX_DELAY_MS);

        setTimeout(() => {
          const r = rooms[roomId];
          if (!r || !isRoomAlive(roomId)) return;
          if (!isBot(r, seat)) return;
          if (r.numericAnswers?.[seat]) return;

          const noise = Math.round((Math.random() - 0.5) * 0.25 * Math.max(10, Math.abs(correctAnswer)));
          const guess = correctAnswer + noise;

          r.numericAnswers = r.numericAnswers || {};
          r.numericAnswers[seat] = { num: guess, time: Date.now() - r.numericStartTime };
          console.log(`🤖 BOT ${seat} odpověděl NUM (3): ${guess}`);
        }, botDelay);
      });
    } catch (e) { console.warn('BOT 3p numeric error', e); }

    // ⏲️ Timeout + vyhodnocení + resolve
    setTimeout(() => {
      if (!isRoomAlive(roomId)) return resolve(null);

      // doplň chybějící
      [1, 2, 3].forEach(player => {
        if (!room.numericAnswers[player]) {
          room.numericAnswers[player] = { num: 0, time: 15000 };
          console.log(`⏳ Hráč ${player} nestihl → 0 (15 s)`);
        }
      });

      const sorted = Object.entries(room.numericAnswers)
        .map(([player, data]) => ({
          player: Number(player),
          num: parseInt(data.num, 10),
          diff: Math.abs(parseInt(data.num, 10) - correctAnswer),
          time: data.time
        }))
        .sort((a, b) => (a.diff !== b.diff ? a.diff - b.diff : a.time - b.time));

      const winner = sorted[0].player;

      io.to(roomId).emit("numericQuestionResults", {
        correctAnswer,
        answers: sorted
      });

      resolve(winner);
    }, 15000);
  });
}







/* JEN BITVY


async function runGameScenario(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  console.log("⏩ Přeskakuji rozšiřování a dobývání – test bitev!");

  const allRegions = Object.keys(room.regionValues);
  const p1 = [];
  const p2 = [];
  const p3 = [];

  room.bases = {}; // ✅ Zajistíme, že existuje

  allRegions.forEach((region, i) => {
    if (i % 3 === 0) {
      p1.push(region);
      if (i === 0) {
        room.regionValues[region] = 1000;
        room.bases[1] = region; // ✅ Ulož jako základnu hráče 1
      } else {
        room.regionValues[region] = 200;
      }
    } else if (i % 3 === 1) {
      p2.push(region);
      if (i === 1) {
        room.regionValues[region] = 1000;
        room.bases[2] = region; // ✅ Základna hráče 2
      } else {
        room.regionValues[region] = 200;
      }
    } else {
      p3.push(region);
      if (i === 2) {
        room.regionValues[region] = 1000;
        room.bases[3] = region; // ✅ Základna hráče 3
      } else {
        room.regionValues[region] = 200;
      }
    }
  });

  room.regions.Player1regions = p1;
  room.regions.Player2regions = p2;
  room.regions.Player3regions = p3;

  room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

  io.to(roomId).emit("updateRegions", {
    regions: room.regions,
    regionValues: room.regionValues,
    scores: room.scores
  });

  // ✅ Můžeš volitelně poslat klientům základny, pokud je potřebují vizuálně
  io.to(roomId).emit("startGame", {
    bases: room.bases,
    regions: room.regions,
    regionValues: room.regionValues
  });

  console.log("📌 Regiony připravené pro test bitev:", room.regions);
  console.log("🏰 Základny nastaveny:", room.bases);

  await runBattlePhase(roomId);
}


*/


/* CELÁ HRA  */

// Scénář po startGame
async function runGameScenario(roomId) {


  if (!isRoomAlive(roomId)) return; // 🔴 NEW
  const room = rooms[roomId];
  if (!room) return;

  sanitizeRoomRegionState(room, roomId);

  room.phase = "settle";
  room.round = 0;


    if (!await delayAlive(roomId, 7000)) return; // 🔴 NEW

  //FÁZE USAZENÍ
      io.to(roomId).emit("runClientScenario", { action: "basesSettle" });
       if (!await delayAlive(roomId, 8000)) return; // 🔴 NEW


       room.phase ="expansion" 
  //INTRO K ROZŠIŘOVÁNÍ

       if (!isRoomAlive(roomId)) return; // 🔴 NEW
      //VYGENEROVÁNÍ HERNÍHO PLÁNU
        const expansionPlan = generateExpansionPlan();
        

        
        if (!room) return;
        room.expansionPlan = expansionPlan;

      //POSLÁNÍ PLÁNU KLIENTŮM
      io.to(roomId).emit("runClientScenario", {
        action: "expansionintro",
        expansionPlan
      });

      console.log("🧭 Odeslán expansionPlan:", expansionPlan);
      if (!await delayAlive(roomId, 2000)) return; // 🔴 NEW

      //FÁZE ROZŠIŘOVÁNÍ
      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      await runExpansionPhase(roomId);

      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      room.phase = "conquest";
      room.round = 1;
      await runConquestPhase(roomId);

      if (!isRoomAlive(roomId)) return; // 🔴 NEW


      room.phase = "battle";
      room.round = 1;
      await runBattlePhase(roomId);

}








async function runExpansionPhase(roomId) {
  const room = rooms[roomId];
    if (!room || !isRoomAlive(roomId)) return; // 🔴 NEW


  const totalRegions = REGION_IDS.length;
  const expansionTarget = Math.max(0, totalRegions - 2); // poslední 2 pole necháváme pro dobývání

  for (let round = 1; round <= 6; round++) {
    // Nezakládej další kolo, pokud už je cíl rozšiřování splněn
    // nebo na mapě nezbylo žádné volné pole.
    const occupiedBeforeRound = countOccupiedRegions(room);
    const freeBeforeRound = getFreeRegions(room);
    if (occupiedBeforeRound >= expansionTarget || freeBeforeRound.length === 0) {
      console.log(`🛑 Další kolo rozšiřování se nespouští – obsazeno ${occupiedBeforeRound}/${totalRegions}, volných ${freeBeforeRound.length}.`);
      break;
    }

    room.round = round; // ⬅️ DOPLNIT


    if (!isRoomAlive(roomId)) return; // 🔴 NEW
    room.claimedRegionsThisRound = new Set();

    io.to(roomId).emit("startExpansionRound", {
      round,
      order: room.expansionPlan[round - 1]
    });

    console.log(`🔵 Kolo ${round} začíná – pořadí:`, room.expansionPlan[round - 1]);

    

    await runPlayerTurns(roomId, round, room.expansionPlan[round - 1]);
    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    const correctPlayers = await runMultipleChoice(roomId);
    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    if (!await delayAlive(roomId, 6000)) return; // 🔴 NEW


    correctPlayers.forEach(player => {
      const selectedRegion = room.lastSelections[player];
      if (selectedRegion) {
        room.regions[`Player${player}regions`].push(selectedRegion);
        room.regionValues[selectedRegion] = 200;
        room.scores[player] += 200;
        console.log(`✅ Hráč ${player} získal region ${selectedRegion} (+200 bodů)`);
        io.to(roomId).emit("updateScores", { scores: room.scores });

      }
    });

    // Aktualizace klientů
    io.to(roomId).emit("updateRegions", {
      regions: room.regions,
      regionValues: room.regionValues,
      scores: room.scores
    });



    console.log(`✅ Kolo ${round} dokončeno`);

    const occupiedAfterRound = countOccupiedRegions(room);
    const freeAfterRound = getFreeRegions(room);
    if (occupiedAfterRound >= expansionTarget || freeAfterRound.length === 0) {
        console.log(`🛑 Fáze rozšiřování ukončena – obsazeno ${occupiedAfterRound}/${totalRegions}, volných ${freeAfterRound.length}.`);
        break;
    }
  }

  console.log("🟢 Fáze rozšiřování dokončena");
}













async function runConquestPhase(roomId) {
  const room = rooms[roomId];
  if (!room || !isRoomAlive(roomId)) return; // 🔴 NEW

  console.log("⚔️ Fáze dobývání spuštěna!");
  io.to(roomId).emit("phaseChange", { phase: "conquest" });


  let round = 1;

  // Vždy vycházej ze skutečně volných polí, ne z lokálního počítadla,
  // které se může se stavem mapy rozejít.
  while (getFreeRegions(room).length > 0) {
    room.round = round; // ⬅️ DOPLNIT


    if (!isRoomAlive(roomId)) return; // 🔴 NEW

    const occupiedNow = countOccupiedRegions(room);
    console.log(`⚔️ Dobývání – ${round}. kolo (obsazeno: ${occupiedNow}, volných: ${getFreeRegions(room).length})`);

    // 1️⃣ Intro pro klienty – animace a název kola
    io.to(roomId).emit("conquestIntro", {
      round,
      title: `Dobývání – ${round}. kolo`
    });
    if (!await delayAlive(roomId, 4000)) return; // 🔴 NEW

    // 2️⃣ Numerická otázka – vítěz
    const winner = await runNumericQuestionForThree(roomId);
    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    if (winner) {
      console.log(`🏆 Hráč ${winner} vyhrál numerickou otázku`);

      // 3️⃣ Počkej na animaci výsledků na klientovi (stejně jako offline verze)
      if (!await delayAlive(roomId, 6000)) return; // 🔴 NEW

      // 4️⃣ Získej dostupné regiony pro vítěze
      const available = getAvailableRegionsConquest(room);

      // Mapa mohla být mezitím doplněna; v takovém případě už
      // vítěze nenecháváme čekat 10 sekund na neexistující volbu.
      if (available.length === 0) {
        console.log("🛑 Dobývání končí – na mapě už není žádné volné pole.");
        break;
      }

      const winRec = room.players[winner - 1];
      const playerSocketId = winRec && winRec.id;
      if (playerSocketId) {
        io.to(playerSocketId).emit("availableRegions", { regions: available });
      }


      console.log("📊 Dostupná pole pro hráče", winner, ":", getAvailableRegionsConquest(room));
      console.log("📌 Regions:", room.regions);
      console.log("📌 RegionValues:", room.regionValues);


      // Čekej na výběr regionu nebo náhodné přiřazení
      const selectedRegion = await waitForPlayerSelection(roomId, winner, 10000, available);
      if (!isRoomAlive(roomId)) return; // 🔴 NEW


      if (selectedRegion) {
        // ✅ Okamžitě zobraz pin na mapě všem hráčům
        io.to(roomId).emit("playerSelectedRegion", {
          player: winner,
          region: selectedRegion
        });

        // ✅ Přiděl region a přepočítej body
        room.regions[`Player${winner}regions`].push(selectedRegion);
        room.regionValues[selectedRegion] = 300;
        room.scores[winner] += 300;

        console.log(`✅ Hráč ${winner} obsadil ${selectedRegion} (+300 bodů)`);

      await delayAlive(roomId, 2000); // 🔴 NEW

        // ✅ Aktualizace pro všechny hráče (zabarvení + skóre)
        io.to(roomId).emit("updateRegions", {
          regions: room.regions,
          regionValues: room.regionValues,
          scores: room.scores
        });

        io.to(roomId).emit("updateScores", { scores: room.scores });

      }
    } else {
      console.log("⏳ Nikdo neodpověděl správně – kolo bez změny");
    }

    round++;
  }

  console.log("🟢 Fáze dobývání dokončena!");

}







async function runBattlePhase(roomId) {
  const room = rooms[roomId];
  if (!room || !isRoomAlive(roomId)) return; // 🔴 NEW

  console.log("⚔️ Fáze bitev spuštěna!");

  const battlePlan = generateBattlePlan();
  room.battlePlan = battlePlan;

  // ✅ Pošli battlePlan klientům, aby si vykreslili tyčky
  io.to(roomId).emit("battleIntro", {
    battlePlan,
    title: "Bitvy"
  });

  console.log("📋 BattlePlan:", battlePlan);

  for (let round = 1; round <= 6; round++) {
        room.round = round; // ⬅️ DOPLNIT

    if (!isRoomAlive(roomId)) return; // 🔴 NEW


    io.to(roomId).emit("startBattleRound", {
      round,
      order: room.battlePlan[round - 1]
    });

    console.log(`🔵 Bitvy – ${round}. kolo`);

    for (let battlestick = 1; battlestick <= 3; battlestick++) {
      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      const attacker = room.battlePlan[round - 1][battlestick - 1];

      io.to(roomId).emit("updateBattleStick", {
        round,
        battlestick,
        player: attacker
      });

      console.log(`🎯 Tah ${battlestick} v ${round}. kole`);

      if (isAnyoneWinning(room)) {
        console.log("🏆 Někdo vyhrál – bitvy končí!");

                  
            const finalScores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

            // Získání pořadí (seřazeno podle skóre)
            const ordered = Object.entries(finalScores)
              .map(([player, score]) => ({ player: Number(player), score }))
              .sort((a, b) => b.score - a.score);

            io.to(roomId).emit("gameOver", {
              message: "Hra skončila!",
              finalScores: ordered // obsahuje pole objektů: { player: 1, score: ... }, seřazeno
            });

  


        return;
      }

      const selections = await runBattleClaiming(roomId, attacker);
      if (!isRoomAlive(roomId)) return; // 🔴 NEW

      if (!selections) continue;

      const { claimedBy, currentlyOwnedBy, selectedRegion } = selections;
      console.log(`📌 Bitva: Útočník ${claimedBy} → Napadá ${selectedRegion} (majitel ${currentlyOwnedBy})`);

      if (!selectedRegion) continue;

      await runBattleOnRegion(roomId, claimedBy, currentlyOwnedBy, selectedRegion);

      if (!await delayAlive(roomId, 2000)) return; // 🔴 NEW
    }
  }

  console.log("🟢 Fáze bitev dokončena!");
  const finalScores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

            // Získání pořadí (seřazeno podle skóre)
            const ordered = Object.entries(finalScores)
              .map(([player, score]) => ({ player: Number(player), score }))
              .sort((a, b) => b.score - a.score);

            io.to(roomId).emit("gameOver", {
              message: "Hra skončila!",
              finalScores: ordered // obsahuje pole objektů: { player: 1, score: ... }, seřazeno
  });




}



async function runBattleClaiming(roomId, attacker) {
  const room = rooms[roomId];
  if (!room) return null;

  console.log(`🎯 Hráč ${attacker} vybírá soupeřovo území k útoku`);

  const availableEnemyRegions = getEnemyRegions(room, attacker);

  if (availableEnemyRegions.length === 0) {
    console.log(`⚠️ Hráč ${attacker} nemá co napadnout`);
    return null;
  }

  const attRec = room.players[attacker - 1];
  const attackerSocketId = attRec && attRec.id;
  if (attackerSocketId) {
    io.to(attackerSocketId).emit("battleAvailableRegions", { regions: availableEnemyRegions });
  }




  //BOTS ADDED
    if (isBot(room, attacker)) {
    const pool = availableEnemyRegions;
    if (pool.length) {
      const pick = pool[randInt(0, pool.length - 1)];
      // naplánuj „klik“ bota – nastav pendingSelections
      setTimeout(() => {
        const r = rooms[roomId];
        if (!r || !isRoomAlive(roomId)) return;
        if (!isBot(r, attacker)) return;
        r.pendingSelections = r.pendingSelections || {};
        if (!r.pendingSelections[attacker]) r.pendingSelections[attacker] = pick;
      }, randInt(500, 1000));
    }
  }














  const selectedRegion = await waitForPlayerSelection(roomId, attacker, 10000, availableEnemyRegions);

  if (!selectedRegion) {
    console.log(`⏳ Hráč ${attacker} nestihl vybrat → kolo se přeskočí`);
    return null;
  }


// revalidace cíle v aktuálním stavu
 const nowValidTargets = getEnemyRegions(room, attacker);
 if (!nowValidTargets.includes(selectedRegion)) {
   console.log("⚠️ Cíl přestal být validní (stav se změnil) – tah přeskočen.");
   return null;
}



  // ✅ Okamžitě zobraz pin na mapě
  io.to(roomId).emit("playerSelectedRegion", {
    player: attacker,
    region: selectedRegion
  });

  // ✅ Pauza, aby si všichni prohlédli pin (např. 2 s)
  await delay(2000);

  // Najdeme majitele regionu
  let participant2 = null;
  for (let p = 1; p <= 3; p++) {
    if (room.regions[`Player${p}regions`].includes(selectedRegion)) {
      participant2 = p;
      break;
    }
  }


 if (participant2 == null || participant2 === attacker) {
  console.log(`⚠️ Neplatný cíl: útočník ${attacker} → ${selectedRegion} (majitel: ${participant2})`);
   return null;
 }

  console.log(`⚔️ Útočník ${attacker} → Napadá region ${selectedRegion} (majitel: ${participant2})`);

  return {
    claimedBy: attacker,
    currentlyOwnedBy: participant2,
    selectedRegion
  };
}




function getEnemyRegions(room, attacker) {
const owned = new Set(room.regions[`Player${attacker}regions`] || []);
const allEnemyRegions = new Set();

  for (let p = 1; p <= 3; p++) {
    if (p === attacker) continue;

    const enemyRegions = room.regions[`Player${p}regions`] || [];

    enemyRegions.forEach(region => {
      // ✅ Útočit lze jen na regiony, které sousedí s některým z útočníkových regionů
     
      

     if (owned.has(region)) return; // vylouč vlastní regiony při nekonzistenci
     for (const r of owned) {
       if (adjacencyInfo[r]?.includes(region)) {
         allEnemyRegions.add(region);
         break;
       }
     }





    });
  }

console.log(`▶️ getEnemyRegions: Attacker ${attacker}`);
console.log(`  Owned:`, owned);
console.log(`  Regions P1:`, room.regions.Player1regions);
console.log(`  Regions P2:`, room.regions.Player2regions);
console.log(`  Regions P3:`, room.regions.Player3regions);

console.log("ALL AVAILABLE ENEMY REGIONS", allEnemyRegions)

  return Array.from(allEnemyRegions);




}




async function runBattleOnRegion(roomId, attacker, defender, region) {
  const room = rooms[roomId];
  if (!room) return;

  const isBase = region === room.bases[defender];
  console.log(`⚔️ Bitva o region ${region} mezi Hráčem ${attacker} (útočník) a Hráčem ${defender} (obránce)`);

  if (isBase) {
    const lives = room.playerLives[`Player${defender}`] || 3;
    io.to(roomId).emit("showBaseMini", { attacker, defender, lives });
    await delay(1000);
  }

  // 1. BĚŽNÉ POLE → žádná smyčka, jen jedna otázka
  if (!isBase) {
    const correctPlayers = await runMultipleChoice(roomId, [attacker, defender]);
    
    await delay(5000);

    let winner = null;

    if (correctPlayers.length === 1) {
      winner = correctPlayers[0];
    } else if (correctPlayers.length > 1) {
      await delay(2000);
      winner = await runNumericQuestionForTwo(roomId, [attacker, defender]);
      await delay(3000);
    }

    if (winner === attacker) {
      const defKey = `Player${defender}regions`;
      const atkKey = `Player${attacker}regions`;
      const index = room.regions[defKey].indexOf(region);
      if (index !== -1) room.regions[defKey].splice(index, 1);
      if (!room.regions[atkKey].includes(region)) {
        room.regions[atkKey].push(region);
        room.regionValues[region] = 400;
      }
    } 
    
    else if (winner === defender) {


      io.to(roomId).emit("battleDefended");

      const bonusKey = `Player${defender}`;
      room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;

      console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);



    }
    
    else {
      



    }

    // Aktualizace a konec
    await delay(2000);
    room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
    io.to(roomId).emit("updateRegions", {
      regions: room.regions,
      regionValues: room.regionValues,
      scores: room.scores
    });
    io.to(roomId).emit("updateScores", { scores: room.scores });
    return;
  }







  // 2. ZÁKLADNA
  let baseCaptured = false;

  while (!baseCaptured) {
    const correctPlayers = await runMultipleChoice(roomId, [attacker, defender]);
    

    // 2a. Vyhrál pouze útočník
    if (correctPlayers.length === 1 && correctPlayers[0] === attacker) {
      await delay(5100);
      room.playerLives[`Player${defender}`]--;
      io.to(roomId).emit("destroyTower", {
        defender,
        remainingLives: room.playerLives[`Player${defender}`]
      });
      await delay(6100);

      if (room.playerLives[`Player${defender}`] <= 0) {
        transferBase(roomId, room, attacker, defender, region);
        baseCaptured = true;
      }

      continue;
    }

    // 2b. Vyhrál pouze obránce
    if (correctPlayers.length === 1 && correctPlayers[0] === defender) {
      await delay(3000);
      io.to(roomId).emit("battleDefended");

      const bonusKey = `Player${defender}`;
      room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;

      console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);


      break;
    }

    // 2c/2d. Oba odpověděli správně → numeric
    if (correctPlayers.length > 1) {
      await delay(5100);
      const numericWinner = await runNumericQuestionForTwo(roomId, [attacker, defender]);
      await delay(3000);

      if (numericWinner === attacker) {
        await delay(4000);
        room.playerLives[`Player${defender}`]--;
        io.to(roomId).emit("destroyTower", {
          defender,
          remainingLives: room.playerLives[`Player${defender}`]
        });
        await delay(8000);

        if (room.playerLives[`Player${defender}`] <= 0) {
          transferBase(roomId, room, attacker, defender, region);
          baseCaptured = true;
        }

        continue;
      } else {
        io.to(roomId).emit("battleDefended");
        const bonusKey = `Player${defender}`;
        room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;

        console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);



        break;
      }
    }

    // 2e. Nikdo neodpověděl správně
    if (correctPlayers.length === 0) {
      await delay(3000);
      io.to(roomId).emit("battleDefended");
      break;
    }
  }

  if (isBase) {
    await delay(1500);
    io.to(roomId).emit("hideBaseMini");
  }

  // Final update
  room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
  io.to(roomId).emit("updateRegions", {
    regions: room.regions,
    regionValues: room.regionValues,
    scores: room.scores
  });
  io.to(roomId).emit("updateScores", { scores: room.scores });

  await delay(1000);
}




function checkForEliminatedPlayers(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  for (let player = 1; player <= 3; player++) {
    const playerRegions = room.regions[`Player${player}regions`] || [];

    if (playerRegions.length === 0) {
      console.log(`🛑 Hráč ${player} přišel o všechna území!`);
      io.to(roomId).emit("playerLoses", { defender: player });
    }
  }
}


function transferBase(roomId, room, attacker, defender, baseRegion) {
  const defKey = `Player${defender}regions`;
  const atkKey = `Player${attacker}regions`;

  const defenderRegions = room.regions[defKey] || [];

  defenderRegions.forEach(region => {
    if (!room.regions[atkKey].includes(region)) {
      room.regions[atkKey].push(region);
    }

    // ✅ Pouze základně přepiš hodnotu na 400
    if (region === baseRegion) {
      room.regionValues[region] = 400;
    }
  });

  // ✅ Vymaž obráncova území
  room.regions[defKey] = [];

  
  // ✅ Vynuluj obráncovy bonusy
  room.defenseBonuses[`Player${defender}`] = 0;
  console.log(`🛡️ Obránci Player${defender} byly vynulovány defense bonusy.`);


  checkForEliminatedPlayers(roomId);
}

  








function isAnyoneWinning(room) {
  const totalRegions = REGION_IDS.length;
  return (
    room.regions.Player1regions.length === totalRegions ||
    room.regions.Player2regions.length === totalRegions ||
    room.regions.Player3regions.length === totalRegions
  );
}






async function runPlayerTurns(roomId, round, order) {
  const room = rooms[roomId];
  if (!room) return;

  room.selections = {};
  room.lastSelections = {}; // ✅ Reset pro aktuální kolo

  for (const player of order) {
    const availableRegions = getAvailableRegions(room, player);

    // Pokud předchozí hráči v tomto kole zabrali/rezervovali všechna
    // zbývající pole, další hráč už nemá co vybírat. Nečekáme timeout.
    if (availableRegions.length === 0) {
      room.selections[player] = null;
      room.lastSelections[player] = null;
      console.log(`🛑 Hráč ${player} nemá v kole ${round} žádný volný region – tah přeskočen.`);
      continue;
    }

    io.to(roomId).emit("playerTurn", {
      player,
      round,
      timeLeft: 10
    });

      const playerRec = room.players[player - 1];
      const playerSocketId = playerRec && playerRec.id;
      if (playerSocketId) {
        io.to(playerSocketId).emit("availableRegions", {
          regions: availableRegions
        });
      }

    console.log(`🎯 Hráč ${player} je na tahu (kolo ${round})`);

    const selectedRegion = await waitForPlayerSelection(roomId, player, 10000, availableRegions);

    room.selections[player] = selectedRegion;
    room.lastSelections[player] = selectedRegion; // ✅ Uložíme i pro pozdější vyhodnocení

    console.log(`✅ Hráč ${player} vybral: ${selectedRegion}`);

    io.to(roomId).emit("playerSelectedRegion", {
      player,
      region: selectedRegion
    });

    await delay(1000);
  }

  console.log(`📌 Výběry v kole ${round}:`, room.selections);
}











function getAvailableRegions(room, player) {
  const allRegions = REGION_IDS;

  const occupied = [
    ...room.regions.Player1regions,
    ...room.regions.Player2regions,
    ...room.regions.Player3regions
  ];

  const claimed = Array.from(room.claimedRegionsThisRound || []);

  // Volná a neclaimnutá políčka
  const freeRegions = allRegions.filter(region => 
    !occupied.includes(region) && !claimed.includes(region)
  );

  const owned = room.regions[`Player${player}regions`] || [];

  if (owned.length === 0) return freeRegions;

  const adjacentFree = freeRegions.filter(region =>
    owned.some(ownedRegion => adjacencyInfo[ownedRegion]?.includes(region))
  );

  return adjacentFree.length > 0 ? adjacentFree : freeRegions;
}





function getAvailableRegionsConquest(room) {
  return getFreeRegions(room);
}









function waitForPlayerSelection(roomId, player, timeout, forcedAvailableRegions = null) {
  console.log(
    "[waitForPlayerSelection] p:", player,
    " forcedAvailable:", Array.isArray(forcedAvailableRegions) ? forcedAvailableRegions.length : "none"
  );


  return new Promise(resolve => {
    const room = rooms[roomId];
    if (!room) return resolve(null);


    room.pendingSelections = room.pendingSelections || {};
    delete room.pendingSelections[player]; // čistý start kola pro hráče



          //ADDED BOTS
          // --- BOT auto-výběr (běží jen když je sedadlo v módu "bot") ---
          if (isBot(room, player)) {
            // z čeho vybíráme
            const pool = Array.isArray(forcedAvailableRegions)
              ? forcedAvailableRegions
              : getAvailableRegions(room, player);

            if (Array.isArray(pool) && pool.length > 0) {
              const pick = pool[randInt(0, pool.length - 1)];

              // lehké zpoždění a pojistky (může se mezitím vrátit člověk)
              setTimeout(() => {
                const r = rooms[roomId];
                if (!r || !isRoomAlive(roomId)) return;
                if (!isBot(r, player)) return;                  // hráč se mezitím „vzal volant“
                if (r.pendingSelections?.[player]) return;      // už vybráno (třeba člověkem)

                r.pendingSelections = r.pendingSelections || {};
                r.pendingSelections[player] = pick;
                if (r.claimedRegionsThisRound) r.claimedRegionsThisRound.add(pick);
                // dál už si to vyzvedne existující loop v waitForPlayerSelection
              }, randInt(400, 900)); // „přirozené“ zpoždění bota
            }
          }








    





    room.pendingSelections = room.pendingSelections || {};

    let elapsed = 0;
    const interval = setInterval(() => {



      if (!isRoomAlive(roomId)) { // 🔴 NEW
        clearInterval(interval);
        return resolve(null);
      }



      if (room.pendingSelections[player]) {
        clearInterval(interval);
        const region = room.pendingSelections[player];
        delete room.pendingSelections[player];

        if (room.claimedRegionsThisRound) {
          room.claimedRegionsThisRound.add(region);
        }

        resolve(region);
      }

      elapsed += 100;
      if (elapsed >= timeout) {
        clearInterval(interval);

        // ✅ POUŽIJ jen forcedAvailableRegions, pokud existují
        const accessible = Array.isArray(forcedAvailableRegions)
          ? forcedAvailableRegions
          : getAvailableRegions(room, player);

        const randomRegion =
          accessible.length > 0
            ? accessible[Math.floor(Math.random() * accessible.length)]
            : null;

        console.log(`⏳ Hráč ${player} nestihl → náhodně: ${randomRegion}`);

        if (randomRegion && room.claimedRegionsThisRound) {
          room.claimedRegionsThisRound.add(randomRegion);
        }

        resolve(randomRegion);
      }
    }, 100);
  });
}








io.on('connection', socket => {





  socket.on('settings:update', ({ roomId, settings }) => {
    const room = rooms[roomId];
    if (!room) return;

    const safe = sanitizeSettings(settings);
    room.settings = { ...(room.settings || {}), ...safe };

    // (volitelně) pošli potvrzení všem v místnosti
    io.to(roomId).emit('settings:applied', { settings: room.settings });

    console.log('🧩 settings:update', roomId, room.settings);
  });





  socket.on("auth:token", ({ token }) => {
    if (!token) return;
    const roomId = socket.data?.roomId || socket.data?.joinedRoom;
    const room = rooms[roomId];
    if (!room) return;

    const seat = getSeatNumber(room, socket.id);
    if (seat) {
      room.playerTokens[seat] = token;
    }
  });


  socket.on("resume", ({ roomId, token }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("resume:error", { message: "room not found" });

    const entry = Object.entries(room.playerTokens).find(([seat, t]) => t === token);
    if (!entry) return socket.emit("resume:error", { message: "player not recognized" });

    const seat = parseInt(entry[0], 10);

    // připoj socket do room
    socket.join(roomId);
    socket.data = socket.data || {};
    socket.data.joinedRoom = roomId;
    socket.data.roomId = roomId;
    socket.data.seat = seat;

    // rebinding hráče na nový socket.id
    const rec = room.players[seat - 1];
    if (rec) rec.id = socket.id;

    // když byl dočasně bot → vrať člověka k volantu
    room.seatControllers[seat] = "human";

    // zruš grace timeout (viz níž)
    const prevTO = room.reconnectHolds.get(seat);
    if (prevTO) {
      clearTimeout(prevTO);
      room.reconnectHolds.delete(seat);
    }

    // Pošli snapshot místo startu
    socket.emit("stateSync", {
      myNumber: seat,
      snapshot: buildRoomSnapshot(room, roomId)
    });

    // ať ostatní vidí, že hráč je zpět “human”
    const allNames = {};
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      const p = room.players[i];
      allNames[i + 1] = (p && p.name) ? p.name : `Robot ${i + 1}`;
    }



    const displayNames = {
      1: displayName(room, 1, true),
      2: displayName(room, 2, true),
      3: displayName(room, 3, true)
    };

    io.to(roomId).emit("updatePlayers", { allNames, displayNames, seatControllers: room.seatControllers });
  });





  console.log(`✅ ${socket.id} connected`);


  socket.on("baseSettled", ({ playerNumber } = {}) => {
    // baseSettled smí měnit pouze místnost, ke které patří tento socket.
    // Původní verze procházela VŠECHNY rooms, takže event z jiné rozehrané
    // hry mohl v lobby jiné room vytvořit room.regionValues[undefined] = 1000.
    const roomId = socket.data?.joinedRoom || socket.data?.roomId;
    const room = roomId ? rooms[roomId] : null;
    if (!room || !isRoomAlive(roomId)) {
      console.warn(`⚠️ baseSettled ignorován – socket ${socket.id} není v aktivní místnosti.`);
      return;
    }

    const seat = Number(playerNumber);
    if (![1, 2, 3].includes(seat)) {
      console.warn(`⚠️ baseSettled ignorován – neplatné číslo hráče: ${playerNumber}`);
      return;
    }

    sanitizeRoomRegionState(room, roomId);

    const regionKey = `Player${seat}regions`;
    const baseRegion = room.bases?.[seat];

    // Kritická validace: na mapu se nesmí zapsat undefined ani jiný cizí klíč.
    if (!REGION_ID_SET.has(baseRegion)) {
      console.warn(`⚠️ baseSettled ignorován v ${roomId} – Player${seat} nemá platnou základnu (${String(baseRegion)}).`);
      return;
    }

    room.regionValues[baseRegion] = 1000;

    if (!Array.isArray(room.regions[regionKey])) room.regions[regionKey] = [];
    if (!room.regions[regionKey].includes(baseRegion)) {
      room.regions[regionKey].push(baseRegion);
    }

    room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

    io.to(roomId).emit("updateScores", { scores: room.scores });
    console.log(`✅ ${roomId}: Hráč ${seat} usadil základnu ${baseRegion} (1000 bodů)`);
    console.log("🧮 Nové skóre:", room.scores);
  });




  // FRIENDS: host vytvoří místnost a rovnou se do ní přidá
socket.on("createRoom", ({ settings }) => {
  const name   = (settings?.name || "Host").toString();
  const mode   = (settings?.mode || 'friends');   // ⬅️ vezmeme mód z klienta
  const roomId = makeFriendsRoomId();

  const room = makeEmptyRoom(roomId, mode);       // ⬅️ použij mód i do room
  room.settings = settings || {};

  socket.emit("roomReady", { room: roomId });

  socket.data = socket.data || {};
  socket.data.joinedRoom = roomId;
  socket.data.name = name;

  // === SOLO vs BOTI: předvyplň sedadla 2 a 3 jako boty ===
  if (mode === 'bots') {
    // zajisti délku pole players = 3
    while (room.players.length < MAX_PLAYERS_PER_ROOM) room.players.push(undefined);

    // sedadla 2 a 3: „bot“ (id=null), jméno necháme podle ROBOT_NAMES
    room.players[1] = { id: null, name: (ROBOT_NAMES[2] || 'Robot 2') };
    room.players[2] = { id: null, name: (ROBOT_NAMES[3] || 'Robot 3') };

    room.seatControllers[2] = 'bot';
    room.seatControllers[3] = 'bot';
  }

  // hostitele posaď normálně (obsadí první volné sedadlo – bude to 1)
  roomAddPlayerAndBroadcast(roomId, socket, name);

  // po přidání hráče pošli snapshot
  const seatNum = getSeatNumber(rooms[roomId], socket.id);
  socket.emit("stateSync", { myNumber: seatNum, snapshot: buildRoomSnapshot(rooms[roomId], roomId) });
});






// FRIENDS: hosté (nebo host, pokud už má kód) se připojují do existující room
socket.on("joinRoom", ({ room, settings }) => {
  const name = (settings?.name || "").toString().trim() || "Host";
  const roomId = sanitizeRoomId(room);
  if (!roomId) {
    socket.emit("roomError", { message: "Missing or invalid room id" });
    return;
  }

  if (!rooms[roomId]) {
    makeEmptyRoom(roomId, 'friends');
    rooms[roomId].settings = settings || {};
  }

  // ⬇️ doplň tohle (volitelné)
  if (rooms[roomId].mode === 'bots') {
    socket.emit("roomError", { message: "Tahle místnost je sólo proti botům." });
    return;
  }

  const current = rooms[roomId];
  if (occupiedSeatCount(current) >= MAX_PLAYERS_PER_ROOM) {
    socket.emit("roomError", { message: "Room is full" });
    return;
  }

  const safeName = (name || socket.data?.name || "Host").toString();
  socket.data = socket.data || {};
  socket.data.joinedRoom = roomId;
  socket.data.name = name;

  roomAddPlayerAndBroadcast(roomId, socket, safeName);
  console.log(`👥 joinRoom → ${roomId} by ${name}`);

  const seatNum = getSeatNumber(rooms[roomId], socket.id);
  socket.emit("stateSync", { myNumber: seatNum, snapshot: buildRoomSnapshot(rooms[roomId], roomId) });
});












  socket.on("submitName", name => {
    // ✅ už je socket v nějaké room (friends)? ignoruj random přihlášku
    if (socket.data?.joinedRoom) return;

    // ✅ vezmi první NEplnou room, která je opravdu random
    let roomId = Object.keys(rooms).find(id =>
      rooms[id].mode === 'random' && occupiedSeatCount(rooms[id]) < MAX_PLAYERS_PER_ROOM
    );

    // žádná random room? vytvoř novou
    if (!roomId) {
      roomId = `room_${Date.now()}`;
      makeEmptyRoom(roomId, 'random');
    }

    socket.data = socket.data || {};
    socket.data.joinedRoom = roomId;
    socket.data.name = name;

    roomAddPlayerAndBroadcast(roomId, socket, name);

    console.log(`🎮 ${name} joined ${roomId}`);
  });













socket.on("disconnect", () => {
  const roomId = socket.data?.joinedRoom || socket.data?.roomId;
  if (!roomId || !rooms[roomId]) return;

  const room = rooms[roomId];
  const ix = room.players.findIndex(p => p && p.id === socket.id);
  if (ix === -1) return;

  const seat = ix + 1;
  const name = room.players[ix]?.name || `Player${seat}`;

  console.log(`⌛ ${name} temporarily left ${roomId} – switching seat ${seat} to BOT`);

  // nepřehazuj sedadla – jen zneplatni id a přepni na bota
  room.seatControllers = room.seatControllers || {1:"human",2:"human",3:"human"};
  room.seatControllers[seat] = "bot";
  room.players[ix].id = null; // jméno zůstává!

  // pobídni klienty k refreshi UI (jména zůstávají stejné)
  const allNames = {};
  room.players.forEach((p, i) => { if (p) allNames[i + 1] = p.name; });



  const displayNames = {
      1: displayName(room, 1, true),
      2: displayName(room, 2, true),
      3: displayName(room, 3, true)
    };

  io.to(roomId).emit("updatePlayers", { allNames, displayNames, seatControllers: room.seatControllers });
  io.to(roomId).emit("updateScores", { scores: room.scores });

  // když je room opravdu prázdná (všechna sedadla bez id a živých socketů), pak uklidit
  if (room.players.every(p => !p || p.id == null)) {
    markRoomClosed?.(roomId);
    // delete rooms[roomId]; // mazat jen když fakt chceš
  }
});



 socket.on("claimRegion", ({ round, region }) => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    if (!room) continue;

    const player = room.players.findIndex(p => p.id === socket.id) + 1;
    if (player) {
      room.pendingSelections = room.pendingSelections || {};
      room.pendingSelections[player] = region;
      console.log(`📩 Přijato: Hráč ${player} → ${region}`);
      break;
    }
  }


});



socket.on("chat:send", ({ roomId, text }) => {
  console.log("📩 chat:send received", { from: socket.id, roomId, text });

  const room = rooms[roomId];
  if (!room) {
    console.log("❌ room not found for chat:", roomId);
    return;
  }

  const clean = (typeof text === "string" ? text.trim() : "");
  if (!clean) {
    console.log("❌ empty/invalid text");
    return;
  }

  // CHANGED: určete číslo hráče (1..3) – vždy podle aktuálního pořadí
  const number = getSeatNumber(room, socket.id) || 0;

  const ix = room.players.findIndex(p => p.id === socket.id);
  const name = ix !== -1 ? room.players[ix].name : "Neznámý hráč";

  // CHANGED: ukládáme i number do historie
  const msg = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    name,
    text: clean.slice(0, 500),
    ts: Date.now(),
    number // 1|2|3 (0 = neznámý/observer)
  };

  room.chat = room.chat || [];
  room.chat.push(msg);
  if (room.chat.length > 200) room.chat.shift();

  console.log(`💬 [${roomId}] #${number} ${name}: ${clean}`);
  io.to(roomId).emit("chat:new", msg);
});



socket.on('chat:history:get', ({ roomId }) => {
  const room = rooms[roomId];
  if (!room) return;
  socket.emit('chat:history', room.chat || []);
});






  socket.on("addValueToBase", ({ base, roomId }) => {
        if (!roomId || !base) return;

        // Inicializuj místnost, pokud ještě neexistuje
        if (!regionValuesByRoom[roomId]) {
            regionValuesByRoom[roomId] = {};
        }

        // Nastav hodnotu základny na 1000
        regionValuesByRoom[roomId][base] = 1000;

       
  });



socket.on("playerAnswered", ({ room: roomId, player, answerIndex }) => {
  const room = rooms[roomId];
  if (!room) return;

  room.answers = room.answers || {};

  // Ulož odpověď jen pokud ještě neodpověděl
  if (room.answers[player] === undefined) {
    room.answers[player] = answerIndex;
    console.log(`✏️ Hráč ${player} v ${roomId} odpověděl: ${answerIndex}`);
  }
});




socket.on("playerNumericAnswer", ({ room: roomId, player, answer }) => {
  const room = rooms[roomId];
  if (!room) return;

  
  room.numericAnswers = room.numericAnswers || {};
  const startTime = room.numericStartTime || Date.now(); // server uchovává začátek

  if (!room.numericAnswers[player]) {
    room.numericAnswers[player] = {
      num: answer,
      time: Date.now() - startTime
    };
    console.log(`✏️ Numerická odpověď: Hráč ${player} v ${roomId} → ${answer} (${room.numericAnswers[player].time}ms)`);
  }
});







});




