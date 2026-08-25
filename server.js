const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, 'aeroball.db'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1000,
  coins INTEGER NOT NULL DEFAULT 50,
  banned INTEGER NOT NULL DEFAULT 0,
  admin INTEGER NOT NULL DEFAULT 0,
  profile TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  username TEXT NOT NULL,
  code TEXT NOT NULL,
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(username, code),
  FOREIGN KEY(username) REFERENCES users(username)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(username) REFERENCES users(username)
);
`);

try { db.prepare("ALTER TABLE users ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'").run(); } catch {}

const INITIAL_USERS = [
  ['Artem', 'Art', 0],
  ['Vova', 'Vovik', 0],
  ['Miron', 'Miroha', 0],
  ['Sergey', 'Seryy', 0],
  ['Ilya', 'Iluha', 0],
  ['RAZRAB', 'S1GMA', 1]
];

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users(username, password_hash, admin)
  VALUES (?, ?, ?)
`);

for (const [username, password, admin] of INITIAL_USERS) {
  insertUser.run(username, hashPassword(password), admin);
}

const DEFAULT_PROFILE = {fieldEffect:'grass', hudLayout:'both', graphicsQuality:'standard', items:{skin_blue:false,skin_red:false,ball_soccer:false,ball_puck:false,ball_beach:false,trail_paddle:false,trail_ball:false}, equipped:{skin:'default',ball:'default',trail_paddle:false,trail_ball:false}, redeemedPromos:[]};
for (const [username] of INITIAL_USERS) {
  const u = db.prepare('SELECT profile FROM users WHERE username = ?').get(username);
  if (!u?.profile || u.profile === '{}') db.prepare('UPDATE users SET profile = ? WHERE username = ?').run(JSON.stringify(DEFAULT_PROFILE), username);
}

const PROMOS = {
  Get100r: 100,
  RAZRAB: 1000,
  WINNER: 500
};

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Требуется вход' });

  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.username = s.username
    WHERE s.token = ?
  `).get(token);

  if (!row) return res.status(401).json({ error: 'Сессия недействительна' });
  if (row.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });

  req.user = row;
  req.token = token;
  next();
}

function adminOnly(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ error: 'Недостаточно прав' });
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || user.password_hash !== hashPassword(password || '')) {
    return res.status(401).json({ error: 'Неверный ник или пароль' });
  }
  if (user.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, username) VALUES (?, ?)').run(token, user.username);

  res.json({
    token,
    user: {
      username: user.username,
      elo: user.elo,
      coins: user.coins,
      admin: !!user.admin,
      profile: JSON.parse(user.profile || '{}')
    }
  });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT username, elo, coins, banned, admin FROM users WHERE username = ?')
    .get(req.user.username);
  res.json({ username: u.username, elo: u.elo, coins: u.coins, admin: !!u.admin, profile: JSON.parse(u.profile || '{}') });
});

app.put('/api/profile', auth, (req, res) => {
  const profile = req.body?.profile;
  if (!profile || typeof profile !== 'object') return res.status(400).json({ error: 'Некорректный профиль' });
  // ELO/монеты остаются отдельными серверными полями; профиль содержит настройки/предметы.
  db.prepare('UPDATE users SET profile = ? WHERE username = ?').run(JSON.stringify(profile), req.user.username);
  const u = db.prepare('SELECT username, elo, coins, admin, profile FROM users WHERE username = ?').get(req.user.username);
  res.json({ username:u.username, elo:u.elo, coins:u.coins, admin:!!u.admin, profile:JSON.parse(u.profile || '{}') });
});

app.post('/api/state', auth, (req, res) => {
  const elo = Number(req.body?.elo);
  const coins = Number(req.body?.coins);
  if (!Number.isInteger(elo) || elo < 0 || !Number.isInteger(coins) || coins < 0) return res.status(400).json({error:'Некорректное состояние'});
  db.prepare('UPDATE users SET elo = ?, coins = ? WHERE username = ?').run(elo, coins, req.user.username);
  res.json({elo, coins});
});

app.get('/api/users', auth, adminOnly, (req, res) => {
  const users = db.prepare(`
    SELECT username, elo, coins, banned, admin, created_at
    FROM users ORDER BY elo DESC, username ASC
  `).all();
  res.json(users.map(u => ({ ...u, admin: !!u.admin, banned: !!u.banned })));
});

app.post('/api/promo', auth, (req, res) => {
  const code = String(req.body?.code || '').trim();
  const reward = PROMOS[code];

  if (!reward) return res.status(400).json({ error: 'Промокод не найден' });

  try {
    db.transaction(() => {
      db.prepare('INSERT INTO promo_redemptions(username, code) VALUES (?, ?)')
        .run(req.user.username, code);
      db.prepare('UPDATE users SET coins = coins + ? WHERE username = ?')
        .run(reward, req.user.username);
    })();
  } catch {
    return res.status(409).json({ error: 'Этот промокод уже активирован на аккаунте' });
  }

  const u = db.prepare('SELECT elo, coins FROM users WHERE username = ?').get(req.user.username);
  res.json({ reward, coins: u.coins, elo: u.elo });
});

app.post('/api/elo', auth, (req, res) => {
  const delta = Number(req.body?.delta);
  if (!Number.isInteger(delta) || Math.abs(delta) > 500) {
    return res.status(400).json({ error: 'Некорректное изменение ELO' });
  }
  db.prepare('UPDATE users SET elo = MAX(0, elo + ?) WHERE username = ?')
    .run(delta, req.user.username);

  const u = db.prepare('SELECT elo, coins FROM users WHERE username = ?').get(req.user.username);
  res.json(u);
});

app.post('/api/admin/coins', auth, adminOnly, (req, res) => {
  const { username } = req.body || {};
  const delta = Number(req.body?.delta);

  if (!Number.isInteger(delta) || Math.abs(delta) > 1000000) {
    return res.status(400).json({ error: 'Некорректное изменение монет' });
  }

  const target = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Аккаунт не найден' });

  db.prepare('UPDATE users SET coins = MAX(0, coins + ?) WHERE username = ?')
    .run(delta, username);

  res.json(db.prepare('SELECT username, elo, coins, banned FROM users WHERE username = ?').get(username));
});

app.post('/api/admin/ban', auth, adminOnly, (req, res) => {
  const { username, banned } = req.body || {};
  if (username === 'RAZRAB') return res.status(400).json({ error: 'RAZRAB нельзя заблокировать' });

  const target = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'Аккаунт не найден' });

  db.prepare('UPDATE users SET banned = ? WHERE username = ?').run(banned ? 1 : 0, username);

  if (banned) {
    db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
  }

  res.json({ ok: true, username, banned: !!banned });
});

app.get('/api/leaderboard', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT username, elo, coins FROM users
    WHERE banned = 0
    ORDER BY elo DESC, coins DESC
  `).all();
  res.json(rows);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AeroBall server listening on port ${PORT}`);
});
