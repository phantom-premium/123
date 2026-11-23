require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { WebSocketServer } = require("ws");
const TelegramBot = require("node-telegram-bot-api");
const {
  getUser, getUserByEmail, getUserByPublicId, getUsersByUids, searchUsers, createUser, upsertUser,
  applyResult, addRating, addGameRecord, getGames, defaultUser,
  getModeRatings, applyModeResult,
  listPuzzles, getPuzzle, createPuzzle, updatePuzzle, deletePuzzle, getSolvedPuzzleIds, countSolvedPuzzles, markPuzzleSolved,
  addFriendship, removeFriendship, areFriends, listFriendUids, countFriends,
  createFriendRequest, hasFriendRequest, deleteFriendRequest, listIncomingRequests, listOutgoingRequests,
  getAchievements, grantAchievements,
  createTournament, getTournament, listTournaments, updateTournament, listTournamentPlayers, getTournamentPlayer,
  countTournamentPlayers, joinTournament, leaveTournament, applyTournamentResult, setTournamentActive,
  setTournamentPlaces, addTournamentGame, listUserTournamentResults,
  dbStatus,
} = require("./storage");
// Та же проверка FEN/решения, что и в админ-меню в браузере, — но здесь она
// окончательная: в базу попадает только то, что прошло проверку на сервере.
const PuzzleCheck = require("./public/puzzlecheck.js");
// Шахматные правила для судейства партий с ботом (тот же chess.js, что и в браузере).
require("./public/chess.js");
const ChessRules = globalThis.Chess;
const { computeBotMove } = require("./bot-pool");
// Общие с браузером справочники: режимы игры и каталог достижений.
const Modes = require("./public/modes.js");
const Achievements = require("./public/achievements.js");
// Чистая логика турнира-арены (очки, таблица, подбор пар).
const Engine = require("./tournament-engine");

const BOT_TOKEN = process.env.BOT_TOKEN;
// На Render этот адрес подставляется автоматически (RENDER_EXTERNAL_URL),
// вручную его прописывать не нужно. Для локального запуска/своего туннеля
// можно по-прежнему задать MINI_APP_URL в .env.
const MINI_APP_URL = process.env.MINI_APP_URL || process.env.RENDER_EXTERNAL_URL || null;
const PORT = process.env.PORT || 3000;
// Публичный HTTPS-адрес есть только когда сервис реально развёрнут (Render
// или свой туннель) — по нему решаем, включать вебхук или long polling.
const IS_PUBLICLY_REACHABLE = Boolean(MINI_APP_URL);

if (!BOT_TOKEN) {
  console.error("❌ Не найден BOT_TOKEN. Создайте файл .env на основе .env.example");
  process.exit(1);
}

/* ============================================================
   ХРАНИЛИЩЕ (рейтинг, история партий) — вынесено в storage.js.
   Постоянная Postgres-база, если задан DATABASE_URL (переживает
   передеплой/сон на Render Free), либо JSON-файлы для локальной
   разработки без базы. Подробности — в README.
   ============================================================ */

/* ============================================================
   АУТЕНТИФИКАЦИЯ ПО E-MAIL И ПАРОЛЮ
   Вход через Telegram убран: аккаунт (и рейтинг) больше не привязан
   к Telegram-профилю, а создаётся регистрацией внутри мини-приложения.
   Сессия — обычный JWT-токен, который клиент хранит в localStorage и
   присылает в заголовке Authorization: Bearer <token>.
   ============================================================ */

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn(
    "⚠️  JWT_SECRET не задан в .env — сгенерирован временный секрет. " +
      "Все выданные токены станут недействительными при перезапуске сервера " +
      "(пользователям придётся войти заново). Задайте постоянный JWT_SECRET в .env/переменных окружения."
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Администраторы — по e-mail из переменной ADMIN_EMAILS (через запятую).
// Пример: ADMIN_EMAILS=owner@example.com,second@example.com
// ВАЖНО: e-mail при регистрации не подтверждается письмом, поэтому эти
// аккаунты нужно зарегистрировать самим, ДО того как вы объявите адрес
// администратора кому-то ещё. Иначе теоретически чужой человек мог бы
// занять этот e-mail первым.
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

function isAdminUser(user) {
  return Boolean(user && user.email && ADMIN_EMAILS.has(String(user.email).toLowerCase()));
}

function signToken(uid) {
  return jwt.sign({ uid }, JWT_SECRET, { expiresIn: "30d" });
}

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  safe.isAdmin = isAdminUser(user);
  return safe;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "auth_required" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.uid = payload.uid;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

// uid из токена, если он есть и валиден; иначе null (гость). Ошибку не бросает.
function readOptionalUid(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET).uid; } catch { return null; }
}

