var lichess = require('./_lichess.js');

/* Checks whether an outgoing challenge has turned into a started game, by
 * looking for it in the account's list of ongoing games rather than
 * depending on a dedicated "get challenge status" endpoint - Lichess
 * convention is that an accepted challenge's game shares its id, and
 * /api/account/playing is a plain, poll-friendly GET (unlike the
 * challenge/game stream endpoints), which is what this whole app's
 * polling-only architecture needs. */
module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var auth = await lichess.requireSession(req);
        if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

        var challengeId = (req.query && req.query.challengeId || '').toString();
        if (!challengeId) { return lichess.sendJson(res, 400, { error: 'missing_challenge_id' }); }

        var result = await lichess.lichessFetch(auth.session.accessToken, '/api/account/playing');
        if (!result.ok) {
            return lichess.sendJson(res, result.status || 502, { error: 'lichess_fetch_failed', detail: result.data });
        }

        var games = (result.data && result.data.nowPlaying) || [];
        for (var i = 0; i < games.length; i++) {
            if (games[i].gameId === challengeId || games[i].fullId === challengeId) {
                return lichess.sendJson(res, 200, { started: true, gameId: games[i].gameId, color: lichess.normalizeColor(games[i].color) });
            }
        }

        return lichess.sendJson(res, 200, { started: false });
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
