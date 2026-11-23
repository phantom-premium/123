/*!
 * Шахматный бот T-CHESS.
 *
 * Самостоятельный движок (не зависит от chess.js): доска 0x88, генерация ходов
 * с make/unmake, поиск alpha-beta с итеративным углублением, форсированный
 * поиск взятий (quiescence), расширение при шахе, оценка «материал + позиция
 * фигур + структура пешек + матование в эндшпиле».
 *
 * Работает где угодно: в Web Worker (bot-worker.js), в основном потоке
 * браузера (запасной вариант) и в Node (тесты). Глобального состояния
 * вне модуля нет, но сам поиск однопоточный: за раз — один запрос.
 *
 * Использование:
 *   BotEngine.chooseMove({ moves: [{from:"e2", to:"e4"}, ...], level: 1|2|3, timeMs?, fen? })
 *     → { from, to, promotion?, score, depth, nodes }  или null, если ходов нет.
 *   `moves` — все ходы партии с начальной позиции: по ним движок восстанавливает
 *   позицию И историю повторений (чтобы не «ходить кругами» в выигранной позиции).
 *
 * Уровни:
 *   1 «Лёгкий»  — видит только свой ход (и мат в 1), часто ошибается;
 *   2 «Средний» — просчитывает 2 полухода + взятия, изредка неточен;
 *   3 «Сильный» — итеративное углубление до ~6 полуходов за ~1.5 с.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BotEngine = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /* ---------- константы ---------- */
  const P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;      // тип фигуры; чёрные = тип | 8
  const WHITE = 0, BLACK = 1;
  const INF = 1000000;
  const MATE = 100000;
  const MAXPLY = 64;
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  const KNIGHT_D = [-33, -31, -18, -14, 14, 18, 31, 33];
  const KING_D = [-17, -16, -15, -1, 1, 15, 16, 17];
  const BISHOP_D = [-17, -15, 15, 17];
  const ROOK_D = [-16, -1, 1, 16];

  // Флаги хода (биты 17+): 1 взятие, 2 взятие на проходе, 4 короткая рокировка,
  // 8 длинная рокировка, 16 ход пешки на две клетки.
  const F_CAP = 1, F_EP = 2, F_OO = 4, F_OOO = 8, F_DBL = 16;

  const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 0];

  // Права на рокировку: 1 = белая короткая, 2 = белая длинная, 4 = чёрная короткая, 8 = чёрная длинная.
  const CASTLE_MASK = new Int8Array(128).fill(15);
  CASTLE_MASK[0x00] = 15 & ~2; CASTLE_MASK[0x07] = 15 & ~1; CASTLE_MASK[0x04] = 15 & ~3;
  CASTLE_MASK[0x70] = 15 & ~8; CASTLE_MASK[0x77] = 15 & ~4; CASTLE_MASK[0x74] = 15 & ~12;

  /* ---------- таблицы оценки (Simplified Evaluation Function) ----------
     Индекс 0 = a8, 63 = h1 — с точки зрения белых. */
  const PST = [
    null,
    [ 0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0 ],
    [ -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50 ],
    [ -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20 ],
    [ 0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0 ],
    [ -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20 ],
    null,
  ];
  const KING_MG = [
    -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20,
  ];
  const KING_EG = [
    -50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50,
  ];
  const PASSED_BONUS = [0, 5, 10, 20, 35, 60, 100, 0]; // по «шагам» пешки от своей стороны

  /* ---------- Zobrist-хеши (детерминированные) ---------- */
  let seed = 0x9e3779b9;
  function rnd32() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed | 0;
  }
  const ZL = new Int32Array(16 * 128), ZH = new Int32Array(16 * 128);
  const ZCL = new Int32Array(16), ZCH = new Int32Array(16);
  const ZEL = new Int32Array(128), ZEH = new Int32Array(128);
  for (let i = 0; i < ZL.length; i++) { ZL[i] = rnd32(); ZH[i] = rnd32(); }
  for (let i = 0; i < 16; i++) { ZCL[i] = rnd32(); ZCH[i] = rnd32(); }
  for (let i = 0; i < 128; i++) { ZEL[i] = rnd32(); ZEH[i] = rnd32(); }
  const ZSL = rnd32(), ZSH = rnd32();

  /* ---------- состояние позиции ---------- */
  const board = new Int8Array(128);
  let side = WHITE, castle = 0, ep = -1, half = 0, sp = 0;
  const kingSq = [0x04, 0x74];
  let hashL = 0, hashH = 0;

  // стек для отката хода и история хешей (для повторений)
  const STACK = 2048;
  const S_cap = new Int8Array(STACK), S_castle = new Int8Array(STACK), S_ep = new Int16Array(STACK), S_half = new Int16Array(STACK);
  const posL = new Int32Array(STACK), posH = new Int32Array(STACK);

  // буферы ходов по глубине
  const MV = [], SC = [];
  for (let i = 0; i < MAXPLY + 8; i++) { MV.push(new Int32Array(256)); SC.push(new Int32Array(256)); }
  const killers = [], history = [new Int32Array(128 * 128), new Int32Array(128 * 128)];
  for (let i = 0; i < MAXPLY + 8; i++) killers.push([0, 0]);

  function computeHash() {
    let l = 0, h = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = board[sq];
      if (p) { l ^= ZL[p * 128 + sq]; h ^= ZH[p * 128 + sq]; }
    }
    l ^= ZCL[castle]; h ^= ZCH[castle];
    if (ep !== -1) { l ^= ZEL[ep]; h ^= ZEH[ep]; }
    if (side === BLACK) { l ^= ZSL; h ^= ZSH; }
    hashL = l; hashH = h;
  }

  function setFen(fen) {
    board.fill(0);
    const parts = fen.trim().split(/\s+/);
    const rows = parts[0].split("/");
    const map = { p: P, n: N, b: B, r: R, q: Q, k: K };
    for (let i = 0; i < 8; i++) {
      let file = 0;
      const rank = 7 - i;
      for (const ch of rows[i]) {
        if (/\d/.test(ch)) { file += Number(ch); continue; }
        const isWhite = ch === ch.toUpperCase();
        const type = map[ch.toLowerCase()];
        const sq = rank * 16 + file;
        board[sq] = type | (isWhite ? 0 : 8);
        if (type === K) kingSq[isWhite ? WHITE : BLACK] = sq;
        file++;
      }
    }
    side = parts[1] === "b" ? BLACK : WHITE;
    castle = 0;
    const c = parts[2] || "-";
    if (c.includes("K")) castle |= 1;
    if (c.includes("Q")) castle |= 2;
    if (c.includes("k")) castle |= 4;
    if (c.includes("q")) castle |= 8;
    ep = parts[3] && parts[3] !== "-" ? (Number(parts[3][1]) - 1) * 16 + (parts[3].charCodeAt(0) - 97) : -1;
    half = parts[4] ? parseInt(parts[4], 10) : 0;
    sp = 0;
    computeHash();
    posL[0] = hashL; posH[0] = hashH;
  }

  /* ---------- атаки ---------- */
  function isAttacked(sq, by) {
    // пешки: белая пешка на s атакует s+15 и s+17, чёрная — s-15 и s-17
    if (by === WHITE) {
      let s = sq - 15; if (!(s & 0x88) && board[s] === P) return true;
      s = sq - 17; if (!(s & 0x88) && board[s] === P) return true;
    } else {
      let s = sq + 15; if (!(s & 0x88) && board[s] === (P | 8)) return true;
      s = sq + 17; if (!(s & 0x88) && board[s] === (P | 8)) return true;
    }
    const off = by << 3;
    for (let i = 0; i < 8; i++) {
      const s = sq + KNIGHT_D[i];
      if (!(s & 0x88) && board[s] === (N | off)) return true;
    }
    for (let i = 0; i < 8; i++) {
      const s = sq + KING_D[i];
      if (!(s & 0x88) && board[s] === (K | off)) return true;
    }
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_D[i];
      let s = sq + d;
      while (!(s & 0x88)) {
        const p = board[s];
        if (p) { if (p === (B | off) || p === (Q | off)) return true; break; }
        s += d;
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_D[i];
      let s = sq + d;
      while (!(s & 0x88)) {
        const p = board[s];
        if (p) { if (p === (R | off) || p === (Q | off)) return true; break; }
        s += d;
      }
    }
    return false;
  }

  function inCheck() {
    return isAttacked(kingSq[side], side ^ 1);
  }

  /* ---------- генерация ходов ---------- */
  // Заполняет MV[ply]/SC[ply] псевдолегальными ходами (легальность проверяется при make).
  // caps = true — только взятия и превращения (для quiescence).
  function gen(ply, caps) {
    const list = MV[ply], sc = SC[ply];
    let n = 0;
    const us = side, them = us ^ 1, off = us << 3;
    const push = (from, to, promo, flags, score) => {
      list[n] = from | (to << 7) | (promo << 14) | (flags << 17);
      sc[n] = score;
      n++;
    };
    for (let from = 0; from < 128; from++) {
      if (from & 0x88) continue;
      const piece = board[from];
      if (!piece || (piece >> 3) !== us) continue;
      const type = piece & 7;

      if (type === P) {
        const dir = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 7 : 0;
        const one = from + dir;
        if (!(one & 0x88) && !board[one]) {
          if ((one >> 4) === promoRank) {
            push(from, one, Q, 0, 9000 + 900);
            if (!caps) { push(from, one, N, 0, 9000 + 320); push(from, one, R, 0, 9000 + 500); push(from, one, B, 0, 9000 + 330); }
          } else if (!caps) {
            push(from, one, 0, 0, 0);
            if ((from >> 4) === startRank) {
              const two = one + dir;
              if (!board[two]) push(from, two, 0, F_DBL, 0);
            }
          }
        }
        for (let k = 0; k < 2; k++) {
          const to = from + dir + (k === 0 ? -1 : 1);
          if (to & 0x88) continue;
          const target = board[to];
          if (target && (target >> 3) === them) {
            const s = 10000 + PIECE_VALUE[target & 7] * 10 - 1;
            if ((to >> 4) === promoRank) {
              push(from, to, Q, F_CAP, 9000 + 900 + s);
              if (!caps) { push(from, to, N, F_CAP, 9000 + 320 + s); push(from, to, R, F_CAP, 9000 + 500 + s); push(from, to, B, F_CAP, 9000 + 330 + s); }
            } else {
              push(from, to, 0, F_CAP, s);
            }
          } else if (to === ep) {
            push(from, to, 0, F_EP | F_CAP, 10000 + 1000 - 1);
          }
        }
      } else if (type === N || type === K) {
        const dirs = type === N ? KNIGHT_D : KING_D;
        for (let i = 0; i < 8; i++) {
          const to = from + dirs[i];
          if (to & 0x88) continue;
          const target = board[to];
          if (!target) {
            if (!caps) push(from, to, 0, 0, 0);
          } else if ((target >> 3) === them) {
            push(from, to, 0, F_CAP, 10000 + PIECE_VALUE[target & 7] * 10 - type);
          }
        }
        if (type === K && !caps) {
          // рокировка: король и поля прохода не под боем, поля между пусты
          const base = us === WHITE ? 0x00 : 0x70;
          if (from === base + 4 && !isAttacked(from, them)) {
            const kBit = us === WHITE ? 1 : 4, qBit = us === WHITE ? 2 : 8;
            if ((castle & kBit) && !board[base + 5] && !board[base + 6] && board[base + 7] === (R | off) &&
                !isAttacked(base + 5, them) && !isAttacked(base + 6, them)) {
              push(from, base + 6, 0, F_OO, 0);
            }
            if ((castle & qBit) && !board[base + 3] && !board[base + 2] && !board[base + 1] && board[base] === (R | off) &&
                !isAttacked(base + 3, them) && !isAttacked(base + 2, them)) {
              push(from, base + 2, 0, F_OOO, 0);
            }
          }
        }
      } else {
        const dirs = type === B ? BISHOP_D : type === R ? ROOK_D : KING_D; // ферзь ходит по всем 8 направлениям
        for (let i = 0; i < dirs.length; i++) {
          const d = dirs[i];
          let to = from + d;
          while (!(to & 0x88)) {
            const target = board[to];
            if (!target) {
              if (!caps) push(from, to, 0, 0, 0);
            } else {
              if ((target >> 3) === them) push(from, to, 0, F_CAP, 10000 + PIECE_VALUE[target & 7] * 10 - type);
              break;
            }
            to += d;
          }
        }
      }
    }
    return n;
  }

  /* ---------- сделать / откатить ход ---------- */
  function make(m) {
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, fl = m >> 17;
    const piece = board[from];
    const us = side;
    let cap = board[to];
    S_castle[sp] = castle; S_ep[sp] = ep; S_half[sp] = half;

    let hl = hashL, hh = hashH;
    if (ep !== -1) { hl ^= ZEL[ep]; hh ^= ZEH[ep]; }
    hl ^= ZCL[castle]; hh ^= ZCH[castle];

    board[from] = 0;
    hl ^= ZL[piece * 128 + from]; hh ^= ZH[piece * 128 + from];

    if (fl & F_EP) {
      const capSq = us === WHITE ? to - 16 : to + 16;
      cap = board[capSq];
      board[capSq] = 0;
      hl ^= ZL[cap * 128 + capSq]; hh ^= ZH[cap * 128 + capSq];
    } else if (cap) {
      hl ^= ZL[cap * 128 + to]; hh ^= ZH[cap * 128 + to];
    }
    S_cap[sp] = cap;

    const placed = promo ? (promo | (us << 3)) : piece;
    board[to] = placed;
    hl ^= ZL[placed * 128 + to]; hh ^= ZH[placed * 128 + to];

    if (fl & F_OO) {
      const rook = R | (us << 3);
      board[from + 3] = 0; board[from + 1] = rook;
      hl ^= ZL[rook * 128 + from + 3] ^ ZL[rook * 128 + from + 1]; hh ^= ZH[rook * 128 + from + 3] ^ ZH[rook * 128 + from + 1];
    } else if (fl & F_OOO) {
      const rook = R | (us << 3);
      board[from - 4] = 0; board[from - 1] = rook;
      hl ^= ZL[rook * 128 + from - 4] ^ ZL[rook * 128 + from - 1]; hh ^= ZH[rook * 128 + from - 4] ^ ZH[rook * 128 + from - 1];
    }

    if ((piece & 7) === K) kingSq[us] = to;
    castle &= CASTLE_MASK[from] & CASTLE_MASK[to];
    ep = (fl & F_DBL) ? (from + to) >> 1 : -1;
    half = ((piece & 7) === P || cap) ? 0 : half + 1;

    hl ^= ZCL[castle]; hh ^= ZCH[castle];
    if (ep !== -1) { hl ^= ZEL[ep]; hh ^= ZEH[ep]; }
    hl ^= ZSL; hh ^= ZSH;

    side = us ^ 1;
    sp++;
    hashL = hl; hashH = hh;
    posL[sp] = hl; posH[sp] = hh;
  }

  function unmake(m) {
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, fl = m >> 17;
    sp--;
    side ^= 1;
    const us = side;
    castle = S_castle[sp]; ep = S_ep[sp]; half = S_half[sp];
    hashL = posL[sp]; hashH = posH[sp];

    const placed = board[to];
    const piece = promo ? (P | (us << 3)) : placed;
    board[from] = piece;
    if (fl & F_EP) {
      board[to] = 0;
      board[us === WHITE ? to - 16 : to + 16] = S_cap[sp];
    } else {
      board[to] = S_cap[sp];
    }
    if (fl & F_OO) {
      const rook = R | (us << 3);
      board[from + 1] = 0; board[from + 3] = rook;
    } else if (fl & F_OOO) {
      const rook = R | (us << 3);
      board[from - 1] = 0; board[from - 4] = rook;
    }
    if ((piece & 7) === K) kingSq[us] = from;
  }

  // Ход только что сделан: не оставил ли он собственного короля под шахом?
  function madeMoveIsLegal() {
    const mover = side ^ 1;
    return !isAttacked(kingSq[mover], side);
  }

  /* ---------- оценка ---------- */
  // Буферы для структуры пешек — заранее, без выделения памяти на каждый вызов.
  const bMaxR = new Int8Array(8);      // самая дальняя (по горизонтали) чёрная пешка на вертикали
  const wMinR = new Int8Array(8);      // самая дальняя от белых... (наименьшая горизонталь) белая пешка
  const cntW = new Int8Array(8), cntB = new Int8Array(8);
  const wPawnSq = new Int16Array(16), bPawnSq = new Int16Array(16);

  // Оценка с точки зрения стороны, которая ходит (в сантипешках).
  function evaluate() {
    let mat = 0;                       // материал + расстановка (белые − чёрные)
    let kMgW = 0, kEgW = 0, kMgB = 0, kEgB = 0, wk = 0, bk = 0;
    let phase = 0, wBishops = 0, bBishops = 0, minors = 0, majors = 0, pawns = 0;
    let wMaterial = 0, bMaterial = 0, nW = 0, nB = 0;
    for (let f = 0; f < 8; f++) { bMaxR[f] = -1; wMinR[f] = 8; cntW[f] = 0; cntB[f] = 0; }

    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = board[sq];
      if (!p) continue;
      const type = p & 7, black = p >> 3;
      const rank = sq >> 4, file = sq & 7;
      const idx = black ? rank * 8 + file : (7 - rank) * 8 + file;
      if (type === K) {
        if (black) { kMgB = KING_MG[idx]; kEgB = KING_EG[idx]; bk = sq; }
        else { kMgW = KING_MG[idx]; kEgW = KING_EG[idx]; wk = sq; }
        continue;
      }
      const v = PIECE_VALUE[type] + PST[type][idx];
      if (black) { mat -= v; bMaterial += PIECE_VALUE[type]; } else { mat += v; wMaterial += PIECE_VALUE[type]; }
      if (type === P) {
        pawns++;
        if (black) { if (nB < 16) bPawnSq[nB++] = sq; cntB[file]++; if (rank > bMaxR[file]) bMaxR[file] = rank; }
        else { if (nW < 16) wPawnSq[nW++] = sq; cntW[file]++; if (rank < wMinR[file]) wMinR[file] = rank; }
      } else {
        if (type === B) { if (black) bBishops++; else wBishops++; minors++; }
        else if (type === N) minors++;
        else majors++;
        phase += type === Q ? 4 : type === R ? 2 : 1;
      }
    }

    // Мата уже не поставить (голые короли, король + один конь/слон) — ничья.
    if (pawns === 0 && majors === 0 && minors <= 1) return 0;

    if (wBishops >= 2) mat += 30;   // пара слонов
    if (bBishops >= 2) mat -= 30;

    for (let f = 0; f < 8; f++) {   // сдвоенные пешки
      if (cntW[f] > 1) mat -= 12 * (cntW[f] - 1);
      if (cntB[f] > 1) mat += 12 * (cntB[f] - 1);
    }
    for (let i = 0; i < nW; i++) {  // проходные пешки: впереди нет чужих пешек на своей и соседних вертикалях
      const sq = wPawnSq[i], r = sq >> 4, f = sq & 7;
      let passed = true;
      for (let g = f > 0 ? f - 1 : 0; g <= (f < 7 ? f + 1 : 7); g++) if (bMaxR[g] > r) { passed = false; break; }
      if (passed) mat += PASSED_BONUS[r];
    }
    for (let i = 0; i < nB; i++) {
      const sq = bPawnSq[i], r = sq >> 4, f = sq & 7;
      let passed = true;
      for (let g = f > 0 ? f - 1 : 0; g <= (f < 7 ? f + 1 : 7); g++) if (wMinR[g] < r) { passed = false; break; }
      if (passed) mat -= PASSED_BONUS[7 - r];
    }

    // Король: миттельшпиль ↔ эндшпиль (плавно, по количеству фигур).
    if (phase > 24) phase = 24;
    const kingW = (kMgW * phase + kEgW * (24 - phase)) / 24;
    const kingB = (kMgB * phase + kEgB * (24 - phase)) / 24;
    let score = mat + kingW - kingB;

    // Добивание в эндшпиле: гоним короля слабой стороны к краю и подтягиваем своего.
    if (phase <= 10) {
      const diff = wMaterial - bMaterial;
      if (diff >= 250 || diff <= -250) {
        const strong = diff > 0 ? wk : bk, weak = diff > 0 ? bk : wk;
        const edge = (s) => { const f = s & 7, r = s >> 4; return Math.max(3 - f, f - 4) + Math.max(3 - r, r - 4); };
        const dist = Math.abs((strong & 7) - (weak & 7)) + Math.abs((strong >> 4) - (weak >> 4));
        const mop = 5 * edge(weak) + 2 * (14 - dist);
        score += diff > 0 ? mop : -mop;
      }
    }

    return Math.round(side === WHITE ? score : -score) + 10; // +10 — право хода
  }

  /* ---------- поиск ---------- */
  let nodes = 0, deadline = 0, stopped = false;
  let qMax = 8;

  function isRepetition() {
    const lim = Math.min(half, sp);
    for (let i = 2; i <= lim; i += 2) {
      if (posL[sp - i] === hashL && posH[sp - i] === hashH) return true;
    }
    return false;
  }

  function pickNext(ply, n, start) {
    const sc = SC[ply], list = MV[ply];
    let best = start;
    for (let i = start + 1; i < n; i++) if (sc[i] > sc[best]) best = i;
    if (best !== start) {
      const tm = list[start]; list[start] = list[best]; list[best] = tm;
      const ts = sc[start]; sc[start] = sc[best]; sc[best] = ts;
    }
    return list[start];
  }

  function scoreQuiet(ply, n) {
    const list = MV[ply], sc = SC[ply], k = killers[ply], h = history[side];
    for (let i = 0; i < n; i++) {
      if (sc[i] !== 0) continue; // взятия и превращения уже оценены
      const m = list[i];
      if (m === k[0]) sc[i] = 8000;
      else if (m === k[1]) sc[i] = 7900;
      else sc[i] = h[(m & 127) * 128 + ((m >> 7) & 127)];
    }
  }

  function quiesce(alpha, beta, ply, qd) {
    nodes++;
    if ((nodes & 2047) === 0 && Date.now() > deadline) stopped = true;
    if (stopped) return 0;

    const check = inCheck();
    let best;
    let stand = 0;
    if (!check) {
      stand = evaluate();
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
      if (qd >= qMax || ply >= MAXPLY - 1) return stand;
    } else {
      best = -INF;
      if (qd >= qMax + 2 || ply >= MAXPLY - 1) return evaluate();
    }

    const n = gen(ply, !check);
    let legal = 0;
    for (let i = 0; i < n; i++) {
      const m = pickNext(ply, n, i);
      if (!check) {
        // «отсечение по дельте»: даже с выигрышем фигуры до alpha не дотянуть
        const capType = (m >> 17) & F_EP ? P : (board[(m >> 7) & 127] & 7);
        if (stand + PIECE_VALUE[capType] + 200 < alpha && !((m >> 14) & 7)) continue;
      }
      make(m);
      if (!madeMoveIsLegal()) { unmake(m); continue; }
      legal++;
      const score = -quiesce(-beta, -alpha, ply + 1, qd + 1);
      unmake(m);
      if (stopped) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) { alpha = score; if (alpha >= beta) break; }
      }
    }
    if (check && legal === 0) return -MATE + ply;
    return best;
  }

  function negamax(depth, alpha, beta, ply) {
    nodes++;
    if ((nodes & 2047) === 0 && Date.now() > deadline) stopped = true;
    if (stopped) return 0;

    if (half >= 100 || isRepetition()) return 0;
    // «пропуск» расстояния до мата: мат ближе — лучше
    if (alpha < -MATE + ply) alpha = -MATE + ply;
    if (beta > MATE - ply - 1) beta = MATE - ply - 1;
    if (alpha >= beta) return alpha;

    const check = inCheck();
    if (check && ply < MAXPLY - 4) depth++; // расширение при шахе
    if (depth <= 0) return quiesce(alpha, beta, ply, 0);
    if (ply >= MAXPLY - 1) return evaluate();

    const n = gen(ply, false);
    scoreQuiet(ply, n);
    let legal = 0;
    let best = -INF;
    const origAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const m = pickNext(ply, n, i);
      make(m);
      if (!madeMoveIsLegal()) { unmake(m); continue; }
      legal++;
      const score = -negamax(depth - 1, -beta, -alpha, ply + 1);
      unmake(m);
      if (stopped) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) {
            if (!((m >> 17) & F_CAP) && !((m >> 14) & 7)) {
              const k = killers[ply];
              if (k[0] !== m) { k[1] = k[0]; k[0] = m; }
              history[side][(m & 127) * 128 + ((m >> 7) & 127)] += depth * depth;
            }
            break;
          }
        }
      }
    }
    if (legal === 0) return check ? -MATE + ply : 0;
    return best;
  }

  /* ---------- корень ---------- */
  function legalRootMoves() {
    const n = gen(0, false);
    const out = [];
    for (let i = 0; i < n; i++) {
      const m = MV[0][i];
      make(m);
      const ok = madeMoveIsLegal();
      unmake(m);
      if (ok) out.push(m);
    }
    return out;
  }

  // Точные оценки всех ходов на заданной глубине (для лёгких уровней и «живого» дебюта).
  function scoreAllRoot(rootMoves, depth) {
    const scored = [];
    for (const m of rootMoves) {
      make(m);
      const s = -negamax(depth - 1, -INF, INF, 1);
      unmake(m);
      if (stopped) break;
      scored.push({ m, score: s });
    }
    return scored;
  }

  function pickWithNoise(scored, sigma) {
    let best = null, bestVal = -INF * 2;
    for (const item of scored) {
      // сумма трёх равномерных ≈ колокол; масштаб — sigma сантипешек
      const noise = sigma ? ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2 * sigma : Math.random() * 0.01;
      const v = item.score + noise;
      if (v > bestVal) { bestVal = v; best = item; }
    }
    return best;
  }

  function iterativeDeepening(rootMoves, maxDepth) {
    let bestMove = rootMoves[0], bestScore = 0, reached = 0;
    let ordered = rootMoves.slice();
    for (let depth = 1; depth <= maxDepth; depth++) {
      let alpha = -INF, iterBest = 0, iterScore = -INF;
      for (const m of ordered) {
        make(m);
        const s = -negamax(depth - 1, -INF, -alpha, 1);
        unmake(m);
        if (stopped) break;
        if (s > iterScore) { iterScore = s; iterBest = m; }
        if (s > alpha) alpha = s;
      }
      if (iterBest) {
        bestMove = iterBest; bestScore = iterScore;
        if (!stopped) reached = depth;
        ordered = [iterBest].concat(ordered.filter((x) => x !== iterBest));
      }
      if (stopped) break;
      if (Math.abs(bestScore) > MATE - 200) break; // мат найден — глубже не нужно
    }
    return { m: bestMove, score: bestScore, depth: reached };
  }

  /* ---------- публичный интерфейс ---------- */
  const LEVELS = {
    1: { depth: 1, qMax: 0, noise: 160, randomChance: 0.3, timeMs: 1500 },
    2: { depth: 2, qMax: 6, noise: 35, randomChance: 0, timeMs: 2500 },
    3: { depth: 6, qMax: 8, noise: 0, randomChance: 0, timeMs: 1500 },
  };

  function sqName(sq) {
    return "abcdefgh"[sq & 7] + ((sq >> 4) + 1);
  }
  function moveToObj(m) {
    const promo = (m >> 14) & 7;
    const o = { from: sqName(m & 127), to: sqName((m >> 7) & 127) };
    if (promo) o.promotion = "qnbr"[[Q, N, B, R].indexOf(promo)] || "q";
    return o;
  }
  function findMove(from, to, promotion) {
    const n = gen(0, false);
    const want = promotion ? { q: Q, n: N, b: B, r: R }[promotion] : 0;
    for (let i = 0; i < n; i++) {
      const m = MV[0][i];
      if (sqName(m & 127) !== from || sqName((m >> 7) & 127) !== to) continue;
      const pr = (m >> 14) & 7;
      if (pr && pr !== (want || Q)) continue;
      if (!pr && want) continue;
      make(m);
      const ok = madeMoveIsLegal();
      if (ok) return m; // ход остаётся сделанным — так строится история партии
      unmake(m);
    }
    return 0;
  }

  function chooseMove(req) {
    const level = LEVELS[req && req.level] ? req.level : 2;
    const cfg = LEVELS[level];
    const moves = (req && req.moves) || [];

    if (moves.length > 1900) return null; // недостижимо на практике; страховка от переполнения стека
    setFen((req && req.fen) || START_FEN); // fen — необязательная стартовая позиция (тесты/анализ)
    for (const mv of moves) {
      if (!findMove(mv.from, mv.to, mv.promotion)) return null; // история не совпала с правилами
    }
    // после replay: sp = число сделанных ходов; корень — текущая позиция
    for (let i = 0; i < killers.length; i++) { killers[i][0] = 0; killers[i][1] = 0; }
    history[0].fill(0); history[1].fill(0);

    nodes = 0; stopped = false;
    qMax = cfg.qMax;
    deadline = Date.now() + (req && req.timeMs ? req.timeMs : cfg.timeMs);

    // корень строим на MV[0]; sp растёт от текущей глубины истории
    const rootMoves = legalRootMoves();
    if (rootMoves.length === 0) return null;

    let chosen, score = 0, depth = cfg.depth;

    if (rootMoves.length === 1) {
      chosen = rootMoves[0];
    } else if (Math.random() < cfg.randomChance) {
      chosen = rootMoves[Math.floor(Math.random() * rootMoves.length)];
    } else if (level < 3) {
      const scored = scoreAllRoot(rootMoves, cfg.depth);
      const pick = scored.length ? pickWithNoise(scored, cfg.noise) : null;
      chosen = pick ? pick.m : rootMoves[0];
      score = pick ? pick.score : 0;
    } else if (!(req && req.fen) && moves.length < 6) {
      // «Живой» дебют: несколько почти равных ходов, чтобы партии не повторялись.
      const scored = scoreAllRoot(rootMoves, 3);
      const pick = scored.length ? pickWithNoise(scored, 25) : null;
      chosen = pick ? pick.m : rootMoves[0];
      score = pick ? pick.score : 0; depth = 3;
    } else {
      const res = iterativeDeepening(rootMoves, cfg.depth);
      chosen = res.m; score = res.score; depth = res.depth;
    }

    const out = moveToObj(chosen);
    out.score = score; out.depth = depth; out.nodes = nodes;
    return out;
  }

  // Для тестов: количество листовых позиций (проверка правил генерации ходов).
  function perft(fen, depth) {
    setFen(fen);
    function rec(d, ply) {
      if (d === 0) return 1;
      const n = gen(ply, false);
      // копия списка: рекурсия перезапишет MV[ply+1], но не MV[ply]
      let total = 0;
      for (let i = 0; i < n; i++) {
        const m = MV[ply][i];
        make(m);
        if (madeMoveIsLegal()) total += rec(d - 1, ply + 1);
        unmake(m);
      }
      return total;
    }
    return rec(depth, 0);
  }

  return { chooseMove, perft, LEVELS };
});
