console.log('🧪 VLASTENEC BUILD: 2026-08-18-refresh-room-lifecycle-v1');
console.log('🧪 VLASTENEC BUILD: 2026-08-18-start-sequence-sync-v1');
console.log('🧪 VLASTENEC BUILD: 2026-08-18-base-score-on-settle-v1');
console.log('🧪 VLASTENEC BUILD: 2026-08-18-authoritative-refresh-v1');
console.log('🧪 VLASTENEC BUILD: 2026-08-18-mc-human-timing-v1');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const db = require('./db');
const { mountAuthRoutes, sessionUser } = require('./auth');
const { mountProfileRoutes, recordAuthoritativeQuestion, recordAuthoritativeMatch } = require('./player-profile');
const { mountLeaderboardRoutes, finalizeNormalRatedMatch } = require('./leaderboards');
const {
  mountLeagueRoutes, leagueEntryForSocketRequest, createReadyMatch, cancelLeagueMatch,
  activateLeagueMatch, activeLeagueMatchForUser, leagueMatchForUser, leagueMatchPlayers, finalizeLeagueMatch,
  recoverInterruptedLeagueMatches
} = require('./league');




const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
mountAuthRoutes(app);
mountProfileRoutes(app);
mountLeagueRoutes(app);
mountLeaderboardRoutes(app);
app.use(express.static('public')); // servíruje index.html a další soubory

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } }); // (později si omezíš)

// Přibližná online přítomnost: počítáme právě připojené Socket.IO klienty.
// Jeden člověk s více otevřenými kartami se může započítat vícekrát,
// ale pro portal je to stabilní a okamžitý údaj bez zásahu do herní logiky.
const portalOnlineSockets = new Set();
function broadcastPortalOnlineCount() {
  io.emit('portal:onlineCount', { count: portalOnlineSockets.size });
}



const PORT = process.env.PORT || 3000;
(async () => {
  await db.initDatabase();
  if (db.getStatus().ready) await recoverInterruptedLeagueMatches().catch(err => console.error('league boot recovery:', err));
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Server běží na', PORT);
    console.log('🧪 VLASTENEC BUILD: 2026-08-18-authoritative-refresh-v1');
    console.log('🧪 VLASTENEC BUILD: 2026-08-18-mc-human-timing-v1');
  });
})();






const MAX_PLAYERS_PER_ROOM = 3;
const rooms = {}; // roomId -> { players, scores, bases, regions, regionValues, defenseBonuses }
const communityChat = []; // globální komunitní chat; v RAM, max. 200 zpráv
const regionValuesByRoom = {};

// Liga: transientní fronta je v RAM; autoritativní nalezené zápasy jsou v PostgreSQL.
const leagueQueue = new Map();             // userId -> queue entry
const leagueReadyChecks = new Map();       // matchId -> ready state
const leagueMatchRooms = new Map();        // matchId -> roomId
const leagueCooldowns = new Map();          // userId -> timestamp
let leagueMatchmakingBusy = false;



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
// Snapshot je autoritativní zdroj pravdy po F5/reconnectu. Nevrací jen mapu,
// ale i právě běžící interakci (otázku / výběr pole), aby klient nemusel
// hádat, co se na serveru zrovna děje.
function buildActiveQuestionSnapshot(room, forSeat = null) {
  const q = room?.activeQuestion;
  if (!q || !room.currentQuestionType) return null;

  const seat = Number(forSeat) || null;
  const participants = Array.isArray(q.participants) ? q.participants.map(Number) : [];
  const answered = seat
    ? (q.kind === 'choice' ? room.answers?.[seat] !== undefined : !!room.numericAnswers?.[seat])
    : false;
  const ownAnswer = seat && answered
    ? (q.kind === 'choice' ? room.answers?.[seat] : room.numericAnswers?.[seat]?.num)
    : null;

  return {
    kind: q.kind,
    question: q.question,
    options: Array.isArray(q.options) ? [...q.options] : null,
    category: q.category || null,
    participants,
    attacker: q.attacker ?? null,
    defender: q.defender ?? null,
    attackerName: q.attackerName || '',
    defenderName: q.defenderName || '',
    startedAt: Number(q.startedAt) || null,
    deadline: Number(q.deadline) || null,
    remainingMs: Math.max(0, (Number(q.deadline) || Date.now()) - Date.now()),
    answered,
    ownAnswer,
    isParticipant: !!seat && participants.includes(seat),
    canAnswer: !!seat && participants.includes(seat) && !answered
  };
}

function buildActiveTurnSnapshot(room, forSeat = null) {
  const turn = room?.activeTurn;
  if (!turn) return null;
  const seat = Number(forSeat) || null;
  return {
    kind: turn.kind || null,
    player: Number(turn.player) || null,
    round: Number(turn.round) || 0,
    battlestick: Number(turn.battlestick) || null,
    deadline: Number(turn.deadline) || null,
    remainingMs: Math.max(0, (Number(turn.deadline) || Date.now()) - Date.now()),
    canSelect: !!seat && Number(turn.player) === seat,
    availableRegions: (!!seat && Number(turn.player) === seat && Array.isArray(turn.availableRegions))
      ? [...turn.availableRegions]
      : []
  };
}

function normalizeAuthoritativeBaseState(room) {
  if (!room) return;
  room.bases = room.bases || {};
  room.playerLives = room.playerLives || { Player1:3, Player2:3, Player3:3 };
  for (let seat = 1; seat <= 3; seat++) {
    const base = room.bases[seat];
    if (!base) continue;
    const owned = room.regions?.[`Player${seat}regions`] || [];
    if (!owned.includes(base) || Number(room.playerLives[`Player${seat}`]) <= 0) {
      delete room.bases[seat];
    }
  }
}

function buildRoomSnapshot(room, roomId, forSeat = null) {
  normalizeAuthoritativeBaseState(room);
  // Skóre se při reconnectu vždy dopočítá z autoritativních regionů, hodnot a bonusů.
  // Tím se neopíráme o případnou starou cache z předchozího eventu.
  if (room?.regions && room?.regionValues && room?.defenseBonuses) {
    room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
  }

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
    battlestick: room.battlestick || null,
    bases: { ...(room.bases || {}) },
    regions: {
      Player1regions: [...(room.regions?.Player1regions || [])],
      Player2regions: [...(room.regions?.Player2regions || [])],
      Player3regions: [...(room.regions?.Player3regions || [])]
    },
    regionValues: { ...(room.regionValues || {}) },
    scores: { ...(room.scores || {}) },
    defenseBonuses: { ...(room.defenseBonuses || {}) },
    playerLives: { ...(room.playerLives || {}) },
    baseScoreSettled: { ...(room.baseScoreSettled || { 1:false, 2:false, 3:false }) },
    seatControllers: { ...(room.seatControllers || {}) },
    expansionPlan: room.expansionPlan || null,
    battlePlan: room.battlePlan || null,
    activeQuestion: buildActiveQuestionSnapshot(room, forSeat),
    activeTurn: buildActiveTurnSnapshot(room, forSeat),
    activeBaseBattle: room.activeBaseBattle ? { ...room.activeBaseBattle } : null,
    pendingPins: { ...(room.pendingPins || {}) },
    chat: room.chat || [],
    settings: room.settings || {},
    matchKind: room.matchKind || null,
    publicRoom: !!room.publicRoom,
    ready: room.ready || { 1: false, 2: false, 3: false }
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
    pendingPins: {},
    chat: [],
    settings: {},           // volitelné – můžeš sem ukládat cats/catNames
    ready: { 1: false, 2: false, 3: false },
    matchKind: null,         // random: 'quick' | 'custom'
    publicRoom: false,
    createdAt: Date.now(),
    skillRating: null,
    profileMatchId: `match-${randomUUID()}`,
    profileWriteChain: Promise.resolve(),
    profileQuestionWins: { 1: 0, 2: 0, 3: 0 },
    profileTerritoriesGained: { 1: 0, 2: 0, 3: 0 },


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



function profileModeForRoom(room) {
  if (!room) return 'random';
  if (room.mode === 'liga') return 'league';
  if (room.mode === 'random' && room.matchKind === 'custom') return 'custom';
  if (['random','friends','bots'].includes(room.mode)) return room.mode;
  return 'random';
}

function profileUserIdForSeat(room, seat) {
  const rec = room?.players?.[Number(seat) - 1];
  const direct = rec?.userId || room?.leagueUsers?.[Number(seat)] || null;
  if (direct) return String(direct);
  const liveSocket = rec?.id ? io.sockets.sockets.get(rec.id) : null;
  return liveSocket?.data?.accountUserId ? String(liveSocket.data.accountUserId) : null;
}

function queueProfileWrite(room, label, task) {
  if (!room || typeof task !== 'function') return Promise.resolve();
  const previous = room.profileWriteChain || Promise.resolve();
  room.profileWriteChain = previous
    .catch(() => {})
    .then(task)
    .catch(err => {
      console.error(`📊 Profilová událost ${label} selhala:`, err);
    });
  return room.profileWriteChain;
}

function noteProfileTerritoryGain(room, seat, count = 1) {
  if (!room || ![1,2,3].includes(Number(seat))) return;
  room.profileTerritoriesGained = room.profileTerritoriesGained || {1:0,2:0,3:0};
  room.profileTerritoriesGained[Number(seat)] = Math.max(0, Number(room.profileTerritoriesGained[Number(seat)] || 0) + Math.max(0, Number(count)||0));
}

function queueQuestionProfileEvents(room, eventBase, category, questionType, seats, detailsBySeat = {}) {
  if (!room) return;
  const mode = profileModeForRoom(room);
  const matchId = String(room.profileMatchId || '').slice(0,80);
  const tasks = [];
  for (const rawSeat of seats || []) {
    const seat = Number(rawSeat);
    if (![1,2,3].includes(seat)) continue;
    const detail = detailsBySeat[seat] || {};
    recordMatchQuestionStat(room, seat, category, questionType, detail);
    if (detail.success) {
      room.profileQuestionWins = room.profileQuestionWins || {1:0,2:0,3:0};
      room.profileQuestionWins[seat] = Number(room.profileQuestionWins[seat] || 0) + 1;
    }
    const userId = profileUserIdForSeat(room,seat);
    if (!userId) continue;
    tasks.push({
      userId,
      eventId:`${eventBase}-s${seat}`.slice(0,80),
      matchId,
      mode,
      category,
      questionType,
      success:!!detail.success,
      answered:detail.answered !== false,
      answerNumeric:detail.answerNumeric,
      correctNumeric:detail.correctNumeric,
      numericErrorPct:detail.numericErrorPct,
      exactHit:!!detail.exactHit
    });
  }
  if (!tasks.length) return;
  queueProfileWrite(room,`${questionType}:${eventBase}`,() => Promise.all(tasks.map(recordAuthoritativeQuestion)));
}

function numericErrorPercent(answer, correct, answered = true) {
  if (!answered) return 100;
  const a = Number(answer), c = Number(correct);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return 100;
  const denominator = Math.max(1, Math.abs(c));
  return Math.min(1_000_000, Math.abs(a-c) / denominator * 100);
}

function ensureMatchStats(room) {
  if (!room) return null;
  if (!room.matchStats) {
    room.matchStats = {
      1: { choiceAsked:0, choiceAnswered:0, choiceCorrect:0, numericAsked:0, numericAnswered:0, numericWins:0, numericErrors:[], exactHits:0, categories:{} },
      2: { choiceAsked:0, choiceAnswered:0, choiceCorrect:0, numericAsked:0, numericAnswered:0, numericWins:0, numericErrors:[], exactHits:0, categories:{} },
      3: { choiceAsked:0, choiceAnswered:0, choiceCorrect:0, numericAsked:0, numericAnswered:0, numericWins:0, numericErrors:[], exactHits:0, categories:{} }
    };
  }
  return room.matchStats;
}

function recordMatchQuestionStat(room, seat, category, questionType, detail = {}) {
  const all = ensureMatchStats(room);
  seat = Number(seat);
  if (!all || ![1,2,3].includes(seat)) return;
  const stat = all[seat];
  const answered = detail.answered !== false;
  const success = !!detail.success;

  if (questionType === 'choice') {
    stat.choiceAsked += 1;
    if (answered) stat.choiceAnswered += 1;
    if (success) stat.choiceCorrect += 1;
  } else if (questionType === 'numeric') {
    stat.numericAsked += 1;
    if (answered) stat.numericAnswered += 1;
    if (success) stat.numericWins += 1;
    const err = Number(detail.numericErrorPct);
    if (Number.isFinite(err)) stat.numericErrors.push(Math.max(0, err));
    if (detail.exactHit) stat.exactHits += 1;
  }

  const cat = String(category || '').trim();
  if (cat) {
    stat.categories[cat] = stat.categories[cat] || { asked:0, successes:0 };
    stat.categories[cat].asked += 1;
    if (success) stat.categories[cat].successes += 1;
  }
}

function medianNumber(values = []) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a,b) => a-b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function buildEndgameMatchStats(room, ordered = []) {
  const all = ensureMatchStats(room) || {};
  const placementBySeat = {};
  const scoreBySeat = {};
  (ordered || []).forEach((entry, index) => {
    placementBySeat[Number(entry.player)] = index + 1;
    scoreBySeat[Number(entry.player)] = Number(entry.score) || 0;
  });

  return {
    authoritative: true,
    players: [1,2,3].map(seat => {
      const stat = all[seat] || {};
      const categories = Object.entries(stat.categories || {}).map(([name, value]) => ({
        name,
        asked: Number(value.asked) || 0,
        successes: Number(value.successes) || 0,
        rate: Number(value.asked) > 0 ? (Number(value.successes) / Number(value.asked)) * 100 : 0
      })).sort((a,b) => b.rate - a.rate || b.successes - a.successes || b.asked - a.asked || a.name.localeCompare(b.name, 'cs'));
      const bestCategory = categories[0] || null;
      const choiceAsked = Number(stat.choiceAsked) || 0;
      const choiceCorrect = Number(stat.choiceCorrect) || 0;
      return {
        seat,
        name: displayName(room, seat, true),
        placement: placementBySeat[seat] || null,
        score: scoreBySeat[seat] || 0,
        choiceAsked,
        choiceAnswered: Number(stat.choiceAnswered) || 0,
        choiceCorrect,
        choiceAccuracyPct: choiceAsked ? (choiceCorrect / choiceAsked) * 100 : null,
        numericAsked: Number(stat.numericAsked) || 0,
        numericAnswered: Number(stat.numericAnswered) || 0,
        numericWins: Number(stat.numericWins) || 0,
        numericMedianErrorPct: medianNumber(stat.numericErrors || []),
        exactHits: Number(stat.exactHits) || 0,
        territoriesGained: Number(room.profileTerritoriesGained?.[seat]) || 0,
        questionSuccesses: Number(room.profileQuestionWins?.[seat]) || 0,
        bestCategory
      };
    })
  };
}

