/* ============================================================
   ХРАНИЛИЩЕ ДАННЫХ

   Два режима, переключаются автоматически по переменной DATABASE_URL:

   1. DATABASE_URL задан  → Postgres (Neon/Supabase). Постоянная внешняя
      база: переживает передеплой и «засыпание» на Render Free.
      Схема меняется ТОЛЬКО через migrations.js (добавляющие миграции
      в транзакциях, со снимком перед изменением данных).

   2. DATABASE_URL не задан → JSON-файлы в data/ (локальная разработка).
      На Render файловая система эфемерна — поэтому на хостинге такой
      режим ЗАПРЕЩЁН: сервер откажется стартовать, а не «молча» начнёт
      с пустой базы (см. защиту ниже).
   ============================================================ */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { makePublicId } = require("./migrations");

const DATABASE_URL = process.env.DATABASE_URL || null;

/* ------------------------------------------------------------
   ЗАЩИТА ОТ ПОТЕРИ ДАННЫХ ПРИ ДЕПЛОЕ.
   Если на хостинге потерялась переменная DATABASE_URL (опечатка,
   «Clear environment», новый сервис), раньше сервер молча переходил
   на пустые JSON-файлы: пользователи «пропадали», регистрировались
   заново, а настоящая база оставалась нетронутой, но невидимой.
   Теперь на хостинге без базы сервер НЕ СТАРТУЕТ — Render оставит
   предыдущую рабочую версию. Осознанно разрешить можно только
   переменной ALLOW_EPHEMERAL_STORAGE=1.
   ------------------------------------------------------------ */
const ON_HOSTING =
  process.env.NODE_ENV === "production" ||
  process.env.RENDER === "true" ||
  Boolean(process.env.RENDER_EXTERNAL_URL);
if (!DATABASE_URL && ON_HOSTING && process.env.ALLOW_EPHEMERAL_STORAGE !== "1") {
  console.error(
    "\n❌ ОСТАНОВКА: DATABASE_URL не задан, а сервер запущен на хостинге.\n" +
      "   Без базы все аккаунты, рейтинги и задачи потеряются при следующем перезапуске.\n" +
      "   Проверьте переменную DATABASE_URL в Environment (Render → ваш сервис → Environment).\n" +
      "   Если вы ОСОЗНАННО хотите временное JSON-хранилище — задайте ALLOW_EPHEMERAL_STORAGE=1.\n"
  );
  process.exit(1);
}

const LEGACY_RATING = 1200;

function defaultUser(uid) {
  return {
    uid,
    publicId: null,
    email: null,
    name: "Игрок",
    rating: LEGACY_RATING,
    desc: "",
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    streak: 0,
  };
}

// Из «T-CHESS-ab12cd», «ab12cd» → «AB12CD».
function normPublicId(s) {
  return String(s || "").trim().toUpperCase().replace(/^T-?CHESS-?/, "");
}

const pairKey = (a, b) => (String(a) < String(b) ? [String(a), String(b)] : [String(b), String(a)]);

let impl;

