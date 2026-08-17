'use strict';

const db = require('./db');
const { sessionUser } = require('./auth');

const SEASON_WEEKS = 8;
const PLACEMENT_GAMES = 5;
const SEASON_LOCK_KEY = 84621731;

const DIVISIONS = [
  { key: 'copper', name: 'Měděná', min: null, max: 999 },
  { key: 'bronze', name: 'Bronzová', min: 1000, max: 1199 },
  { key: 'silver', name: 'Stříbrná', min: 1200, max: 1399 },
  { key: 'gold', name: 'Zlatá', min: 1400, max: 1599 },
  { key: 'crown', name: 'Korunní', min: 1600, max: 1799 },
  { key: 'lion', name: 'Lví liga', min: 1800, max: null }
];

function divisionForRating(value) {
  const rating = Number(value) || 1200;
  if (rating < 1000) return DIVISIONS[0];
  if (rating < 1200) return DIVISIONS[1];
  if (rating < 1400) return DIVISIONS[2];
  if (rating < 1600) return DIVISIONS[3];
  if (rating < 1800) return DIVISIONS[4];
  return DIVISIONS[5];
}

function seasonRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    number: Number(row.season_number),
    name: row.name,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    status: row.status
  };
}

function leaguePlayerRow(row, rank = null) {
  if (!row) return null;
  const placementGames = Number(row.placement_games || 0);
  const ranked = placementGames >= PLACEMENT_GAMES;
  const rating = Number(row.rating || 1200);
  const startingRating = Number(row.starting_rating || 1200);
  const division = divisionForRating(rating);
  const nextDivision = DIVISIONS[DIVISIONS.findIndex(d => d.key === division.key) + 1] || null;
  let divisionProgress = null;
  if (ranked && division.min != null && division.max != null) {
    divisionProgress = Math.max(0, Math.min(1, (rating - division.min) / ((division.max + 1) - division.min)));
  } else if (ranked && division.key === 'copper') {
    divisionProgress = Math.max(0, Math.min(1, rating / 1000));
  } else if (ranked && division.key === 'lion') {
    divisionProgress = 1;
  }
  return {
    rating,
    ratingVisible: ranked,
    startingRating,
    ratingDeltaSeason: rating - startingRating,
    games: Number(row.games || 0),
    wins: Number(row.wins || 0),
    secondPlaces: Number(row.second_places || 0),
    thirdPlaces: Number(row.third_places || 0),
    placementGames,
    placementRequired: PLACEMENT_GAMES,
    ranked,
    rank: rank == null ? null : Number(rank),
    highestRating: Number(row.highest_rating || rating),
    division: ranked ? { ...division } : null,
    nextDivision: ranked && nextDivision ? { ...nextDivision } : null,
    divisionProgress,
    lastMatchAt: row.last_match_at ? new Date(row.last_match_at).toISOString() : null
  };
}

async function ensureActiveSeason() {
  return db.withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEASON_LOCK_KEY]);
    const now = new Date();

    await client.query(
      `UPDATE league_seasons
          SET status='closed', finalized_at=COALESCE(finalized_at, ends_at)
        WHERE status IN ('active','closing') AND ends_at <= NOW()`
    );

    let active = await client.query(
      `SELECT * FROM league_seasons
        WHERE starts_at <= NOW() AND ends_at > NOW() AND status IN ('active','planned')
        ORDER BY season_number DESC LIMIT 1`
    );
    if (active.rows[0]) {
      if (active.rows[0].status !== 'active') {
        const activated = await client.query(
          `UPDATE league_seasons SET status='active' WHERE id=$1 RETURNING *`,
          [active.rows[0].id]
        );
        return activated.rows[0];
      }
      return active.rows[0];
    }

    const latestQ = await client.query('SELECT * FROM league_seasons ORDER BY season_number DESC LIMIT 1');
    let latest = latestQ.rows[0] || null;

    if (!latest) {
      const created = await client.query(
        `INSERT INTO league_seasons(season_number,name,starts_at,ends_at,status)
         VALUES(1,'Sezóna 1',NOW(),NOW() + INTERVAL '${SEASON_WEEKS} weeks','active')
         RETURNING *`
      );
      return created.rows[0];
    }

    let seasonNumber = Number(latest.season_number) + 1;
    let startsAt = new Date(latest.ends_at);
    if (startsAt.getTime() > now.getTime()) startsAt = now;

    // Pokud server několik sezón neběžel, bezpečně doplníme uzavřená období,
    // aby číslování i časová osa zůstaly konzistentní.
    for (let guard = 0; guard < 64; guard++) {
      const endsAt = new Date(startsAt.getTime() + SEASON_WEEKS * 7 * 24 * 60 * 60 * 1000);
      const isCurrent = now.getTime() < endsAt.getTime();
      const status = isCurrent ? 'active' : 'closed';
      const inserted = await client.query(
        `INSERT INTO league_seasons(season_number,name,starts_at,ends_at,status,finalized_at)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (season_number) DO UPDATE SET
           starts_at=EXCLUDED.starts_at,
           ends_at=EXCLUDED.ends_at,
           status=CASE WHEN league_seasons.status='closed' THEN 'closed' ELSE EXCLUDED.status END
         RETURNING *`,
        [seasonNumber, `Sezóna ${seasonNumber}`, startsAt, endsAt, status, isCurrent ? null : endsAt]
      );
      if (isCurrent) return inserted.rows[0];
      startsAt = endsAt;
      seasonNumber += 1;
    }

    throw new Error('Nepodařilo se určit aktuální ligovou sezónu.');
  });
}

