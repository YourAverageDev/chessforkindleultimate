var uc = require('../_uc.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return uc.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
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
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
