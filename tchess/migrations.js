/* ============================================================
   МИГРАЦИИ БАЗЫ ДАННЫХ (Postgres)

   Главное правило: ОБНОВЛЕНИЕ КОДА НИКОГДА НЕ ДОЛЖНО ТЕРЯТЬ ДАННЫЕ.
   Поэтому здесь:

   1. Все миграции ТОЛЬКО ДОБАВЛЯЮЩИЕ: CREATE TABLE IF NOT EXISTS,
      ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS. Ни DROP,
      ни TRUNCATE, ни DELETE, ни переименований существующих колонок.
      Старая версия кода (пока Render переключает инстансы) продолжает
      работать с той же базой — новые колонки у неё просто «не видны».

   2. Каждая миграция выполняется В ОДНОЙ ТРАНЗАКЦИИ вместе с записью
      в schema_migrations. Сбой посередине = полный откат, база остаётся
      ровно такой, какой была.

   3. Миграция, которая ЗАПИСЫВАЕТ в существующие данные (заполнение
      public_id у пользователей), перед этим делает копию затронутых
      таблиц: bak_<ГГГГММДДЧЧММ>_<таблица>. Хранятся 3 последние копии.

   4. Транзакционная advisory-блокировка: если одновременно стартуют
      два инстанса (деплой с перекрытием), миграция выполнится один раз.
      Блокировка transaction-level, поэтому работает и через pgbouncer
      (Neon «pooler»).

   Правило для разработчика: НЕ редактируйте уже выпущенные миграции —
   добавляйте новую в конец списка с новым номером.
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { seedTournaments } = require("./cup-seed");

const LOCK_KEY = 7272741; // произвольное число-идентификатор блокировки
const SNAPSHOT_KEEP = 3;
const PUBLIC_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

// Публичный ID игрока — то, что он показывает друзьям («T-CHESS-XXXXXX»).
// Сначала пробуем прежнее отображаемое значение (последние 6 символов uid) —
// у существующих игроков ID не меняется. При совпадении — случайный.
function makePublicId(uid, taken) {
  const legacy = String(uid).replace(/-/g, "").slice(-6).toUpperCase();
  if (legacy.length === 6 && !taken.has(legacy)) return legacy;
  for (let i = 0; i < 200; i++) {
    let id = "";
    for (let k = 0; k < 6; k++) id += PUBLIC_ID_ALPHABET[crypto.randomInt(PUBLIC_ID_ALPHABET.length)];
    if (!taken.has(id)) return id;
  }
  throw new Error("Не удалось сгенерировать public_id");
}

const SNAPSHOT_TABLES = new Set(["users", "games", "puzzles", "puzzle_solves"]);

async function tableExists(c, name) {
  const { rows } = await c.query(`SELECT to_regclass($1) AS t`, [`public.${name}`]);
  return Boolean(rows[0].t);
}

// Копия таблиц перед миграцией, которая меняет в них данные.
async function snapshot(c, tables, log) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  for (const t of tables) {
    if (!SNAPSHOT_TABLES.has(t)) throw new Error(`snapshot: недопустимая таблица ${t}`);
    if (!(await tableExists(c, t))) continue;
    await c.query(`CREATE TABLE IF NOT EXISTS bak_${ts}_${t} AS TABLE ${t}`);
    log(`💾 Снимок перед миграцией: bak_${ts}_${t}`);
  }
  // Удаляем только СВОИ старые копии (имена строго bak_<12 цифр>_<таблица>).
  const { rows } = await c.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name ~ '^bak_[0-9]{12}_(users|games|puzzles|puzzle_solves)$'`
  );
  const stamps = [...new Set(rows.map((r) => r.table_name.slice(4, 16)))].sort().reverse();
  for (const old of stamps.slice(SNAPSHOT_KEEP)) {
    for (const r of rows.filter((x) => x.table_name.slice(4, 16) === old)) {
      await c.query(`DROP TABLE IF EXISTS "${r.table_name}"`);
    }
  }
}

/* ------------------------------------------------------------
   СПИСОК МИГРАЦИЙ. Только добавляйте в конец.
   touches — таблицы, ДАННЫЕ в которых миграция меняет (для снимка).
   ------------------------------------------------------------ */
