const test = require("node:test");
const assert = require("node:assert");
const E = require("../tournament-engine");

test("очки арены: обычная победа, серия, ничьи, поражение", () => {
  assert.deepStrictEqual(E.arenaPoints(0, "win", 40), { points: 2, streak: 1 });
  assert.deepStrictEqual(E.arenaPoints(1, "win", 40), { points: 2, streak: 2 });
  assert.deepStrictEqual(E.arenaPoints(2, "win", 40), { points: 4, streak: 3 }); // серия — очки х2
  assert.deepStrictEqual(E.arenaPoints(5, "draw", 60), { points: 2, streak: 0 });
  assert.deepStrictEqual(E.arenaPoints(0, "draw", 60), { points: 1, streak: 0 });
  assert.deepStrictEqual(E.arenaPoints(0, "draw", 10), { points: 0, streak: 0 }); // короткая ничья
  assert.deepStrictEqual(E.arenaPoints(7, "loss", 50), { points: 0, streak: 0 });
});

test("таблица: очки → победы → качество побед → время регистрации", () => {
  const r = E.rankPlayers([
    { uid: "c", score: 6, wins: 2, perf: 3000, joinedAt: 3 },
    { uid: "a", score: 8, wins: 3, perf: 100, joinedAt: 2 },
    { uid: "b", score: 6, wins: 2, perf: 3500, joinedAt: 1 },
    { uid: "d", score: 6, wins: 3, perf: 0, joinedAt: 9 },
  ]);
  assert.deepStrictEqual(r.map((p) => p.uid), ["a", "d", "b", "c"]);
  assert.deepStrictEqual(r.map((p) => p.rank), [1, 2, 3, 4]);
});

test("подбор пар: ближайший по очкам, без повторов подряд", () => {
  const now = 100000;
  const mk = (uid, score, rating, extra = {}) => ({ uid, score, rating, since: now - 1000, ...extra });
  const pairs = E.pickPairs([mk("a", 10, 1500), mk("b", 0, 1500), mk("c", 9, 1400), mk("d", 1, 1300)], now);
  const ids = pairs.map(([x, y]) => [x.uid, y.uid].sort().join(""));
  assert.deepStrictEqual(ids.sort(), ["ac", "bd"]);

  // только что играли друг с другом и ждут недолго — не сводим
  const rematch = E.pickPairs([mk("a", 2, 1500, { lastOpp: "b" }), mk("b", 2, 1500, { lastOpp: "a" })], now);
  assert.strictEqual(rematch.length, 0);
  // но если ждут дольше 30 секунд — сводим
  const waited = E.pickPairs([mk("a", 2, 1500, { lastOpp: "b", since: now - 40000 }), mk("b", 2, 1500, { lastOpp: "a", since: now - 40000 })], now);
  assert.strictEqual(waited.length, 1);
  // нечётное число — один остаётся без пары
  assert.strictEqual(E.pickPairs([mk("a", 1, 1), mk("b", 1, 1), mk("c", 1, 1)], now).length, 1);
});

test("цвета чередуются", () => {
  const a = { uid: "a", lastColor: "w" }, b = { uid: "b", lastColor: "b" };
  for (let i = 0; i < 20; i++) assert.strictEqual(E.pickWhite(a, b).uid, "b");
});

test("статусы: регистрация → идёт; пары открыты только в окне турнира", () => {
  const t = { status: "registration", startsAt: 1000, durationMin: 1 };
  assert.strictEqual(E.nextStatus(t, 999), null);
  assert.strictEqual(E.nextStatus(t, 1000), "running");
  const run = { ...t, status: "running" };
  assert.strictEqual(E.isPairingOpen(run, 1000 + 59999), true);
  assert.strictEqual(E.isPairingOpen(run, 1000 + 60000), false);
  assert.strictEqual(E.isPairingOpen({ ...t, status: "draft" }, 1500), false);
});

test("места получают только игравшие", () => {
  const p = E.finalPlaces([{ uid: "a", score: 4, wins: 2, games: 3 }, { uid: "z", score: 0, wins: 0, games: 0 }]);
  assert.deepStrictEqual(p, [{ uid: "a", place: 1 }]);
});
