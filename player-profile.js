'use strict';

const db = require('./db');
const { sessionUser } = require('./auth');

const CATEGORY_SLUGS = [
  'vedy','literatura','technologie','geografie','historie',
  'kultura','sport','osobnosti','politika'
];
const MODES = ['random','custom','friends','bots','league'];

function clampInt(value, min = 0, max = 1_000_000_000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanCategories(input) {
  const src = safeObject(input);
  const out = {};
  for (const slug of CATEGORY_SLUGS) {
    const row = safeObject(src[slug]);
    out[slug] = {
      played: clampInt(row.played, 0, 10_000_000),
      successes: clampInt(row.successes, 0, 10_000_000)
    };
    if (out[slug].successes > out[slug].played) out[slug].successes = out[slug].played;
  }
  return out;
}

function cleanModes(input) {
  const src = safeObject(input);
  const out = {};
  for (const mode of MODES) {
    const row = safeObject(src[mode]);
    out[mode] = {
      games: clampInt(row.games, 0, 10_000_000),
      wins: clampInt(row.wins, 0, 10_000_000)
    };
    if (out[mode].wins > out[mode].games) out[mode].wins = out[mode].games;
  }
  return out;
}

function cleanAchievements(input) {
  const src = safeObject(input);
  const out = {};
  for (const [key, value] of Object.entries(src).slice(0, 100)) {
    if (!/^[a-z0-9_-]{1,80}$/i.test(key)) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) out[key] = date.toISOString();
  }
  return out;
}

function normalizeCategory(raw) {
  const value = String(Array.isArray(raw) ? raw[0] : (raw || ''))
    .trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const aliases = {
    vedy:'vedy', science:'vedy', 'prirodni vedy':'vedy',
    literatura:'literatura', literature:'literatura',
    technologie:'technologie', technology:'technologie', tech:'technologie',
    geografie:'geografie', geography:'geografie',
    historie:'historie', history:'historie',
    kultura:'kultura', culture:'kultura',
    sport:'sport', sports:'sport',
    osobnosti:'osobnosti', personalities:'osobnosti', people:'osobnosti',
    politika:'politika', politics:'politika'
  };
  return aliases[value] || null;
}

function xpForMatch({ placement = 3, score = 0, questionWins = 0, territories = 0 } = {}) {
  const p = clampInt(placement, 1, 3);
  const placementBonus = p === 1 ? 80 : p === 2 ? 45 : 25;
  const scoreBonus = Math.min(90, Math.max(0, Math.round(clampInt(score) / 100)));
  return 40 + placementBonus + scoreBonus + clampInt(questionWins, 0, 1000) * 5 + clampInt(territories, 0, 1000) * 4;
}

function achievementState(row) {
  const categories = cleanCategories(row.category_stats);
  const achievements = cleanAchievements(row.achievements);
  const unlocked = new Set(Object.keys(achievements));
  const now = new Date().toISOString();
  const add = id => { if (!unlocked.has(id)) achievements[id] = now; };

  if (row.games_played >= 1) add('first_match');
  if (row.wins >= 1) add('first_win');
  if (row.games_played >= 10) add('veteran_10');
  if (row.games_played >= 50) add('veteran_50');
  if (row.territories_captured >= 25) add('cartographer_25');
  if (row.territories_captured >= 100) add('cartographer_100');
  if (row.best_streak >= 5) add('streak_5');
  if (row.best_streak >= 10) add('streak_10');
  if (CATEGORY_SLUGS.filter(s => categories[s].successes > 0).length >= 9) add('polyhistor');
  if (CATEGORY_SLUGS.some(s => categories[s].played >= 10 && categories[s].successes / Math.max(1, categories[s].played) >= 0.8)) add('specialist');
  if (row.questions_correct >= 100) add('centurion');
  if (row.best_score >= 2500) add('high_score');
  return achievements;
}

