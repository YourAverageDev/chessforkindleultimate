var uc = require('../_uc.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return uc.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var body = await uc.readJsonBody(req);
        var gameId = (body.gameId || '').toString();
        var playerId = (body.playerId || '').toString();
        if (!gameId || !playerId) { return uc.sendJson(res, 400, { error: 'bad_request' }); }

        var game = await uc.getGame(gameId);
        if (!game) { return uc.sendJson(res, 404, { ok: false, error: 'game_not_found' }); }
        if (game.status !== 'active') { return uc.sendJson(res, 200, { ok: true, state: uc.publicState(game, playerId) }); }

        /* If they were already out of time, that result stands instead of a resignation. */
        uc.checkTimeout(game);
        var result = uc.applyResign(game, playerId);
        if (!result.ok) { return uc.sendJson(res, 403, { ok: false, error: result.error }); }

        await uc.saveGame(gameId, game);
        return uc.sendJson(res, 200, { ok: true, state: uc.publicState(game, playerId) });
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
