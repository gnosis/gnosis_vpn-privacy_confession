require('dotenv').config();
const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');
const { Pool } = require('pg');

const app    = express();
const PORT   = process.env.PORT || 3000;
const ADMIN_PW = process.env.ADMIN_PASSWORD;
// 32-byte key (base64) for the waitlist contact details; without it sign-ups are refused
const WAITLIST_KEY = Buffer.from(process.env.WAITLIST_KEY || '', 'base64');
const waitlistForm = require('./public/waitlist-form.json');

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
    CREATE TABLE IF NOT EXISTS waitlist (
      id              SERIAL  PRIMARY KEY,
      answers         JSONB   NOT NULL,
      contact_channel TEXT    NOT NULL,
      contact_enc     TEXT    NOT NULL,
      submitted_at    INTEGER NOT NULL
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
  // Vercel adds these location headers; they are missing in local dev
  const city    = decodeURIComponent(req.headers['x-vercel-ip-city'] || '');
  const country = req.headers['x-vercel-ip-country'] || '';
  res.json({ ip, city, country });
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

// ── Waitlist ─────────────────────────────────────────────────────────────────
// Answer to "Where should we contact you?" and the field that holds the contact detail
const CONTACT_QUESTION = '644rl9tj66i';
const CONTACT_FIELDS = { Signal: '5rj5616rdvn', Telegram: '7nip27pk43v', 'E-Mail': '43ss8i8ulhr' };

// Checks the answers against waitlist-form.json the same way page 3 shows the form:
// only questions that are visible count, required ones must be answered.
// Returns the cleaned answers, or null if anything is missing or invalid.
function validateWaitlist(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const clean = {};
  const valuesOf = id => {
    const v = clean[id];
    return v === undefined ? [] : [].concat(v);
  };
  let valid = true;

  function visit(id) {
    const item = waitlistForm.form[id];
    if (item.type === 'md') return;
    if (item.type === 'section') {
      const shown = item.opts.when.some(group => group.every(c => valuesOf(String(c.q)).includes(c.v)));
      if (shown) item.opts.questions.forEach(visit);
      return;
    }
    const given = answers[id];
    const options = (item.opts.values || []).map(o => o.v);
    let value;
    if (item.type === 'input') {
      value = typeof given === 'string' ? given.trim() : '';
      if (value.length > 200) valid = false;
    } else if (item.type === 'radio') {
      value = options.includes(given) ? given : '';
      if (given !== undefined && !value) valid = false;
    } else {
      value = Array.isArray(given) ? [...new Set(given)] : [];
      if (given !== undefined && !Array.isArray(given)) valid = false;
      if (value.some(v => !options.includes(v)) || (item.opts.max && value.length > item.opts.max)) valid = false;
    }
    const empty = Array.isArray(value) ? !value.length : !value;
    if (empty && item.opts.required) valid = false;
    if (!empty) clean[id] = value;
  }

  waitlistForm.order.forEach(visit);
  return valid ? clean : null;
}

function encryptContact(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', WAITLIST_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

app.post('/api/waitlist', async (req, res) => {
  if (WAITLIST_KEY.length !== 32) {
    console.error('WAITLIST_KEY env var is missing or not 32 bytes.');
    return res.status(503).json({ error: 'Waitlist unavailable' });
  }
  const answers = validateWaitlist(req.body.answers);
  const channel = answers && answers[CONTACT_QUESTION];
  const contactField = CONTACT_FIELDS[channel];
  if (!contactField || !answers[contactField]) {
    return res.status(400).json({ error: 'Invalid sign-up' });
  }
  const contact = answers[contactField];
  delete answers[contactField];
  const now = Math.floor(Date.now() / 1000);
  try {
    // Global rate limit: reject if another sign-up came in within 5 seconds
    const { rows } = await pool.query(
      'SELECT submitted_at FROM waitlist ORDER BY submitted_at DESC LIMIT 1'
    );
    if (rows.length && now - rows[0].submitted_at < 5) {
      return res.status(429).json({ error: 'Too many sign-ups. Please wait a moment.' });
    }
    await pool.query(
      'INSERT INTO waitlist (answers, contact_channel, contact_enc, submitted_at) VALUES ($1, $2, $3, $4)',
      [answers, channel, encryptContact(contact), now]
    );
    res.json({ ok: true });
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

// Answerable questions in form order, with a label that makes sense on its own:
// "Please specify" / "Which one?" get the question that opened them in front.
const waitlistQuestions = [];
// Drops the "(If you're not sure, … run one of these commands …)" hint from version questions
const shortLabel = q => q.replace(/\s*\(If you.*$/, '');
(function collect(ids, openedBy) {
  ids.forEach(id => {
    const item = waitlistForm.form[id];
    if (item.type === 'section') {
      const group = item.opts.when[0];
      return collect(item.opts.questions, shortLabel(waitlistForm.form[group[group.length - 1].q].q));
    }
    if (item.type === 'md' || Object.values(CONTACT_FIELDS).includes(id)) return;
    if (waitlistQuestions.some(q => q.id === id)) return;
    const text = shortLabel(item.q);
    waitlistQuestions.push({ id, label: item.type === 'input' && openedBy ? openedBy + ' — ' + text : text });
  });
})(waitlistForm.order, null);

function decryptContact(stored) {
  try {
    const [iv, tag, enc] = stored.split('.').map(p => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', WAITLIST_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '(cannot decrypt)';
  }
}

async function loadSignups() {
  const { rows } = await pool.query(
    'SELECT id, answers, contact_channel, contact_enc, submitted_at FROM waitlist ORDER BY submitted_at DESC'
  );
  return rows.map(r => ({
    id: r.id,
    submitted_at: r.submitted_at,
    contact_channel: r.contact_channel,
    contact: decryptContact(r.contact_enc),
    answers: r.answers,
  }));
}

app.get('/api/admin/waitlist', adminAuth, async (req, res) => {
  res.json({ questions: waitlistQuestions, signups: await loadSignups() });
});

// Quoted cells; a leading = + - @ is neutralised so spreadsheets don't run it as a formula
function csvCell(value) {
  let text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

app.get('/api/admin/waitlist.csv', adminAuth, async (req, res) => {
  const signups = await loadSignups();
  const header = ['Sent (UTC)', 'Contact via', 'Contact', ...waitlistQuestions.map(q => q.label)];
  const lines = signups.map(s => [
    new Date(s.submitted_at * 1000).toISOString().slice(0, 16).replace('T', ' '),
    s.contact_channel,
    s.contact,
    ...waitlistQuestions.map(q => s.answers[q.id]),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="waitlist.csv"');
  res.send('\uFEFF' + [header, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n'));
});

app.delete('/api/admin/waitlist/:id', adminAuth, async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM waitlist WHERE id = $1', [parseInt(req.params.id)]
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
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
