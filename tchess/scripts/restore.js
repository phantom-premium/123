// БЕЗОПАСНОЕ восстановление: ДОБАВЛЯЕТ из копии только то, чего в базе нет
// (INSERT … ON CONFLICT DO NOTHING). Существующие строки не меняются и не удаляются.
// Запуск:  npm run restore -- backups/файл.json
require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");
(async () => {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error("Использование: npm run restore -- backups/файл.json (нужен DATABASE_URL)"); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  for (const [table, rows] of Object.entries(data.tables)) {
    if (table === "schema_migrations" || !/^[a-z_]+$/.test(table)) continue;
    let added = 0;
    for (const row of rows) {
      // У таблиц с автономером (id SERIAL) нет естественного ключа: id отбрасываем, а дубли
      // отсекаем сравнением всех остальных колонок — повторный запуск ничего не задвоит.
      const serial = table === "games" || table === "tournament_games";
      if (serial) delete row.id;
      const cols = Object.keys(row);
      const vals = cols.map((_, i) => "$" + (i + 1));
      const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${vals.join(",")})${serial ? "" : " ON CONFLICT DO NOTHING"}`;
      if (serial) {
        const dup = await pool.query(`SELECT 1 FROM ${table} WHERE ${cols.map((c, i) => `${c} IS NOT DISTINCT FROM $${i + 1}`).join(" AND ")} LIMIT 1`, cols.map((c) => row[c]));
        if (dup.rowCount) continue;
      }
      try { added += (await pool.query(sql, cols.map((c) => row[c]))).rowCount; } catch (e) { console.log(`  ${table}: пропущена строка (${e.message})`); }
    }
    console.log(table.padEnd(20), `в копии ${rows.length}, добавлено ${added}`);
  }
  await pool.end();
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
