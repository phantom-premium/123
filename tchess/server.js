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
  getUser,
  getUserByEmail,
  createUser,
  upsertUser,
  addGameRecord,
  getGames,
  defaultUser,
  listPuzzles,
  getPuzzle,
  createPuzzle,
  updatePuzzle,
  deletePuzzle,
  getSolvedPuzzleIds,
  markPuzzleSolved,
} = require("./storage");
// Та же проверка FEN/решения, что и в админ-меню в браузере, — но здесь она
// окончательная: в базу попадает только то, что прошло проверку на сервере.
const PuzzleCheck = require("./public/puzzlecheck.js");
// Шахматные правила для судейства партий с ботом (тот же chess.js, что и в браузере).
require("./public/chess.js");
const ChessRules = globalThis.Chess;
const { computeBotMove } = require("./bot-pool");

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
    res.json(sanitizeUser(user));
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
    const user = await upsertUser(req.uid, { rating: current.rating + PUZZLE_RATING_DELTA });
    res.json({ ...sanitizeUser(user), delta: PUZZLE_RATING_DELTA });
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

// Лёгкий эндпоинт для keep-alive пинга (см. секцию ниже) — не трогает
// хранилище и не отдаёт файлы, отвечает мгновенно.
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

const server = http.createServer(app);

/* ============================================================
   WEBSOCKET — ПОИСК СОПЕРНИКА И РЕТРАНСЛЯЦИЯ ХОДОВ
   ============================================================ */

const wss = new WebSocketServer({ server, path: "/ws" });

let queue = [];               // ожидающие соперника: { ws, uid, name, rating }
const rooms = new Map();      // roomId -> { white: ws, black: ws, whiteUid, blackUid }

/* ------------------------------------------------------------
   Heartbeat. Пока игрок ждёт друга (до 10 минут) по сокету ничего
   не передаётся, а прокси/мобильные сети любят молча закрывать такие
   «тихие» соединения. Пинг раз в 30 секунд держит канал живым; клиент
   (браузер) отвечает pong автоматически. Соединение, не ответившее
   дважды подряд, считаем мёртвым и закрываем.
   ------------------------------------------------------------ */
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

wss.on("connection", (ws) => {
  ws.missedPongs = 0;
  ws.friendGen = 0;         // «поколение» запроса кода — чтобы отмена не гонялась с созданием
  ws.friendFails = 0;       // неудачные вводы чужого кода подряд
  ws.friendBlockedUntil = 0;
  ws.on("pong", () => { ws.missedPongs = 0; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "find_opponent") {
      findOpponent(ws, msg).catch((err) => console.error("❌ find_opponent:", err.message));
    }

    if (msg.type === "cancel_search") {
      queue = queue.filter((q) => q.ws !== ws);
    }

    if (msg.type === "friend_create") {
      friendCreate(ws, msg).catch((err) => console.error("❌ friend_create:", err.message));
    }

    if (msg.type === "friend_resume") {
      friendResume(ws, msg);
    }

    if (msg.type === "friend_cancel") {
      ws.friendGen++;
      removeFriendCodesOf(ws);
    }

    if (msg.type === "friend_join") {
      friendJoin(ws, msg).catch((err) => {
        console.error("❌ friend_join:", err.message);
        sendTo(ws, { type: "friend_error", reason: "server_error" });
      });
    }

    if (msg.type === "bot_start") {
      botStart(ws, msg).catch((err) => {
        console.error("❌ bot_start:", err.message);
        sendTo(ws, { type: "bot_error", reason: "server_error" });
      });
    }
    if (msg.type === "bot_move") {
      botPlayerMove(ws, msg).catch((err) => console.error("❌ bot_move:", err.message));
    }
    if (msg.type === "bot_resign") {
      botResign(ws, msg).catch((err) => console.error("❌ bot_resign:", err.message));
    }
    if (msg.type === "bot_resume") {
      botResume(ws, msg);
    }

    if (msg.type === "move") {
      const room = rooms.get(msg.roomId);
      if (!room || (room.white !== ws && room.black !== ws)) return;
      const opponentWs = room.white === ws ? room.black : room.white;
      if (opponentWs && opponentWs.readyState === opponentWs.OPEN) {
        opponentWs.send(JSON.stringify({ type: "move", from: msg.from, to: msg.to, promotion: msg.promotion }));
      }
    }

    if (msg.type === "game_over") {
      handleGameOver(msg, ws).catch((err) => console.error("❌ handleGameOver:", err.message));
    }
  });

  ws.on("close", () => {
    queue = queue.filter((q) => q.ws !== ws);
    // Код друга НЕ удаляем сразу: игрок мог просто свернуть мини-приложение,
    // чтобы отправить код в чат, — при этом мобильная ОС часто обрывает сокет.
    // Код остаётся жить до конца своих 10 минут, а клиент при возвращении
    // переподключается и «забирает» его обратно (friend_resume).
    detachFriendCodesFrom(ws);
    for (const [roomId, room] of rooms.entries()) {
      if (room.white === ws || room.black === ws) {
        const other = room.white === ws ? room.black : room.white;
        if (other && other.readyState === other.OPEN) {
          other.send(JSON.stringify({ type: "opponent_left" }));
        }
        rooms.delete(roomId);
      }
    }
  });
});

