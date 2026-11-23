// Охранный тест: миграции не должны ничего удалять и переименовывать.
// Если вы добавили миграцию и этот тест упал — переделайте её на добавляющую.
const test = require("node:test");
const assert = require("node:assert");
const { MIGRATIONS, makePublicId } = require("../migrations");

const FORBIDDEN = [
  /\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bRENAME\b/i,
  /\bALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN\b/i,
  /\bUPDATE\s+(?!users\s+u\s+SET\s+public_id)\w+/i, // единственное разрешённое UPDATE — заполнение public_id
];

test("миграции только добавляющие", () => {
  for (const m of MIGRATIONS) {
    const src = String(m.up);
    for (const re of FORBIDDEN) assert.ok(!re.test(src), `миграция ${m.id} содержит запрещённое: ${re}`);
  }
});

test("номера миграций идут подряд без пропусков и повторов", () => {
  MIGRATIONS.forEach((m, i) => assert.strictEqual(m.id, i + 1));
});

test("миграция, меняющая данные, объявляет таблицы для снимка", () => {
  const m = MIGRATIONS.find((x) => /UPDATE users u SET public_id/.test(String(x.up)));
  assert.ok(m && m.touches && m.touches.includes("users"));
});

test("public_id: у старых игроков остаётся прежнее значение, при конфликте — новое", () => {
  const taken = new Set();
  const uid = "aaaaaaaa-0000-4000-8000-000000abc123";
  assert.strictEqual(makePublicId(uid, taken), "ABC123"); // как раньше показывал клиент: последние 6 символов uid
  taken.add("ABC123");
  const other = makePublicId("bbbbbbbb-0000-4000-8000-111111abc123", taken); // то же окончание
  assert.notStrictEqual(other, "ABC123");
  assert.match(other, /^[A-Z0-9]{6}$/);
});
