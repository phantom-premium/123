/* Web Worker бота: считает ход вне основного потока, чтобы интерфейс не зависал. */
importScripts("bot-engine.js");

self.onmessage = function (e) {
  const { id, moves, level } = e.data || {};
  try {
    self.postMessage({ id, move: self.BotEngine.chooseMove({ moves: moves || [], level }) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