// Личность игрока: если прислан валидный токен — берём личность и рейтинг из
// базы (клиенту не доверяем, иначе можно подделать себе рейтинг). Без токена
// или с невалидным — пускаем играть гостем: свежий одноразовый uid, рейтинг
// по умолчанию, результат партии нигде не сохраняется.
async function identify(ws, token) {
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
  ws.playerInfo = isGuest
    ? { uid: `guest-${crypto.randomBytes(6).toString("hex")}`, name: "Гость", rating: 1200, guest: true }
    : { uid: user.uid, name: user.name || "Игрок", rating: user.rating ?? 1200, guest: false };
  return ws.playerInfo;
}

async function findOpponent(ws, msg) {
  await identify(ws, msg.token);
  if (ws.readyState !== ws.OPEN) return;

  // Если игрок до этого создавал код для друга — он передумал и ищет случайного.
  ws.friendGen++;
  removeFriendCodesOf(ws);

  queue = queue.filter((q) => q.ws.readyState === ws.OPEN && q.ws !== ws);
  queue.push({ ws, ...ws.playerInfo });
  tryMatch();
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (a.ws.readyState !== a.ws.OPEN) { queue.unshift(b); continue; }
    if (b.ws.readyState !== b.ws.OPEN) { queue.unshift(a); continue; }
    createRoom(a, b);
  }
}

