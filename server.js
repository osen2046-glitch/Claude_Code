const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Trust proxy for secure cookies behind Render / reverse proxy
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'news-collector-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: process.env.NODE_ENV === 'production',
  },
}));

app.use(express.static('public'));

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '請先登入' });
  next();
}

// --- Auth routes ---

// Register
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const { email, password, display_name } = req.body;
    if (!email || !password) return res.status(400).json({ error: '請填寫電子郵件和密碼' });
    if (password.length < 6) return res.status(400).json({ error: '密碼至少需要 6 個字元' });

    const lowerEmail = email.toLowerCase().trim();
    if (db.prepare('SELECT id FROM users WHERE email = ?').get([lowerEmail])) {
      return res.status(409).json({ error: '此電子郵件已被使用' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const name = (display_name || '').trim() || lowerEmail.split('@')[0];
    const result = db.prepare(
      'INSERT INTO users (email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)'
    ).run([lowerEmail, password_hash, name, new Date().toISOString()]);

    req.session.userId = result.lastInsertRowid;
    req.session.displayName = name;
    res.status(201).json({ id: result.lastInsertRowid, email: lowerEmail, display_name: name });
  } catch (e) { next(e); }
});

// Login
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '請填寫電子郵件和密碼' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get([email.toLowerCase().trim()]);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: '電子郵件或密碼錯誤' });
    }

    req.session.userId = user.id;
    req.session.displayName = user.display_name;
    res.json({ id: user.id, email: user.email, display_name: user.display_name });
  } catch (e) { next(e); }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Get current user
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, display_name FROM users WHERE id = ?').get([req.session.userId]);
  if (!user) { req.session.destroy(); return res.status(401).json({ error: '請先登入' }); }
  res.json(user);
});

// Update user settings
app.put('/api/auth/settings', requireAuth, async (req, res, next) => {
  try {
    const { display_name, current_password, new_password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get([req.session.userId]);
    if (!user) return res.status(404).json({ error: '找不到使用者' });

    let password_hash = user.password_hash;
    if (new_password) {
      if (!current_password) return res.status(400).json({ error: '請輸入目前密碼' });
      if (!(await bcrypt.compare(current_password, user.password_hash))) {
        return res.status(401).json({ error: '目前密碼錯誤' });
      }
      if (new_password.length < 6) return res.status(400).json({ error: '新密碼至少需要 6 個字元' });
      password_hash = await bcrypt.hash(new_password, 12);
    }

    const name = (display_name !== undefined ? display_name.trim() : '') || user.display_name;
    db.prepare('UPDATE users SET display_name = ?, password_hash = ? WHERE id = ?')
      .run([name, password_hash, user.id]);
    req.session.displayName = name;
    res.json({ id: user.id, email: user.email, display_name: name });
  } catch (e) { next(e); }
});

// --- Fetch title from URL ---
app.get('/api/fetch-title', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: '缺少 url 參數' });

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('title').text() ||
      '';

    res.json({ title: title.trim() });
  } catch {
    res.json({ title: '', error: '無法取得標題' });
  }
});

// --- Articles (all scoped by user) ---
app.get('/api/articles', requireAuth, (req, res, next) => {
  try {
    const { q, tag, importance, sort } = req.query;
    const userId = req.session.userId;

    let sql = 'SELECT * FROM articles WHERE user_id = ?';
    const params = [userId];

    if (q) {
      sql += ' AND (title LIKE ? OR url LIKE ? OR notes LIKE ? OR tags LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    if (tag) {
      sql += ' AND tags LIKE ?';
      params.push(`%${tag}%`);
    }

    if (importance) {
      sql += ' AND importance = ?';
      params.push(Number(importance));
    }

    const sortMap = {
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      importance: 'importance DESC, created_at DESC',
    };
    sql += ` ORDER BY ${sortMap[sort] || 'created_at DESC'}`;

    res.json(db.prepare(sql).all(params));
  } catch (e) { next(e); }
});

app.post('/api/articles', requireAuth, (req, res, next) => {
  try {
    const { url, title, tags, importance, notes } = req.body;
    if (!url || !title) return res.status(400).json({ error: '網址和標題為必填' });

    const result = db.prepare(`
      INSERT INTO articles (user_id, url, title, tags, importance, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run([
      req.session.userId,
      url.trim(),
      title.trim(),
      (tags || '').trim(),
      Number(importance) || 1,
      (notes || '').trim(),
      new Date().toISOString(),
    ]);

    res.status(201).json(db.prepare('SELECT * FROM articles WHERE id = ?').get([result.lastInsertRowid]));
  } catch (e) { next(e); }
});

app.put('/api/articles/:id', requireAuth, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { title, tags, importance, notes, read_at } = req.body;

    const article = db.prepare('SELECT * FROM articles WHERE id = ? AND user_id = ?').get([id, req.session.userId]);
    if (!article) return res.status(404).json({ error: '找不到文章' });

    db.prepare(`
      UPDATE articles SET title = ?, tags = ?, importance = ?, notes = ?, read_at = ? WHERE id = ?
    `).run([
      title ?? article.title,
      tags ?? article.tags,
      importance ?? article.importance,
      notes ?? article.notes,
      read_at !== undefined ? read_at : article.read_at,
      id,
    ]);

    res.json(db.prepare('SELECT * FROM articles WHERE id = ?').get([id]));
  } catch (e) { next(e); }
});

app.delete('/api/articles/:id', requireAuth, (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM articles WHERE id = ? AND user_id = ?')
      .run([Number(req.params.id), req.session.userId]);
    if (result.changes === 0) return res.status(404).json({ error: '找不到文章' });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// --- Labels (all scoped by user) ---
app.get('/api/labels', requireAuth, (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM labels WHERE user_id = ? ORDER BY name').all([req.session.userId]));
  } catch (e) { next(e); }
});

app.post('/api/labels', requireAuth, (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '標籤名稱不能為空' });
    const result = db.prepare('INSERT INTO labels (user_id, name) VALUES (?, ?)').run([req.session.userId, name.trim()]);
    res.status(201).json(db.prepare('SELECT * FROM labels WHERE id = ?').get([result.lastInsertRowid]));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '標籤名稱已存在' });
    next(e);
  }
});

app.delete('/api/labels/:id', requireAuth, (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM labels WHERE id = ? AND user_id = ?')
      .run([Number(req.params.id), req.session.userId]);
    if (result.changes === 0) return res.status(404).json({ error: '找不到標籤' });
    res.json({ success: true });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: err.message || '伺服器錯誤' });
});

app.listen(PORT, () => {
  console.log(`伺服器啟動於 http://localhost:${PORT}`);
});
