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
const crypto = require("crypto");

const DATABASE_URL = process.env.DATABASE_URL || null;

function defaultUser(uid) {
  return {
    uid,
    email: null,
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

  let puzzlesTableExisted = true;

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
    // email/password_hash добавлены позже (вход по e-mail) — ADD COLUMN
    // IF NOT EXISTS безопасен и для уже существующих таблиц на Render.
    .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;`))
    .then(() => pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`))
    .then(() =>
      pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email) WHERE email IS NOT NULL;`
      )
    )
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
    // --- задачи (управляются из админ-меню) и «кто что решил» ---
    // Стартовый набор сеем только если таблицы задач ещё не было — иначе
    // удалённые админом задачи «воскресали» бы при каждом перезапуске.
    .then(() => pool.query(`SELECT to_regclass('public.puzzles') AS t`))
    .then(({ rows }) => { puzzlesTableExisted = Boolean(rows[0].t); })
    .then(() =>
      pool.query(`
        CREATE TABLE IF NOT EXISTS puzzles (
          id         TEXT PRIMARY KEY,
          tag        TEXT NOT NULL DEFAULT '',
          fen        TEXT NOT NULL,
          hint       TEXT NOT NULL DEFAULT '',
          solution   TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
      `)
    )
    .then(() =>
      pool.query(`
        CREATE TABLE IF NOT EXISTS puzzle_solves (
          uid       TEXT NOT NULL,
          puzzle_id TEXT NOT NULL,
          solved_at BIGINT NOT NULL,
          PRIMARY KEY (uid, puzzle_id)
        );
      `)
    )
    .then(async () => {
      if (puzzlesTableExisted) return;
      const seed = require("./puzzles-seed");
      const base = Date.now();
      for (let i = 0; i < seed.length; i++) {
        const p = seed[i];
        await pool.query(
          `INSERT INTO puzzles (id, tag, fen, hint, solution, created_at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO NOTHING`,
          [p.id, p.tag, p.fen, p.hint, JSON.stringify(p.solution), base + i]
        );
      }
      console.log(`✅ Загружен стартовый набор задач (${seed.length}).`);
    })
    .then(() => console.log("✅ Подключено к Postgres, таблицы готовы."))
    .catch((err) => {
      console.error("❌ Не удалось инициализировать Postgres:", err.message);
      throw err;
    });

  function rowToUser(row) {
    if (!row) return null;
    return {
      uid: row.uid,
      email: row.email,
      passwordHash: row.password_hash,
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

  async function getUserByEmail(email) {
    await ready;
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [
      String(email).toLowerCase(),
    ]);
    return rowToUser(rows[0]);
  }

  async function createUser({ email, passwordHash, name }) {
    await ready;
    const uid = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO users (uid, email, password_hash, name, rating, description, games_played, wins, losses, draws, streak)
       VALUES ($1,$2,$3,$4,1200,'',0,0,0,0,0)
       RETURNING *`,
      [uid, String(email).toLowerCase(), passwordHash, name || "Игрок"]
    );
    return rowToUser(rows[0]);
  }

  async function upsertUser(uid, patch) {
    await ready;
    const current = (await getUser(uid)) || defaultUser(String(uid));
    const next = { ...current, ...patch, uid: String(uid) };
    await pool.query(
      `INSERT INTO users (uid, name, rating, description, games_played, wins, losses, draws, streak, email, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (uid) DO UPDATE SET
         name = $2, rating = $3, description = $4, games_played = $5,
         wins = $6, losses = $7, draws = $8, streak = $9,
         email = COALESCE($10, users.email), password_hash = COALESCE($11, users.password_hash)`,
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
        next.email || null,
        next.passwordHash || null,
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

  function rowToPuzzle(row) {
    return {
      id: row.id,
      tag: row.tag,
      fen: row.fen,
      hint: row.hint,
      solution: JSON.parse(row.solution),
    };
  }

  async function listPuzzles() {
    await ready;
    const { rows } = await pool.query("SELECT * FROM puzzles ORDER BY created_at ASC, id ASC");
    return rows.map(rowToPuzzle);
  }

  async function getPuzzle(id) {
    await ready;
    const { rows } = await pool.query("SELECT * FROM puzzles WHERE id = $1", [String(id)]);
    return rows[0] ? rowToPuzzle(rows[0]) : null;
  }

  async function createPuzzle({ tag, fen, hint, solution }) {
    await ready;
    const id = "p_" + crypto.randomBytes(5).toString("hex");
    const { rows } = await pool.query(
      `INSERT INTO puzzles (id, tag, fen, hint, solution, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, tag, fen, hint, JSON.stringify(solution), Date.now()]
    );
    return rowToPuzzle(rows[0]);
  }

  async function updatePuzzle(id, { tag, fen, hint, solution }) {
    await ready;
    const { rows } = await pool.query(
      `UPDATE puzzles SET tag = $2, fen = $3, hint = $4, solution = $5 WHERE id = $1 RETURNING *`,
      [String(id), tag, fen, hint, JSON.stringify(solution)]
    );
    return rows[0] ? rowToPuzzle(rows[0]) : null;
  }

  async function deletePuzzle(id) {
    await ready;
    const { rowCount } = await pool.query("DELETE FROM puzzles WHERE id = $1", [String(id)]);
    await pool.query("DELETE FROM puzzle_solves WHERE puzzle_id = $1", [String(id)]);
    return rowCount > 0;
  }

  async function getSolvedPuzzleIds(uid) {
    await ready;
    const { rows } = await pool.query("SELECT puzzle_id FROM puzzle_solves WHERE uid = $1", [String(uid)]);
    return rows.map((r) => r.puzzle_id);
  }

  // Атомарно: true — задача засчитана впервые, false — уже была решена раньше.
  // Составной PRIMARY KEY (uid, puzzle_id) + ON CONFLICT DO NOTHING гарантируют,
  // что даже два одновременных запроса не засчитают рейтинг дважды.
  async function markPuzzleSolved(uid, puzzleId) {
    await ready;
    const { rowCount } = await pool.query(
      `INSERT INTO puzzle_solves (uid, puzzle_id, solved_at) VALUES ($1,$2,$3)
       ON CONFLICT (uid, puzzle_id) DO NOTHING`,
      [String(uid), String(puzzleId), Date.now()]
    );
    return rowCount === 1;
  }

  impl = {
    getUser, getUserByEmail, createUser, upsertUser, addGameRecord, getGames,
    listPuzzles, getPuzzle, createPuzzle, updatePuzzle, deletePuzzle, getSolvedPuzzleIds, markPuzzleSolved,
    mode: "postgres",
  };
} else {
  /* ---------------------------------------------------------
     РЕЖИМ JSON-ФАЙЛЫ (запасной, для локальной разработки)
     --------------------------------------------------------- */
  const DATA_DIR = path.join(__dirname, "data");
  const USERS_FILE = path.join(DATA_DIR, "users.json");
  const GAMES_FILE = path.join(DATA_DIR, "games.json");

  const PUZZLES_FILE = path.join(DATA_DIR, "puzzles.json");
  const SOLVES_FILE = path.join(DATA_DIR, "puzzle_solves.json");

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "{}");
  if (!fs.existsSync(GAMES_FILE)) fs.writeFileSync(GAMES_FILE, "[]");
  // Стартовые задачи сеем только при первом создании файла — иначе удалённые
  // админом задачи возвращались бы после перезапуска.
  if (!fs.existsSync(PUZZLES_FILE)) {
    fs.writeFileSync(PUZZLES_FILE, JSON.stringify(require("./puzzles-seed"), null, 2));
  }
  if (!fs.existsSync(SOLVES_FILE)) fs.writeFileSync(SOLVES_FILE, "{}");

  function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return (file === USERS_FILE || file === SOLVES_FILE) ? {} : []; }
  }
  function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  async function getUser(uid) {
    const users = readJSON(USERS_FILE);
    return users[uid];
  }
  async function getUserByEmail(email) {
    const users = readJSON(USERS_FILE);
    const target = String(email).toLowerCase();
    return Object.values(users).find((u) => (u.email || "").toLowerCase() === target) || null;
  }
  async function createUser({ email, passwordHash, name }) {
    const users = readJSON(USERS_FILE);
    const uid = crypto.randomUUID();
    const user = { ...defaultUser(uid), email: String(email).toLowerCase(), passwordHash, name: name || "Игрок" };
    users[uid] = user;
    writeJSON(USERS_FILE, users);
    return user;
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

  async function listPuzzles() {
    return readJSON(PUZZLES_FILE);
  }
  async function getPuzzle(id) {
    return readJSON(PUZZLES_FILE).find((p) => p.id === String(id)) || null;
  }
  async function createPuzzle({ tag, fen, hint, solution }) {
    const list = readJSON(PUZZLES_FILE);
    const puzzle = { id: "p_" + crypto.randomBytes(5).toString("hex"), tag, fen, hint, solution };
    list.push(puzzle);
    writeJSON(PUZZLES_FILE, list);
    return puzzle;
  }
  async function updatePuzzle(id, { tag, fen, hint, solution }) {
    const list = readJSON(PUZZLES_FILE);
    const i = list.findIndex((p) => p.id === String(id));
    if (i === -1) return null;
    list[i] = { id: list[i].id, tag, fen, hint, solution };
    writeJSON(PUZZLES_FILE, list);
    return list[i];
  }
  async function deletePuzzle(id) {
    const list = readJSON(PUZZLES_FILE);
    const next = list.filter((p) => p.id !== String(id));
    if (next.length === list.length) return false;
    writeJSON(PUZZLES_FILE, next);
    const solves = readJSON(SOLVES_FILE);
    for (const uid of Object.keys(solves)) solves[uid] = solves[uid].filter((pid) => pid !== String(id));
    writeJSON(SOLVES_FILE, solves);
    return true;
  }
  async function getSolvedPuzzleIds(uid) {
    return readJSON(SOLVES_FILE)[String(uid)] || [];
  }
  // Между чтением и записью нет await, поэтому в одном процессе Node проверка
  // «уже решено?» и отметка неделимы — двойной запрос не засчитается дважды.
  async function markPuzzleSolved(uid, puzzleId) {
    const solves = readJSON(SOLVES_FILE);
    const list = solves[String(uid)] || [];
    if (list.includes(String(puzzleId))) return false;
    list.push(String(puzzleId));
    solves[String(uid)] = list;
    writeJSON(SOLVES_FILE, solves);
    return true;
  }

  console.warn(
    "⚠️  DATABASE_URL не задан — используется JSON-хранилище в data/. " +
      "На Render (и большинстве хостингов) файловая система эфемерна: " +
      "рейтинг и аккаунты БУДУТ теряться при каждом передеплое/перезапуске. " +
      "Задайте DATABASE_URL (например, бесплатный Neon/Supabase Postgres), чтобы рейтинг сохранялся постоянно."
  );

  impl = {
    getUser, getUserByEmail, createUser, upsertUser, addGameRecord, getGames,
    listPuzzles, getPuzzle, createPuzzle, updatePuzzle, deletePuzzle, getSolvedPuzzleIds, markPuzzleSolved,
    mode: "json",
  };
}

module.exports = { ...impl, defaultUser };
