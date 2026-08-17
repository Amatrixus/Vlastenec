'use strict';

const db = require('./db');
const { sessionUser } = require('./auth');

const CATEGORY_SLUGS = [
  'vedy','literatura','technologie','geografie','historie',
  'kultura','sport','osobnosti','politika'
];

const PERIODS = { '7d':7, '30d':30, '90d':90, 'all':null };
const NORMAL_INITIAL_RATING = 1000;
const NORMAL_MIN_CATEGORY_ANSWERS = 30;
const NORMAL_MIN_NUMERIC_ANSWERS = 25;

function safePeriod(raw) {
  const value = String(raw || '30d').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PERIODS,value) ? value : '30d';
}

function periodClause(period, alias, paramIndex) {
  const days = PERIODS[period];
  if (!days) return { sql:'', params:[] };
  return { sql:` AND ${alias}.played_at >= NOW() - ($${paramIndex}::int * INTERVAL '1 day')`, params:[days] };
}

function questionPeriodClause(period, alias, paramIndex) {
  const days = PERIODS[period];
  if (!days) return { sql:'', params:[] };
  return { sql:` AND ${alias}.answered_at >= NOW() - ($${paramIndex}::int * INTERVAL '1 day')`, params:[days] };
}

function winRate(wins,games) { return Number(games) ? Number(wins)/Number(games) : 0; }
function clamp(n,min,max) { return Math.max(min,Math.min(max,n)); }

