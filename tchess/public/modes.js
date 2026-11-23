/* ============================================================
   РЕЖИМЫ ИГРЫ (контроль времени)
   Один файл для сервера и браузера: сервер по нему проверяет, что
   клиент запросил существующий режим, и выставляет часы; клиент —
   рисует выбор режима.

   Формат id: <категория>_<минуты>_<прибавка в секундах>
   Рейтинг ведётся по КАТЕГОРИЯМ (пуля / блиц / рапид / классика).
   ============================================================ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TModes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CATEGORIES = {
    bullet:  { id: "bullet",  name: "Пуля",     icon: "⚡", hint: "до 2 минут на партию" },
    blitz:   { id: "blitz",   name: "Блиц",     icon: "🔥", hint: "3–5 минут" },
    rapid:   { id: "rapid",   name: "Рапид",    icon: "⏱", hint: "10–15 минут" },
    classic: { id: "classic", name: "Классика", icon: "🏛", hint: "30 минут и больше" },
  };
  const CATEGORY_ORDER = ["bullet", "blitz", "rapid", "classic"];

  // base — секунды на всю партию каждому, inc — прибавка за ход (секунды).
  const CONTROLS = [
    { id: "bullet_1_0",   cat: "bullet",  base: 60,   inc: 0 },
    { id: "bullet_2_1",   cat: "bullet",  base: 120,  inc: 1 },
    { id: "blitz_3_0",    cat: "blitz",   base: 180,  inc: 0 },
    { id: "blitz_3_2",    cat: "blitz",   base: 180,  inc: 2 },
    { id: "blitz_5_0",    cat: "blitz",   base: 300,  inc: 0 },
    { id: "rapid_10_0",   cat: "rapid",   base: 600,  inc: 0 },
    { id: "rapid_15_10",  cat: "rapid",   base: 900,  inc: 10 },
    { id: "classic_30_0", cat: "classic", base: 1800, inc: 0 },
    { id: "classic_30_20", cat: "classic", base: 1800, inc: 20 },
  ];

  // Режим по умолчанию = прежние 5 минут без прибавки.
  const DEFAULT_CONTROL = "blitz_5_0";

  const byId = new Map(CONTROLS.map((c) => [c.id, c]));

  function label(c) {
    return `${Math.round(c.base / 60 * 100) / 100}+${c.inc}`;
  }

  function get(id) {
    const c = byId.get(String(id));
    if (!c) return null;
    return { ...c, label: label(c), category: CATEGORIES[c.cat] };
  }

  function isValid(id) {
    return byId.has(String(id));
  }

  function list() {
    return CONTROLS.map((c) => get(c.id));
  }

  function byCategory(cat) {
    return CONTROLS.filter((c) => c.cat === cat).map((c) => get(c.id));
  }

  // 65432 мс -> "01:05"; меньше 10 секунд показываем десятые ("0:07.4").
  function fmtClock(ms) {
    ms = Math.max(0, Math.ceil(ms));
    if (ms < 10000) {
      const tenths = Math.floor((ms % 1000) / 100);
      return `0:0${Math.floor(ms / 1000)}.${tenths}`;
    }
    const total = Math.ceil(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  return { CATEGORIES, CATEGORY_ORDER, CONTROLS, DEFAULT_CONTROL, get, isValid, list, byCategory, label, fmtClock };
});
