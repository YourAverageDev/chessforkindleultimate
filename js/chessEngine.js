/* chessEngine.js
 * Self-contained chess rules engine: legal move generation, check/checkmate/
 * stalemate/draw detection, castling, en passant, promotion.
 * Written in plain ES5 (var, function declarations only) so it runs on the
 * old WebKit JS engines found in Kindle e-ink browsers, not just modern ones.
 * No external dependencies (no chess.js, nothing fetched over the network).
 */
var ChessEngine = (function () {
    "use strict";

    var KNIGHT_OFFSETS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    var BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    var ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    var KING_OFFSETS = BISHOP_DIRS.concat(ROOK_DIRS);
    var QUEEN_DIRS = BISHOP_DIRS.concat(ROOK_DIRS);

    function otherColor(c) { return c === 'w' ? 'b' : 'w'; }

    function createInitialState() {
        var board = new Array(64);
        var i;
        for (i = 0; i < 64; i++) { board[i] = null; }

        var backRank = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
        for (i = 0; i < 8; i++) {
            board[i] = { type: backRank[i], color: 'w' };
            board[8 + i] = { type: 'p', color: 'w' };
            board[48 + i] = { type: 'p', color: 'b' };
            board[56 + i] = { type: backRank[i], color: 'b' };
        }

        return {
            board: board,
            turn: 'w',
            castling: { wK: true, wQ: true, bK: true, bQ: true },
            ep: null,
            halfmove: 0,
            fullmove: 1
        };
    }

    /* Parses a standard FEN string into our state shape. Used for Lichess
     * integration: Lichess reports game state as a FEN, and FEN happens to
     * carry everything our state object needs (castling rights, en passant
     * target) - no move-list replay required to know the current position. */
    function stateFromFen(fen) {
        var parts = (fen || '').replace(/^\s+|\s+$/g, '').split(/\s+/);
        var placement = parts[0] || '';
        var activeColor = parts[1] || 'w';
        var castlingStr = parts[2] || '-';
        var epStr = parts[3] || '-';
        var halfmove = parseInt(parts[4], 10);
        var fullmove = parseInt(parts[5], 10);
        if (isNaN(halfmove)) { halfmove = 0; }
        if (isNaN(fullmove)) { fullmove = 1; }

        var board = new Array(64);
        var i;
        for (i = 0; i < 64; i++) { board[i] = null; }

        var validTypes = { p: true, n: true, b: true, r: true, q: true, k: true };
        var rows = placement.split('/');
        for (var r = 0; r < 8 && r < rows.length; r++) {
            var rank = 7 - r;
            var file = 0;
            var row = rows[r];
            for (var c = 0; c < row.length; c++) {
                var ch = row.charAt(c);
                if (ch >= '1' && ch <= '8') {
                    file += parseInt(ch, 10);
                } else {
                    var lower = ch.toLowerCase();
                    if (validTypes[lower] && file >= 0 && file < 8) {
                        board[rank * 8 + file] = { type: lower, color: (ch === ch.toUpperCase()) ? 'w' : 'b' };
                    }
                    file++;
                }
            }
        }

        var castling = {
            wK: castlingStr.indexOf('K') >= 0,
            wQ: castlingStr.indexOf('Q') >= 0,
            bK: castlingStr.indexOf('k') >= 0,
            bQ: castlingStr.indexOf('q') >= 0
        };

        var ep = algebraicToSquare(epStr);

        return {
            board: board,
            turn: (activeColor === 'b') ? 'b' : 'w',
            castling: castling,
            ep: ep,
            halfmove: halfmove,
            fullmove: fullmove
        };
    }

    /* The reverse of stateFromFen - needed for Position Analysis (Opening
     * Explorer / tablebase), which both take a FEN for the position being
     * looked up rather than anything in our own state shape. */
    function stateToFen(state) {
        var rows = [];
        for (var r = 7; r >= 0; r--) {
            var row = '';
            var empty = 0;
            for (var f = 0; f < 8; f++) {
                var p = state.board[r * 8 + f];
                if (!p) { empty++; continue; }
                if (empty > 0) { row += empty; empty = 0; }
                row += (p.color === 'w') ? p.type.toUpperCase() : p.type;
            }
            if (empty > 0) { row += empty; }
            rows.push(row);
        }
        var c = state.castling;
        var castling = (c.wK ? 'K' : '') + (c.wQ ? 'Q' : '') + (c.bK ? 'k' : '') + (c.bQ ? 'q' : '');
        var ep = (state.ep === null) ? '-' : squareToAlgebraic(state.ep);
        return rows.join('/') + ' ' + state.turn + ' ' + (castling || '-') + ' ' + ep + ' ' + state.halfmove + ' ' + state.fullmove;
    }

    function squareToAlgebraic(idx) {
        if (idx === null || idx === undefined || idx < 0 || idx > 63) { return null; }
        var file = idx % 8;
        var rank = (idx - file) / 8;
        return String.fromCharCode(97 + file) + (rank + 1);
    }

    function algebraicToSquare(str) {
        if (!str || str.length < 2 || str === '-') { return null; }
        var file = str.charCodeAt(0) - 97;
        var rank = parseInt(str.charAt(1), 10) - 1;
        if (file < 0 || file > 7 || rank < 0 || rank > 7 || isNaN(rank)) { return null; }
        return rank * 8 + file;
    }

    /* UCI ("e2e4", "e7e8q") is what Lichess's Board API speaks for moves in
     * and out - these convert to/from our {from,to,promotion} move shape. */
    function moveToUci(move) {
        var s = squareToAlgebraic(move.from) + squareToAlgebraic(move.to);
        if (move.promotion) { s += move.promotion; }
        return s;
    }

    function uciToMove(uci) {
        if (!uci || uci.length < 4) { return null; }
        var from = algebraicToSquare(uci.substring(0, 2));
        var to = algebraicToSquare(uci.substring(2, 4));
        if (from === null || to === null) { return null; }
        return { from: from, to: to, promotion: uci.length > 4 ? uci.charAt(4) : null };
    }

    function makeMoveObj(from, to, captured, promotion, flag) {
        return { from: from, to: to, captured: captured || null, promotion: promotion || null, flag: flag || 'normal' };
    }

    function addOffsetMoves(state, idx, file, rank, offsets, moves) {
        var board = state.board, color = state.turn, i, nf, nr, to, target;
        for (i = 0; i < offsets.length; i++) {
            nf = file + offsets[i][0];
            nr = rank + offsets[i][1];
            if (nf < 0 || nf > 7 || nr < 0 || nr > 7) { continue; }
            to = nr * 8 + nf;
            target = board[to];
            if (!target) {
                moves.push(makeMoveObj(idx, to, null, null, 'normal'));
            } else if (target.color !== color) {
                moves.push(makeMoveObj(idx, to, target, null, 'normal'));
            }
        }
    }

    function addSlidingMoves(state, idx, file, rank, dirs, moves) {
        var board = state.board, color = state.turn, d, nf, nr, to, target;
        for (d = 0; d < dirs.length; d++) {
            nf = file + dirs[d][0];
            nr = rank + dirs[d][1];
            while (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) {
                to = nr * 8 + nf;
                target = board[to];
                if (!target) {
                    moves.push(makeMoveObj(idx, to, null, null, 'normal'));
                } else {
                    if (target.color !== color) {
                        moves.push(makeMoveObj(idx, to, target, null, 'normal'));
                    }
                    break;
                }
                nf += dirs[d][0];
                nr += dirs[d][1];
            }
        }
    }

    function addPawnMoves(state, idx, file, rank, moves) {
        var board = state.board, color = state.turn;
        var dir = color === 'w' ? 1 : -1;
        var startRank = color === 'w' ? 1 : 6;
        var promoteRank = color === 'w' ? 7 : 0;
        var oneRank = rank + dir;
        var promos = ['q', 'r', 'b', 'n'];
        var p, to, target, cf;

        if (oneRank >= 0 && oneRank <= 7) {
            to = oneRank * 8 + file;
            if (!board[to]) {
                if (oneRank === promoteRank) {
                    for (p = 0; p < promos.length; p++) { moves.push(makeMoveObj(idx, to, null, promos[p], 'normal')); }
                } else {
                    moves.push(makeMoveObj(idx, to, null, null, 'normal'));
                    if (rank === startRank) {
                        var twoRank = rank + dir * 2;
                        var to2 = twoRank * 8 + file;
                        if (!board[to2]) { moves.push(makeMoveObj(idx, to2, null, null, 'double')); }
                    }
                }
            }
            var captureFiles = [file - 1, file + 1];
            for (var cIdx = 0; cIdx < 2; cIdx++) {
                cf = captureFiles[cIdx];
                if (cf < 0 || cf > 7) { continue; }
                to = oneRank * 8 + cf;
                target = board[to];
                if (target && target.color !== color) {
                    if (oneRank === promoteRank) {
                        for (p = 0; p < promos.length; p++) { moves.push(makeMoveObj(idx, to, target, promos[p], 'normal')); }
                    } else {
                        moves.push(makeMoveObj(idx, to, target, null, 'normal'));
                    }
                } else if (state.ep !== null && to === state.ep) {
                    moves.push(makeMoveObj(idx, to, { type: 'p', color: otherColor(color) }, null, 'ep'));
                }
            }
        }
    }

    function isSquareAttacked(board, idx, byColor) {
        var file = idx % 8;
        var rank = (idx - file) / 8;
        var i, nf, nr, sq, piece;

        var pawnDir = byColor === 'w' ? -1 : 1;
        var pawnFiles = [file - 1, file + 1];
        for (i = 0; i < 2; i++) {
            nf = pawnFiles[i];
            nr = rank + pawnDir;
            if (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) {
                piece = board[nr * 8 + nf];
                if (piece && piece.color === byColor && piece.type === 'p') { return true; }
            }
        }

        for (i = 0; i < KNIGHT_OFFSETS.length; i++) {
            nf = file + KNIGHT_OFFSETS[i][0];
            nr = rank + KNIGHT_OFFSETS[i][1];
            if (nf < 0 || nf > 7 || nr < 0 || nr > 7) { continue; }
            piece = board[nr * 8 + nf];
            if (piece && piece.color === byColor && piece.type === 'n') { return true; }
        }

        for (i = 0; i < KING_OFFSETS.length; i++) {
            nf = file + KING_OFFSETS[i][0];
            nr = rank + KING_OFFSETS[i][1];
            if (nf < 0 || nf > 7 || nr < 0 || nr > 7) { continue; }
            piece = board[nr * 8 + nf];
            if (piece && piece.color === byColor && piece.type === 'k') { return true; }
        }

        for (i = 0; i < BISHOP_DIRS.length; i++) {
            nf = file + BISHOP_DIRS[i][0];
            nr = rank + BISHOP_DIRS[i][1];
            while (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) {
                sq = nr * 8 + nf;
                piece = board[sq];
                if (piece) {
                    if (piece.color === byColor && (piece.type === 'b' || piece.type === 'q')) { return true; }
                    break;
                }
                nf += BISHOP_DIRS[i][0];
                nr += BISHOP_DIRS[i][1];
            }
        }

        for (i = 0; i < ROOK_DIRS.length; i++) {
            nf = file + ROOK_DIRS[i][0];
            nr = rank + ROOK_DIRS[i][1];
            while (nf >= 0 && nf <= 7 && nr >= 0 && nr <= 7) {
                sq = nr * 8 + nf;
                piece = board[sq];
                if (piece) {
                    if (piece.color === byColor && (piece.type === 'r' || piece.type === 'q')) { return true; }
                    break;
                }
                nf += ROOK_DIRS[i][0];
                nr += ROOK_DIRS[i][1];
            }
        }

        return false;
    }

    function findKing(board, color) {
        for (var i = 0; i < 64; i++) {
            var p = board[i];
            if (p && p.color === color && p.type === 'k') { return i; }
        }
        return -1;
    }

    function isKingInCheck(state, color) {
        var kingIdx = findKing(state.board, color);
        if (kingIdx === -1) { return false; }
        return isSquareAttacked(state.board, kingIdx, otherColor(color));
    }

    function addCastlingMoves(state, kingIdx, moves) {
        var color = state.turn;
        var board = state.board;
        var base = color === 'w' ? 0 : 56;
        if (kingIdx !== base + 4) { return; }
        var rights = state.castling;
        var oppColor = otherColor(color);

        var canK = color === 'w' ? rights.wK : rights.bK;
        var canQ = color === 'w' ? rights.wQ : rights.bQ;

        if (canK) {
            var rook = board[base + 7];
            if (rook && rook.type === 'r' && rook.color === color &&
                !board[base + 5] && !board[base + 6] &&
                !isSquareAttacked(board, base + 4, oppColor) &&
                !isSquareAttacked(board, base + 5, oppColor) &&
                !isSquareAttacked(board, base + 6, oppColor)) {
                moves.push(makeMoveObj(kingIdx, base + 6, null, null, 'castleK'));
            }
        }
        if (canQ) {
            var rookQ = board[base + 0];
            if (rookQ && rookQ.type === 'r' && rookQ.color === color &&
                !board[base + 1] && !board[base + 2] && !board[base + 3] &&
                !isSquareAttacked(board, base + 4, oppColor) &&
                !isSquareAttacked(board, base + 3, oppColor) &&
                !isSquareAttacked(board, base + 2, oppColor)) {
                moves.push(makeMoveObj(kingIdx, base + 2, null, null, 'castleQ'));
            }
        }
    }

    function generatePseudoMoves(state) {
        var moves = [];
        var board = state.board;
        var color = state.turn;
        for (var idx = 0; idx < 64; idx++) {
            var piece = board[idx];
            if (!piece || piece.color !== color) { continue; }
            var file = idx % 8;
            var rank = (idx - file) / 8;
            switch (piece.type) {
                case 'p': addPawnMoves(state, idx, file, rank, moves); break;
                case 'n': addOffsetMoves(state, idx, file, rank, KNIGHT_OFFSETS, moves); break;
                case 'b': addSlidingMoves(state, idx, file, rank, BISHOP_DIRS, moves); break;
                case 'r': addSlidingMoves(state, idx, file, rank, ROOK_DIRS, moves); break;
                case 'q': addSlidingMoves(state, idx, file, rank, QUEEN_DIRS, moves); break;
                case 'k':
                    addOffsetMoves(state, idx, file, rank, KING_OFFSETS, moves);
                    addCastlingMoves(state, idx, moves);
                    break;
            }
        }
        return moves;
    }

    function makeMove(state, move) {
        var board = state.board.slice();
        var piece = board[move.from];
        var newCastling = { wK: state.castling.wK, wQ: state.castling.wQ, bK: state.castling.bK, bQ: state.castling.bQ };
        var newEp = null;

        if (move.flag === 'ep') {
            var capturedSquare = move.to + (piece.color === 'w' ? -8 : 8);
            board[capturedSquare] = null;
        }

        board[move.to] = move.promotion ? { type: move.promotion, color: piece.color } : piece;
        board[move.from] = null;

        if (move.flag === 'castleK') {
            var baseK = piece.color === 'w' ? 0 : 56;
            board[baseK + 5] = board[baseK + 7];
            board[baseK + 7] = null;
        } else if (move.flag === 'castleQ') {
            var baseQ = piece.color === 'w' ? 0 : 56;
            board[baseQ + 3] = board[baseQ + 0];
            board[baseQ + 0] = null;
        }

        if (piece.type === 'k') {
            if (piece.color === 'w') { newCastling.wK = false; newCastling.wQ = false; }
            else { newCastling.bK = false; newCastling.bQ = false; }
        }
        if (piece.type === 'r') {
            if (move.from === 0) { newCastling.wQ = false; }
            else if (move.from === 7) { newCastling.wK = false; }
            else if (move.from === 56) { newCastling.bQ = false; }
            else if (move.from === 63) { newCastling.bK = false; }
        }
        if (move.to === 0) { newCastling.wQ = false; }
        else if (move.to === 7) { newCastling.wK = false; }
        else if (move.to === 56) { newCastling.bQ = false; }
        else if (move.to === 63) { newCastling.bK = false; }

        if (move.flag === 'double') {
            newEp = (move.from + move.to) / 2;
        }

        var isCapture = !!move.captured || move.flag === 'ep';
        var newHalfmove = (piece.type === 'p' || isCapture) ? 0 : state.halfmove + 1;
        var newFullmove = state.fullmove + (piece.color === 'b' ? 1 : 0);

        return {
            board: board,
            turn: otherColor(piece.color),
            castling: newCastling,
            ep: newEp,
            halfmove: newHalfmove,
            fullmove: newFullmove
        };
    }

    function generateLegalMoves(state) {
        var pseudo = generatePseudoMoves(state);
        var legal = [];
        for (var i = 0; i < pseudo.length; i++) {
            var mv = pseudo[i];
            var next = makeMove(state, mv);
            if (!isKingInCheck(next, state.turn)) { legal.push(mv); }
        }
        return legal;
    }

    function hasInsufficientMaterial(state) {
        var board = state.board;
        var minor = [];
        for (var i = 0; i < 64; i++) {
            var p = board[i];
            if (!p || p.type === 'k') { continue; }
            if (p.type === 'p' || p.type === 'q' || p.type === 'r') { return false; }
            minor.push(p);
        }
        if (minor.length === 0) { return true; }
        if (minor.length === 1) { return true; }
        return false;
    }

    function getStatus(state, legalMoves) {
        var moves = legalMoves || generateLegalMoves(state);
        var check = isKingInCheck(state, state.turn);
        if (moves.length === 0) {
            return check ? 'checkmate' : 'stalemate';
        }
        if (state.halfmove >= 100) { return 'draw-50move'; }
        if (hasInsufficientMaterial(state)) { return 'draw-material'; }
        return check ? 'check' : 'normal';
    }

    function positionKey(state) {
        var parts = new Array(64);
        for (var i = 0; i < 64; i++) {
            var p = state.board[i];
            parts[i] = p ? (p.color + p.type) : '--';
        }
        var c = state.castling;
        return parts.join('') + '|' + state.turn + '|' + (c.wK ? 1 : 0) + (c.wQ ? 1 : 0) + (c.bK ? 1 : 0) + (c.bQ ? 1 : 0) + '|' + (state.ep === null ? 'x' : state.ep);
    }

    /* SAN ("Nf3", "exd5", "e8=Q", "O-O") -> our {from,to,promotion,...} move
     * shape, resolved against the actual legal moves in `state` rather than
     * a standalone parser - this sidesteps needing to implement SAN's own
     * disambiguation/check-mark rules from scratch, since generateLegalMoves
     * already knows exactly what's legal. Used for replaying a Lichess
     * puzzle's PGN (see replayPgnToPly below), since the puzzle API gives
     * movetext, not a FEN, for the position the puzzle starts from. Returns
     * null if the token can't be resolved to exactly one legal move. */
    function sanToMove(state, sanRaw) {
        var san = (sanRaw || '').replace(/^\s+|\s+$/g, '');
        if (!san) { return null; }
        var legal = generateLegalMoves(state);
        var stripped = san.replace(/[+#!?]+$/g, '').replace(/0/g, 'O');

        if (stripped === 'O-O') {
            for (var i = 0; i < legal.length; i++) { if (legal[i].flag === 'castleK') { return legal[i]; } }
            return null;
        }
        if (stripped === 'O-O-O') {
            for (var j = 0; j < legal.length; j++) { if (legal[j].flag === 'castleQ') { return legal[j]; } }
            return null;
        }

        var m = /^([NBRQK]?)([a-h]?)([1-8]?)(x?)([a-h][1-8])(?:=([NBRQ]))?$/.exec(stripped);
        if (!m) { return null; }
        var pieceLetterMap = { N: 'n', B: 'b', R: 'r', Q: 'q', K: 'k' };
        var pieceType = m[1] ? pieceLetterMap[m[1]] : 'p';
        var disambigFile = m[2] || null;
        var disambigRank = m[3] || null;
        var dest = algebraicToSquare(m[5]);
        var promotion = m[6] ? m[6].toLowerCase() : null;
        if (dest === null) { return null; }

        var candidates = [];
        for (var k = 0; k < legal.length; k++) {
            var mv = legal[k];
            if (mv.to !== dest) { continue; }
            var piece = state.board[mv.from];
            if (!piece || piece.type !== pieceType) { continue; }
            if (promotion ? (mv.promotion !== promotion) : !!mv.promotion) { continue; }
            var fromFile = String.fromCharCode(97 + (mv.from % 8));
            var fromRank = String(Math.floor(mv.from / 8) + 1);
            if (disambigFile && disambigFile !== fromFile) { continue; }
            if (disambigRank && disambigRank !== fromRank) { continue; }
            candidates.push(mv);
        }
        return (candidates.length === 1) ? candidates[0] : null;
    }

    /* Splits a PGN movetext blob into plain SAN tokens, tolerating either
     * "e4 e5 Nf3" (no move numbers, what this app's author believes the
     * Lichess puzzle API returns) or "1. e4 e5 2. Nf3 Nc6" / "1.e4" styles,
     * plus a trailing result token, since none of that could be checked
     * against the real API while writing this. */
    function tokenizePgnMoves(pgn) {
        /* Strip whole header-tag lines ("[Event \"...\"]") before splitting
         * into tokens - a pasted PGN (Game Replay's "Import PGN") normally
         * has these, and naively word-splitting a tag line like
         * `[Event "Rated Blitz game"]` would otherwise produce garbage
         * tokens ("[Event", "\"Rated", ...) that abort the whole replay on
         * the very first token. */
        var noHeaders = (pgn || '').split(/\r?\n/).filter(function (line) {
            return !/^\s*\[.*\]\s*$/.test(line);
        }).join(' ');
        var raw = noHeaders.split(/\s+/);
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var t = raw[i].replace(/^\d+\.+/, '').replace(/^\s+|\s+$/g, '');
            if (!t) { continue; }
            if (t === '1-0' || t === '0-1' || t === '1/2-1/2' || t === '*') { continue; }
            out.push(t);
        }
        return out;
    }

    /* Replays a PGN's mainline from the start position up to `ply` half-moves,
     * returning the resulting state, or null if any move along the way
     * can't be resolved (malformed PGN, or a SAN token this parser can't
     * handle). */
    function replayPgnToPly(pgn, ply) {
        var state = createInitialState();
        var tokens = tokenizePgnMoves(pgn);
        var n = Math.min(ply || 0, tokens.length);
        for (var i = 0; i < n; i++) {
            var mv = sanToMove(state, tokens[i]);
            if (!mv) { return null; }
            state = makeMove(state, mv);
        }
        return state;
    }

    /* Replays an entire game's movetext from the start, returning every
     * intermediate position (for Game Replay's prev/next stepping) rather
     * than just the final one. states[0] is the start position, states[i]
     * is the position after moves[i-1]/sanTokens[i-1]. Returns null if any
     * move can't be resolved (malformed PGN, or a SAN construct this
     * parser doesn't handle). Used for both a Lichess "My Games" entry's
     * bare move list and a user-pasted full PGN (Import PGN). */
    function replayFullGame(pgn) {
        var state = createInitialState();
        var tokens = tokenizePgnMoves(pgn);
        var states = [state];
        var moves = [];
        for (var i = 0; i < tokens.length; i++) {
            var mv = sanToMove(state, tokens[i]);
            if (!mv) { return null; }
            state = makeMove(state, mv);
            states.push(state);
            moves.push(mv);
        }
        return { states: states, moves: moves, sanTokens: tokens };
    }

    /* Finds the legal move (with correct flag/captured info - unlike a bare
     * uciToMove result) matching a given UCI string, e.g. to apply a move
     * an external source (Lichess's puzzle "solution" array) named only by
     * UCI rather than handing over a move object. */
    function findMoveByUci(moves, uci) {
        for (var i = 0; i < moves.length; i++) {
            if (moveToUci(moves[i]) === uci) { return moves[i]; }
        }
        return null;
    }

    var api = {
        createInitialState: createInitialState,
        generateLegalMoves: generateLegalMoves,
        makeMove: makeMove,
        isKingInCheck: isKingInCheck,
        isSquareAttacked: isSquareAttacked,
        findKing: findKing,
        getStatus: getStatus,
        hasInsufficientMaterial: hasInsufficientMaterial,
        positionKey: positionKey,
        otherColor: otherColor,
        stateFromFen: stateFromFen,
        stateToFen: stateToFen,
        squareToAlgebraic: squareToAlgebraic,
        algebraicToSquare: algebraicToSquare,
        moveToUci: moveToUci,
        uciToMove: uciToMove,
        sanToMove: sanToMove,
        tokenizePgnMoves: tokenizePgnMoves,
        replayPgnToPly: replayPgnToPly,
        replayFullGame: replayFullGame,
        findMoveByUci: findMoveByUci
    };

    /* Also usable from Node (api/*.js serverless functions use this same
     * engine to validate online-play moves server-side) without affecting
     * the browser global assignment above. */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    return api;
})();
