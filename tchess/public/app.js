/* ============================================================
   T-CHESS mini app
   ============================================================ */

const PIECE_GLYPH = {
  p: "♟", r: "♜", n: "♞", b: "♝", q: "♛", k: "♚",
  P: "♙", R: "♖", N: "♘", B: "♗", Q: "♕", K: "♔",
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

let game = new Chess();
let orientation = "white";       // "white" | "black"
let mode = "none";                // "none" | "puzzle" | "online" | "bot"
let selectedSquare = null;
let legalTargets = [];
let lastMove = null;

let socket = null;
let roomId = null;
let myColor = null;
let opponentInfo = null;
let clockInterval = null;
let clockSeconds = { top: 300, bottom: 300 };

let currentPuzzleIdx = 0;
let puzzleMoveCursor = 0;
let puzzleList = [];              // задачи, которые игрок ещё НЕ решал
let puzzleAuthed = false;         // список получен для авторизованного игрока (решённые фильтрует сервер)
let puzzleSolverColor = "w";      // за кого играет решающий в текущей задаче
let puzzleUserMoves = [];         // ходы решающего — уходят на сервер при решении
let puzzleBusy = false;           // ждём ответ соперника / переход к следующей — доска заблокирована
let puzzleTimer = null;
let puzzleLoading = false;

// Партия с ботом: { level, colorChoice, human: "w"|"b", bot, moves[], active, thinking, requestId }
let botGame = null;
let botWorker = null;
let botWorkerBusy = false;
let botRequestSeq = 0;

// true, пока идёт онлайн-партия (от match_found до итога). По этому флагу
// «Сдаться» и любые ходы работают только в реальной партии.
let gameActive = false;

let profile = {
  uid: null,
  name: "Гость",
  tchessId: "T-CHESS-000000",
  photoUrl: null,
  rating: null,
  desc: "",
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  streak: 0,
  isAdmin: false,
};
let isSyncedAccount = false;

const AUTH_TOKEN_KEY = "tchess_token";
let authToken = localStorage.getItem(AUTH_TOKEN_KEY) || null;

/* ============================================================
   BOOTSTRAP
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  buildFileLabels();
  renderBoard();
  bindNav();
  bindHomeActions();
  bindModeModal();
  bindProfileActions();
  bindAdminMenu();
  bindAuthModal();
  rotateSponsorBanner();
  loadLocalIdentity();
  tryAuth();
  initNavIndicator();
});

window.addEventListener("resize", () => {
  const active = document.querySelector(".nav-btn.active") || document.querySelector('.nav-btn[data-nav="home"]');
  if (active) positionNavIndicator(active, { animate: false });
});

// Веб-шрифты догружаются асинхронно и могут чуть изменить ширину кнопок —
// пересчитываем позицию индикатора после их применения, без анимации "перелёта".
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    const active = document.querySelector(".nav-btn.active") || document.querySelector('.nav-btn[data-nav="home"]');
    if (active) positionNavIndicator(active, { animate: false });
  });
}

function buildFileLabels() {
  const bottom = document.getElementById("boardFiles");
  bottom.innerHTML = "";
  const files = orientation === "white" ? FILES : [...FILES].reverse();
  files.forEach((f) => {
    const span = document.createElement("span");
    span.textContent = f;
    bottom.appendChild(span);
  });
}

/* ============================================================
   NAVIGATION
   ============================================================ */

function bindNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchPage(btn.dataset.nav));
  });
}

function switchPage(name) {
  document.querySelectorAll(".page").forEach((p) => {
    p.hidden = p.dataset.page !== name;
  });
  let targetBtn = null;
  document.querySelectorAll(".nav-btn").forEach((b) => {
    const isActive = b.dataset.nav === name;
    b.classList.toggle("active", isActive);
    if (isActive) targetBtn = b;
  });
  if (targetBtn) positionNavIndicator(targetBtn, { animate: true });
  if (name === "tournaments") loadTournaments();
  if (name === "profile") refreshProfileUI();
}

function initNavIndicator() {
  const homeBtn = document.querySelector('.nav-btn[data-nav="home"]');
  if (homeBtn) positionNavIndicator(homeBtn, { animate: false });
}

function positionNavIndicator(btn, opts) {
  const animate = !opts || opts.animate !== false;
  const indicator = document.getElementById("navIndicator");
  const nav = document.getElementById("bottombar");
  if (!indicator || !nav) return;

  const navRect = nav.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();

  const width = btnRect.width;
  const toX = btnRect.left - navRect.left;
  const prevX = indicator._toX !== undefined ? indicator._toX : toX;

  indicator.style.setProperty("--indicator-w", width + "px");

  if (!animate || prevX === toX) {
    indicator.classList.remove("flying");
    indicator.style.setProperty("--to-x", toX + "px");
    indicator.style.setProperty("--from-x", toX + "px");
    indicator._toX = toX;
    return;
  }

  indicator.style.setProperty("--from-x", prevX + "px");
  indicator.style.setProperty("--to-x", toX + "px");
  indicator._toX = toX;

  // перезапуск CSS-анимации: снять класс, форсировать reflow, добавить снова
  indicator.classList.remove("flying");
  void indicator.offsetWidth;
  indicator.classList.add("flying");
}

/* ============================================================
   SPONSOR BANNER AUTO-SCROLL
   ============================================================ */

function rotateSponsorBanner() {
  const el = document.getElementById("sponsorBanner");
  let i = 0;
  setInterval(() => {
    i = (i + 1) % el.children.length;
    el.scrollTo({ left: el.children[i].offsetLeft - 12, behavior: "smooth" });
  }, 3500);
}

/* ============================================================
   BOARD RENDERING
   ============================================================ */

function renderBoard() {
  const boardEl = document.getElementById("board");
  boardEl.innerHTML = "";

  const board = game.board(); // 8x8, row0 = rank8
  const rows = orientation === "white" ? board : [...board].reverse().map((r) => [...r].reverse());

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = rows[r][c];
      const fileIdx = orientation === "white" ? c : 7 - c;
      const rankNum = orientation === "white" ? 8 - r : r + 1;
      const squareName = FILES[fileIdx] + rankNum;

      const sq = document.createElement("div");
      const isLight = (fileIdx + rankNum) % 2 === 1;
      sq.className = "sq " + (isLight ? "light" : "dark");
      sq.dataset.square = squareName;

      if (piece) {
        const span = document.createElement("span");
        span.className = "piece " + (piece.color === "w" ? "piece-white" : "piece-black");
        // \uFE0E — просим текстовое (а не цветное эмодзи) начертание: на Android
        // ♟ иначе рисуется эмодзи-шрифтом другого размера и без учёта цвета фигуры.
        span.textContent = PIECE_GLYPH[piece.color === "w" ? piece.type.toUpperCase() : piece.type] + "\uFE0E";
        sq.appendChild(span);
      }

      if (lastMove && (squareName === lastMove.from || squareName === lastMove.to)) {
        sq.classList.add("last-move");
      }
      if (selectedSquare === squareName) sq.classList.add("selected");
      if (legalTargets.some((t) => t.to === squareName)) {
        sq.classList.add("legal");
        if (legalTargets.find((t) => t.to === squareName)?.flags.includes("c")) sq.classList.add("capture");
      }
      if (game.in_check()) {
        const kingSq = findKingSquare(game.turn());
        if (squareName === kingSq) sq.classList.add("check");
      }

      sq.addEventListener("click", () => onSquareClick(squareName));
      boardEl.appendChild(sq);
    }
  }
}

function findKingSquare(color) {
  const board = game.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.type === "k" && p.color === color) {
        return FILES[c] + (8 - r);
      }
    }
  }
  return null;
}

