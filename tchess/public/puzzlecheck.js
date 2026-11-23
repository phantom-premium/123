/*!
 * Проверка шахматных задач: FEN и решение.
 *
 * ОДИН файл для двух сторон:
 *   • в браузере (админ-меню) — живая подсветка ошибок и предпросмотр;
 *   • на сервере (server.js делает require) — окончательная проверка перед
 *     сохранением. Клиенту не доверяем: в базу попадает только то, что
 *     прошло проверку здесь, на сервере.
 *
 * Формат решения: массив ходов {from, to, promotion?} — ходы решающего и
 * ответы соперника ПО ОЧЕРЕДИ, начиная с хода стороны, которая ходит в
 * позиции. Решение всегда заканчивается ходом решающего (нечётное число
 * ходов). Пример «мат в 2»: [ход1, ответ соперника, мат].
 *
 * Требует chess.js (локальный мини-движок из этой же папки).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    require("./chess.js"); // выставляет globalThis.Chess
    module.exports = factory(globalThis.Chess);
  } else {
    root.PuzzleCheck = factory(root.Chess);
  }
})(typeof window !== "undefined" ? window : globalThis, function (Chess) {
  "use strict";

  const MAX_MOVES = 21;
  const SQUARE_RE = /^[a-h][1-8]$/;

  function fail(error, extra) {
    return Object.assign({ ok: false, error }, extra || {});
  }

  /* ---------- FEN ---------- */

  // Права на рокировку, которые не подтверждены расстановкой (король/ладья
  // не на своих местах), молча отбрасываем — иначе движок мог бы «разрешить»
  // невозможную рокировку.
  function sanitizeCastling(rights, rows) {
    if (rights === "-") return "-";
    const at = (rank, file) => rows[8 - rank][file];
    let out = "";
    if (rights.includes("K") && at(1, 4) === "K" && at(1, 7) === "R") out += "K";
    if (rights.includes("Q") && at(1, 4) === "K" && at(1, 0) === "R") out += "Q";
    if (rights.includes("k") && at(8, 4) === "k" && at(8, 7) === "r") out += "k";
    if (rights.includes("q") && at(8, 4) === "k" && at(8, 0) === "r") out += "q";
    return out || "-";
  }

  function normalizeFen(raw) {
    const text = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
    if (!text) return fail("Введите позицию в формате FEN");

    const parts = text.split(" ");
    if (parts.length < 2 || parts.length > 6) {
      return fail("В FEN должно быть от 2 до 6 полей (расстановка, чей ход, рокировка, …)");
    }
    const [placement, active, castling = "-", ep = "-", half = "0", full = "1"] = parts;

    const ranks = placement.split("/");
    if (ranks.length !== 8) return fail("В расстановке должно быть 8 горизонталей, разделённых «/»");

    const rows = []; // 8 строк по 8 символов ("" = пустая клетка), сверху вниз (8-я → 1-я)
    let whiteKings = 0, blackKings = 0, whitePawns = 0, blackPawns = 0;
    for (let i = 0; i < 8; i++) {
      const row = [];
      let prevDigit = false;
      for (const ch of ranks[i]) {
        if (/[1-8]/.test(ch)) {
          if (prevDigit) return fail(`Горизонталь ${8 - i}: две цифры подряд — «${ranks[i]}»`);
          prevDigit = true;
          for (let k = 0; k < Number(ch); k++) row.push("");
        } else if (/[pnbrqkPNBRQK]/.test(ch)) {
          prevDigit = false;
          row.push(ch);
          if (ch === "K") whiteKings++;
          if (ch === "k") blackKings++;
          if (ch === "P") whitePawns++;
          if (ch === "p") blackPawns++;
          if ((ch === "p" || ch === "P") && (i === 0 || i === 7)) {
            return fail("Пешки не могут стоять на 1-й и 8-й горизонталях");
          }
        } else {
          return fail(`Недопустимый символ «${ch}» в расстановке`);
        }
      }
      if (row.length !== 8) return fail(`Горизонталь ${8 - i}: должно быть 8 клеток, а указано ${row.length}`);
      rows.push(row);
    }
    if (whiteKings !== 1 || blackKings !== 1) return fail("На доске должно быть ровно по одному королю каждого цвета");
    if (whitePawns > 8 || blackPawns > 8) return fail("Пешек одного цвета не может быть больше восьми");

    if (active !== "w" && active !== "b") return fail("Чей ход: укажите «w» (белые) или «b» (чёрные)");
    if (!/^(-|K?Q?k?q?)$/.test(castling)) return fail("Поле рокировки должно быть «-» или буквы KQkq");
    if (!/^(-|[a-h][36])$/.test(ep)) return fail("Поле взятия на проходе должно быть «-» или клетка вроде e3");
    if (!/^\d+$/.test(half)) return fail("Счётчик полуходов должен быть числом");
    if (!/^[1-9]\d*$/.test(full)) return fail("Номер хода должен быть положительным числом");

    const fen = [
      rows.map((row) => {
        let s = "", empty = 0;
        for (const cell of row) {
          if (!cell) empty++;
          else { if (empty) { s += empty; empty = 0; } s += cell; }
        }
        return s + (empty || "");
      }).join("/"),
      active,
      sanitizeCastling(castling, rows),
      ep, // проверка взятия на проходе не нужна: движок использует его только при реальной пешке
      half,
      full,
    ].join(" ");

    // Юридическая корректность: сторона, которая НЕ ходит, не может стоять под шахом.
    const flipped = fen.split(" ");
    flipped[1] = active === "w" ? "b" : "w";
    flipped[3] = "-";
    if (new Chess(flipped.join(" ")).in_check()) {
      return fail("Король стороны, которая не ходит, стоит под шахом — такая позиция невозможна");
    }
    const game = new Chess(fen);
    if (game.moves().length === 0) {
      return fail("В позиции у ходящей стороны нет ходов (мат или пат) — задачи в ней не будет");
    }
    return { ok: true, fen, turn: active };
  }

  /* ---------- ходы ---------- */

  function parseMoves(input) {
    let raw;
    if (Array.isArray(input)) {
      raw = input;
    } else {
      const text = String(input == null ? "" : input).trim();
      raw = text ? text.split(/[\s,;]+/).filter(Boolean) : [];
    }
    if (raw.length > MAX_MOVES) return fail(`Слишком длинное решение: не больше ${MAX_MOVES} ходов`);

    const moves = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      let from, to, promotion;
      if (item && typeof item === "object") {
        from = String(item.from || "").toLowerCase();
        to = String(item.to || "").toLowerCase();
        promotion = item.promotion ? String(item.promotion).toLowerCase() : undefined;
      } else {
        const token = String(item).toLowerCase().replace(/[-–—x×:]/g, "");
        const m = token.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
        if (!m) return fail(`«${item}» не похоже на ход. Формат: e2e4 (откуда и куда), ходы через пробел`, { validPlies: i });
        [, from, to, promotion] = m;
      }
      if (!SQUARE_RE.test(from) || !SQUARE_RE.test(to) || from === to) {
        return fail(`Ход ${i + 1}: неверные клетки`, { validPlies: i });
      }
      if (promotion && !/^[qrbn]$/.test(promotion)) return fail(`Ход ${i + 1}: неверная фигура превращения`, { validPlies: i });
      const move = { from, to };
      if (promotion) move.promotion = promotion;
      moves.push(move);
    }
    return { ok: true, moves };
  }

  /* ---------- позиция + решение ---------- */

  // Проверяет задачу целиком. При ошибке в ходах возвращает `game` в позиции
  // после последнего корректного хода — на этом строится предпросмотр в редакторе.
  function checkPuzzle(input) {
    const f = normalizeFen(input && input.fen);
    if (!f.ok) return { ok: false, stage: "fen", error: f.error };

    const game = new Chess(f.fen);
    const solverColor = game.turn();
    const base = { fen: f.fen, solverColor, game, validPlies: 0, moves: [] };

    const parsed = parseMoves(input && input.moves);
    if (!parsed.ok) {
      // Строку с опечаткой в середине разбираем до последнего верного хода — для предпросмотра.
      const partial = Array.isArray(input && input.moves) ? [] : String(input.moves || "").trim().split(/[\s,;]+/).filter(Boolean);
      const upTo = Math.min(parsed.validPlies == null ? 0 : parsed.validPlies, partial.length);
      if (upTo > 0) {
        const pre = parseMoves(partial.slice(0, upTo));
        if (pre.ok) applyMoves(game, pre.moves);
        base.validPlies = game.moveHistory.length;
      }
      return Object.assign(base, { ok: false, stage: "moves", error: parsed.error });
    }

    const moves = parsed.moves;
    if (moves.length === 0) {
      return Object.assign(base, { ok: false, stage: "moves", error: "Добавьте решение: хотя бы один ход" });
    }

    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const piece = game.get(mv.from);
      const isPromo = piece && piece.type === "p" && (mv.to[1] === "8" || mv.to[1] === "1");
      const res = game.move({ from: mv.from, to: mv.to, promotion: mv.promotion || (isPromo ? "q" : undefined) });
      if (!res) {
        return Object.assign(base, {
          ok: false, stage: "moves", validPlies: i,
          error: `Ход ${i + 1} (${mv.from}${mv.to}) невозможен в этой позиции`,
        });
      }
      base.validPlies = i + 1;
      if (i < moves.length - 1 && game.game_over()) {
        return Object.assign(base, {
          ok: false, stage: "moves",
          error: `После хода ${i + 1} партия уже закончена — дальше ходов быть не может`,
        });
      }
    }

    if (moves.length % 2 === 0) {
      return Object.assign(base, {
        ok: false, stage: "moves",
        error: "Решение должно заканчиваться ходом решающего: число ходов нечётное (1, 3, 5…). Последним не может быть ответ соперника",
      });
    }

    let final = "";
    if (game.in_checkmate()) final = "checkmate";
    else if (game.in_stalemate()) final = "stalemate";
    return Object.assign(base, { ok: true, moves, final });
  }

  function applyMoves(game, moves) {
    for (const mv of moves) {
      const piece = game.get(mv.from);
      const isPromo = piece && piece.type === "p" && (mv.to[1] === "8" || mv.to[1] === "1");
      if (!game.move({ from: mv.from, to: mv.to, promotion: mv.promotion || (isPromo ? "q" : undefined) })) return false;
    }
    return true;
  }

  return { normalizeFen, parseMoves, checkPuzzle, MAX_MOVES };
});
