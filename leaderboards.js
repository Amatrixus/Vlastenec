'use strict';

const db = require('./db');
const { sessionUser } = require('./auth');

const CATEGORY_SLUGS = [
  'vedy','literatura','technologie','geografie','historie',
  'kultura','sport','osobnosti','politika'
];

const PERIODS = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  'all': null
};

function safePeriod(raw) {
  const value = String(raw || '30d').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PERIODS, value) ? value : '30d';
}

function periodSql(period, alias = 'pm') {
  const days = PERIODS[period];
  if (!days) return { sql:'', params:[] };
  return { sql:` AND ${alias}.played_at >= NOW() - ($1::int * INTERVAL '1 day')`, params:[days] };
}

function publicNormalRow(row, currentUserId = null) {
  const games = Number(row.games || 0);
  const wins = Number(row.wins || 0);
  const seconds = Number(row.second_places || 0);
  const thirds = Number(row.third_places || 0);
  const rawPlacementScore = games ? (wins + seconds * 0.5) / games : 0;
  // Jemný bayesovský prior: 6 pomyslných her s neutrálním výsledkem 50 %.
  // Chrání veřejný žebříček před tím, aby 1 výhra z 1 hry automaticky znamenala první místo.
  const performance = games ? (wins + seconds * 0.5 + 3) / (games + 6) : 0.5;
  return {
    userId:String(row.user_id),
    displayName:row.display_name,
    rank:Number(row.rank),
    games,
    wins,
    secondPlaces:seconds,
    thirdPlaces:thirds,
    winRate:games ? wins / games : 0,
    averagePlacement:games ? Number(row.avg_placement || 0) : null,
    placementScore:rawPlacementScore,
    performance,
    totalScore:Number(row.total_score || 0),
    bestScore:Number(row.best_score || 0),
    territories:Number(row.territories || 0),
    questionWins:Number(row.question_wins || 0),
    isMe:currentUserId != null && String(row.user_id) === String(currentUserId)
  };
}

async function normalRows(period) {
  const filter = periodSql(period);
  const params = [...filter.params];
  const result = await db.query(
    `WITH aggregated AS (
       SELECT pm.user_id, u.display_name,
              COUNT(*)::int AS games,
              COUNT(*) FILTER (WHERE pm.placement=1)::int AS wins,
              COUNT(*) FILTER (WHERE pm.placement=2)::int AS second_places,
              COUNT(*) FILTER (WHERE pm.placement=3)::int AS third_places,
              AVG(pm.placement)::float8 AS avg_placement,
              SUM(pm.score)::bigint AS total_score,
              MAX(pm.score)::int AS best_score,
              SUM(pm.territories)::bigint AS territories,
              SUM(pm.question_wins)::bigint AS question_wins
         FROM profile_matches pm
         JOIN users u ON u.id=pm.user_id
        WHERE pm.mode='random' ${filter.sql}
        GROUP BY pm.user_id,u.display_name
     ), ranked AS (
       SELECT a.*,
              ((a.wins + a.second_places * 0.5 + 3.0) / (a.games + 6.0)) AS performance,
              ROW_NUMBER() OVER (
                ORDER BY ((a.wins + a.second_places * 0.5 + 3.0) / (a.games + 6.0)) DESC,
                         a.wins DESC, a.games DESC, a.user_id ASC
              ) AS rank
         FROM aggregated a
     )
     SELECT * FROM ranked
      ORDER BY rank ASC`,
    params
  );
  return result.rows;
}