function onSquareClick(square) {
  if (mode === "none") return;
  if (mode === "online" && (!gameActive || (myColor && game.turn() !== myColor[0]))) return;
  if (mode === "puzzle" && puzzleBusy) return;
  if (mode === "bot" && (!botGame || !botGame.active || botGame.thinking || game.turn() !== botGame.human)) return;

  const piece = game.get(square);

  if (selectedSquare) {
    const attempt = legalTargets.find((t) => t.to === square);
    if (attempt) {
      executeMove(selectedSquare, square, attempt.promotion);
      selectedSquare = null;
      legalTargets = [];
      renderBoard();
      return;
    }
  }

  if (piece && (
    (mode === "online" && piece.color === myColor[0]) ||
    (mode === "puzzle" && piece.color === puzzleSolverColor) ||
    (mode === "bot" && piece.color === botGame.human)
  )) {
    selectedSquare = square;
    const moves = game.moves({ square, verbose: true });
    legalTargets = moves;
  } else {
    selectedSquare = null;
    legalTargets = [];
  }
  renderBoard();
}

function executeMove(from, to, promotion) {
  const needsPromotion = shouldAutoQueen(from, to);
  const moveObj = { from, to };
  if (needsPromotion) moveObj.promotion = "q";

  const result = game.move(moveObj);
  if (!result) return;

  lastMove = { from, to };

  if (mode === "puzzle") {
    handlePuzzleMove(result);
  } else if (mode === "online") {
    sendWS({ type: "move", roomId, from, to, promotion: moveObj.promotion || null });
    afterOnlineMoveCheck();
  } else if (mode === "bot") {
    botGame.moves.push(moveRecord(result));
    afterBotGameMove();
  }
}

function shouldAutoQueen(from, to) {
  const piece = game.get(from);
  if (!piece || piece.type !== "p") return false;
  const targetRank = to[1];
  return (piece.color === "w" && targetRank === "8") || (piece.color === "b" && targetRank === "1");
}

/* ============================================================
   HOME ACTIONS
   ============================================================ */

function bindHomeActions() {
  document.getElementById("btnFindOpponent").addEventListener("click", openModeModal);
  document.getElementById("btnPuzzles").addEventListener("click", startPuzzleMode);
  document.getElementById("btnCancelSearch").addEventListener("click", cancelSearch);
  document.getElementById("btnResign").addEventListener("click", resignGame);
  document.getElementById("btnLeaveGame").addEventListener("click", leaveGame);
  document.getElementById("btnBotAgain").addEventListener("click", rematchBot);
  document.getElementById("btnPuzzleHint").addEventListener("click", showPuzzleHint);
  document.getElementById("btnPuzzleSkip").addEventListener("click", () => loadPuzzle(currentPuzzleIdx + 1));
  document.getElementById("btnPuzzleExit").addEventListener("click", exitPuzzleMode);
}

function setStatus(text) {
  document.getElementById("boardStatus").textContent = text;
}

function showToast(text, ms = 2200) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.hidden = true), ms);
}

/* ============================================================
   PUZZLE MODE
   ============================================================ */

const GUEST_SOLVED_KEY = "tchess_guest_solved";

function getGuestSolved() {
  try { return JSON.parse(localStorage.getItem(GUEST_SOLVED_KEY)) || []; } catch { return []; }
}

function addGuestSolved(id) {
  try {
    const list = getGuestSolved();
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(GUEST_SOLVED_KEY, JSON.stringify(list));
    }
  } catch {}
}

// Задачи приходят с сервера (их редактируют админы). Игроку с аккаунтом сервер
// сразу отдаёт только нерешённые; гостю — все, а решённые он скрывает сам
// (по списку в localStorage): у гостя рейтинг не сохраняется.
async function fetchPuzzles() {
  const res = await fetch("/api/puzzles", {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  if (!res.ok) throw new Error("puzzles_failed");
  const data = await res.json();
  let list = Array.isArray(data.puzzles) ? data.puzzles : [];
  if (!data.authed) {
    const solved = new Set(getGuestSolved());
    list = list.filter((p) => !solved.has(p.id));
  }
  return { list, authed: Boolean(data.authed) };
}

async function startPuzzleMode() {
  if (puzzleLoading) return;
  puzzleLoading = true;
  const btn = document.getElementById("btnPuzzles");
  btn.disabled = true;
  try {
    const { list, authed } = await fetchPuzzles();
    // Пока грузились, игрок мог открыть другой режим — не перебиваем его.
    if (mode !== "none" || isModeModalOpen()) return;

    if (!list.length) {
      setStatus("Вы решили все задачи — новые появятся позже 🎉");
      showToast("Все задачи решены! Новые появятся позже", 3500);
      return;
    }
    puzzleList = list;
    puzzleAuthed = authed;
    mode = "puzzle";
    document.getElementById("homeActions").hidden = true;
    document.getElementById("matchActions").hidden = true;
    document.getElementById("puzzlePanel").hidden = false;
    document.getElementById("clocks").hidden = true;
    loadPuzzle(0);
  } catch {
    showToast("Не удалось загрузить задачи. Проверьте соединение", 3000);
  } finally {
    puzzleLoading = false;
    btn.disabled = false;
  }
}

function loadPuzzle(idx) {
  clearTimeout(puzzleTimer);
  if (!puzzleList.length) { finishAllPuzzles(); return; }

  currentPuzzleIdx = ((idx % puzzleList.length) + puzzleList.length) % puzzleList.length;
  const puzzle = puzzleList[currentPuzzleIdx];
  game = new Chess(puzzle.fen);
  puzzleSolverColor = game.turn();
  orientation = puzzleSolverColor === "w" ? "white" : "black";
  puzzleMoveCursor = 0;
  puzzleUserMoves = [];
  puzzleBusy = false;
  selectedSquare = null;
  legalTargets = [];
  lastMove = null;
  buildFileLabels();
  renderBoard();
  document.getElementById("puzzleIndex").textContent = `Задача ${currentPuzzleIdx + 1} / ${puzzleList.length}`;
  document.getElementById("puzzleTag").textContent = puzzle.tag;
  setStatus("Ваш ход — найдите лучший ход в позиции");
}

function handlePuzzleMove(result) {
  const puzzle = puzzleList[currentPuzzleIdx];
  const expected = puzzle && puzzle.solution[puzzleMoveCursor];

  if (expected && result.from === expected.from && result.to === expected.to) {
    puzzleUserMoves.push({ from: result.from, to: result.to });
    puzzleMoveCursor++;
    if (puzzleMoveCursor >= puzzle.solution.length) {
      onPuzzleSolved(puzzle);
    } else {
      // Многоходовая задача: соперник отвечает сам, затем снова ход игрока.
      puzzleBusy = true;
      setStatus("Верно! Соперник отвечает…");
      renderBoard();
      puzzleTimer = setTimeout(() => playPuzzleReply(puzzle), 550);
    }
  } else {
    setStatus("Не тот ход — попробуйте снова");
    game.undo();
    lastMove = null;
    renderBoard();
  }
}

function playPuzzleReply(puzzle) {
  if (mode !== "puzzle") return;
  const reply = puzzle.solution[puzzleMoveCursor];
  const res = reply && game.move({ from: reply.from, to: reply.to, promotion: reply.promotion || "q" });
  if (!res) {
    showToast("В этой задаче ошибка — перейдите к следующей", 3000);
    puzzleBusy = false;
    return;
  }
  lastMove = { from: reply.from, to: reply.to };
  puzzleMoveCursor++;
  puzzleBusy = false;
  setStatus("Верно, продолжайте — ваш ход");
  renderBoard();
}

function onPuzzleSolved(puzzle) {
  puzzleBusy = true;
  setStatus("Верно! Задача решена 🎉");
  renderBoard();

  // Решённая задача сразу уходит из списка — больше не попадётся.
  const idx = currentPuzzleIdx;
  puzzleList.splice(idx, 1);
  reportPuzzleSolved(puzzle, puzzleUserMoves.slice());

  puzzleTimer = setTimeout(() => {
    if (mode !== "puzzle") return;
    if (!puzzleList.length) finishAllPuzzles();
    else loadPuzzle(idx);
  }, 1100);
}

function finishAllPuzzles() {
  exitPuzzleMode();
  setStatus("Вы решили все задачи — новые появятся позже 🎉");
  showToast("Вы решили все задачи! 🎉 Новые появятся позже", 3500);
}

async function reportPuzzleSolved(puzzle, moves) {
  if (!puzzleAuthed || !authToken) {
    // Гость: рейтинг за задачи копится только локально в этой сессии.
    addGuestSolved(puzzle.id);
    addLocalRatingDelta(4);
    showToast("Задача решена!");
    return;
  }
  try {
    const res = await fetch("/api/puzzle/solved", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ puzzleId: puzzle.id, moves }),
    });
    if (!res.ok) throw new Error("puzzle sync failed");
    const data = await res.json();
    profile.rating = data.rating;
    updateTopbarRating();
    refreshProfileUI();
    showToast(data.delta > 0 ? `Задача решена! +${data.delta} к рейтингу` : "Задача решена (рейтинг за неё уже начислен)");
  } catch {
    // Рейтинг на клиенте сами не начисляем — только то, что подтвердил сервер.
    showToast("Задача решена, но результат не сохранился. Проверьте соединение", 3500);
  }
}

