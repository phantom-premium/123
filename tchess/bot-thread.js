// Рабочий поток для расчёта ходов бота на сервере (запускается из bot-pool.js).
// Поиск хода — это секунды процессорного времени; в отдельном потоке он не
// блокирует основной цикл сервера (WebSocket-партии, вход, API).
const { parentPort } = require("worker_threads");
const engine = require("./public/bot-engine.js");

parentPort.on("message", ({ id, req }) => {
  try {
    parentPort.postMessage({ id, move: engine.chooseMove(req) });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
