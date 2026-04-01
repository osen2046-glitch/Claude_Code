const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'articles.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

// Articles table (create if not exists)
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
  CREATE INDEX IF NOT EXISTS idx_created_at ON articles(created_at);
  CREATE INDEX IF NOT EXISTS idx_importance ON articles(importance);
`);

// Migrate: add user_id to articles if missing
const articleCols = db.prepare('PRAGMA table_info(articles)').all().map(c => c.name);
if (!articleCols.includes('user_id')) {
  db.exec('ALTER TABLE articles ADD COLUMN user_id INTEGER REFERENCES users(id)');
}

// Labels table: create with correct schema or migrate from legacy
const labelsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='labels'").get();
if (!labelsExists) {
  db.exec(`
    CREATE TABLE labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      UNIQUE(user_id, name)
    );
  `);
} else {
  const labelCols = db.prepare('PRAGMA table_info(labels)').all().map(c => c.name);
  if (!labelCols.includes('user_id')) {
    // Migrate: recreate with user_id support and per-user uniqueness
    db.exec(`
      ALTER TABLE labels RENAME TO labels_old;
      CREATE TABLE labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        name TEXT NOT NULL,
        UNIQUE(user_id, name)
      );
      INSERT INTO labels (id, name) SELECT id, name FROM labels_old;
      DROP TABLE labels_old;
    `);
  }
}

module.exports = db;
