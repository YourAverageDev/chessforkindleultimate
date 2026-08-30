/* matchmaker.js - the Matchmaker Durable Object.
 *
 * There is exactly ONE instance of this object for the whole deployment
 * (the top-level Worker always looks it up via idFromName("global") - see
 * index.js). That single-instance-ness is the whole point: a Durable
 * Object processes requests to itself one at a time, in order, so two
 * players hitting "Find Match" at nearly the same moment can never both
 * grab the same third waiting player - there is no concurrent access to
 * race over in the first place. This sidesteps, by construction, the kind
 * of "two requests grab the same queue entry" race that a plain
 * key-value store (no serialization guarantee across concurrent requests)
 * has to defend against with extra re-check logic.
 *
 * The whole queue is stored as one JSON array under a single storage key.
 * For the scale this is meant for (a casual chess site's matchmaking
 * queue, not a global matchmaking service), reading/writing one small
 * array per request is simpler and plenty fast - no need for per-ticket
 * keys or secondary indexes.
 */

var TICKET_TTL_MS = 5 * 60 * 1000; /* an abandoned ticket (tab closed without Cancel) is pruned after 5 minutes */
var QUEUE_KEY = 'queue';

function randomId(len) {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var out = '';
    for (var i = 0; i < len; i++) { out += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return out;
}

function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: { 'content-type': 'application/json' }
    });
}

export class Matchmaker {
    constructor(state, env) {
        this.state = state;
        this.env = env;
    }

    async getQueue() {
        var queue = await this.state.storage.get(QUEUE_KEY);
        return queue || [];
    }

    async saveQueue(queue) {
        await this.state.storage.put(QUEUE_KEY, queue);
    }

    /* Drops tickets that are too old (abandoned) or already matched (kept
     * around briefly is unnecessary here - once a ticket is matched, its
     * one remaining job is to be read exactly once more by its owner's
     * next status poll, which happens BEFORE this prune runs on THAT
     * ticket's own request, since pruning happens first and only removes
     * OTHER tickets - see fetch() below for the exact order). */
    pruneQueue(queue, keepTicketId) {
        var now = Date.now();
        var kept = [];
        for (var i = 0; i < queue.length; i++) {
            var t = queue[i];
            if (t.ticketId === keepTicketId) { kept.push(t); continue; }
            if (t.matchedGameId) { continue; } /* already handed off - the owner's next poll will find it via their OWN ticket record, not this queue scan */
            if (now - t.joinedAt > TICKET_TTL_MS) { continue; }
            kept.push(t);
        }
        return kept;
    }

    async fetch(request) {
        var url = new URL(request.url);
        var path = url.pathname;

        try {
            if (path === '/queue/join' && request.method === 'POST') {
                return await this.handleJoin(request);
            }
            if (path === '/queue/status' && request.method === 'GET') {
                return await this.handleStatus(url);
            }
            if (path === '/queue/cancel' && request.method === 'POST') {
                return await this.handleCancel(request);
            }
            return jsonResponse({ error: 'not_found' }, 404);
        } catch (e) {
            return jsonResponse({ error: 'server_error', message: String((e && e.message) || e) }, 500);
        }
    }