const MIGRATIONS = [
  {
    id: 1,
    name: "baseline: users, games, puzzles, puzzle_solves",
    // Это ровно то, что раньше выполнялось при каждом старте. Все операторы
    // идемпотентны, поэтому на уже работающей базе миграция ничего не меняет —
    // она просто фиксируется как выполненная.
    async up(c, log, ctx) {
      await c.query(`
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
        )`);
      await c.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
      await c.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
      await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email) WHERE email IS NOT NULL`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS games (
          id            SERIAL PRIMARY KEY,
          uid           TEXT NOT NULL,
          opponent_name TEXT,
          result        TEXT,
          rating_delta  INTEGER,
          played_at     BIGINT
        )`);
      await c.query(`CREATE INDEX IF NOT EXISTS games_uid_idx ON games(uid)`);

      // Стартовый набор задач сеем только если таблицы задач ещё НЕ БЫЛО —
      // иначе удалённые админом задачи «воскресали» бы.
      const puzzlesExisted = await tableExists(c, "puzzles");
      await c.query(`
        CREATE TABLE IF NOT EXISTS puzzles (
          id         TEXT PRIMARY KEY,
          tag        TEXT NOT NULL DEFAULT '',
          fen        TEXT NOT NULL,
          hint       TEXT NOT NULL DEFAULT '',
          solution   TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS puzzle_solves (
          uid       TEXT NOT NULL,
          puzzle_id TEXT NOT NULL,
          solved_at BIGINT NOT NULL,
          PRIMARY KEY (uid, puzzle_id)
        )`);
      if (!puzzlesExisted) {
        const seed = require("./puzzles-seed");
        const base = Date.now();
        for (let i = 0; i < seed.length; i++) {
          const p = seed[i];
          await c.query(
            `INSERT INTO puzzles (id, tag, fen, hint, solution, created_at) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (id) DO NOTHING`,
            [p.id, p.tag, p.fen, p.hint, JSON.stringify(p.solution), base + i]
          );
        }
        log(`✅ Загружен стартовый набор задач (${seed.length}).`);
      }
    },
  },

  {
    id: 2,
    name: "users.public_id (публичный ID для друзей и профилей)",
    touches: ["users"],
    async up(c, log) {
      await c.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id TEXT`);
      const taken = new Set(
        (await c.query(`SELECT public_id FROM users WHERE public_id IS NOT NULL`)).rows.map((r) => r.public_id)
      );
      const { rows } = await c.query(`SELECT uid FROM users WHERE public_id IS NULL ORDER BY uid`);
      const BATCH = 1000;
      for (let i = 0; i < rows.length; i += BATCH) {
        const uids = [], pids = [];
        for (const { uid } of rows.slice(i, i + BATCH)) {
          const pid = makePublicId(uid, taken);
          taken.add(pid);
          uids.push(uid);
          pids.push(pid);
        }
        await c.query(
          `UPDATE users u SET public_id = v.pid
           FROM (SELECT unnest($1::text[]) AS uid, unnest($2::text[]) AS pid) v
           WHERE u.uid = v.uid AND u.public_id IS NULL`,
          [uids, pids]
        );
      }
      await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_idx ON users(public_id) WHERE public_id IS NOT NULL`);
      await c.query(`CREATE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name) text_pattern_ops)`);
      log(`✅ public_id заполнен у ${rows.length} игроков.`);
    },
  },

  {
    id: 3,
    name: "games: режим, контроль времени, турнир",
    async up(c) {
      await c.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS mode TEXT`);
      await c.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS time_control TEXT`);
      await c.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS tournament_id TEXT`);
    },
  },

  {
    id: 4,
    name: "друзья: friendships, friend_requests",
    async up(c) {
      await c.query(`
        CREATE TABLE IF NOT EXISTS friendships (
          user_a     TEXT NOT NULL,
          user_b     TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (user_a, user_b),
          CHECK (user_a < user_b)
        )`);
      await c.query(`CREATE INDEX IF NOT EXISTS friendships_b_idx ON friendships(user_b)`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS friend_requests (
          from_uid   TEXT NOT NULL,
          to_uid     TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (from_uid, to_uid)
        )`);
      await c.query(`CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests(to_uid)`);
    },
  },

  {
    id: 5,
    name: "рейтинги по режимам и достижения",
    async up(c) {
      await c.query(`
        CREATE TABLE IF NOT EXISTS mode_ratings (
          uid    TEXT NOT NULL,
          mode   TEXT NOT NULL,
          rating INTEGER NOT NULL,
          games  INTEGER NOT NULL DEFAULT 0,
          wins   INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,
          draws  INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (uid, mode)
        )`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS user_achievements (
          uid       TEXT NOT NULL,
          code      TEXT NOT NULL,
          earned_at BIGINT NOT NULL,
          PRIMARY KEY (uid, code)
        )`);
    },
  },

  {
    id: 6,
    name: "турниры: tournaments, tournament_players, tournament_games",
    async up(c) {
      await c.query(`
        CREATE TABLE IF NOT EXISTS tournaments (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          subtitle     TEXT NOT NULL DEFAULT '',
          description  TEXT NOT NULL DEFAULT '',
          stage        TEXT NOT NULL DEFAULT 'single',
          status       TEXT NOT NULL DEFAULT 'draft',
          starts_at    BIGINT NOT NULL,
          duration_min INTEGER NOT NULL DEFAULT 60,
          tc           TEXT NOT NULL DEFAULT 'blitz_5_0',
          max_players  INTEGER NOT NULL DEFAULT 500,
          parent_id    TEXT,
          qualify_top  INTEGER NOT NULL DEFAULT 16,
          created_at   BIGINT NOT NULL,
          finished_at  BIGINT
        )`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS tournament_players (
          tournament_id TEXT NOT NULL,
          uid           TEXT NOT NULL,
          joined_at     BIGINT NOT NULL,
          score         INTEGER NOT NULL DEFAULT 0,
          games         INTEGER NOT NULL DEFAULT 0,
          wins          INTEGER NOT NULL DEFAULT 0,
          draws         INTEGER NOT NULL DEFAULT 0,
          losses        INTEGER NOT NULL DEFAULT 0,
          streak        INTEGER NOT NULL DEFAULT 0,
          perf          INTEGER NOT NULL DEFAULT 0,
          active        BOOLEAN NOT NULL DEFAULT TRUE,
          place         INTEGER,
          last_opp      TEXT,
          PRIMARY KEY (tournament_id, uid)
        )`);
      await c.query(`CREATE INDEX IF NOT EXISTS tournament_players_uid_idx ON tournament_players(uid)`);
      await c.query(`
        CREATE TABLE IF NOT EXISTS tournament_games (
          id            SERIAL PRIMARY KEY,
          tournament_id TEXT NOT NULL,
          white_uid     TEXT NOT NULL,
          black_uid     TEXT NOT NULL,
          result        TEXT NOT NULL,
          plies         INTEGER NOT NULL DEFAULT 0,
          finished_at   BIGINT NOT NULL
        )`);
      await c.query(`CREATE INDEX IF NOT EXISTS tournament_games_t_idx ON tournament_games(tournament_id)`);
    },
  },

  {
    id: 7,
    name: "Shahmatista Unicum Cup 2026: черновики этапов",
    async up(c, log) {
      for (const t of seedTournaments()) {
        await c.query(
          `INSERT INTO tournaments
             (id, title, subtitle, description, stage, status, starts_at, duration_min, tc, max_players, parent_id, qualify_top, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO NOTHING`,
          [t.id, t.title, t.subtitle, t.description, t.stage, t.status, t.startsAt, t.durationMin, t.tc, t.maxPlayers, t.parentId, t.qualifyTop, Date.now()]
        );
      }
      log("🏆 Кубок Unicum 2026 добавлен как черновик (откройте регистрацию в Админ-меню).");
    },
  },
];