function rowToProfile(row, matches = [], displayName = '') {
  const meta = safeObject(row.profile_meta);
  return {
    version: 1,
    identityId: `account:${row.user_id}`,
    displayName: displayName || meta.displayName || 'Hráč',
    createdAt: meta.createdAt || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    xp: Number(row.xp) || 0,
    stats: {
      gamesPlayed: row.games_played || 0,
      wins: row.wins || 0,
      seconds: row.second_places || 0,
      thirds: row.third_places || 0,
      totalScore: Number(row.total_score) || 0,
      bestScore: row.best_score || 0,
      questionsPlayed: row.questions_answered || 0,
      questionWins: row.questions_correct || 0,
      territoriesCaptured: row.territories_captured || 0,
      currentStreak: clampInt(meta.currentStreak, 0, 1_000_000),
      maxStreak: row.best_streak || 0
    },
    modes: cleanModes(row.mode_stats),
    categories: cleanCategories(row.category_stats),
    achievements: cleanAchievements(row.achievements),
    matches: matches.map(m => ({
      id: m.event_id,
      playedAt: new Date(m.played_at).toISOString(),
      mode: m.mode,
      placement: m.placement,
      score: m.score,
      xp: m.xp,
      territories: m.territories,
      questionWins: m.question_wins,
      opponents: Array.isArray(m.opponents) ? m.opponents : []
    }))
  };
}

async function fetchProfile(client, userId, displayName) {
  await client.query('INSERT INTO player_profiles(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const p = await client.query('SELECT * FROM player_profiles WHERE user_id = $1', [userId]);
  const m = await client.query(
    `SELECT event_id, played_at, mode, placement, score, xp, territories, question_wins, opponents
       FROM profile_matches
      WHERE user_id = $1
      ORDER BY played_at DESC, id DESC
      LIMIT 20`,
    [userId]
  );
  return rowToProfile(p.rows[0], m.rows, displayName);
}

async function requireUser(req, res) {
  if (!db.getStatus().ready) {
    res.status(503).json({ ok:false, message:'Databáze profilu není dostupná.' });
    return null;
  }
  const user = await sessionUser(req);
  if (!user) {
    res.status(401).json({ ok:false, message:'Pro serverový profil se přihlas.' });
    return null;
  }
  return user;
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return url.origin === `${proto}://${host}`;
  } catch { return false; }
}

async function insertEvent(client, userId, eventId, eventType) {
  const id = String(eventId || '').trim().slice(0, 80);
  if (!id || !/^[a-zA-Z0-9._:-]{6,80}$/.test(id)) return false;
  const q = await client.query(
    `INSERT INTO profile_events(user_id, event_id, event_type)
     VALUES($1,$2,$3)
     ON CONFLICT (user_id,event_id) DO NOTHING
     RETURNING event_id`,
    [userId, id, eventType]
  );
  return q.rowCount > 0;
}

function sanitizeImport(data) {
  const d = safeObject(data);
  const s = safeObject(d.stats);
  const gamesPlayed = clampInt(s.gamesPlayed, 0, 100_000);
  const wins = Math.min(gamesPlayed, clampInt(s.wins, 0, 100_000));
  const seconds = Math.min(gamesPlayed, clampInt(s.seconds, 0, 100_000));
  const thirds = Math.min(gamesPlayed, clampInt(s.thirds, 0, 100_000));
  const questionsPlayed = clampInt(s.questionsPlayed, 0, 10_000_000);
  return {
    xp: clampInt(d.xp, 0, 50_000_000),
    gamesPlayed, wins, seconds, thirds,
    totalScore: clampInt(s.totalScore, 0, 10_000_000_000),
    bestScore: clampInt(s.bestScore, 0, 10_000_000),
    territories: clampInt(s.territoriesCaptured, 0, 10_000_000),
    questionsPlayed,
    questionWins: Math.min(questionsPlayed, clampInt(s.questionWins, 0, 10_000_000)),
    currentStreak: clampInt(s.currentStreak, 0, 1_000_000),
    maxStreak: clampInt(s.maxStreak, 0, 1_000_000),
    categories: cleanCategories(d.categories),
    modes: cleanModes(d.modes),
    achievements: cleanAchievements(d.achievements),
    createdAt: (() => { const x = new Date(d.createdAt); return Number.isNaN(x.getTime()) ? new Date().toISOString() : x.toISOString(); })(),
    matches: Array.isArray(d.matches) ? d.matches.slice(0,20) : []
  };
}

