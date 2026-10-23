require('dotenv').config();
const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const { Pool } = require('pg');

const app    = express();
const PORT   = process.env.PORT || 3000;
const ADMIN_PW = process.env.ADMIN_PASSWORD;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS confessions (
      id           SERIAL  PRIMARY KEY,
      text         TEXT    NOT NULL,
      submitted_at INTEGER NOT NULL,
      approved     BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS emails (
      id           SERIAL  PRIMARY KEY,
      email        TEXT    UNIQUE NOT NULL,
      submitted_at INTEGER NOT NULL
    );
  `);
}

// Run once on module load — works for both local and Vercel serverless
const dbReady = initDb();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// All routes wait for DB to be ready before proceeding
app.use(async (req, res, next) => {
  try { await dbReady; next(); }
  catch (e) { console.error('DB init error:', e); res.status(503).json({ error: 'Database unavailable' }); }
});

// ── Admin auth ──────────────────────────────────────────────────────────────
// Token is derived from the password so any serverless instance can validate it
// without needing shared in-memory state.
function adminToken() {
  return crypto.createHmac('sha256', ADMIN_PW || '').update('admin-session').digest('hex');
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function adminAuth(req, res, next) {
  if (ADMIN_PW && getCookie(req, 'admin_token') === adminToken()) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Public routes ────────────────────────────────────────────────────────────
app.get('/api/whoami', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  res.json({ ip });
});

app.get('/wall', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wall.html'));
});

app.post('/api/confession', async (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text || text.length > 1000) {
    return res.status(400).json({ error: 'Invalid confession' });
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    // Global rate limit: reject if another confession came in within 5 seconds
    const { rows } = await pool.query(
      'SELECT submitted_at FROM confessions ORDER BY submitted_at DESC LIMIT 1'
    );
    if (rows.length && now - rows[0].submitted_at < 5) {
      return res.status(429).json({ error: 'Too many confessions. Please wait a moment.' });
    }
    await pool.query(
      'INSERT INTO confessions (text, submitted_at, approved) VALUES ($1, $2, FALSE)',
      [text, now]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/confessions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, text, submitted_at FROM confessions ORDER BY submitted_at DESC'
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Admin page ───────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PW || (req.body.password || '') !== ADMIN_PW) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', `admin_token=${adminToken()}; HttpOnly; Path=/; SameSite=Strict`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/admin/confessions', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, text, submitted_at, approved FROM confessions ORDER BY submitted_at DESC'
  );
  res.json(rows);
});

app.delete('/api/admin/confession/:id', adminAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM confessions WHERE id = $1', [parseInt(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.get('/api/admin/download', adminAuth, async (req, res) => {
  const confessions = await pool.query('SELECT * FROM confessions ORDER BY id');
  res.setHeader('Content-Disposition', 'attachment; filename="confessions.json"');
  res.json({ confessions: confessions.rows });
});

if (!ADMIN_PW) {
  console.error('WARNING: ADMIN_PASSWORD env var is not set.');
}

// Local dev: listen directly. Vercel imports this file and uses module.exports.
if (require.main === module) {
  dbReady
    .then(() => app.listen(PORT, () => {
      console.log(`Running on http://localhost:${PORT}`);
      console.log(`Admin panel: http://localhost:${PORT}/admin`);
    }))
    .catch(err => { console.error('DB init failed:', err); process.exit(1); });
}

module.exports = app;
