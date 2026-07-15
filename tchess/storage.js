/* ============================================================
   ХРАНИЛИЩЕ ДАННЫХ (рейтинг, история партий)

   Два режима, переключаются автоматически по переменной DATABASE_URL:

   1. DATABASE_URL задан  → Postgres (например, бесплатный Neon/Supabase).
      Данные переживают передеплой и "засыпание" на Render Free — это
      постоянная внешняя база, а не файл на диске сервиса.

   2. DATABASE_URL не задан → JSON-файлы в data/ (как раньше). Удобно
      для быстрого локального теста, но на Render Free эти файлы
      стираются при каждом передеплое/долгом простое — файловая
      система бесплатного тарифа эфемерная.
   ============================================================ */

const path = require("path");
const fs = require("fs");

const DATABASE_URL = process.env.DATABASE_URL || null;

function defaultUser(uid) {
  return {
    uid,
    name: "Игрок",
    rating: 1200,
    desc: "",
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    streak: 0,
  };
}

let impl;

if (DATABASE_URL) {
  /* ---------------------------------------------------------
     РЕЖИМ POSTGRES
     --------------------------------------------------------- */
  const { Pool } = require("pg");

  // Neon/Supabase (и большинство бесплатных Postgres-хостингов) требуют
  // SSL; rejectUnauthorized: false нужен, т.к. у них самоподписанный
  // цепочечный сертификат, который node иначе не примет.
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const ready = pool
    .query(`
      CREATE TABLE IF NOT EXISTS users (
        uid          TEXT PRIMARY KEY,
        name         TEXT NOT NULL DEFAULT 'Игрок',
        rating       INTEGER NOT NULL DEFAULT 1200,
        description  TEXT NOT NULL DEFAULT '',
        games_played INTEGER NOT NULL DEFAULT 0,
        wins         INTEGER NOT NULL DEFAULT 0,
        losses       INTEGER NOT NULL DEFAULT 0,
        draws        INTEGER NOT NULL DEFAULT 0,
        streak       INTEGER NOT NULL DEFAULT 0
      );
    `)
    .then(() =>
      pool.query(`
        CREATE TABLE IF NOT EXISTS games (
          id            SERIAL PRIMARY KEY,
          uid           TEXT NOT NULL,
          opponent_name TEXT,
          result        TEXT,
          rating_delta  INTEGER,
          played_at     BIGINT
        );
      `)
    )
    .then(() => pool.query(`CREATE INDEX IF NOT EXISTS games_uid_idx ON games(uid);`))
    .then(() => console.log("✅ Подключено к Postgres, таблицы готовы."))
    .catch((err) => {
      console.error("❌ Не удалось инициализировать Postgres:", err.message);
      throw err;
    });

  function rowToUser(row) {
    if (!row) return null;
    return {
      uid: row.uid,
      name: row.name,
      rating: row.rating,
      desc: row.description,
      gamesPlayed: row.games_played,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      streak: row.streak,
    };
  }

  async function getUser(uid) {
    await ready;
    const { rows } = await pool.query("SELECT * FROM users WHERE uid = $1", [String(uid)]);
    return rowToUser(rows[0]);
  }

  async function upsertUser(uid, patch) {
    await ready;
    const current = (await getUser(uid)) || defaultUser(String(uid));
    const next = { ...current, ...patch, uid: String(uid) };
    await pool.query(
      `INSERT INTO users (uid, name, rating, description, games_played, wins, losses, draws, streak)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (uid) DO UPDATE SET
         name = $2, rating = $3, description = $4, games_played = $5,
         wins = $6, losses = $7, draws = $8, streak = $9`,
      [
        next.uid,
        next.name,
        next.rating,
        next.desc,
        next.gamesPlayed,
        next.wins,
        next.losses,
        next.draws,
        next.streak,
      ]
    );
    return next;
  }

  async function addGameRecord(uid, record) {
    await ready;
    await pool.query(
      `INSERT INTO games (uid, opponent_name, result, rating_delta, played_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [String(uid), record.opponentName, record.result, record.ratingDelta, Date.now()]
    );
  }

  async function getGames(uid, limit = 50) {
    await ready;
    const { rows } = await pool.query(
      `SELECT uid, opponent_name AS "opponentName", result, rating_delta AS "ratingDelta", played_at AS date
       FROM games WHERE uid = $1 ORDER BY played_at DESC LIMIT $2`,
      [String(uid), limit]
    );
    return rows;
  }

  impl = { getUser, upsertUser, addGameRecord, getGames, mode: "postgres" };
} else {
  /* ---------------------------------------------------------
     РЕЖИМ JSON-ФАЙЛЫ (запасной, для локальной разработки)
     --------------------------------------------------------- */
  const DATA_DIR = path.join(__dirname, "data");
  const USERS_FILE = path.join(DATA_DIR, "users.json");
  const GAMES_FILE = path.join(DATA_DIR, "games.json");

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
  if (!fs.existsSync(GAMES_FILE)) fs.writeFileSync(GAMES_FILE, "[]");

  function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return file === USERS_FILE ? {} : []; }
  }
  function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  async function getUser(uid) {
    const users = readJSON(USERS_FILE);
    return users[uid];
  }
  async function upsertUser(uid, patch) {
    const users = readJSON(USERS_FILE);
    users[uid] = { ...(users[uid] || defaultUser(uid)), ...patch };
    writeJSON(USERS_FILE, users);
    return users[uid];
  }
  async function addGameRecord(uid, record) {
    const games = readJSON(GAMES_FILE);
    games.unshift({ uid, ...record, date: Date.now() });
    writeJSON(GAMES_FILE, games);
  }
  async function getGames(uid, limit = 50) {
    const games = readJSON(GAMES_FILE).filter((g) => String(g.uid) === String(uid));
    return games.slice(0, limit);
  }

  console.log("ℹ️  DATABASE_URL не задан — используется JSON-хранилище в data/ (не переживает передеплой на Render).");

  impl = { getUser, upsertUser, addGameRecord, getGames, mode: "json" };
}

module.exports = { ...impl, defaultUser };
