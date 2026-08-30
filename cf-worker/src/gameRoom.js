/* gameRoom.js - the GameRoom Durable Object, one instance per match.
 *
 * Holds the one authoritative copy of the game: board position, whose
 * turn it is, and both clocks. Every move is validated here against the
 * real rules engine (chessEngine.js, a synced copy of the main site's
 * engine - see that file's header) before being applied - a client can
 * only ever propose a move, never assert one happened.
 *
 * Clock model (same lazy-wall-clock approach the main site's own online
 * rooms use in api/_room.js, ported to Durable Object storage): rather
 * than running a live countdown somewhere, the room just remembers each
 * side's remaining time AS OF turnStartedAt, and computes "has the side
 * to move actually run out by now" from Date.now() whenever it matters
 * (on every /state read and before every /move). On top of that lazy
 * check, an alarm is also scheduled for roughly when the side to move
 * WOULD flag - Durable Object alarms fire even if nobody ever polls
 * again (both players closing their tabs), so a genuinely abandoned game
 * still resolves to a real timeout result on its own, which a plain
 * poll-only backend (no equivalent of alarms) can't do without a
 * separate cron job.
 */
import ChessEngine from './chessEngine.js';

var ROOM_KEY = 'room';

var TERMINAL_STATUSES = { checkmate: 1, stalemate: 1, 'draw-50move': 1, 'draw-material': 1 };

function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: { 'content-type': 'application/json' }
    });
}

