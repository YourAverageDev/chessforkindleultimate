/* ai.js
 * A small, self-contained opponent engine: iterative-deepening negamax with
 * alpha-beta pruning and a hard time budget, so it always returns a move
 * quickly no matter how slow the device's CPU is (critical for old Kindles).
 *
 * NOTE ON THE "SmartForwarder" SNIPPET THAT WAS SUPPLIED WITH THIS REQUEST:
 * That snippet never actually works. It calls `new Chess()` but the only
 * <script> tag on the page loads https://cloudflare.com (not chess.js or
 * any engine), so `Chess` is undefined and it throws immediately in any
 * browser, old or new. It also has no bundled logic of its own - it just
 * wraps whatever chess.js's `game.moves()`/`game.move()` provide. Loading a
 * third-party CDN script is also a bad fit for an old-Kindle-first, offline-
 * friendly, Vercel-static app: no network dependency, no external requests.
 * This file reimplements the same idea it was going for - iterative
 * deepening + alpha-beta + material scoring under a time cap - directly on
 * top of ChessEngine (js/chessEngine.js), fully self-contained and offline.
 */
var ChessAI = (function () {
    "use strict";

    var PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

    /* Small, cheap positional nudges (white's perspective; mirrored for black). */
    var PAWN_PST = [
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, -10, -10, 10, 10, 5,
        5, -5, -10, 0, 0, -10, -5, 5,
        0, 0, 0, 20, 20, 0, 0, 0,
        5, 5, 10, 25, 25, 10, 5, 5,
        10, 10, 20, 30, 30, 20, 10, 10,
        50, 50, 50, 50, 50, 50, 50, 50,
        0, 0, 0, 0, 0, 0, 0, 0
    ];
    var KNIGHT_PST = [
        -50, -40, -30, -30, -30, -30, -40, -50,
        -40, -20, 0, 5, 5, 0, -20, -40,
        -30, 5, 10, 15, 15, 10, 5, -30,
        -30, 0, 15, 20, 20, 15, 0, -30,
        -30, 5, 15, 20, 20, 15, 5, -30,
        -30, 0, 10, 15, 15, 10, 0, -30,
        -40, -20, 0, 0, 0, 0, -20, -40,
        -50, -40, -30, -30, -30, -30, -40, -50
    ];

    var MATE_SCORE = 1000000;
    var searchDeadline = 0;
    var timedOut = false;

    function evaluate(state) {
        var board = state.board;
        var score = 0;
        for (var i = 0; i < 64; i++) {
            var piece = board[i];
            if (!piece) { continue; }
            var value = PIECE_VALUES[piece.type];
            if (piece.type === 'p') {
                value += PAWN_PST[piece.color === 'w' ? i : 63 - i];
            } else if (piece.type === 'n') {
                value += KNIGHT_PST[piece.color === 'w' ? i : 63 - i];
            }
            score += (piece.color === state.turn) ? value : -value;
        }
        return score;
    }

    function moveScoreForOrdering(move) {
        if (move.captured) {
            return 10000 + PIECE_VALUES[move.captured.type];
        }
        if (move.promotion) { return 5000; }
        return 0;
    }

    function orderMoves(moves, preferredMove) {
        moves.sort(function (a, b) {
            return moveScoreForOrdering(b) - moveScoreForOrdering(a);
        });
        if (preferredMove) {
            for (var i = 1; i < moves.length; i++) {
                var m = moves[i];
                if (m.from === preferredMove.from && m.to === preferredMove.to && m.promotion === preferredMove.promotion) {
                    moves.splice(i, 1);
                    moves.unshift(m);
                    break;
                }
            }
        }
        return moves;
    }

    function negamax(state, depth, alpha, beta) {
        if (Date.now() >= searchDeadline) { timedOut = true; return evaluate(state); }

        var moves = ChessEngine.generateLegalMoves(state);
        if (moves.length === 0) {
            if (ChessEngine.isKingInCheck(state, state.turn)) { return -MATE_SCORE; }
            return 0;
        }
        if (depth === 0) { return evaluate(state); }

        orderMoves(moves, null);
        var best = -Infinity;
        for (var i = 0; i < moves.length; i++) {
            var next = ChessEngine.makeMove(state, moves[i]);
            var val = -negamax(next, depth - 1, -beta, -alpha);
            if (timedOut) { return best === -Infinity ? val : best; }
            if (val > best) { best = val; }
            if (best > alpha) { alpha = best; }
            if (alpha >= beta) { break; }
        }
        return best;
    }

    /* Runs iterative deepening one depth per event-loop tick (via setTimeout)
     * so the browser can repaint the "thinking" status between depths -
     * important on slow e-ink hardware where a long synchronous block can
     * look like the page froze. onComplete(move) fires with the chosen move. */
    function findBestMove(state, options, onComplete) {
        var maxDepth = (options && options.maxDepth) || 2;
        var timeLimit = (options && options.timeLimit) || 1000;
        var randomness = (options && options.randomness) || 0;

        var legalMoves = ChessEngine.generateLegalMoves(state);
        if (legalMoves.length === 0) { onComplete(null); return; }
        if (legalMoves.length === 1) { onComplete(legalMoves[0]); return; }

        if (randomness > 0 && Math.random() < randomness) {
            onComplete(legalMoves[Math.floor(Math.random() * legalMoves.length)]);
            return;
        }

        searchDeadline = Date.now() + timeLimit;
        var bestMoveOverall = legalMoves[0];
        var depth = 1;

        function runDepth() {
            if (depth > maxDepth || Date.now() >= searchDeadline) {
                onComplete(bestMoveOverall);
                return;
            }
            timedOut = false;
            var ordered = orderMoves(legalMoves.slice(), bestMoveOverall);
            var alpha = -Infinity;
            var beta = Infinity;
            var bestScore = -Infinity;
            var bestMove = null;
            var completedAll = true;

            for (var i = 0; i < ordered.length; i++) {
                var next = ChessEngine.makeMove(state, ordered[i]);
                var score = -negamax(next, depth - 1, -beta, -alpha);
                if (timedOut) { completedAll = false; break; }
                if (score > bestScore) { bestScore = score; bestMove = ordered[i]; }
                if (bestScore > alpha) { alpha = bestScore; }
            }

            if (completedAll && bestMove) {
                bestMoveOverall = bestMove;
                depth++;
                setTimeout(runDepth, 0);
            } else {
                onComplete(bestMoveOverall);
            }
        }

        runDepth();
    }

    return {
        findBestMove: findBestMove,
        evaluate: evaluate
    };
})();
