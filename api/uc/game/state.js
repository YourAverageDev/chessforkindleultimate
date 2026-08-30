var uc = require('../_uc.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return uc.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var gameId = (req.query && req.query.gameId || '').toString();
        var playerId = (req.query && req.query.playerId || '').toString();
        if (!gameId) { return uc.sendJson(res, 400, { error: 'missing_game_id' }); }

        var game = await uc.getGame(gameId);
        if (!game) { return uc.sendJson(res, 200, { found: false }); }

        if (uc.checkTimeout(game)) { await uc.saveGame(gameId, game); }

        return uc.sendJson(res, 200, uc.publicState(game, playerId));
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