function showPuzzleHint() {
  const puzzle = puzzleList[currentPuzzleIdx];
  if (!puzzle || puzzleBusy) return;
  showToast(puzzle.hint || "Для этой задачи подсказки нет", 3200);
}

function exitPuzzleMode() {
  clearTimeout(puzzleTimer);
  puzzleBusy = false;
  mode = "none";
  document.getElementById("puzzlePanel").hidden = true;
  document.getElementById("homeActions").hidden = false;
  resetBoardToStart();
}

function resetBoardToStart() {
  game = new Chess();
  orientation = "white";
  selectedSquare = null;
  legalTargets = [];
  lastMove = null;
  buildFileLabels();
  renderBoard();
  setStatus('Нажмите «Найти соперника» или «Решать задачи»');
}

/* ============================================================
   ONLINE MATCHMAKING
   ============================================================ */

function ensureSocket() {
  // Уже подключены или подключаемся — второй сокет не создаём.
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const s = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = s;

  s.addEventListener("message", (ev) => {
    if (s !== socket) return;      // сообщение от устаревшего сокета
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWSMessage(msg);
  });

  s.addEventListener("close", () => {
    if (s !== socket) return;      // старый сокет закрылся, уже есть новый
    if (mode === "online") showToast("Соединение потеряно");
    hideSearchOverlay();
    onFriendSocketClosed();
  });
}

// Отправить сообщение, дождавшись открытия сокета (при необходимости — открыв его).
function sendWhenOpen(payload) {
  ensureSocket();
  const s = socket;
  if (s.readyState === WebSocket.OPEN) {
    s.send(JSON.stringify(payload));
  } else {
    s.addEventListener("open", () => { if (s === socket) sendWS(payload); }, { once: true });
  }
}

function startMatchmaking() {
  sendWhenOpen({ type: "find_opponent", token: authToken || undefined });

  document.getElementById("homeActions").hidden = true;
  document.getElementById("matchActions").hidden = false;
  document.getElementById("btnCancelSearch").hidden = false;
  document.getElementById("btnResign").hidden = true;
  document.getElementById("btnLeaveGame").hidden = true;
  setStatus("Ищем соперника…");
  showSearchOverlay();
}

function showSearchOverlay() {
  document.getElementById("boardVisual")?.classList.add("blurred");
  document.getElementById("searchOverlay")?.classList.add("visible");
}

function hideSearchOverlay() {
  document.getElementById("boardVisual")?.classList.remove("blurred");
  document.getElementById("searchOverlay")?.classList.remove("visible");
}

function cancelSearch() {
  sendWS({ type: "cancel_search", uid: profile.uid });
  document.getElementById("homeActions").hidden = false;
  document.getElementById("matchActions").hidden = true;
  hideSearchOverlay();
  resetBoardToStart();
}

function sendWS(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case "match_found":
      onMatchFound(msg);
      break;
    case "move":
      onOpponentMove(msg);
      break;
    case "opponent_left":
      showToast("Соперник покинул партию");
      endOnlineGame();
      break;
    case "game_over":
      onGameOver(msg);
      break;
    case "friend_code":
      onFriendCode(msg);
      break;
    case "friend_code_expired":
      onFriendCodeExpired();
      break;
    case "friend_error":
      onFriendError(msg);
      break;
  }
}

function onMatchFound(msg) {
  // Партия могла начаться из окна «Играть с другом» — закрываем его и
  // переключаем кнопки так же, как при обычном поиске.
  closeModeModal({ silent: true });
  document.getElementById("homeActions").hidden = true;
  document.getElementById("matchActions").hidden = false;

  mode = "online";
  gameActive = true;
  roomId = msg.roomId;
  myColor = msg.color;
  opponentInfo = msg.opponent;
  game = new Chess();
  orientation = myColor;
  selectedSquare = null;
  legalTargets = [];
  lastMove = null;
  buildFileLabels();
  renderBoard();
  hideSearchOverlay();

  document.getElementById("btnCancelSearch").hidden = true;
  document.getElementById("btnResign").hidden = false;
  document.getElementById("btnLeaveGame").hidden = true;
  document.getElementById("clocks").hidden = false;
  clockSeconds = { top: 300, bottom: 300 };
  startClock();

  setStatus(`${msg.friend ? "Игра с другом (без рейтинга) · " : ""}Соперник: ${opponentInfo.name} (${opponentInfo.rating}) · вы играете ${myColor === "white" ? "белыми" : "чёрными"}`);
}

function onOpponentMove(msg) {
  if (!gameActive) return;
  const moveObj = { from: msg.from, to: msg.to };
  if (msg.promotion) moveObj.promotion = msg.promotion;
  const result = game.move(moveObj);
  if (result) {
    lastMove = { from: msg.from, to: msg.to };
    renderBoard();
    afterOnlineMoveCheck();
  }
}

function afterOnlineMoveCheck() {
  if (!gameActive) return;
  if (game.in_checkmate()) {
    const winnerColor = game.turn() === "w" ? "black" : "white";
    finishOnlineGame(winnerColor === myColor ? "win" : "loss");
  } else if (game.in_draw() || game.in_stalemate() || game.in_threefold_repetition()) {
    finishOnlineGame("draw");
  } else {
    setStatus(game.turn() === myColor[0] ? "Ваш ход" : "Ход соперника");
    swapClockActive();
  }
}

// Игрок (или часы) сообщает серверу об окончании партии. Работает только в
// реальной, ещё не завершённой партии — иначе «Сдаться» без партии (или второй
// клик по нему) ничего не отправляет и не меняет.
function finishOnlineGame(result, extra) {
  if (mode !== "online" || !gameActive || !roomId) return;
  sendWS({ type: "game_over", roomId, result, uid: profile.uid, opponentUid: opponentInfo?.uid, ...extra });
  showGameResult(result);
}

function resignGame() {
  if (mode === "bot") { finishBotGame("loss"); return; }
  finishOnlineGame("loss", { resigned: true });
}

// Показывает итог на экране и останавливает партию. Рейтинг тут НЕ трогаем:
// единственный источник правды — ответ сервера (см. onGameOver).
// Возвращает true, если партия действительно завершилась только что.
function showGameResult(result) {
  if (!gameActive) return false;
  gameActive = false;
  stopClock();
  selectedSquare = null;
  legalTargets = [];
  const label = result === "win" ? "Победа! 🎉" : result === "loss" ? "Поражение" : "Ничья";
  setStatus(label);
  renderBoard();
  document.getElementById("btnResign").hidden = true;
  document.getElementById("btnLeaveGame").hidden = false;
  return true;
}

