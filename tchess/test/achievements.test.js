const test = require("node:test");
const assert = require("node:assert");
const A = require("../public/achievements");
const M = require("../public/modes");

test("коды достижений уникальны, у каждого есть условие", () => {
  const codes = A.CATALOG.map((a) => a.code);
  assert.strictEqual(new Set(codes).size, codes.length);
  for (const a of A.CATALOG) assert.ok(a.special || (a.metric && a.target), a.code);
});

test("выдаётся только положенное и только ещё не полученное", () => {
  const ctx = { gamesPlayed: 10, wins: 1, streak: 0, rating: 1250, puzzles: 0, friends: 1 };
  const got = A.evaluate(ctx, []);
  assert.ok(got.includes("first_game") && got.includes("games_10") && got.includes("first_win") && got.includes("first_friend"));
  assert.ok(!got.includes("games_50") && !got.includes("rating_1400") && !got.includes("beat_strong_bot"));
  assert.ok(!A.evaluate(ctx, ["first_game"]).includes("first_game"));
});

test("кубок: место ≤ цели; без места ничего не выдаётся", () => {
  assert.ok(!A.evaluate({ cupFinalPlace: null }, []).includes("cup_champion"));
  const first = A.evaluate({ cupFinalPlace: 1 }, []);
  assert.ok(["cup_champion", "cup_silver", "cup_bronze"].every((c) => first.includes(c)));
  const third = A.evaluate({ cupFinalPlace: 3 }, []);
  assert.ok(third.includes("cup_bronze") && !third.includes("cup_silver"));
});

test("режимы: id валидны, часы форматируются", () => {
  assert.ok(M.isValid(M.DEFAULT_CONTROL));
  assert.ok(!M.isValid("blitz_99_9"));
  assert.strictEqual(M.get("blitz_3_2").label, "3+2");
  assert.strictEqual(M.get("rapid_15_10").base, 900);
  assert.strictEqual(M.fmtClock(65000), "01:05");
  assert.strictEqual(M.fmtClock(7400), "0:07.4");
  for (const c of M.CATEGORY_ORDER) assert.ok(M.byCategory(c).length > 0);
});