async function refreshRoomAccountIds(room) {
  if (!room) return;
  const waits = [];
  for (const seat of [1,2,3]) {
    const rec = room.players?.[seat - 1];
    if (!rec) continue;
    const liveSocket = rec.id ? io.sockets.sockets.get(rec.id) : null;
    if (!liveSocket) continue;
    const promise = liveSocket.data?.accountPromise;
    if (promise && typeof promise.then === 'function') {
      waits.push(Promise.resolve(promise).then(user => {
        if (user?.id) {
          liveSocket.data.accountUserId = String(user.id);
          rec.userId = String(user.id);
        }
      }).catch(() => {}));
    } else if (liveSocket.data?.accountUserId) {
      rec.userId = String(liveSocket.data.accountUserId);
    }
  }
  if (waits.length) await Promise.allSettled(waits);
}

async function finalizeAuthoritativeProfiles(roomId, ordered) {
  const room = rooms[roomId];
  if (!room || !Array.isArray(ordered)) return { normalRating:null };

  // Socket authentication is asynchronous. A fast matchmaking join can happen
  // before sessionUser() has finished. Before finalizing a rated quick match,
  // explicitly wait for the account promises and persist the resolved user IDs
  // into the room seats. This removes a race where a valid logged-in player
  // could be treated as a guest at match end.
  await refreshRoomAccountIds(room);
  try { await (room.profileWriteChain || Promise.resolve()); } catch (_) {}

  const mode = profileModeForRoom(room);
  const matchId = String(room.profileMatchId || `match-${randomUUID()}`).slice(0,80);
  room.profileMatchId = matchId;
  const profileWrites = [];
  const ratedPlayers = [];

  ordered.forEach((entry,index) => {
    const seat = Number(entry.player);
    if (![1,2,3].includes(seat)) return;
    const userId = profileUserIdForSeat(room,seat);
    if (!userId) return;
    const rec = room.players?.[seat-1];
    const opponents = ordered
      .filter(other => Number(other.player) !== seat)
      .map(other => room.players?.[Number(other.player)-1]?.name || `Hráč ${other.player}`);
    profileWrites.push(recordAuthoritativeMatch({
      userId,
      eventId:`m-${matchId}-s${seat}`.slice(0,80),
      mode,
      placement:index+1,
      score:Number(entry.score)||0,
      territories:Number(room.profileTerritoriesGained?.[seat]||0),
      questionWins:Number(room.profileQuestionWins?.[seat]||0),
      opponents
    }));
    ratedPlayers.push({ userId, displayName:rec?.name || `Hráč ${seat}`, placement:index+1 });
  });

  if (profileWrites.length) {
    const results = await Promise.allSettled(profileWrites);
    const rejected = results.filter(r=>r.status==='rejected');
    if (rejected.length) console.error(`📊 ${roomId}: ${rejected.length} profilových zápisů zápasu selhalo.`);
  }

  let normalRating = null;
  if (room.mode === 'random' && room.matchKind === 'quick') {
    const uniqueUsers = new Set(ratedPlayers.map(p=>String(p.userId)));
    const allHumanAtFinish = [1,2,3].every(seat => room.seatControllers?.[seat] === 'human');
    const seatAuth = [1,2,3].map(seat => ({
      seat,
      name: room.players?.[seat-1]?.name || null,
      userId: profileUserIdForSeat(room,seat),
      controller: room.seatControllers?.[seat] || null
    }));

    console.log(`📈 NORMAL eligibility ${roomId}: ${seatAuth.map(x => `P${x.seat}=${x.name || '-'}:${x.userId || 'guest'}:${x.controller}`).join(' | ')}`);

    if (ratedPlayers.length === 3 && uniqueUsers.size === 3 && allHumanAtFinish) {
      normalRating = await finalizeNormalRatedMatch(matchId,ratedPlayers,roomId);
      console.log(`📈 NORMAL rated ${roomId}: ${normalRating?.players?.map(p => `${p.displayName} ${p.ratingBefore}→${p.ratingAfter} (${p.ratingDelta >= 0 ? '+' : ''}${p.ratingDelta})`).join(' | ') || 'done'}`);
    } else {
      let reason = 'three_authenticated_players_required';
      if (!allHumanAtFinish) reason = 'bot_or_disconnect_present';
      else if (ratedPlayers.length !== 3) reason = 'one_or_more_guests';
      else if (uniqueUsers.size !== 3) reason = 'duplicate_account';
      normalRating = { rated:false, reason, seats:seatAuth };
      console.log(`📈 NORMAL skipped ${roomId}: ${reason}`);
    }
  }
  return { normalRating };
}

function sanitizePlayerName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function isPlayerNameTaken(room, name, exceptSeat = null) {
  const normalized = String(name || '').toLocaleLowerCase('cs-CZ');
  return (room?.players || []).some((p, index) => {
    if (!p?.name || (exceptSeat && index + 1 === Number(exceptSeat))) return false;
    return String(p.name).toLocaleLowerCase('cs-CZ') === normalized;
  });
}

// ===== LOBBY =====
function buildLobbyState(room, roomId) {
  const ready = room.ready || { 1: false, 2: false, 3: false };
  const players = [1, 2, 3].map(seat => {
    const rec = room.players?.[seat - 1];
    const controller = room.seatControllers?.[seat] || 'human';
    return {
      seat,
      name: rec?.name || null,
      connected: controller === 'bot' ? true : !!rec?.id,
      ready: controller === 'bot' ? true : !!ready[seat],
      controller,
      host: seat === 1
    };
  });

  const allConnected = players.every(p => p.name && p.connected);
  const allReady = players.every(p => p.name && p.connected && p.ready);
  const connectedHumans = players.filter(p => p.controller !== 'bot' && p.name && p.connected);
  const connectedHumanReady = connectedHumans.every(p => p.ready);

  const canStart = (
    // FRIENDS: hostitel může spustit už ve dvou, pokud jsou oba lidé připraveni.
    // Chybějící třetí sedadlo se při startu doplní botem.
    (room.mode === 'friends' && !room.hasStarted && connectedHumans.length >= 2 && connectedHumanReady) ||
    (room.mode === 'bots' && !room.hasStarted && !!players[0]?.connected) ||
    // RANDOM CUSTOM: hostitel může spustit už se dvěma lidmi; třetí místo doplní bot.
    (room.mode === 'random' && room.matchKind === 'custom' && !room.hasStarted && connectedHumans.length >= 2)
  );

  return {
    roomId,
    mode: room.mode,
    matchKind: room.matchKind || null,
    publicRoom: !!room.publicRoom,
    players,
    hostSeat: 1,
    settings: room.settings || {},
    allConnected,
    allReady,
    canStart
  };
}

function broadcastLobbyState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('lobby:state', buildLobbyState(room, roomId));
}

function connectedHumanCount(room) {
  return (room?.players || []).filter(p => p && p.id).length;
}

function randomRoomSummary(roomId, room) {
  const players = (room.players || []).filter(p => p && p.id);
  const host = room.players?.[0]?.name || 'Hostitel';
  return {
    roomId,
    code: String(roomId || '').replace(/^room_/i, ''),
    host,
    occupancy: players.length,
    capacity: MAX_PLAYERS_PER_ROOM,
    cats: Array.isArray(room.settings?.cats) && room.settings.cats.length ? room.settings.cats : [1,2,3,4,5,6,7,8,9],
    createdAt: room.createdAt || Date.now()
  };
}

function listPublicRandomRooms() {
  return Object.entries(rooms)
    .filter(([roomId, room]) => room && !room.__closed && room.mode === 'random' && room.matchKind === 'custom' && room.publicRoom && !room.hasStarted && connectedHumanCount(room) < MAX_PLAYERS_PER_ROOM && !!room.players?.[0]?.id)
    .map(([roomId, room]) => randomRoomSummary(roomId, room))
    .sort((a,b) => a.createdAt - b.createdAt);
}

function broadcastPublicRandomRooms() {
  io.emit('random:custom:rooms', listPublicRandomRooms());
}

function pickQuickMatchRoom(rating = null) {
  const candidates = Object.entries(rooms)
    .filter(([roomId, room]) => room && !room.__closed && room.mode === 'random' && room.matchKind === 'quick' && !room.hasStarted && connectedHumanCount(room) < MAX_PLAYERS_PER_ROOM)
    .map(([roomId, room]) => ({ roomId, room }));

  if (!candidates.length) return null;
  const r = Number.isFinite(Number(rating)) ? Number(rating) : null;
  candidates.sort((a,b) => {
    if (r != null) {
      const ar = Number.isFinite(Number(a.room.skillRating)) ? Number(a.room.skillRating) : r;
      const br = Number.isFinite(Number(b.room.skillRating)) ? Number(b.room.skillRating) : r;
      const ad = Math.abs(ar-r), bd = Math.abs(br-r);
      if (ad !== bd) return ad-bd;
    }
    return (a.room.createdAt || 0) - (b.room.createdAt || 0);
  });
  return candidates[0];
}

function fillMissingLobbySeatsWithBots(roomId) {
  const room = rooms[roomId];
  if (!room || room.hasStarted) return;

  room.seatControllers = room.seatControllers || { 1: 'human', 2: 'human', 3: 'human' };
  room.ready = room.ready || { 1: false, 2: false, 3: false };
  while (room.players.length < MAX_PLAYERS_PER_ROOM) room.players.push(undefined);

  for (let seat = 1; seat <= MAX_PLAYERS_PER_ROOM; seat++) {
    const rec = room.players[seat - 1];
    const hasLiveHuman = !!rec?.id && room.seatControllers[seat] !== 'bot';
    if (hasLiveHuman) continue;

    room.players[seat - 1] = { id: null, name: ROBOT_NAMES[seat] || `Robot ${seat}` };
    room.seatControllers[seat] = 'bot';
    room.ready[seat] = true;
  }

  const allNames = {};
  room.players.forEach((p, idx) => { if (p) allNames[idx + 1] = p.name; });
  const displayNames = {
    1: displayName(room, 1, true),
    2: displayName(room, 2, true),
    3: displayName(room, 3, true)
  };

  io.to(roomId).emit('updatePlayers', { allNames, displayNames, seatControllers: room.seatControllers });
  broadcastLobbyState(roomId);
}

function awardBaseSettlementScore(roomId, seat, source = 'client') {
  const room = rooms[roomId];
  seat = Number(seat);
  if (!room || !isRoomAlive(roomId) || ![1, 2, 3].includes(seat)) return false;

  if (room.phase !== 'settle') {
    console.log(`↩️ ${roomId}: základna Player${seat} bez bodů mimo settle (${room.phase}) [${source}]`);
    return false;
  }

  sanitizeRoomRegionState(room, roomId);
  room.baseScoreSettled = room.baseScoreSettled || { 1: false, 2: false, 3: false };
  if (room.baseScoreSettled[seat]) return false;

  const baseRegion = room.bases?.[seat];
  const regionKey = `Player${seat}regions`;
  if (!REGION_ID_SET.has(baseRegion)) {
    console.warn(`⚠️ ${roomId}: nelze připsat základnu Player${seat} – neplatný region ${String(baseRegion)} [${source}]`);
    return false;
  }
  if (!Array.isArray(room.regions?.[regionKey]) || !room.regions[regionKey].includes(baseRegion)) {
    console.warn(`⚠️ ${roomId}: nelze připsat základnu Player${seat} – region už mu nepatří [${source}]`);
    return false;
  }

  room.baseScoreSettled[seat] = true;
  room.regionValues[baseRegion] = 1000;
  room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
  io.to(roomId).emit('updateScores', { scores: room.scores });
  console.log(`🏰 ${roomId}: Player${seat} vykreslen ${baseRegion} → +1000 bodů [${source}]`);
  return true;
}

function startRoomGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.hasStarted || !isRoomAlive(roomId)) return false;

  const possibleBases = ['Rho', 'Omega', 'Theta'];
  const shuffled = [...possibleBases].sort(() => Math.random() - 0.5);

  room.bases[1] = shuffled[0];
  room.bases[2] = shuffled[1];
  room.bases[3] = shuffled[2];

  room.regions.Player1regions = [room.bases[1]];
  room.regions.Player2regions = [room.bases[2]];
  room.regions.Player3regions = [room.bases[3]];

  // Vlastnictví základen vzniká autoritativně hned, ale body až v okamžiku
  // jejich úvodního vykreslení. Díky tomu začínají všichni na 0 a postupně
  // dostanou 1000 bodů ve stejné chvíli, kdy se jejich základna objeví.
  room.regionValues[room.bases[1]] = 0;
  room.regionValues[room.bases[2]] = 0;
  room.regionValues[room.bases[3]] = 0;
  room.baseScoreSettled = { 1: false, 2: false, 3: false };
  room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);

  room.hasStarted = true;
  room.phase = 'settle';
  room.round = 0;
  room.pendingPins = {};
  room.activeTurn = null;
  room.activeQuestion = null;
  room.activeBaseBattle = null;

  io.to(roomId).emit('startGame', {
    bases: room.bases,
    regions: room.regions,
    regionValues: room.regionValues
  });
  io.to(roomId).emit('updateScores', { scores: room.scores });

  console.log(`🎮 ${roomId}: hra spuštěna (${room.mode})`);
  if (isRoomAlive(roomId)) runGameScenario(roomId);
  return true;
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