// Сообщение сервера game_over: у нас это подтверждённый итог и изменение рейтинга.
function onGameOver(msg) {
  showGameResult(msg.result); // если уже показали локально — ничего не делает
  const label = msg.result === "win" ? "Победа! 🎉" : msg.result === "loss" ? "Поражение" : "Ничья";

  if (msg.rated === false) {
    showToast(`${label} · товарищеская партия, рейтинг не меняется`, 3200);
    return;
  }
  if (msg.ratingDelta !== undefined) addLocalRatingDelta(msg.ratingDelta);
  if (msg.saved === false) {
    showToast(`${label} · рейтинг не сохраняется в гостевом режиме`, 3000);
  } else {
    showToast(label);
  }
}

function endOnlineGame() {
  gameActive = false;
  roomId = null;
  stopClock();
  document.getElementById("matchActions").hidden = true;
  document.getElementById("homeActions").hidden = false;
  document.getElementById("clocks").hidden = true;
  mode = "none";
  resetBoardToStart();
}

function leaveGame() {
  if (mode === "bot") { exitBotGame(); return; }
  roomId = null;
  endOnlineGame();
}

function startClock() {
  swapClockActive();
  clockInterval = setInterval(() => {
    const activeKey = game.turn() === myColor[0] ? "bottom" : "top";
    clockSeconds[activeKey] = Math.max(0, clockSeconds[activeKey] - 1);
    renderClocks();
    if (clockSeconds[activeKey] === 0) {
      finishOnlineGame(activeKey === "bottom" ? "loss" : "win");
    }
  }, 1000);
}

function stopClock() {
  clearInterval(clockInterval);
}

function swapClockActive() {
  const bottomActive = game.turn() === myColor?.[0];
  document.getElementById("clockBottom").classList.toggle("active", bottomActive);
  document.getElementById("clockTop").classList.toggle("active", !bottomActive);
}

function renderClocks() {
  document.getElementById("clockTop").textContent = fmtClock(clockSeconds.top);
  document.getElementById("clockBottom").textContent = fmtClock(clockSeconds.bottom);
}

function fmtClock(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

/* ============================================================
   MODE MODAL — «Найти соперника»: играть с другом или случайный
   ============================================================
   Случайный противник — прежний поиск через очередь.
   Игра с другом: сервер выдаёт код на 10 минут, друг вводит его у себя.
   Пока окно открыто, код живёт; если сокет оборвался (например, вы
   свернули приложение, чтобы отправить код в чат) — при возвращении
   клиент переподключается и «забирает» тот же код обратно.
   ============================================================ */

const friendState = {
  active: false,      // открыт шаг «Играть с другом»
  code: null,
  secret: null,       // нужен только для восстановления кода после переподключения
  joining: false,     // отправлен код друга, ждём ответ сервера
  resumeTimer: null,
  copyTimer: null,
};

const FRIEND_ERROR_MESSAGES = {
  not_found: "Код не найден или срок его действия истёк",
  own_code: "Это ваш собственный код — отправьте его другу",
  host_offline: "Друг сейчас не в сети. Попросите его вернуться в приложение",
  busy: "Игрок уже в другой партии",
  rate_limited: "Слишком много попыток. Подождите полминуты",
  server_error: "Что-то пошло не так. Попробуйте ещё раз",
};

function isModeModalOpen() {
  return !document.getElementById("modeOverlay").hidden;
}

function isFriendStepOpen() {
  return isModeModalOpen() && friendState.active;
}

function bindModeModal() {
  const overlay = document.getElementById("modeOverlay");
  const input = document.getElementById("friendCodeInput");

  document.getElementById("btnModeRandom").addEventListener("click", () => {
    closeModeModal();
    startMatchmaking();
  });
  document.getElementById("btnModeFriend").addEventListener("click", openFriendStep);
  bindBotStep();
  document.getElementById("btnModeClose").addEventListener("click", () => closeModeModal());
  document.getElementById("btnFriendBack").addEventListener("click", () => {
    stopFriendWaiting();
    showModeStep("choice");
  });

  // Тап по фону закрывает только окно выбора. Пока показан код для друга,
  // случайный тап мимо не должен его отменять — только «Назад».
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && !friendState.active) closeModeModal();
  });

  document.getElementById("friendCodeBox").addEventListener("click", copyFriendCode);

  input.addEventListener("input", () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    hideFriendError();
    updateFriendJoinButton();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitFriendJoin();
  });
  document.getElementById("btnFriendJoin").addEventListener("click", submitFriendJoin);

  // Вернулись в приложение (например, после отправки кода в чат) — если
  // сокет за это время оборвался, восстанавливаем код.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !isFriendStepOpen()) return;
    const alive = socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
    if (!alive) resumeFriendCode();
  });
}

function showModeStep(step) {
  document.getElementById("modeStepChoice").hidden = step !== "choice";
  document.getElementById("modeStepFriend").hidden = step !== "friend";
  document.getElementById("modeStepBot").hidden = step !== "bot";
}

function openModeModal() {
  resetFriendUI();
  showModeStep("choice");
  document.getElementById("modeOverlay").hidden = false;
}

// silent: true — окно закрывается потому, что партия уже началась,
// код на сервере к этому моменту уже удалён и отменять его не нужно.
function closeModeModal(opts) {
  const silent = opts && opts.silent;
  if (!silent) stopFriendWaiting();
  else resetFriendState();
  document.getElementById("modeOverlay").hidden = true;
  resetFriendUI();
}

function openFriendStep() {
  resetFriendUI();
  showModeStep("friend");
  friendState.active = true;
  requestFriendCode();
}

function requestFriendCode() {
  sendWhenOpen({ type: "friend_create", token: authToken || undefined });
}

// Выходим из ожидания друга: код на сервере гасим.
function stopFriendWaiting() {
  if (friendState.active) sendWS({ type: "friend_cancel" });
  resetFriendState();
  resetFriendUI();
}

function resetFriendState() {
  clearTimeout(friendState.resumeTimer);
  friendState.active = false;
  friendState.code = null;
  friendState.secret = null;
  friendState.joining = false;
}

function resetFriendUI() {
  document.getElementById("friendCodeValue").textContent = "······";
  document.getElementById("friendCodeHint").textContent = "Создаём код…";
  document.getElementById("friendCodeBox").classList.remove("copied");
  document.getElementById("friendCodeInput").value = "";
  hideFriendError();
  updateFriendJoinButton();
}

function updateFriendJoinButton() {
  const len = document.getElementById("friendCodeInput").value.length;
  document.getElementById("btnFriendJoin").disabled = friendState.joining || len !== 6;
}

function showFriendError(text) {
  const el = document.getElementById("friendError");
  el.textContent = text;
  el.hidden = false;
}

function hideFriendError() {
  document.getElementById("friendError").hidden = true;
}

function onFriendCode(msg) {
  // Код пришёл, а окно уже закрыли — гасим его на сервере.
  if (!isFriendStepOpen()) {
    sendWS({ type: "friend_cancel" });
    return;
  }
  friendState.code = msg.code;
  friendState.secret = msg.secret;
  document.getElementById("friendCodeValue").textContent = msg.code;
  document.getElementById("friendCodeHint").textContent = "Нажмите, чтобы скопировать";
}

function onFriendCodeExpired() {
  if (!isFriendStepOpen()) return;
  friendState.code = null;
  friendState.secret = null;
  document.getElementById("friendCodeValue").textContent = "······";
  document.getElementById("friendCodeHint").textContent = "Создаём новый код…";
  showToast("Срок действия кода истёк — создан новый", 3000);
  requestFriendCode();
}

function onFriendError(msg) {
  friendState.joining = false;
  updateFriendJoinButton();
  if (!isFriendStepOpen()) return;
  showFriendError(FRIEND_ERROR_MESSAGES[msg.reason] || FRIEND_ERROR_MESSAGES.server_error);
}

function submitFriendJoin() {
  const code = document.getElementById("friendCodeInput").value.trim().toUpperCase();
  if (code.length !== 6 || friendState.joining) return;
  friendState.joining = true;
  updateFriendJoinButton();
  hideFriendError();
  sendWhenOpen({ type: "friend_join", code, token: authToken || undefined });
}