    async handleJoin(request) {
        var body = await request.json().catch(function () { return {}; });
        var playerId = (body.playerId || '').toString();
        var timeControlSec = parseInt(body.timeControlSec, 10);
        var incrementSec = parseInt(body.incrementSec, 10);
        if (!playerId || isNaN(timeControlSec) || isNaN(incrementSec)) {
            return jsonResponse({ error: 'bad_request' }, 400);
        }

        var queue = await this.getQueue();
        queue = this.pruneQueue(queue, null);

        /* Duplicate-entry guard: this exact player already has a ticket
         * (e.g. a flaky connection made the client retry "Find Match")-
         * hand back the SAME ticket instead of creating a second one, so
         * they never end up queued twice or matched with themselves. */
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].playerId === playerId && !queue[i].matchedGameId) {
                await this.saveQueue(queue);
                return jsonResponse({ ticketId: queue[i].ticketId, matched: false });
            }
        }

        var ticket = {
            ticketId: randomId(16),
            playerId: playerId,
            timeControlSec: timeControlSec,
            incrementSec: incrementSec,
            joinedAt: Date.now(),
            matchedGameId: null,
            matchedColor: null
        };
        queue.push(ticket);

        var matchResult = await this.tryMatch(queue, ticket);
        await this.saveQueue(queue);

        if (matchResult) {
            return jsonResponse({ ticketId: ticket.ticketId, matched: true, gameId: matchResult.gameId, color: matchResult.color });
        }
        return jsonResponse({ ticketId: ticket.ticketId, matched: false });
    }

    async handleStatus(url) {
        var ticketId = url.searchParams.get('ticketId') || '';
        if (!ticketId) { return jsonResponse({ error: 'missing_ticket_id' }, 400); }

        var queue = await this.getQueue();
        var mine = null;
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].ticketId === ticketId) { mine = queue[i]; break; }
        }
        if (!mine) { return jsonResponse({ found: false }); }

        if (mine.matchedGameId) {
            var result = { found: true, matched: true, gameId: mine.matchedGameId, color: mine.matchedColor };
            /* Job done - safe to drop now that the owner has picked it up. */
            queue = this.pruneQueue(queue, null).filter(function (t) { return t.ticketId !== ticketId; });
            await this.saveQueue(queue);
            return jsonResponse(result);
        }

        var matchResult = await this.tryMatch(queue, mine);
        queue = this.pruneQueue(queue, ticketId);
        await this.saveQueue(queue);

        if (matchResult) {
            return jsonResponse({ found: true, matched: true, gameId: matchResult.gameId, color: matchResult.color });
        }
        return jsonResponse({ found: true, matched: false });
    }

    async handleCancel(request) {
        var body = await request.json().catch(function () { return {}; });
        var ticketId = (body.ticketId || '').toString();
        if (!ticketId) { return jsonResponse({ error: 'missing_ticket_id' }, 400); }

        var queue = await this.getQueue();
        var mine = null;
        for (var i = 0; i < queue.length; i++) {
            if (queue[i].ticketId === ticketId) { mine = queue[i]; break; }
        }
        if (mine && mine.matchedGameId) {
            /* A match already went through - the game room is real, don't
             * discard it just because a cancel and a match crossed in
             * flight. Leave the ticket as-is; the client's own poll will
             * discover the match instead. */
            return jsonResponse({ ok: true, alreadyMatched: true, gameId: mine.matchedGameId, color: mine.matchedColor });
        }

        queue = queue.filter(function (t) { return t.ticketId !== ticketId; });
        await this.saveQueue(queue);
        return jsonResponse({ ok: true });
    }

    /* Looks for one compatible waiting partner for `myTicket` within
     * `queue` (mutated in place: on a match, both tickets are updated
     * with matchedGameId/matchedColor and the actual GameRoom Durable
     * Object is created here). Returns {gameId, color} for MY side if a
     * match was made, or null. */
    async tryMatch(queue, myTicket) {
        for (var i = 0; i < queue.length; i++) {
            var other = queue[i];
            if (other.ticketId === myTicket.ticketId) { continue; }
            if (other.matchedGameId) { continue; }
            if (other.playerId === myTicket.playerId) { continue; } /* never match a player against their own other tab/device */
            if (other.timeControlSec !== myTicket.timeControlSec || other.incrementSec !== myTicket.incrementSec) { continue; }

            var gameId = randomId(12);
            var myIsWhite = Math.random() < 0.5;
            var whiteTicket = myIsWhite ? myTicket : other;
            var blackTicket = myIsWhite ? other : myTicket;

            var created = await this.createGameRoom(gameId, whiteTicket, blackTicket, myTicket.timeControlSec, myTicket.incrementSec);
            if (!created) { continue; } /* extremely unlikely (the GameRoom DO itself failed to initialize) - try the next candidate rather than fail the whole join/poll */

            myTicket.matchedGameId = gameId;
            myTicket.matchedColor = myIsWhite ? 'w' : 'b';
            other.matchedGameId = gameId;
            other.matchedColor = myIsWhite ? 'b' : 'w';

            return { gameId: gameId, color: myTicket.matchedColor };
        }
        return null;
    }

    async createGameRoom(gameId, whiteTicket, blackTicket, timeControlSec, incrementSec) {
        var id = this.env.GAME_ROOM.idFromName(gameId);
        var stub = this.env.GAME_ROOM.get(id);
        var res = await stub.fetch('https://game-room/internal/init', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                gameId: gameId,
                whitePlayerId: whiteTicket.playerId,
                blackPlayerId: blackTicket.playerId,
                timeControlSec: timeControlSec,
                incrementSec: incrementSec
            })
        });
        return res.ok;
    }
}