// ─────────────────────────────────────────────────────────────────────────────
// Battle/question UI sequencer
// ─────────────────────────────────────────────────────────────────────────────
// Dříve server odhadoval délku klientských animací pomocí pevných delayů
// (5.1 s, 5.7 s, 8 s...). To je náchylné na latenci a throttling timerů v
// prohlížeči: starý close timer pak mohl schovat novou numerickou otázku nebo
// animaci ničení základny. Každá důležitá UI fáze má nyní unikátní token.
// Server pokračuje až po potvrzení klientů, s timeoutem pouze jako pojistkou.
const battleUiWaiters = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Start/base animation barrier
// ─────────────────────────────────────────────────────────────────────────────
// Začátek hry už nesmí běžet podle dvou nezávislých hodin (server delay + klientské
// setTimeouty). Server po startGame čeká na skutečné dokončení úvodní animace
// základen. Jakmile ji dokončí všichni právě připojení klienti, pokračuje ihned.
const baseAnimationWaiters = new Map();

function waitForBaseAnimationDone(roomId, timeoutMs = 16000) {
  const room = rooms[roomId];
  const expected = new Set(connectedBattleUiSocketIds(room));

  return new Promise((resolve) => {
    if (!room || expected.size === 0) {
      resolve({ reason: 'no_clients' });
      return;
    }

    const timer = setTimeout(() => {
      const waiter = baseAnimationWaiters.get(roomId);
      if (!waiter) return;
      console.warn(`⏱️ ${roomId}: timeout úvodní animace základen; zbývá ${waiter.pending.size} klient(ů).`);
      baseAnimationWaiters.delete(roomId);
      resolve({ reason: 'timeout' });
    }, timeoutMs);
    timer.unref?.();

    baseAnimationWaiters.set(roomId, { pending: expected, resolve, timer });
    console.log(`🏁 ${roomId}: čekám na dokončení animace základen od ${expected.size} klient(ů).`);
  });
}

function acknowledgeBaseAnimationDone(socket, requestedRoomId) {
  const roomId = socket.data?.roomId || socket.data?.joinedRoom;
  if (!roomId || String(requestedRoomId || '') !== String(roomId)) return;
  const waiter = baseAnimationWaiters.get(roomId);
  if (!waiter || !waiter.pending.has(socket.id)) return;

  waiter.pending.delete(socket.id);
  console.log(`✅ ${roomId}: animace základen hotová na ${socket.id}; zbývá=${waiter.pending.size}`);
  if (waiter.pending.size > 0) return;

  baseAnimationWaiters.delete(roomId);
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.resolve({ reason: 'acked' });
}

function dropSocketFromBaseAnimationWaiters(socketId) {
  for (const [roomId, waiter] of baseAnimationWaiters.entries()) {
    if (!waiter.pending?.has(socketId)) continue;
    waiter.pending.delete(socketId);
    console.log(`↩️ ${roomId}: odpojený socket odstraněn z čekání na základny; zbývá=${waiter.pending.size}`);
    if (waiter.pending.size > 0) continue;
    baseAnimationWaiters.delete(roomId);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve({ reason: 'clients_gone' });
  }
}

function connectedBattleUiSocketIds(room) {
  if (!room || !Array.isArray(room.players)) return [];
  return room.players
    .map(p => p?.id)
    .filter(id => id && io.sockets.sockets.has(id));
}

function finishBattleUiWaiter(uiToken, reason = 'acked') {
  const waiter = battleUiWaiters.get(uiToken);
  if (!waiter) return false;
  battleUiWaiters.delete(uiToken);
  if (waiter.timer) clearTimeout(waiter.timer);
  waiter.resolve({ uiToken, stage: waiter.stage, reason });
  return true;
}

function emitBattleUiAndWait(roomId, eventName, payload = {}, stage = eventName, timeoutMs = 7500) {
  const room = rooms[roomId];
  const uiToken = `ui-${randomUUID()}`;
  const expected = new Set(connectedBattleUiSocketIds(room));

  // Waiter musí existovat PŘED emitnutím eventu, jinak by velmi rychlý klient
  // mohl poslat ACK dříve, než jej server začne poslouchat.
  const promise = new Promise((resolve) => {
    if (!room || expected.size === 0) {
      resolve({ uiToken, stage, reason: 'no_clients' });
      return;
    }

    const timer = setTimeout(() => {
      const waiter = battleUiWaiters.get(uiToken);
      if (!waiter) return;
      console.warn(`⏱️ UI ACK timeout ${roomId} / ${stage}; čekám ještě na ${waiter.pending.size} klient(ů).`);
      finishBattleUiWaiter(uiToken, 'timeout');
    }, timeoutMs);
    timer.unref?.();

    battleUiWaiters.set(uiToken, {
      roomId,
      stage,
      pending: expected,
      resolve,
      timer
    });
  });

  io.to(roomId).emit(eventName, { ...payload, uiToken, uiStage: stage });
  console.log(`🎬 UI stage ${roomId}: ${stage} (${uiToken}), klientů=${expected.size}`);
  return promise;
}

function acknowledgeBattleUi(socket, requestedRoomId, uiToken, stage) {
  const waiter = battleUiWaiters.get(String(uiToken || ''));
  if (!waiter) return;

  const socketRoomId = socket.data?.roomId || socket.data?.joinedRoom;
  if (!socketRoomId || String(requestedRoomId || '') !== String(socketRoomId)) return;
  if (String(waiter.roomId) !== String(socketRoomId)) return;
  if (stage && String(stage) !== String(waiter.stage)) return;
  if (!waiter.pending.has(socket.id)) return;

  waiter.pending.delete(socket.id);
  console.log(`✅ UI ACK ${waiter.roomId}: ${waiter.stage} od ${socket.id}; zbývá=${waiter.pending.size}`);
  if (waiter.pending.size === 0) finishBattleUiWaiter(String(uiToken), 'acked');
}

function dropSocketFromBattleUiWaiters(socketId) {
  for (const [uiToken, waiter] of battleUiWaiters.entries()) {
    if (!waiter.pending?.has(socketId)) continue;
    waiter.pending.delete(socketId);
    console.log(`↩️ UI waiter ${waiter.roomId}: odpojený socket ${socketId} odstraněn; zbývá=${waiter.pending.size}`);
    if (waiter.pending.size === 0) finishBattleUiWaiter(uiToken, 'clients_gone');
  }
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
    if (room.mode === 'friends' && !room.hasStarted) broadcastLobbyState(roomId);
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
  room.players[myNumber - 1] = { id: socket.id, name, userId: socket.data?.accountUserId || null };

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

  if (!room.hasStarted && room.mode === 'friends') {
    // FRIENDS: skutečná ready lobby, startuje hostitel ručně.
    room.ready = room.ready || { 1: false, 2: false, 3: false };
    room.ready[myNumber] = false;
    broadcastLobbyState(roomId);
  } else if (!room.hasStarted && room.mode === 'bots') {
    // BOTI: zobraz lobby se dvěma připravenými roboty; startuje hráč ručně.
    broadcastLobbyState(roomId);
  } else if (!room.hasStarted && room.mode === 'random') {
    broadcastLobbyState(roomId);
    // Rychlý matchmaking odstartuje automaticky. Custom room čeká na hostitele.
    if (room.matchKind !== 'custom' && connectedHumanCount(room) >= MAX_PLAYERS_PER_ROOM) startRoomGame(roomId);
    if (room.matchKind === 'custom') broadcastPublicRandomRooms();
  } else if (room.hasStarted) {
    if (typeof buildRoomSnapshot === 'function') {
      socket.emit("stateSync", { myNumber, snapshot: buildRoomSnapshot(room, roomId, myNumber) });
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

// Multiple-choice: bot odpovídá převážně v běžném lidském tempu.
// Velmi rychlá reakce je možná, ale je záměrně vzácná. Limit otázky je 10 s,
// proto jsou všechny intervaly bezpečně pod deadlinem.
function botMultipleChoiceResponseDelayMs() {
  const roll = Math.random();
  if (roll < 0.03) return randInt(850, 1500);      // 3 %: blesková odpověď
  if (roll < 0.20) return randInt(1800, 3200);     // 17 %: rychlejší člověk
  if (roll < 0.78) return randInt(3200, 6000);     // 58 %: běžná reakce
  if (roll < 0.96) return randInt(6000, 8100);     // 18 %: rozmyšlení
  return randInt(8100, 9300);                      // 4 %: těsně před limitem
}

function allChoiceParticipantsAnswered(room) {
  const participants = Array.isArray(room?.currentQuestionParticipants)
    ? room.currentQuestionParticipants
    : [];
  return participants.length > 0 && participants.every(seat => room.answers?.[seat] !== undefined);
}

function maybeFinishMultipleChoiceQuestion(roomId) {
  const room = rooms[roomId];
  if (!room || room.currentQuestionType !== 'choice') return false;
  if (!allChoiceParticipantsAnswered(room)) return false;
  if (typeof room.choiceFinalize !== 'function') return false;
  room.choiceFinalize('all_answered');
  return true;
}

// Numerické otázky: bot obvykle odpovídá v lidském tempu, jen vzácně velmi rychle.
function botNumericResponseDelayMs() {
  const roll = Math.random();
  if (roll < 0.04) return randInt(900, 1900);
  if (roll < 0.24) return randInt(2600, 4400);
  if (roll < 0.84) return randInt(4400, 7800);
  if (roll < 0.97) return randInt(7800, 10800);
  return randInt(10800, 13200);
}

function allNumericParticipantsAnswered(room) {
  const participants = Array.isArray(room?.currentQuestionParticipants)
    ? room.currentQuestionParticipants
    : [];
  return participants.length > 0 && participants.every(seat => !!room.numericAnswers?.[seat]);
}

function maybeFinishNumericQuestion(roomId) {
  const room = rooms[roomId];
  if (!room || room.currentQuestionType !== 'numeric') return false;
  if (!allNumericParticipantsAnswered(room)) return false;
  if (typeof room.numericFinalize !== 'function') return false;
  room.numericFinalize('all_answered');
  return true;
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


const questionFiles = [
  'general_multiple_choice.json',
  'general_multiple_choice2.json',
  'general_multiple_choice3.json'
];
const questions = questionFiles.flatMap(fileName =>
  JSON.parse(fs.readFileSync(path.join(__dirname, fileName), 'utf8'))
);


// --- Numeric Qs (CJS) ---
const numericQuestionFiles = [
  'general_numeric_questions.json',
  'general_numeric_questions2.json',
  'general_numeric_questions3.json'
];
const numericQuestions = numericQuestionFiles.flatMap(fileName =>
  JSON.parse(fs.readFileSync(path.join(__dirname, fileName), 'utf8'))
);


module.exports = { questions }; // pokud exportuješ dál






function runMultipleChoice(roomId, participatingPlayers = [1, 2, 3]) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve([]);

    const pool = filterQuestionsByRoomCategories(questions, room);
    const question = pickRandom(pool);
    const questionEventBase = `q-${randomUUID()}`;
    console.log(`🧠 MC otázka z kategorie: ${question.category}`);

    room.answers = {};
    room.currentQuestionType = 'choice';
    room.currentQuestionParticipants = [...participatingPlayers];
    room.choiceQuestionToken = questionEventBase;

    const isDuel = participatingPlayers.length === 2;
    const attacker = isDuel ? participatingPlayers[0] : null;
    const defender = isDuel ? participatingPlayers[1] : null;
    const questionStartedAt = Date.now();
    const questionDeadline = questionStartedAt + 10000;

    room.activeQuestion = {
      kind: 'choice',
      question: question.question,
      options: [...question.options],
      category: question.category || null,
      participants: [...participatingPlayers],
      attacker,
      defender,
      attackerName: isDuel ? displayName(room, attacker, true) : '',
      defenderName: isDuel ? displayName(room, defender, true) : '',
      startedAt: questionStartedAt,
      deadline: questionDeadline
    };

    let finished = false;
    let timeoutHandle = null;

    const finalize = async (reason = 'timeout') => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const liveRoom = rooms[roomId];
      if (!liveRoom || !isRoomAlive(roomId) || liveRoom.choiceQuestionToken !== questionEventBase) {
        return resolve([]);
      }

      const correctPlayers = [];
      for (const player of participatingPlayers) {
        if (liveRoom.answers?.[player] === question.correct) {
          correctPlayers.push(Number(player));
        }
      }

      const profileDetails = {};
      participatingPlayers.forEach(seat => {
        profileDetails[seat] = {
          success: liveRoom.answers?.[seat] === question.correct,
          answered: liveRoom.answers?.[seat] !== undefined
        };
      });
      queueQuestionProfileEvents(liveRoom, questionEventBase, question.category, 'choice', participatingPlayers, profileDetails);

      if (reason === 'all_answered') {
        console.log(`⚡ MC ${roomId}: odpověděli všichni účastníci (${participatingPlayers.join(', ')}), vyhodnocuji hned.`);
      }

      // Od této chvíle už další kliknutí ani opožděné botí timery nesmí do otázky zasáhnout.
      liveRoom.currentQuestionType = null;
      liveRoom.currentQuestionParticipants = [];
      liveRoom.activeQuestion = null;
      liveRoom.choiceFinalize = null;
      liveRoom.choiceQuestionTimer = null;
      liveRoom.choiceQuestionToken = null;

      await emitBattleUiAndWait(roomId, "multipleChoiceResults", {
        correctAnswer: question.correct,
        answersByPlayer: liveRoom.answers
      }, 'multiple_choice_results', 7000);

      resolve(correctPlayers);
    };

    room.choiceFinalize = finalize;

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
        canAnswer: participatingPlayers.includes(playerNumber),
        category: question.category || null
      });
    });

    // BOT odpovědi – přirozenější reakční doba. Jakmile odpoví poslední účastník,
    // stejná cesta jako u numerických otázek otázku okamžitě vyhodnotí.
    try {
      const BOT_CORRECT_PROB = 0.55;

      participatingPlayers.forEach((seat) => {
        if (!isBot(room, seat)) return;
        const botDelay = botMultipleChoiceResponseDelayMs();

        setTimeout(() => {
          const r = rooms[roomId];
          if (!r || !isRoomAlive(roomId)) return;
          if (r.currentQuestionType !== 'choice' || r.choiceQuestionToken !== questionEventBase) return;
          if (!isBot(r, seat)) return;
          if (r.answers?.[seat] !== undefined) return;

          const indices = question.options.map((_, i) => i);
          const wrong = indices.filter(i => i !== question.correct);
          const shouldBeCorrect = Math.random() < BOT_CORRECT_PROB;
          const pick = shouldBeCorrect
            ? question.correct
            : (wrong.length ? wrong[randInt(0, wrong.length - 1)] : question.correct);

          r.answers = r.answers || {};
          r.answers[seat] = pick;
          console.log(`🤖 BOT ${seat} odpověděl MC: ${pick} po ${Date.now() - questionStartedAt} ms`);
          maybeFinishMultipleChoiceQuestion(roomId);
        }, botDelay);
      });
    } catch (e) { console.warn('BOT MC error', e); }

    timeoutHandle = setTimeout(() => finalize('timeout'), 10000);
    room.choiceQuestionTimer = timeoutHandle;
  });
}