function cleanMatch(raw) {
  const x = safeObject(raw);
  const mode = MODES.includes(x.mode) ? x.mode : 'random';
  const playedAtDate = new Date(x.playedAt);
  return {
    eventId: String(x.id || `import-${Date.now()}-${Math.random().toString(36).slice(2,8)}`).slice(0,80),
    playedAt: Number.isNaN(playedAtDate.getTime()) ? new Date() : playedAtDate,
    mode,
    placement: clampInt(x.placement,1,3),
    score: clampInt(x.score,0,10_000_000),
    xp: clampInt(x.xp,0,100_000),
    territories: clampInt(x.territories,0,1000),
    questionWins: clampInt(x.questionWins,0,1000),
    opponents: Array.isArray(x.opponents) ? x.opponents.slice(0,2).map(v=>String(v).slice(0,24)) : []
  };
}


function safeMode(raw) {
  const value = String(raw || '').toLowerCase();
  if (value === 'liga') return 'league';
  return MODES.includes(value) ? value : 'random';
}

function finiteNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function recordAuthoritativeQuestion(event = {}) {
  if (!db.getStatus().ready) return { saved:false, reason:'db_not_ready' };
  const userId = String(event.userId || '').trim();
  const eventId = String(event.eventId || '').trim().slice(0,80);
  if (!/^\d+$/.test(userId) || !/^[a-zA-Z0-9._:-]{6,80}$/.test(eventId)) return { saved:false, reason:'invalid_identity' };

  const mode = safeMode(event.mode);
  const category = normalizeCategory(event.category);
  const questionType = event.questionType === 'numeric' ? 'numeric' : 'choice';
  const success = !!event.success;
  const answered = event.answered !== false;
  const answerNumeric = questionType === 'numeric' ? finiteNumberOrNull(event.answerNumeric) : null;
  const correctNumeric = questionType === 'numeric' ? finiteNumberOrNull(event.correctNumeric) : null;
  let numericErrorPct = questionType === 'numeric' ? finiteNumberOrNull(event.numericErrorPct) : null;
  if (numericErrorPct != null) numericErrorPct = Math.max(0, Math.min(1_000_000, numericErrorPct));
  const exactHit = questionType === 'numeric' && !!event.exactHit;
  const matchId = String(event.matchId || '').trim().slice(0,80) || null;

  return db.withTransaction(async client => {
    const fresh = await insertEvent(client,userId,eventId,'question_server');
    if (!fresh) return { saved:false, duplicate:true };

    await client.query(
      `INSERT INTO profile_question_events(
         user_id,event_id,match_id,mode,category,question_type,success,answered,
         answer_numeric,correct_numeric,numeric_error_pct,exact_hit
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [userId,eventId,matchId,mode,category,questionType,success,answered,
       answerNumeric,correctNumeric,numericErrorPct,exactHit]
    );

    await client.query('INSERT INTO player_profiles(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const locked = await client.query('SELECT * FROM player_profiles WHERE user_id=$1 FOR UPDATE', [userId]);
    const row = locked.rows[0];
    const categories = cleanCategories(row.category_stats);
    if (category) {
      categories[category].played += 1;
      if (success) categories[category].successes += 1;
    }
    const meta = safeObject(row.profile_meta);
    const currentStreak = success ? clampInt(meta.currentStreak,0,1_000_000) + 1 : 0;
    const bestStreak = Math.max(row.best_streak || 0,currentStreak);
    row.questions_answered = (row.questions_answered || 0) + 1;
    row.questions_correct = (row.questions_correct || 0) + (success ? 1 : 0);
    row.best_streak = bestStreak;
    row.category_stats = categories;
    row.profile_meta = { ...meta, currentStreak };
    row.achievements = achievementState(row);
    await client.query(
      `UPDATE player_profiles SET questions_answered=$2,questions_correct=$3,best_streak=$4,
         category_stats=$5::jsonb,profile_meta=$6::jsonb,achievements=$7::jsonb,updated_at=NOW()
       WHERE user_id=$1`,
      [userId,row.questions_answered,row.questions_correct,bestStreak,JSON.stringify(categories),JSON.stringify(row.profile_meta),JSON.stringify(row.achievements)]
    );
    return { saved:true, duplicate:false };
  });
}

async function recordAuthoritativeMatch(event = {}) {
  if (!db.getStatus().ready) return { saved:false, reason:'db_not_ready' };
  const userId = String(event.userId || '').trim();
  const eventId = String(event.eventId || '').trim().slice(0,80);
  if (!/^\d+$/.test(userId) || !/^[a-zA-Z0-9._:-]{6,80}$/.test(eventId)) return { saved:false, reason:'invalid_identity' };

  const mode = safeMode(event.mode);
  const placement = clampInt(event.placement,1,3);
  const score = clampInt(event.score,0,10_000_000);
  const territories = clampInt(event.territories,0,10_000);
  const questionWins = clampInt(event.questionWins,0,10_000);
  const opponents = Array.isArray(event.opponents) ? event.opponents.slice(0,2).map(v=>String(v).slice(0,24)) : [];
  const xpEarned = xpForMatch({placement,score,questionWins,territories});

  return db.withTransaction(async client => {
    const fresh = await insertEvent(client,userId,eventId,'match_server');
    if (!fresh) return { saved:false, duplicate:true, xpEarned:0 };
    await client.query('INSERT INTO player_profiles(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const locked = await client.query('SELECT * FROM player_profiles WHERE user_id=$1 FOR UPDATE', [userId]);
    const row = locked.rows[0];
    const modes = cleanModes(row.mode_stats);
    modes[mode].games += 1;
    if (placement === 1) modes[mode].wins += 1;
    row.xp = Number(row.xp || 0) + xpEarned;
    row.games_played = (row.games_played || 0) + 1;
    if (placement === 1) row.wins = (row.wins || 0) + 1;
    if (placement === 2) row.second_places = (row.second_places || 0) + 1;
    if (placement === 3) row.third_places = (row.third_places || 0) + 1;
    row.total_score = Number(row.total_score || 0) + score;
    row.best_score = Math.max(row.best_score || 0,score);
    row.territories_captured = (row.territories_captured || 0) + territories;
    row.mode_stats = modes;
    row.achievements = achievementState(row);

    await client.query(
      `UPDATE player_profiles SET xp=$2,games_played=$3,wins=$4,second_places=$5,third_places=$6,
         total_score=$7,best_score=$8,territories_captured=$9,mode_stats=$10::jsonb,
         achievements=$11::jsonb,updated_at=NOW() WHERE user_id=$1`,
      [userId,row.xp,row.games_played,row.wins,row.second_places,row.third_places,row.total_score,row.best_score,
       row.territories_captured,JSON.stringify(modes),JSON.stringify(row.achievements)]
    );
    await client.query(
      `INSERT INTO profile_matches(user_id,event_id,mode,placement,score,xp,territories,question_wins,opponents,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'server')`,
      [userId,eventId,mode,placement,score,xpEarned,territories,questionWins,JSON.stringify(opponents)]
    );
    return { saved:true, duplicate:false, xpEarned };
  });
}

function mountProfileRoutes(app) {
  app.get('/api/profile', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const profile = await db.withTransaction(client => fetchProfile(client, user.id, user.displayName));
      res.json({ ok:true, profile });
    } catch (err) {
      console.error('profile/get:', err);
      res.status(500).json({ ok:false, message:'Profil se nepodařilo načíst.' });
    }
  });

  app.post('/api/profile/import-local', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!sameOrigin(req)) return res.status(403).json({ ok:false, message:'Neplatný původ požadavku.' });
      const incoming = sanitizeImport(req.body?.profile);

      const result = await db.withTransaction(async client => {
        await client.query('INSERT INTO player_profiles(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING', [user.id]);
        const locked = await client.query('SELECT * FROM player_profiles WHERE user_id=$1 FOR UPDATE', [user.id]);
        const row = locked.rows[0];
        const pristine = Number(row.xp) === 0 && row.games_played === 0 && row.questions_answered === 0 && row.territories_captured === 0;
        const matchCount = await client.query('SELECT COUNT(*)::int AS n FROM profile_matches WHERE user_id=$1', [user.id]);
        const canImport = pristine && Number(matchCount.rows[0]?.n || 0) === 0;

        if (canImport) {
          const meta = { currentStreak: incoming.currentStreak, createdAt: incoming.createdAt, importedLocalAt: new Date().toISOString() };
          await client.query(
            `UPDATE player_profiles SET
               xp=$2, games_played=$3, wins=$4, second_places=$5, third_places=$6,
               total_score=$7, best_score=$8, territories_captured=$9,
               questions_answered=$10, questions_correct=$11, best_streak=$12,
               category_stats=$13::jsonb, mode_stats=$14::jsonb, achievements=$15::jsonb,
               profile_meta=$16::jsonb, updated_at=NOW()
             WHERE user_id=$1`,
            [user.id, incoming.xp, incoming.gamesPlayed, incoming.wins, incoming.seconds, incoming.thirds,
             incoming.totalScore, incoming.bestScore, incoming.territories, incoming.questionsPlayed,
             incoming.questionWins, incoming.maxStreak, JSON.stringify(incoming.categories), JSON.stringify(incoming.modes),
             JSON.stringify(incoming.achievements), JSON.stringify(meta)]
          );
          for (const raw of incoming.matches) {
            const m = cleanMatch(raw);
            await client.query(
              `INSERT INTO profile_matches(user_id,event_id,played_at,mode,placement,score,xp,territories,question_wins,opponents)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
               ON CONFLICT (user_id,event_id) DO NOTHING`,
              [user.id,m.eventId,m.playedAt,m.mode,m.placement,m.score,m.xp,m.territories,m.questionWins,JSON.stringify(m.opponents)]
            );
          }
        }
        return { imported:canImport, profile:await fetchProfile(client,user.id,user.displayName) };
      });
      res.json({ ok:true, ...result });
    } catch (err) {
      console.error('profile/import-local:', err);
      res.status(500).json({ ok:false, message:'Lokální profil se nepodařilo převést.' });
    }
  });

  // Od v2 se profilové události počítají autoritativně přímo z herního serveru.
  // Endpointy ponecháváme kvůli starším klientům, ale jejich payload už statistiky nemění.
  app.post('/api/profile/event/question', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!sameOrigin(req)) return res.status(403).json({ ok:false, message:'Neplatný původ požadavku.' });
      res.json({ ok:true, ignored:true, authoritative:true });
    } catch (err) {
      console.error('profile/question legacy endpoint:', err);
      res.status(500).json({ ok:false, message:'Profilový server není dostupný.' });
    }
  });

  app.post('/api/profile/event/match', async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!sameOrigin(req)) return res.status(403).json({ ok:false, message:'Neplatný původ požadavku.' });
      res.json({ ok:true, ignored:true, authoritative:true });
    } catch (err) {
      console.error('profile/match legacy endpoint:', err);
      res.status(500).json({ ok:false, message:'Profilový server není dostupný.' });
    }
  });
}

module.exports = { mountProfileRoutes, xpForMatch, recordAuthoritativeQuestion, recordAuthoritativeMatch, normalizeCategory };
