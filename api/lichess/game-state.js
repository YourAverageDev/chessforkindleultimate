var lichess = require('./_lichess.js');

/* NOTE ON CLOCKS: /api/account/playing's entries expose a single
 * `secondsLeft` for whoever's turn it currently is, not a clean
 * both-sides-always split the way this app's own room clocks work - so
 * the Lichess game screen shows one "time left" reading for the side to
 * move rather than two always-visible clocks. If real API access later
 * shows richer per-side clock data is available, that's a small
 * client-side enhancement, not a redesign. */
module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var auth = await lichess.requireSession(req);
        if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

        var gameId = (req.query && req.query.gameId || '').toString();
        if (!gameId) { return lichess.sendJson(res, 400, { error: 'missing_game_id' }); }

        var playing = await lichess.lichessFetch(auth.session.accessToken, '/api/account/playing');
        if (!playing.ok) {
            return lichess.sendJson(res, playing.status || 502, { error: 'lichess_fetch_failed', detail: playing.data });
        }

        var games = (playing.data && playing.data.nowPlaying) || [];
        for (var i = 0; i < games.length; i++) {
            var g = games[i];
            if (g.gameId === gameId) {
                return lichess.sendJson(res, 200, {
                    active: true,
                    gameId: g.gameId,
                    color: lichess.normalizeColor(g.color),
                    fen: g.fen,
                    lastMove: g.lastMove || null,
                    isMyTurn: !!g.isMyTurn,
                    secondsLeft: (typeof g.secondsLeft === 'number') ? g.secondsLeft : null,
                    speed: g.speed,
                    perf: g.perf,
                    rated: !!g.rated,
                    variant: g.variant,
                    opponent: g.opponent || null
                });
            }
        }

        /* Not in the "now playing" list any more - it ended. Fetch the
         * final result for display. */
        var exportRes = await lichess.lichessFetch(auth.session.accessToken, '/api/game/export/' + encodeURIComponent(gameId) + '?pgnInJson=true');
        if (!exportRes.ok) {
            return lichess.sendJson(res, 200, { active: false, finished: true, status: 'unknown' });
        }
        var g2 = exportRes.data;
        /* Defensive: some Lichess API versions return `status` as a plain
         * string ("mate"), others as {id, name} - handle either shape
         * rather than assume, since this couldn't be checked live. */
        var statusValue = (g2.status && typeof g2.status === 'object') ? g2.status.name : g2.status;
        return lichess.sendJson(res, 200, {
            active: false,
            finished: true,
            status: statusValue,
            winner: lichess.normalizeColor(g2.winner),
            players: g2.players || null,
            pgn: g2.pgn || null
        });
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