function runNumericQuestionForTwo(roomId, [player1, player2]) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve(null);

    const npool = filterQuestionsByRoomCategories(numericQuestions, room);
    const nq = pickRandom(npool);
    const questionEventBase = `q-${randomUUID()}`;
    console.log(`🔢 Numeric otázka z kategorie: ${nq.category}`);

    const correctAnswer = Number.isInteger(nq.answer) ? nq.answer : parseInt(nq.answer, 10);
    const participants = [player1, player2];

    room.numericAnswers = {};
    room.numericStartTime = Date.now();
    room.currentQuestionType = 'numeric';
    room.currentQuestionParticipants = [...participants];
    room.numericQuestionToken = questionEventBase;
    room.activeQuestion = {
      kind: 'numeric-two',
      question: nq.question,
      options: null,
      category: nq.category || null,
      participants: [...participants],
      attacker: player1,
      defender: player2,
      attackerName: displayName(room, player1, true),
      defenderName: displayName(room, player2, true),
      startedAt: room.numericStartTime,
      deadline: room.numericStartTime + 15000
    };

    let finished = false;
    let timeoutHandle = null;

    const finalize = async (reason = 'timeout') => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const liveRoom = rooms[roomId];
      if (!liveRoom || !isRoomAlive(roomId) || liveRoom.numericQuestionToken !== questionEventBase) {
        return resolve(null);
      }

      const answeredSeats = new Set(Object.keys(liveRoom.numericAnswers || {}).map(Number));
      participants.forEach(p => {
        if (!liveRoom.numericAnswers[p]) {
          liveRoom.numericAnswers[p] = { num: 0, time: 15000 };
          console.log(`⏳ Hráč ${p} nestihl → 0 (15 s)`);
        }
      });

      const sorted = participants.map(player => {
        const data = liveRoom.numericAnswers[player];
        const num = parseInt(data.num, 10);
        return { player:Number(player), num, diff:Math.abs(num-correctAnswer), time:data.time };
      }).sort((a,b) => (a.diff !== b.diff ? a.diff-b.diff : a.time-b.time));

      const winner = sorted[0].player;
      const profileDetails = {};
      sorted.forEach(item => {
        const answered = answeredSeats.has(item.player);
        profileDetails[item.player] = {
          success:item.player === winner,
          answered,
          answerNumeric:item.num,
          correctNumeric:correctAnswer,
          numericErrorPct:numericErrorPercent(item.num,correctAnswer,answered),
          exactHit:answered && item.diff === 0
        };
      });
      queueQuestionProfileEvents(liveRoom,questionEventBase,nq.category,'numeric',participants,profileDetails);

      if (reason === 'all_answered') {
        console.log(`⚡ Numeric duel ${roomId}: oba hráči odpověděli, vyhodnocuji hned.`);
      }

      // Další odpovědi už odmítneme hned. Samotný Promise ale dokončíme až
      // po zavření výsledkové obrazovky na klientech.
      liveRoom.currentQuestionType = null;
      liveRoom.currentQuestionParticipants = [];
      liveRoom.activeQuestion = null;
      liveRoom.numericFinalize = null;
      liveRoom.numericQuestionTimer = null;
      liveRoom.numericQuestionToken = null;

      await emitBattleUiAndWait(roomId, "numericQuestionResultsForTwo", {
        correctAnswer,
        attacker: player1,
        defender: player2,
        answers: sorted.map(a => ({
          player:a.player,
          num:a.num,
          time:a.time,
          name:liveRoom.players[a.player - 1]?.name || displayName(liveRoom,a.player,false)
        }))
      }, 'numeric_duel_results', 8000);

      resolve(winner);
    };

    room.numericFinalize = finalize;

    io.to(roomId).emit("numericQuestionForTwo", {
      question: nq.question,
      time: 15,
      attacker: player1,
      defender: player2,
      attackerName: displayName(room, player1, true),
      defenderName: displayName(room, player2, true),
      category: nq.category || null
    });

    try {
      participants.forEach((seat) => {
        if (!isBot(room, seat)) return;
        const botDelay = botNumericResponseDelayMs();
        setTimeout(() => {
          const r = rooms[roomId];
          if (!r || !isRoomAlive(roomId)) return;
          if (r.currentQuestionType !== 'numeric' || r.numericQuestionToken !== questionEventBase) return;
          if (!isBot(r, seat) || r.numericAnswers?.[seat]) return;

          const noise = Math.round((Math.random() - 0.5) * 0.2 * Math.max(10, Math.abs(correctAnswer)));
          const guess = correctAnswer + noise;
          r.numericAnswers = r.numericAnswers || {};
          r.numericAnswers[seat] = { num:guess, time:Date.now()-r.numericStartTime };
          console.log(`🤖 BOT ${seat} odpověděl NUM (duel): ${guess} po ${r.numericAnswers[seat].time} ms`);
          maybeFinishNumericQuestion(roomId);
        }, botDelay);
      });
    } catch (e) { console.warn('BOT duel numeric error', e); }

    timeoutHandle = setTimeout(() => finalize('timeout'), 15000);
    room.numericQuestionTimer = timeoutHandle;
  });
}


