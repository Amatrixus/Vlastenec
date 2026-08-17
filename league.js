'use strict';

const crypto = require('crypto');
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
    const latest = latestQ.rows[0] || null;

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
      placementGames = PLACEMENT_GAMES;
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

async function recentOpponentIds(seasonId, userId, matchLimit = 5) {
  const result = await db.query(
    `WITH mine AS (
       SELECT lm.id, lm.finished_at
         FROM league_matches lm
         JOIN league_match_players me ON me.match_id=lm.id AND me.user_id=$2
        WHERE lm.season_id=$1 AND lm.state='finished'
        ORDER BY lm.finished_at DESC NULLS LAST
        LIMIT $3
     )
     SELECT DISTINCT other.user_id
       FROM mine
       JOIN league_match_players other ON other.match_id=mine.id
      WHERE other.user_id<>$2`,
    [seasonId, userId, Math.max(1, Math.min(20, Number(matchLimit) || 5))]
  );
  return new Set(result.rows.map(row => String(row.user_id)));
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

async function leagueEntryForSocketRequest(req) {
  if (!db.getStatus().ready) return null;
  const user = await sessionUser(req, { touch: false });
  if (!user) return null;
  const season = await ensureActiveSeason();
  const player = await ensureLeaguePlayer(season, user);
  const recentOpponents = await recentOpponentIds(season.id, user.id, 5);
  return {
    user,
    season,
    player,
    recentOpponents,
    rating: Number(player.rating || 1200),
    displayName: user.displayName || user.username || 'Hráč'
  };
}

async function createReadyMatch(entries) {
  if (!Array.isArray(entries) || entries.length !== 3) throw new Error('Ligový zápas vyžaduje tři hráče.');
  const seasonId = String(entries[0].season.id);
  if (!entries.every(e => String(e.season.id) === seasonId)) throw new Error('Hráči nejsou ve stejné sezóně.');
  const matchId = crypto.randomUUID();
  await db.withTransaction(async client => {
    await client.query(
      `INSERT INTO league_matches(id,season_id,state,metadata)
       VALUES($1,$2,'ready',$3::jsonb)`,
      [matchId, seasonId, JSON.stringify({ source:'matchmaking', readyCreatedAt:new Date().toISOString() })]
    );
    for (let i = 0; i < entries.length; i++) {
      await client.query(
        `INSERT INTO league_match_players(match_id,user_id,seat,rating_before)
         VALUES($1,$2,$3,$4)`,
        [matchId, entries[i].user.id, i + 1, Number(entries[i].rating || 1200)]
      );
    }
  });
  return matchId;
}

async function cancelLeagueMatch(matchId, reason, metadata = {}) {
  if (!matchId || !db.getStatus().ready) return;
  await db.query(
    `UPDATE league_matches
        SET state='cancelled', finished_at=COALESCE(finished_at,NOW()), cancelled_reason=$2,
            metadata=COALESCE(metadata,'{}'::jsonb) || $3::jsonb
      WHERE id=$1 AND state IN ('queued','ready','active')`,
    [matchId, String(reason || 'cancelled').slice(0,80), JSON.stringify(metadata || {})]
  );
}

async function activateLeagueMatch(matchId) {
  const q = await db.query(
    `UPDATE league_matches SET state='active', started_at=COALESCE(started_at,NOW())
      WHERE id=$1 AND state='ready' RETURNING *`,
    [matchId]
  );
  return q.rows[0] || null;
}

async function activeLeagueMatchForUser(userId) {
  const q = await db.query(
    `SELECT lm.id,lm.state,lm.created_at,lm.started_at
       FROM league_matches lm
       JOIN league_match_players lmp ON lmp.match_id=lm.id
      WHERE lmp.user_id=$1 AND lm.state IN ('ready','active')
      ORDER BY lm.created_at DESC
      LIMIT 1`,
    [userId]
  );
  return q.rows[0] || null;
}

async function leagueMatchForUser(matchId, userId) {
  const q = await db.query(
    `SELECT lm.*, lmp.seat, lmp.user_id, u.display_name, lmp.rating_before
       FROM league_matches lm
       JOIN league_match_players lmp ON lmp.match_id=lm.id
       JOIN users u ON u.id=lmp.user_id
      WHERE lm.id=$1 AND lmp.user_id=$2
      LIMIT 1`,
    [matchId, userId]
  );
  return q.rows[0] || null;
}

async function leagueMatchPlayers(matchId) {
  const q = await db.query(
    `SELECT lmp.user_id,lmp.seat,lmp.rating_before,u.display_name
       FROM league_match_players lmp
       JOIN users u ON u.id=lmp.user_id
      WHERE lmp.match_id=$1
      ORDER BY lmp.seat`,
    [matchId]
  );
  return q.rows;
}

function kFactor(games) {
  const n = Number(games || 0);
  if (n < 10) return 64;
  if (n >= 50) return 26;
  return 32;
}

function expectedScore(myRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (Number(opponentRating) - Number(myRating)) / 400));
}

