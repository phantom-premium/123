// Проверка хранилища (JSON-режим) — включая главное: СТАРЫЕ ДАННЫЕ ПЕРЕЖИВАЮТ ОБНОВЛЕНИЕ.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tchess-"));
delete process.env.DATABASE_URL; delete process.env.RENDER; delete process.env.NODE_ENV; delete process.env.RENDER_EXTERNAL_URL;
process.env.DATA_DIR = dir;

// --- данные «как у старой версии»: без public_id, без новых файлов ---
const oldUsers = {};
for (let i = 1; i <= 50; i++) {
  const uid = `0000000${i}-aaaa-4bbb-8ccc-0000000000${String(i).padStart(2, "0")}`;
  oldUsers[uid] = { uid, email: `u${i}@x.ru`, passwordHash: "$2a$10$hash" + i, name: "Игрок " + i, rating: 1000 + i * 7, desc: "о себе " + i, gamesPlayed: i, wins: i % 5, losses: 1, draws: 0, streak: i % 3 };
}
fs.writeFileSync(path.join(dir, "users.json"), JSON.stringify(oldUsers));
fs.writeFileSync(path.join(dir, "games.json"), JSON.stringify([{ uid: Object.keys(oldUsers)[0], opponentName: "Бот · Лёгкий", result: "win", ratingDelta: 5, date: 1700000000000 }]));
fs.writeFileSync(path.join(dir, "puzzles.json"), JSON.stringify([{ id: "keep_me", tag: "t", fen: "x", hint: "", solution: [] }]));
fs.writeFileSync(path.join(dir, "puzzle_solves.json"), JSON.stringify({ [Object.keys(oldUsers)[0]]: ["keep_me"] }));

const S = require("../storage");
const uids = Object.keys(oldUsers);

test("ДАННЫЕ СОХРАНЕНЫ: все старые игроки, пароли, рейтинги, партии, задачи на месте", async () => {
  for (const uid of uids) {
    const u = await S.getUser(uid);
    assert.ok(u, "игрок пропал: " + uid);
    assert.strictEqual(u.rating, oldUsers[uid].rating);
    assert.strictEqual(u.passwordHash, oldUsers[uid].passwordHash);
    assert.strictEqual(u.email, oldUsers[uid].email);
    assert.strictEqual(u.desc, oldUsers[uid].desc);
    assert.strictEqual(u.gamesPlayed, oldUsers[uid].gamesPlayed);
  }
  assert.strictEqual((await S.getGames(uids[0])).length, 1);
  assert.deepStrictEqual((await S.listPuzzles()).map((p) => p.id), ["keep_me"]); // стартовый набор НЕ перезаписал
  assert.deepStrictEqual(await S.getSolvedPuzzleIds(uids[0]), ["keep_me"]);
  assert.strictEqual(await S.countSolvedPuzzles(uids[0]), 1);
});

test("public_id выдан всем старым игрокам, уникален, прежний вид сохранён", async () => {
  const ids = [];
  for (const uid of uids) ids.push((await S.getUser(uid)).publicId);
  assert.ok(ids.every(Boolean));
  assert.strictEqual(new Set(ids).size, ids.length);
  // у uid …0000000001 последние 6 символов (без дефисов) = «000001» — как раньше показывал клиент
  assert.strictEqual((await S.getUser(uids[0])).publicId, "000001");
  assert.strictEqual((await S.getUserByPublicId("T-CHESS-000001")).uid, uids[0]);
  assert.strictEqual((await S.getUserByPublicId("t-chess-000001")).uid, uids[0]);
});

test("Кубок Unicum добавлен как ЧЕРНОВИК и не виден игрокам", async () => {
  const all = await S.listTournaments();
  assert.deepStrictEqual(all.map((t) => t.id).sort(), ["unicum-2026-f", "unicum-2026-q"]);
  assert.ok(all.every((t) => t.status === "draft"));
  assert.strictEqual((await S.listTournaments(["registration", "running", "finished"])).length, 0);
});

test("повторный запуск не пересоздаёт и не перезаписывает данные", async () => {
  await S.updateTournament("unicum-2026-q", { title: "Правка админа" });
  const before = fs.readFileSync(path.join(dir, "tournaments.json"), "utf8");
  delete require.cache[require.resolve("../storage")];
  const S2 = require("../storage");
  assert.strictEqual((await S2.getTournament("unicum-2026-q")).title, "Правка админа");
  assert.strictEqual(fs.readFileSync(path.join(dir, "tournaments.json"), "utf8"), before);
});

test("регистрация: новый игрок получает уникальный public_id; поиск находит по имени и ID", async () => {
  const u = await S.createUser({ email: "new@x.ru", passwordHash: "h", name: "Тихон Новый" });
  assert.match(u.publicId, /^[A-Z0-9]{6}$/);
  assert.strictEqual((await S.searchUsers("тихон", 10)).length, 1);
  assert.strictEqual((await S.searchUsers(u.publicId, 10, null))[0].uid, u.uid);
  assert.strictEqual((await S.searchUsers("т", 10)).length, 0); // слишком короткий запрос
  assert.strictEqual((await S.searchUsers("тихон", 10, u.uid)).length, 0); // себя не ищем
});

