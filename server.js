const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// --- Fetch title from URL ---
app.get('/api/fetch-title', async (req, res) => {
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
  } catch (err) {
    res.json({ title: '', error: '無法取得標題' });
  }
});

// --- Get all articles (with search & filter) ---
app.get('/api/articles', (req, res, next) => {
  try {
    const { q, tag, importance, sort } = req.query;

    let sql = 'SELECT * FROM articles WHERE 1=1';
    const params = [];

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

    const articles = db.prepare(sql).all(params);
    res.json(articles);
  } catch (e) { next(e); }
});

// --- Add article ---
app.post('/api/articles', (req, res, next) => {
  try {
    const { url, title, tags, importance, notes } = req.body;

    if (!url || !title) {
      return res.status(400).json({ error: '網址和標題為必填' });
    }

    const result = db.prepare(`
      INSERT INTO articles (url, title, tags, importance, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run([
      url.trim(),
      title.trim(),
      (tags || '').trim(),
      Number(importance) || 1,
      (notes || '').trim(),
      new Date().toISOString(),
    ]);

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get([result.lastInsertRowid]);
    res.status(201).json(article);
  } catch (e) { next(e); }
});

// --- Update article ---
app.put('/api/articles/:id', (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, tags, importance, notes, read_at } = req.body;

    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get([Number(id)]);
    if (!article) return res.status(404).json({ error: '找不到文章' });

    db.prepare(`
      UPDATE articles
      SET title = ?, tags = ?, importance = ?, notes = ?, read_at = ?
      WHERE id = ?
    `).run([
      title ?? article.title,
      tags ?? article.tags,
      importance ?? article.importance,
      notes ?? article.notes,
      read_at !== undefined ? read_at : article.read_at,
      Number(id),
    ]);

    const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get([Number(id)]);
    res.json(updated);
  } catch (e) { next(e); }
});

// --- Delete article ---
app.delete('/api/articles/:id', (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM articles WHERE id = ?').run([Number(req.params.id)]);
    if (result.changes === 0) return res.status(404).json({ error: '找不到文章' });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// --- Labels CRUD ---
app.get('/api/labels', (req, res, next) => {
  try {
    res.json(db.prepare('SELECT * FROM labels ORDER BY name').all());
  } catch (e) { next(e); }
});

app.post('/api/labels', (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '標籤名稱不能為空' });
    const result = db.prepare('INSERT INTO labels (name) VALUES (?)').run([name.trim()]);
    res.status(201).json(db.prepare('SELECT * FROM labels WHERE id = ?').get([result.lastInsertRowid]));
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: '標籤名稱已存在' });
    next(e);
  }
});

app.delete('/api/labels/:id', (req, res, next) => {
  try {
    const result = db.prepare('DELETE FROM labels WHERE id = ?').run([Number(req.params.id)]);
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
