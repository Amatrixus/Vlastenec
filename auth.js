'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');

const scryptAsync = promisify(crypto.scrypt);
const SESSION_COOKIE = 'vlastenec_session';
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const attempts = new Map();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function normalizeUsername(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function validUsername(value) {
  return /^[\p{L}\p{N}_-]{3,24}$/u.test(value);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    username: row.username,
    displayName: row.display_name ?? row.displayName ?? row.username,
    email: row.email,
    createdAt: row.created_at ?? row.createdAt ?? null,
    lastLoginAt: row.last_login_at ?? row.lastLoginAt ?? null
  };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const derived = Buffer.from(await scryptAsync(String(password), salt, expected.length));
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  for (const chunk of header.split(';')) {
    const i = chunk.indexOf('=');
    if (i < 0) continue;
    const key = chunk.slice(0, i).trim();
    const value = chunk.slice(i + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || req.socket?.remoteAddress || '').slice(0, 64);
}

function cookieSecure(req) {
  if (String(process.env.COOKIE_SECURE || '').toLowerCase() === 'false') return false;
  return process.env.NODE_ENV === 'production' || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
}

function setSessionCookie(req, res, rawToken) {
  const secure = cookieSecure(req) ? '; Secure' : '';
  const maxAge = Math.floor(SESSION_MS / 1000);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(req, res) {
  const secure = cookieSecure(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return origin === `${proto}://${host}`;
}

function rateLimit(req) {
  const key = requestIp(req) || 'unknown';
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || now - current.startedAt > LOGIN_WINDOW_MS) {
    attempts.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > LOGIN_MAX_ATTEMPTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of attempts) {
    if (now - value.startedAt > LOGIN_WINDOW_MS) attempts.delete(key);
  }
}, LOGIN_WINDOW_MS).unref?.();

async function createSession(client, req, userId) {
  const rawToken = newSessionToken();
  const tokenHash = hashToken(rawToken);
  const expires = new Date(Date.now() + SESSION_MS);
  await client.query(
    `INSERT INTO auth_sessions(token_hash, user_id, expires_at, user_agent, ip_address)
     VALUES($1,$2,$3,$4,$5)`,
    [tokenHash, userId, expires, String(req.headers['user-agent'] || '').slice(0, 500), requestIp(req)]
  );
  return rawToken;
}

async function sessionUser(req, { touch = true } = {}) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const tokenHash = hashToken(raw);
  const result = await db.query(
    `SELECT u.id, u.username, u.email, u.display_name, u.created_at, u.last_login_at,
            s.last_seen_at, s.expires_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
        AND u.status = 'active'
      LIMIT 1`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (touch) {
    db.query('UPDATE auth_sessions SET last_seen_at = NOW() WHERE token_hash = $1', [tokenHash]).catch(() => {});
  }
  return { ...publicUser(row), sessionTokenHash: tokenHash };
}

function dbUnavailable(res) {
  const status = db.getStatus();
  res.status(503).json({
    ok: false,
    code: 'DATABASE_UNAVAILABLE',
    message: status.configured
      ? 'Databáze účtů je dočasně nedostupná.'
      : 'Databáze účtů zatím není nakonfigurovaná.'
  });
}

function mountAuthRoutes(app) {
  app.get('/api/auth/status', (req, res) => {
    const status = db.getStatus();
    res.json({ ok: true, database: { configured: status.configured, ready: status.ready } });
  });

  app.get('/api/auth/me', async (req, res) => {
    if (!db.getStatus().ready) return dbUnavailable(res);
    try {
      const user = await sessionUser(req);
      res.json({ ok: true, authenticated: !!user, user: user ? publicUser(user) : null });
    } catch (err) {
      console.error('auth/me:', err);
      res.status(500).json({ ok: false, message: 'Nepodařilo se načíst přihlášení.' });
    }
  });

  app.post('/api/auth/register', async (req, res) => {
    if (!db.getStatus().ready) return dbUnavailable(res);
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, message: 'Neplatný původ požadavku.' });
    if (rateLimit(req)) return res.status(429).json({ ok: false, message: 'Příliš mnoho pokusů. Zkus to za chvíli.' });

    const username = normalizeUsername(req.body?.username);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');

    if (!validUsername(username)) {
      return res.status(400).json({ ok: false, field: 'username', message: 'Jméno musí mít 3–24 znaků a smí obsahovat písmena, čísla, _ nebo -.' });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ ok: false, field: 'email', message: 'Zadej platnou e-mailovou adresu.' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ ok: false, field: 'password', message: 'Heslo musí mít alespoň 8 znaků.' });
    }

    try {
      const passwordHash = await hashPassword(password);
      const result = await db.withTransaction(async client => {
        const created = await client.query(
          `INSERT INTO users(username, email, display_name, password_hash, last_login_at)
           VALUES($1,$2,$1,$3,NOW())
           RETURNING id, username, email, display_name, created_at, last_login_at`,
          [username, email, passwordHash]
        );
        const user = created.rows[0];
        await client.query('INSERT INTO player_profiles(user_id) VALUES($1)', [user.id]);
        const rawToken = await createSession(client, req, user.id);
        return { user, rawToken };
      });
      setSessionCookie(req, res, result.rawToken);
      res.status(201).json({ ok: true, user: publicUser(result.user) });
    } catch (err) {
      if (err?.code === '23505') {
        const detail = String(err.detail || '').toLowerCase();
        const message = detail.includes('email') ? 'Tento e-mail už používá jiný účet.' : 'Toto uživatelské jméno už je obsazené.';
        return res.status(409).json({ ok: false, message });
      }
      console.error('auth/register:', err);
      res.status(500).json({ ok: false, message: 'Účet se nepodařilo vytvořit.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!db.getStatus().ready) return dbUnavailable(res);
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, message: 'Neplatný původ požadavku.' });
    if (rateLimit(req)) return res.status(429).json({ ok: false, message: 'Příliš mnoho pokusů. Zkus to za chvíli.' });

    const login = String(req.body?.login || '').trim().slice(0, 254);
    const password = String(req.body?.password || '');
    if (!login || !password) return res.status(400).json({ ok: false, message: 'Vyplň jméno/e-mail i heslo.' });

    try {
      const found = await db.query(
        `SELECT id, username, email, display_name, password_hash, status, created_at, last_login_at
           FROM users
          WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
          LIMIT 1`,
        [login]
      );
      const row = found.rows[0];
      const valid = row && row.status === 'active' && await verifyPassword(password, row.password_hash);
      if (!valid) return res.status(401).json({ ok: false, message: 'Nesprávné jméno/e-mail nebo heslo.' });

      const result = await db.withTransaction(async client => {
        await client.query('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [row.id]);
        await client.query('DELETE FROM auth_sessions WHERE user_id = $1 AND expires_at <= NOW()', [row.id]);
        const rawToken = await createSession(client, req, row.id);
        const refreshed = await client.query(
          'SELECT id, username, email, display_name, created_at, last_login_at FROM users WHERE id = $1',
          [row.id]
        );
        return { rawToken, user: refreshed.rows[0] };
      });
      setSessionCookie(req, res, result.rawToken);
      res.json({ ok: true, user: publicUser(result.user) });
    } catch (err) {
      console.error('auth/login:', err);
      res.status(500).json({ ok: false, message: 'Přihlášení se nepodařilo.' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, message: 'Neplatný původ požadavku.' });
    const raw = parseCookies(req)[SESSION_COOKIE];
    clearSessionCookie(req, res);
    if (raw && db.getStatus().ready) {
      try { await db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(raw)]); }
      catch (err) { console.warn('auth/logout cleanup:', err.message); }
    }
    res.json({ ok: true });
  });
}

module.exports = {
  mountAuthRoutes,
  sessionUser,
  publicUser
};
