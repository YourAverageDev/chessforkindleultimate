/* api/uc/_uc.js - shared helpers for "Ultimate Chess Matchmaking" (the
 * "Find Match" random-opponent flow). This is the same Vercel + Upstash
 * Redis backend as the rest of this project's online play (api/_room.js) -
 * no separate account, no separate deploy step, no extra moving parts.
 * It used to be a standalone Cloudflare Worker with two Durable Objects
 * (see git history / cf-worker/ before it was removed); that bought
 * race-free matchmaking "for free" from Durable Objects processing
 * requests to themselves one at a time, but at the cost of a whole second
 * backend with its own account, CLI, and deploy flow. A single Redis LIST
 * gets the same race-free guarantee far more simply: LPOP is atomic, so
 * two players hitting "Find Match" at the same moment can never both pop
 * the same waiting opponent - there's no concurrent access to race over.
 *
 * Game state reuses api/_room.js's replay/statusAndResult helpers (they're
 * already generic - just "moves in, position/status out" - so there's no
 * reason to duplicate them here).
 */
var roomLib = require('../_room.js');
var redisCommand = require('../_redis.js').redisCommand;
var ChessEngine = require('../../js/chessEngine.js');

var TICKET_TTL_SECONDS = 5 * 60; /* an abandoned ticket (tab closed without Cancel) expires after 5 minutes */
var GAME_TTL_SECONDS = 6 * 60 * 60; /* same as room-code games */
var ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function randomId(len) {
    var out = '';
    for (var i = 0; i < len; i++) { out += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length)); }
    return out;
}

function ticketKey(ticketId) { return 'uc:ticket:' + ticketId; }
function playerTicketKey(playerId) { return 'uc:playerticket:' + playerId; }
function queueKey(timeControlSec, incrementSec) { return 'uc:queue:' + timeControlSec + ':' + incrementSec; }
function gameKey(gameId) { return 'uc:game:' + gameId; }

async function getTicket(ticketId) {
    var raw = await redisCommand(['GET', ticketKey(ticketId)]);
    return raw ? JSON.parse(raw) : null;
}

async function saveTicket(ticketId, ticket) {
    await redisCommand(['SET', ticketKey(ticketId), JSON.stringify(ticket), 'EX', TICKET_TTL_SECONDS]);
}

async function deleteTicket(ticketId) {
    await redisCommand(['DEL', ticketKey(ticketId)]);
}

async function getGame(gameId) {
    var raw = await redisCommand(['GET', gameKey(gameId)]);
    return raw ? JSON.parse(raw) : null;
}

async function saveGame(gameId, game) {
    await redisCommand(['SET', gameKey(gameId), JSON.stringify(game), 'EX', GAME_TTL_SECONDS]);
}

/* Pops waiting tickets off this time-control bucket one at a time (LPOP is
 * atomic, so no two concurrent joins can ever pop the same one) until it
 * finds a genuine live opponent, or the bucket runs dry. A popped ticket
 * that's missing (expired), already matched, or belongs to the calling
 * player is simply discarded rather than put back - this is also how the
 * queue cleans itself of abandoned tickets over time, with no separate
 * pruning step needed. */
async function popOpponent(bucket, playerId) {
    for (;;) {
        var opponentId = await redisCommand(['LPOP', bucket]);
        if (!opponentId) { return null; }
        var ticket = await getTicket(opponentId);
        if (!ticket || ticket.matchedGameId || ticket.playerId === playerId) { continue; }
        return { ticketId: opponentId, ticket: ticket };
    }
}

async function createGame(whitePlayerId, blackPlayerId, timeControlSec, incrementSec) {
    var gameId = randomId(12);
    var now = Date.now();
    await saveGame(gameId, {
        gameId: gameId,
        whitePlayerId: whitePlayerId,
        blackPlayerId: blackPlayerId,
        timeControlSec: timeControlSec,
        incrementSec: incrementSec,
        moves: [],
        lastMove: null,
        whiteTimeLeftMs: timeControlSec * 1000,
        blackTimeLeftMs: timeControlSec * 1000,
        turnStartedAt: now,
        status: 'active',
        result: null,
        createdAt: now
    });
    return gameId;
}

async function joinQueue(playerId, timeControlSec, incrementSec) {
    /* Duplicate-join guard: this exact player already has a live ticket
     * (e.g. a flaky connection made the client retry "Find Match") - hand
     * back the same ticket instead of creating a second one. */
    var existingTicketId = await redisCommand(['GET', playerTicketKey(playerId)]);
    if (existingTicketId) {
        var existing = await getTicket(existingTicketId);
        if (existing && !existing.matchedGameId) {
            return { ticketId: existingTicketId, matched: false };
        }
    }

    var bucket = queueKey(timeControlSec, incrementSec);
    var popped = await popOpponent(bucket, playerId);

    if (popped) {
        var myIsWhite = Math.random() < 0.5;
        var whitePlayerId = myIsWhite ? playerId : popped.ticket.playerId;
        var blackPlayerId = myIsWhite ? popped.ticket.playerId : playerId;
        var gameId = await createGame(whitePlayerId, blackPlayerId, timeControlSec, incrementSec);

        /* Tell the opponent's own next poll about the match; I already
         * know the result, so I don't need a ticket of my own at all. */
        popped.ticket.matchedGameId = gameId;
        popped.ticket.matchedColor = myIsWhite ? 'b' : 'w';
        await saveTicket(popped.ticketId, popped.ticket);
        await redisCommand(['DEL', playerTicketKey(playerId)]);

        return { ticketId: randomId(16), matched: true, gameId: gameId, color: myIsWhite ? 'w' : 'b' };
    }

    var myTicketId = randomId(16);
    await saveTicket(myTicketId, {
        playerId: playerId,
        timeControlSec: timeControlSec,
        incrementSec: incrementSec,
        joinedAt: Date.now(),
        matchedGameId: null,
        matchedColor: null
    });
    await redisCommand(['RPUSH', bucket, myTicketId]);
    await redisCommand(['SET', playerTicketKey(playerId), myTicketId, 'EX', TICKET_TTL_SECONDS]);
    return { ticketId: myTicketId, matched: false };
}

