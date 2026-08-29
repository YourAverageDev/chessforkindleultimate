var lichess = require('./_lichess.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var auth = await lichess.requireSession(req);
        if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

        var body = await lichess.readJsonBody(req);
        var gameId = (body.gameId || '').toString();
        var uci = (body.uci || '').toString();
        if (!gameId || !uci) { return lichess.sendJson(res, 400, { error: 'bad_request' }); }

        var path = '/api/board/game/' + encodeURIComponent(gameId) + '/move/' + encodeURIComponent(uci);
        if (body.offeringDraw) { path += '?offeringDraw=true'; }

        var result = await lichess.lichessFetch(auth.session.accessToken, path, { method: 'POST' });
        if (!result.ok) {
            return lichess.sendJson(res, result.status || 502, { error: 'move_rejected', detail: result.data });
        }

        return lichess.sendJson(res, 200, { ok: true });
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
