const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TECH_EMAILS = (process.env.TECH_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
const STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];

const db = new Database(process.env.DB_FILE || 'helpdesk.db');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','technician'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'Medium',
  status TEXT NOT NULL DEFAULT 'Open',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
`);

const app = express();
app.use(express.json());
app.use(express.static('public'));

const sign = (id) => jwt.sign({ id }, SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  try {
    const { id } = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
    const u = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
    if (!u) throw new Error();
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in again.' }); }
}
const techOnly = (req, res, next) =>
  req.user.role === 'technician' ? next() : res.status(403).json({ error: 'Technicians only.' });

// A ticket is visible to its creator and to technicians.
function getTicket(req, res) {
  const t = db.prepare(`SELECT t.*, u.email AS requester, a.email AS assignee FROM tickets t
    JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to WHERE t.id = ?`).get(req.params.id);
  if (!t || (req.user.role !== 'technician' && t.user_id !== req.user.id)) {
    res.status(404).json({ error: 'Ticket not found.' }); return null;
  }
  return t;
}

app.post('/api/signup', (req, res) => {
  const { email, password } = req.body;
  if (!email?.includes('@') || (password || '').length < 8)
    return res.status(400).json({ error: 'Use a valid email and a password of 8+ characters.' });
  const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const role = first || TECH_EMAILS.includes(email.toLowerCase()) ? 'technician' : 'user';
  try {
    const info = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)')
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10), role);
    res.json({ token: sign(info.lastInsertRowid) });
  } catch { res.status(409).json({ error: 'That email already has an account.' }); }
});

app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get((req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password_hash))
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json({ token: sign(u.id) });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.get('/api/technicians', auth, techOnly, (req, res) =>
  res.json(db.prepare("SELECT id, email FROM users WHERE role = 'technician'").all()));

app.get('/api/tickets', auth, (req, res) => {
  const where = [], args = [];
  if (req.user.role !== 'technician') { where.push('t.user_id = ?'); args.push(req.user.id); }
  if (STATUSES.includes(req.query.status)) { where.push('t.status = ?'); args.push(req.query.status); }
  const sql = `SELECT t.*, u.email AS requester, a.email AS assignee FROM tickets t
    JOIN users u ON u.id = t.user_id LEFT JOIN users a ON a.id = t.assigned_to
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE t.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t.created_at DESC`;
  res.json(db.prepare(sql).all(...args));
});

app.post('/api/tickets', auth, (req, res) => {
  const { title, description, priority = 'Medium' } = req.body;
  if (!title?.trim() || !description?.trim()) return res.status(400).json({ error: 'Title and description are required.' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });
  const info = db.prepare('INSERT INTO tickets (user_id, title, description, priority) VALUES (?, ?, ?, ?)')
    .run(req.user.id, title.trim(), description.trim(), priority);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/tickets/:id', auth, (req, res) => {
  const t = getTicket(req, res); if (!t) return;
  t.comments = db.prepare(`SELECT c.id, c.body, c.created_at, u.email, u.role FROM comments c
    JOIN users u ON u.id = c.user_id WHERE c.ticket_id = ? ORDER BY c.id`).all(t.id);
  res.json(t);
});

app.put('/api/tickets/:id', auth, (req, res) => {
  const t = getTicket(req, res); if (!t) return;
  const { status, priority, assigned_to } = req.body;
  if (req.user.role === 'technician') {
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority.' });
    if (assigned_to && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'technician'").get(assigned_to))
      return res.status(400).json({ error: 'Assignee must be a technician.' });
    db.prepare(`UPDATE tickets SET status = ?, priority = ?, assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(status || t.status, priority || t.priority, assigned_to === undefined ? t.assigned_to : assigned_to || null, t.id);
  } else {
    if (status !== 'Closed') return res.status(403).json({ error: 'You can only close your own tickets.' });
    db.prepare("UPDATE tickets SET status = 'Closed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(t.id);
  }
  res.json({ ok: true });
});

app.post('/api/tickets/:id/comments', auth, (req, res) => {
  const t = getTicket(req, res); if (!t) return;
  if (!req.body.body?.trim()) return res.status(400).json({ error: 'Write a comment first.' });
  db.prepare('INSERT INTO comments (ticket_id, user_id, body) VALUES (?, ?, ?)').run(t.id, req.user.id, req.body.body.trim());
  db.prepare('UPDATE tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(t.id);
  res.status(201).json({ ok: true });
});

app.get('/api/stats', auth, techOnly, (req, res) => {
  const group = (col, list) => {
    const out = Object.fromEntries(list.map((k) => [k, 0]));
    db.prepare(`SELECT ${col} k, COUNT(*) c FROM tickets GROUP BY ${col}`).all().forEach((r) => (out[r.k] = r.c));
    return out;
  };
  const unassigned = db.prepare("SELECT COUNT(*) c FROM tickets WHERE assigned_to IS NULL AND status IN ('Open','In Progress')").get().c;
  const avg = db.prepare(`SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) h FROM tickets WHERE status IN ('Resolved','Closed')`).get().h;
  res.json({ byStatus: group('status', STATUSES), byPriority: group('priority', PRIORITIES), unassigned, avgResolutionHours: avg ? Math.round(avg * 10) / 10 : null });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Help desk running at http://localhost:${port}`));