async function pollStatus(ticketId) {
    var ticket = await getTicket(ticketId);
    if (!ticket) { return { found: false }; }
    if (ticket.matchedGameId) {
        await deleteTicket(ticketId); /* job done - safe to drop now that the owner has picked it up */
        return { found: true, matched: true, gameId: ticket.matchedGameId, color: ticket.matchedColor };
    }
    return { found: true, matched: false };
}

async function cancelQueue(ticketId) {
    var ticket = await getTicket(ticketId);
    if (!ticket) { return { ok: true }; } /* already gone */
    if (ticket.matchedGameId) {
        /* A match already went through - the game room is real, don't
         * discard it just because a cancel and a match crossed in flight. */
        return { ok: true, alreadyMatched: true, gameId: ticket.matchedGameId, color: ticket.matchedColor };
    }
    await deleteTicket(ticketId);
    await redisCommand(['DEL', playerTicketKey(ticket.playerId)]);
    return { ok: true };
}

function colorFor(game, playerId) {
    if (playerId === game.whitePlayerId) { return 'w'; }
    if (playerId === game.blackPlayerId) { return 'b'; }
    return null;
}

/* Mutates and returns `game` if the side to move has run out of time on
 * the wall clock - checked lazily on every state poll and before every
 * move, the same approach api/_room.js's checkTimeout uses and for the
 * same reason (a serverless function has no persistent process to run a
 * background timer in anyway). */
function checkTimeout(game) {
    if (game.status !== 'active') { return false; }
    var state = roomLib.replay(game.moves);
    var elapsed = Date.now() - game.turnStartedAt;
    var turn = state.turn;
    var remaining = (turn === 'w' ? game.whiteTimeLeftMs : game.blackTimeLeftMs) - elapsed;
    if (remaining > 0) { return false; }

    if (turn === 'w') { game.whiteTimeLeftMs = 0; } else { game.blackTimeLeftMs = 0; }
    game.status = 'finished';
    game.result = (turn === 'w' ? 'black' : 'white') + '_wins_timeout';
    return true;
}

function publicState(game, playerId) {
    var state = roomLib.replay(game.moves);
    return {
        found: true,
        gameId: game.gameId,
        fen: ChessEngine.stateToFen(state),
        lastMove: game.lastMove,
        moves: game.moves.map(function (m) { return ChessEngine.moveToUci(m); }).join(' '),
        turnStartedAt: game.turnStartedAt,
        whiteTimeLeftMs: game.whiteTimeLeftMs,
        blackTimeLeftMs: game.blackTimeLeftMs,
        turn: state.turn,
        status: game.status,
        result: game.result,
        yourColor: colorFor(game, playerId),
        timeControlSec: game.timeControlSec,
        incrementSec: game.incrementSec
    };
}

/* Validates and applies one move server-side, crediting the mover's
 * increment and handing the clock to the other side. Mutates `game`;
 * returns {ok:true} on success or {ok:false, error} otherwise - the caller
 * is responsible for persisting `game` only when ok is true. */
function applyMove(game, playerId, from, to, promotion) {
    var color = colorFor(game, playerId);
    if (!color) { return { ok: false, error: 'not_a_player' }; }

    var state = roomLib.replay(game.moves);
    if (state.turn !== color) { return { ok: false, error: 'not_your_turn' }; }

    var legal = ChessEngine.generateLegalMoves(state);
    var found = null;
    for (var i = 0; i < legal.length; i++) {
        if (legal[i].from === from && legal[i].to === to && legal[i].promotion === (promotion || null)) {
            found = legal[i];
            break;
        }
    }
    if (!found) { return { ok: false, error: 'illegal_move' }; }

    var elapsed = Date.now() - game.turnStartedAt;
    if (color === 'w') { game.whiteTimeLeftMs = Math.max(0, game.whiteTimeLeftMs - elapsed) + game.incrementSec * 1000; }
    else { game.blackTimeLeftMs = Math.max(0, game.blackTimeLeftMs - elapsed) + game.incrementSec * 1000; }

    game.moves.push({ from: from, to: to, promotion: promotion || null });
    var newState = ChessEngine.makeMove(state, found);
    game.lastMove = { from: from, to: to };
    game.turnStartedAt = Date.now();

    var outcome = roomLib.statusAndResult(newState);
    if (outcome.finished) {
        game.status = 'finished';
        game.result = outcome.result;
    }

    return { ok: true };
}

function applyResign(game, playerId) {
    var color = colorFor(game, playerId);
    if (!color) { return { ok: false, error: 'not_a_player' }; }
    if (game.status === 'active') {
        game.status = 'finished';
        game.result = (color === 'w' ? 'black' : 'white') + '_wins_resign';
    }
    return { ok: true };
}

module.exports = {
    getGame: getGame,
    saveGame: saveGame,
    joinQueue: joinQueue,
    pollStatus: pollStatus,
    cancelQueue: cancelQueue,
    checkTimeout: checkTimeout,
    publicState: publicState,
    applyMove: applyMove,
    applyResign: applyResign,
    readJsonBody: roomLib.readJsonBody,
    sendJson: roomLib.sendJson
};
