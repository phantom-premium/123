/* ============================================================
   ДОСТИЖЕНИЯ
   Каталог — просто данные: у каждого достижения есть код, название,
   значок и условие «метрика >= цель». Сервер по этому же каталогу
   решает, что выдать; клиент — что нарисовать (в том числе полоску
   прогресса у ещё не полученных).

   ВАЖНО: коды (code) — это то, что хранится в базе у игроков.
   Никогда не переименовывайте и не переиспользуйте существующие коды —
   можно добавлять новые и менять тексты/значки.
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TAchievements = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // tier: bronze | silver | gold | legend — влияет только на цвет рамки.
  // metric — поле контекста (см. buildContext в server.js); cmp по умолчанию «>=».
  const CATALOG = [
    // --- партии ---
    { code: "first_game",  group: "Партии", icon: "♟", tier: "bronze", name: "Первый шаг",       desc: "Сыграйте первую партию",  metric: "gamesPlayed", target: 1 },
    { code: "games_10",    group: "Партии", icon: "♞", tier: "bronze", name: "Втянулся",         desc: "Сыграйте 10 партий",      metric: "gamesPlayed", target: 10 },
    { code: "games_50",    group: "Партии", icon: "♝", tier: "silver", name: "Завсегдатай",      desc: "Сыграйте 50 партий",      metric: "gamesPlayed", target: 50 },
    { code: "games_100",   group: "Партии", icon: "♜", tier: "gold",   name: "Сотня",            desc: "Сыграйте 100 партий",     metric: "gamesPlayed", target: 100 },
    { code: "games_500",   group: "Партии", icon: "♛", tier: "legend", name: "Шахматный марафон", desc: "Сыграйте 500 партий",    metric: "gamesPlayed", target: 500 },

    // --- победы ---
    { code: "first_win",   group: "Победы", icon: "🏅", tier: "bronze", name: "Первая кровь",    desc: "Выиграйте первую партию", metric: "wins", target: 1 },
    { code: "wins_10",     group: "Победы", icon: "🥉", tier: "bronze", name: "Десять побед",    desc: "Выиграйте 10 партий",     metric: "wins", target: 10 },
    { code: "wins_50",     group: "Победы", icon: "🥈", tier: "silver", name: "Пятьдесят побед", desc: "Выиграйте 50 партий",     metric: "wins", target: 50 },
    { code: "wins_100",    group: "Победы", icon: "🥇", tier: "gold",   name: "Сотня побед",     desc: "Выиграйте 100 партий",    metric: "wins", target: 100 },

    // --- серии ---
    { code: "streak_3",    group: "Серии", icon: "🔥", tier: "bronze", name: "Горячая рука",  desc: "3 победы подряд",  metric: "streak", target: 3 },
    { code: "streak_5",    group: "Серии", icon: "🔥", tier: "silver", name: "На огне",       desc: "5 побед подряд",   metric: "streak", target: 5 },
    { code: "streak_10",   group: "Серии", icon: "☄️", tier: "gold",   name: "Неудержимый",   desc: "10 побед подряд",  metric: "streak", target: 10 },

    // --- рейтинг ---
    { code: "rating_1400", group: "Рейтинг", icon: "📈", tier: "bronze", name: "Уверенный любитель", desc: "Достигните рейтинга 1400", metric: "rating", target: 1400 },
    { code: "rating_1600", group: "Рейтинг", icon: "📈", tier: "silver", name: "Клубный игрок",      desc: "Достигните рейтинга 1600", metric: "rating", target: 1600 },
    { code: "rating_1800", group: "Рейтинг", icon: "🚀", tier: "gold",   name: "Кандидат",           desc: "Достигните рейтинга 1800", metric: "rating", target: 1800 },
    { code: "rating_2000", group: "Рейтинг", icon: "👑", tier: "legend", name: "Мастер",             desc: "Достигните рейтинга 2000", metric: "rating", target: 2000 },

    // --- задачи ---
    { code: "puzzles_1",   group: "Задачи", icon: "🧩", tier: "bronze", name: "Первая задача",  desc: "Решите первую задачу", metric: "puzzles", target: 1 },
    { code: "puzzles_10",  group: "Задачи", icon: "🧩", tier: "bronze", name: "Тактик",         desc: "Решите 10 задач",      metric: "puzzles", target: 10 },
    { code: "puzzles_50",  group: "Задачи", icon: "🧠", tier: "silver", name: "Мастер тактики", desc: "Решите 50 задач",      metric: "puzzles", target: 50 },
    { code: "puzzles_100", group: "Задачи", icon: "🧠", tier: "gold",   name: "Задачный гуру",  desc: "Решите 100 задач",     metric: "puzzles", target: 100 },

    // --- друзья ---
    { code: "first_friend", group: "Друзья", icon: "🤝", tier: "bronze", name: "Не один",         desc: "Добавьте первого друга", metric: "friends", target: 1 },
    { code: "friends_5",    group: "Друзья", icon: "👥", tier: "silver", name: "Своя компания",   desc: "5 друзей",               metric: "friends", target: 5 },
    { code: "friends_10",   group: "Друзья", icon: "🎉", tier: "gold",   name: "Душа шахмат-клуба", desc: "10 друзей",            metric: "friends", target: 10 },

    // --- режимы ---
    { code: "bullet_10",   group: "Режимы", icon: "⚡", tier: "silver", name: "Пулемётчик",   desc: "10 партий в режиме «Пуля»",     metric: "bulletGames",  target: 10 },
    { code: "blitz_25",    group: "Режимы", icon: "🔥", tier: "silver", name: "Блицер",       desc: "25 партий в режиме «Блиц»",     metric: "blitzGames",   target: 25 },
    { code: "rapid_10",    group: "Режимы", icon: "⏱", tier: "silver", name: "Рапидист",     desc: "10 партий в режиме «Рапид»",    metric: "rapidGames",   target: 10 },
    { code: "classic_5",   group: "Режимы", icon: "🏛", tier: "silver", name: "Классик",      desc: "5 партий в режиме «Классика»",  metric: "classicGames", target: 5 },
    { code: "all_modes",   group: "Режимы", icon: "🎛", tier: "gold",   name: "Универсал",    desc: "Сыграйте хотя бы 3 партии в каждом из 4 режимов", metric: "modesPlayed", target: 4 },

    // --- боты ---
    { code: "beat_strong_bot", group: "Боты", icon: "🤖", tier: "gold", name: "Победитель машины", desc: "Выиграйте у «Сильного» бота в рейтинговой партии", special: true },

    // --- Кубок Unicum 2026 ---
    { code: "cup_participant", group: "Кубок Unicum", icon: "❄️", tier: "bronze", name: "Участник Unicum Cup 2026", desc: "Сыграйте хотя бы одну партию в турнире Кубка", metric: "cupParticipated", target: 1 },
    { code: "cup_finalist",    group: "Кубок Unicum", icon: "🎿", tier: "silver", name: "Финалист Unicum Cup 2026", desc: "Пробейтесь в финал Кубка",                    metric: "cupFinals",       target: 1 },
    { code: "cup_bronze",      group: "Кубок Unicum", icon: "🥉", tier: "silver", name: "Бронзовый кубок Unicum",   desc: "3-е место в финале Кубка",                   metric: "cupFinalPlace",   target: 3, cmp: "lte" },
    { code: "cup_silver",      group: "Кубок Unicum", icon: "🥈", tier: "gold",   name: "Серебряный кубок Unicum",  desc: "2-е место в финале Кубка",                   metric: "cupFinalPlace",   target: 2, cmp: "lte" },
    { code: "cup_champion",    group: "Кубок Unicum", icon: "🏆", tier: "legend", name: "Чемпион Unicum Cup 2026",  desc: "Победите в финале Кубка",                    metric: "cupFinalPlace",   target: 1, cmp: "lte" },
  ];

  const byCode = new Map(CATALOG.map((a) => [a.code, a]));

  function isMet(def, ctx) {
    if (def.special) return false; // выдаётся событием, а не метрикой
    const v = ctx[def.metric];
    if (v === undefined || v === null) return false;
    return def.cmp === "lte" ? v >= 1 && v <= def.target : v >= def.target;
  }

  // Коды, которые по контексту положены, но ещё не получены.
  function evaluate(ctx, alreadyEarned) {
    const have = new Set(alreadyEarned || []);
    return CATALOG.filter((d) => !have.has(d.code) && isMet(d, ctx)).map((d) => d.code);
  }

  // Прогресс для ещё не полученного: [текущее, цель] или null (особое / по месту).
  function progress(def, ctx) {
    if (def.special || def.cmp === "lte") return null;
    const v = Number(ctx[def.metric]) || 0;
    return [Math.min(v, def.target), def.target];
  }

  return { CATALOG, get: (code) => byCode.get(code) || null, evaluate, isMet, progress };
});