async function finalizeNormalRatedMatch(matchId, players, roomId = null) {
  if (!db.getStatus().ready) return { rated:false, reason:'db_not_ready' };
  const id = String(matchId || '').trim().slice(0,80);
  const clean = (Array.isArray(players) ? players : []).map(p => ({
    userId:String(p.userId || '').trim(),
    displayName:String(p.displayName || 'Hráč').slice(0,24),
    placement:clamp(Number(p.placement)||3,1,3)
  })).filter(p => /^\d+$/.test(p.userId));
  const unique = new Set(clean.map(p=>p.userId));
  if (!id || clean.length !== 3 || unique.size !== 3) {
    return { rated:false, reason:'three_authenticated_players_required' };
  }

  return db.withTransaction(async client => {
    const inserted = await client.query(
      `INSERT INTO normal_matches(match_id,room_id) VALUES($1,$2)
       ON CONFLICT (match_id) DO NOTHING RETURNING match_id`,
      [id,String(roomId || '').slice(0,80) || null]
    );
    if (!inserted.rowCount) {
      const previous = await client.query(
        `SELECT e.user_id,e.placement,e.rating_before,e.rating_after,e.rating_delta,u.display_name
           FROM normal_rating_events e JOIN users u ON u.id=e.user_id
          WHERE e.match_id=$1 ORDER BY e.placement ASC`,[id]
      );
      return { rated:true, duplicate:true, players:previous.rows.map(r=>({
        userId:String(r.user_id),displayName:r.display_name,placement:Number(r.placement),
        ratingBefore:Number(r.rating_before),ratingAfter:Number(r.rating_after),ratingDelta:Number(r.rating_delta)
      })) };
    }

    const ids = [...unique].sort((a,b)=>Number(a)-Number(b));
    for (const userId of ids) {
      await client.query(
        `INSERT INTO normal_ratings(user_id,rating,highest_rating)
         VALUES($1,$2,$2) ON CONFLICT (user_id) DO NOTHING`,
        [userId,NORMAL_INITIAL_RATING]
      );
    }
    const locked = await client.query(
      `SELECT user_id,rating,rated_games,wins,second_places,third_places,highest_rating
         FROM normal_ratings WHERE user_id = ANY($1::bigint[])
         ORDER BY user_id ASC FOR UPDATE`,[ids]
    );
    const ratings = new Map(locked.rows.map(r=>[String(r.user_id),r]));
    const byId = new Map(clean.map(p=>[p.userId,p]));
    const changes = [];

    for (const p of clean) {
      const row = ratings.get(p.userId);
      const before = Number(row.rating || NORMAL_INITIAL_RATING);
      const opponents = clean.filter(o=>o.userId!==p.userId);
      let expectedSum = 0;
      let actualSum = 0;
      for (const o of opponents) {
        const oppRating = Number(ratings.get(o.userId)?.rating || NORMAL_INITIAL_RATING);
        expectedSum += 1 / (1 + Math.pow(10,(oppRating-before)/400));
        actualSum += p.placement < o.placement ? 1 : p.placement > o.placement ? 0 : 0.5;
      }
      const k = Number(row.rated_games || 0) < 10 ? 48 : 32;
      let delta = Math.round(k * ((actualSum - expectedSum) / Math.max(1,opponents.length)));
      if (p.placement === 1) delta = Math.max(1,delta);
      if (p.placement === 3) delta = Math.min(-1,delta);
      const after = Math.max(100, before + delta);
      changes.push({ ...p, ratingBefore:before, ratingAfter:after, ratingDelta:after-before });
    }

    for (const change of changes) {
      const old = ratings.get(change.userId);
      const games = Number(old.rated_games || 0) + 1;
      const wins = Number(old.wins || 0) + (change.placement===1?1:0);
      const seconds = Number(old.second_places || 0) + (change.placement===2?1:0);
      const thirds = Number(old.third_places || 0) + (change.placement===3?1:0);
      const highest = Math.max(Number(old.highest_rating || NORMAL_INITIAL_RATING),change.ratingAfter);
      await client.query(
        `UPDATE normal_ratings SET rating=$2,rated_games=$3,wins=$4,second_places=$5,third_places=$6,
           highest_rating=$7,last_match_at=NOW(),updated_at=NOW() WHERE user_id=$1`,
        [change.userId,change.ratingAfter,games,wins,seconds,thirds,highest]
      );
      const opponents = changes.filter(o=>o.userId!==change.userId).map(o=>({
        userId:o.userId,displayName:o.displayName,rating:o.ratingBefore
      }));
      await client.query(
        `INSERT INTO normal_rating_events(match_id,user_id,placement,rating_before,rating_after,rating_delta,opponents)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [id,change.userId,change.placement,change.ratingBefore,change.ratingAfter,change.ratingDelta,JSON.stringify(opponents)]
      );
    }
    return { rated:true, duplicate:false, players:changes };
  });
}

function publicNormalRow(row,currentUserId=null) {
  const games=Number(row.games||0),wins=Number(row.wins||0),seconds=Number(row.second_places||0),thirds=Number(row.third_places||0);
  return {
    userId:String(row.user_id),displayName:row.display_name,rank:Number(row.rank),
    rating:Number(row.rating||NORMAL_INITIAL_RATING),highestRating:Number(row.highest_rating||NORMAL_INITIAL_RATING),
    periodDelta:Number(row.period_delta||0),games,wins,secondPlaces:seconds,thirdPlaces:thirds,
    winRate:winRate(wins,games),averagePlacement:games?Number(row.avg_placement||0):null,
    isMe:currentUserId!=null && String(row.user_id)===String(currentUserId)
  };
}

async function normalRows(period) {
  const filter=periodClause(period,'e',1);
  const activeOnly=PERIODS[period] ? 'WHERE p.games > 0' : 'WHERE nr.rated_games > 0';
  const result=await db.query(
    `WITH period_stats AS (
       SELECT e.user_id,COUNT(*)::int AS games,
              COUNT(*) FILTER (WHERE e.placement=1)::int AS wins,
              COUNT(*) FILTER (WHERE e.placement=2)::int AS second_places,
              COUNT(*) FILTER (WHERE e.placement=3)::int AS third_places,
              AVG(e.placement)::float8 AS avg_placement,
              SUM(e.rating_delta)::int AS period_delta
         FROM normal_rating_events e WHERE 1=1 ${filter.sql}
        GROUP BY e.user_id
     ), base AS (
       SELECT nr.user_id,u.display_name,nr.rating,nr.highest_rating,nr.rated_games,
              COALESCE(p.games,0) AS games,COALESCE(p.wins,0) AS wins,
              COALESCE(p.second_places,0) AS second_places,COALESCE(p.third_places,0) AS third_places,
              p.avg_placement,COALESCE(p.period_delta,0) AS period_delta
         FROM normal_ratings nr JOIN users u ON u.id=nr.user_id
         LEFT JOIN period_stats p ON p.user_id=nr.user_id
         ${activeOnly}
     ), ranked AS (
       SELECT base.*,ROW_NUMBER() OVER (ORDER BY rating DESC,games DESC,wins DESC,user_id ASC) AS rank FROM base
     ) SELECT * FROM ranked ORDER BY rank ASC`,filter.params
  );
  return result.rows;
}

function wilsonLower(successes,total,z=1.96) {
  const n=Number(total)||0,s=Number(successes)||0;if(!n)return 0;
  const p=s/n,z2=z*z,den=1+z2/n,centre=p+z2/(2*n),margin=z*Math.sqrt((p*(1-p)+z2/(4*n))/n);
  return Math.max(0,(centre-margin)/den);
}

async function categoryRows(category,period,currentUserId=null) {
  const filter=questionPeriodClause(period,'q',2);
  const result=await db.query(
    `SELECT q.user_id,u.display_name,COUNT(*)::int AS played,
            COUNT(*) FILTER (WHERE q.success)::int AS successes
       FROM profile_question_events q JOIN users u ON u.id=q.user_id
      WHERE q.mode='random' AND q.category=$1 ${filter.sql}
      GROUP BY q.user_id,u.display_name`,[category,...filter.params]
  );
  const rows=result.rows.map(row=>{
    const played=Number(row.played||0),successes=Number(row.successes||0),accuracy=played?successes/played:0;
    return {userId:String(row.user_id),displayName:row.display_name,played,successes,accuracy,
      score:wilsonLower(successes,played),eligible:played>=NORMAL_MIN_CATEGORY_ANSWERS,
      isMe:currentUserId!=null&&String(row.user_id)===String(currentUserId)};
  });
  const eligible=rows.filter(r=>r.eligible).sort((a,b)=>b.score-a.score||b.accuracy-a.accuracy||b.played-a.played||a.displayName.localeCompare(b.displayName,'cs')).map((r,i)=>({...r,rank:i+1}));
  return {rows:eligible,me:rows.find(r=>r.isMe)||null,minAnswers:NORMAL_MIN_CATEGORY_ANSWERS};
}

async function numericRows(period,currentUserId=null) {
  const filter=questionPeriodClause(period,'q',1);
  const result=await db.query(
    `SELECT q.user_id,u.display_name,COUNT(*)::int AS attempts,
            COUNT(*) FILTER (WHERE q.answered)::int AS submitted,
            COUNT(*) FILTER (WHERE q.exact_hit)::int AS exact_hits,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY q.numeric_error_pct) AS median_error_pct
       FROM profile_question_events q JOIN users u ON u.id=q.user_id
      WHERE q.mode='random' AND q.question_type='numeric' AND q.numeric_error_pct IS NOT NULL ${filter.sql}
      GROUP BY q.user_id,u.display_name`,filter.params
  );
  const rows=result.rows.map(row=>{
    const attempts=Number(row.attempts||0),submitted=Number(row.submitted||0),median=Math.max(0,Number(row.median_error_pct||0));
    return {userId:String(row.user_id),displayName:row.display_name,attempts,submitted,exactHits:Number(row.exact_hits||0),
      medianErrorPct:median,accuracy:clamp(1-median/100,0,1),eligible:attempts>=NORMAL_MIN_NUMERIC_ANSWERS,
      isMe:currentUserId!=null&&String(row.user_id)===String(currentUserId)};
  });
  const eligible=rows.filter(r=>r.eligible).sort((a,b)=>a.medianErrorPct-b.medianErrorPct||b.exactHits-a.exactHits||b.attempts-a.attempts||a.displayName.localeCompare(b.displayName,'cs')).map((r,i)=>({...r,rank:i+1}));
  return {rows:eligible,me:rows.find(r=>r.isMe)||null,minAnswers:NORMAL_MIN_NUMERIC_ANSWERS};
}

async function normalRecords(period) {
  const filter=periodClause(period,'pm',1);
  const result=await db.query(
    `SELECT pm.user_id,u.display_name,COUNT(*)::int AS games,
            COUNT(*) FILTER (WHERE pm.placement=1)::int AS wins,
            SUM(pm.territories)::bigint AS territories,SUM(pm.question_wins)::bigint AS question_wins,
            MAX(pm.score)::int AS best_score
       FROM profile_matches pm JOIN users u ON u.id=pm.user_id
      WHERE pm.mode='random' AND pm.source='server' ${filter.sql}
      GROUP BY pm.user_id,u.display_name`,filter.params
  );
  const rows=result.rows.map(row=>({userId:String(row.user_id),displayName:row.display_name,games:Number(row.games||0),wins:Number(row.wins||0),
    territories:Number(row.territories||0),questionWins:Number(row.question_wins||0),bestScore:Number(row.best_score||0),winRate:winRate(row.wins,row.games)}));
  const pick=(key,predicate=()=>true)=>rows.filter(predicate).sort((a,b)=>b[key]-a[key]||b.games-a.games)[0]||null;
  return {mostWins:pick('wins'),bestWinRate:pick('winRate',r=>r.games>=5),bestScore:pick('bestScore'),mostTerritories:pick('territories'),mostQuestionWins:pick('questionWins')};
}

function mountLeaderboardRoutes(app) {
  app.get('/api/leaderboards/normal',async(req,res)=>{
    if(!db.getStatus().ready)return res.status(503).json({ok:false,message:'Databáze žebříčků není dostupná.'});
    try{const period=safePeriod(req.query.period),user=await sessionUser(req),rows=await normalRows(period),limit=clamp(Number(req.query.limit)||100,10,100);
      const mine=user?rows.find(r=>String(r.user_id)===String(user.id)):null,rank=mine?Number(mine.rank):0;
      res.json({ok:true,period,total:rows.length,rows:rows.slice(0,limit).map(r=>publicNormalRow(r,user?.id)),nearby:rank?rows.filter(r=>Math.abs(Number(r.rank)-rank)<=3).map(r=>publicNormalRow(r,user?.id)):[],me:mine?publicNormalRow(mine,user.id):null,authenticated:!!user,initialRating:NORMAL_INITIAL_RATING});
    }catch(err){console.error('leaderboards/normal:',err);res.status(500).json({ok:false,message:'Žebříček normální hry se nepodařilo načíst.'});}
  });

  app.get('/api/leaderboards/category',async(req,res)=>{
    if(!db.getStatus().ready)return res.status(503).json({ok:false,message:'Databáze žebříčků není dostupná.'});
    try{const category=String(req.query.category||'historie').toLowerCase(),period=safePeriod(req.query.period);if(!CATEGORY_SLUGS.includes(category))return res.status(400).json({ok:false,message:'Neplatná kategorie.'});
      const user=await sessionUser(req),data=await categoryRows(category,period,user?.id),limit=clamp(Number(req.query.limit)||100,10,100);
      res.json({ok:true,period,category,rows:data.rows.slice(0,limit),me:data.me,minAnswers:data.minAnswers,total:data.rows.length});
    }catch(err){console.error('leaderboards/category:',err);res.status(500).json({ok:false,message:'Žebříček kategorie se nepodařilo načíst.'});}
  });

  app.get('/api/leaderboards/numeric',async(req,res)=>{
    if(!db.getStatus().ready)return res.status(503).json({ok:false,message:'Databáze žebříčků není dostupná.'});
    try{const period=safePeriod(req.query.period),user=await sessionUser(req),data=await numericRows(period,user?.id),limit=clamp(Number(req.query.limit)||100,10,100);
      res.json({ok:true,period,rows:data.rows.slice(0,limit),me:data.me,minAnswers:data.minAnswers,total:data.rows.length});
    }catch(err){console.error('leaderboards/numeric:',err);res.status(500).json({ok:false,message:'Žebříček numerických odhadů se nepodařilo načíst.'});}
  });

  app.get('/api/leaderboards/records',async(req,res)=>{
    if(!db.getStatus().ready)return res.status(503).json({ok:false,message:'Databáze žebříčků není dostupná.'});
    try{const period=safePeriod(req.query.period),records=await normalRecords(period);res.json({ok:true,period,records});}
    catch(err){console.error('leaderboards/records:',err);res.status(500).json({ok:false,message:'Rekordy se nepodařilo načíst.'});}
  });
}

module.exports={mountLeaderboardRoutes,finalizeNormalRatedMatch,NORMAL_INITIAL_RATING};