async function ensureLeaguePlayer(season, user) {
  return db.withTransaction(async client => {
    const existing = await client.query(
      'SELECT * FROM league_players WHERE season_id=$1 AND user_id=$2 FOR UPDATE',
      [season.id, user.id]
    );
    if (existing.rows[0]) return existing.rows[0];

    const previous = await client.query(
      `SELECT lp.*
         FROM league_players lp
         JOIN league_seasons ls ON ls.id=lp.season_id
        WHERE lp.user_id=$1 AND ls.season_number < $2
        ORDER BY ls.season_number DESC
        LIMIT 1`,
      [user.id, season.season_number]
    );

    let startingRating = 1200;
    let placementGames = 0;
    if (previous.rows[0] && Number(previous.rows[0].placement_games || 0) >= PLACEMENT_GAMES) {
      const previousRating = Number(previous.rows[0].rating || 1200);
      startingRating = 1200 + Math.round((previousRating - 1200) * 0.65);
      placementGames = PLACEMENT_GAMES; // Rozřazení je jen pro první ligovou sezónu hráče.
    }

    const division = placementGames >= PLACEMENT_GAMES ? divisionForRating(startingRating).name : null;
    const inserted = await client.query(
      `INSERT INTO league_players(
         season_id,user_id,rating,starting_rating,games,wins,second_places,third_places,
         placement_games,highest_rating,highest_division,updated_at
       ) VALUES($1,$2,$3,$3,0,0,0,0,$4,$3,$5,NOW())
       ON CONFLICT (season_id,user_id) DO UPDATE SET updated_at=NOW()
       RETURNING *`,
      [season.id, user.id, startingRating, placementGames, division]
    );
    return inserted.rows[0];
  });
}

async function rankedRows(seasonId) {
  const result = await db.query(
    `SELECT lp.user_id, lp.rating, lp.games, lp.wins, lp.second_places, lp.third_places,
            lp.placement_games, lp.highest_rating, lp.highest_division, lp.last_match_at,
            u.display_name,
            ROW_NUMBER() OVER (ORDER BY lp.rating DESC, lp.wins DESC, lp.games ASC, lp.user_id ASC) AS rank
       FROM league_players lp
       JOIN users u ON u.id=lp.user_id
      WHERE lp.season_id=$1 AND lp.placement_games >= $2
      ORDER BY lp.rating DESC, lp.wins DESC, lp.games ASC, lp.user_id ASC`,
    [seasonId, PLACEMENT_GAMES]
  );
  return result.rows;
}

function publicRankRow(row, currentUserId = null) {
  const games = Number(row.games || 0);
  return {
    userId: String(row.user_id),
    displayName: row.display_name,
    rating: Number(row.rating),
    rank: Number(row.rank),
    games,
    wins: Number(row.wins || 0),
    winRate: games ? Number(row.wins || 0) / games : 0,
    division: { ...divisionForRating(row.rating) },
    isMe: currentUserId != null && String(row.user_id) === String(currentUserId)
  };
}