export class GameRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async getRoom() {
        return await this.state.storage.get(ROOM_KEY);
    }

    async saveRoom(room) {
        await this.state.storage.put(ROOM_KEY, room);
    }

    /* Mutates `room` in place if the side to move has run out of time;
     * returns true if it just did. Called before every read AND before
     * validating every move, so a flagged clock is caught no matter which
     * request happens to notice it first. */
    checkTimeout(room) {
        if (room.status !== 'active') { return false; }
        var elapsed = Date.now() - room.turnStartedAt;
        var turn = room.state.turn;
        var remaining = (turn === 'w' ? room.whiteTimeLeftMs : room.blackTimeLeftMs) - elapsed;
        if (remaining > 0) { return false; }

        if (turn === 'w') { room.whiteTimeLeftMs = 0; } else { room.blackTimeLeftMs = 0; }
        room.status = 'finished';
        room.result = (turn === 'w' ? 'black' : 'white') + '_wins_timeout';
        return true;
    }

    /* Schedules (or clears) the alarm for whenever the side to move would
     * next flag, so an abandoned game (nobody polling) still resolves
     * itself. A few seconds of slack is added since the alarm is a
     * backstop for abandonment, not the primary timeout mechanism
     * (checkTimeout on every request is) - firing a little late costs
     * nothing, firing early before a legitimate very-last-second move
     * lands would be wrong. */
    async scheduleAlarm(room) {
        if (room.status !== 'active') {
            await this.state.storage.deleteAlarm();
            return;
        }
        var remaining = (room.state.turn === 'w' ? room.whiteTimeLeftMs : room.blackTimeLeftMs);
        var fireAt = room.turnStartedAt + remaining + 3000;
        await this.state.storage.setAlarm(fireAt);
    }

    async alarm() {
        var room = await this.getRoom();
        if (!room) { return; }
        if (this.checkTimeout(room)) {
            await this.saveRoom(room);
            return;
        }
        /* Not actually due yet (e.g. a move reset the clock after the
         * alarm was scheduled but before it fired) - reschedule rather
         * than drop it. */
        await this.scheduleAlarm(room);
    }

    colorFor(room, playerId) {
        if (playerId === room.whitePlayerId) { return 'w'; }
        if (playerId === room.blackPlayerId) { return 'b'; }
        return null;
    }

    publicState(room, playerId) {
        var yourColor = this.colorFor(room, playerId);
        return {
            found: true,
            gameId: room.gameId,
            fen: ChessEngine.stateToFen(room.state),
            lastMove: room.lastMove,
            moves: room.moveList.join(' '),
            turnStartedAt: room.turnStartedAt,
            whiteTimeLeftMs: room.whiteTimeLeftMs,
            blackTimeLeftMs: room.blackTimeLeftMs,
            turn: room.state.turn,
            status: room.status,
            result: room.result,
            yourColor: yourColor,
            timeControlSec: room.timeControlSec,
            incrementSec: room.incrementSec
        };
    }

    async fetch(request) {
        var url = new URL(request.url);
        var path = url.pathname;

        try {
            if (path === '/internal/init' && request.method === 'POST') {
                return await this.handleInit(request);
            }
            if (path === '/state' && request.method === 'GET') {
                return await this.handleState(url);
            }
            if (path === '/move' && request.method === 'POST') {
                return await this.handleMove(request);
            }
            if (path === '/resign' && request.method === 'POST') {
                return await this.handleResign(request);
            }
            return jsonResponse({ error: 'not_found' }, 404);
        } catch (e) {
            return jsonResponse({ error: 'server_error', message: String((e && e.message) || e) }, 500);
        }
    }

    async handleInit(request) {
        var existing = await this.getRoom();
        if (existing) {
            /* Already initialized (a retried init request, or this DO id
             * was somehow reused) - idempotent no-op rather than
             * clobbering a game in progress. */
            return jsonResponse({ ok: true });
        }

        var body = await request.json().catch(function () { return {}; });
        var timeControlSec = parseInt(body.timeControlSec, 10);
        var incrementSec = parseInt(body.incrementSec, 10);
        if (!body.gameId || !body.whitePlayerId || !body.blackPlayerId || isNaN(timeControlSec) || isNaN(incrementSec)) {
            return jsonResponse({ error: 'bad_request' }, 400);
        }

        var now = Date.now();
        var room = {
            gameId: body.gameId,
            whitePlayerId: body.whitePlayerId,
            blackPlayerId: body.blackPlayerId,
            timeControlSec: timeControlSec,
            incrementSec: incrementSec,
            state: ChessEngine.createInitialState(),
            moveList: [],
            lastMove: null,
            whiteTimeLeftMs: timeControlSec * 1000,
            blackTimeLeftMs: timeControlSec * 1000,
            turnStartedAt: now,
            status: 'active',
            result: null,
            createdAt: now
        };
        await this.saveRoom(room);
        await this.scheduleAlarm(room);
        return jsonResponse({ ok: true });
    }

    async handleState(url) {
        var playerId = url.searchParams.get('playerId') || '';
        var room = await this.getRoom();
        if (!room) { return jsonResponse({ found: false }); }

        if (this.checkTimeout(room)) {
            await this.saveRoom(room);
        }
        return jsonResponse(this.publicState(room, playerId));
    }

    async handleMove(request) {
        var body = await request.json().catch(function () { return {}; });
        var playerId = (body.playerId || '').toString();
        var from = parseInt(body.from, 10);
        var to = parseInt(body.to, 10);
        var promotion = body.promotion || null;

        var room = await this.getRoom();
        if (!room) { return jsonResponse({ ok: false, error: 'game_not_found' }, 404); }

        if (this.checkTimeout(room)) {
            await this.saveRoom(room);
            return jsonResponse({ ok: false, error: 'game_over', state: this.publicState(room, playerId) }, 409);
        }
        if (room.status !== 'active') {
            return jsonResponse({ ok: false, error: 'game_over', state: this.publicState(room, playerId) }, 409);
        }

        var color = this.colorFor(room, playerId);
        if (!color) { return jsonResponse({ ok: false, error: 'not_a_player' }, 403); }
        if (color !== room.state.turn) { return jsonResponse({ ok: false, error: 'not_your_turn' }, 400); }

        var legal = ChessEngine.generateLegalMoves(room.state);
        var found = null;
        for (var i = 0; i < legal.length; i++) {
            if (legal[i].from === from && legal[i].to === to && legal[i].promotion === (promotion || null)) {
                found = legal[i];
                break;
            }
        }
        if (!found) { return jsonResponse({ ok: false, error: 'illegal_move' }, 400); }

        /* Apply the move, credit the increment to the mover, and hand the
         * clock to the other side starting now. */
        var mover = room.state.turn;
        var elapsed = Date.now() - room.turnStartedAt;
        if (mover === 'w') { room.whiteTimeLeftMs = Math.max(0, room.whiteTimeLeftMs - elapsed) + room.incrementSec * 1000; }
        else { room.blackTimeLeftMs = Math.max(0, room.blackTimeLeftMs - elapsed) + room.incrementSec * 1000; }

        room.state = ChessEngine.makeMove(room.state, found);
        room.moveList.push(ChessEngine.moveToUci(found));
        room.lastMove = { from: found.from, to: found.to };
        room.turnStartedAt = Date.now();

        var status = ChessEngine.getStatus(room.state);
        if (TERMINAL_STATUSES.hasOwnProperty(status)) {
            room.status = 'finished';
            if (status === 'checkmate') {
                room.result = (mover === 'w' ? 'white' : 'black') + '_wins_checkmate';
            } else {
                room.result = 'draw_' + status.replace('draw-', '');
            }
        }

        await this.saveRoom(room);
        await this.scheduleAlarm(room);
        return jsonResponse({ ok: true, state: this.publicState(room, playerId) });
    }

    async handleResign(request) {
        var body = await request.json().catch(function () { return {}; });
        var playerId = (body.playerId || '').toString();

        var room = await this.getRoom();
        if (!room) { return jsonResponse({ ok: false, error: 'game_not_found' }, 404); }
        if (room.status !== 'active') { return jsonResponse({ ok: true, state: this.publicState(room, playerId) }); }

        var color = this.colorFor(room, playerId);
        if (!color) { return jsonResponse({ ok: false, error: 'not_a_player' }, 403); }

        this.checkTimeout(room); /* if they were already out of time, that result stands instead of a resignation */
        if (room.status === 'active') {
            room.status = 'finished';
            room.result = (color === 'w' ? 'black' : 'white') + '_wins_resign';
        }
        await this.saveRoom(room);
        await this.state.storage.deleteAlarm();
        return jsonResponse({ ok: true, state: this.publicState(room, playerId) });
    }
}
