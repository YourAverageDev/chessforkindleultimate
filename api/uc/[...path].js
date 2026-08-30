var uc = require('./_uc.js');

/* Vercel's Hobby plan caps a deployment at 12 Serverless Functions - the
 * same limit api/lichess/[action].js already ran into and solved the same
 * way (see that file's own comment). Ultimate Chess Matchmaking's six
 * endpoints (queue/join, queue/status, queue/cancel, game/state,
 * game/move, game/resign) used to be six separate files, which alone
 * pushed the total over 12 once combined with everything else. This one
 * catch-all route (`[...path].js` matches /api/uc/<anything>/<anything>)
 * folds all of them into a single function, dispatching on the path
 * segments - the client's URLs (js/ultimateChess.js) are unchanged, since
 * /api/uc/queue/join etc. still resolve to this same file. */

async function handleQueueJoin(req, res) {
    if (req.method !== 'POST') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var body = await uc.readJsonBody(req);
    var playerId = (body.playerId || '').toString();
    var timeControlSec = parseInt(body.timeControlSec, 10);
    var incrementSec = parseInt(body.incrementSec, 10);
    if (!playerId || isNaN(timeControlSec) || isNaN(incrementSec)) {
        return uc.sendJson(res, 400, { error: 'bad_request' });
    }
    var result = await uc.joinQueue(playerId, timeControlSec, incrementSec);
    return uc.sendJson(res, 200, result);
}

async function handleQueueStatus(req, res) {
    if (req.method !== 'GET') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var ticketId = (req.query && req.query.ticketId || '').toString();
    if (!ticketId) { return uc.sendJson(res, 400, { error: 'missing_ticket_id' }); }
    var result = await uc.pollStatus(ticketId);
    return uc.sendJson(res, 200, result);
}

async function handleQueueCancel(req, res) {
    if (req.method !== 'POST') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var body = await uc.readJsonBody(req);
    var ticketId = (body.ticketId || '').toString();
    if (!ticketId) { return uc.sendJson(res, 400, { error: 'missing_ticket_id' }); }
    var result = await uc.cancelQueue(ticketId);
    return uc.sendJson(res, 200, result);
}

async function handleGameState(req, res) {
    if (req.method !== 'GET') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var gameId = (req.query && req.query.gameId || '').toString();
    var playerId = (req.query && req.query.playerId || '').toString();
    if (!gameId) { return uc.sendJson(res, 400, { error: 'missing_game_id' }); }

    var game = await uc.getGame(gameId);
    if (!game) { return uc.sendJson(res, 200, { found: false }); }

    if (uc.checkTimeout(game)) { await uc.saveGame(gameId, game); }
    return uc.sendJson(res, 200, uc.publicState(game, playerId));
}

async function handleGameMove(req, res) {
    if (req.method !== 'POST') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var body = await uc.readJsonBody(req);
    var gameId = (body.gameId || '').toString();
    var playerId = (body.playerId || '').toString();
    var from = parseInt(body.from, 10);
    var to = parseInt(body.to, 10);
    var promotion = body.promotion || null;
    if (!gameId || !playerId || isNaN(from) || isNaN(to)) {
        return uc.sendJson(res, 400, { error: 'bad_request' });
    }

    var game = await uc.getGame(gameId);
    if (!game) { return uc.sendJson(res, 404, { ok: false, error: 'game_not_found' }); }

    if (uc.checkTimeout(game)) {
        await uc.saveGame(gameId, game);
        return uc.sendJson(res, 409, { ok: false, error: 'game_over', state: uc.publicState(game, playerId) });
    }
    if (game.status !== 'active') {
        return uc.sendJson(res, 409, { ok: false, error: 'game_over', state: uc.publicState(game, playerId) });
    }

    var result = uc.applyMove(game, playerId, from, to, promotion);
    if (!result.ok) {
        var status = result.error === 'not_a_player' ? 403 : 400;
        return uc.sendJson(res, status, { ok: false, error: result.error });
    }

    await uc.saveGame(gameId, game);
    return uc.sendJson(res, 200, { ok: true, state: uc.publicState(game, playerId) });
}

async function handleGameResign(req, res) {
    if (req.method !== 'POST') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var body = await uc.readJsonBody(req);
    var gameId = (body.gameId || '').toString();
    var playerId = (body.playerId || '').toString();
    if (!gameId || !playerId) { return uc.sendJson(res, 400, { error: 'bad_request' }); }

    var game = await uc.getGame(gameId);
    if (!game) { return uc.sendJson(res, 404, { ok: false, error: 'game_not_found' }); }
    if (game.status !== 'active') { return uc.sendJson(res, 200, { ok: true, state: uc.publicState(game, playerId) }); }

    uc.checkTimeout(game); /* if they were already out of time, that result stands instead of a resignation */
    var result = uc.applyResign(game, playerId);
    if (!result.ok) { return uc.sendJson(res, 403, { ok: false, error: result.error }); }

    await uc.saveGame(gameId, game);
    return uc.sendJson(res, 200, { ok: true, state: uc.publicState(game, playerId) });
}

var ROUTES = {
    'queue/join': handleQueueJoin,
    'queue/status': handleQueueStatus,
    'queue/cancel': handleQueueCancel,
    'game/state': handleGameState,
    'game/move': handleGameMove,
    'game/resign': handleGameResign
};

module.exports = async function handler(req, res) {
    var segments = (req.query && req.query.path) || [];
    var route = segments.join('/');
    var fn = ROUTES.hasOwnProperty(route) ? ROUTES[route] : null;
    if (!fn) { return uc.sendJson(res, 404, { error: 'not_found' }); }

    try {
        return await fn(req, res);
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
