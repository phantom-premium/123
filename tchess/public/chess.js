/*!
 * Локальная реализация мини-движка шахматных правил, совместимая по API
 * с той частью chess.js (0.10.x), которую использует T-CHESS.
 * Подключается локально (без внешних CDN), поэтому не зависит от того,
 * доступны ли сторонние домены пользователю.
 *
 * Поддерживаемое API: new Chess(fen?), board(), get(sq), turn(),
 * moves({square, verbose}), move({from,to,promotion}), undo(),
 * in_check(), in_checkmate(), in_stalemate(), in_draw(),
 * in_threefold_repetition(), fen().
 */
(function (global) {
  "use strict";

  const FILES = "abcdefgh";
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  function sqToRC(sq) {
    const file = FILES.indexOf(sq[0]);
    const rank = parseInt(sq[1], 10);
    return [8 - rank, file];
  }
  function rcToSq(r, c) {
    return FILES[c] + (8 - r);
  }
  function inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }
  function cloneBoard(b) {
    return b.map((row) => row.map((cell) => (cell ? { type: cell.type, color: cell.color } : null)));
  }

  const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const KING_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const BISHOP_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ROOK_D = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  class Chess {
    constructor(fen) {
      this.load(fen || START_FEN);
    }

    load(fen) {
      const parts = fen.trim().split(/\s+/);
      const [placement, active, castling, ep, half, full] = parts;
      this._board = [];
      for (const rowStr of placement.split("/")) {
        const row = [];
        for (const ch of rowStr) {
          if (/\d/.test(ch)) {
            for (let i = 0; i < parseInt(ch, 10); i++) row.push(null);
          } else {
            const color = ch === ch.toUpperCase() ? "w" : "b";
            row.push({ type: ch.toLowerCase(), color });
          }
        }
        this._board.push(row);
      }
      this.turnColor = active === "b" ? "b" : "w";
      this.castling = {
        wK: castling ? castling.includes("K") : true,
        wQ: castling ? castling.includes("Q") : true,
        bK: castling ? castling.includes("k") : true,
        bQ: castling ? castling.includes("q") : true,
      };
      this.epSquare = ep && ep !== "-" ? sqToRC(ep) : null;
      this.halfmove = half ? parseInt(half, 10) : 0;
      this.fullmove = full ? parseInt(full, 10) : 1;
      this.moveHistory = [];
      this.positionCounts = {};
      this._countPosition();
    }

    _posKey() {
      const b = this._board.map((row) => row.map((c) => (c ? c.color + c.type : "-")).join(",")).join("|");
      const cast = (this.castling.wK ? "K" : "") + (this.castling.wQ ? "Q" : "") + (this.castling.bK ? "k" : "") + (this.castling.bQ ? "q" : "");
      const ep = this.epSquare ? rcToSq(this.epSquare[0], this.epSquare[1]) : "-";
      return `${b}|${this.turnColor}|${cast}|${ep}`;
    }
    _countPosition() {
      const key = this._posKey();
      this.positionCounts[key] = (this.positionCounts[key] || 0) + 1;
    }

    turn() {
      return this.turnColor;
    }

    get(sq) {
      const [r, c] = sqToRC(sq);
      const cell = this._board[r][c];
      return cell ? { type: cell.type, color: cell.color } : null;
    }

    board() {
      return cloneBoard(this._board);
    }

    fen() {
      const rows = this._board.map((row) => {
        let s = "";
        let empty = 0;
        for (const cell of row) {
          if (!cell) {
            empty++;
          } else {
            if (empty) {
              s += empty;
              empty = 0;
            }
            s += cell.color === "w" ? cell.type.toUpperCase() : cell.type;
          }
        }
        if (empty) s += empty;
        return s;
      });
      const cast = (this.castling.wK ? "K" : "") + (this.castling.wQ ? "Q" : "") + (this.castling.bK ? "k" : "") + (this.castling.bQ ? "q" : "") || "-";
      const ep = this.epSquare ? rcToSq(this.epSquare[0], this.epSquare[1]) : "-";
      return `${rows.join("/")} ${this.turnColor} ${cast} ${ep} ${this.halfmove} ${this.fullmove}`;
    }

    _findKing(color) {
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const cell = this._board[r][c];
          if (cell && cell.type === "k" && cell.color === color) return [r, c];
        }
      return null;
    }

    _attacked(r, c, byColor, board) {
      board = board || this._board;
      // пешки
      const dir = byColor === "w" ? 1 : -1; // белая пешка атакует "вверх" по доске (в сторону меньших r)
      for (const dc of [-1, 1]) {
        const pr = r + dir;
        const pc = c + dc;
        if (inBounds(pr, pc)) {
          const cell = board[pr][pc];
          if (cell && cell.type === "p" && cell.color === byColor) return true;
        }
      }
      // конь
      for (const [dr, dc] of KNIGHT_D) {
        const nr = r + dr, nc = c + dc;
        if (inBounds(nr, nc)) {
          const cell = board[nr][nc];
          if (cell && cell.type === "n" && cell.color === byColor) return true;
        }
      }
      // король
      for (const [dr, dc] of KING_D) {
        const nr = r + dr, nc = c + dc;
        if (inBounds(nr, nc)) {
          const cell = board[nr][nc];
          if (cell && cell.type === "k" && cell.color === byColor) return true;
        }
      }
      // слон/ферзь по диагоналям
      for (const [dr, dc] of BISHOP_D) {
        let nr = r + dr, nc = c + dc;
        while (inBounds(nr, nc)) {
          const cell = board[nr][nc];
          if (cell) {
            if (cell.color === byColor && (cell.type === "b" || cell.type === "q")) return true;
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      // ладья/ферзь по вертикалям/горизонталям
      for (const [dr, dc] of ROOK_D) {
        let nr = r + dr, nc = c + dc;
        while (inBounds(nr, nc)) {
          const cell = board[nr][nc];
          if (cell) {
            if (cell.color === byColor && (cell.type === "r" || cell.type === "q")) return true;
            break;
          }
          nr += dr;
          nc += dc;
        }
      }
      return false;
    }

    in_check() {
      const kingPos = this._findKing(this.turnColor);
      if (!kingPos) return false;
      const enemy = this.turnColor === "w" ? "b" : "w";
      return this._attacked(kingPos[0], kingPos[1], enemy, this._board);
    }

    _pseudoMovesFor(r, c) {
      const cell = this._board[r][c];
      if (!cell) return [];
      const moves = [];
      const color = cell.color;
      const push = (nr, nc, flags) => {
        if (!inBounds(nr, nc)) return;
        const target = this._board[nr][nc];
        if (target && target.color === color) return;
        flags = flags || (target ? "c" : "n");
        moves.push({ from: [r, c], to: [nr, nc], flags, piece: cell.type });
      };

      if (cell.type === "p") {
        const dir = color === "w" ? -1 : 1;
        const startRank = color === "w" ? 6 : 1;
        const promRank = color === "w" ? 0 : 7;
        // ход вперёд
        if (inBounds(r + dir, c) && !this._board[r + dir][c]) {
          if (r + dir === promRank) {
            for (const p of ["q", "r", "b", "n"]) moves.push({ from: [r, c], to: [r + dir, c], flags: "p", piece: "p", promotion: p });
          } else {
            moves.push({ from: [r, c], to: [r + dir, c], flags: "n", piece: "p" });
          }
          if (r === startRank && !this._board[r + 2 * dir][c]) {
            moves.push({ from: [r, c], to: [r + 2 * dir, c], flags: "b", piece: "p" });
          }
        }
        // взятия
        for (const dc of [-1, 1]) {
          const nr = r + dir, nc = c + dc;
          if (!inBounds(nr, nc)) continue;
          const target = this._board[nr][nc];
          if (target && target.color !== color) {
            if (nr === promRank) {
              for (const p of ["q", "r", "b", "n"]) moves.push({ from: [r, c], to: [nr, nc], flags: "cp", piece: "p", promotion: p });
            } else {
              moves.push({ from: [r, c], to: [nr, nc], flags: "c", piece: "p" });
            }
          } else if (this.epSquare && this.epSquare[0] === nr && this.epSquare[1] === nc) {
            moves.push({ from: [r, c], to: [nr, nc], flags: "e", piece: "p" });
          }
        }
      } else if (cell.type === "n") {
        for (const [dr, dc] of KNIGHT_D) push(r + dr, c + dc);
      } else if (cell.type === "k") {
        for (const [dr, dc] of KING_D) push(r + dr, c + dc);
        // рокировка
        const enemy = color === "w" ? "b" : "w";
        const homeRank = color === "w" ? 7 : 0;
        if (r === homeRank && c === 4 && !this._attacked(r, c, enemy, this._board)) {
          const kFlag = color === "w" ? "wK" : "bK";
          const qFlag = color === "w" ? "wQ" : "bQ";
          if (this.castling[kFlag] && !this._board[r][5] && !this._board[r][6] &&
              this._board[r][7] && this._board[r][7].type === "r" && this._board[r][7].color === color &&
              !this._attacked(r, 5, enemy, this._board) && !this._attacked(r, 6, enemy, this._board)) {
            moves.push({ from: [r, c], to: [r, 6], flags: "k", piece: "k" });
          }
          if (this.castling[qFlag] && !this._board[r][3] && !this._board[r][2] && !this._board[r][1] &&
              this._board[r][0] && this._board[r][0].type === "r" && this._board[r][0].color === color &&
              !this._attacked(r, 3, enemy, this._board) && !this._attacked(r, 2, enemy, this._board)) {
            moves.push({ from: [r, c], to: [r, 2], flags: "q", piece: "k" });
          }
        }
      } else {
        const dirs = cell.type === "b" ? BISHOP_D : cell.type === "r" ? ROOK_D : BISHOP_D.concat(ROOK_D);
        for (const [dr, dc] of dirs) {
          let nr = r + dr, nc = c + dc;
          while (inBounds(nr, nc)) {
            const target = this._board[nr][nc];
            if (target) {
              if (target.color !== color) push(nr, nc, "c");
              break;
            }
            push(nr, nc, "n");
            nr += dr;
            nc += dc;
          }
        }
      }
      return moves;
    }

    _applyRaw(mv) {
      // Применяет ход к текущей доске без проверок легальности; возвращает объект для отката.
      const [fr, fc] = mv.from;
      const [tr, tc] = mv.to;
      const movingPiece = this._board[fr][fc];
      const captured = this._board[tr][tc];
      const prevCastling = { ...this.castling };
      const prevEp = this.epSquare;
      const prevHalf = this.halfmove;
      const prevFullmove = this.fullmove;

      let epCaptured = null;
      if (mv.flags === "e") {
        const capR = movingPiece.color === "w" ? tr + 1 : tr - 1;
        epCaptured = this._board[capR][tc];
        this._board[capR][tc] = null;
      }

      this._board[tr][tc] = mv.promotion ? { type: mv.promotion, color: movingPiece.color } : movingPiece;
      this._board[fr][fc] = null;

      // рокировка — переносим ладью
      if (mv.flags === "k") {
        this._board[fr][5] = this._board[fr][7];
        this._board[fr][7] = null;
      } else if (mv.flags === "q") {
        this._board[fr][3] = this._board[fr][0];
        this._board[fr][0] = null;
      }

      // обновляем права рокировки
      if (movingPiece.type === "k") {
        if (movingPiece.color === "w") { this.castling.wK = false; this.castling.wQ = false; }
        else { this.castling.bK = false; this.castling.bQ = false; }
      }
      if (movingPiece.type === "r") {
        if (fr === 7 && fc === 0) this.castling.wQ = false;
        if (fr === 7 && fc === 7) this.castling.wK = false;
        if (fr === 0 && fc === 0) this.castling.bQ = false;
        if (fr === 0 && fc === 7) this.castling.bK = false;
      }
      if (captured && captured.type === "r") {
        if (tr === 7 && tc === 0) this.castling.wQ = false;
        if (tr === 7 && tc === 7) this.castling.wK = false;
        if (tr === 0 && tc === 0) this.castling.bQ = false;
        if (tr === 0 && tc === 7) this.castling.bK = false;
      }

      // en passant square
      this.epSquare = null;
      if (movingPiece.type === "p" && Math.abs(tr - fr) === 2) {
        this.epSquare = [(tr + fr) / 2, fc];
      }

      // halfmove clock
      if (movingPiece.type === "p" || captured || mv.flags === "e") this.halfmove = 0;
      else this.halfmove += 1;

      if (movingPiece.color === "b") this.fullmove += 1;

      return { movingPiece, captured, epCaptured, prevCastling, prevEp, prevHalf, prevFullmove, mv };
    }

    _undoRaw(state) {
      const { movingPiece, captured, epCaptured, prevCastling, prevEp, prevHalf, prevFullmove, mv } = state;
      const [fr, fc] = mv.from;
      const [tr, tc] = mv.to;
      this._board[fr][fc] = movingPiece;
      this._board[tr][tc] = captured || null;
      if (mv.flags === "e") {
        const capR = movingPiece.color === "w" ? tr + 1 : tr - 1;
        this._board[capR][tc] = epCaptured;
      }
      if (mv.flags === "k") {
        this._board[fr][7] = this._board[fr][5];
        this._board[fr][5] = null;
      } else if (mv.flags === "q") {
        this._board[fr][0] = this._board[fr][3];
        this._board[fr][3] = null;
      }
      this.castling = prevCastling;
      this.epSquare = prevEp;
      this.halfmove = prevHalf;
      this.fullmove = prevFullmove;
    }

    _legalMovesFor(r, c) {
      const cell = this._board[r][c];
      if (!cell) return [];
      const pseudo = this._pseudoMovesFor(r, c);
      const legal = [];
      const enemy = cell.color === "w" ? "b" : "w";
      for (const mv of pseudo) {
        const state = this._applyRaw(mv);
        const kingPos = this._findKing(cell.color);
        const stillInCheck = kingPos ? this._attacked(kingPos[0], kingPos[1], enemy, this._board) : false;
        this._undoRaw(state);
        if (!stillInCheck) legal.push(mv);
      }
      return legal;
    }

    _allLegalMoves(color) {
      const all = [];
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const cell = this._board[r][c];
          if (cell && cell.color === color) all.push(...this._legalMovesFor(r, c));
        }
      return all;
    }

    moves(opts) {
      opts = opts || {};
      let raw;
      if (opts.square) {
        const [r, c] = sqToRC(opts.square);
        const cell = this._board[r][c];
        raw = cell && cell.color === this.turnColor ? this._legalMovesFor(r, c) : [];
      } else {
        raw = this._allLegalMoves(this.turnColor);
      }
      const verbose = raw.map((mv) => ({
        from: rcToSq(mv.from[0], mv.from[1]),
        to: rcToSq(mv.to[0], mv.to[1]),
        piece: mv.piece,
        color: this.turnColor,
        flags: mv.flags,
        promotion: mv.promotion,
        captured: mv.flags.includes("c") || mv.flags === "e" ? "x" : undefined,
        san: rcToSq(mv.to[0], mv.to[1]),
      }));
      if (opts.verbose) return verbose;
      return verbose.map((m) => m.san);
    }

    move(input) {
      let fromSq, toSq, promotion;
      if (typeof input === "string") {
        return null; // SAN-строки в T-CHESS не используются
      }
      fromSq = input.from;
      toSq = input.to;
      promotion = input.promotion;

      const [fr, fc] = sqToRC(fromSq);
      const cell = this._board[fr][fc];
      if (!cell || cell.color !== this.turnColor) return null;

      const legal = this._legalMovesFor(fr, fc);
      const [tr, tc] = sqToRC(toSq);
      let candidate = legal.find((m) => m.to[0] === tr && m.to[1] === tc && (!m.promotion || m.promotion === (promotion || "q")));
      if (!candidate) return null;

      const beforeTurn = this.turnColor;
      const state = this._applyRaw(candidate);
      this.turnColor = this.turnColor === "w" ? "b" : "w";
      this._countPosition();

      this.moveHistory.push({ state, turnBefore: beforeTurn });

      return {
        from: fromSq,
        to: toSq,
        color: beforeTurn,
        piece: candidate.piece,
        flags: candidate.flags,
        promotion: candidate.promotion,
        captured: candidate.flags.includes("c") || candidate.flags === "e" ? "x" : undefined,
        san: toSq,
      };
    }

    undo() {
      const last = this.moveHistory.pop();
      if (!last) return null;
      const key = this._posKey();
      if (this.positionCounts[key]) {
        this.positionCounts[key] -= 1;
        if (this.positionCounts[key] <= 0) delete this.positionCounts[key];
      }
      this._undoRaw(last.state);
      this.turnColor = last.turnBefore;
      return {
        from: rcToSq(last.state.mv.from[0], last.state.mv.from[1]),
        to: rcToSq(last.state.mv.to[0], last.state.mv.to[1]),
        color: this.turnColor,
      };
    }

    in_checkmate() {
      return this.in_check() && this._allLegalMoves(this.turnColor).length === 0;
    }
    in_stalemate() {
      return !this.in_check() && this._allLegalMoves(this.turnColor).length === 0;
    }
    _insufficientMaterial() {
      const pieces = [];
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const cell = this._board[r][c];
          if (cell && cell.type !== "k") pieces.push(cell.type);
        }
      if (pieces.length === 0) return true;
      if (pieces.length === 1 && (pieces[0] === "n" || pieces[0] === "b")) return true;
      return false;
    }
    in_threefold_repetition() {
      return Object.values(this.positionCounts).some((n) => n >= 3);
    }
    in_draw() {
      return this.in_stalemate() || this._insufficientMaterial() || this.in_threefold_repetition() || this.halfmove >= 100;
    }
    game_over() {
      return this.in_checkmate() || this.in_draw();
    }
  }

  global.Chess = Chess;
})(typeof window !== "undefined" ? window : globalThis);