function runNumericQuestionForThree(roomId) {
  return new Promise((resolve) => {
    const room = rooms[roomId];
    if (!room) return resolve(null);

    const npool = filterQuestionsByRoomCategories(numericQuestions, room);
    const nq = pickRandom(npool);
    const questionEventBase = `q-${randomUUID()}`;
    console.log(`🔢 Numeric (3p) otázka z kategorie: ${nq.category}`);

    const correctAnswer = Number.isInteger(nq.answer) ? nq.answer : parseInt(nq.answer, 10);
    const participants = [1,2,3];

    room.numericAnswers = {};
    room.numericStartTime = Date.now();
    room.currentQuestionType = 'numeric';
    room.currentQuestionParticipants = [...participants];
    room.numericQuestionToken = questionEventBase;
    room.activeQuestion = {
      kind: 'numeric-three',
      question: nq.question,
      options: null,
      category: nq.category || null,
      participants: [...participants],
      attacker: null,
      defender: null,
      attackerName: '',
      defenderName: '',
      startedAt: room.numericStartTime,
      deadline: room.numericStartTime + 15000
    };

    let finished = false;
    let timeoutHandle = null;

    const finalize = async (reason = 'timeout') => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);

      const liveRoom = rooms[roomId];
      if (!liveRoom || !isRoomAlive(roomId) || liveRoom.numericQuestionToken !== questionEventBase) {
        return resolve(null);
      }

      const answeredSeats = new Set(Object.keys(liveRoom.numericAnswers || {}).map(Number));
      participants.forEach(player => {
        if (!liveRoom.numericAnswers[player]) {
          liveRoom.numericAnswers[player] = { num:0, time:15000 };
          console.log(`⏳ Hráč ${player} nestihl → 0 (15 s)`);
        }
      });

      const sorted = participants.map(player => {
        const data = liveRoom.numericAnswers[player];
        const num = parseInt(data.num,10);
        return { player:Number(player), num, diff:Math.abs(num-correctAnswer), time:data.time };
      }).sort((a,b) => (a.diff !== b.diff ? a.diff-b.diff : a.time-b.time));

      const winner = sorted[0].player;
      const profileDetails = {};
      sorted.forEach(item => {
        const answered = answeredSeats.has(item.player);
        profileDetails[item.player] = {
          success:item.player === winner,
          answered,
          answerNumeric:item.num,
          correctNumeric:correctAnswer,
          numericErrorPct:numericErrorPercent(item.num,correctAnswer,answered),
          exactHit:answered && item.diff === 0
        };
      });
      queueQuestionProfileEvents(liveRoom,questionEventBase,nq.category,'numeric',participants,profileDetails);

      if (reason === 'all_answered') {
        console.log(`⚡ Numeric 3p ${roomId}: všichni tři odpověděli, vyhodnocuji hned.`);
      }

      liveRoom.currentQuestionType = null;
      liveRoom.currentQuestionParticipants = [];
      liveRoom.activeQuestion = null;
      liveRoom.numericFinalize = null;
      liveRoom.numericQuestionTimer = null;
      liveRoom.numericQuestionToken = null;

      await emitBattleUiAndWait(roomId, "numericQuestionResults", {
        correctAnswer,
        answers:sorted
      }, 'numeric_three_results', 8000);

      resolve(winner);
    };

    room.numericFinalize = finalize;

    io.to(roomId).emit("numericQuestion", {
      question:nq.question,
      time:15,
      category:nq.category || null
    });

    try {
      participants.forEach((seat) => {
        if (!isBot(room, seat)) return;
        const botDelay = botNumericResponseDelayMs();
        setTimeout(() => {
          const r = rooms[roomId];
          if (!r || !isRoomAlive(roomId)) return;
          if (r.currentQuestionType !== 'numeric' || r.numericQuestionToken !== questionEventBase) return;
          if (!isBot(r, seat) || r.numericAnswers?.[seat]) return;

          const noise = Math.round((Math.random() - 0.5) * 0.25 * Math.max(10, Math.abs(correctAnswer)));
          const guess = correctAnswer + noise;
          r.numericAnswers = r.numericAnswers || {};
          r.numericAnswers[seat] = { num:guess, time:Date.now()-r.numericStartTime };
          console.log(`🤖 BOT ${seat} odpověděl NUM (3): ${guess} po ${r.numericAnswers[seat].time} ms`);
          maybeFinishNumericQuestion(roomId);
        }, botDelay);
      });
    } catch (e) { console.warn('BOT 3p numeric error', e); }

    timeoutHandle = setTimeout(() => finalize('timeout'), 15000);
    room.numericQuestionTimer = timeoutHandle;
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

  // Klient dostal startGame už těsně před spuštěním scénáře a sám zobrazí
  // pětisekundový overlay. Po jeho zmizení spustí animaci základen (2/4/6 s).
  // Místo starého pevného 7 s + 8 s čekání nyní server čeká na skutečný konec
  // této animace. Tím nevznikne hluché místo a fáze se nemohou předbíhat.
  const baseAnimationResult = await waitForBaseAnimationDone(roomId, 16000);
  if (!isRoomAlive(roomId)) return;
  console.log(`🏁 ${roomId}: úvodní animace základen dokončena (${baseAnimationResult?.reason || 'unknown'}).`);

  // Nouzová pojistka: pokud některý baseSettled ACK nedorazil, dorovnáme stav
  // až po skončení/timeoutu animace. Helper je idempotentní.
  for (let seat = 1; seat <= 3; seat++) {
    awardBaseSettlementScore(roomId, seat, 'settle-fallback');
  }

  // Krátké nadechnutí po poslední vlně; už nejde o synchronizační delay.
  if (!await delayAlive(roomId, 350)) return;

  room.phase ="expansion";
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
      // Jen krátký čas na přečtení/rozsvícení pořadí. Synchronizace už proběhla
      // skutečným ACKem úvodní animace, takže zde není potřeba dlouhá rezerva.
      if (!await delayAlive(roomId, 900)) return;

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


    // Výsledková obrazovka MC už je v tuto chvíli potvrzeně zavřená všemi
    // aktivními klienty. Necháme jen krátký přirozený přechod.
    if (!await delayAlive(roomId, 350)) return;


    correctPlayers.forEach(player => {
      const selectedRegion = room.lastSelections[player];
      if (selectedRegion) {
        room.regions[`Player${player}regions`].push(selectedRegion);
        noteProfileTerritoryGain(room,player,1);
        room.regionValues[selectedRegion] = 200;
        room.scores[player] += 200;
        console.log(`✅ Hráč ${player} získal region ${selectedRegion} (+200 bodů)`);
        io.to(roomId).emit("updateScores", { scores: room.scores });

      }
    });

    // Aktualizace klientů – po přidělení regionů už výběrové piny nejsou aktivní.
    room.pendingPins = {};
    io.to(roomId).emit("updateRegions", {
      regions: room.regions,
      regionValues: room.regionValues,
      scores: room.scores,
      bases: room.bases,
      playerLives: room.playerLives,
      defenseBonuses: room.defenseBonuses,
      pendingPins: room.pendingPins
    });

    // Nezačínej další tah dřív, než klienti stihnou dokončit vlnu zabarvení.
    // 860 ms animace + malá vizuální pauza.
    if (!await delayAlive(roomId, 1100)) return;

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

      // Výsledky numerické otázky jsou už potvrzeně zavřené na klientech.
      if (!await delayAlive(roomId, 350)) return;

      // 4️⃣ Získej dostupné regiony pro vítěze
      const available = getAvailableRegionsConquest(room);

      // Mapa mohla být mezitím doplněna; v takovém případě už
      // vítěze nenecháváme čekat 10 sekund na neexistující volbu.
      if (available.length === 0) {
        console.log("🛑 Dobývání končí – na mapě už není žádné volné pole.");
        break;
      }

      // Aktivní tah uložíme PŘED emitnutím dostupných regionů. Když hráč
      // refreshne přesně v tomto okamžiku, stateSync už obsahuje celou volbu.
      const turnStartedAt = Date.now();
      room.activeTurn = {
        kind: 'conquest',
        player: winner,
        round,
        battlestick: null,
        availableRegions: [...available],
        startedAt: turnStartedAt,
        deadline: turnStartedAt + 10000
      };
      room.pendingPins = {};

      const winRec = room.players[winner - 1];
      const playerSocketId = winRec && winRec.id;
      if (playerSocketId) {
        io.to(playerSocketId).emit("availableRegions", { regions: available, timeLeft: 10, round, kind: 'conquest' });
      }

      console.log("📊 Dostupná pole pro hráče", winner, ":", available);
      console.log("📌 Regions:", room.regions);
      console.log("📌 RegionValues:", room.regionValues);

      const selectedRegion = await waitForPlayerSelection(roomId, winner, 10000, available);
      room.activeTurn = null;
      if (!isRoomAlive(roomId)) return; // 🔴 NEW


      if (selectedRegion) {
        room.pendingPins[winner] = selectedRegion;
        // ✅ Okamžitě zobraz pin na mapě všem hráčům
        io.to(roomId).emit("playerSelectedRegion", {
          player: winner,
          region: selectedRegion
        });

        // ✅ Přiděl region a přepočítej body
        room.regions[`Player${winner}regions`].push(selectedRegion);
        noteProfileTerritoryGain(room,winner,1);
        room.regionValues[selectedRegion] = 300;
        room.scores[winner] += 300;

        console.log(`✅ Hráč ${winner} obsadil ${selectedRegion} (+300 bodů)`);

      await delayAlive(roomId, 2000); // 🔴 NEW

        // ✅ Aktualizace pro všechny hráče (zabarvení + skóre)
        room.pendingPins = {};
        io.to(roomId).emit("updateRegions", {
          regions: room.regions,
          regionValues: room.regionValues,
          scores: room.scores,
          bases: room.bases,
          playerLives: room.playerLives,
          defenseBonuses: room.defenseBonuses,
          pendingPins: room.pendingPins
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

      room.battlestick = battlestick;
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

            await finishRoomGame(roomId, ordered);

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

            await finishRoomGame(roomId, ordered);



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

  const turnStartedAt = Date.now();
  room.activeTurn = {
    kind: 'battle',
    player: attacker,
    round: Number(room.round) || 0,
    battlestick: Number(room.battlestick) || null,
    availableRegions: [...availableEnemyRegions],
    startedAt: turnStartedAt,
    deadline: turnStartedAt + 10000
  };
  room.pendingPins = {};

  const attRec = room.players[attacker - 1];
  const attackerSocketId = attRec && attRec.id;
  if (attackerSocketId) {
    io.to(attackerSocketId).emit("battleAvailableRegions", { regions: availableEnemyRegions, timeLeft: 10 });
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
  room.activeTurn = null;

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
  room.pendingPins[attacker] = selectedRegion;
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
    room.activeBaseBattle = { attacker, defender, region, lives };
    io.to(roomId).emit("showBaseMini", { attacker, defender, lives });
    if (!await delayAlive(roomId, 1000)) return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. BĚŽNÉ POLE
  // runMultipleChoice / runNumericQuestionForTwo už samy čekají, dokud
  // klienti skutečně nezavřou výsledkovou obrazovku. Tady už proto nejsou
  // žádné odhady typu „počkej 5/6 sekund“.
  // ───────────────────────────────────────────────────────────────────────────
  if (!isBase) {
    const correctPlayers = await runMultipleChoice(roomId, [attacker, defender]);
    if (!isRoomAlive(roomId)) return;
    if (!await delayAlive(roomId, 350)) return;

    let winner = null;

    if (correctPlayers.length === 1) {
      winner = correctPlayers[0];
    } else if (correctPlayers.length > 1) {
      // Krátký čistý přechod mezi MC výsledky a novou numerickou otázkou.
      if (!await delayAlive(roomId, 400)) return;
      winner = await runNumericQuestionForTwo(roomId, [attacker, defender]);
      if (!isRoomAlive(roomId)) return;
      if (!await delayAlive(roomId, 450)) return;
    }

    if (winner === attacker) {
      const defKey = `Player${defender}regions`;
      const atkKey = `Player${attacker}regions`;
      const index = room.regions[defKey].indexOf(region);
      if (index !== -1) room.regions[defKey].splice(index, 1);
      if (!room.regions[atkKey].includes(region)) {
        room.regions[atkKey].push(region);
        noteProfileTerritoryGain(room, attacker, 1);
        room.regionValues[region] = 400;
      }
    } else if (winner === defender) {
      io.to(roomId).emit("battleDefended");
      const bonusKey = `Player${defender}`;
      room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;
      console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);
    }

    // Malá dramaturgická pauza po rozhodnutí; už neslouží k synchronizaci UI.
    if (!await delayAlive(roomId, 650)) return;

    room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
    room.pendingPins = {};
    io.to(roomId).emit("updateRegions", {
      regions: room.regions,
      regionValues: room.regionValues,
      scores: room.scores,
      bases: room.bases,
      playerLives: room.playerLives,
      defenseBonuses: room.defenseBonuses,
      pendingPins: room.pendingPins
    });
    io.to(roomId).emit("updateScores", { scores: room.scores });

    // Přebarvení regionu má vlastní klientskou bariéru + zde rezervu pro mapu.
    if (!await delayAlive(roomId, 1800)) return;
    return;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. ZÁKLADNA
  // Každý krok je sekvenční: MC results ACK → případně NUM results ACK →
  // případně destroyTower ACK → teprve potom další otázka / převod základny.
  // ───────────────────────────────────────────────────────────────────────────
  let baseCaptured = false;

  while (!baseCaptured) {
    const correctPlayers = await runMultipleChoice(roomId, [attacker, defender]);
    if (!isRoomAlive(roomId)) return;
    if (!await delayAlive(roomId, 400)) return;

    // 2a. Vyhrál pouze útočník → jedna věž dolů.
    if (correctPlayers.length === 1 && correctPlayers[0] === attacker) {
      room.playerLives[`Player${defender}`]--;
      const remainingLives = room.playerLives[`Player${defender}`];
      if (room.activeBaseBattle) room.activeBaseBattle.lives = remainingLives;

      await emitBattleUiAndWait(roomId, "destroyTower", {
        defender,
        remainingLives
      }, 'destroy_tower', 8000);
      if (!isRoomAlive(roomId)) return;

      if (remainingLives <= 0) {
        transferBase(roomId, room, attacker, defender, region);
        baseCaptured = true;
      } else {
        // Nová MC otázka nesmí naskočit v témže frame jako zavření animace věže.
        if (!await delayAlive(roomId, 450)) return;
      }
      continue;
    }

    // 2b. Vyhrál pouze obránce.
    if (correctPlayers.length === 1 && correctPlayers[0] === defender) {
      io.to(roomId).emit("battleDefended");
      const bonusKey = `Player${defender}`;
      room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;
      console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);
      break;
    }

    // 2c/2d. Oba správně → numerický duel. Ten se vrátí až po zavření
    // numerických výsledků, takže nic starého už nemůže schovat další fázi.
    if (correctPlayers.length > 1) {
      if (!await delayAlive(roomId, 400)) return;
      const numericWinner = await runNumericQuestionForTwo(roomId, [attacker, defender]);
      if (!isRoomAlive(roomId)) return;
      if (!await delayAlive(roomId, 450)) return;

      if (numericWinner === attacker) {
        room.playerLives[`Player${defender}`]--;
        const remainingLives = room.playerLives[`Player${defender}`];
        if (room.activeBaseBattle) room.activeBaseBattle.lives = remainingLives;

        await emitBattleUiAndWait(roomId, "destroyTower", {
          defender,
          remainingLives
        }, 'destroy_tower', 8000);
        if (!isRoomAlive(roomId)) return;

        if (remainingLives <= 0) {
          transferBase(roomId, room, attacker, defender, region);
          baseCaptured = true;
        } else {
          if (!await delayAlive(roomId, 450)) return;
        }
        continue;
      }

      io.to(roomId).emit("battleDefended");
      const bonusKey = `Player${defender}`;
      room.defenseBonuses[bonusKey] = (room.defenseBonuses[bonusKey] || 0) + 100;
      console.log(`🛡️ Hráč ${defender} ubránil region ${region} → +100 bodů bonusu`);
      break;
    }

    // 2e. Nikdo správně.
    io.to(roomId).emit("battleDefended");
    break;
  }

  if (!await delayAlive(roomId, 700)) return;
  room.activeBaseBattle = null;
  io.to(roomId).emit("hideBaseMini");

  room.scores = calculateScores(room.regions, room.regionValues, room.defenseBonuses);
  room.pendingPins = {};
  io.to(roomId).emit("updateRegions", {
    regions: room.regions,
    regionValues: room.regionValues,
    scores: room.scores,
    bases: room.bases,
    playerLives: room.playerLives,
    defenseBonuses: room.defenseBonuses,
    pendingPins: room.pendingPins
  });
  io.to(roomId).emit("updateScores", { scores: room.scores });

  if (!await delayAlive(roomId, 1800)) return;
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

  let transferredCount = 0;
  defenderRegions.forEach(region => {
    if (!room.regions[atkKey].includes(region)) {
      room.regions[atkKey].push(region);
      transferredCount += 1;
    }

    // ✅ Pouze základně přepiš hodnotu na 400
    if (region === baseRegion) {
      room.regionValues[region] = 400;
    }
  });

  noteProfileTerritoryGain(room,attacker,transferredCount);

  // ✅ Vymaž obráncova území
  room.regions[defKey] = [];

  // Základna po dobytí už neexistuje. To musí být pravda i v serverovém
  // snapshotu; jinak ji refresh klienta znovu vykreslí.
  delete room.bases[defender];
  room.playerLives[`Player${defender}`] = 0;

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
  room.pendingPins = {};

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

    const turnStartedAt = Date.now();
    room.activeTurn = {
      kind: 'expansion',
      player,
      round,
      battlestick: null,
      availableRegions: [...availableRegions],
      startedAt: turnStartedAt,
      deadline: turnStartedAt + 10000
    };

    io.to(roomId).emit("playerTurn", {
      player,
      round,
      timeLeft: 10
    });

      const playerRec = room.players[player - 1];
      const playerSocketId = playerRec && playerRec.id;
      if (playerSocketId) {
        io.to(playerSocketId).emit("availableRegions", {
          regions: availableRegions,
          timeLeft: 10,
          round,
          kind: 'expansion'
        });
      }

    console.log(`🎯 Hráč ${player} je na tahu (kolo ${round})`);

    const selectedRegion = await waitForPlayerSelection(roomId, player, 10000, availableRegions);
    room.activeTurn = null;

    room.selections[player] = selectedRegion;
    room.lastSelections[player] = selectedRegion; // ✅ Uložíme i pro pozdější vyhodnocení
    if (selectedRegion) room.pendingPins[player] = selectedRegion;

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









// ===== LIGA: matchmaking / ready check / league room =====
function leagueSearchRange(waitMs) {
  const ms = Math.max(0, Number(waitMs) || 0);
  if (ms < 30_000) return 100;
  if (ms < 60_000) return 200;
  if (ms < 90_000) return 350;
  return Infinity;
}

function leagueRangeLabel(range) {
  return Number.isFinite(range) ? `±${range}` : 'libovolný';
}

function leagueQueueEntriesSorted() {
  return [...leagueQueue.values()]
    .filter(entry => io.sockets.sockets.get(entry.socketId)?.connected)
    .sort((a,b) => a.joinedAt - b.joinedAt || String(a.userId).localeCompare(String(b.userId)));
}

function leaguePairEligible(a, b, now = Date.now()) {
  const diff = Math.abs(Number(a.rating) - Number(b.rating));
  const allowed = Math.min(
    leagueSearchRange(now - a.joinedAt),
    leagueSearchRange(now - b.joinedAt)
  );
  return diff <= allowed;
}

function leagueCombinationScore(entries) {
  let repeats = 0;
  let spread = 0;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].recentOpponents?.has(String(entries[j].userId))) repeats += 1;
      if (entries[j].recentOpponents?.has(String(entries[i].userId))) repeats += 1;
      spread = Math.max(spread, Math.abs(Number(entries[i].rating) - Number(entries[j].rating)));
    }
  }
  return { repeats, spread, joinedSum: entries.reduce((sum,e) => sum + Number(e.joinedAt || 0), 0) };
}

function leagueStatusPayload(entry, sorted, now = Date.now()) {
  const position = Math.max(1, sorted.findIndex(e => String(e.userId) === String(entry.userId)) + 1);
  const waitMs = Math.max(0, now - entry.joinedAt);
  const range = leagueSearchRange(waitMs);
  return {
    position,
    queueSize: sorted.length,
    waitMs,
    searchRange: Number.isFinite(range) ? range : null,
    searchRangeLabel: leagueRangeLabel(range),
    ratingVisible: Number(entry.player?.placement_games || 0) >= 5,
    rating: Number(entry.rating || 1200),
    seasonNumber: Number(entry.season?.season_number || 0)
  };
}

function broadcastLeagueQueueStatuses() {
  const sorted = leagueQueueEntriesSorted();
  const now = Date.now();
  for (const entry of sorted) {
    io.to(entry.socketId).emit('league:queue:status', leagueStatusPayload(entry, sorted, now));
  }
}

function removeLeagueQueueEntry(userId, socketId = null) {
  const key = String(userId || '');
  const entry = leagueQueue.get(key);
  if (!entry) return false;
  if (socketId && entry.socketId !== socketId) return false;
  leagueQueue.delete(key);
  return true;
}

async function cancelLeagueReadyCheck(matchId, reason = 'ready_timeout', explicitOffenderUserId = null) {
  const state = leagueReadyChecks.get(matchId);
  if (!state || state.cancelling) return;
  state.cancelling = true;
  if (state.timer) clearTimeout(state.timer);
  leagueReadyChecks.delete(matchId);

  const offenders = new Set();
  if (explicitOffenderUserId != null) offenders.add(String(explicitOffenderUserId));
  if (!offenders.size) {
    for (const player of state.players) if (!player.accepted) offenders.add(String(player.userId));
  }

  await cancelLeagueMatch(matchId, reason, { offenders:[...offenders] }).catch(err => console.error('league cancel ready:', err));

  const now = Date.now();
  for (const player of state.players) {
    const socket = io.sockets.sockets.get(player.socketId);
    const offender = offenders.has(String(player.userId));
    if (offender) leagueCooldowns.set(String(player.userId), now + 30_000);

    if (socket?.connected && !offender) {
      const requeued = { ...player.entry, socketId:socket.id, joinedAt:player.entry.joinedAt };
      leagueQueue.set(String(player.userId), requeued);
      socket.data.leagueQueueUserId = String(player.userId);
      socket.data.leagueReadyMatchId = null;
      socket.emit('league:ready:cancelled', {
        matchId, requeued:true,
        message:'Soupeř nepotvrdil zápas. Vracíme tě na původní místo ve frontě.'
      });
    } else if (socket?.connected) {
      socket.data.leagueReadyMatchId = null;
      socket.emit('league:ready:cancelled', {
        matchId, requeued:false, cooldownSeconds:30,
        message:'Zápas nebyl potvrzen. Do matchmakingu se můžeš vrátit za 30 sekund.'
      });
    }
  }
  broadcastLeagueQueueStatuses();
  setTimeout(() => attemptLeagueMatchmaking().catch(err => console.error('league matchmaking after ready cancel:', err)), 20);
}

