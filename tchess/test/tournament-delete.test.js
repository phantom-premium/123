// Удаление отменённого турнира в JSON-хранилище: чистит участников и партии, отвязывает финал.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");

test("deleteTournament удаляет турнир, участников, партии и отвязывает финал", async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tchess-"));
  delete process.env.DATABASE_URL;
  const st = require("../storage");
  const base = { title: "Тест", startsAt: Date.now() + 1e6, durationMin: 60, tc: "blitz_5_0" };
  const a = await st.createTournament({ ...base, status: "cancelled" });
  const b = await st.createTournament({ ...base, stage: "final", parentId: a.id, status: "draft" });
  await st.joinTournament(a.id, "u1");
  await st.addTournamentGame({ tournamentId: a.id, whiteUid: "u1", blackUid: "u2", result: "1-0" });

  assert.strictEqual(await st.deleteTournament(a.id), true);
  assert.strictEqual(await st.getTournament(a.id), null);
  assert.strictEqual(await st.countTournamentPlayers(a.id), 0);
  assert.strictEqual((await st.getTournament(b.id)).parentId, null);
  assert.strictEqual(await st.deleteTournament(a.id), false);
});
