/* ============================================================
   T-CHESS mini app
   ============================================================ */

const tg = window.Telegram ? window.Telegram.WebApp : null;
if (tg) { tg.ready(); tg.expand(); }

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
  rating: 1200,
  desc: "",
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  streak: 0,
};
let isSyncedAccount = false;

/* ============================================================
   BOOTSTRAP
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
  buildFileLabels();
  renderBoard();
  bindNav();
  bindHomeActions();
  bindProfileActions();
  rotateSponsorBanner();
  loadLocalIdentity();
  tryAuth();
});

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
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === name);
  });
  if (name === "tournaments") loadTournaments();
  if (name === "profile") refreshProfileUI();
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
        span.textContent = PIECE_GLYPH[piece.color === "w" ? piece.type.toUpperCase() : piece.type];
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
  document.getElementById("btnFindOpponent").addEventListener("click", startMatchmaking);
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
      addLocalRatingDelta(4);
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
  if (socket && socket.readyState === WebSocket.OPEN) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWSMessage(msg);
  });

  socket.addEventListener("close", () => {
    if (mode === "online") showToast("Соединение потеряно");
  });
}

function startMatchmaking() {
  ensureSocket();
  const send = () => sendWS({ type: "find_opponent", uid: profile.uid, name: profile.name, rating: profile.rating });
  if (socket.readyState === WebSocket.OPEN) send();
  else socket.addEventListener("open", send, { once: true });

  document.getElementById("homeActions").hidden = true;
  document.getElementById("matchActions").hidden = false;
  document.getElementById("btnCancelSearch").hidden = false;
  document.getElementById("btnResign").hidden = true;
  document.getElementById("btnLeaveGame").hidden = true;
  setStatus("Ищем соперника…");
}

function cancelSearch() {
  sendWS({ type: "cancel_search", uid: profile.uid });
  document.getElementById("homeActions").hidden = false;
  document.getElementById("matchActions").hidden = true;
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
  }
}

function onMatchFound(msg) {
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

  document.getElementById("btnCancelSearch").hidden = true;
  document.getElementById("btnResign").hidden = false;
  document.getElementById("btnLeaveGame").hidden = true;
  document.getElementById("clocks").hidden = false;
  clockSeconds = { top: 300, bottom: 300 };
  startClock();

  setStatus(`Соперник: ${opponentInfo.name} (${opponentInfo.rating}) · вы играете ${myColor === "white" ? "белыми" : "чёрными"}`);
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
  showToast(label);
  if (msg.ratingDelta !== undefined) {
    profile.rating += msg.ratingDelta;
    updateTopbarRating();
  } else {
    addLocalRatingDelta(msg.result === "win" ? 8 : msg.result === "loss" ? -6 : 1);
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
   PROFILE / AUTH
   ============================================================ */

function loadLocalIdentity() {
  const savedDesc = localStorage.getItem("tchess_desc");
  const savedRating = localStorage.getItem("tchess_rating");
  const savedLogin = localStorage.getItem("tchess_logged_in");
  if (savedDesc) profile.desc = savedDesc;
  if (savedRating) profile.rating = parseInt(savedRating, 10);
  isSyncedAccount = savedLogin === "1";
}

async function tryAuth() {
  if (!tg || !tg.initData) {
    // Работает вне Telegram (тест в браузере) — используем гостевой профиль.
    profile.name = "Гость";
    profile.tchessId = "T-CHESS-000000";
    updateTopbarRating();
    refreshProfileUI();
    return;
  }

  const u = tg.initDataUnsafe?.user;
  if (u) {
    profile.uid = u.id;
    profile.name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "Игрок";
    profile.photoUrl = u.photo_url || null;
    profile.tchessId = "T-CHESS-" + String(u.id).slice(-6).padStart(6, "0");
  }

  if (isSyncedAccount) {
    await syncProfileWithServer();
  }
  updateTopbarRating();
  refreshProfileUI();
}

async function syncProfileWithServer() {
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: tg.initData }),
    });
    if (!res.ok) throw new Error("auth failed");
    const data = await res.json();
    profile.rating = data.rating;
    profile.gamesPlayed = data.gamesPlayed;
    profile.wins = data.wins;
    profile.losses = data.losses;
    profile.draws = data.draws;
    profile.streak = data.streak;
    profile.desc = data.desc ?? profile.desc;
    isSyncedAccount = true;
    localStorage.setItem("tchess_logged_in", "1");
  } catch (e) {
    showToast("Не удалось подключиться к серверу — работаем локально");
    isSyncedAccount = false;
  }
}

function bindProfileActions() {
  document.getElementById("btnSaveDesc").addEventListener("click", saveDesc);
  document.getElementById("btnAuth").addEventListener("click", toggleAuth);
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
  document.getElementById("profileRatingNum").textContent = profile.rating;
  document.getElementById("btnAuth").textContent = isSyncedAccount ? "Выйти" : "Войти";
  updateTopbarRating();
}

function updateTopbarRating() {
  document.querySelector("#topbarRating .rating-num").textContent = profile.rating;
}

async function saveDesc() {
  profile.desc = document.getElementById("profileDesc").value.trim();
  localStorage.setItem("tchess_desc", profile.desc);
  if (isSyncedAccount && profile.uid) {
    try {
      await fetch("/api/profile/desc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: profile.uid, desc: profile.desc }),
      });
    } catch {}
  }
  showToast("Описание сохранено");
}

async function toggleAuth() {
  if (isSyncedAccount) {
    isSyncedAccount = false;
    localStorage.removeItem("tchess_logged_in");
    showToast("Вы вышли из аккаунта T-CHESS ID");
    refreshProfileUI();
  } else {
    if (!tg || !tg.initData) {
      showToast("Откройте бота внутри Telegram, чтобы войти");
      return;
    }
    await syncProfileWithServer();
    showToast(isSyncedAccount ? "Вход выполнен" : "Не удалось войти");
    refreshProfileUI();
  }
}

function addLocalRatingDelta(delta) {
  profile.rating += delta;
  localStorage.setItem("tchess_rating", String(profile.rating));
  updateTopbarRating();
}

/* ============================================================
   TOURNAMENTS PAGE
   ============================================================ */

async function loadTournaments() {
  document.getElementById("statPlayed").textContent = profile.gamesPlayed;
  document.getElementById("statWins").textContent = profile.wins;
  document.getElementById("statStreak").textContent = profile.streak;

  const listEl = document.getElementById("gameList");
  if (!isSyncedAccount || !profile.uid) {
    listEl.innerHTML = '<div class="empty-state">Войдите в T-CHESS ID в профиле, чтобы видеть историю партий на всех устройствах.</div>';
    return;
  }

  try {
    const res = await fetch(`/api/games/${profile.uid}`);
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
