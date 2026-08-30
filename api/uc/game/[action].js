var uc = require('../_uc.js');

/* Same reasoning as api/uc/queue/[action].js: one dynamic route folding
 * state/move/resign into a single function to stay under Vercel's
 * 12-function Hobby cap. Client URLs are unchanged. */

async function handleState(req, res) {
    if (req.method !== 'GET') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var gameId = (req.query && req.query.gameId || '').toString();
    var playerId = (req.query && req.query.playerId || '').toString();
    if (!gameId) { return uc.sendJson(res, 400, { error: 'missing_game_id' }); }

    var game = await uc.getGame(gameId);
    if (!game) { return uc.sendJson(res, 200, { found: false }); }

    if (uc.checkTimeout(game)) { await uc.saveGame(gameId, game); }
    return uc.sendJson(res, 200, uc.publicState(game, playerId));
}

async function handleMove(req, res) {
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

async function handleResign(req, res) {
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

var ACTIONS = {
    state: handleState,
    move: handleMove,
    resign: handleResign
};

module.exports = async function handler(req, res) {
    var action = req.query && req.query.action;
    var fn = ACTIONS.hasOwnProperty(action) ? ACTIONS[action] : null;
    if (!fn) { return uc.sendJson(res, 404, { error: 'unknown_action' }); }

    try {
        return await fn(req, res);
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