test("атомарные обновления рейтинга и серии", async () => {
  const uid = uids[1];
  const before = await S.getUser(uid);
  const after = await S.applyResult(uid, { ratingDelta: 12, result: "win" });
  assert.strictEqual(after.rating, before.rating + 12);
  assert.strictEqual(after.gamesPlayed, before.gamesPlayed + 1);
  assert.strictEqual(after.streak, before.streak + 1);
  const lost = await S.applyResult(uid, { ratingDelta: -9, result: "loss" });
  assert.strictEqual(lost.streak, 0);
  assert.strictEqual((await S.addRating(uid, 4)).rating, lost.rating + 4);
});

test("рейтинг по режимам", async () => {
  const uid = uids[2];
  const r1 = await S.applyModeResult(uid, "blitz", { ratingDelta: 10, result: "win", seedRating: 1100 });
  assert.strictEqual(r1.rating, 1110); assert.strictEqual(r1.games, 1);
  const r2 = await S.applyModeResult(uid, "blitz", { ratingDelta: -4, result: "loss", seedRating: 1100 });
  assert.strictEqual(r2.rating, 1106); assert.strictEqual(r2.games, 2);
  assert.deepStrictEqual(Object.keys(await S.getModeRatings(uid)), ["blitz"]);
});

test("друзья и заявки", async () => {
  const [a, b, c] = uids;
  assert.strictEqual(await S.createFriendRequest(a, b), true);
  assert.strictEqual(await S.createFriendRequest(a, b), false); // повтор не создаёт дубль
  assert.strictEqual(await S.hasFriendRequest(a, b), true);
  assert.strictEqual((await S.listIncomingRequests(b))[0].uid, a);
  assert.strictEqual((await S.listOutgoingRequests(a))[0].uid, b);
  assert.strictEqual(await S.addFriendship(b, a), true); // порядок аргументов не важен
  assert.strictEqual(await S.addFriendship(a, b), false);
  await S.deleteFriendRequest(a, b);
  assert.strictEqual(await S.areFriends(a, b), true);
  assert.strictEqual(await S.areFriends(b, a), true);
  assert.strictEqual(await S.areFriends(a, c), false);
  assert.strictEqual(await S.countFriends(a), 1);
  assert.strictEqual((await S.listFriendUids(b))[0].uid, a);
  assert.strictEqual(await S.removeFriendship(b, a), true);
  assert.strictEqual(await S.areFriends(a, b), false);
});

test("достижения выдаются один раз", async () => {
  const uid = uids[3];
  assert.deepStrictEqual(await S.grantAchievements(uid, ["first_game", "first_win"]), ["first_game", "first_win"]);
  assert.deepStrictEqual(await S.grantAchievements(uid, ["first_win", "games_10"]), ["games_10"]);
  assert.strictEqual((await S.getAchievements(uid)).length, 3);
});

test("турнир: регистрация, результаты, места", async () => {
  const [a, b] = uids;
  assert.strictEqual(await S.joinTournament("unicum-2026-q", a), true);
  assert.strictEqual(await S.joinTournament("unicum-2026-q", a), false);
  await S.joinTournament("unicum-2026-q", b);
  assert.strictEqual(await S.countTournamentPlayers("unicum-2026-q"), 2);
  const p = await S.applyTournamentResult("unicum-2026-q", a, { points: 2, result: "win", oppRating: 1300, streak: 1, oppUid: b });
  assert.strictEqual(p.score, 2); assert.strictEqual(p.perf, 1300); assert.strictEqual(p.lastOpp, b);
  assert.strictEqual(await S.leaveTournament("unicum-2026-q", a), false); // сыграл — выйти из списка нельзя
  assert.strictEqual(await S.leaveTournament("unicum-2026-q", b), true);
  await S.setTournamentPlaces("unicum-2026-q", [{ uid: a, place: 1 }]);
  await S.updateTournament("unicum-2026-q", { status: "finished" });
  const res = await S.listUserTournamentResults(a);
  assert.strictEqual(res[0].place, 1);
});

test("статус базы", async () => {
  const st = await S.dbStatus();
  assert.strictEqual(st.mode, "json");
  assert.ok(st.counts.users >= 51);
});

test("на хостинге без DATABASE_URL сервер не стартует (защита от «пустой базы» после деплоя)", () => {
  const { spawnSync } = require("child_process");
  const run = (env) => spawnSync(process.execPath, ["-e", 'require("./storage")'], {
    cwd: path.join(__dirname, ".."), env: { PATH: process.env.PATH, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "g-")), ...env }, encoding: "utf8",
  });
  const blocked = run({ RENDER: "true" });
  assert.strictEqual(blocked.status, 1);
  assert.match(blocked.stderr, /DATABASE_URL/);
  assert.strictEqual(run({ NODE_ENV: "production" }).status, 1);
  assert.strictEqual(run({ RENDER: "true", ALLOW_EPHEMERAL_STORAGE: "1" }).status, 0);
  assert.strictEqual(run({}).status, 0); // локальная разработка — как раньше
});
