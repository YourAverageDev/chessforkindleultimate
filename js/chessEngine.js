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
        otherColor: otherColor
    };

    /* Also usable from Node (api/*.js serverless functions use this same
     * engine to validate online-play moves server-side) without affecting
     * the browser global assignment above. */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    return api;
})();
