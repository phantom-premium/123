require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const TelegramBot = require("node-telegram-bot-api");
const { getUser, upsertUser, addGameRecord, getGames, defaultUser } = require("./storage");

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
   ПРОВЕРКА TELEGRAM initData
   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
   ============================================================ */

function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return null;

  const userRaw = params.get("user");
  return userRaw ? JSON.parse(userRaw) : null;
}

/* ============================================================
   EXPRESS APP
   ============================================================ */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/auth", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const tgUser = initData ? verifyInitData(initData) : null;
    if (!tgUser) return res.status(401).json({ error: "invalid_init_data" });

    const uid = String(tgUser.id);
    const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || tgUser.username || "Игрок";
    const user = await upsertUser(uid, { name });
    res.json(user);
  } catch (err) {
    console.error("❌ /api/auth:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.post("/api/profile/desc", async (req, res) => {
  try {
    const { uid, desc } = req.body || {};
    if (!uid) return res.status(400).json({ error: "missing_uid" });
    const user = await upsertUser(String(uid), { desc: String(desc || "").slice(0, 120) });
    res.json(user);
  } catch (err) {
    console.error("❌ /api/profile/desc:", err.message);
    res.status(500).json({ error: "storage_error" });
  }
});

app.get("/api/games/:uid", async (req, res) => {
  try {
    const games = await getGames(req.params.uid, 50);
    res.json(games);
  } catch (err) {
    console.error("❌ /api/games/:uid:", err.message);
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

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "find_opponent") {
      ws.playerInfo = { uid: msg.uid, name: msg.name || "Игрок", rating: msg.rating || 1200 };
      queue = queue.filter((q) => q.ws.readyState === ws.OPEN && q.ws !== ws);
      queue.push({ ws, ...ws.playerInfo });
      tryMatch();
    }

    if (msg.type === "cancel_search") {
      queue = queue.filter((q) => q.ws !== ws);
    }

    if (msg.type === "move") {
      const room = rooms.get(msg.roomId);
      if (!room) return;
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

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (a.ws.readyState !== a.ws.OPEN) { queue.unshift(b); continue; }
    if (b.ws.readyState !== b.ws.OPEN) { queue.unshift(a); continue; }

    const roomId = crypto.randomBytes(6).toString("hex");
    const aIsWhite = Math.random() < 0.5;
    const white = aIsWhite ? a : b;
    const black = aIsWhite ? b : a;

    rooms.set(roomId, { white: white.ws, black: black.ws, whiteUid: white.uid, blackUid: black.uid });

    white.ws.send(JSON.stringify({
      type: "match_found", roomId, color: "white",
      opponent: { uid: black.uid, name: black.name, rating: black.rating },
    }));
    black.ws.send(JSON.stringify({
      type: "match_found", roomId, color: "black",
      opponent: { uid: white.uid, name: white.name, rating: white.rating },
    }));
  }
}

function eloDelta(myRating, oppRating, score) {
  const K = 32;
  const expected = 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
  return Math.round(K * (score - expected));
}

async function handleGameOver(msg, ws) {
  const room = rooms.get(msg.roomId);
  if (!room) return;

  const isWhite = room.white === ws;
  const myUid = isWhite ? room.whiteUid : room.blackUid;
  const oppUid = isWhite ? room.blackUid : room.whiteUid;
  if (!myUid || !oppUid) { rooms.delete(msg.roomId); return; }

  const myUser = (await getUser(myUid)) || defaultUser(myUid);
  const oppUser = (await getUser(oppUid)) || defaultUser(oppUid);

  const score = msg.result === "win" ? 1 : msg.result === "loss" ? 0 : 0.5;
  const myDelta = eloDelta(myUser.rating, oppUser.rating, score);
  const oppDelta = eloDelta(oppUser.rating, myUser.rating, 1 - score);

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

  const oppResult = msg.result === "win" ? "loss" : msg.result === "loss" ? "win" : "draw";
  await upsertUser(oppUid, {
    rating: oppUser.rating + oppDelta,
    gamesPlayed: (oppUser.gamesPlayed || 0) + 1,
    wins: (oppUser.wins || 0) + (oppResult === "win" ? 1 : 0),
    losses: (oppUser.losses || 0) + (oppResult === "loss" ? 1 : 0),
    draws: (oppUser.draws || 0) + (oppResult === "draw" ? 1 : 0),
    streak: oppResult === "win" ? (oppUser.streak || 0) + 1 : 0,
  });
  await addGameRecord(oppUid, { opponentName: myUser.name, result: oppResult, ratingDelta: oppDelta });

  ws.send(JSON.stringify({ type: "game_over", result: msg.result, ratingDelta: myDelta }));
  const oppWs = isWhite ? room.black : room.white;
  if (oppWs && oppWs.readyState === oppWs.OPEN && !msg.resigned) {
    oppWs.send(JSON.stringify({ type: "game_over", result: oppResult, ratingDelta: oppDelta }));
  } else if (oppWs && oppWs.readyState === oppWs.OPEN && msg.resigned) {
    oppWs.send(JSON.stringify({ type: "game_over", result: oppResult, ratingDelta: oppDelta }));
  }

  rooms.delete(msg.roomId);
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