// Общая точка создания партии — для случайного подбора и для игры по коду.
// a/b: { ws, uid, name, rating, guest }
function createRoom(a, b, opts = {}) {
  queue = queue.filter((q) => q.ws !== a.ws && q.ws !== b.ws);
  removeFriendCodesOf(a.ws);
  removeFriendCodesOf(b.ws);

  const roomId = crypto.randomBytes(6).toString("hex");
  const aIsWhite = Math.random() < 0.5;
  const white = aIsWhite ? a : b;
  const black = aIsWhite ? b : a;

  rooms.set(roomId, {
    white: white.ws, black: black.ws,
    whiteUid: white.uid, blackUid: black.uid,
    whiteGuest: !!white.guest, blackGuest: !!black.guest,
    // Партия с другом — товарищеская: рейтинг, статистика и история не меняются.
    friend: !!opts.friend,
  });

  white.ws.send(JSON.stringify({
    type: "match_found", roomId, color: "white", friend: !!opts.friend,
    opponent: { uid: black.uid, name: black.name, rating: black.rating, guest: !!black.guest },
  }));
  black.ws.send(JSON.stringify({
    type: "match_found", roomId, color: "black", friend: !!opts.friend,
    opponent: { uid: white.uid, name: white.name, rating: white.rating, guest: !!white.guest },
  }));
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
  const player = await identify(ws, msg.token);
  // Пока шли запросы к базе, игрок мог закрыть окно или отключиться.
  if (ws.readyState !== ws.OPEN || gen !== ws.friendGen) return;

  if (isInRoom(ws)) { sendTo(ws, { type: "friend_error", reason: "busy" }); return; }

  queue = queue.filter((q) => q.ws !== ws);
  removeFriendCodesOf(ws);

  const code = generateFriendCode();
  if (!code) { sendTo(ws, { type: "friend_error", reason: "server_error" }); return; }

  const secret = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + FRIEND_CODE_TTL_MS;
  friendCodes.set(code, {
    code, ws, player, secret, expiresAt,
    timer: setTimeout(() => expireFriendCode(code), FRIEND_CODE_TTL_MS),
  });

  // secret нужен только хозяину кода — чтобы «забрать» код обратно после
  // переподключения. Второму игроку он никогда не отправляется.
  sendTo(ws, { type: "friend_code", code, secret, expiresAt });
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
  sendTo(ws, { type: "friend_code", code: entry.code, secret: entry.secret, expiresAt: entry.expiresAt, resumed: true });
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
  createRoom({ ws: entry.ws, ...entry.player }, { ws, ...player }, { friend: true });
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
      const updated = await upsertUser(s.uid, {
        rating: user.rating + delta,
        gamesPlayed: (user.gamesPlayed || 0) + 1,
        wins: (user.wins || 0) + (result === "win" ? 1 : 0),
        losses: (user.losses || 0) + (result === "loss" ? 1 : 0),
        draws: (user.draws || 0) + (result === "draw" ? 1 : 0),
        streak: result === "win" ? (user.streak || 0) + 1 : 0,
      });
      await addGameRecord(s.uid, { opponentName: `Бот · ${BOT_NAMES[s.level]}`, result, ratingDelta: delta });
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

async function handleGameOver(msg, ws) {
  if (msg.result !== "win" && msg.result !== "loss" && msg.result !== "draw") return;
  const room = rooms.get(msg.roomId);
  // Итог принимаем только от участника существующей партии: «сдаться»/«game_over»
  // без партии (или чужой) ничего не меняет ни в рейтинге, ни в статистике.
  if (!room || (room.white !== ws && room.black !== ws)) return;
  // Комнату закрываем СРАЗУ, до обращений к базе. Раньше она удалялась в конце,
  // и если оба клиента одновременно сообщали об окончании (типично при мате),
  // рейтинг обоим засчитывался дважды.
  rooms.delete(msg.roomId);

  const isWhite = room.white === ws;
  const myUid = isWhite ? room.whiteUid : room.blackUid;
  const oppUid = isWhite ? room.blackUid : room.whiteUid;
  const myIsGuest = isWhite ? room.whiteGuest : room.blackGuest;
  const oppIsGuest = isWhite ? room.blackGuest : room.whiteGuest;
  if (!myUid || !oppUid) return;

  // Товарищеская партия с другом: ничего не сохраняем и рейтинг не меняем.
  if (room.friend) {
    const oppWsFriend = isWhite ? room.black : room.white;
    const oppResultFriend = msg.result === "win" ? "loss" : msg.result === "loss" ? "win" : "draw";
    sendTo(ws, { type: "game_over", result: msg.result, ratingDelta: 0, saved: false, rated: false });
    sendTo(oppWsFriend, { type: "game_over", result: oppResultFriend, ratingDelta: 0, saved: false, rated: false });
    return;
  }

  // Для гостя нет записи в базе — используем данные из очереди/подбора
  // (rating при матче) только для расчёта Эло, но ничего не сохраняем.
  const myFallback = { ...defaultUser(myUid), name: "Гость" };
  const oppFallback = { ...defaultUser(oppUid), name: "Гость" };
  const myUser = myIsGuest ? myFallback : (await getUser(myUid)) || defaultUser(myUid);
  const oppUser = oppIsGuest ? oppFallback : (await getUser(oppUid)) || defaultUser(oppUid);

  const score = msg.result === "win" ? 1 : msg.result === "loss" ? 0 : 0.5;
  const myDelta = eloDelta(myUser.rating, oppUser.rating, score);
  const oppDelta = eloDelta(oppUser.rating, myUser.rating, 1 - score);

  const oppResult = msg.result === "win" ? "loss" : msg.result === "loss" ? "win" : "draw";

  if (!myIsGuest) {
    const myStreak = msg.result === "win" ? (myUser.streak || 0) + 1 : 0;
    await upsertUser(myUid, {
      rating: myUser.rating + myDelta,
      gamesPlayed: (myUser.gamesPlayed || 0) + 1,
      wins: (myUser.wins || 0) + (msg.result === "win" ? 1 : 0),
      losses: (myUser.losses || 0) + (msg.result === "loss" ? 1 : 0),
      draws: (myUser.draws || 0) + (msg.result === "draw" ? 1 : 0),
      streak: myStreak,
    });
    await addGameRecord(myUid, { opponentName: oppUser.name, result: msg.result, ratingDelta: myDelta });
  }

  if (!oppIsGuest) {
    await upsertUser(oppUid, {
      rating: oppUser.rating + oppDelta,
      gamesPlayed: (oppUser.gamesPlayed || 0) + 1,
      wins: (oppUser.wins || 0) + (oppResult === "win" ? 1 : 0),
      losses: (oppUser.losses || 0) + (oppResult === "loss" ? 1 : 0),
      draws: (oppUser.draws || 0) + (oppResult === "draw" ? 1 : 0),
      streak: oppResult === "win" ? (oppUser.streak || 0) + 1 : 0,
    });
    await addGameRecord(oppUid, { opponentName: myUser.name, result: oppResult, ratingDelta: oppDelta });
  }

  // Гостю тоже отправляем дельту — рейтинг у него посчитается и покажется
  // в интерфейсе, просто только в рамках текущей сессии, без сохранения.
  ws.send(JSON.stringify({ type: "game_over", result: msg.result, ratingDelta: myDelta, saved: !myIsGuest, rated: true }));
  const oppWs = isWhite ? room.black : room.white;
  if (oppWs && oppWs.readyState === oppWs.OPEN) {
    oppWs.send(JSON.stringify({ type: "game_over", result: oppResult, ratingDelta: oppDelta, saved: !oppIsGuest, rated: true }));
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