function onFriendSocketClosed() {
  if (friendState.joining) {
    friendState.joining = false;
    updateFriendJoinButton();
    if (isFriendStepOpen()) showFriendError("Соединение потеряно. Попробуйте ещё раз");
  }
  if (isFriendStepOpen()) {
    clearTimeout(friendState.resumeTimer);
    friendState.resumeTimer = setTimeout(resumeFriendCode, 1500);
  }
}

// Переподключение: если код уже был — просим сервер вернуть его, иначе создаём новый.
function resumeFriendCode() {
  if (!isFriendStepOpen()) return;
  if (friendState.code && friendState.secret) {
    sendWhenOpen({ type: "friend_resume", code: friendState.code, secret: friendState.secret });
  } else {
    requestFriendCode();
  }
}

async function copyFriendCode() {
  const code = friendState.code;
  if (!code) return;

  let copied = false;
  try {
    await navigator.clipboard.writeText(code);
    copied = true;
  } catch {
    // В некоторых WebView Clipboard API недоступен — пробуем старый способ.
    try {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed; top:0; left:0; opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, code.length);
      copied = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {}
  }

  const box = document.getElementById("friendCodeBox");
  const hint = document.getElementById("friendCodeHint");
  clearTimeout(friendState.copyTimer);
  if (copied) {
    box.classList.add("copied");
    hint.textContent = "Код скопирован ✓";
    friendState.copyTimer = setTimeout(() => {
      box.classList.remove("copied");
      if (friendState.code) hint.textContent = "Нажмите, чтобы скопировать";
    }, 1800);
  } else {
    hint.textContent = "Выделите код и скопируйте вручную";
  }
}

/* ============================================================
   ИГРА С БОТОМ
   ============================================================
   Бот целиком работает у игрока в браузере (bot-engine.js), сервер не
   участвует. Считает ход в Web Worker, чтобы интерфейс не подвисал; если
   Worker недоступен — считает в основном потоке. Партии с ботом
   тренировочные: рейтинг, статистика и история не меняются.
   ============================================================ */

const BOT_PREFS_KEY = "tchess_bot_prefs";
const BOT_LEVEL_NAMES = { 1: "Лёгкий", 2: "Средний", 3: "Сильный" };
const botPrefs = loadBotPrefs();

function loadBotPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(BOT_PREFS_KEY));
    if (p && BOT_LEVEL_NAMES[p.level] && ["w", "r", "b"].includes(p.color)) return { level: p.level, color: p.color };
  } catch {}
  return { level: 2, color: "r" };
}

function saveBotPrefs() {
  try { localStorage.setItem(BOT_PREFS_KEY, JSON.stringify(botPrefs)); } catch {}
}

