/* ============================================================
   Пул потоков для бота (worker_threads).

   computeBotMove(req, timeoutMs) → Promise<{from,to,promotion?} | null>

   • потоков немного (по умолчанию 2, если ядер больше одного; BOT_WORKERS
     переопределяет) — чтобы бот не съедал весь сервер;
   • запросы стоят в очереди; если поток завис дольше timeoutMs — его
     убивают, а запрос завершается ошибкой (сервер тогда ходит запасным
     способом);
   • упавший поток заменяется новым автоматически.
   ============================================================ */
const { Worker } = require("worker_threads");
const path = require("path");
const os = require("os");

const POOL_SIZE = Math.max(1, Math.min(Number(process.env.BOT_WORKERS) || (os.cpus().length > 1 ? 2 : 1), 4));
const MAX_QUEUE = 100;

const slots = [];   // { worker, job, alive }
const queue = [];   // { id, req, timeoutMs, resolve, reject, timer }
let seq = 0;

function createSlot() {
  const worker = new Worker(path.join(__dirname, "bot-thread.js"));
  worker.unref(); // сам по себе пул не удерживает процесс от завершения
  const slot = { worker, job: null, alive: true };

  worker.on("message", (msg) => {
    const job = slot.job;
    if (!job || job.id !== msg.id) return;
    slot.job = null;
    clearTimeout(job.timer);
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg.move);
    pump();
  });
  const dead = (err) => {
    if (!slot.alive) return;
    slot.alive = false;
    const i = slots.indexOf(slot);
    if (i !== -1) slots.splice(i, 1);
    if (slot.job) {
      clearTimeout(slot.job.timer);
      slot.job.reject(err || new Error("bot_worker_exit"));
      slot.job = null;
    }
    pump();
  };
  worker.on("error", dead);
  worker.on("exit", () => dead(new Error("bot_worker_exit")));

  slots.push(slot);
  return slot;
}

function pump() {
  while (queue.length) {
    let slot = slots.find((s) => s.alive && !s.job);
    if (!slot && slots.length < POOL_SIZE) slot = createSlot();
    if (!slot) return;
    const job = queue.shift();
    slot.job = job;
    job.timer = setTimeout(() => {
      // Поток завис: убиваем, запрос считаем проваленным.
      slot.job = null;
      job.reject(new Error("bot_timeout"));
      slot.alive = false;
      const i = slots.indexOf(slot);
      if (i !== -1) slots.splice(i, 1);
      slot.worker.terminate().catch(() => {});
      pump();
    }, job.timeoutMs);
    slot.worker.postMessage({ id: job.id, req: job.req });
  }
}

function computeBotMove(req, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) return reject(new Error("bot_busy"));
    queue.push({ id: ++seq, req, timeoutMs, resolve, reject, timer: null });
    pump();
  });
}

module.exports = { computeBotMove, POOL_SIZE };
