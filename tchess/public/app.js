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
let mode = "none";                // "none" | "puzzle" | "online"
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
  if (mode === "online" && myColor && game.turn() !== myColor[0]) return;

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

  if (piece && ((mode === "online" && piece.color === myColor[0]) || mode === "puzzle")) {
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

function startPuzzleMode() {
  mode = "puzzle";
  document.getElementById("homeActions").hidden = true;
  document.getElementById("matchActions").hidden = true;
  document.getElementById("puzzlePanel").hidden = false;
  document.getElementById("clocks").hidden = true;
  loadPuzzle(0);
}

function loadPuzzle(idx) {
  currentPuzzleIdx = ((idx % TCHESS_PUZZLES.length) + TCHESS_PUZZLES.length) % TCHESS_PUZZLES.length;
  const puzzle = TCHESS_PUZZLES[currentPuzzleIdx];
  game = new Chess(puzzle.fen);
  orientation = game.turn() === "w" ? "white" : "black";
  puzzleMoveCursor = 0;
  selectedSquare = null;
  legalTargets = [];
  lastMove = null;
  buildFileLabels();
  renderBoard();
  document.getElementById("puzzleIndex").textContent = `Задача ${currentPuzzleIdx + 1} / ${TCHESS_PUZZLES.length}`;
  document.getElementById("puzzleTag").textContent = puzzle.tag;
  setStatus("Ваш ход — найдите лучший ход в позиции");
}

function handlePuzzleMove(result) {
  const puzzle = TCHESS_PUZZLES[currentPuzzleIdx];
  const expected = puzzle.solution[puzzleMoveCursor];

  if (result.from === expected.from && result.to === expected.to) {
    puzzleMoveCursor++;
    if (puzzleMoveCursor >= puzzle.solution.length) {
      setStatus("Верно! Задача решена 🎉");
      showToast("Задача решена!");
      reportPuzzleSolved();
      setTimeout(() => loadPuzzle(currentPuzzleIdx + 1), 1100);
    } else {
      setStatus("Верно, продолжайте");
      renderBoard();
    }
  } else {
    setStatus("Не тот ход — попробуйте снова");
    game.undo();
    lastMove = null;
    renderBoard();
  }
}

async function reportPuzzleSolved() {
  if (!isSyncedAccount || !authToken) {
    // Гость: рейтинг за задачи копится только локально в этой сессии и
    // не сохраняется — как и раньше без входа в аккаунт.
    addLocalRatingDelta(4);
    return;
  }
  try {
    const res = await fetch("/api/puzzle/solved", {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error("puzzle sync failed");
    const data = await res.json();
    profile.rating = data.rating;
    updateTopbarRating();
    refreshProfileUI();
  } catch {
    addLocalRatingDelta(4);
  }
}

function showPuzzleHint() {
  const puzzle = TCHESS_PUZZLES[currentPuzzleIdx];
  showToast(puzzle.hint, 3200);
}

function exitPuzzleMode() {
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

  setStatus(`${msg.friend ? "Игра с другом · " : ""}Соперник: ${opponentInfo.name} (${opponentInfo.rating}) · вы играете ${myColor === "white" ? "белыми" : "чёрными"}`);
}

function onOpponentMove(msg) {
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

function finishOnlineGame(result) {
  sendWS({ type: "game_over", roomId, result, uid: profile.uid, opponentUid: opponentInfo?.uid });
  onGameOver({ result });
}

function resignGame() {
  sendWS({ type: "game_over", roomId, result: "loss", uid: profile.uid, opponentUid: opponentInfo?.uid, resigned: true });
  onGameOver({ result: "loss" });
}

function onGameOver(msg) {
  stopClock();
  const label = msg.result === "win" ? "Победа! 🎉" : msg.result === "loss" ? "Поражение" : "Ничья";
  setStatus(label);
  const delta = msg.ratingDelta !== undefined
    ? msg.ratingDelta
    : (msg.result === "win" ? 8 : msg.result === "loss" ? -6 : 1);
  addLocalRatingDelta(delta);
  if (msg.saved === false) {
    showToast(`${label} · рейтинг не сохраняется в гостевом режиме`, 3000);
  } else {
    showToast(label);
  }
  document.getElementById("btnResign").hidden = true;
  document.getElementById("btnLeaveGame").hidden = false;
}

function endOnlineGame() {
  stopClock();
  document.getElementById("matchActions").hidden = true;
  document.getElementById("homeActions").hidden = false;
  document.getElementById("clocks").hidden = true;
  mode = "none";
  resetBoardToStart();
}

function leaveGame() {
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
  isSyncedAccount = true;
}

function resetToGuest() {
  profile.uid = null;
  profile.name = "Гость";
  profile.tchessId = "T-CHESS-000000";
  profile.rating = null;
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