function renderBotPrefs() {
  document.querySelectorAll("#botLevels .bot-opt").forEach((btn) => {
    const on = Number(btn.dataset.level) === botPrefs.level;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
  document.querySelectorAll("#botColors .bot-chip").forEach((btn) => {
    const on = btn.dataset.color === botPrefs.color;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function bindBotStep() {
  document.getElementById("btnModeBot").addEventListener("click", () => {
    renderBotPrefs();
    showModeStep("bot");
  });
  document.getElementById("botLevels").addEventListener("click", (e) => {
    const btn = e.target.closest(".bot-opt");
    if (!btn) return;
    botPrefs.level = Number(btn.dataset.level);
    saveBotPrefs();
    renderBotPrefs();
  });
  document.getElementById("botColors").addEventListener("click", (e) => {
    const btn = e.target.closest(".bot-chip");
    if (!btn) return;
    botPrefs.color = btn.dataset.color;
    saveBotPrefs();
    renderBotPrefs();
  });
  document.getElementById("btnBotStart").addEventListener("click", () => {
    closeModeModal();
    if (mode === "none") beginBotGame(botPrefs.level, botPrefs.color);
  });
  document.getElementById("btnBotBack").addEventListener("click", () => showModeStep("choice"));
}

// Запись хода для истории партии (движок восстанавливает по ней позицию и повторения).
function moveRecord(res) {
  const rec = { from: res.from, to: res.to };
  if (res.promotion) rec.promotion = res.promotion;
  return rec;
}

function beginBotGame(level, colorChoice) {
  cancelBotThinking();
  const human = colorChoice === "r" ? (Math.random() < 0.5 ? "w" : "b") : colorChoice;
  mode = "bot";
  botGame = {
    level, colorChoice, human, bot: human === "w" ? "b" : "w",
    moves: [], active: true, thinking: false, requestId: 0,
  };
  game = new Chess();
  orientation = human === "w" ? "white" : "black";
  selectedSquare = null;
  legalTargets = [];
  lastMove = null;
  buildFileLabels();
  renderBoard();

  document.getElementById("homeActions").hidden = true;
  document.getElementById("matchActions").hidden = false;
  document.getElementById("btnCancelSearch").hidden = true;
  document.getElementById("btnResign").hidden = false;
  document.getElementById("btnLeaveGame").hidden = true;
  document.getElementById("btnBotAgain").hidden = true;
  document.getElementById("clocks").hidden = true;

  if (botGame.bot === "w") requestBotMove();
  else setBotStatus();
}

function rematchBot() {
  if (!botGame) return;
  beginBotGame(botGame.level, botGame.colorChoice);
}

function setBotStatus() {
  if (!botGame || !botGame.active) return;
  const lv = BOT_LEVEL_NAMES[botGame.level];
  if (game.turn() === botGame.human) {
    const you = botGame.human === "w" ? "белыми" : "чёрными";
    setStatus(`${game.in_check() ? "Шах! " : ""}Ваш ход · бот «${lv}» · вы играете ${you}`);
  } else {
    setStatus(`Бот «${lv}» думает…`);
  }
}

// После каждого хода (своего или бота): конец партии, либо очередь бота, либо снова наш ход.
function afterBotGameMove() {
  if (!botGame || !botGame.active) return;
  if (game.in_checkmate()) { finishBotGame(game.turn() === botGame.human ? "loss" : "win"); return; }
  if (game.in_draw()) { finishBotGame("draw"); return; }
  if (game.turn() === botGame.bot) requestBotMove();
  else setBotStatus();
}

function requestBotMove() {
  const bg = botGame;
  if (!bg || !bg.active) return;
  bg.thinking = true;
  const myId = ++botRequestSeq;
  bg.requestId = myId;
  setBotStatus();

  const started = Date.now();
  const minDelay = bg.level === 1 ? 450 : 700; // чтобы ответ не мелькал мгновенно
  runBotEngine(bg.moves.slice(), bg.level).then((move) => {
    const wait = Math.max(0, minDelay - (Date.now() - started));
    setTimeout(() => applyBotMove(bg, myId, move), wait);
  });
}

function applyBotMove(bg, id, move) {
  // Игрок мог выйти из партии или начать другую, пока бот думал.
  if (botGame !== bg || !bg.active || bg.requestId !== id || mode !== "bot") return;

  let res = move ? game.move({ from: move.from, to: move.to, promotion: move.promotion }) : null;
  if (!res) {
    // Страховка: если движок не вернул допустимый ход — ходим любым легальным.
    const legal = game.moves({ verbose: true });
    if (!legal.length) { bg.thinking = false; afterBotGameMove(); return; }
    const pick = legal[Math.floor(Math.random() * legal.length)];
    res = game.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
  }
  bg.thinking = false;
  bg.moves.push(moveRecord(res));
  lastMove = { from: res.from, to: res.to };
  renderBoard();
  afterBotGameMove();
}

// Считает ход движком: сначала в Web Worker, при любой неудаче — в основном потоке.
function runBotEngine(moves, level) {
  return new Promise((resolve) => {
    const id = botRequestSeq;
    let done = false;
    let guard = null;

    const finish = (move) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      botWorkerBusy = false;
      resolve(move);
    };
    const inMainThread = () => {
      setTimeout(() => {
        try { finish(window.BotEngine.chooseMove({ moves, level })); } catch { finish(null); }
      }, 30);
    };

    if (!window.Worker) { inMainThread(); return; }
    try {
      if (!botWorker) botWorker = new Worker("bot-worker.js");
    } catch { inMainThread(); return; }

    const worker = botWorker;
    const onMessage = (e) => {
      if (!e.data || e.data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      finish(e.data.error ? null : e.data.move);
    };
    const onError = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      disposeBotWorker();
      done = false;               // уходим на запасной путь
      inMainThread();
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    botWorkerBusy = true;
    // Если Worker завис — не оставляем игрока ждать вечно.
    guard = setTimeout(() => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      disposeBotWorker();
      done = false;
      inMainThread();
    }, 8000);
    worker.postMessage({ id, moves, level });
  });
}

function disposeBotWorker() {
  if (botWorker) { try { botWorker.terminate(); } catch {} }
  botWorker = null;
  botWorkerBusy = false;
}

// Игрок вышел/сдался, пока бот считает: останавливаем расчёт и игнорируем его ответ.
function cancelBotThinking() {
  if (botGame) { botGame.thinking = false; botGame.requestId = 0; }
  if (botWorkerBusy) disposeBotWorker();
}

// result — с точки зрения игрока: "win" | "loss" | "draw".
function finishBotGame(result) {
  const bg = botGame;
  if (!bg || !bg.active) return;
  bg.active = false;
  cancelBotThinking();
  selectedSquare = null;
  legalTargets = [];
  renderBoard();

  let text;
  if (result === "win") text = "Мат — вы победили бота! 🎉";
  else if (result === "draw") text = game.in_stalemate() ? "Пат — ничья" : "Ничья";
  else text = game.in_checkmate() ? "Мат — победил бот" : "Вы сдались — победил бот";
  setStatus(text);
  showToast(`${text} · без рейтинга`, 3200);

  document.getElementById("btnResign").hidden = true;
  document.getElementById("btnLeaveGame").hidden = false;
  document.getElementById("btnBotAgain").hidden = false;
}

function exitBotGame() {
  cancelBotThinking();
  botGame = null;
  mode = "none";
  document.getElementById("matchActions").hidden = true;
  document.getElementById("homeActions").hidden = false;
  document.getElementById("btnBotAgain").hidden = true;
  document.getElementById("btnLeaveGame").hidden = true;
  resetBoardToStart();
}

/* ============================================================
   PROFILE / AUTH
   ============================================================ */

function loadLocalIdentity() {
  // Рейтинг больше не читаем из плоского локального кэша здесь — на этом
  // этапе мы ещё не знаем, валиден ли токен. Источник правды для рейтинга —
  // сервер, его подтягивает tryAuth(). Здесь восстанавливаем только
  // описание профиля — это чисто косметический кэш, ни на что не влияет.
  const savedDesc = localStorage.getItem("tchess_desc");
  if (savedDesc) profile.desc = savedDesc;
}

function applyUserToProfile(user) {
  profile.uid = user.uid;
  profile.name = user.name || "Игрок";
  profile.tchessId = "T-CHESS-" + String(user.uid).replace(/-/g, "").slice(-6).toUpperCase();
  profile.rating = user.rating;
  profile.gamesPlayed = user.gamesPlayed || 0;
  profile.wins = user.wins || 0;
  profile.losses = user.losses || 0;
  profile.draws = user.draws || 0;
  profile.streak = user.streak || 0;
  profile.desc = user.desc ?? profile.desc;
  profile.isAdmin = Boolean(user.isAdmin);
  isSyncedAccount = true;
}

function resetToGuest() {
  profile.uid = null;
  profile.name = "Гость";
  profile.tchessId = "T-CHESS-000000";
  profile.rating = null;
  profile.isAdmin = false;
  isSyncedAccount = false;
}

// При запуске приложения: если в localStorage есть сохранённый токен входа,
// проверяем его на сервере и подтягиваем актуальный профиль (рейтинг,
// статистику) — так рейтинг переживает закрытие/повторное открытие бота.
// Без токена показываем гостя без рейтинга, как и раньше без входа.
async function tryAuth() {
  if (!authToken) {
    resetToGuest();
    updateTopbarRating();
    refreshProfileUI();
    return;
  }

  try {
    const res = await fetch("/api/me", {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error("invalid token");
    const user = await res.json();
    applyUserToProfile(user);
  } catch (e) {
    // Токен истёк/невалиден — тихо разлогиниваем, без назойливого тоста при
    // каждом открытии приложения.
    authToken = null;
    localStorage.removeItem(AUTH_TOKEN_KEY);
    resetToGuest();
  }

  updateTopbarRating();
  refreshProfileUI();
}

function bindProfileActions() {
  document.getElementById("btnSaveDesc").addEventListener("click", saveDesc);
  document.getElementById("btnAuth").addEventListener("click", toggleAuth);
}

/* ============================================================
   AUTH MODAL (вход / регистрация по e-mail и паролю)
   ============================================================ */

function bindAuthModal() {
  const overlay = document.getElementById("authOverlay");
  const tabLogin = document.getElementById("authTabLogin");
  const tabRegister = document.getElementById("authTabRegister");
  const formLogin = document.getElementById("authFormLogin");
  const formRegister = document.getElementById("authFormRegister");

  tabLogin.addEventListener("click", () => switchAuthTab("login"));
  tabRegister.addEventListener("click", () => switchAuthTab("register"));
  document.getElementById("authClose").addEventListener("click", closeAuthModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeAuthModal(); });

  formLogin.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    await submitAuth("/api/login", { email, password }, "loginError");
  });

  formRegister.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("registerName").value.trim();
    const email = document.getElementById("registerEmail").value.trim();
    const password = document.getElementById("registerPassword").value;
    await submitAuth("/api/register", { email, password, name }, "registerError");
  });
}

function switchAuthTab(which) {
  const isLogin = which === "login";
  document.getElementById("authTabLogin").classList.toggle("active", isLogin);
  document.getElementById("authTabRegister").classList.toggle("active", !isLogin);
  document.getElementById("authFormLogin").hidden = !isLogin;
  document.getElementById("authFormRegister").hidden = isLogin;
}

function openAuthModal(tab = "login") {
  switchAuthTab(tab);
  hideAuthError("loginError");
  hideAuthError("registerError");
  document.getElementById("authOverlay").hidden = false;
}

function closeAuthModal() {
  document.getElementById("authOverlay").hidden = true;
}

function showAuthError(elId, text) {
  const el = document.getElementById(elId);
  el.textContent = text;
  el.hidden = false;
}

function hideAuthError(elId) {
  document.getElementById(elId).hidden = true;
}

const AUTH_ERROR_MESSAGES = {
  invalid_email: "Введите корректный e-mail",
  weak_password: "Пароль должен быть не короче 6 символов",
  email_taken: "Этот e-mail уже зарегистрирован",
  invalid_credentials: "Неверный e-mail или пароль",
  missing_fields: "Заполните все поля",
};

async function submitAuth(url, body, errorElId) {
  hideAuthError(errorElId);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      showAuthError(errorElId, AUTH_ERROR_MESSAGES[data.error] || "Не удалось выполнить запрос");
      return;
    }
    authToken = data.token;
    localStorage.setItem(AUTH_TOKEN_KEY, authToken);
    applyUserToProfile(data.user);
    updateTopbarRating();
    refreshProfileUI();
    closeAuthModal();
    showToast(`Добро пожаловать, ${profile.name}!`);
  } catch (e) {
    showAuthError(errorElId, "Не удалось подключиться к серверу");
  }
}

function logout() {
  authToken = null;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  resetToGuest();
  updateTopbarRating();
  refreshProfileUI();
  showToast("Вы вышли из аккаунта");
}