async function launchLeagueReadyMatch(matchId) {
  const state = leagueReadyChecks.get(matchId);
  if (!state || state.launching) return;
  state.launching = true;
  if (state.timer) clearTimeout(state.timer);

  const allConnected = state.players.every(p => io.sockets.sockets.get(p.socketId)?.connected);
  if (!allConnected) {
    state.launching = false;
    return cancelLeagueReadyCheck(matchId, 'ready_disconnect');
  }

  const roomId = `league_${String(matchId).replace(/-/g,'').slice(0,12)}`;
  const room = makeEmptyRoom(roomId, 'liga');
  room.matchKind = 'league';
  room.publicRoom = false;
  room.settings = { mode:'liga', cats:[1,2,3,4,5,6,7,8,9] };
  room.leagueMatchId = matchId;
  room.profileMatchId = `league-${String(matchId)}`;
  room.leagueUsers = {};
  room.leagueDisconnectedTimers = new Map();
  room.leagueForfeitSeat = null;
  room.players = [undefined, undefined, undefined];
  room.seatControllers = { 1:'human', 2:'human', 3:'human' };
  room.ready = { 1:true, 2:true, 3:true };

  state.players.forEach((p, index) => {
    const seat = index + 1;
    room.leagueUsers[seat] = String(p.userId);
    room.players[seat - 1] = { id:null, name:p.entry.displayName, userId:String(p.userId) };
  });
  leagueMatchRooms.set(matchId, roomId);
  leagueReadyChecks.delete(matchId);

  room.leagueJoinTimer = setTimeout(async () => {
    const current = rooms[roomId];
    if (!current || current.hasStarted) return;
    await cancelLeagueMatch(matchId, 'game_join_timeout').catch(err => console.error('league join timeout cancel:', err));
    io.to(roomId).emit('league:game:cancelled', { message:'Jeden z hráčů se nepřipojil do hry. Rating se nemění.' });
    markRoomClosed(roomId);
    delete rooms[roomId];
    leagueMatchRooms.delete(matchId);
  }, 25_000);
  room.leagueJoinTimer.unref?.();

  for (const player of state.players) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket?.connected) continue;
    socket.data.leagueReadyMatchId = null;
    socket.emit('league:ready:launch', {
      matchId,
      url:`game_online.html?mode=liga&match=${encodeURIComponent(matchId)}`
    });
  }
  console.log(`🏁 LIGA ${matchId}: ready check potvrzen, přechod do ${roomId}`);
}

async function beginLeagueReadyCheck(entries) {
  const matchId = await createReadyMatch(entries);
  entries.forEach(entry => leagueQueue.delete(String(entry.userId)));
  const deadline = Date.now() + 10_000;
  const players = entries.map(entry => ({
    userId:String(entry.userId), socketId:entry.socketId, accepted:false, entry
  }));
  const state = { matchId, deadline, players, timer:null, launching:false, cancelling:false };
  leagueReadyChecks.set(matchId, state);

  const publicPlayers = entries.map((entry,index) => ({
    seat:index + 1,
    userId:String(entry.userId),
    displayName:entry.displayName,
    ranked:Number(entry.player?.placement_games || 0) >= 5,
    rating:Number(entry.rating || 1200)
  }));
  for (const player of players) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket?.connected) continue;
    socket.data.leagueQueueUserId = null;
    socket.data.leagueUserId = String(player.userId);
    socket.data.leagueReadyMatchId = matchId;
    socket.emit('league:ready:found', { matchId, deadline, players:publicPlayers });
  }
  state.timer = setTimeout(() => cancelLeagueReadyCheck(matchId, 'ready_timeout'), 10_100);
  state.timer.unref?.();
  console.log(`🎯 LIGA match found ${matchId}: ${entries.map(e => `${e.displayName}(${e.rating})`).join(' / ')}`);
}

async function attemptLeagueMatchmaking() {
  if (leagueMatchmakingBusy) return;
  leagueMatchmakingBusy = true;
  try {
    // Vyhoď odpojené sockety.
    for (const [userId, entry] of leagueQueue) {
      if (!io.sockets.sockets.get(entry.socketId)?.connected) leagueQueue.delete(userId);
    }

    while (true) {
      const entries = leagueQueueEntriesSorted();
      if (entries.length < 3) break;
      const now = Date.now();
      let best = null;

      // FIFO: nejprve zkusíme nejstaršího hráče; pokud pro něj pár neexistuje,
      // zkusí se další anchor, takže nevhodný rating nezablokuje celou frontu.
      for (let a = 0; a < entries.length - 2 && !best; a++) {
        const anchor = entries[a];
        const candidates = [];
        for (let b = a + 1; b < entries.length - 1; b++) {
          for (let c = b + 1; c < entries.length; c++) {
            const trio = [anchor, entries[b], entries[c]];
            if (!trio.every(e => String(e.season.id) === String(anchor.season.id))) continue;
            if (!leaguePairEligible(trio[0],trio[1],now) || !leaguePairEligible(trio[0],trio[2],now) || !leaguePairEligible(trio[1],trio[2],now)) continue;
            candidates.push({ trio, score:leagueCombinationScore(trio) });
          }
        }
        if (candidates.length) {
          candidates.sort((x,y) =>
            x.score.repeats - y.score.repeats ||
            x.score.spread - y.score.spread ||
            x.score.joinedSum - y.score.joinedSum
          );
          best = candidates[0].trio;
        }
      }
      if (!best) break;
      await beginLeagueReadyCheck(best);
    }
  } finally {
    leagueMatchmakingBusy = false;
    broadcastLeagueQueueStatuses();
  }
}

async function joinLeagueQueue(socket) {
  try {
    const entryBase = await leagueEntryForSocketRequest(socket.request);
    if (!entryBase) return socket.emit('league:queue:error', { code:'AUTH_REQUIRED', message:'Liga vyžaduje přihlášení.' });
    const userId = String(entryBase.user.id);
    socket.data.leagueUserId = userId;

    // Pokud má tentýž účet už aktivní ready check (např. druhý tab / reconnect),
    // nepřidávej ho znovu do fronty; převaž socket a obnov ready obrazovku.
    for (const state of leagueReadyChecks.values()) {
      const pending = state.players.find(p => String(p.userId) === userId);
      if (!pending) continue;
      pending.socketId = socket.id;
      socket.data.leagueReadyMatchId = state.matchId;
      const publicPlayers = state.players.map((p,index) => ({
        seat:index+1,userId:String(p.userId),displayName:p.entry.displayName,
        ranked:Number(p.entry.player?.placement_games || 0) >= 5,rating:Number(p.entry.rating || 1200)
      }));
      socket.emit('league:ready:found', { matchId:state.matchId, deadline:state.deadline, players:publicPlayers });
      socket.emit('league:ready:update', {
        matchId:state.matchId, deadline:state.deadline,
        accepted:state.players.map(p => ({ userId:String(p.userId), accepted:!!p.accepted }))
      });
      return;
    }

    const activeMatch = await activeLeagueMatchForUser(userId);
    if (activeMatch) {
      return socket.emit('league:queue:error', {
        code:'MATCH_IN_PROGRESS', matchId:String(activeMatch.id), state:activeMatch.state,
        message:'Tento účet už má rozpracovaný ligový zápas. Dokonči ho před vstupem do další fronty.'
      });
    }

    const cooldownUntil = Number(leagueCooldowns.get(userId) || 0);
    if (cooldownUntil > Date.now()) {
      return socket.emit('league:queue:error', {
        code:'COOLDOWN', cooldownSeconds:Math.ceil((cooldownUntil-Date.now())/1000),
        message:'Po nepotvrzeném zápase je matchmaking krátce pozastaven.'
      });
    }
    leagueCooldowns.delete(userId);

    // Jedna identita = jedna fronta. Novější tab převezme starší záznam.
    const previous = leagueQueue.get(userId);
    const joinedAt = previous?.joinedAt || Date.now();
    if (previous && previous.socketId !== socket.id) {
      io.to(previous.socketId).emit('league:queue:replaced', { message:'Matchmaking byl otevřen v jiném okně.' });
    }

    const entry = {
      ...entryBase,
      userId,
      socketId:socket.id,
      joinedAt,
      displayName:entryBase.displayName
    };
    leagueQueue.set(userId, entry);
    socket.data.leagueQueueUserId = userId;
    socket.data.leagueReadyMatchId = null;
    socket.emit('league:queue:joined', leagueStatusPayload(entry, leagueQueueEntriesSorted()));
    broadcastLeagueQueueStatuses();
    await attemptLeagueMatchmaking();
  } catch (err) {
    console.error('league queue join:', err);
    socket.emit('league:queue:error', { message:'Do ligového matchmakingu se nepodařilo vstoupit.' });
  }
}

async function joinLeagueGame(socket, matchId) {
  try {
    const user = await sessionUser(socket.request, { touch:false });
    if (!user) return socket.emit('league:game:error', { message:'Pro ligovou hru se znovu přihlas.' });
    const safeMatchId = String(matchId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(safeMatchId)) return socket.emit('league:game:error', { message:'Neplatný ligový zápas.' });

    const dbMatch = await leagueMatchForUser(safeMatchId, user.id);
    if (!dbMatch) return socket.emit('league:game:error', { message:'Tento ligový zápas ti nepatří.' });
    if (dbMatch.state === 'cancelled') return socket.emit('league:game:error', { message:'Zápas byl zrušen bez změny ratingu.' });
    if (dbMatch.state === 'finished') return socket.emit('league:game:error', { message:'Tento ligový zápas už skončil.' });

    const roomId = leagueMatchRooms.get(safeMatchId);
    const room = roomId ? rooms[roomId] : null;
    if (!room || room.__closed) {
      await cancelLeagueMatch(safeMatchId, 'room_missing').catch(() => {});
      return socket.emit('league:game:error', { message:'Herní instance byla obnovena. Zápas byl bezpečně zrušen bez změny ratingu.' });
    }

    const seat = Number(dbMatch.seat);
    if (String(room.leagueUsers?.[seat]) !== String(user.id)) return socket.emit('league:game:error', { message:'Nesouhlasí sedadlo ligového hráče.' });
    if (room.leagueForfeitSeat === seat) return socket.emit('league:game:error', { message:'Limit pro návrat do tohoto zápasu už vypršel.' });

    socket.join(roomId);
    socket.data = socket.data || {};
    socket.data.joinedRoom = roomId;
    socket.data.roomId = roomId;
    socket.data.seat = seat;
    socket.data.name = user.displayName || user.username || room.players?.[seat-1]?.name || `Hráč ${seat}`;
    socket.data.leagueUserId = String(user.id);
    socket.data.leagueMatchId = safeMatchId;

    room.players[seat - 1] = { id:socket.id, name:socket.data.name, userId:String(user.id) };
    room.seatControllers[seat] = 'human';
    const reconnectTimer = room.leagueDisconnectedTimers?.get(seat);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      room.leagueDisconnectedTimers.delete(seat);
    }

    const allNames = {};
    room.players.forEach((p,idx) => { allNames[idx+1] = p?.name || `Hráč ${idx+1}`; });
    socket.emit('assignPlayerNumber', { number:seat, allNames, scores:room.scores, roomId });
    io.to(roomId).emit('updatePlayers', {
      allNames,
      displayNames:{1:displayName(room,1,true),2:displayName(room,2,true),3:displayName(room,3,true)},
      seatControllers:room.seatControllers
    });
    socket.emit('stateSync', { myNumber:seat, snapshot:buildRoomSnapshot(room,roomId,seat) });

    const connected = connectedHumanCount(room);
    io.to(roomId).emit('league:game:status', { connected, total:3 });

    if (!room.hasStarted && connected >= 3) {
      if (room.leagueJoinTimer) clearTimeout(room.leagueJoinTimer);
      const activated = await activateLeagueMatch(safeMatchId);
      if (!activated && dbMatch.state !== 'active') {
        await cancelLeagueMatch(safeMatchId, 'activation_failed').catch(() => {});
        return io.to(roomId).emit('league:game:cancelled', { message:'Zápas se nepodařilo aktivovat. Rating se nemění.' });
      }
      startRoomGame(roomId);
    }
  } catch (err) {
    console.error('league game join:', err);
    socket.emit('league:game:error', { message:'Do ligového zápasu se nepodařilo připojit.' });
  }
}

async function finishRoomGame(roomId, ordered) {
  const room = rooms[roomId];
  if (!room || room.__gameFinished) return;
  room.__gameFinished = true;
  room.phase = 'end';

  let leagueResult = null;
  if (room.mode === 'liga' && room.leagueMatchId) {
    const seatScores = {};
    for (const entry of ordered || []) seatScores[Number(entry.player)] = Number(entry.score || 0);
    let lastError = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        leagueResult = await finalizeLeagueMatch(room.leagueMatchId, seatScores, { forcedLastSeat:room.leagueForfeitSeat || null });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.error(`league finalize ${room.leagueMatchId} attempt ${attempt}:`, err);
        await new Promise(r => setTimeout(r, 250 * attempt));
      }
    }
    if (lastError) {
      io.to(roomId).emit('league:rating:error', { message:'Výsledek hry je uložen, ale ligový rating se právě nepodařilo dopočítat. Nezavírej hru a zkus obnovit Ligu za chvíli.' });
    }
  }

  let profileSummary = null;
  try {
    profileSummary = await finalizeAuthoritativeProfiles(roomId,ordered);
  } catch (err) {
    console.error(`📊 ${roomId}: autoritativní profil/žebříček se nepodařilo dokončit:`,err);
  }

  io.to(roomId).emit('gameOver', { message:'Hra skončila!', finalScores:ordered, matchStats:buildEndgameMatchStats(room, ordered) });
  if (leagueResult) io.to(roomId).emit('league:rating:result', leagueResult);
  if (profileSummary?.normalRating) io.to(roomId).emit('normal:rating:result', profileSummary.normalRating);
}