async function finalizeLeagueMatch(matchId, seatScores, options = {}) {
  if (!db.getStatus().ready) throw new Error('Databáze není připravená.');
  return db.withTransaction(async client => {
    const matchQ = await client.query('SELECT * FROM league_matches WHERE id=$1 FOR UPDATE', [matchId]);
    const match = matchQ.rows[0];
    if (!match) throw new Error('Ligový zápas neexistuje.');

    if (match.state === 'finished' && match.processed_at) {
      const existing = await client.query(
        `SELECT lmp.user_id,lmp.seat,lmp.placement,lmp.score,lmp.rating_before,lmp.rating_after,lmp.rating_delta,u.display_name,
                lp.placement_games AS placement_games_after
           FROM league_match_players lmp
           JOIN league_matches lm ON lm.id=lmp.match_id
           JOIN league_players lp ON lp.season_id=lm.season_id AND lp.user_id=lmp.user_id
           JOIN users u ON u.id=lmp.user_id
          WHERE lmp.match_id=$1 ORDER BY lmp.placement,lmp.seat`,
        [matchId]
      );
      return { matchId, players: existing.rows.map(publicLeagueResultRow), alreadyProcessed:true };
    }
    if (match.state === 'cancelled') return null;

    const playersQ = await client.query(
      `SELECT lmp.user_id,lmp.seat,lmp.rating_before,
              lp.rating,lp.games,lp.placement_games,lp.highest_rating,lp.highest_division,
              u.display_name
         FROM league_match_players lmp
         JOIN league_players lp ON lp.season_id=$2 AND lp.user_id=lmp.user_id
         JOIN users u ON u.id=lmp.user_id
        WHERE lmp.match_id=$1
        ORDER BY lmp.seat
        FOR UPDATE OF lp,lmp`,
      [matchId, match.season_id]
    );
    const players = playersQ.rows;
    if (players.length !== 3) throw new Error('Ligový zápas nemá tři hráče.');

    const forcedLastSeat = Number(options.forcedLastSeat || 0) || null;
    const ordered = players
      .map(p => ({ ...p, score:Number(seatScores?.[p.seat] || 0) }))
      .sort((a,b) => {
        if (forcedLastSeat && Number(a.seat) === forcedLastSeat) return 1;
        if (forcedLastSeat && Number(b.seat) === forcedLastSeat) return -1;
        return b.score - a.score || Number(a.seat) - Number(b.seat);
      });
    ordered.forEach((p,i) => { p.placement = i + 1; });

    const computed = ordered.map(p => {
      const opponents = ordered.filter(o => String(o.user_id) !== String(p.user_id));
      let actual = 0;
      let expected = 0;
      for (const opp of opponents) {
        actual += p.placement < opp.placement ? 1 : p.placement > opp.placement ? 0 : 0.5;
        expected += expectedScore(p.rating, opp.rating);
      }
      actual /= opponents.length;
      expected /= opponents.length;
      let delta = Math.round(kFactor(p.games) * (actual - expected));
      if (p.placement === 1 && delta <= 0) delta = 1;
      if (p.placement === 3 && delta >= 0) delta = -1;
      if (forcedLastSeat && Number(p.seat) === forcedLastSeat && delta > -1) delta = -1;
      const ratingAfter = Math.max(100, Number(p.rating) + delta);
      return { ...p, delta, ratingAfter };
    });

    for (const p of computed) {
      const newPlacementGames = Math.min(PLACEMENT_GAMES, Number(p.placement_games || 0) + 1);
      p.placementGamesAfter = newPlacementGames;
      const newHighestRating = Math.max(Number(p.highest_rating || p.rating), p.ratingAfter);
      const highestDivision = divisionForRating(newHighestRating).name;
      await client.query(
        `UPDATE league_match_players
            SET placement=$3,score=$4,rating_after=$5,rating_delta=$6,disconnected=$7
          WHERE match_id=$1 AND user_id=$2`,
        [matchId,p.user_id,p.placement,p.score,p.ratingAfter,p.delta,forcedLastSeat === Number(p.seat)]
      );
      await client.query(
        `UPDATE league_players
            SET rating=$3,
                games=games+1,
                wins=wins+CASE WHEN $4=1 THEN 1 ELSE 0 END,
                second_places=second_places+CASE WHEN $4=2 THEN 1 ELSE 0 END,
                third_places=third_places+CASE WHEN $4=3 THEN 1 ELSE 0 END,
                placement_games=$5,
                highest_rating=$6,
                highest_division=$7,
                last_match_at=NOW(),updated_at=NOW()
          WHERE season_id=$1 AND user_id=$2`,
        [match.season_id,p.user_id,p.ratingAfter,p.placement,newPlacementGames,newHighestRating,highestDivision]
      );
    }

    await client.query(
      `UPDATE league_matches
          SET state='finished',finished_at=NOW(),processed_at=NOW(),
              metadata=COALESCE(metadata,'{}'::jsonb) || $2::jsonb
        WHERE id=$1`,
      [matchId, JSON.stringify({ completedBy:'game-server', forcedLastSeat:forcedLastSeat || null })]
    );

    const resultPlayers = computed
      .sort((a,b) => a.placement - b.placement)
      .map(p => publicLeagueResultRow({
        user_id:p.user_id, seat:p.seat, placement:p.placement, score:p.score,
        rating_before:p.rating, rating_after:p.ratingAfter, rating_delta:p.delta,
        display_name:p.display_name, placement_games_after:p.placementGamesAfter
      }));
    return { matchId, players:resultPlayers, alreadyProcessed:false };
  });
}