function refreshProfileUI() {
  const avatarEl = document.getElementById("profileAvatar");
  if (profile.photoUrl) {
    avatarEl.style.backgroundImage = `url(${profile.photoUrl})`;
    avatarEl.style.backgroundSize = "cover";
    avatarEl.textContent = "";
  } else {
    avatarEl.style.backgroundImage = "";
    avatarEl.textContent = (profile.name || "?").charAt(0).toUpperCase();
  }
  document.getElementById("profileTChessId").textContent = profile.tchessId;
  document.getElementById("profileName").textContent = isSyncedAccount ? profile.name : "Гость";
  document.getElementById("profileDesc").value = profile.desc || "";
  document.getElementById("profileRatingNum").textContent = profile.rating ?? "🔒";

  const authBtn = document.getElementById("btnAuth");
  authBtn.hidden = false;
  authBtn.textContent = isSyncedAccount ? "Выйти" : "Войти";
  // Кнопка админ-меню — только у администраторов. Настоящая защита — на сервере
  // (ADMIN_EMAILS): без прав API вернёт 403, даже если кнопку показать вручную.
  document.getElementById("btnAdmin").hidden = !(isSyncedAccount && profile.isAdmin);
  updateTopbarRating();
}

function updateTopbarRating() {
  document.querySelector("#topbarRating .rating-num").textContent = profile.rating ?? "🔒";
}

async function saveDesc() {
  profile.desc = document.getElementById("profileDesc").value.trim();
  localStorage.setItem("tchess_desc", profile.desc);
  if (isSyncedAccount && authToken) {
    try {
      await fetch("/api/profile/desc", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ desc: profile.desc }),
      });
    } catch {}
  }
  showToast("Описание сохранено");
}

function toggleAuth() {
  if (isSyncedAccount) {
    logout();
  } else {
    openAuthModal("login");
  }
}

// Локальное обновление рейтинга в UI (для мгновенного отклика). Реальное
// сохранение на сервере происходит отдельно: за онлайн-партии — сервер сам
// присылает подтверждённую дельту в сообщении game_over, а за решённые
// задачи — через POST /api/puzzle/solved (см. handlePuzzleMove).
function addLocalRatingDelta(delta) {
  profile.rating = (profile.rating ?? 1200) + delta;
  updateTopbarRating();
  refreshProfileUI();
}

/* ============================================================
   АДМИН-МЕНЮ — создание / редактирование / удаление задач
   ============================================================
   Проверка позиции и решения — общий модуль puzzlecheck.js (тот же файл
   использует сервер и перепроверяет всё перед сохранением).
   ============================================================ */

const adminState = {
  puzzles: [],
  editingId: null,
  check: null,          // результат PuzzleCheck.checkPuzzle для текущих полей
  selected: null,       // выбранная клетка на доске редактора
  legal: [],
  confirmDeleteId: null,
  confirmTimer: null,
  saving: false,
};

const ADMIN_ERROR_MESSAGES = {
  forbidden: "Нет прав администратора",
  puzzle_not_found: "Задача не найдена — возможно, её уже удалили",
  storage_error: "Ошибка сервера. Попробуйте ещё раз",
  invalid_token: "Сессия истекла — войдите заново",
  auth_required: "Сессия истекла — войдите заново",
};

function adminEl(id) { return document.getElementById(id); }

