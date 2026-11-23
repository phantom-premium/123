/* ============================================================
   ДВИЖОК ТУРНИРА «АРЕНА» — только чистые функции (без базы и сети),
   поэтому их легко проверять тестами (см. test/tournament.test.js).

   Что такое арена: турнир идёт заданное время (например, 60 минут).
   Игроки заходят и выходят когда хотят, а сервер сам подбирает им
   соперников из тех, кто готов играть. Сыграл партию — встал в очередь
   за следующей. Побеждает тот, кто набрал больше очков к концу времени.

   Очки за партию:
     победа — 2, ничья — 1, поражение — 0;
     «серия»: после двух побед подряд каждая следующая победа стоит
     вдвое больше (4 очка), ничья — 2. Поражение или ничья обрывает серию;
     ничья короче 20 полуходов (10 ходов каждого) не даёт очков —
     это защита от «договорных» ничьих.
   ============================================================ */
"use strict";

const WIN_POINTS = 2;
const DRAW_POINTS = 1;
const STREAK_FOR_DOUBLE = 2;      // столько побед подряд — и очки удваиваются
const DRAW_MIN_PLIES = 20;

// result — «win» | «draw» | «loss» с точки зрения игрока.
// Возвращает начисленные очки и новую длину серии побед.
function arenaPoints(streakBefore, result, plies) {
  const hot = streakBefore >= STREAK_FOR_DOUBLE;
  if (result === "win") {
    return { points: WIN_POINTS * (hot ? 2 : 1), streak: streakBefore + 1 };
  }
  if (result === "draw") {
    const base = plies >= DRAW_MIN_PLIES ? DRAW_POINTS : 0;
    return { points: base * (hot ? 2 : 1), streak: 0 };
  }
  return { points: 0, streak: 0 };
}

// Порядок в таблице: очки → больше побед → «качество» побед (сумма рейтингов
// побеждённых соперников) → кто раньше зарегистрировался.
function compareStandings(a, b) {
  return (
    b.score - a.score ||
    b.wins - a.wins ||
    (b.perf || 0) - (a.perf || 0) ||
    (a.joinedAt || 0) - (b.joinedAt || 0) ||
    String(a.uid).localeCompare(String(b.uid))
  );
}

function rankPlayers(players) {
  return players
    .slice()
    .sort(compareStandings)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

/* ------------------------------------------------------------
   Подбор пар среди «готовых». Элемент пула:
   { uid, score, rating, since (мс, когда встал в очередь), lastOpp, lastColor }
   Жадно идём от лидеров вниз и каждому ищем ближайшего по очкам и рейтингу.
   Только что сыгравших между собой не сводим снова, пока есть выбор;
   если же человек ждёт дольше 30 секунд — разрешаем и повтор (иначе
   вдвоём в пуле они бы никогда не сыграли).
   ------------------------------------------------------------ */
const REMATCH_OK_AFTER_MS = 30 * 1000;

function pickPairs(pool, now) {
  const sorted = pool
    .slice()
    .sort((a, b) => b.score - a.score || (a.since || 0) - (b.since || 0));
  const used = new Set();
  const pairs = [];

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (used.has(a.uid)) continue;
    let best = null;
    let bestCost = Infinity;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (used.has(b.uid)) continue;
      const waited = Math.max(now - (a.since || now), now - (b.since || now));
      const isRematch = a.lastOpp === b.uid || b.lastOpp === a.uid;
      if (isRematch && waited < REMATCH_OK_AFTER_MS) continue;
      const cost =
        Math.abs(a.score - b.score) * 100 +
        Math.abs((a.rating || 0) - (b.rating || 0)) / 4 +
        (isRematch ? 500 : 0);
      if (cost < bestCost) { bestCost = cost; best = b; }
    }
    if (best) {
      used.add(a.uid);
      used.add(best.uid);
      pairs.push([a, best]);
    }
  }
  return pairs;
}

// Кто играет белыми. Стараемся чередовать цвета; при равенстве — по жребию.
function pickWhite(a, b, rnd = Math.random) {
  const aWhiteBias = (a.lastColor === "b" ? 1 : 0) - (a.lastColor === "w" ? 1 : 0);
  const bWhiteBias = (b.lastColor === "b" ? 1 : 0) - (b.lastColor === "w" ? 1 : 0);
  if (aWhiteBias !== bWhiteBias) return aWhiteBias > bWhiteBias ? a : b;
  return rnd() < 0.5 ? a : b;
}

function endsAt(t) {
  return Number(t.startsAt) + Number(t.durationMin) * 60 * 1000;
}

// Что должно произойти с турниром к моменту now. Возвращает новый статус
// из базы («running») или null, если менять нечего. Завершение («finished»)
// ставится отдельно — только когда доиграны все партии.
function nextStatus(t, now) {
  if (t.status === "registration" && now >= Number(t.startsAt)) return "running";
  return null;
}

function isPairingOpen(t, now) {
  return t.status === "running" && now < endsAt(t);
}

// Места после завершения: плоский список {uid, place}.
function finalPlaces(players) {
  return rankPlayers(players.filter((p) => p.games > 0)).map((p) => ({ uid: p.uid, place: p.rank }));
}

module.exports = {
  WIN_POINTS, DRAW_POINTS, DRAW_MIN_PLIES, STREAK_FOR_DOUBLE, REMATCH_OK_AFTER_MS,
  arenaPoints, compareStandings, rankPlayers, pickPairs, pickWhite,
  endsAt, nextStatus, isPairingOpen, finalPlaces,
};