if (DATABASE_URL) {
  /* =========================================================
     РЕЖИМ POSTGRES
     ========================================================= */
  const pg = require("pg");
  const { Pool } = pg;
  const { runMigrations } = require("./migrations");

  // BIGINT (метки времени, счётчики) приходит из pg строкой — превращаем в число.
  // Значения у нас всегда < 2^53, потери точности нет.
  pg.types.setTypeParser(20, (v) => Number(v));

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 8,
    idleTimeoutMillis: 30 * 1000,
    // Neon «просыпается» после простоя несколько секунд — даём время.
    connectionTimeoutMillis: 25 * 1000,
  });
  pool.on("error", (err) => console.error("⚠️ Postgres (пул):", err.message));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function init() {
    let lastErr;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await runMigrations(pool, { log: (m) => console.log(m) });
        return;
      } catch (err) {
        lastErr = err;
        console.error(`❌ Инициализация базы (попытка ${attempt}/6): ${err.message}`);
        // Ошибка самой миграции повтором не лечится — не долбим базу.
        if (/^Миграция \d+/.test(err.message)) break;
        await sleep(attempt * 2000);
      }
    }
    throw lastErr;
  }

  const ready = init().then(() => console.log("✅ Подключено к Postgres, схема актуальна."));
  ready.catch((err) => {
    // Лучше упасть при деплое (Render оставит прошлую версию), чем работать
    // с недоинициализированной базой.
    console.error("❌ Не удалось подготовить базу. Данные не тронуты (миграции откатываются целиком):", err.message);
    process.exit(1);
  });

  const q = async (text, params) => { await ready; return pool.query(text, params); };

  function rowToUser(row) {
    if (!row) return null;
    return {
      uid: row.uid,
      publicId: row.public_id || null,
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

  // Игрок, созданный старой версией кода во время деплоя, может быть без
  // public_id — достраиваем «на лету».
  async function assignPublicId(uid) {
    const taken = new Set();
    for (let i = 0; i < 10; i++) {
      const pid = makePublicId(uid, taken);
      try {
        const { rows } = await q(
          `UPDATE users SET public_id = $2 WHERE uid = $1 AND public_id IS NULL RETURNING public_id`,
          [String(uid), pid]
        );
        if (rows[0]) return rows[0].public_id;
        const cur = await q(`SELECT public_id FROM users WHERE uid = $1`, [String(uid)]);
        return cur.rows[0] ? cur.rows[0].public_id : null;
      } catch (err) {
        if (err.code === "23505") { taken.add(pid); continue; }
        throw err;
      }
    }
    return null;
  }

  async function withPublicId(user) {
    if (user && !user.publicId) user.publicId = await assignPublicId(user.uid);
    return user;
  }

  async function getUser(uid) {
    const { rows } = await q("SELECT * FROM users WHERE uid = $1", [String(uid)]);
    return withPublicId(rowToUser(rows[0]));
  }

  async function getUserByEmail(email) {
    const { rows } = await q("SELECT * FROM users WHERE email = $1", [String(email).toLowerCase()]);
    return withPublicId(rowToUser(rows[0]));
  }

  async function getUserByPublicId(pid) {
    const { rows } = await q("SELECT * FROM users WHERE public_id = $1", [normPublicId(pid)]);
    return rowToUser(rows[0]);
  }

  async function getUsersByUids(uids) {
    const list = [...new Set((uids || []).map(String))];
    if (!list.length) return [];
    const { rows } = await q("SELECT * FROM users WHERE uid = ANY($1::text[])", [list]);
    return rows.map(rowToUser);
  }

  async function searchUsers(query, limit = 20, excludeUid = null) {
    const text = String(query || "").trim().toLowerCase();
    if (text.length < 2) return [];
    const like = "%" + text.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const { rows } = await q(
      `SELECT * FROM users
       WHERE (lower(name) LIKE $1 OR public_id = $2) AND uid <> $3
       ORDER BY (public_id = $2) DESC, rating DESC, name ASC
       LIMIT $4`,
      [like, normPublicId(text), String(excludeUid || ""), limit]
    );
    return rows.map(rowToUser);
  }

  async function createUser({ email, passwordHash, name }) {
    const uid = crypto.randomUUID();
    const taken = new Set();
    for (let i = 0; i < 10; i++) {
      const pid = makePublicId(uid, taken);
      try {
        const { rows } = await q(
          `INSERT INTO users (uid, email, password_hash, name, rating, description, games_played, wins, losses, draws, streak, public_id)
           VALUES ($1,$2,$3,$4,1200,'',0,0,0,0,0,$5)
           RETURNING *`,
          [uid, String(email).toLowerCase(), passwordHash, name || "Игрок", pid]
        );
        return rowToUser(rows[0]);
      } catch (err) {
        if (err.code === "23505" && /public_id/.test(err.constraint || "")) { taken.add(pid); continue; }
        throw err;
      }
    }
    throw new Error("не удалось выдать public_id");
  }

  async function upsertUser(uid, patch) {
    const current = (await getUser(uid)) || defaultUser(String(uid));
    const next = { ...current, ...patch, uid: String(uid) };
    await q(
      `INSERT INTO users (uid, name, rating, description, games_played, wins, losses, draws, streak, email, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (uid) DO UPDATE SET
         name = $2, rating = $3, description = $4, games_played = $5,
         wins = $6, losses = $7, draws = $8, streak = $9,
         email = COALESCE($10, users.email), password_hash = COALESCE($11, users.password_hash)`,
      [next.uid, next.name, next.rating, next.desc, next.gamesPlayed, next.wins, next.losses, next.draws, next.streak, next.email || null, next.passwordHash || null]
    );
    return next;
  }

  // АТОМАРНОЕ обновление в самой базе (а не «прочитал → посчитал → записал»):
  // две партии, закончившиеся одновременно, больше не затирают друг другу рейтинг.
  async function applyResult(uid, { ratingDelta, result }) {
    const { rows } = await q(
      `UPDATE users SET
         rating = rating + $2::int,
         games_played = games_played + 1,
         wins = wins + $3::int,
         losses = losses + $4::int,
         draws = draws + $5::int,
         streak = CASE WHEN $3::int = 1 THEN streak + 1 ELSE 0 END
       WHERE uid = $1
       RETURNING *`,
      [String(uid), ratingDelta, result === "win" ? 1 : 0, result === "loss" ? 1 : 0, result === "draw" ? 1 : 0]
    );
    if (rows[0]) return withPublicId(rowToUser(rows[0]));
    const base = defaultUser(String(uid));
    return upsertUser(uid, {
      rating: base.rating + ratingDelta, gamesPlayed: 1,
      wins: result === "win" ? 1 : 0, losses: result === "loss" ? 1 : 0, draws: result === "draw" ? 1 : 0,
      streak: result === "win" ? 1 : 0,
    });
  }

  async function addRating(uid, delta) {
    const { rows } = await q(`UPDATE users SET rating = rating + $2::int WHERE uid = $1 RETURNING *`, [String(uid), delta]);
    if (rows[0]) return withPublicId(rowToUser(rows[0]));
    return upsertUser(uid, { rating: defaultUser(String(uid)).rating + delta });
  }

  async function addGameRecord(uid, record) {
    await q(
      `INSERT INTO games (uid, opponent_name, result, rating_delta, played_at, mode, time_control, tournament_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [String(uid), record.opponentName, record.result, record.ratingDelta, Date.now(),
       record.mode || null, record.timeControl || null, record.tournamentId || null]
    );
  }

  async function getGames(uid, limit = 50) {
    const { rows } = await q(
      `SELECT uid, opponent_name AS "opponentName", result, rating_delta AS "ratingDelta", played_at AS date,
              mode, time_control AS "timeControl", tournament_id AS "tournamentId"
       FROM games WHERE uid = $1 ORDER BY played_at DESC LIMIT $2`,
      [String(uid), limit]
    );
    return rows;
  }

  /* ---------- рейтинги по режимам ---------- */
  async function getModeRatings(uid) {
    const { rows } = await q(`SELECT * FROM mode_ratings WHERE uid = $1`, [String(uid)]);
    const out = {};
    for (const r of rows) out[r.mode] = { rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws };
    return out;
  }

  async function applyModeResult(uid, mode, { ratingDelta, result, seedRating }) {
    const w = result === "win" ? 1 : 0, l = result === "loss" ? 1 : 0, d = result === "draw" ? 1 : 0;
    const { rows } = await q(
      `INSERT INTO mode_ratings (uid, mode, rating, games, wins, losses, draws)
       VALUES ($1, $2, $3::int + $4::int, 1, $5::int, $6::int, $7::int)
       ON CONFLICT (uid, mode) DO UPDATE SET
         rating = mode_ratings.rating + $4::int,
         games  = mode_ratings.games + 1,
         wins   = mode_ratings.wins + $5::int,
         losses = mode_ratings.losses + $6::int,
         draws  = mode_ratings.draws + $7::int
       RETURNING *`,
      [String(uid), mode, seedRating, ratingDelta, w, l, d]
    );
    const r = rows[0];
    return { rating: r.rating, games: r.games, wins: r.wins, losses: r.losses, draws: r.draws };
  }

  /* ---------- задачи ---------- */
  function rowToPuzzle(row) {
    return { id: row.id, tag: row.tag, fen: row.fen, hint: row.hint, solution: JSON.parse(row.solution) };
  }
  async function listPuzzles() {
    const { rows } = await q("SELECT * FROM puzzles ORDER BY created_at ASC, id ASC");
    return rows.map(rowToPuzzle);
  }
  async function getPuzzle(id) {
    const { rows } = await q("SELECT * FROM puzzles WHERE id = $1", [String(id)]);
    return rows[0] ? rowToPuzzle(rows[0]) : null;
  }
  async function createPuzzle({ tag, fen, hint, solution }) {
    const id = "p_" + crypto.randomBytes(5).toString("hex");
    const { rows } = await q(
      `INSERT INTO puzzles (id, tag, fen, hint, solution, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, tag, fen, hint, JSON.stringify(solution), Date.now()]
    );
    return rowToPuzzle(rows[0]);
  }
  async function updatePuzzle(id, { tag, fen, hint, solution }) {
    const { rows } = await q(
      `UPDATE puzzles SET tag = $2, fen = $3, hint = $4, solution = $5 WHERE id = $1 RETURNING *`,
      [String(id), tag, fen, hint, JSON.stringify(solution)]
    );
    return rows[0] ? rowToPuzzle(rows[0]) : null;
  }
  async function deletePuzzle(id) {
    const { rowCount } = await q("DELETE FROM puzzles WHERE id = $1", [String(id)]);
    await q("DELETE FROM puzzle_solves WHERE puzzle_id = $1", [String(id)]);
    return rowCount > 0;
  }
  async function getSolvedPuzzleIds(uid) {
    const { rows } = await q("SELECT puzzle_id FROM puzzle_solves WHERE uid = $1", [String(uid)]);
    return rows.map((r) => r.puzzle_id);
  }
  async function countSolvedPuzzles(uid) {
    const { rows } = await q("SELECT COUNT(*)::int AS n FROM puzzle_solves WHERE uid = $1", [String(uid)]);
    return rows[0].n;
  }
  // true — засчитано впервые. PRIMARY KEY (uid, puzzle_id) + ON CONFLICT DO NOTHING
  // не дают засчитать рейтинг дважды даже при одновременных запросах.
  async function markPuzzleSolved(uid, puzzleId) {
    const { rowCount } = await q(
      `INSERT INTO puzzle_solves (uid, puzzle_id, solved_at) VALUES ($1,$2,$3) ON CONFLICT (uid, puzzle_id) DO NOTHING`,
      [String(uid), String(puzzleId), Date.now()]
    );
    return rowCount === 1;
  }

  /* ---------- друзья ---------- */
  async function addFriendship(a, b) {
    const [x, y] = pairKey(a, b);
    const { rowCount } = await q(
      `INSERT INTO friendships (user_a, user_b, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [x, y, Date.now()]
    );
    return rowCount === 1;
  }
  async function removeFriendship(a, b) {
    const [x, y] = pairKey(a, b);
    const { rowCount } = await q(`DELETE FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
    return rowCount > 0;
  }
  async function areFriends(a, b) {
    const [x, y] = pairKey(a, b);
    const { rowCount } = await q(`SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2`, [x, y]);
    return rowCount > 0;
  }
  async function listFriendUids(uid) {
    const { rows } = await q(
      `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS uid, created_at AS "createdAt"
       FROM friendships WHERE user_a = $1 OR user_b = $1 ORDER BY created_at DESC`,
      [String(uid)]
    );
    return rows;
  }
  async function countFriends(uid) {
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM friendships WHERE user_a = $1 OR user_b = $1`, [String(uid)]);
    return rows[0].n;
  }
  async function createFriendRequest(from, to) {
    const { rowCount } = await q(
      `INSERT INTO friend_requests (from_uid, to_uid, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [String(from), String(to), Date.now()]
    );
    return rowCount === 1;
  }
  async function hasFriendRequest(from, to) {
    const { rowCount } = await q(`SELECT 1 FROM friend_requests WHERE from_uid = $1 AND to_uid = $2`, [String(from), String(to)]);
    return rowCount > 0;
  }
  async function deleteFriendRequest(from, to) {
    const { rowCount } = await q(`DELETE FROM friend_requests WHERE from_uid = $1 AND to_uid = $2`, [String(from), String(to)]);
    return rowCount > 0;
  }
  async function listIncomingRequests(uid) {
    const { rows } = await q(`SELECT from_uid AS uid, created_at AS "createdAt" FROM friend_requests WHERE to_uid = $1 ORDER BY created_at DESC`, [String(uid)]);
    return rows;
  }
  async function listOutgoingRequests(uid) {
    const { rows } = await q(`SELECT to_uid AS uid, created_at AS "createdAt" FROM friend_requests WHERE from_uid = $1 ORDER BY created_at DESC`, [String(uid)]);
    return rows;
  }

  /* ---------- достижения ---------- */
  async function getAchievements(uid) {
    const { rows } = await q(`SELECT code, earned_at AS "earnedAt" FROM user_achievements WHERE uid = $1 ORDER BY earned_at ASC`, [String(uid)]);
    return rows;
  }
  // Возвращает коды, выданные ВПЕРВЫЕ (уже имевшиеся не повторяются).
  async function grantAchievements(uid, codes) {
    if (!codes || !codes.length) return [];
    const { rows } = await q(
      `INSERT INTO user_achievements (uid, code, earned_at)
       SELECT $1, c, $3 FROM unnest($2::text[]) AS c
       ON CONFLICT DO NOTHING RETURNING code`,
      [String(uid), codes, Date.now()]
    );
    return rows.map((r) => r.code);
  }

  /* ---------- турниры ---------- */
  function rowToTournament(r) {
    if (!r) return null;
    return {
      id: r.id, title: r.title, subtitle: r.subtitle, description: r.description,
      stage: r.stage, status: r.status, startsAt: Number(r.starts_at), durationMin: r.duration_min,
      tc: r.tc, maxPlayers: r.max_players, parentId: r.parent_id, qualifyTop: r.qualify_top,
      createdAt: Number(r.created_at), finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    };
  }
  function rowToTPlayer(r) {
    return {
      tournamentId: r.tournament_id, uid: r.uid, joinedAt: Number(r.joined_at), score: r.score, games: r.games,
      wins: r.wins, draws: r.draws, losses: r.losses, streak: r.streak, perf: r.perf,
      active: r.active, place: r.place, lastOpp: r.last_opp,
    };
  }
  const T_FIELDS = {
    title: "title", subtitle: "subtitle", description: "description", stage: "stage", status: "status",
    startsAt: "starts_at", durationMin: "duration_min", tc: "tc", maxPlayers: "max_players",
    parentId: "parent_id", qualifyTop: "qualify_top", finishedAt: "finished_at",
  };

  async function createTournament(t) {
    const id = t.id || "t_" + crypto.randomBytes(5).toString("hex");
    const { rows } = await q(
      `INSERT INTO tournaments (id, title, subtitle, description, stage, status, starts_at, duration_min, tc, max_players, parent_id, qualify_top, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, t.title, t.subtitle || "", t.description || "", t.stage || "single", t.status || "draft", t.startsAt,
       t.durationMin, t.tc, t.maxPlayers || 500, t.parentId || null, t.qualifyTop || 16, Date.now()]
    );
    return rowToTournament(rows[0]);
  }
  async function getTournament(id) {
    const { rows } = await q(`SELECT * FROM tournaments WHERE id = $1`, [String(id)]);
    return rowToTournament(rows[0]);
  }
  async function listTournaments(statuses) {
    const { rows } = statuses && statuses.length
      ? await q(`SELECT * FROM tournaments WHERE status = ANY($1::text[]) ORDER BY starts_at ASC`, [statuses])
      : await q(`SELECT * FROM tournaments ORDER BY starts_at ASC`);
    return rows.map(rowToTournament);
  }
  async function updateTournament(id, patch) {
    const sets = [], vals = [String(id)];
    for (const [k, col] of Object.entries(T_FIELDS)) {
      if (patch[k] !== undefined) { vals.push(patch[k]); sets.push(`${col} = $${vals.length}`); }
    }
    if (!sets.length) return getTournament(id);
    const { rows } = await q(`UPDATE tournaments SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals);
    return rowToTournament(rows[0]);
  }
  async function listTournamentPlayers(tid) {
    const { rows } = await q(`SELECT * FROM tournament_players WHERE tournament_id = $1`, [String(tid)]);
    return rows.map(rowToTPlayer);
  }
  async function getTournamentPlayer(tid, uid) {
    const { rows } = await q(`SELECT * FROM tournament_players WHERE tournament_id = $1 AND uid = $2`, [String(tid), String(uid)]);
    return rows[0] ? rowToTPlayer(rows[0]) : null;
  }
  async function countTournamentPlayers(tid) {
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM tournament_players WHERE tournament_id = $1`, [String(tid)]);
    return rows[0].n;
  }
  async function joinTournament(tid, uid) {
    const { rowCount } = await q(
      `INSERT INTO tournament_players (tournament_id, uid, joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [String(tid), String(uid), Date.now()]
    );
    return rowCount === 1;
  }
  async function leaveTournament(tid, uid) {
    const { rowCount } = await q(`DELETE FROM tournament_players WHERE tournament_id = $1 AND uid = $2 AND games = 0`, [String(tid), String(uid)]);
    return rowCount > 0;
  }
  async function applyTournamentResult(tid, uid, { points, result, oppRating, streak, oppUid }) {
    const { rows } = await q(
      `UPDATE tournament_players SET
         score = score + $3::int, games = games + 1,
         wins = wins + $4::int, draws = draws + $5::int, losses = losses + $6::int,
         streak = $7::int, perf = perf + $8::int, last_opp = $9
       WHERE tournament_id = $1 AND uid = $2 RETURNING *`,
      [String(tid), String(uid), points, result === "win" ? 1 : 0, result === "draw" ? 1 : 0, result === "loss" ? 1 : 0,
       streak, result === "win" ? Math.max(0, Math.round(oppRating || 0)) : 0, String(oppUid)]
    );
    return rows[0] ? rowToTPlayer(rows[0]) : null;
  }
  async function setTournamentActive(tid, uid, active) {
    await q(`UPDATE tournament_players SET active = $3 WHERE tournament_id = $1 AND uid = $2`, [String(tid), String(uid), Boolean(active)]);
  }
  async function setTournamentPlaces(tid, places) {
    for (const p of places) {
      await q(`UPDATE tournament_players SET place = $3 WHERE tournament_id = $1 AND uid = $2`, [String(tid), String(p.uid), p.place]);
    }
  }
  async function addTournamentGame(g) {
    await q(
      `INSERT INTO tournament_games (tournament_id, white_uid, black_uid, result, plies, finished_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [String(g.tournamentId), String(g.whiteUid), String(g.blackUid), g.result, g.plies || 0, Date.now()]
    );
  }
  // Результаты игрока по турнирам (в т.ч. черновики: «попал в финал» — это уже достижение).
  // Что показывать в профиле публично, решает вызывающий код (server.js).
  async function listUserTournamentResults(uid) {
    const { rows } = await q(
      `SELECT t.id, t.title, t.subtitle, t.stage, t.status, t.finished_at AS "finishedAt",
              p.place, p.score, p.games, p.wins
       FROM tournament_players p JOIN tournaments t ON t.id = p.tournament_id
       WHERE p.uid = $1 AND t.status <> 'cancelled'
       ORDER BY t.starts_at DESC`,
      [String(uid)]
    );
    return rows;
  }

  async function dbStatus() {
    const counts = {};
    for (const t of ["users", "games", "puzzles", "puzzle_solves", "friendships", "tournaments", "tournament_players"]) {
      try { counts[t] = (await q(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n; } catch { counts[t] = null; }
    }
    const migrations = (await q(`SELECT id, name, applied_at AS "appliedAt" FROM schema_migrations ORDER BY id`)).rows;
    const snaps = (await q(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ~ '^bak_[0-9]{12}_' ORDER BY table_name`
    )).rows.map((r) => r.table_name);
    return { mode: "postgres", counts, migrations, snapshots: snaps };
  }

  impl = {
    getUser, getUserByEmail, getUserByPublicId, getUsersByUids, searchUsers, createUser, upsertUser,
    applyResult, addRating, addGameRecord, getGames,
    getModeRatings, applyModeResult,
    listPuzzles, getPuzzle, createPuzzle, updatePuzzle, deletePuzzle, getSolvedPuzzleIds, countSolvedPuzzles, markPuzzleSolved,
    addFriendship, removeFriendship, areFriends, listFriendUids, countFriends,
    createFriendRequest, hasFriendRequest, deleteFriendRequest, listIncomingRequests, listOutgoingRequests,
    getAchievements, grantAchievements,
    createTournament, getTournament, listTournaments, updateTournament, listTournamentPlayers, getTournamentPlayer,
    countTournamentPlayers, joinTournament, leaveTournament, applyTournamentResult, setTournamentActive,
    setTournamentPlaces, addTournamentGame, listUserTournamentResults,
    dbStatus,
    mode: "postgres",
  };
} else {
  /* =========================================================
     РЕЖИМ JSON-ФАЙЛЫ (только для локальной разработки)
     ========================================================= */
  const { seedTournaments } = require("./cup-seed");
  const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const F = (n) => path.join(DATA_DIR, n);
  const FILES = {
    users: F("users.json"), games: F("games.json"), puzzles: F("puzzles.json"), solves: F("puzzle_solves.json"),
    modes: F("mode_ratings.json"), friends: F("friendships.json"), requests: F("friend_requests.json"),
    ach: F("achievements.json"), tournaments: F("tournaments.json"), tplayers: F("tournament_players.json"),
    tgames: F("tournament_games.json"),
  };
  const OBJ_FILES = new Set([FILES.users, FILES.solves, FILES.modes, FILES.ach]);

  function readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return OBJ_FILES.has(file) ? {} : []; }
  }
  // Запись через временный файл + rename: оборванная запись не портит основной файл.
  function writeJSON(file, data) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }
  const existedBefore = new Set(Object.values(FILES).filter((f) => fs.existsSync(f)));
  for (const f of Object.values(FILES)) if (!existedBefore.has(f)) writeJSON(f, OBJ_FILES.has(f) ? {} : []);
  // Стартовые данные — только при ПЕРВОМ создании файла (иначе удалённое админом «воскресало» бы).
  if (!existedBefore.has(FILES.puzzles)) writeJSON(FILES.puzzles, require("./puzzles-seed"));
  if (!existedBefore.has(FILES.tournaments)) {
    writeJSON(FILES.tournaments, seedTournaments().map((t) => ({ ...t, createdAt: Date.now(), finishedAt: null })));
  }

  // public_id у уже существующих игроков (если файл users.json остался от старой версии).
  (function backfillPublicIds() {
    const users = readJSON(FILES.users);
    const taken = new Set(Object.values(users).map((u) => u.publicId).filter(Boolean));
    let changed = false;
    for (const u of Object.values(users)) {
      if (!u.publicId) { u.publicId = makePublicId(u.uid, taken); taken.add(u.publicId); changed = true; }
    }
    if (changed) writeJSON(FILES.users, users);
  })();

  const usersMap = () => readJSON(FILES.users);
  const pub = (u) => u || null;

  async function getUser(uid) { return pub(usersMap()[uid]); }
  async function getUserByEmail(email) {
    const target = String(email).toLowerCase();
    return Object.values(usersMap()).find((u) => (u.email || "").toLowerCase() === target) || null;
  }
  async function getUserByPublicId(pid) {
    const t = normPublicId(pid);
    return Object.values(usersMap()).find((u) => u.publicId === t) || null;
  }
  async function getUsersByUids(uids) {
    const m = usersMap();
    return [...new Set((uids || []).map(String))].map((id) => m[id]).filter(Boolean);
  }
  async function searchUsers(query, limit = 20, excludeUid = null) {
    const text = String(query || "").trim().toLowerCase();
    if (text.length < 2) return [];
    const pid = normPublicId(text);
    return Object.values(usersMap())
      .filter((u) => u.uid !== excludeUid && ((u.name || "").toLowerCase().includes(text) || u.publicId === pid))
      .sort((a, b) => (b.publicId === pid) - (a.publicId === pid) || b.rating - a.rating)
      .slice(0, limit);
  }
  async function createUser({ email, passwordHash, name }) {
    const users = usersMap();
    const uid = crypto.randomUUID();
    const taken = new Set(Object.values(users).map((u) => u.publicId));
    const user = { ...defaultUser(uid), publicId: makePublicId(uid, taken), email: String(email).toLowerCase(), passwordHash, name: name || "Игрок" };
    users[uid] = user;
    writeJSON(FILES.users, users);
    return user;
  }
  async function upsertUser(uid, patch) {
    const users = usersMap();
    users[uid] = { ...(users[uid] || defaultUser(uid)), ...patch };
    writeJSON(FILES.users, users);
    return users[uid];
  }
  // В одном процессе Node между чтением и записью нет await — обновление атомарно.
  async function applyResult(uid, { ratingDelta, result }) {
    const users = usersMap();
    const u = users[uid] || defaultUser(uid);
    u.rating += ratingDelta;
    u.gamesPlayed = (u.gamesPlayed || 0) + 1;
    u.wins = (u.wins || 0) + (result === "win" ? 1 : 0);
    u.losses = (u.losses || 0) + (result === "loss" ? 1 : 0);
    u.draws = (u.draws || 0) + (result === "draw" ? 1 : 0);
    u.streak = result === "win" ? (u.streak || 0) + 1 : 0;
    users[uid] = u;
    writeJSON(FILES.users, users);
    return u;
  }
  async function addRating(uid, delta) {
    const users = usersMap();
    const u = users[uid] || defaultUser(uid);
    u.rating += delta;
    users[uid] = u;
    writeJSON(FILES.users, users);
    return u;
  }
  async function addGameRecord(uid, record) {
    const games = readJSON(FILES.games);
    games.unshift({ uid, ...record, date: Date.now() });
    writeJSON(FILES.games, games);
  }
  async function getGames(uid, limit = 50) {
    return readJSON(FILES.games).filter((g) => String(g.uid) === String(uid)).slice(0, limit);
  }

  async function getModeRatings(uid) { return readJSON(FILES.modes)[String(uid)] || {}; }
  async function applyModeResult(uid, mode, { ratingDelta, result, seedRating }) {
    const all = readJSON(FILES.modes);
    const mine = all[String(uid)] || (all[String(uid)] = {});
    const r = mine[mode] || { rating: seedRating, games: 0, wins: 0, losses: 0, draws: 0 };
    r.rating += ratingDelta; r.games++;
    if (result === "win") r.wins++; else if (result === "loss") r.losses++; else r.draws++;
    mine[mode] = r;
    writeJSON(FILES.modes, all);
    return r;
  }

  async function listPuzzles() { return readJSON(FILES.puzzles); }
  async function getPuzzle(id) { return readJSON(FILES.puzzles).find((p) => p.id === String(id)) || null; }
  async function createPuzzle({ tag, fen, hint, solution }) {
    const list = readJSON(FILES.puzzles);
    const puzzle = { id: "p_" + crypto.randomBytes(5).toString("hex"), tag, fen, hint, solution };
    list.push(puzzle);
    writeJSON(FILES.puzzles, list);
    return puzzle;
  }
  async function updatePuzzle(id, { tag, fen, hint, solution }) {
    const list = readJSON(FILES.puzzles);
    const i = list.findIndex((p) => p.id === String(id));
    if (i === -1) return null;
    list[i] = { id: list[i].id, tag, fen, hint, solution };
    writeJSON(FILES.puzzles, list);
    return list[i];
  }
  async function deletePuzzle(id) {
    const list = readJSON(FILES.puzzles);
    const next = list.filter((p) => p.id !== String(id));
    if (next.length === list.length) return false;
    writeJSON(FILES.puzzles, next);
    const solves = readJSON(FILES.solves);
    for (const uid of Object.keys(solves)) solves[uid] = solves[uid].filter((pid) => pid !== String(id));
    writeJSON(FILES.solves, solves);
    return true;
  }
  async function getSolvedPuzzleIds(uid) { return readJSON(FILES.solves)[String(uid)] || []; }
  async function countSolvedPuzzles(uid) { return (readJSON(FILES.solves)[String(uid)] || []).length; }
  async function markPuzzleSolved(uid, puzzleId) {
    const solves = readJSON(FILES.solves);
    const list = solves[String(uid)] || [];
    if (list.includes(String(puzzleId))) return false;
    list.push(String(puzzleId));
    solves[String(uid)] = list;
    writeJSON(FILES.solves, solves);
    return true;
  }

  async function addFriendship(a, b) {
    const [x, y] = pairKey(a, b);
    const list = readJSON(FILES.friends);
    if (list.some((f) => f.a === x && f.b === y)) return false;
    list.push({ a: x, b: y, createdAt: Date.now() });
    writeJSON(FILES.friends, list);
    return true;
  }
  async function removeFriendship(a, b) {
    const [x, y] = pairKey(a, b);
    const list = readJSON(FILES.friends);
    const next = list.filter((f) => !(f.a === x && f.b === y));
    if (next.length === list.length) return false;
    writeJSON(FILES.friends, next);
    return true;
  }
  async function areFriends(a, b) {
    const [x, y] = pairKey(a, b);
    return readJSON(FILES.friends).some((f) => f.a === x && f.b === y);
  }
  async function listFriendUids(uid) {
    return readJSON(FILES.friends)
      .filter((f) => f.a === String(uid) || f.b === String(uid))
      .map((f) => ({ uid: f.a === String(uid) ? f.b : f.a, createdAt: f.createdAt }))
      .sort((p, r) => r.createdAt - p.createdAt);
  }
  async function countFriends(uid) { return (await listFriendUids(uid)).length; }
  async function createFriendRequest(from, to) {
    const list = readJSON(FILES.requests);
    if (list.some((r) => r.from === String(from) && r.to === String(to))) return false;
    list.push({ from: String(from), to: String(to), createdAt: Date.now() });
    writeJSON(FILES.requests, list);
    return true;
  }
  async function hasFriendRequest(from, to) {
    return readJSON(FILES.requests).some((r) => r.from === String(from) && r.to === String(to));
  }
  async function deleteFriendRequest(from, to) {
    const list = readJSON(FILES.requests);
    const next = list.filter((r) => !(r.from === String(from) && r.to === String(to)));
    if (next.length === list.length) return false;
    writeJSON(FILES.requests, next);
    return true;
  }
  async function listIncomingRequests(uid) {
    return readJSON(FILES.requests).filter((r) => r.to === String(uid)).map((r) => ({ uid: r.from, createdAt: r.createdAt })).reverse();
  }
  async function listOutgoingRequests(uid) {
    return readJSON(FILES.requests).filter((r) => r.from === String(uid)).map((r) => ({ uid: r.to, createdAt: r.createdAt })).reverse();
  }

  async function getAchievements(uid) { return readJSON(FILES.ach)[String(uid)] || []; }
  async function grantAchievements(uid, codes) {
    const all = readJSON(FILES.ach);
    const mine = all[String(uid)] || [];
    const have = new Set(mine.map((a) => a.code));
    const fresh = (codes || []).filter((c) => !have.has(c));
    if (!fresh.length) return [];
    for (const code of fresh) mine.push({ code, earnedAt: Date.now() });
    all[String(uid)] = mine;
    writeJSON(FILES.ach, all);
    return fresh;
  }

  const tList = () => readJSON(FILES.tournaments);
  async function createTournament(t) {
    const list = tList();
    const row = {
      id: t.id || "t_" + crypto.randomBytes(5).toString("hex"), title: t.title, subtitle: t.subtitle || "",
      description: t.description || "", stage: t.stage || "single", status: t.status || "draft", startsAt: t.startsAt,
      durationMin: t.durationMin, tc: t.tc, maxPlayers: t.maxPlayers || 500, parentId: t.parentId || null,
      qualifyTop: t.qualifyTop || 16, createdAt: Date.now(), finishedAt: null,
    };
    list.push(row);
    writeJSON(FILES.tournaments, list);
    return row;
  }
  async function getTournament(id) { return tList().find((t) => t.id === String(id)) || null; }
  async function listTournaments(statuses) {
    return tList().filter((t) => !statuses || !statuses.length || statuses.includes(t.status)).sort((a, b) => a.startsAt - b.startsAt);
  }
  async function updateTournament(id, patch) {
    const list = tList();
    const i = list.findIndex((t) => t.id === String(id));
    if (i === -1) return null;
    const allowed = ["title", "subtitle", "description", "stage", "status", "startsAt", "durationMin", "tc", "maxPlayers", "parentId", "qualifyTop", "finishedAt"];
    for (const k of allowed) if (patch[k] !== undefined) list[i][k] = patch[k];
    writeJSON(FILES.tournaments, list);
    return list[i];
  }
  const tpAll = () => readJSON(FILES.tplayers);
  async function listTournamentPlayers(tid) { return tpAll().filter((p) => p.tournamentId === String(tid)); }
  async function getTournamentPlayer(tid, uid) { return tpAll().find((p) => p.tournamentId === String(tid) && p.uid === String(uid)) || null; }
  async function countTournamentPlayers(tid) { return (await listTournamentPlayers(tid)).length; }
  async function joinTournament(tid, uid) {
    const list = tpAll();
    if (list.some((p) => p.tournamentId === String(tid) && p.uid === String(uid))) return false;
    list.push({ tournamentId: String(tid), uid: String(uid), joinedAt: Date.now(), score: 0, games: 0, wins: 0, draws: 0, losses: 0, streak: 0, perf: 0, active: true, place: null, lastOpp: null });
    writeJSON(FILES.tplayers, list);
    return true;
  }
  async function leaveTournament(tid, uid) {
    const list = tpAll();
    const next = list.filter((p) => !(p.tournamentId === String(tid) && p.uid === String(uid) && p.games === 0));
    if (next.length === list.length) return false;
    writeJSON(FILES.tplayers, next);
    return true;
  }
  async function applyTournamentResult(tid, uid, { points, result, oppRating, streak, oppUid }) {
    const list = tpAll();
    const p = list.find((x) => x.tournamentId === String(tid) && x.uid === String(uid));
    if (!p) return null;
    p.score += points; p.games++; p.streak = streak; p.lastOpp = String(oppUid);
    if (result === "win") { p.wins++; p.perf += Math.max(0, Math.round(oppRating || 0)); }
    else if (result === "draw") p.draws++; else p.losses++;
    writeJSON(FILES.tplayers, list);
    return p;
  }
  async function setTournamentActive(tid, uid, active) {
    const list = tpAll();
    const p = list.find((x) => x.tournamentId === String(tid) && x.uid === String(uid));
    if (p) { p.active = Boolean(active); writeJSON(FILES.tplayers, list); }
  }
  async function setTournamentPlaces(tid, places) {
    const list = tpAll();
    for (const pl of places) {
      const p = list.find((x) => x.tournamentId === String(tid) && x.uid === String(pl.uid));
      if (p) p.place = pl.place;
    }
    writeJSON(FILES.tplayers, list);
  }
  async function addTournamentGame(g) {
    const list = readJSON(FILES.tgames);
    list.push({ ...g, finishedAt: Date.now() });
    writeJSON(FILES.tgames, list);
  }
  async function listUserTournamentResults(uid) {
    const ts = new Map(tList().map((t) => [t.id, t]));
    return tpAll()
      .filter((p) => p.uid === String(uid))
      .map((p) => ({ p, t: ts.get(p.tournamentId) }))
      .filter(({ t }) => t && t.status !== "cancelled")
      .sort((a, b) => b.t.startsAt - a.t.startsAt)
      .map(({ p, t }) => ({ id: t.id, title: t.title, subtitle: t.subtitle, stage: t.stage, status: t.status, finishedAt: t.finishedAt, place: p.place, score: p.score, games: p.games, wins: p.wins }));
  }

  async function dbStatus() {
    return {
      mode: "json",
      counts: { users: Object.keys(usersMap()).length, games: readJSON(FILES.games).length, puzzles: readJSON(FILES.puzzles).length, tournaments: tList().length },
      migrations: [], snapshots: [],
    };
  }

  console.warn(
    "⚠️  DATABASE_URL не задан — используется JSON-хранилище в " + DATA_DIR + ". " +
      "Это режим для локальной разработки: на хостинге с эфемерным диском данные теряются."
  );

  impl = {
    getUser, getUserByEmail, getUserByPublicId, getUsersByUids, searchUsers, createUser, upsertUser,
    applyResult, addRating, addGameRecord, getGames,
    getModeRatings, applyModeResult,
    listPuzzles, getPuzzle, createPuzzle, updatePuzzle, deletePuzzle, getSolvedPuzzleIds, countSolvedPuzzles, markPuzzleSolved,
    addFriendship, removeFriendship, areFriends, listFriendUids, countFriends,
    createFriendRequest, hasFriendRequest, deleteFriendRequest, listIncomingRequests, listOutgoingRequests,
    getAchievements, grantAchievements,
    createTournament, getTournament, listTournaments, updateTournament, listTournamentPlayers, getTournamentPlayer,
    countTournamentPlayers, joinTournament, leaveTournament, applyTournamentResult, setTournamentActive,
    setTournamentPlaces, addTournamentGame, listUserTournamentResults,
    dbStatus,
    mode: "json",
  };
}

module.exports = { ...impl, defaultUser, normPublicId };
