const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'articles.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    tags TEXT DEFAULT '',
    importance INTEGER DEFAULT 1,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE INDEX IF NOT EXISTS idx_created_at ON articles(created_at);
  CREATE INDEX IF NOT EXISTS idx_importance ON articles(importance);
`);

module.exports = db;
