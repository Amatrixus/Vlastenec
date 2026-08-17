'use strict';

const { Pool } = require('pg');

let pool = null;
let ready = false;
let initError = null;

function databaseConfigured() {
  return !!String(process.env.DATABASE_URL || '').trim();
}

function buildPool() {
  if (!databaseConfigured()) return null;
  const sslSetting = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  const config = {
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  };
  // Ve výchozím stavu respektujeme přesně DATABASE_URL od poskytovatele.
  // Override je tu jen pro případ, že bude později potřeba vynutit/zakázat SSL.
  if (sslSetting === 'true' || sslSetting === 'require') config.ssl = { rejectUnauthorized: false };
  if (sslSetting === 'false' || sslSetting === 'disable') config.ssl = false;
  return new Pool(config);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(24) NOT NULL,
  email VARCHAR(254) NOT NULL,
  display_name VARCHAR(24) NOT NULL,
  password_hash TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq ON users ((LOWER(username)));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users ((LOWER(email)));

CREATE TABLE IF NOT EXISTS player_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp BIGINT NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  second_places INTEGER NOT NULL DEFAULT 0,
  third_places INTEGER NOT NULL DEFAULT 0,
  total_score BIGINT NOT NULL DEFAULT 0,
  best_score INTEGER NOT NULL DEFAULT 0,
  territories_captured INTEGER NOT NULL DEFAULT 0,
  questions_answered INTEGER NOT NULL DEFAULT 0,
  questions_correct INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  category_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  mode_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  achievements JSONB NOT NULL DEFAULT '{}'::jsonb,
  profile_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS profile_matches (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id VARCHAR(80) NOT NULL,
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode VARCHAR(16) NOT NULL,
  placement SMALLINT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  territories INTEGER NOT NULL DEFAULT 0,
  question_wins INTEGER NOT NULL DEFAULT 0,
  opponents JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE(user_id, event_id),
  CHECK (placement BETWEEN 1 AND 3)
);
ALTER TABLE profile_matches ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'legacy_client';
CREATE INDEX IF NOT EXISTS profile_matches_user_date_idx ON profile_matches(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS profile_matches_mode_date_idx ON profile_matches(mode, played_at DESC);

CREATE TABLE IF NOT EXISTS profile_events (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id VARCHAR(80) NOT NULL,
  event_type VARCHAR(24) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS profile_events_created_idx ON profile_events(created_at);



CREATE TABLE IF NOT EXISTS profile_question_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id VARCHAR(80) NOT NULL,
  match_id VARCHAR(80),
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode VARCHAR(16) NOT NULL,
  category VARCHAR(24),
  question_type VARCHAR(16) NOT NULL,
  success BOOLEAN NOT NULL DEFAULT FALSE,
  answered BOOLEAN NOT NULL DEFAULT TRUE,
  answer_numeric DOUBLE PRECISION,
  correct_numeric DOUBLE PRECISION,
  numeric_error_pct DOUBLE PRECISION,
  exact_hit BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(user_id, event_id),
  CHECK (question_type IN ('choice','numeric'))
);
CREATE INDEX IF NOT EXISTS profile_question_events_user_date_idx ON profile_question_events(user_id, answered_at DESC);
CREATE INDEX IF NOT EXISTS profile_question_events_mode_category_date_idx ON profile_question_events(mode, category, answered_at DESC);
CREATE INDEX IF NOT EXISTS profile_question_events_numeric_date_idx ON profile_question_events(mode, question_type, answered_at DESC);

CREATE TABLE IF NOT EXISTS normal_matches (
  match_id VARCHAR(80) PRIMARY KEY,
  room_id VARCHAR(80),
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS normal_ratings (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1000,
  rated_games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  second_places INTEGER NOT NULL DEFAULT 0,
  third_places INTEGER NOT NULL DEFAULT 0,
  highest_rating INTEGER NOT NULL DEFAULT 1000,
  last_match_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS normal_ratings_rating_idx ON normal_ratings(rating DESC, rated_games DESC);

CREATE TABLE IF NOT EXISTS normal_rating_events (
  match_id VARCHAR(80) NOT NULL REFERENCES normal_matches(match_id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  placement SMALLINT NOT NULL,
  rating_before INTEGER NOT NULL,
  rating_after INTEGER NOT NULL,
  rating_delta INTEGER NOT NULL,
  opponents JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (match_id, user_id),
  CHECK (placement BETWEEN 1 AND 3)
);
CREATE INDEX IF NOT EXISTS normal_rating_events_user_date_idx ON normal_rating_events(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS normal_rating_events_date_idx ON normal_rating_events(played_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT,
  ip_address VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS league_seasons (
  id BIGSERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'planned',
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at > starts_at),
  CHECK (status IN ('planned','active','closing','closed'))
);

CREATE TABLE IF NOT EXISTS league_players (
  season_id BIGINT NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL DEFAULT 1200,
  starting_rating INTEGER NOT NULL DEFAULT 1200,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  second_places INTEGER NOT NULL DEFAULT 0,
  third_places INTEGER NOT NULL DEFAULT 0,
  placement_games INTEGER NOT NULL DEFAULT 0,
  highest_rating INTEGER NOT NULL DEFAULT 1200,
  highest_division VARCHAR(24),
  last_match_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season_id, user_id)
);
ALTER TABLE league_players ADD COLUMN IF NOT EXISTS starting_rating INTEGER NOT NULL DEFAULT 1200;
CREATE INDEX IF NOT EXISTS league_players_rating_idx ON league_players(season_id, rating DESC);

CREATE TABLE IF NOT EXISTS league_matches (
  id UUID PRIMARY KEY,
  season_id BIGINT NOT NULL REFERENCES league_seasons(id) ON DELETE RESTRICT,
  state VARCHAR(24) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  cancelled_reason VARCHAR(80),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (state IN ('queued','ready','active','finished','cancelled'))
);
CREATE INDEX IF NOT EXISTS league_matches_season_idx ON league_matches(season_id, created_at DESC);

CREATE TABLE IF NOT EXISTS league_match_players (
  match_id UUID NOT NULL REFERENCES league_matches(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seat SMALLINT NOT NULL,
  rating_before INTEGER,
  rating_after INTEGER,
  rating_delta INTEGER,
  placement SMALLINT,
  score INTEGER,
  disconnected BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (match_id, user_id),
  UNIQUE (match_id, seat),
  CHECK (seat BETWEEN 1 AND 3),
  CHECK (placement IS NULL OR placement BETWEEN 1 AND 3)
);

CREATE TABLE IF NOT EXISTS league_rewards (
  season_id BIGINT NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_key VARCHAR(80) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season_id, user_id, reward_key)
);

INSERT INTO schema_meta(key, value)
VALUES ('schema_version', '4')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
`;

async function initDatabase() {
  if (!databaseConfigured()) {
    ready = false;
    initError = null;
    console.warn('⚠️ DATABASE_URL není nastaveno. Hra poběží, ale účty a Liga jsou vypnuté.');
    return false;
  }

  if (!pool) pool = buildPool();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(SCHEMA_SQL);
      await client.query("DELETE FROM auth_sessions WHERE expires_at <= NOW()");
      await client.query('COMMIT');
      ready = true;
      initError = null;
      console.log('✅ PostgreSQL připojeno a databázové schéma je připravené.');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    ready = false;
    initError = err;
    console.error('❌ Inicializace PostgreSQL selhala:', err.message);
    return false;
  }
}

function getStatus() {
  return {
    configured: databaseConfigured(),
    ready,
    error: initError ? initError.message : null
  };
}

async function query(text, params = []) {
  if (!pool || !ready) {
    const err = new Error('Databáze není připravená.');
    err.code = 'DB_NOT_READY';
    throw err;
  }
  return pool.query(text, params);
}

async function withTransaction(fn) {
  if (!pool || !ready) {
    const err = new Error('Databáze není připravená.');
    err.code = 'DB_NOT_READY';
    throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  initDatabase,
  getStatus,
  query,
  withTransaction
};