function publicLeagueResultRow(row) {
  return {
    userId:String(row.user_id),
    seat:Number(row.seat),
    displayName:row.display_name,
    placement:Number(row.placement),
    score:Number(row.score || 0),
    ratingBefore:Number(row.rating_before || 1200),
    ratingAfter:Number(row.rating_after || row.rating_before || 1200),
    ratingDelta:Number(row.rating_delta || 0),
    placementGamesAfter:Number(row.placement_games_after || 0),
    ratingVisible:Number(row.placement_games_after || 0) >= PLACEMENT_GAMES,
    division:{ ...divisionForRating(row.rating_after || row.rating_before || 1200) }
  };
}

async function recoverInterruptedLeagueMatches() {
  if (!db.getStatus().ready) return 0;
  const q = await db.query(
    `UPDATE league_matches
        SET state='cancelled',finished_at=COALESCE(finished_at,NOW()),cancelled_reason='server_restart',
            metadata=COALESCE(metadata,'{}'::jsonb) || '{"recoveredOnBoot":true}'::jsonb
      WHERE state IN ('queued','ready','active')
      RETURNING id`
  );
  if (q.rowCount) console.log(`🛡️ Liga: po restartu bezpečně zrušeno ${q.rowCount} nedokončených zápasů bez změny ratingu.`);
  return q.rowCount;
}

function mountLeagueRoutes(app) {
  app.get('/api/league/overview', async (req, res) => {
    if (!db.getStatus().ready) return res.status(503).json({ ok:false, message:'Ligová databáze není dostupná.' });
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
        nearby = rank != null
          ? rows.filter(row => Math.abs(Number(row.rank) - rank) <= 3).map(row => publicRankRow(row, user.id))
          : top;
        matches = (await recentMatches(season.id, user.id)).map(match => ({ ...match, ratingVisible:!!me.ranked }));
        profile = await profileSummary(user.id);
      }

      res.json({
        ok:true,
        authenticated:!!user,
        user:user ? { id:String(user.id), displayName:user.displayName || user.username } : null,
        season:seasonRow(season),
        me,
        profile,
        rankedCount,
        leaderboard:{ nearby, top },
        recentMatches:matches,
        divisions:DIVISIONS.map(d => ({ ...d })),
        rules:{ placementGames:PLACEMENT_GAMES, seasonWeeks:SEASON_WEEKS }
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
  ensureLeaguePlayer,
  divisionForRating,
  leaguePlayerRow,
  leagueEntryForSocketRequest,
  createReadyMatch,
  cancelLeagueMatch,
  activateLeagueMatch,
  activeLeagueMatchForUser,
  leagueMatchForUser,
  leagueMatchPlayers,
  finalizeLeagueMatch,
  recoverInterruptedLeagueMatches,
  DIVISIONS,
  PLACEMENT_GAMES
};