async function adminApi(method, url, body) {
  const headers = { Authorization: `Bearer ${authToken}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.message) || ADMIN_ERROR_MESSAGES[data && data.error] || "Не удалось выполнить запрос");
    err.status = res.status;
    throw err;
  }
  return data;
}

function bindAdminMenu() {
  adminEl("btnAdmin").addEventListener("click", openAdminMenu);
  adminEl("btnAdminClose").addEventListener("click", closeAdminMenu);
  adminEl("btnAdminNew").addEventListener("click", () => openAdminEditor(null));
  adminEl("btnAdminEditClose").addEventListener("click", backToAdminList);
  adminEl("btnAdminCancel").addEventListener("click", backToAdminList);
  adminEl("btnAdminSave").addEventListener("click", saveAdminPuzzle);

  adminEl("adminFen").addEventListener("input", onAdminInput);
  adminEl("adminSolution").addEventListener("input", onAdminInput);

  adminEl("btnAdminUndo").addEventListener("click", () => {
    setAdminSolutionTokens(adminSolutionTokens().slice(0, -1));
  });
  adminEl("btnAdminClear").addEventListener("click", () => setAdminSolutionTokens([]));

  adminEl("adminBoard").addEventListener("click", (e) => {
    const sq = e.target.closest(".sq");
    if (sq) onAdminBoardClick(sq.dataset.square);
  });
}

function showAdminView(view) {
  adminEl("adminViewList").hidden = view !== "list";
  adminEl("adminViewEdit").hidden = view !== "edit";
  adminEl("adminOverlay").scrollTop = 0;
}

function openAdminMenu() {
  if (!isSyncedAccount || !profile.isAdmin) return;
  adminEl("adminOverlay").hidden = false;
  showAdminView("list");
  loadAdminList();
}

function closeAdminMenu() {
  adminEl("adminOverlay").hidden = true;
  clearTimeout(adminState.confirmTimer);
  adminState.confirmDeleteId = null;
}

function backToAdminList() {
  showAdminView("list");
  loadAdminList();
}

/* ---------- список ---------- */

async function loadAdminList() {
  const errEl = adminEl("adminListError");
  errEl.hidden = true;
  try {
    const data = await adminApi("GET", "/api/admin/puzzles");
    adminState.puzzles = data.puzzles || [];
    renderAdminList();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
  }
}

function renderAdminList() {
  const list = adminEl("adminList");
  list.innerHTML = "";
  adminEl("adminCount").textContent = adminState.puzzles.length;

  if (!adminState.puzzles.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Задач пока нет. Нажмите «Создать задачу».";
    list.appendChild(empty);
    return;
  }

  adminState.puzzles.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "admin-item";

    const main = document.createElement("div");
    main.className = "admin-item-main";
    const title = document.createElement("div");
    title.className = "admin-item-title";
    title.textContent = `${i + 1}. ${p.tag}`;
    const meta = document.createElement("div");
    meta.className = "admin-item-meta";
    const solverWhite = (p.fen.split(" ")[1] || "w") === "w";
    const plies = p.solution.length;
    meta.textContent = `${solverWhite ? "ходят белые" : "ходят чёрные"} · ходов в решении: ${plies}`;
    main.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "admin-item-actions";
    const edit = document.createElement("button");
    edit.className = "btn btn-ghost btn-sm";
    edit.type = "button";
    edit.textContent = "Изменить";
    edit.addEventListener("click", () => openAdminEditor(p));
    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-sm admin-del";
    del.type = "button";
    const confirming = adminState.confirmDeleteId === p.id;
    del.textContent = confirming ? "Точно удалить?" : "Удалить";
    del.classList.toggle("confirming", confirming);
    del.addEventListener("click", () => onAdminDeleteClick(p.id));
    actions.append(edit, del);

    item.append(main, actions);
    list.appendChild(item);
  });
}

// Удаление в два тапа: первый просит подтвердить, второй — удаляет.
// (Встроенный confirm() в мини-приложениях Telegram работает нестабильно.)
async function onAdminDeleteClick(id) {
  if (adminState.confirmDeleteId !== id) {
    adminState.confirmDeleteId = id;
    clearTimeout(adminState.confirmTimer);
    adminState.confirmTimer = setTimeout(() => {
      adminState.confirmDeleteId = null;
      renderAdminList();
    }, 3500);
    renderAdminList();
    return;
  }
  clearTimeout(adminState.confirmTimer);
  adminState.confirmDeleteId = null;
  try {
    await adminApi("DELETE", `/api/admin/puzzles/${encodeURIComponent(id)}`);
    showToast("Задача удалена");
  } catch (e) {
    showToast(e.message, 3000);
  }
  loadAdminList();
}

/* ---------- редактор ---------- */

function openAdminEditor(puzzle) {
  adminState.editingId = puzzle ? puzzle.id : null;
  adminEl("adminEditTitle").textContent = puzzle ? "Редактирование задачи" : "Новая задача";
  adminEl("adminTag").value = puzzle ? puzzle.tag : "";
  adminEl("adminFen").value = puzzle ? puzzle.fen : "";
  adminEl("adminSolution").value = puzzle ? puzzle.solution.map((m) => m.from + m.to + (m.promotion || "")).join(" ") : "";
  adminEl("adminHint").value = puzzle ? puzzle.hint : "";
  showAdminView("edit");
  onAdminInput();
}

function adminSolutionTokens() {
  return adminEl("adminSolution").value.trim().split(/[\s,;]+/).filter(Boolean);
}

function setAdminSolutionTokens(tokens) {
  adminEl("adminSolution").value = tokens.join(" ");
  onAdminInput();
}

function onAdminInput() {
  adminState.selected = null;
  adminState.legal = [];
  adminState.check = PuzzleCheck.checkPuzzle({
    fen: adminEl("adminFen").value,
    moves: adminEl("adminSolution").value,
  });
  renderAdminEditorState();
}

function renderAdminEditorState() {
  const check = adminState.check;
  renderAdminBoard();

  const fenText = adminEl("adminFen").value.trim();
  const solText = adminEl("adminSolution").value.trim();
  const info = adminEl("adminBoardInfo");
  const status = adminEl("adminStatus");
  const save = adminEl("btnAdminSave");

  const setStatus = (text, kind) => {
    status.textContent = text;
    status.className = "admin-status" + (kind ? " " + kind : "");
  };

  if (check.stage === "fen") {
    info.textContent = "Введите позицию — здесь появится доска";
    setStatus(fenText ? check.error : "", fenText ? "err" : "");
    save.disabled = true;
    return;
  }

  const side = check.game.turn() === "w" ? "белых" : "чёрных";
  const ended = check.game.in_checkmate() ? " · мат" : check.game.in_stalemate() ? " · пат" : "";
  info.textContent = `Сейчас ход ${side} · ходов в решении: ${check.validPlies}${ended}`;

  if (check.ok) {
    const n = check.moves.length;
    const end = check.final === "checkmate" ? " · заканчивается матом" : check.final === "stalemate" ? " · заканчивается патом" : "";
    setStatus(`✓ Позиция и решение корректны · ходов: ${n}${end}`, "ok");
    save.disabled = adminState.saving;
  } else if (!solText) {
    setStatus("Сделайте ход на доске или впишите его текстом — это и будет решение", "");
    save.disabled = true;
  } else {
    setStatus(check.error, "err");
    save.disabled = true;
  }
}

function renderAdminBoard() {
  const el = adminEl("adminBoard");
  el.innerHTML = "";
  const check = adminState.check;
  const hasPos = check && check.stage !== "fen" && check.game;

  const board = hasPos ? check.game.board() : Array.from({ length: 8 }, () => Array(8).fill(null));
  const orient = hasPos && check.solverColor === "b" ? "black" : "white";
  const rows = orient === "white" ? board : [...board].reverse().map((r) => [...r].reverse());

  // Подсветка последнего сделанного хода решения.
  let last = null;
  if (hasPos && check.validPlies > 0) {
    const pre = PuzzleCheck.parseMoves(adminSolutionTokens().slice(0, check.validPlies));
    if (pre.ok && pre.moves.length) last = pre.moves[pre.moves.length - 1];
  }

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = rows[r][c];
      const fileIdx = orient === "white" ? c : 7 - c;
      const rankNum = orient === "white" ? 8 - r : r + 1;
      const name = FILES[fileIdx] + rankNum;

      const sq = document.createElement("div");
      sq.className = "sq " + ((fileIdx + rankNum) % 2 === 1 ? "light" : "dark");
      sq.dataset.square = name;
      if (piece) {
        const span = document.createElement("span");
        span.className = "piece " + (piece.color === "w" ? "piece-white" : "piece-black");
        span.textContent = PIECE_GLYPH[piece.color === "w" ? piece.type.toUpperCase() : piece.type] + "\uFE0E";
        sq.appendChild(span);
      }
      if (last && (name === last.from || name === last.to)) sq.classList.add("last-move");
      if (adminState.selected === name) sq.classList.add("selected");
      const target = adminState.legal.find((m) => m.to === name);
      if (target) {
        sq.classList.add("legal");
        if (target.flags.includes("c")) sq.classList.add("capture");
      }
      el.appendChild(sq);
    }
  }
}

// Ходы прямо на доске: выбрать фигуру → выбрать клетку. Ход дописывается в решение.
function onAdminBoardClick(square) {
  const check = adminState.check;
  if (!check || check.stage === "fen" || !check.game) return;
  const game = check.game;

  if (adminState.selected) {
    const target = adminState.legal.find((m) => m.to === square);
    if (target) {
      // Если в тексте есть «хвост» с ошибкой — отбрасываем его и продолжаем с последней верной позиции.
      const valid = adminSolutionTokens().slice(0, check.validPlies);
      valid.push(adminState.selected + square);
      setAdminSolutionTokens(valid);
      return;
    }
  }

  const piece = game.get(square);
  if (piece && piece.color === game.turn()) {
    adminState.selected = square;
    adminState.legal = game.moves({ square, verbose: true });
  } else {
    adminState.selected = null;
    adminState.legal = [];
  }
  renderAdminBoard();
}

async function saveAdminPuzzle() {
  const check = adminState.check;
  if (!check || !check.ok || adminState.saving) return;

  adminState.saving = true;
  adminEl("btnAdminSave").disabled = true;
  const body = {
    tag: adminEl("adminTag").value.trim(),
    fen: check.fen,
    hint: adminEl("adminHint").value.trim(),
    solution: check.moves,
  };
  try {
    if (adminState.editingId) {
      await adminApi("PUT", `/api/admin/puzzles/${encodeURIComponent(adminState.editingId)}`, body);
    } else {
      await adminApi("POST", "/api/admin/puzzles", body);
    }
    showToast("Задача сохранена");
    adminState.saving = false;
    backToAdminList();
  } catch (e) {
    adminState.saving = false;
    const status = adminEl("adminStatus");
    status.textContent = e.message;
    status.className = "admin-status err";
    adminEl("btnAdminSave").disabled = false;
  }
}

/* ============================================================
   TOURNAMENTS PAGE
   ============================================================ */

async function loadTournaments() {
  document.getElementById("statPlayed").textContent = profile.gamesPlayed;
  document.getElementById("statWins").textContent = profile.wins;
  document.getElementById("statStreak").textContent = profile.streak;

  const listEl = document.getElementById("gameList");
  if (!isSyncedAccount || !authToken) {
    listEl.innerHTML = '<div class="empty-state">Войдите в аккаунт в профиле, чтобы видеть историю партий на всех устройствах.</div>';
    return;
  }

  try {
    const res = await fetch("/api/games", { headers: { Authorization: `Bearer ${authToken}` } });
    const games = await res.json();
    if (!games.length) {
      listEl.innerHTML = '<div class="empty-state">Пока нет сыгранных партий. Начните с главной страницы.</div>';
      return;
    }
    listEl.innerHTML = "";
    games.forEach((g) => {
      const row = document.createElement("div");
      row.className = "game-row";
      row.innerHTML = `
        <div class="game-row-left">
          <span class="game-opp">${g.opponentName}</span>
          <span class="game-meta">${new Date(g.date).toLocaleDateString("ru-RU")} · ${g.ratingDelta > 0 ? "+" : ""}${g.ratingDelta}</span>
        </div>
        <span class="game-result ${g.result}">${g.result === "win" ? "Победа" : g.result === "loss" ? "Поражение" : "Ничья"}</span>
      `;
      listEl.appendChild(row);
    });
  } catch {
    listEl.innerHTML = '<div class="empty-state">Не удалось загрузить историю партий.</div>';
  }
}
