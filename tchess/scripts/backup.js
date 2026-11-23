// Полная копия базы в один JSON-файл. Запуск:  npm run backup
// Нужен DATABASE_URL (из .env или окружения). Файл попадёт в backups/ — храните его вне сервера.
// ВНИМАНИЕ: в копии есть хэши паролей — не публикуйте файл.
require("dotenv").config();
const fs = require("fs"), path = require("path");
const { Pool, types } = require("pg");
types.setTypeParser(20, Number);
const TABLES = ["users", "games", "puzzles", "puzzle_solves", "friendships", "friend_requests", "mode_ratings",
  "user_achievements", "tournaments", "tournament_players", "tournament_games", "schema_migrations"];
(async () => {
  if (!process.env.DATABASE_URL) { console.error("Нет DATABASE_URL"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const out = { createdAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    try { out.tables[t] = (await pool.query(`SELECT * FROM ${t}`)).rows; console.log(t.padEnd(20), out.tables[t].length); }
    catch (e) { console.log(t.padEnd(20), "— нет таблицы (пропущено)"); }
  }
  const dir = path.join(__dirname, "..", "backups"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `tchess-${out.createdAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  console.log("\n✅ Копия сохранена:", file);
  await pool.end();
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
