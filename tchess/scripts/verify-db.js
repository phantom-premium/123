// Быстрая проверка: к какой базе подключаемся и сколько в ней данных. Запуск: npm run verify-db
require("dotenv").config();
const { Pool, types } = require("pg");
types.setTypeParser(20, Number);
(async () => {
  if (!process.env.DATABASE_URL) { console.log("⚠️ DATABASE_URL не задан — будет JSON-режим (данные временные)."); return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const host = new URL(process.env.DATABASE_URL).host;
  console.log("База:", host);
  for (const t of ["users", "games", "puzzles", "puzzle_solves"]) {
    try { console.log(t.padEnd(16), (await pool.query(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n); } catch { console.log(t.padEnd(16), "нет"); }
  }
  try { const m = await pool.query("SELECT id, name FROM schema_migrations ORDER BY id"); console.log("\nПрименённые миграции:", m.rows.map((r) => r.id).join(", ")); } catch { console.log("\nМиграции ещё не применялись (первый запуск новой версии их создаст)."); }
  await pool.end();
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