async function ensureMigrationsTable(c) {
  const sql = `CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at BIGINT NOT NULL
  )`;
  try {
    await c.query(sql);
  } catch (err) {
    // Два инстанса одновременно создают таблицу — один может получить
    // конфликт имён в каталоге; повторная попытка безопасна.
    await c.query(sql);
  }
}

async function runMigrations(pool, { log = console.log } = {}) {
  const c = await pool.connect();
  try {
    await ensureMigrationsTable(c);
    for (const m of MIGRATIONS) {
      await c.query("BEGIN");
      try {
        await c.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
        const done = await c.query("SELECT 1 FROM schema_migrations WHERE id = $1", [m.id]);
        if (done.rowCount > 0) { await c.query("COMMIT"); continue; }

        if (m.touches && m.touches.length) await snapshot(c, m.touches, log);
        await m.up(c, log, {});
        await c.query("INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1,$2,$3)", [m.id, m.name, Date.now()]);
        await c.query("COMMIT");
        log(`✅ Миграция ${m.id}: ${m.name}`);
      } catch (err) {
        try { await c.query("ROLLBACK"); } catch {}
        err.message = `Миграция ${m.id} («${m.name}») не применена, изменения откачены: ${err.message}`;
        throw err;
      }
    }
  } finally {
    c.release();
  }
}

module.exports = { runMigrations, MIGRATIONS, makePublicId };