// Ставится ПОСЛЕ authMiddleware. Права проверяются по базе при каждом запросе —
// а не по флагу из токена, поэтому убрать e-mail из ADMIN_EMAILS отзывает
// доступ сразу.
async function adminMiddleware(req, res, next) {
  try {
    const user = await getUser(req.uid);
    if (!isAdminUser(user)) return res.status(403).json({ error: "forbidden" });
    next();
  } catch (err) {
    console.error("❌ adminMiddleware:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
}

/* ============================================================
   EXPRESS APP
   ============================================================ */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/register", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: "invalid_email" });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: "weak_password" });
    }
    const existing = await getUserByEmail(String(email));
    if (existing) return res.status(409).json({ error: "email_taken" });

    const passwordHash = await bcrypt.hash(String(password), 10);
    const user = await createUser({
      email: String(email),
      passwordHash,
      name: String(name || "Игрок").slice(0, 40) || "Игрок",
    });
    const token = signToken(user.uid);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error("❌ /api/register:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_fields" });

    const user = await getUserByEmail(String(email));
    if (!user || !user.passwordHash) return res.status(401).json({ error: "invalid_credentials" });

    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = signToken(user.uid);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error("❌ /api/login:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.uid);
    if (!user) return res.status(404).json({ error: "not_found" });
    res.json({ ...sanitizeUser(user), modes: await getModeRatings(user.uid) });
  } catch (err) {
    console.error("❌ /api/me:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/profile/desc", authMiddleware, async (req, res) => {
  try {
    const { desc } = req.body || {};
    const user = await upsertUser(req.uid, { desc: String(desc || "").slice(0, 120) });
    res.json(sanitizeUser(user));
  } catch (err) {
    console.error("❌ /api/profile/desc:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

/* ============================================================
   ЗАДАЧИ
   ============================================================ */

// Рейтинг за решённую задачу начисляется на сервере и РОВНО ОДИН РАЗ за каждую
// задачу на каждого игрока: решённая задача больше не выдаётся, а повторный
// запрос «я решил» не даёт ничего (см. markPuzzleSolved).
const PUZZLE_RATING_DELTA = 4;

// Список задач для игрока. С токеном — без уже решённых им; без токена (гость)
// отдаём все, а клиент сам скрывает решённые (гостю рейтинг не сохраняется).
app.get("/api/puzzles", async (req, res) => {
  try {
    const uid = readOptionalUid(req);
    const [all, solvedIds] = await Promise.all([listPuzzles(), uid ? getSolvedPuzzleIds(uid) : []]);
    const solved = new Set(solvedIds);
    res.set("Cache-Control", "no-store");
    res.json({
      authed: Boolean(uid),
      total: all.length,
      puzzles: all.filter((p) => !solved.has(p.id)),
    });
  } catch (err) {
    console.error("❌ /api/puzzles:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/puzzle/solved", authMiddleware, async (req, res) => {
  try {
    const { puzzleId, moves } = req.body || {};
    const puzzle = await getPuzzle(String(puzzleId || ""));
    if (!puzzle) return res.status(404).json({ error: "puzzle_not_found" });

    // Клиент присылает свои ходы; они должны совпасть с ходами решающего в решении.
    const expected = puzzle.solution.filter((_, i) => i % 2 === 0).map((m) => m.from + m.to);
    const got = Array.isArray(moves) ? moves.map((m) => String((m && m.from) || "") + String((m && m.to) || "")) : null;
    if (!got || got.length !== expected.length || got.some((g, i) => g !== expected[i])) {
      return res.status(400).json({ error: "wrong_solution" });
    }

    const isNew = await markPuzzleSolved(req.uid, puzzle.id);
    const current = (await getUser(req.uid)) || defaultUser(req.uid);
    if (!isNew) {
      return res.json({ ...sanitizeUser(current), delta: 0, alreadySolved: true });
    }
    const user = await addRating(req.uid, PUZZLE_RATING_DELTA);
    const achievements = await checkAchievements(req.uid);
    res.json({ ...sanitizeUser(user), delta: PUZZLE_RATING_DELTA, achievements });
  } catch (err) {
    console.error("❌ /api/puzzle/solved:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

/* ============================================================
   АДМИН-МЕНЮ: создание / редактирование / удаление задач
   ============================================================ */

function puzzleFromBody(body) {
  body = body || {};
  const check = PuzzleCheck.checkPuzzle({ fen: body.fen, moves: body.solution });
  if (!check.ok) {
    return { error: check.stage === "fen" ? "invalid_fen" : "invalid_solution", message: check.error };
  }
  return {
    value: {
      tag: String(body.tag || "").trim().slice(0, 60) || "Найдите лучший ход",
      fen: check.fen,
      hint: String(body.hint || "").trim().slice(0, 200),
      solution: check.moves,
    },
  };
}

app.get("/api/admin/puzzles", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ puzzles: await listPuzzles() });
  } catch (err) {
    console.error("❌ GET /api/admin/puzzles:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/admin/puzzles", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const parsed = puzzleFromBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error, message: parsed.message });
    res.status(201).json(await createPuzzle(parsed.value));
  } catch (err) {
    console.error("❌ POST /api/admin/puzzles:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.put("/api/admin/puzzles/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const parsed = puzzleFromBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error, message: parsed.message });
    const updated = await updatePuzzle(req.params.id, parsed.value);
    if (!updated) return res.status(404).json({ error: "puzzle_not_found" });
    res.json(updated);
  } catch (err) {
    console.error("❌ PUT /api/admin/puzzles:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.delete("/api/admin/puzzles/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const ok = await deletePuzzle(req.params.id);
    if (!ok) return res.status(404).json({ error: "puzzle_not_found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ DELETE /api/admin/puzzles:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.get("/api/games", authMiddleware, async (req, res) => {
  try {
    const games = await getGames(req.uid, 50);
    res.json(games);
  } catch (err) {
    console.error("❌ /api/games:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

/* ============================================================
   ДРУЗЬЯ, ПРОФИЛИ, ДОСТИЖЕНИЯ
   ============================================================ */

// uid -> Set<ws>: кто сейчас «в сети» (держит открытый сокет с входом в аккаунт).
const presence = new Map();

function isOnline(uid) {
  const s = presence.get(String(uid));
  return Boolean(s && s.size);
}
function notifyUser(uid, payload) {
  const s = presence.get(String(uid));
  if (s) for (const w of s) sendTo(w, payload);
}
function bindPresence(ws, uid) {
  if (ws.presenceUid === uid) return;
  unbindPresence(ws);
  ws.presenceUid = uid;
  if (!presence.has(uid)) presence.set(uid, new Set());
  presence.get(uid).add(ws);
}
function unbindPresence(ws) {
  const uid = ws.presenceUid;
  if (!uid) return;
  const s = presence.get(uid);
  if (s) { s.delete(ws); if (!s.size) presence.delete(uid); }
  ws.presenceUid = null;
}

const MODE_IDS = Modes.CATEGORY_ORDER;

// Короткая публичная карточка игрока (без e-mail и прочего личного).
function playerCard(u) {
  return { uid: u.uid, publicId: u.publicId, name: u.name, rating: u.rating, desc: u.desc || "", online: isOnline(u.uid) };
}

// Метрики для проверки достижений (см. public/achievements.js).
async function buildAchievementContext(uid) {
  const [user, modes, puzzles, friends, results] = await Promise.all([
    getUser(uid), getModeRatings(uid), countSolvedPuzzles(uid), countFriends(uid), listUserTournamentResults(uid),
  ]);
  if (!user) return null;
  const mg = (m) => (modes[m] && modes[m].games) || 0;
  const finals = results.filter((r) => r.stage === "final");
  const places = finals.map((r) => r.place).filter((p) => p != null);
  return {
    gamesPlayed: user.gamesPlayed || 0, wins: user.wins || 0, streak: user.streak || 0, rating: user.rating || 1200,
    puzzles, friends,
    bulletGames: mg("bullet"), blitzGames: mg("blitz"), rapidGames: mg("rapid"), classicGames: mg("classic"),
    modesPlayed: MODE_IDS.filter((m) => mg(m) >= 3).length,
    cupParticipated: results.filter((r) => r.games > 0).length,
    cupFinals: finals.length,
    cupFinalPlace: places.length ? Math.min(...places) : null,
  };
}

// Проверяет, что игрок заработал нового, выдаёт и присылает уведомление.
// Никогда не бросает ошибку: достижения — приятное дополнение, а не причина сломать партию.
async function checkAchievements(uid, extraCodes = []) {
  try {
    if (!uid || String(uid).startsWith("guest-")) return [];
    const ctx = await buildAchievementContext(uid);
    if (!ctx) return [];
    const have = (await getAchievements(uid)).map((a) => a.code);
    const codes = new Set(Achievements.evaluate(ctx, have));
    for (const c of extraCodes) if (Achievements.get(c) && !have.includes(c)) codes.add(c);
    const fresh = await grantAchievements(uid, [...codes]);
    if (fresh.length) notifyUser(uid, { type: "achievements", codes: fresh });
    return fresh;
  } catch (err) {
    console.error("❌ checkAchievements:", err.message);
    return [];
  }
}

async function resolveUserParam(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  // public_id — 6 символов; uid — UUID/длиннее.
  if (s.length <= 12 || /^t-?chess-/i.test(s)) return getUserByPublicId(s);
  return getUser(s);
}

async function buildPublicProfile(target, viewerUid) {
  const [modes, achievements, results, friendsCount, puzzles] = await Promise.all([
    getModeRatings(target.uid), getAchievements(target.uid), listUserTournamentResults(target.uid),
    countFriends(target.uid), countSolvedPuzzles(target.uid),
  ]);
  let relation = "none";
  if (viewerUid) {
    if (viewerUid === target.uid) relation = "self";
    else if (await areFriends(viewerUid, target.uid)) relation = "friends";
    else if (await hasFriendRequest(viewerUid, target.uid)) relation = "request_sent";
    else if (await hasFriendRequest(target.uid, viewerUid)) relation = "request_received";
  }
  const modeOut = {};
  for (const m of MODE_IDS) modeOut[m] = modes[m] || null;
  return {
    uid: target.uid, publicId: target.publicId, name: target.name, desc: target.desc || "",
    rating: target.rating, gamesPlayed: target.gamesPlayed || 0, wins: target.wins || 0,
    losses: target.losses || 0, draws: target.draws || 0, streak: target.streak || 0,
    modes: modeOut, puzzlesSolved: puzzles, friendsCount,
    achievements, online: isOnline(target.uid), relation,
    // награды Кубка: только завершённые турниры с призовым местом
    trophies: results.filter((r) => r.status === "finished" && r.place != null && r.place <= 3)
      .map((r) => ({ tournamentId: r.id, title: r.title, subtitle: r.subtitle, stage: r.stage, place: r.place })),
    tournaments: results.filter((r) => r.games > 0 && r.status !== "draft")
      .map((r) => ({ tournamentId: r.id, title: r.title, subtitle: r.subtitle, stage: r.stage, status: r.status, place: r.place, score: r.score, games: r.games })),
  };
}

app.get("/api/profile/:id", async (req, res) => {
  try {
    const target = await resolveUserParam(req.params.id);
    if (!target) return res.status(404).json({ error: "user_not_found" });
    res.set("Cache-Control", "no-store");
    res.json(await buildPublicProfile(target, readOptionalUid(req)));
  } catch (err) {
    console.error("❌ /api/profile:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.get("/api/users/search", authMiddleware, async (req, res) => {
  try {
    const found = await searchUsers(String(req.query.q || ""), 20, req.uid);
    const out = [];
    for (const u of found) {
      let relation = "none";
      if (await areFriends(req.uid, u.uid)) relation = "friends";
      else if (await hasFriendRequest(req.uid, u.uid)) relation = "request_sent";
      else if (await hasFriendRequest(u.uid, req.uid)) relation = "request_received";
      out.push({ ...playerCard(u), relation });
    }
    res.json({ users: out });
  } catch (err) {
    console.error("❌ /api/users/search:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.get("/api/friends", authMiddleware, async (req, res) => {
  try {
    const [friendRows, inRows, outRows] = await Promise.all([
      listFriendUids(req.uid), listIncomingRequests(req.uid), listOutgoingRequests(req.uid),
    ]);
    const users = await getUsersByUids([...friendRows, ...inRows, ...outRows].map((r) => r.uid));
    const byUid = new Map(users.map((u) => [u.uid, u]));
    const card = (r) => (byUid.get(r.uid) ? { ...playerCard(byUid.get(r.uid)), since: r.createdAt } : null);
    const friends = friendRows.map(card).filter(Boolean)
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "ru"));
    res.set("Cache-Control", "no-store");
    res.json({ friends, incoming: inRows.map(card).filter(Boolean), outgoing: outRows.map(card).filter(Boolean) });
  } catch (err) {
    console.error("❌ /api/friends:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

const MAX_OUTGOING_REQUESTS = 50;
const MAX_FRIENDS = 500;

async function makeFriends(a, b) {
  await deleteFriendRequest(a, b);
  await deleteFriendRequest(b, a);
  await addFriendship(a, b);
  await Promise.all([checkAchievements(a), checkAchievements(b)]);
}

app.post("/api/friends/request", authMiddleware, async (req, res) => {
  try {
    const { uid, publicId } = req.body || {};
    const target = uid ? await getUser(String(uid)) : await getUserByPublicId(String(publicId || ""));
    if (!target) return res.status(404).json({ error: "user_not_found" });
    if (target.uid === req.uid) return res.status(400).json({ error: "self" });
    if (await areFriends(req.uid, target.uid)) return res.json({ status: "already_friends" });

    // Встречная заявка уже есть — просто становимся друзьями.
    if (await hasFriendRequest(target.uid, req.uid)) {
      await makeFriends(req.uid, target.uid);
      const me = await getUser(req.uid);
      notifyUser(target.uid, { type: "friend_accepted", from: playerCard(me) });
      return res.json({ status: "accepted" });
    }
    if (await hasFriendRequest(req.uid, target.uid)) return res.json({ status: "already_sent" });
    if ((await listOutgoingRequests(req.uid)).length >= MAX_OUTGOING_REQUESTS) return res.status(429).json({ error: "too_many_requests" });
    if ((await countFriends(req.uid)) >= MAX_FRIENDS) return res.status(400).json({ error: "friends_limit" });

    await createFriendRequest(req.uid, target.uid);
    const me = await getUser(req.uid);
    notifyUser(target.uid, { type: "friend_request", from: playerCard(me) });
    res.json({ status: "sent" });
  } catch (err) {
    console.error("❌ /api/friends/request:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/friends/respond", authMiddleware, async (req, res) => {
  try {
    const { uid, accept } = req.body || {};
    const from = String(uid || "");
    if (!(await hasFriendRequest(from, req.uid))) return res.status(404).json({ error: "request_not_found" });
    if (accept) {
      await makeFriends(req.uid, from);
      const me = await getUser(req.uid);
      notifyUser(from, { type: "friend_accepted", from: playerCard(me) });
      return res.json({ status: "accepted" });
    }
    await deleteFriendRequest(from, req.uid);
    res.json({ status: "declined" });
  } catch (err) {
    console.error("❌ /api/friends/respond:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

// Убрать из друзей / отозвать свою заявку.
app.post("/api/friends/remove", authMiddleware, async (req, res) => {
  try {
    const other = String((req.body || {}).uid || "");
    await removeFriendship(req.uid, other);
    await deleteFriendRequest(req.uid, other);
    res.json({ status: "removed" });
  } catch (err) {
    console.error("❌ /api/friends/remove:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

/* ============================================================
   ТУРНИРЫ (Кубок Unicum) — REST. Сама игра идёт по WebSocket, см. блок
   «ТУРНИР: АРЕНА» ниже.
   ============================================================ */

function tournamentPhase(t, now) {
  if (t.status === "cancelled" || t.status === "finished" || t.status === "draft" || t.status === "registration") return t.status;
  return now < Engine.endsAt(t) ? "live" : "finishing";
}

function tournamentView(t, extra = {}) {
  const now = Date.now();
  return {
    id: t.id, title: t.title, subtitle: t.subtitle, description: t.description, stage: t.stage,
    status: t.status, phase: tournamentPhase(t, now), startsAt: t.startsAt, endsAt: Engine.endsAt(t),
    durationMin: t.durationMin, tc: Modes.get(t.tc), maxPlayers: t.maxPlayers, parentId: t.parentId,
    qualifyTop: t.qualifyTop, finishedAt: t.finishedAt, now, ...extra,
  };
}

// Таблица кэшируется на несколько секунд: её опрашивают все, кто смотрит турнир.
const standingsCache = new Map(); // id -> { at, data }
const STANDINGS_TTL_MS = 4000;
function dropStandingsCache(id) { standingsCache.delete(String(id)); }

async function buildStandings(t) {
  const hit = standingsCache.get(t.id);
  if (hit && Date.now() - hit.at < STANDINGS_TTL_MS) return hit.data;
  const players = await listTournamentPlayers(t.id);
  const ranked = Engine.rankPlayers(players);
  const users = await getUsersByUids(ranked.slice(0, 100).map((p) => p.uid));
  const byUid = new Map(users.map((u) => [u.uid, u]));
  const live = tRuntime.get(t.id);
  const data = {
    total: players.length,
    rows: ranked.slice(0, 100).map((p) => {
      const u = byUid.get(p.uid);
      return {
        rank: p.rank, uid: p.uid, publicId: u ? u.publicId : null, name: u ? u.name : "Игрок", rating: u ? u.rating : null,
        score: p.score, games: p.games, wins: p.wins, draws: p.draws, losses: p.losses, streak: p.streak,
        place: p.place, playing: Boolean(live && (live.pool.has(p.uid) || isUidInTournamentRoom(t.id, p.uid))),
      };
    }),
    ranks: new Map(ranked.map((p) => [p.uid, p])), // для «моей строки»; в JSON не уходит
  };
  standingsCache.set(t.id, { at: Date.now(), data });
  return data;
}

app.get("/api/tournaments", async (req, res) => {
  try {
    const uid = readOptionalUid(req);
    const list = await listTournaments(["registration", "running", "finished"]);
    const order = { running: 0, registration: 1, finished: 2 };
    list.sort((a, b) => order[a.status] - order[b.status] || (a.status === "finished" ? b.startsAt - a.startsAt : a.startsAt - b.startsAt));
    const out = [];
    for (const t of list) {
      const [count, mine] = await Promise.all([countTournamentPlayers(t.id), uid ? getTournamentPlayer(t.id, uid) : null]);
      out.push(tournamentView(t, { playersCount: count, joined: Boolean(mine), myPlace: mine ? mine.place : null }));
    }
    tCache = list.filter((t) => t.status === "registration" || t.status === "running");
    tCacheLoaded = true;
    res.set("Cache-Control", "no-store");
    res.json({ tournaments: out, now: Date.now() });
  } catch (err) {
    console.error("❌ /api/tournaments:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.get("/api/tournaments/:id", async (req, res) => {
  try {
    const t = await getTournament(req.params.id);
    if (!t || t.status === "draft" || t.status === "cancelled") return res.status(404).json({ error: "tournament_not_found" });
    const uid = readOptionalUid(req);
    const st = await buildStandings(t);
    const mine = uid ? st.ranks.get(uid) || (await getTournamentPlayer(t.id, uid)) : null;
    const rt = tRuntime.get(t.id);
    const me = mine
      ? { joined: true, rank: mine.rank || null, score: mine.score, games: mine.games, wins: mine.wins, draws: mine.draws, losses: mine.losses, streak: mine.streak, place: mine.place, queued: Boolean(rt && rt.pool.has(uid)) }
      : { joined: false };
    res.set("Cache-Control", "no-store");
    res.json({
      tournament: tournamentView(t, { playersCount: st.total }),
      standings: st.rows, me,
      live: { waiting: rt ? rt.pool.size : 0, playing: countTournamentRooms(t.id) * 2 },
    });
  } catch (err) {
    console.error("❌ /api/tournaments/:id:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/tournaments/:id/join", authMiddleware, async (req, res) => {
  try {
    const t = await getTournament(req.params.id);
    if (!t || t.status === "draft" || t.status === "cancelled") return res.status(404).json({ error: "tournament_not_found" });
    if (t.status === "finished") return res.status(400).json({ error: "finished" });
    if (t.status === "running" && Date.now() >= Engine.endsAt(t)) return res.status(400).json({ error: "ended" });
    const mine = await getTournamentPlayer(t.id, req.uid);
    if (mine) return res.json({ ok: true, already: true });
    // В финал попадают только по итогам квалификации.
    if (t.stage === "final") return res.status(403).json({ error: "invite_only" });
    if ((await countTournamentPlayers(t.id)) >= t.maxPlayers) return res.status(409).json({ error: "full" });
    await joinTournament(t.id, req.uid);
    dropStandingsCache(t.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/tournaments/:id/join:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/tournaments/:id/leave", authMiddleware, async (req, res) => {
  try {
    const t = await getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: "tournament_not_found" });
    if (t.status !== "registration" || Date.now() >= t.startsAt) return res.status(400).json({ error: "too_late" });
    if (t.stage === "final") return res.status(403).json({ error: "invite_only" });
    await leaveTournament(t.id, req.uid);
    dropStandingsCache(t.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/tournaments/:id/leave:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

/* ---------- админ: управление турнирами ---------- */

const T_STAGES = new Set(["single", "qualifier", "final"]);

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const ms = Date.parse(String(v || ""));
  return Number.isFinite(ms) ? ms : null;
}

// Проверка полей турнира из админ-формы. Возвращает { value } или { error, message }.
function tournamentFromBody(b) {
  b = b || {};
  const bad = (message) => ({ error: "invalid_tournament", message });
  const title = String(b.title || "").trim().slice(0, 80);
  if (title.length < 3) return bad("Название — минимум 3 символа");
  const startsAt = toMs(b.startsAt);
  if (!startsAt) return bad("Укажите дату и время начала");
  const durationMin = Number(b.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < 10 || durationMin > 240) return bad("Длительность — от 10 до 240 минут");
  if (!Modes.isValid(b.tc)) return bad("Неизвестный контроль времени");
  const maxPlayers = Number(b.maxPlayers || 500);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 2000) return bad("Лимит участников — от 2 до 2000");
  const qualifyTop = Number(b.qualifyTop || 16);
  if (!Number.isInteger(qualifyTop) || qualifyTop < 2 || qualifyTop > 64) return bad("Проходят в финал — от 2 до 64");
  const stage = T_STAGES.has(b.stage) ? b.stage : "single";
  return {
    value: {
      title, subtitle: String(b.subtitle || "").trim().slice(0, 80), description: String(b.description || "").slice(0, 3000),
      stage, startsAt, durationMin, tc: b.tc, maxPlayers, qualifyTop, parentId: b.parentId ? String(b.parentId) : null,
    },
  };
}

app.get("/api/admin/tournaments", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const list = await listTournaments();
    const out = [];
    for (const t of list) out.push(tournamentView(t, { playersCount: await countTournamentPlayers(t.id), tcId: t.tc, rawStartsAt: t.startsAt }));
    res.set("Cache-Control", "no-store");
    res.json({ tournaments: out });
  } catch (err) {
    console.error("❌ GET /api/admin/tournaments:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/admin/tournaments", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const parsed = tournamentFromBody(req.body);
    if (parsed.error) return res.status(400).json(parsed);
    const t = await createTournament({ ...parsed.value, status: "draft" });
    res.status(201).json(tournamentView(t, { tcId: t.tc }));
  } catch (err) {
    console.error("❌ POST /api/admin/tournaments:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.put("/api/admin/tournaments/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const t = await getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: "tournament_not_found" });
    const parsed = tournamentFromBody({ ...t, ...req.body });
    if (parsed.error) return res.status(400).json(parsed);
    const v = parsed.value;
    // Когда турнир уже идёт или закончен, правила и время менять нельзя — только тексты.
    const editable = t.status === "draft" || t.status === "registration";
    const patch = editable ? v : { title: v.title, subtitle: v.subtitle, description: v.description };
    const updated = await updateTournament(t.id, patch);
    await refreshTournamentCache();
    res.json(tournamentView(updated, { tcId: updated.tc }));
  } catch (err) {
    console.error("❌ PUT /api/admin/tournaments:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/admin/tournaments/:id/open", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const t = await getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: "tournament_not_found" });
    if (t.status !== "draft") return res.status(400).json({ error: "bad_status" });
    if (t.startsAt < Date.now() + 60 * 1000) return res.status(400).json({ error: "start_in_past", message: "Время начала должно быть в будущем — поправьте дату" });
    const updated = await updateTournament(t.id, { status: "registration" });
    await refreshTournamentCache();
    res.json(tournamentView(updated, { tcId: updated.tc }));
  } catch (err) {
    console.error("❌ open tournament:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

// Вручную занести финалистов (обычно это происходит само по окончании квалификации).
app.post("/api/admin/tournaments/:id/seed", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const t = await getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: "tournament_not_found" });
    if (t.stage !== "final" || !t.parentId) return res.status(400).json({ error: "not_final" });
    if (t.status !== "draft" && t.status !== "registration") return res.status(400).json({ error: "bad_status" });
    const parent = await getTournament(t.parentId);
    if (!parent || parent.status !== "finished") return res.status(400).json({ error: "parent_not_finished", message: "Квалификация ещё не завершена" });
    const n = await seedFinalists(t, parent);
    res.json({ seeded: n });
  } catch (err) {
    console.error("❌ seed finalists:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/admin/tournaments/:id/cancel", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const t = await getTournament(req.params.id);
    if (!t) return res.status(404).json({ error: "tournament_not_found" });
    if (t.status === "finished" || t.status === "cancelled") return res.status(400).json({ error: "bad_status" });
    const updated = await updateTournament(t.id, { status: "cancelled" });
    closeTournamentRuntime(t.id, "cancelled");
    await refreshTournamentCache();
    res.json(tournamentView(updated, { tcId: updated.tc }));
  } catch (err) {
    console.error("❌ cancel tournament:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.get("/api/admin/db-status", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await dbStatus());
  } catch (err) {
    console.error("❌ db-status:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

// Лёгкий эндпоинт для keep-alive пинга (см. секцию ниже) — не трогает
// хранилище и не отдаёт файлы, отвечает мгновенно.
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

const server = http.createServer(app);

/* ============================================================
   WEBSOCKET — ПАРТИИ МЕЖДУ ЛЮДЬМИ
   ============================================================
   Партия ведётся ПОД КОНТРОЛЕМ СЕРВЕРА (как и партии с ботом):
     • сервер сам проверяет каждый ход по правилам;
     • сервер сам ведёт шахматные часы (клиент только показывает);
     • сервер сам определяет мат, пат, ничью, просрочку времени, сдачу;
     • клиент не может «заявить победу» — сообщение game_over от клиента игнорируется.
   Это нужно для честных рейтинговых партий и тем более — для турнира.

   Часы: у каждого игрока base секунд + inc секунд за каждый ход.
   Часы стартуют после первых ходов обеих сторон (ply >= 2); до этого
   действует лимит на первый ход (FIRST_MOVE_MS) — не сходил, партия
   отменяется (рейтинг не меняется).
   ============================================================ */

const wss = new WebSocketServer({ server, path: "/ws" });

let queue = [];               // ожидающие соперника: { ws, uid, name, rating, tc, since }
const rooms = new Map();      // roomId -> комната (см. createRoom)

const FIRST_MOVE_MS = 45 * 1000;
const FIRST_MOVE_TOURNAMENT_MS = 30 * 1000;
const RECONNECT_GRACE_MS = 45 * 1000;
const INVITE_TTL_MS = 90 * 1000;

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.missedPongs >= 2) { ws.terminate(); return; }
    ws.missedPongs = (ws.missedPongs || 0) + 1;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_INTERVAL_MS);

function sendTo(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function isInRoom(ws) {
  for (const room of rooms.values()) {
    if (room.white === ws || room.black === ws) return true;
  }
  return false;
}

function countTournamentRooms(tid) {
  let n = 0;
  for (const r of rooms.values()) if (r.tournamentId === tid) n++;
  return n;
}
function isUidInTournamentRoom(tid, uid) {
  for (const r of rooms.values()) if (r.tournamentId === tid && (r.whiteUid === uid || r.blackUid === uid)) return true;
  return false;
}

wss.on("connection", (ws) => {
  ws.missedPongs = 0;
  ws.friendGen = 0;         // «поколение» запроса кода — чтобы отмена не гонялась с созданием
  ws.friendFails = 0;       // неудачные вводы чужого кода подряд
  ws.friendBlockedUntil = 0;
  ws.msgBucket = { t: Date.now(), n: 0 };
  ws.on("pong", () => { ws.missedPongs = 0; });

  ws.on("message", (raw) => {
    // Простейшая защита от флуда: не больше 40 сообщений в секунду с одного сокета.
    const now = Date.now();
    if (now - ws.msgBucket.t > 1000) ws.msgBucket = { t: now, n: 0 };
    if (++ws.msgBucket.n > 40) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const fail = (name) => (err) => console.error(`❌ ${name}:`, err.message);

    switch (msg.type) {
      case "auth": authSocket(ws, msg).catch(fail("auth")); break;

      case "find_opponent": findOpponent(ws, msg).catch(fail("find_opponent")); break;
      case "cancel_search": queue = queue.filter((q) => q.ws !== ws); break;

      case "friend_create": friendCreate(ws, msg).catch(fail("friend_create")); break;
      case "friend_resume": friendResume(ws, msg); break;
      case "friend_cancel": ws.friendGen++; removeFriendCodesOf(ws); break;
      case "friend_join":
        friendJoin(ws, msg).catch((err) => {
          console.error("❌ friend_join:", err.message);
          sendTo(ws, { type: "friend_error", reason: "server_error" });
        });
        break;

      case "invite_send": inviteSend(ws, msg).catch(fail("invite_send")); break;
      case "invite_accept": inviteAccept(ws, msg); break;
      case "invite_decline": inviteDecline(ws, msg); break;
      case "invite_cancel": inviteCancel(ws, msg); break;

      case "bot_start":
        leaveTournamentPools(ws);
        botStart(ws, msg).catch((err) => {
          console.error("❌ bot_start:", err.message);
          sendTo(ws, { type: "bot_error", reason: "server_error" });
        });
        break;
      case "bot_move": botPlayerMove(ws, msg).catch(fail("bot_move")); break;
      case "bot_resign": botResign(ws, msg).catch(fail("bot_resign")); break;
      case "bot_resume": botResume(ws, msg); break;

      case "move": roomMove(ws, msg).catch(fail("move")); break;
      case "resign": roomResign(ws, msg); break;
      case "draw_offer": roomDrawOffer(ws, msg); break;
      case "draw_accept": roomDrawAccept(ws, msg); break;
      case "draw_decline": roomDrawDecline(ws, msg); break;
      case "game_resume": roomResume(ws, msg); break;
      // «game_over» от клиента больше НЕ принимается: итог определяет только сервер.

      case "t_ready": tournamentReady(ws, msg).catch(fail("t_ready")); break;
      case "t_pause": tournamentPause(ws, msg).catch(fail("t_pause")); break;
    }
  });

  ws.on("close", () => {
    queue = queue.filter((q) => q.ws !== ws);
    unbindPresence(ws);
    leaveTournamentPools(ws);
    dropInvitesOf(ws);
    // Код друга НЕ удаляем сразу: игрок мог просто свернуть мини-приложение,
    // чтобы отправить код в чат, — при этом мобильная ОС часто обрывает сокет.
    detachFriendCodesFrom(ws);
    // Партию тоже не бросаем сразу: даём время вернуться (сеть моргнула, свернули
    // приложение). Часы при этом идут, а если не вернётся — партия проиграна.
    for (const room of rooms.values()) {
      const side = room.white === ws ? "w" : room.black === ws ? "b" : null;
      if (side) onSideDisconnected(room, side);
    }
  });
});

// Привязка сокета к аккаунту: нужна, чтобы игрок был «в сети» для друзей и
// получал приглашения и уведомления, даже когда не играет.
async function authSocket(ws, msg) {
  if (!msg.token) return;
  try {
    const payload = jwt.verify(msg.token, JWT_SECRET);
    const user = await getUser(payload.uid);
    if (!user || ws.readyState !== ws.OPEN) return;
    bindPresence(ws, user.uid);
    sendTo(ws, { type: "auth_ok", uid: user.uid });
  } catch {
    sendTo(ws, { type: "auth_failed" });
  }
}

// Личность игрока: если прислан валидный токен — берём личность и рейтинг из
// базы (клиенту не доверяем, иначе можно подделать себе рейтинг). Без токена
// или с невалидным — пускаем играть гостем: свежий одноразовый uid, рейтинг
// по умолчанию, результат партии нигде не сохраняется.
// tcId (необязательно) — режим игры: тогда rating = рейтинг ИМЕННО в этом режиме.
async function identify(ws, token, tcId) {
  let user = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      user = (await getUser(payload.uid)) || defaultUser(payload.uid);
    } catch {
      // невалидный/просроченный токен — не ошибка, просто играем гостем
    }
  }

  const isGuest = !user;
  let rating = isGuest ? 1200 : user.rating ?? 1200;
  const tc = tcId && Modes.get(tcId);
  if (!isGuest && tc) {
    const mr = await getModeRatings(user.uid);
    if (mr[tc.cat]) rating = mr[tc.cat].rating;
  }
  ws.playerInfo = isGuest
    ? { uid: `guest-${crypto.randomBytes(6).toString("hex")}`, name: "Гость", rating, guest: true }
    : { uid: user.uid, name: user.name || "Игрок", rating, generalRating: user.rating ?? 1200, publicId: user.publicId, guest: false };
  if (!isGuest) bindPresence(ws, user.uid);
  return ws.playerInfo;
}

/* ------------------------------------------------------------
   Случайный соперник. Подбор — в рамках одного режима (контроля времени),
   по близости рейтинга: окно допустимой разницы растёт, пока игрок ждёт.
   ------------------------------------------------------------ */
async function findOpponent(ws, msg) {
  const tcId = Modes.isValid(msg.tc) ? msg.tc : Modes.DEFAULT_CONTROL;
  await identify(ws, msg.token, tcId);
  if (ws.readyState !== ws.OPEN) return;
  if (isInRoom(ws)) { sendTo(ws, { type: "search_error", reason: "busy" }); return; }

  // Передумал играть с другом / в турнире — ищет случайного.
  ws.friendGen++;
  removeFriendCodesOf(ws);
  leaveTournamentPools(ws);

  queue = queue.filter((q) => q.ws.readyState === ws.OPEN && q.ws !== ws);
  queue.push({ ws, ...ws.playerInfo, tc: tcId, since: Date.now() });
  tryMatch();
}

const MATCH_BASE_WINDOW = 200;       // допустимая разница рейтингов сразу…
const MATCH_WINDOW_PER_SEC = 60;     // …и на сколько расширяется за секунду ожидания

function tryMatch() {
  const now = Date.now();
  queue = queue.filter((q) => q.ws.readyState === q.ws.OPEN);
  const used = new Set();
  const pairs = [];
  for (const a of queue) {            // очередь в порядке прихода — дольше ждущие первыми
    if (used.has(a)) continue;
    let best = null, bestDiff = Infinity;
    for (const b of queue) {
      if (b === a || used.has(b) || b.tc !== a.tc) continue;
      if (!a.guest && a.uid === b.uid) continue;          // два окна одного аккаунта
      const waitedSec = Math.max(now - a.since, now - b.since) / 1000;
      const diff = Math.abs(a.rating - b.rating);
      if (diff <= MATCH_BASE_WINDOW + waitedSec * MATCH_WINDOW_PER_SEC && diff < bestDiff) { best = b; bestDiff = diff; }
    }
    if (best) { used.add(a); used.add(best); pairs.push([a, best]); }
  }
  for (const [a, b] of pairs) createRoom(a, b, { tc: a.tc });
}
setInterval(() => { if (queue.length >= 2) tryMatch(); }, 2000);

/* ------------------------------------------------------------
   КОМНАТА (партия)
   a/b: { ws, uid, name, rating, guest }
   opts: { tc, friend, tournamentId, white (какой из a/b играет белыми) }
   ------------------------------------------------------------ */
function createRoom(a, b, opts = {}) {
  queue = queue.filter((q) => q.ws !== a.ws && q.ws !== b.ws);
  removeFriendCodesOf(a.ws);
  removeFriendCodesOf(b.ws);

  const tc = Modes.get(Modes.isValid(opts.tc) ? opts.tc : Modes.DEFAULT_CONTROL);
  const roomId = crypto.randomBytes(6).toString("hex");
  const aIsWhite = opts.white ? opts.white === a : Math.random() < 0.5;
  const white = aIsWhite ? a : b;
  const black = aIsWhite ? b : a;

  const room = {
    id: roomId, tcId: tc.id, tc, mode: tc.cat,
    white: white.ws, black: black.ws,
    whiteUid: white.uid, blackUid: black.uid,
    whiteGuest: !!white.guest, blackGuest: !!black.guest,
    whiteName: white.name, blackName: black.name,
    whiteRating: white.rating, blackRating: black.rating,
    // Партия с другом и приглашение — товарищеские: рейтинг, статистика и история не меняются.
    friend: !!opts.friend,
    tournamentId: opts.tournamentId || null,
    game: new ChessRules(), moves: [],
    clock: { w: tc.base * 1000, b: tc.base * 1000 },
    turnStartedAt: Date.now(),
    firstMoveMs: opts.tournamentId ? FIRST_MOVE_TOURNAMENT_MS : FIRST_MOVE_MS,
    secret: { w: crypto.randomBytes(12).toString("hex"), b: crypto.randomBytes(12).toString("hex") },
    timer: null, disc: { w: null, b: null }, drawOffer: null, done: false,
  };
  rooms.set(roomId, room);
  armRoomTimer(room);

  const info = (p) => ({ uid: p.uid, name: p.name, rating: p.rating, guest: !!p.guest, publicId: p.publicId || null });
  const common = {
    type: "match_found", roomId, friend: room.friend, tournamentId: room.tournamentId,
    rated: !room.friend && !room.tournamentId, tc, clock: { ...room.clock },
  };
  sendTo(white.ws, { ...common, color: "white", secret: room.secret.w, opponent: info(black) });
  sendTo(black.ws, { ...common, color: "black", secret: room.secret.b, opponent: info(white) });
  return room;
}

function sideOf(room, ws) {
  return room.white === ws ? "w" : room.black === ws ? "b" : null;
}

// Состояние для (пере)подключившегося или рассинхронизированного клиента.
function roomStatePayload(room, side) {
  return {
    type: "game_state", roomId: room.id, color: side === "w" ? "white" : "black",
    moves: room.moves, clock: { ...room.clock }, turn: room.game.turn(), ply: room.moves.length,
    tc: room.tc, friend: room.friend, tournamentId: room.tournamentId,
    rated: !room.friend && !room.tournamentId,
    opponent: side === "w"
      ? { uid: room.blackUid, name: room.blackName, rating: room.blackRating }
      : { uid: room.whiteUid, name: room.whiteName, rating: room.whiteRating },
    drawOffer: room.drawOffer,
  };
}

// Оставшееся время игрока, чьи часы сейчас идут (с учётом уже прошедшего).
function liveClock(room) {
  const c = { ...room.clock };
  if (room.moves.length >= 2) {
    const turn = room.game.turn();
    c[turn] = Math.max(0, c[turn] - (Date.now() - room.turnStartedAt));
  }
  return c;
}

function armRoomTimer(room) {
  clearTimeout(room.timer);
  if (room.done) return;
  const elapsed = Date.now() - room.turnStartedAt;
  const ms = room.moves.length < 2
    ? room.firstMoveMs - elapsed
    : room.clock[room.game.turn()] - elapsed;
  room.timer = setTimeout(() => onRoomTimer(room).catch((e) => console.error("❌ onRoomTimer:", e.message)), Math.max(0, ms) + 40);
  if (room.timer.unref) room.timer.unref();
}

// Есть ли у стороны материал, которым можно поставить мат (для «время вышло»).
function hasMatingMaterial(game, color) {
  let minors = 0;
  for (const row of game.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color || cell.type === "k") continue;
      if (cell.type === "p" || cell.type === "r" || cell.type === "q") return true;
      minors++;
    }
  }
  return minors >= 2;
}

async function onRoomTimer(room) {
  if (room.done) return;
  const turn = room.game.turn();
  if (room.moves.length < 2) {
    // Не сделан первый ход: партия отменяется, нарушитель получает паузу в турнире.
    await finishRoom(room, "abort", "no_first_move", { culprit: turn });
    return;
  }
  const left = room.clock[turn] - (Date.now() - room.turnStartedAt);
  if (left > 50) { armRoomTimer(room); return; }
  room.clock[turn] = 0;
  const opp = turn === "w" ? "b" : "w";
  if (!hasMatingMaterial(room.game, opp)) await finishRoom(room, "draw", "timeout_insufficient");
  else await finishRoom(room, turn === "w" ? "black" : "white", "timeout");
}

async function roomMove(ws, msg) {
  const room = rooms.get(String(msg.roomId || ""));
  if (!room || room.done) return;
  const side = sideOf(room, ws);
  if (!side) return;
  if (room.game.turn() !== side) { sendTo(ws, { ...roomStatePayload(room, side), type: "move_rejected" }); return; }

  const now = Date.now();
  const ply = room.moves.length;
  if (ply >= 2) {
    const used = now - room.turnStartedAt;
    if (used >= room.clock[side]) {
      room.clock[side] = 0;
      const opp = side === "w" ? "b" : "w";
      await finishRoom(room, !hasMatingMaterial(room.game, opp) ? "draw" : side === "w" ? "black" : "white",
        !hasMatingMaterial(room.game, opp) ? "timeout_insufficient" : "timeout");
      return;
    }
  }

  const from = String(msg.from || ""), to = String(msg.to || "");
  const promotion = /^[qrbn]$/i.test(String(msg.promotion || "")) ? String(msg.promotion).toLowerCase() : undefined;
  const res = /^[a-h][1-8]$/.test(from) && /^[a-h][1-8]$/.test(to) ? room.game.move({ from, to, promotion }) : null;
  if (!res) { sendTo(ws, { ...roomStatePayload(room, side), type: "move_rejected" }); return; }

  if (ply >= 2) {
    room.clock[side] = room.clock[side] - (now - room.turnStartedAt) + room.tc.inc * 1000;
  }
  room.moves.push(moveRecord(res));
  room.drawOffer = null;
  room.turnStartedAt = now;

  const clock = { ...room.clock };
  const opponentWs = side === "w" ? room.black : room.white;
  sendTo(opponentWs, { type: "move", roomId: room.id, from, to, promotion: res.promotion || null, clock, ply: room.moves.length });
  sendTo(ws, { type: "move_ack", roomId: room.id, clock, ply: room.moves.length });

  if (room.game.in_checkmate()) { await finishRoom(room, side === "w" ? "white" : "black", "checkmate"); return; }
  if (room.game.in_draw()) { await finishRoom(room, "draw", room.game.in_stalemate() ? "stalemate" : "draw_rule"); return; }
  armRoomTimer(room);
}

function roomResign(ws, msg) {
  const room = rooms.get(String(msg.roomId || ""));
  if (!room || room.done) return;
  const side = sideOf(room, ws);
  if (!side) return;
  finishRoom(room, side === "w" ? "black" : "white", "resign").catch((e) => console.error("❌ resign:", e.message));
}

function roomDrawOffer(ws, msg) {
  const room = rooms.get(String(msg.roomId || ""));
  if (!room || room.done || room.moves.length < 2) return;
  const side = sideOf(room, ws);
  if (!side || room.drawOffer === side) return;
  room.drawOffer = side;
  sendTo(side === "w" ? room.black : room.white, { type: "draw_offered", roomId: room.id });
}
function roomDrawAccept(ws, msg) {
  const room = rooms.get(String(msg.roomId || ""));
  if (!room || room.done) return;
  const side = sideOf(room, ws);
  if (!side || !room.drawOffer || room.drawOffer === side) return;
  finishRoom(room, "draw", "agreement").catch((e) => console.error("❌ draw:", e.message));
}
function roomDrawDecline(ws, msg) {
  const room = rooms.get(String(msg.roomId || ""));
  if (!room || room.done) return;
  const side = sideOf(room, ws);
  if (!side || !room.drawOffer || room.drawOffer === side) return;
  room.drawOffer = null;
  sendTo(side === "w" ? room.black : room.white, { type: "draw_declined", roomId: room.id });
}

/* ---------- обрыв связи и возвращение ---------- */

function onSideDisconnected(room, side) {
  if (room.done) return;
  clearTimeout(room.disc[side]);
  const other = side === "w" ? room.black : room.white;
  sendTo(other, { type: "opponent_disconnected", graceMs: RECONNECT_GRACE_MS });
  room.disc[side] = setTimeout(() => {
    if (room.done) return;
    const otherSide = side === "w" ? "b" : "w";
    const otherGone = !(otherSide === "w" ? room.white : room.black) || (otherSide === "w" ? room.white : room.black).readyState !== 1;
    // Не вернулись оба — отменяем; не вернулся один — он проиграл.
    const p = otherGone
      ? finishRoom(room, "abort", "both_left")
      : finishRoom(room, side === "w" ? "black" : "white", "abandoned");
    p.catch((e) => console.error("❌ abandon:", e.message));
  }, RECONNECT_GRACE_MS);
  if (room.disc[side].unref) room.disc[side].unref();
}

function roomResume(ws, msg) {
  const room = rooms.get(String(msg.roomId || ""));
  if (!room || room.done) { sendTo(ws, { type: "game_gone", roomId: msg.roomId }); return; }
  const secret = String(msg.secret || "");
  const side = safeEqualStr(secret, room.secret.w) ? "w" : safeEqualStr(secret, room.secret.b) ? "b" : null;
  if (!side) { sendTo(ws, { type: "game_gone", roomId: msg.roomId }); return; }
  clearTimeout(room.disc[side]);
  room.disc[side] = null;
  if (side === "w") room.white = ws; else room.black = ws;
  if (ws.presenceUid == null) {
    const uid = side === "w" ? room.whiteUid : room.blackUid;
    if (!String(uid).startsWith("guest-")) bindPresence(ws, uid);
  }
  sendTo(ws, roomStatePayload(room, side));
  sendTo(side === "w" ? room.black : room.white, { type: "opponent_reconnected" });
}

/* ---------- завершение партии и подсчёт итогов ---------- */

// outcome: "white" | "black" | "draw" | "abort". reason — для показа игроку.
async function finishRoom(room, outcome, reason, extra = {}) {
  if (room.done) return;
  room.done = true;
  clearTimeout(room.timer);
  clearTimeout(room.disc.w);
  clearTimeout(room.disc.b);
  // Комнату закрываем СРАЗУ, до обращений к базе: итог засчитывается ровно один раз.
  rooms.delete(room.id);

  const plies = room.moves.length;
  const base = { type: "game_over", roomId: room.id, reason, plies, tc: room.tc, tournamentId: room.tournamentId, moves: room.moves.length };
  const wsW = room.white, wsB = room.black;
  const perSide = { w: { ...base }, b: { ...base } };

  try {
    if (outcome === "abort") {
      perSide.w.result = perSide.b.result = "aborted";
      Object.assign(perSide.w, { ratingDelta: 0, saved: false, rated: false });
      Object.assign(perSide.b, { ratingDelta: 0, saved: false, rated: false });
      if (room.tournamentId) await onTournamentAbort(room, extra.culprit);
    } else {
      const resW = outcome === "white" ? "win" : outcome === "black" ? "loss" : "draw";
      const resB = outcome === "white" ? "loss" : outcome === "black" ? "win" : "draw";
      perSide.w.result = resW;
      perSide.b.result = resB;
      if (room.tournamentId) await settleTournamentGame(room, resW, resB, plies, perSide);
      else if (room.friend) {
        for (const s of ["w", "b"]) Object.assign(perSide[s], { ratingDelta: 0, saved: false, rated: false });
      } else await settleRatedGame(room, resW, resB, perSide);
    }
  } catch (err) {
    console.error("❌ finishRoom (итоги не записаны):", err.message);
    for (const s of ["w", "b"]) Object.assign(perSide[s], { ratingDelta: 0, saved: false, rated: false, error: true });
    if (!perSide.w.result) perSide.w.result = outcome === "white" ? "win" : outcome === "black" ? "loss" : "draw";
    if (!perSide.b.result) perSide.b.result = outcome === "black" ? "win" : outcome === "white" ? "loss" : "draw";
  }

  sendTo(wsW, perSide.w);
  sendTo(wsB, perSide.b);

  if (room.tournamentId) afterTournamentGame(room);
  else {
    for (const uid of [room.whiteUid, room.blackUid]) checkAchievements(uid);
  }
}

// Рейтинговая партия: Эло считается по рейтингу ИМЕННО в этом режиме (пуля/блиц/рапид/классика),
// общий рейтинг в шапке двигается на ту же величину.
async function settleRatedGame(room, resW, resB, perSide) {
  const scoreW = resW === "win" ? 1 : resW === "loss" ? 0 : 0.5;
  const dW = eloDelta(room.whiteRating, room.blackRating, scoreW);
  const dB = eloDelta(room.blackRating, room.whiteRating, 1 - scoreW);
  const players = [
    { s: "w", uid: room.whiteUid, guest: room.whiteGuest, delta: dW, result: resW, modeRating: room.whiteRating, oppName: room.blackName },
    { s: "b", uid: room.blackUid, guest: room.blackGuest, delta: dB, result: resB, modeRating: room.blackRating, oppName: room.whiteName },
  ];
  for (const p of players) {
    if (p.guest) {
      // Гостю рейтинг считаем и показываем, но не сохраняем.
      Object.assign(perSide[p.s], { ratingDelta: p.delta, saved: false, rated: true, modeRating: p.modeRating + p.delta });
      continue;
    }
    const user = await applyResult(p.uid, { ratingDelta: p.delta, result: p.result });
    const mr = await applyModeResult(p.uid, room.mode, { ratingDelta: p.delta, result: p.result, seedRating: p.modeRating });
    await addGameRecord(p.uid, { opponentName: p.oppName, result: p.result, ratingDelta: p.delta, mode: room.mode, timeControl: room.tcId });
    Object.assign(perSide[p.s], { ratingDelta: p.delta, saved: true, rated: true, newRating: user.rating, modeRating: mr.rating });
  }
}


/* ============================================================
   ИГРА С ДРУГОМ ПО КОДУ
   ============================================================
   Игрок A нажимает «Играть с другом» → сервер выдаёт ему короткий код,
   который действует 10 минут. Игрок B вводит этот код → сервер сразу
   создаёт партию между ними (цвета случайные, как и при обычном подборе).
   Код одноразовый: после начала партии, отмены или истечения срока он
   удаляется.
   ============================================================ */

const FRIEND_CODE_TTL_MS = 10 * 60 * 1000;
// Без похожих символов (0/O, 1/I/L), чтобы код легко диктовать и вводить с телефона.
const FRIEND_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const FRIEND_CODE_LENGTH = 6;
const FRIEND_MAX_FAILS = 8;               // столько неверных кодов подряд…
const FRIEND_BLOCK_MS = 30 * 1000;        // …и подбор блокируется на 30 секунд

// code -> { code, ws, player, secret, expiresAt, timer }
// ws может быть null — это значит, что хозяин кода временно отключился.
const friendCodes = new Map();

function generateFriendCode() {
  for (let attempt = 0; attempt < 30; attempt++) {
    let code = "";
    for (let i = 0; i < FRIEND_CODE_LENGTH; i++) {
      code += FRIEND_CODE_ALPHABET[crypto.randomInt(FRIEND_CODE_ALPHABET.length)];
    }
    if (!friendCodes.has(code)) return code;
  }
  return null;
}

function removeFriendCode(code) {
  const entry = friendCodes.get(code);
  if (!entry) return;
  clearTimeout(entry.timer);
  friendCodes.delete(code);
}

function removeFriendCodesOf(ws) {
  for (const [code, entry] of friendCodes.entries()) {
    if (entry.ws === ws) removeFriendCode(code);
  }
}

function detachFriendCodesFrom(ws) {
  for (const entry of friendCodes.values()) {
    if (entry.ws === ws) entry.ws = null;
  }
}

function expireFriendCode(code) {
  const entry = friendCodes.get(code);
  if (!entry) return;
  friendCodes.delete(code);
  sendTo(entry.ws, { type: "friend_code_expired" });
}

async function friendCreate(ws, msg) {
  const gen = ++ws.friendGen;
  const tcId = Modes.isValid(msg.tc) ? msg.tc : Modes.DEFAULT_CONTROL;
  const player = await identify(ws, msg.token, tcId);
  // Пока шли запросы к базе, игрок мог закрыть окно или отключиться.
  if (ws.readyState !== ws.OPEN || gen !== ws.friendGen) return;

  if (isInRoom(ws)) { sendTo(ws, { type: "friend_error", reason: "busy" }); return; }

  queue = queue.filter((q) => q.ws !== ws);
  removeFriendCodesOf(ws);
  leaveTournamentPools(ws);

  const code = generateFriendCode();
  if (!code) { sendTo(ws, { type: "friend_error", reason: "server_error" }); return; }

  const secret = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + FRIEND_CODE_TTL_MS;
  friendCodes.set(code, {
    code, ws, player, secret, expiresAt, tc: tcId,
    timer: setTimeout(() => expireFriendCode(code), FRIEND_CODE_TTL_MS),
  });

  // secret нужен только хозяину кода — чтобы «забрать» код обратно после
  // переподключения. Второму игроку он никогда не отправляется.
  sendTo(ws, { type: "friend_code", code, secret, expiresAt, tc: Modes.get(tcId) });
}

function friendResume(ws, msg) {
  const code = String(msg.code || "").toUpperCase();
  const entry = friendCodes.get(code);
  const secretOk =
    entry &&
    typeof msg.secret === "string" &&
    msg.secret.length === entry.secret.length &&
    crypto.timingSafeEqual(Buffer.from(msg.secret), Buffer.from(entry.secret));

  if (!entry || !secretOk || entry.expiresAt <= Date.now()) {
    sendTo(ws, { type: "friend_code_expired" });
    return;
  }
  if (isInRoom(ws)) return;

  entry.ws = ws;
  ws.playerInfo = entry.player;
  sendTo(ws, { type: "friend_code", code: entry.code, secret: entry.secret, expiresAt: entry.expiresAt, resumed: true, tc: Modes.get(entry.tc) });
}

async function friendJoin(ws, msg) {
  const now = Date.now();
  if (now < ws.friendBlockedUntil) {
    sendTo(ws, { type: "friend_error", reason: "rate_limited" });
    return;
  }

  const code = String(msg.code || "").trim().toUpperCase();
  const registerFail = () => {
    ws.friendFails++;
    if (ws.friendFails >= FRIEND_MAX_FAILS) {
      ws.friendFails = 0;
      ws.friendBlockedUntil = Date.now() + FRIEND_BLOCK_MS;
    }
  };

  if (!new RegExp(`^[${FRIEND_CODE_ALPHABET}]{${FRIEND_CODE_LENGTH}}$`).test(code)) {
    registerFail();
    sendTo(ws, { type: "friend_error", reason: "not_found" });
    return;
  }

  const player = await identify(ws, msg.token);
  if (ws.readyState !== ws.OPEN) return;

  // Поиск и удаление кода — синхронно, без await между ними: если два игрока
  // одновременно введут один код, партию получит только первый.
  const entry = friendCodes.get(code);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) removeFriendCode(code);
    registerFail();
    sendTo(ws, { type: "friend_error", reason: "not_found" });
    return;
  }

  const isOwnCode = entry.ws === ws || (!entry.player.guest && !player.guest && entry.player.uid === player.uid);
  if (isOwnCode) {
    sendTo(ws, { type: "friend_error", reason: "own_code" });
    return;
  }
  if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) {
    sendTo(ws, { type: "friend_error", reason: "host_offline" });
    return;
  }
  if (isInRoom(entry.ws) || isInRoom(ws)) {
    sendTo(ws, { type: "friend_error", reason: "busy" });
    return;
  }

  ws.friendFails = 0;
  removeFriendCode(code);
  leaveTournamentPools(entry.ws);
  leaveTournamentPools(ws);
  createRoom({ ws: entry.ws, ...entry.player }, { ws, ...player }, { friend: true, tc: entry.tc });
}


/* ============================================================
   ПРИГЛАШЕНИЕ ДРУГА СЫГРАТЬ
   ============================================================
   Друг должен быть в сети (открыто приложение). Приглашение живёт
   90 секунд; партия товарищеская (без рейтинга), в выбранном режиме.
   ============================================================ */

const invites = new Map();   // inviteId -> { id, fromUid, fromWs, toUid, tc, timer }

function closeInvite(inv, notify) {
  clearTimeout(inv.timer);
  invites.delete(inv.id);
  if (notify) notifyUser(inv.toUid, { type: "invite_closed", inviteId: inv.id });
}

function dropInvitesOf(ws) {
  for (const inv of [...invites.values()]) {
    if (inv.fromWs === ws) {
      closeInvite(inv, true);
    }
  }
}

async function inviteSend(ws, msg) {
  if (!ws.presenceUid) { sendTo(ws, { type: "invite_error", reason: "not_authed" }); return; }
  const fromUid = ws.presenceUid;
  const toUid = String(msg.toUid || "");
  const tcId = Modes.isValid(msg.tc) ? msg.tc : Modes.DEFAULT_CONTROL;
  if (toUid === fromUid) { sendTo(ws, { type: "invite_error", reason: "self" }); return; }
  if (!(await areFriends(fromUid, toUid))) { sendTo(ws, { type: "invite_error", reason: "not_friends" }); return; }
  if (!isOnline(toUid)) { sendTo(ws, { type: "invite_error", reason: "offline" }); return; }
  if (isInRoom(ws)) { sendTo(ws, { type: "invite_error", reason: "busy" }); return; }

  // У одного игрока — одно исходящее приглашение за раз.
  for (const inv of [...invites.values()]) if (inv.fromUid === fromUid) closeInvite(inv, true);

  const me = await getUser(fromUid);
  if (!me || ws.readyState !== ws.OPEN) return;
  const inv = { id: crypto.randomBytes(6).toString("hex"), fromUid, fromWs: ws, toUid, tc: tcId, timer: null };
  const expiresAt = Date.now() + INVITE_TTL_MS;
  inv.timer = setTimeout(() => {
    if (!invites.has(inv.id)) return;
    closeInvite(inv, true);
    sendTo(inv.fromWs, { type: "invite_expired", inviteId: inv.id });
  }, INVITE_TTL_MS);
  if (inv.timer.unref) inv.timer.unref();
  invites.set(inv.id, inv);

  sendTo(ws, { type: "invite_sent", inviteId: inv.id, toUid, tc: Modes.get(tcId), expiresAt });
  notifyUser(toUid, { type: "invite_received", inviteId: inv.id, from: playerCard(me), tc: Modes.get(tcId), expiresAt });
}

function inviteAccept(ws, msg) {
  const inv = invites.get(String(msg.inviteId || ""));
  if (!inv || inv.toUid !== ws.presenceUid) { sendTo(ws, { type: "invite_error", reason: "expired" }); return; }
  if (inv.fromWs.readyState !== inv.fromWs.OPEN || isInRoom(inv.fromWs)) {
    closeInvite(inv, true);
    sendTo(ws, { type: "invite_error", reason: "sender_gone" });
    return;
  }
  if (isInRoom(ws)) { sendTo(ws, { type: "invite_error", reason: "busy" }); return; }

  closeInvite(inv, true); // остальным окнам получателя — «приглашение закрыто»
  Promise.all([getUser(inv.fromUid), getUser(inv.toUid)]).then(([from, to]) => {
    if (!from || !to || inv.fromWs.readyState !== inv.fromWs.OPEN || ws.readyState !== ws.OPEN) return;
    const pa = { ws: inv.fromWs, uid: from.uid, name: from.name, rating: from.rating, publicId: from.publicId, guest: false };
    const pb = { ws, uid: to.uid, name: to.name, rating: to.rating, publicId: to.publicId, guest: false };
    leaveTournamentPools(pa.ws); leaveTournamentPools(pb.ws);
    createRoom(pa, pb, { friend: true, tc: inv.tc });
  }).catch((e) => console.error("❌ invite_accept:", e.message));
}

function inviteDecline(ws, msg) {
  const inv = invites.get(String(msg.inviteId || ""));
  if (!inv || inv.toUid !== ws.presenceUid) return;
  closeInvite(inv, true);
  getUser(inv.toUid).then((u) => sendTo(inv.fromWs, { type: "invite_declined", inviteId: inv.id, name: u ? u.name : "Друг" })).catch(() => {});
}

function inviteCancel(ws, msg) {
  const inv = invites.get(String(msg.inviteId || ""));
  if (!inv || inv.fromWs !== ws) return;
  closeInvite(inv, true);
}


function eloDelta(myRating, oppRating, score) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
  return Math.round(K * (score - expected));
}

/* ============================================================
   ПАРТИИ С БОТОМ (с рейтингом или без — выбирает игрок)
   ============================================================
   Партия ведётся ПОД КОНТРОЛЕМ СЕРВЕРА: он проверяет каждый ход игрока по
   правилам, САМ выбирает ходы бота (в отдельном потоке — см. bot-pool.js) и
   сам определяет мат/пат/ничью. Клиенту достаточно присылать свои ходы —
   заявить «я выиграл» или подделать партию он не может.

   msg.rated (bot_start) решает, что будет с исходом:
     • rated=true  — требует аккаунт (иначе login_required), рейтинг считается
       по Эло относительно фиксированного рейтинга бота: победа над сильным
       даёт много очков, над слабым — почти ничего, поэтому «накручивать» на
       лёгком боте бессмысленно;
     • rated=false — доступно и гостю; рейтинг, статистика и история партий
       не меняются вовсе (как в товарищеской партии с другом), но ходы
       всё так же проверяет сервер.

   Партия живёт в памяти сервера. Если игрок пропал (сеть, свернул
   приложение), она ждёт его: при возвращении клиент присылает
   bot_resume и продолжает с того же места. Если игрок не возвращается,
   рейтинговая партия через BOT_IDLE_MS засчитывается как поражение (иначе
   можно было бы бросать проигрываемые партии без последствий); партия без
   рейтинга по истечении того же срока просто закрывается.
   ============================================================ */

// Рейтинги ботов — оценка их силы (можно менять). Клиент показывает те же числа.
const BOT_RATINGS = { 1: 700, 2: 1100, 3: 1700 };
const BOT_NAMES = { 1: "Лёгкий", 2: "Средний", 3: "Сильный" };
const BOT_IDLE_MS = Number(process.env.BOT_IDLE_MS) || 15 * 60 * 1000;
const BOT_FINISHED_KEEP_MS = 10 * 60 * 1000;
const BOT_L3_MS = Number(process.env.BOT_L3_MS) || 1500; // лимит на ход «Сильного»

const botGames = new Map();          // gameId -> сессия
const botGameByUid = new Map();      // uid -> gameId (не больше одной партии на игрока)
const finishedBotGames = new Map();  // gameId -> { secret, payload } — чтобы отдать итог вернувшемуся игроку

function safeEqualStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function botStatePayload(s) {
  return {
    type: "bot_state", gameId: s.id, secret: s.secret, level: s.level, human: s.human,
    moves: s.moves, thinking: s.thinking, rated: s.rated,
  };
}

function touchBotGame(s) {
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    finishBotGame(s, "loss", "timeout").catch((err) => console.error("❌ bot timeout:", err.message));
  }, BOT_IDLE_MS);
  if (s.timer.unref) s.timer.unref();
}

function moveRecord(res) {
  const rec = { from: res.from, to: res.to };
  if (res.promotion) rec.promotion = res.promotion;
  return rec;
}

// Итог партии с точки зрения ИГРОКА или null, если партия продолжается.
function botOutcome(s) {
  if (s.game.in_checkmate()) return s.game.turn() === s.human ? "loss" : "win";
  if (s.game.in_draw()) return "draw";
  return null;
}

async function botStart(ws, msg) {
  // Партия без рейтинга на сервере доступна и гостю (свежий одноразовый uid от identify);
  // рейтинговая — только с аккаунтом, иначе её не к чему было бы прибавлять.
  const rated = msg.rated !== false;
  const player = await identify(ws, msg.token);
  if (ws.readyState !== ws.OPEN) return;
  if (rated && player.guest) { sendTo(ws, { type: "bot_error", reason: "login_required" }); return; }

  const level = Number(msg.level);
  if (!BOT_RATINGS[level]) { sendTo(ws, { type: "bot_error", reason: "bad_request" }); return; }
  if (msg.color !== "w" && msg.color !== "b" && msg.color !== "r") { sendTo(ws, { type: "bot_error", reason: "bad_request" }); return; }
  if (isInRoom(ws)) { sendTo(ws, { type: "bot_error", reason: "busy" }); return; }

  const human = msg.color === "r" ? (Math.random() < 0.5 ? "w" : "b") : msg.color;
  const s = {
    id: crypto.randomBytes(8).toString("hex"),
    secret: crypto.randomBytes(16).toString("hex"),
    uid: player.uid, ws, level, human, rated,
    game: new ChessRules(), moves: [], humanMoves: 0,
    thinking: false, done: false, timer: null,
  };
  // Регистрируем новую партию синхронно — двойной bot_start не создаст две.
  const oldId = botGameByUid.get(player.uid);
  botGames.set(s.id, s);
  botGameByUid.set(player.uid, s.id);
  touchBotGame(s);

  // Начатую, но не законченную прежнюю партию с ботом нельзя просто «перезапустить»:
  // иначе проигрываемую партию можно было бы бросать без последствий. Она
  // засчитывается (поражение, если игрок успел сделать хоть один ход).
  const old = oldId && botGames.get(oldId);
  if (old) await finishBotGame(old, "loss", "replaced");

  // Если первым ходит бот — запускаем расчёт ДО отправки состояния: requestBotMove
  // синхронно выставляет thinking=true, и клиент знает, что ответ придёт.
  if (human === "b") requestBotMove(s);
  sendTo(ws, botStatePayload(s));
}

async function botPlayerMove(ws, msg) {
  const s = botGames.get(String(msg.gameId || ""));
  if (!s || s.done || s.ws !== ws) { sendTo(ws, { type: "bot_error", reason: "not_found", gameId: msg.gameId }); return; }
  if (s.thinking || s.game.turn() !== s.human) { sendTo(ws, botStatePayload(s)); return; }

  const from = String(msg.from || ""), to = String(msg.to || "");
  const promotion = /^[qrbn]$/i.test(String(msg.promotion || "")) ? String(msg.promotion).toLowerCase() : undefined;
  const res = /^[a-h][1-8]$/.test(from) && /^[a-h][1-8]$/.test(to) ? s.game.move({ from, to, promotion }) : null;
  if (!res) {
    // Клиент прислал невозможный ход (рассинхрон) — возвращаем его на актуальную позицию.
    sendTo(ws, { type: "bot_error", reason: "illegal_move", gameId: s.id });
    sendTo(ws, botStatePayload(s));
    return;
  }
  s.moves.push(moveRecord(res));
  s.humanMoves++;
  touchBotGame(s);

  const outcome = botOutcome(s);
  if (outcome) await finishBotGame(s, outcome, "game");
  else requestBotMove(s);
}

async function requestBotMove(s) {
  if (s.done) return;
  s.thinking = true;
  const req = { moves: s.moves.slice(), level: s.level };
  if (s.level === 3) req.timeMs = BOT_L3_MS;

  let move = null;
  try {
    move = await computeBotMove(req, (req.timeMs || 2500) + 6000);
  } catch (err) {
    console.error("⚠️ бот не смог посчитать ход, ходим запасным способом:", err.message);
  }
  if (s.done) return; // пока бот думал, партия закончилась (сдача, таймаут)

  let res = move ? s.game.move({ from: move.from, to: move.to, promotion: move.promotion }) : null;
  if (!res) {
    // Запасной вариант: любой легальный ход — партия не должна зависнуть.
    const legal = s.game.moves({ verbose: true });
    if (legal.length) {
      const pick = legal[Math.floor(Math.random() * legal.length)];
      res = s.game.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
    }
  }
  s.thinking = false;
  if (res) s.moves.push(moveRecord(res));
  touchBotGame(s);

  const outcome = botOutcome(s);
  // Итог отправляем ВМЕСТЕ с ходом бота — клиент сначала покажет ход, потом результат.
  const over = outcome ? await finishBotGame(s, outcome, "game", { deferSend: true }) : null;
  sendTo(s.ws, { type: "bot_reply", gameId: s.id, move: res ? moveRecord(res) : null, over });
}

async function botResign(ws, msg) {
  const s = botGames.get(String(msg.gameId || ""));
  if (!s || s.done || s.ws !== ws) { sendTo(ws, { type: "bot_error", reason: "not_found", gameId: msg.gameId }); return; }
  await finishBotGame(s, "loss", "resign");
}

// Игрок вернулся (переподключился сокет или перезапустил приложение).
function botResume(ws, msg) {
  const gameId = String(msg.gameId || "");
  const secret = String(msg.secret || "");
  const s = botGames.get(gameId);
  if (s) {
    if (!safeEqualStr(secret, s.secret)) { sendTo(ws, { type: "bot_error", reason: "not_found", gameId }); return; }
    s.ws = ws;
    touchBotGame(s);
    sendTo(ws, botStatePayload(s));
    return;
  }
  const fin = finishedBotGames.get(gameId);
  if (fin && safeEqualStr(secret, fin.secret)) { sendTo(ws, fin.payload); return; }
  sendTo(ws, { type: "bot_error", reason: "not_found", gameId });
}

// result — с точки зрения игрока. reason: "game" | "resign" | "timeout" | "replaced".
// Для s.rated=true считает рейтинг и сохраняет статистику (партия без единого
// хода игрока — брошена сразу — не засчитывается; сдача засчитывается всегда).
// Для s.rated=false просто завершает партию, ничего не записывая в базу.
async function finishBotGame(s, result, reason, opts = {}) {
  if (s.done) return null;
  s.done = true;
  s.thinking = false;
  clearTimeout(s.timer);
  botGames.delete(s.id);
  if (botGameByUid.get(s.uid) === s.id) botGameByUid.delete(s.uid);

  let payload;
  if (!s.rated) {
    // Партия без рейтинга (в том числе у гостя): рейтинг, статистика и история
    // не трогаются вообще — как в товарищеской партии с другом.
    payload = { type: "bot_over", gameId: s.id, result, rated: false, reason };
  } else {
    // Партия без единого хода игрока (брошена сразу) не засчитывается; сдача — всегда.
    const counts = s.humanMoves > 0 || reason === "game" || reason === "resign";
    if (!counts) {
      payload = { type: "bot_over", gameId: s.id, result: "cancelled", rated: false, reason };
    } else {
      const user = (await getUser(s.uid)) || defaultUser(s.uid);
      const score = result === "win" ? 1 : result === "loss" ? 0 : 0.5;
      const delta = eloDelta(user.rating, BOT_RATINGS[s.level], score);
      // Атомарно в базе: параллельные партии/задачи не затирают друг другу рейтинг.
      const updated = await applyResult(s.uid, { ratingDelta: delta, result });
      await addGameRecord(s.uid, { opponentName: `Бот · ${BOT_NAMES[s.level]}`, result, ratingDelta: delta, mode: "bot" });
      checkAchievements(s.uid, s.level === 3 && result === "win" ? ["beat_strong_bot"] : []);
      payload = {
        type: "bot_over", gameId: s.id, result, rated: true, reason,
        ratingDelta: delta, user: sanitizeUser(updated),
      };
    }
  }

  // Итог храним ещё некоторое время: игрок, вернувшийся после обрыва, получит его.
  finishedBotGames.set(s.id, { secret: s.secret, payload });
  const t = setTimeout(() => finishedBotGames.delete(s.id), BOT_FINISHED_KEEP_MS);
  if (t.unref) t.unref();

  if (!opts.deferSend) sendTo(s.ws, payload);
  return payload;
}

/* ============================================================
   ТУРНИР: АРЕНА (Shahmatista Unicum Cup 2026)
   ============================================================
   Как это работает во время турнира:
     • Игрок нажимает «В бой» → сообщение t_ready → попадает в пул «готовых».
     • Раз в 2 секунды сервер подбирает пары из пула (tournament-engine.js)
       и создаёт серверные партии с часами турнира.
     • Партия закончилась → очки записаны в базу → игрок АВТОМАТИЧЕСКИ
       встаёт в пул за следующей, пока не нажмёт «Пауза» или турнир не кончится.
     • Время вышло → новых пар нет, доигрываются начатые партии, затем
       места фиксируются, победителям выдаются награды, а из квалификации
       лучшие автоматически попадают в финал.

   БАЗА ТРОГАЕТСЯ ТОЛЬКО ТОГДА, КОГДА ЕСТЬ ЧТО ПИСАТЬ: пока турниров в
   ближайшее время нет, таймер ничего не спрашивает у базы (иначе
   бесплатный Neon никогда не засыпал бы и «съедал» часы). Список активных
   турниров держится в памяти и обновляется при запуске, при действиях
   админа и когда кто-то открывает страницу турниров.
   ============================================================ */

const tRuntime = new Map();   // tid -> { pool: Map<uid, entry> }
let tCache = [];              // турниры в статусах registration/running
let tCacheLoaded = false;
const finalizing = new Set();
const FINALIZE_FORCE_AFTER_MS = 20 * 60 * 1000;

async function refreshTournamentCache() {
  tCache = await listTournaments(["registration", "running"]);
  tCacheLoaded = true;
  // Турнир, которого больше нет среди активных, чистим из памяти.
  for (const tid of [...tRuntime.keys()]) if (!tCache.some((t) => t.id === tid)) tRuntime.delete(tid);
}

function getRuntime(tid) {
  if (!tRuntime.has(tid)) tRuntime.set(tid, { pool: new Map() });
  return tRuntime.get(tid);
}

function leaveTournamentPools(ws) {
  for (const rt of tRuntime.values()) {
    for (const [uid, e] of rt.pool) if (e.ws === ws) rt.pool.delete(uid);
  }
}

function closeTournamentRuntime(tid, why) {
  const rt = tRuntime.get(tid);
  if (!rt) return;
  for (const e of rt.pool.values()) sendTo(e.ws, { type: "t_over", tournamentId: tid, why });
  tRuntime.delete(tid);
}

async function tournamentReady(ws, msg) {
  const uid = ws.presenceUid;
  if (!uid) { sendTo(ws, { type: "t_error", reason: "login_required" }); return; }
  const tid = String(msg.tid || "");
  const t = await getTournament(tid);
  const now = Date.now();
  if (!t || t.status !== "running" || !Engine.isPairingOpen(t, now)) { sendTo(ws, { type: "t_error", reason: "not_running", tournamentId: tid }); return; }
  if (isInRoom(ws)) { sendTo(ws, { type: "t_error", reason: "busy" }); return; }

  let tp = await getTournamentPlayer(tid, uid);
  if (!tp) {
    // Поздняя регистрация в уже идущую арену — можно (кроме финала).
    if (t.stage === "final") { sendTo(ws, { type: "t_error", reason: "invite_only" }); return; }
    if ((await countTournamentPlayers(tid)) >= t.maxPlayers) { sendTo(ws, { type: "t_error", reason: "full" }); return; }
    await joinTournament(tid, uid);
    dropStandingsCache(tid);
    tp = await getTournamentPlayer(tid, uid);
  }
  const user = await getUser(uid);
  if (!user || ws.readyState !== ws.OPEN) return;
  const mr = await getModeRatings(uid);
  const tcCat = Modes.get(t.tc).cat;

  // Игрок выбрал турнир — снимаем его с обычного поиска и кодов друга.
  queue = queue.filter((q) => q.ws !== ws);
  ws.friendGen++;
  removeFriendCodesOf(ws);
  await setTournamentActive(tid, uid, true);

  const rt = getRuntime(tid);
  rt.pool.set(uid, {
    ws, uid, name: user.name, publicId: user.publicId, rating: (mr[tcCat] && mr[tcCat].rating) || user.rating,
    score: tp.score, since: Date.now(), lastOpp: tp.lastOpp, lastColor: rt.lastColor && rt.lastColor.get(uid),
  });
  sendTo(ws, { type: "t_queued", tournamentId: tid });
  pairTournament(t);
}

async function tournamentPause(ws, msg) {
  const uid = ws.presenceUid;
  const tid = String(msg.tid || "");
  const rt = tRuntime.get(tid);
  if (rt && uid) rt.pool.delete(uid);
  if (uid) await setTournamentActive(tid, uid, false);
  sendTo(ws, { type: "t_paused", tournamentId: tid });
}

function pairTournament(t) {
  const rt = tRuntime.get(t.id);
  if (!rt || rt.pool.size < 2) return;
  const now = Date.now();
  if (!Engine.isPairingOpen(t, now)) return;
  for (const [uid, e] of rt.pool) {
    if (e.ws.readyState !== e.ws.OPEN || isInRoom(e.ws)) rt.pool.delete(uid);
  }
  if (!rt.lastColor) rt.lastColor = new Map();
  for (const [a, b] of Engine.pickPairs([...rt.pool.values()], now)) {
    rt.pool.delete(a.uid);
    rt.pool.delete(b.uid);
    const w = Engine.pickWhite(a, b);
    const bl = w === a ? b : a;
    rt.lastColor.set(w.uid, "w");
    rt.lastColor.set(bl.uid, "b");
    const pw = { ws: w.ws, uid: w.uid, name: w.name, rating: w.rating, publicId: w.publicId, guest: false };
    const pb = { ws: bl.ws, uid: bl.uid, name: bl.name, rating: bl.rating, publicId: bl.publicId, guest: false };
    createRoom(pw, pb, { tc: t.tc, tournamentId: t.id, white: pw, friend: false });
  }
}

// Записываем очки обоим игрокам. perSide — то, что уйдёт игрокам в game_over.
async function settleTournamentGame(room, resW, resB, plies, perSide) {
  const tid = room.tournamentId;
  const players = [
    { s: "w", uid: room.whiteUid, result: resW, oppUid: room.blackUid, oppRating: room.blackRating, oppName: room.blackName },
    { s: "b", uid: room.blackUid, result: resB, oppUid: room.whiteUid, oppRating: room.whiteRating, oppName: room.whiteName },
  ];
  for (const p of players) {
    const tp = await getTournamentPlayer(tid, p.uid);
    const calc = Engine.arenaPoints((tp && tp.streak) || 0, p.result, plies);
    const row = await applyTournamentResult(tid, p.uid, { points: calc.points, result: p.result, oppRating: p.oppRating, streak: calc.streak, oppUid: p.oppUid });
    await addGameRecord(p.uid, { opponentName: p.oppName, result: p.result, ratingDelta: 0, mode: room.mode, timeControl: room.tcId, tournamentId: tid });
    Object.assign(perSide[p.s], {
      ratingDelta: 0, saved: true, rated: false, tournament: { points: calc.points, total: row ? row.score : null, streak: calc.streak },
    });
    const rt = tRuntime.get(tid);
    const e = rt && rt.pool.get(p.uid);
    if (e && row) { e.score = row.score; e.lastOpp = p.oppUid; }
  }
  await addTournamentGame({ tournamentId: tid, whiteUid: room.whiteUid, blackUid: room.blackUid, result: resW === "win" ? "white" : resW === "loss" ? "black" : "draw", plies });
  dropStandingsCache(tid);
}

// Партия отменена (не сделан первый ход): очков нет, нарушитель — на паузу.
async function onTournamentAbort(room, culprit) {
  const tid = room.tournamentId;
  const bad = [];
  if (culprit === "w") bad.push(room.whiteUid); else if (culprit === "b") bad.push(room.blackUid); else bad.push(room.whiteUid, room.blackUid);
  for (const uid of bad) await setTournamentActive(tid, uid, false);
  room._pausedUids = new Set(bad);
}

// После партии: игрок сам встаёт в очередь за следующей, если турнир ещё идёт.
function afterTournamentGame(room) {
  const tid = room.tournamentId;
  const t = tCache.find((x) => x.id === tid);
  const paused = room._pausedUids || new Set();
  for (const [ws, uid] of [[room.white, room.whiteUid], [room.black, room.blackUid]]) {
    checkAchievements(uid);
    if (!t || !Engine.isPairingOpen(t, Date.now())) continue;
    if (paused.has(uid)) { sendTo(ws, { type: "t_paused", tournamentId: tid, why: "idle" }); continue; }
    if (!ws || ws.readyState !== ws.OPEN) continue;
    // Небольшая задержка: игрок успевает увидеть итог партии.
    setTimeout(() => {
      if (ws.readyState !== ws.OPEN || isInRoom(ws)) return;
      tournamentReady(ws, { tid }).catch(() => {});
    }, 3500);
  }
}

// Финалисты: лучшие игроки квалификации (сыгравшие хотя бы одну партию).
async function seedFinalists(finalT, parentT) {
  const players = await listTournamentPlayers(parentT.id);
  const top = Engine.rankPlayers(players.filter((p) => p.games > 0)).slice(0, finalT.qualifyTop);
  let n = 0;
  for (const p of top) {
    if (await joinTournament(finalT.id, p.uid)) n++;
    notifyUser(p.uid, { type: "cup_qualified", tournamentId: finalT.id, place: p.rank });
  }
  dropStandingsCache(finalT.id);
  for (const p of top) checkAchievements(p.uid);
  return n;
}

// Завершение: места, награды, финал по итогам квалификации.
async function maybeFinalizeTournament(t) {
  if (finalizing.has(t.id)) return;
  const now = Date.now();
  const over = now >= Engine.endsAt(t);
  if (!over) return;
  const rooms_ = countTournamentRooms(t.id);
  if (rooms_ > 0 && now < Engine.endsAt(t) + FINALIZE_FORCE_AFTER_MS) return;

  finalizing.add(t.id);
  try {
    const rt = tRuntime.get(t.id);
    if (rt) for (const e of rt.pool.values()) sendTo(e.ws, { type: "t_over", tournamentId: t.id, why: "finished" });
    tRuntime.delete(t.id);

    const players = await listTournamentPlayers(t.id);
    await setTournamentPlaces(t.id, Engine.finalPlaces(players));
    await updateTournament(t.id, { status: "finished", finishedAt: Date.now() });
    dropStandingsCache(t.id);
    console.log(`🏁 Турнир «${t.title} · ${t.subtitle}» завершён, участников с партиями: ${players.filter((p) => p.games > 0).length}`);

    for (const p of players) {
      checkAchievements(p.uid);
      notifyUser(p.uid, { type: "t_finished", tournamentId: t.id });
    }
    // Квалификация закончилась → лучшие автоматически попадают в финал.
    if (t.stage === "qualifier") {
      const parentNow = await getTournament(t.id);
      const children = (await listTournaments()).filter((x) => x.parentId === t.id && (x.status === "draft" || x.status === "registration"));
      for (const c of children) {
        const n = await seedFinalists(c, parentNow);
        console.log(`🎿 В финал «${c.subtitle}» занесено игроков: ${n}`);
      }
    }
    await refreshTournamentCache();
  } catch (err) {
    console.error("❌ Завершение турнира:", err.message);
  } finally {
    finalizing.delete(t.id);
  }
}

let tournamentTickBusy = false;
async function tournamentTick() {
  if (!tCacheLoaded || tournamentTickBusy) return;
  tournamentTickBusy = true;
  try {
    const now = Date.now();
    for (const t of tCache.slice()) {
      if (Engine.nextStatus(t, now) === "running") {
        await updateTournament(t.id, { status: "running" });
        t.status = "running";
        console.log(`▶️  Турнир «${t.title} · ${t.subtitle}» начался`);
        const tcName = Modes.get(t.tc).label;
        for (const set of presence.values()) for (const w of set) sendTo(w, { type: "t_started", tournamentId: t.id, title: t.subtitle || t.title, tc: tcName });
      }
      if (t.status === "running") {
        if (Engine.isPairingOpen(t, now)) pairTournament(t);
        else await maybeFinalizeTournament(t);
      }
    }
  } catch (err) {
    console.error("❌ tournamentTick:", err.message);
  } finally {
    tournamentTickBusy = false;
  }
}


/* ============================================================
   TELEGRAM BOT
   ============================================================
   На Render (или любом хостинге с постоянным HTTPS-адресом) используем
   вебхук: Telegram сам присылает апдейты POST-запросом на наш сервер.
   Это важно для бесплатного тарифа Render — сервис "засыпает" без
   входящего HTTP-трафика, а входящий вебхук как раз и будит его.
   Long polling в такой схеме не годится: он не создаёт входящих
   запросов и не может разбудить уснувший процесс.
   Если публичного адреса нет (например, локальная разработка без
   туннеля), используем обычный long polling — так проще для теста.
   ============================================================ */

const bot = new TelegramBot(BOT_TOKEN, { polling: !IS_PUBLICLY_REACHABLE });

if (IS_PUBLICLY_REACHABLE) {
  // Токен в пути делает адрес вебхука непредсказуемым для посторонних.
  const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
  app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  const webhookUrl = `${MINI_APP_URL}${WEBHOOK_PATH}`;
  bot.setWebHook(webhookUrl)
    .then(() => console.log(`✅ Вебхук Telegram установлен: ${webhookUrl}`))
    .catch((err) => console.error("❌ Не удалось установить вебхук:", err.message));
} else {
  console.log("ℹ️  Публичный адрес не задан — бот работает через long polling (локальный режим).");
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!MINI_APP_URL) {
    bot.sendMessage(chatId, "T-CHESS почти готов ♟️\nЗадайте MINI_APP_URL в .env, чтобы подключить мини-приложение.");
    return;
  }
  bot.sendMessage(
    chatId,
    "♟️ *T-CHESS* — играйте в шахматы и решайте задачи прямо в Telegram.\n\n" +
      "Организатор турниров: *TikhonCHESS*\nПартнёр проекта: *Блог Шахматиста*",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "♟ Открыть T-CHESS", web_app: { url: MINI_APP_URL } }]],
      },
    }
  );
});

/* ============================================================
   START
   ============================================================ */

server.listen(PORT, () => {
  // Турнир: загрузить активные турниры в память и запустить «часы» арены.
  refreshTournamentCache().catch((err) => console.error("❌ Загрузка турниров:", err.message));
  setInterval(tournamentTick, 3000);

  console.log(`✅ T-CHESS сервер запущен: http://localhost:${PORT}`);
  console.log(`   Мини-приложение раздаётся из папки /public`);
  if (!MINI_APP_URL) {
    console.log("⚠️  Публичный адрес не задан — кнопка в боте не будет работать, пока вы не настроите Render или свой HTTPS-туннель.");
  } else {
    console.log(`   Публичный адрес: ${MINI_APP_URL}`);
  }

  /* ============================================================
     KEEP-ALIVE (анти-сон для Render Free)
     ============================================================
     Бесплатный тариф Render "усыпляет" веб-сервис примерно после
     15 минут без входящих HTTP-запросов. Раз в 10 минут сервис
     дёргает сам себя по своему же публичному адресу — этого
     достаточно, чтобы таймер простоя всегда сбрасывался раньше,
     чем истечёт 15 минут.
     Работает только когда есть публичный адрес (Render или свой
     туннель) — при локальном запуске (npm run dev) не включается,
     там это не нужно.
     Важно: это не гарантия абсолютно вечного аптайма (Render всё
     равно может перезапускать сервис на обслуживание), и на
     бесплатном тарифе есть общий лимит ~750 часов в месяц на все
     бесплатные сервисы аккаунта суммарно — при круглосуточной
     работе одного сервиса это ~720–744 часа, то есть укладывается,
     но впритык, если на аккаунте есть и другие free-сервисы.
     ============================================================ */
  if (IS_PUBLICLY_REACHABLE) {
    const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000; // 10 минут
    setInterval(() => {
      fetch(`${MINI_APP_URL}/health`)
        .then((r) => console.log(`💓 keep-alive пинг: ${r.status}`))
        .catch((err) => console.error("💓 keep-alive пинг не прошёл:", err.message));
    }, KEEP_ALIVE_INTERVAL_MS);
    console.log("💓 Анти-сон включён: самопинг каждые 10 минут");
  }
});

// Деплой/перезапуск: честно закрываем идущие партии (без изменения рейтинга),
// чтобы игроки не сидели перед «зависшей» доской.
process.on("SIGTERM", () => {
  for (const room of rooms.values()) {
    for (const w of [room.white, room.black]) {
      sendTo(w, { type: "game_over", roomId: room.id, result: "aborted", reason: "server_restart", ratingDelta: 0, saved: false, rated: false });
    }
  }
  setTimeout(() => process.exit(0), 1200);
});