setInterval(() => {
  broadcastLeagueQueueStatuses();
  attemptLeagueMatchmaking().catch(err => console.error('league matchmaking tick:', err));
}, 1000).unref?.();


io.on('connection', socket => {

  portalOnlineSockets.add(socket.id);
  broadcastPortalOnlineCount();

  socket.data = socket.data || {};
  socket.data.accountPromise = sessionUser(socket.request, { touch:false })
    .then(user => {
      socket.data.accountUserId = user ? String(user.id) : null;
      socket.data.accountDisplayName = user?.displayName || user?.username || null;
      const roomId = socket.data?.roomId || socket.data?.joinedRoom;
      const room = roomId ? rooms[roomId] : null;
      if (room) {
        const seat = getSeatNumber(room,socket.id);
        if (seat && room.players?.[seat-1]) room.players[seat-1].userId = socket.data.accountUserId;
      }
      return user || null;
    })
    .catch(err => {
      console.warn('Socket účet se nepodařilo načíst:',err.message);
      socket.data.accountUserId = null;
      return null;
    });

  // ===== LIGA socket API =====
  socket.on('league:queue:join', () => joinLeagueQueue(socket));

  socket.on('league:queue:leave', () => {
    const userId = String(socket.data?.leagueQueueUserId || socket.data?.leagueUserId || '');
    if (userId) removeLeagueQueueEntry(userId, socket.id);
    socket.data.leagueQueueUserId = null;
    socket.emit('league:queue:left');
    broadcastLeagueQueueStatuses();
  });

  socket.on('league:ready:accept', async ({ matchId } = {}) => {
    const state = leagueReadyChecks.get(String(matchId || ''));
    if (!state || state.cancelling || state.launching) return;
    const player = state.players.find(p => p.socketId === socket.id || String(p.userId) === String(socket.data?.leagueUserId || ''));
    if (!player) return socket.emit('league:ready:error', { message:'Ready check už není aktivní.' });
    player.socketId = socket.id;
    player.accepted = true;
    socket.data.leagueUserId = String(player.userId);
    socket.data.leagueReadyMatchId = state.matchId;
    const accepted = state.players.map(p => ({ userId:String(p.userId), accepted:!!p.accepted }));
    for (const p of state.players) io.to(p.socketId).emit('league:ready:update', { matchId:state.matchId, accepted, deadline:state.deadline });
    if (state.players.every(p => p.accepted)) await launchLeagueReadyMatch(state.matchId);
  });

  socket.on('league:ready:decline', async ({ matchId } = {}) => {
    const state = leagueReadyChecks.get(String(matchId || ''));
    if (!state) return;
    const player = state.players.find(p => p.socketId === socket.id || String(p.userId) === String(socket.data?.leagueUserId || ''));
    if (!player) return;
    await cancelLeagueReadyCheck(state.matchId, 'ready_declined', player.userId);
  });

  socket.on('league:ready:resume', async ({ matchId } = {}) => {
    try {
      const state = leagueReadyChecks.get(String(matchId || ''));
      const user = await sessionUser(socket.request, { touch:false });
      if (!state || !user) return socket.emit('league:ready:error', { message:'Ready check už skončil.' });
      const player = state.players.find(p => String(p.userId) === String(user.id));
      if (!player) return socket.emit('league:ready:error', { message:'Tento ready check ti nepatří.' });
      player.socketId = socket.id;
      socket.data.leagueUserId = String(user.id);
      socket.data.leagueReadyMatchId = state.matchId;
      const publicPlayers = state.players.map((p,index) => ({
        seat:index+1,userId:String(p.userId),displayName:p.entry.displayName,
        ranked:Number(p.entry.player?.placement_games || 0) >= 5,rating:Number(p.entry.rating || 1200)
      }));
      socket.emit('league:ready:found', { matchId:state.matchId, deadline:state.deadline, players:publicPlayers });
      socket.emit('league:ready:update', {
        matchId:state.matchId, deadline:state.deadline,
        accepted:state.players.map(p => ({ userId:String(p.userId), accepted:!!p.accepted }))
      });
    } catch (err) {
      console.error('league ready resume:', err);
      socket.emit('league:ready:error', { message:'Ready check se nepodařilo obnovit.' });
    }
  });

  socket.on('league:game:join', ({ matchId } = {}) => joinLeagueGame(socket, matchId));


  socket.on('lobby:rename'
, ({ roomId, name } = {}) => {
    const boundRoomId = socket.data?.roomId || socket.data?.joinedRoom;
    const safeRoomId = sanitizeRoomId(roomId || boundRoomId);
    const room = safeRoomId ? rooms[safeRoomId] : null;

    if (!room || safeRoomId !== boundRoomId || room.hasStarted) {
      socket.emit('lobby:rename:error', { message: 'Jméno lze změnit pouze před začátkem hry.' });
      return;
    }

    const seat = getSeatNumber(room, socket.id);
    if (!seat || room.seatControllers?.[seat] === 'bot') {
      socket.emit('lobby:rename:error', { message: 'Hráče se nepodařilo najít.' });
      return;
    }

    const safeName = sanitizePlayerName(name);
    if (safeName.length < 2) {
      socket.emit('lobby:rename:error', { message: 'Jméno musí mít alespoň 2 znaky.' });
      return;
    }
    if (isPlayerNameTaken(room, safeName, seat)) {
      socket.emit('lobby:rename:error', { message: 'Toto jméno už v místnosti používá jiný hráč.' });
      return;
    }

    room.players[seat - 1].name = safeName;
    socket.data.name = safeName;

    const allNames = {};
    room.players.forEach((p, idx) => { if (p) allNames[idx + 1] = p.name; });
    const displayNames = {
      1: displayName(room, 1, true),
      2: displayName(room, 2, true),
      3: displayName(room, 3, true)
    };

    io.to(safeRoomId).emit('updatePlayers', { allNames, displayNames, seatControllers: room.seatControllers });
    broadcastLobbyState(safeRoomId);
    socket.emit('lobby:rename:ok', { name: safeName });

    if (room.mode === 'random' && room.matchKind === 'custom') {
      broadcastPublicRandomRooms();
    }

    console.log(`✏️ ${safeRoomId}: seat ${seat} renamed to ${safeName}`);
  });

  socket.on('settings:update', ({ roomId, settings }) => {
    const room = rooms[roomId];
    if (!room) return;

    const seat = getSeatNumber(room, socket.id);

    // RANDOM quick má nastavení uzamčené; RANDOM custom může měnit pouze hostitel.
    if (room.mode === 'random' && room.matchKind !== 'custom') {
      socket.emit('settings:applied', { settings: room.settings || {} });
      return;
    }

    if (room.mode === 'random' && room.matchKind === 'custom' && (!seat || seat !== 1 || room.hasStarted)) {
      socket.emit('settings:applied', { settings: room.settings || {} });
      return;
    }

    // FRIENDS i BOTI: nastavení může před startem měnit pouze seat 1.
    if (['friends','bots'].includes(room.mode) && (!seat || seat !== 1 || room.hasStarted)) {
      socket.emit('settings:applied', { settings: room.settings || {} });
      return;
    }

    const safe = sanitizeSettings(settings);
    room.settings = { ...(room.settings || {}), ...safe };

    if (room.mode === 'friends' && !room.hasStarted) {
      // Jakákoli změna pravidel zruší připravenost – nikdo nemůže odstartovat
      // zápas s nastavením, které se změnilo až po jeho potvrzení.
      room.ready = { 1: false, 2: false, 3: false };
    }

    io.to(roomId).emit('settings:applied', { settings: room.settings });
    if (['friends','bots'].includes(room.mode) && !room.hasStarted) broadcastLobbyState(roomId);
    if (room.mode === 'random' && room.matchKind === 'custom' && !room.hasStarted) {
      broadcastLobbyState(roomId);
      broadcastPublicRandomRooms();
    }

    console.log('🧩 settings:update', roomId, room.settings);
  });

  socket.on('lobby:ready', ({ roomId, ready }) => {
    const room = rooms[roomId];
    if (!room || room.mode !== 'friends' || room.hasStarted) return;
    const seat = getSeatNumber(room, socket.id);
    if (!seat) return;

    room.ready = room.ready || { 1: false, 2: false, 3: false };
    room.ready[seat] = !!ready;
    console.log(`✅ ${roomId}: seat ${seat} ready=${room.ready[seat]}`);
    broadcastLobbyState(roomId);
  });

  socket.on('lobby:start', ({ roomId } = {}) => {
    const room = rooms[roomId];
    if (!room || room.hasStarted) return;
    const allowedStart = ['friends','bots'].includes(room.mode) || (room.mode === 'random' && room.matchKind === 'custom');
    if (!allowedStart) return;
    const seat = getSeatNumber(room, socket.id);
    if (seat !== 1) return;

    const state = buildLobbyState(room, roomId);
    if (!state.canStart) {
      socket.emit('lobby:error', {
        message: room.mode === 'friends'
          ? 'Ke startu jsou potřeba alespoň dva připojení a připravení hráči.'
          : (room.mode === 'random' ? 'Custom místnost potřebuje alespoň dva připojené hráče.' : 'Trénink zatím není připraven.')
      });
      broadcastLobbyState(roomId);
      return;
    }

    // Friends i veřejná custom hra mohou odstartovat ve dvou.
    // Každé chybějící sedadlo se těsně před startem převede na bota.
    if (room.mode === 'friends' || (room.mode === 'random' && room.matchKind === 'custom')) {
      fillMissingLobbySeatsWithBots(roomId);
    }

    const started = startRoomGame(roomId);
    if (started && room.mode === 'random' && room.matchKind === 'custom') {
      // Po startu custom místnost okamžitě zmizí z veřejného browseru.
      broadcastPublicRandomRooms();
    }
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


  socket.on("resume", ({ roomId, token, expectedMode } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("resume:error", { message: "room not found" });
    if (expectedMode && room.mode !== expectedMode) return socket.emit("resume:error", { message: "room mode mismatch" });

    // Obranná kompatibilita se starší verzí: pokud byla rozehraná non-league room
    // chybně označena jako zavřená jen kvůli transientnímu disconnectu, reconnect ji
    // smí znovu otevřít. V nové verzi se tento stav už při F5 vůbec nevytváří.
    if (room.__closed === true && room.hasStarted && room.mode !== 'liga') {
      room.__closed = false;
      console.warn(`🛟 ${roomId}: resume zrušil stale __closed u rozehrané hry.`);
    }

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
    if (rec) {
      rec.id = socket.id;
      socket.data.name = rec.name;
    }

    // když byl dočasně bot → vrať člověka k volantu
    room.seatControllers[seat] = "human";
    console.log(`♻️ ${roomId}: Player${seat} resumed (phase=${room.phase}, round=${room.round || 0}, activeTurn=${room.activeTurn?.kind || 'none'}, activeQuestion=${room.activeQuestion?.kind || 'none'}).`);

    // zruš grace timeout (viz níž)
    const prevTO = room.reconnectHolds.get(seat);
    if (prevTO) {
      clearTimeout(prevTO);
      room.reconnectHolds.delete(seat);
    }

    // Pošli snapshot místo startu
    socket.emit("stateSync", {
      myNumber: seat,
      snapshot: buildRoomSnapshot(room, roomId, seat)
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
    if (!room.hasStarted && ['friends','bots','random'].includes(room.mode)) {
      broadcastLobbyState(roomId);
      if (room.mode === 'random' && room.matchKind === 'custom') broadcastPublicRandomRooms();
    }
  });





  console.log(`✅ ${socket.id} connected`);


  // Klient po úplném načtení stránky požádá ještě jednou o čerstvý snapshot.
  // Tím pokryjeme i extrémní případ, kdy první stateSync dorazil během parsování
  // velkého game_online.html a některé pozdější legacy inicializace by jej přepsaly.
  socket.on("requestStateSync", () => {
    const roomId = socket.data?.roomId || socket.data?.joinedRoom;
    const room = roomId ? rooms[roomId] : null;
    if (!room || !isRoomAlive(roomId)) return;
    const seat = getSeatNumber(room, socket.id) || Number(socket.data?.seat) || null;
    if (!seat) return;
    socket.emit("stateSync", {
      myNumber: seat,
      snapshot: buildRoomSnapshot(room, roomId, seat)
    });
    console.log(`🔄 ${roomId}: fresh stateSync pro Player${seat}`);
  });


  socket.on("baseSettled", ({ playerNumber } = {}) => {
    const roomId = socket.data?.joinedRoom || socket.data?.roomId;
    const room = roomId ? rooms[roomId] : null;
    if (!room || !isRoomAlive(roomId)) {
      console.warn(`⚠️ baseSettled ignorován – socket ${socket.id} není v aktivní místnosti.`);
      return;
    }

    // Událost už není součástí settlePlayerX()/rehydratace. Klient ji posílá
    // pouze z úvodní animace ve chvíli, kdy se konkrétní základna vykreslí.
    // Helper je idempotentní, takže 2–3 klienti mohou potvrdit stejnou základnu
    // a skóre se přičte pouze jednou.
    awardBaseSettlementScore(roomId, playerNumber, `socket:${socket.id}`);
  });


  socket.on("basesAnimationDone", ({ roomId } = {}) => {
    acknowledgeBaseAnimationDone(socket, roomId);
  });



  // FRIENDS: host vytvoří místnost a rovnou se do ní přidá
socket.on("createRoom", ({ settings }) => {
  const name   = (settings?.name || "Host").toString();
  const mode   = (settings?.mode || 'friends');   // ⬅️ vezmeme mód z klienta
  const roomId = makeFriendsRoomId();

  const room = makeEmptyRoom(roomId, mode);       // ⬅️ použij mód i do room
  room.settings = sanitizeSettings(settings || {});

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
  socket.emit("stateSync", { myNumber: seatNum, snapshot: buildRoomSnapshot(rooms[roomId], roomId, seatNum) });
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
    rooms[roomId].settings = sanitizeSettings(settings || {});
  }

  // ⬇️ doplň tohle (volitelné)
  if (rooms[roomId].mode === 'bots') {
    socket.emit("roomError", { message: "Tahle místnost je sólo proti botům." });
    return;
  }

  const current = rooms[roomId];
  const availableSeat = findSeatForReturningOrBot(current, name);
  if (!availableSeat) {
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
  socket.emit("stateSync", { myNumber: seatNum, snapshot: buildRoomSnapshot(rooms[roomId], roomId, seatNum) });
});












  function joinQuickRandom(payload = {}) {
    if (socket.data?.joinedRoom) return;
    const name = String(payload?.name || payload || '').trim() || 'Hráč';
    const ratingRaw = payload && typeof payload === 'object' ? Number(payload.rating) : NaN;
    const rating = Number.isFinite(ratingRaw) ? ratingRaw : null;

    let picked = pickQuickMatchRoom(rating);
    let roomId, room;
    if (picked) {
      ({ roomId, room } = picked);
    } else {
      roomId = makeFriendsRoomId();
      room = makeEmptyRoom(roomId, 'random');
      room.matchKind = 'quick';
      room.publicRoom = false;
      room.settings = { mode: 'random', cats: [1,2,3,4,5,6,7,8,9] };
      room.skillRating = rating;
    }

    socket.data = socket.data || {};
    socket.data.joinedRoom = roomId;
    socket.data.name = name;
    roomAddPlayerAndBroadcast(roomId, socket, name);
    console.log(`⚡ QUICK FIFO: ${name} joined ${roomId} (${connectedHumanCount(room)}/3)`);
  }

  socket.on('random:quick:join', payload => joinQuickRandom(payload));
  // zpětná kompatibilita se staršími klienty
  socket.on('submitName', payload => joinQuickRandom(payload));

  socket.on('random:custom:create', ({ name, settings } = {}) => {
    if (socket.data?.joinedRoom) return;
    const safeName = String(name || 'Hostitel').trim() || 'Hostitel';
    const roomId = makeFriendsRoomId();
    const room = makeEmptyRoom(roomId, 'random');
    room.matchKind = 'custom';
    room.publicRoom = true;
    room.settings = sanitizeSettings({ ...(settings || {}), mode: 'random' });
    if (!Array.isArray(room.settings.cats) || !room.settings.cats.length) room.settings.cats = [1,2,3,4,5,6,7,8,9];

    socket.data = socket.data || {};
    socket.data.joinedRoom = roomId;
    socket.data.name = safeName;
    roomAddPlayerAndBroadcast(roomId, socket, safeName);
    socket.emit('random:custom:created', { roomId, code: roomId.replace(/^room_/i,'') });
    broadcastPublicRandomRooms();
    console.log(`🛠️ CUSTOM RANDOM: ${safeName} created ${roomId}`);
  });

  socket.on('random:custom:join', ({ roomId, name } = {}) => {
    if (socket.data?.joinedRoom) return;
    const safeId = sanitizeRoomId(roomId);
    const room = safeId ? rooms[safeId] : null;
    if (!room || room.__closed || room.mode !== 'random' || room.matchKind !== 'custom' || room.hasStarted || !room.publicRoom) {
      socket.emit('random:custom:error', { message: 'Místnost už není dostupná.' });
      broadcastPublicRandomRooms();
      return;
    }
    if (connectedHumanCount(room) >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('random:custom:error', { message: 'Místnost je plná.' });
      broadcastPublicRandomRooms();
      return;
    }
    const safeName = String(name || 'Hráč').trim() || 'Hráč';
    socket.data = socket.data || {};
    socket.data.joinedRoom = safeId;
    socket.data.name = safeName;
    roomAddPlayerAndBroadcast(safeId, socket, safeName);
    broadcastPublicRandomRooms();
    console.log(`🚪 CUSTOM RANDOM: ${safeName} joined ${safeId}`);
  });

  socket.on('random:custom:list', () => {
    socket.emit('random:custom:rooms', listPublicRandomRooms());
  });









socket.on("disconnect", async () => {
  portalOnlineSockets.delete(socket.id);
  broadcastPortalOnlineCount();

  // Odpojený klient nesmí držet právě běžící UI bariéru až do fallback timeoutu.
  dropSocketFromBattleUiWaiters(socket.id);
  dropSocketFromBaseAnimationWaiters(socket.id);

  const leagueQueueUserId = String(socket.data?.leagueQueueUserId || '');
  if (leagueQueueUserId) {
    removeLeagueQueueEntry(leagueQueueUserId, socket.id);
    broadcastLeagueQueueStatuses();
  }
  const readyMatchId = String(socket.data?.leagueReadyMatchId || '');
  if (readyMatchId && leagueReadyChecks.has(readyMatchId)) {
    const state = leagueReadyChecks.get(readyMatchId);
    const player = state?.players?.find(p => p.socketId === socket.id || String(p.userId) === String(socket.data?.leagueUserId || ''));
    if (player) await cancelLeagueReadyCheck(readyMatchId, 'ready_disconnect', player.userId);
  }

  const roomId = socket.data?.joinedRoom || socket.data?.roomId;
  if (!roomId || !rooms[roomId]) return;

  const room = rooms[roomId];
  const ix = room.players.findIndex(p => p && p.id === socket.id);
  if (ix === -1) return;

  const seat = ix + 1;
  const name = room.players[ix]?.name || `Player${seat}`;

  // LIGA: nikdy nepřevádíme odpojeného člověka na bota. Před startem ho
  // hlídá join timeout. Po startu má 90 sekund na návrat, pak je označen jako odstoupivší.
  if (room.mode === 'liga') {
    room.players[ix].id = null;
    room.seatControllers[seat] = 'human';
    io.to(roomId).emit('league:game:status', { connected:connectedHumanCount(room), total:3 });

    if (!room.hasStarted) return;

    io.to(roomId).emit('league:player:disconnected', { seat, name, graceSeconds:90 });
    if (room.leagueDisconnectedTimers?.get(seat)) clearTimeout(room.leagueDisconnectedTimers.get(seat));
    const timer = setTimeout(() => {
      const current = rooms[roomId];
      if (!current || current.__closed || current.players?.[seat-1]?.id) return;
      current.leagueForfeitSeat = current.leagueForfeitSeat || seat;
      current.leagueDisconnectedTimers?.delete(seat);
      io.to(roomId).emit('league:player:forfeit', { seat, name });
      console.log(`⚠️ LIGA ${current.leagueMatchId}: ${name} překročil reconnect limit, seat ${seat} = forfeit`);
    }, 90_000);
    timer.unref?.();
    room.leagueDisconnectedTimers?.set(seat, timer);
    return;
  }

  // RANDOM před startem: hráč opravdu opouští frontu/místnost.
  // Nikdy z něj nevytvářej bota a nenechávej po něm stale seat – to dříve
  // způsobovalo přeskočení prvního čekajícího hráče v matchmakingu.
  if (room.mode === 'random' && !room.hasStarted) {
    const wasHost = seat === 1;
    room.players[ix] = undefined;
    room.ready[seat] = false;
    room.seatControllers[seat] = 'human';
    if (room.playerTokens) delete room.playerTokens[seat];
    socket.leave(roomId);

    if (room.matchKind === 'custom' && wasHost) {
      markRoomClosed(roomId);
      delete rooms[roomId];
      console.log(`🧹 CUSTOM RANDOM ${roomId} zrušena – hostitel odešel.`);
    } else if (connectedHumanCount(room) === 0) {
      markRoomClosed(roomId);
      delete rooms[roomId];
      console.log(`🧹 RANDOM ${roomId} odstraněna – fronta je prázdná.`);
    } else {
      broadcastLobbyState(roomId);
      console.log(`↩️ ${name} opustil RANDOM ${roomId}; místo je znovu volné.`);
    }
    broadcastPublicRandomRooms();
    return;
  }

  // Před startem friends hry zůstává sedadlo jen offline; bot ho nepřebírá.
  if (room.mode === 'friends' && !room.hasStarted) {
    room.players[ix].id = null;
    room.ready = room.ready || { 1: false, 2: false, 3: false };
    room.ready[seat] = false;
    room.seatControllers[seat] = 'human';
    console.log(`⌛ ${name} opustil lobby ${roomId} (seat ${seat} offline)`);
    broadcastLobbyState(roomId);
    return;
  }

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

  // DŮLEŽITÉ PRO REFRESH/RECONNECT:
  // U rozehrané hry nesmí krátké odpojení posledního lidského socketu označit
  // místnost jako __closed. V režimu s boty jsou oba boti přirozeně bez socket.id,
  // takže při obyčejném F5 bývají na zlomek sekundy všechny tři id == null.
  // Starší kód v ten okamžik zavřel room a běžící async scénář se při nejbližším
  // isRoomAlive() guardu ukončil. Místnost pak po reconnectu sice existovala, ale
  // už neměl kdo pokračovat otázkou / dalším kolem.
  //
  // Rozehranou non-league hru proto necháváme živou. Sedadlo už výše převzal bot
  // a po resume se vrátí člověku. Úklid pre-game místností se řeší v samostatných
  // větvích výše; ligový reconnect má vlastní 90s logiku.
  if (room.hasStarted && room.mode !== 'liga') {
    console.log(`🛟 ${roomId}: dočasně bez lidského socketu; room zůstává živá (phase=${room.phase}, round=${room.round || 0}).`);
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





// ===== POZVÁNKY UŽIVATELŮ – BUDOUCÍ API KONTRAKT =====
// Odkaz/kód fungují už teď. Tento event je připravený pro budoucí databázi účtů.
socket.on('invite:player', ({ roomId, targetUserId } = {}) => {
  socket.emit('invite:unavailable', {
    roomId: sanitizeRoomId(roomId),
    targetUserId: targetUserId || null,
    reason: 'accounts_not_enabled'
  });
});

// ===== KOMUNITNÍ CHAT =====
socket.on('community:chat:send', ({ text } = {}) => {
  const clean = (typeof text === 'string' ? text.trim() : '');
  if (!clean) return;

  const now = Date.now();
  socket.data = socket.data || {};
  if (socket.data.lastCommunityChatAt && now - socket.data.lastCommunityChatAt < 700) return;
  socket.data.lastCommunityChatAt = now;

  const roomId = socket.data.joinedRoom || socket.data.roomId;
  const room = roomId ? rooms[roomId] : null;
  const seat = room ? getSeatNumber(room, socket.id) : null;
  const name = socket.data.name || (seat && room?.players?.[seat - 1]?.name) || 'Host';

  const msg = {
    id: `${now}_${Math.random().toString(16).slice(2)}`,
    name: String(name).slice(0, 40),
    text: clean.slice(0, 500),
    ts: now
  };
  communityChat.push(msg);
  if (communityChat.length > 200) communityChat.shift();
  io.emit('community:chat:new', msg);
});

socket.on('community:chat:history:get', () => {
  socket.emit('community:chat:history', communityChat);
});


socket.on("chat:send", ({ roomId, text }) => {
  console.log("📩 chat:send received", { from: socket.id, roomId, text });

  const room = rooms[roomId];
  if (!room) {
    console.log("❌ room not found for chat:", roomId);
    return;
  }

  const clean = (typeof text === "string" ? text.trim() : "");
  socket.data = socket.data || {};
  const now = Date.now();
  if (socket.data.lastRoomChatAt && now - socket.data.lastRoomChatAt < 500) return;
  socket.data.lastRoomChatAt = now;
  if (!clean) {
    console.log("❌ empty/invalid text");
    return;
  }

  // CHANGED: určete číslo hráče (1..3) – vždy podle aktuálního pořadí
  const number = getSeatNumber(room, socket.id) || 0;

  const ix = room.players.findIndex(p => p && p.id === socket.id);
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



socket.on("battleUiAck", ({ roomId: requestedRoomId, uiToken, stage } = {}) => {
  acknowledgeBattleUi(socket, requestedRoomId, uiToken, stage);
});


socket.on("playerAnswered", ({ room: requestedRoomId, player, answerIndex }) => {
  const roomId = socket.data?.roomId || socket.data?.joinedRoom;
  if (!roomId || String(requestedRoomId || '') !== String(roomId)) return;
  const room = rooms[roomId];
  if (!room || room.currentQuestionType !== 'choice') return;

  const seat = getSeatNumber(room,socket.id);
  if (!seat || Number(player) !== seat || !room.currentQuestionParticipants?.includes(seat)) return;
  const answer = Number(answerIndex);
  if (!Number.isInteger(answer) || answer < 0 || answer > 20) return;

  room.answers = room.answers || {};
  if (room.answers[seat] === undefined) {
    room.answers[seat] = answer;
    console.log(`✏️ Hráč ${seat} v ${roomId} odpověděl: ${answer}`);
    maybeFinishMultipleChoiceQuestion(roomId);
  }
});



socket.on("playerNumericAnswer", ({ room: requestedRoomId, player, answer }) => {
  const roomId = socket.data?.roomId || socket.data?.joinedRoom;
  if (!roomId || String(requestedRoomId || '') !== String(roomId)) return;
  const room = rooms[roomId];
  if (!room || room.currentQuestionType !== 'numeric') return;

  const seat = getSeatNumber(room,socket.id);
  if (!seat || Number(player) !== seat || !room.currentQuestionParticipants?.includes(seat)) return;
  const value = Number(answer);
  if (!Number.isFinite(value) || Math.abs(value) > 1e15) return;

  room.numericAnswers = room.numericAnswers || {};
  const startTime = room.numericStartTime || Date.now();
  if (!room.numericAnswers[seat]) {
    room.numericAnswers[seat] = { num:value, time:Date.now()-startTime };
    console.log(`✏️ Numerická odpověď: Hráč ${seat} v ${roomId} → ${value} (${room.numericAnswers[seat].time}ms)`);
    maybeFinishNumericQuestion(roomId);
  }
});







});