async function recentMatches(seasonId, userId) {
  const result = await db.query(
    `SELECT lm.id, lm.finished_at, lmp.placement, lmp.rating_before, lmp.rating_after,
            lmp.rating_delta, lmp.score,
            COALESCE((
              SELECT json_agg(u2.display_name ORDER BY omp.seat)
                FROM league_match_players omp
                JOIN users u2 ON u2.id=omp.user_id
               WHERE omp.match_id=lm.id AND omp.user_id<>$2
            ), '[]'::json) AS opponents
       FROM league_matches lm
       JOIN league_match_players lmp ON lmp.match_id=lm.id AND lmp.user_id=$2
      WHERE lm.season_id=$1 AND lm.state='finished'
      ORDER BY lm.finished_at DESC NULLS LAST, lm.created_at DESC
      LIMIT 8`,
    [seasonId, userId]
  );
  return result.rows.map(row => ({
    id: row.id,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    placement: Number(row.placement),
    ratingBefore: row.rating_before == null ? null : Number(row.rating_before),
    ratingAfter: row.rating_after == null ? null : Number(row.rating_after),
    ratingDelta: row.rating_delta == null ? null : Number(row.rating_delta),
    score: row.score == null ? 0 : Number(row.score),
    opponents: Array.isArray(row.opponents) ? row.opponents : []
  }));
}

async function profileSummary(userId) {
  const q = await db.query('SELECT xp, games_played, wins FROM player_profiles WHERE user_id=$1', [userId]);
  const row = q.rows[0] || {};
  return {
    xp: Number(row.xp || 0),
    gamesPlayed: Number(row.games_played || 0),
    wins: Number(row.wins || 0)
  };
}

function mountLeagueRoutes(app) {
  app.get('/api/league/overview', async (req, res) => {
    if (!db.getStatus().ready) {
      return res.status(503).json({ ok:false, message:'Ligová databáze není dostupná.' });
    }
    try {
      const season = await ensureActiveSeason();
      const user = await sessionUser(req);
      const rows = await rankedRows(season.id);
      const rankedCount = rows.length;
      const top = rows.slice(0, 8).map(row => publicRankRow(row, user?.id));

      let me = null;
      let nearby = [];
      let matches = [];
      let profile = null;
      if (user) {
        const leagueRow = await ensureLeaguePlayer(season, user);
        const meRankRow = rows.find(row => String(row.user_id) === String(user.id));
        const rank = meRankRow ? Number(meRankRow.rank) : null;
        me = leaguePlayerRow(leagueRow, rank);
        if (rank != null) {
          nearby = rows
            .filter(row => Math.abs(Number(row.rank) - rank) <= 3)
            .map(row => publicRankRow(row, user.id));
        } else {
          nearby = top;
        }
        matches = await recentMatches(season.id, user.id);
        profile = await profileSummary(user.id);
      }

      res.json({
        ok: true,
        authenticated: !!user,
        user: user ? { id:String(user.id), displayName:user.display_name || user.displayName || user.username } : null,
        season: seasonRow(season),
        me,
        profile,
        rankedCount,
        leaderboard: { nearby, top },
        recentMatches: matches,
        divisions: DIVISIONS.map(d => ({ ...d })),
        rules: { placementGames: PLACEMENT_GAMES, seasonWeeks: SEASON_WEEKS }
      });
    } catch (err) {
      console.error('league/overview:', err);
      res.status(500).json({ ok:false, message:'Ligu se nepodařilo načíst.' });
    }
  });

  app.get('/api/league/leaderboard', async (req, res) => {
    if (!db.getStatus().ready) return res.status(503).json({ ok:false, message:'Ligová databáze není dostupná.' });
    try {
      const season = await ensureActiveSeason();
      const user = await sessionUser(req);
      const rows = await rankedRows(season.id);
      const limit = Math.max(10, Math.min(100, Number(req.query.limit) || 100));
      res.json({
        ok:true,
        season:seasonRow(season),
        rows:rows.slice(0,limit).map(row => publicRankRow(row,user?.id)),
        total:rows.length
      });
    } catch (err) {
      console.error('league/leaderboard:', err);
      res.status(500).json({ ok:false, message:'Žebříček se nepodařilo načíst.' });
    }
  });
}

module.exports = {
  mountLeagueRoutes,
  ensureActiveSeason,
  divisionForRating,
  DIVISIONS,
  PLACEMENT_GAMES
};