function wilsonLower(successes, total, z = 1.96) {
  const n = Number(total) || 0;
  const s = Number(successes) || 0;
  if (!n) return 0;
  const p = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2*n);
  const margin = z * Math.sqrt((p*(1-p) + z2/(4*n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

function categoryCell(value) {
  const parsed = value && typeof value === 'object' ? value : {};
  const played = Math.max(0, Number(parsed.played) || 0);
  const successes = Math.max(0, Math.min(played, Number(parsed.successes) || 0));
  return { played, successes };
}

async function categoryRows(category, currentUserId = null) {
  const result = await db.query(
    `SELECT p.user_id,u.display_name,p.category_stats
       FROM player_profiles p
       JOIN users u ON u.id=p.user_id
      WHERE u.status='active'`,
    []
  );
  const MIN_ANSWERS = 30;
  const rows = result.rows.map(row => {
    const cell = categoryCell(row.category_stats?.[category]);
    const accuracy = cell.played ? cell.successes / cell.played : 0;
    return {
      userId:String(row.user_id),
      displayName:row.display_name,
      played:cell.played,
      successes:cell.successes,
      accuracy,
      score:wilsonLower(cell.successes,cell.played),
      eligible:cell.played >= MIN_ANSWERS,
      isMe:currentUserId != null && String(row.user_id) === String(currentUserId)
    };
  });
  const eligible = rows.filter(r => r.eligible)
    .sort((a,b) => b.score-a.score || b.accuracy-a.accuracy || b.played-a.played || a.displayName.localeCompare(b.displayName,'cs'))
    .map((row,index) => ({ ...row, rank:index+1 }));
  const me = rows.find(r => r.isMe) || null;
  return { rows:eligible, me, minAnswers:MIN_ANSWERS };
}

async function normalRecords(period) {
  const filter = periodSql(period);
  const result = await db.query(
    `SELECT pm.user_id,u.display_name,
            COUNT(*)::int AS games,
            COUNT(*) FILTER (WHERE pm.placement=1)::int AS wins,
            SUM(pm.territories)::bigint AS territories,
            SUM(pm.question_wins)::bigint AS question_wins,
            MAX(pm.score)::int AS best_score
       FROM profile_matches pm
       JOIN users u ON u.id=pm.user_id
      WHERE pm.mode='random' ${filter.sql}
      GROUP BY pm.user_id,u.display_name`,
    filter.params
  );
  const rows = result.rows.map(row => ({
    userId:String(row.user_id), displayName:row.display_name,
    games:Number(row.games||0), wins:Number(row.wins||0),
    territories:Number(row.territories||0), questionWins:Number(row.question_wins||0),
    bestScore:Number(row.best_score||0),
    winRate:Number(row.games||0) ? Number(row.wins||0)/Number(row.games||0) : 0
  }));
  const pick = (key, predicate = () => true) => rows.filter(predicate).sort((a,b)=>b[key]-a[key] || b.games-a.games)[0] || null;
  return {
    mostWins:pick('wins'),
    bestWinRate:pick('winRate', r => r.games >= 5),
    bestScore:pick('bestScore'),
    mostTerritories:pick('territories'),
    mostQuestionWins:pick('questionWins')
  };
}

function mountLeaderboardRoutes(app) {
  app.get('/api/leaderboards/normal', async (req,res) => {
    if (!db.getStatus().ready) return res.status(503).json({ ok:false,message:'Databáze žebříčků není dostupná.' });
    try {
      const period = safePeriod(req.query.period);
      const user = await sessionUser(req);
      const rows = await normalRows(period);
      const limit = Math.max(10,Math.min(100,Number(req.query.limit)||100));
      const rank = user ? Number(rows.find(row => String(row.user_id) === String(user.id))?.rank || 0) : 0;
      const top = rows.slice(0,limit).map(row=>publicNormalRow(row,user?.id));
      const nearby = rank ? rows.filter(row => Math.abs(Number(row.rank)-rank) <= 3).map(row=>publicNormalRow(row,user?.id)) : [];
      const me = rank ? publicNormalRow(rows.find(row => String(row.user_id)===String(user.id)),user.id) : null;
      res.json({ ok:true,period,total:rows.length,rows:top,nearby,me,authenticated:!!user });
    } catch (err) {
      console.error('leaderboards/normal:',err);
      res.status(500).json({ ok:false,message:'Žebříček normální hry se nepodařilo načíst.' });
    }
  });

  app.get('/api/leaderboards/category', async (req,res) => {
    if (!db.getStatus().ready) return res.status(503).json({ ok:false,message:'Databáze žebříčků není dostupná.' });
    try {
      const category = String(req.query.category || 'historie').toLowerCase();
      if (!CATEGORY_SLUGS.includes(category)) return res.status(400).json({ ok:false,message:'Neplatná kategorie.' });
      const user = await sessionUser(req);
      const data = await categoryRows(category,user?.id);
      const limit = Math.max(10,Math.min(100,Number(req.query.limit)||100));
      res.json({ ok:true,category,rows:data.rows.slice(0,limit),me:data.me,minAnswers:data.minAnswers,total:data.rows.length });
    } catch (err) {
      console.error('leaderboards/category:',err);
      res.status(500).json({ ok:false,message:'Žebříček kategorie se nepodařilo načíst.' });
    }
  });

  app.get('/api/leaderboards/records', async (req,res) => {
    if (!db.getStatus().ready) return res.status(503).json({ ok:false,message:'Databáze žebříčků není dostupná.' });
    try {
      const period = safePeriod(req.query.period);
      const records = await normalRecords(period);
      res.json({ ok:true,period,records });
    } catch (err) {
      console.error('leaderboards/records:',err);
      res.status(500).json({ ok:false,message:'Rekordy se nepodařilo načíst.' });
    }
  });
}

module.exports = { mountLeaderboardRoutes };
