var lichess = require('./_lichess.js');

/* Vercel's Hobby plan caps a deployment at 12 Serverless Functions. Each
 * Lichess endpoint used to be its own file (11 files), which alone blew
 * past that limit once combined with the online-room endpoints. This
 * single dynamic route (`[action].js` matches /api/lichess/<anything>)
 * folds all of them into one function, dispatching on the `action` route
 * param - the client's URLs (js/lichess.js) are unchanged, since
 * /api/lichess/oauth-exchange etc. still resolve to this same file. */

var SAMPLE_MS = 7000; /* stay safely under typical serverless function time limits */

async function handleOauthExchange(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var body = await lichess.readJsonBody(req);
    var code = (body.code || '').toString();
    var verifier = (body.verifier || '').toString();
    var redirectUri = (body.redirectUri || '').toString();

    if (!code || !verifier || !redirectUri) {
        return lichess.sendJson(res, 400, { error: 'bad_request' });
    }

    var tokenData = await lichess.exchangeCodeForToken(code, verifier, redirectUri);
    var accessToken = tokenData.access_token;

    var accountRes = await lichess.lichessFetch(accessToken, '/api/account');
    if (!accountRes.ok) {
        return lichess.sendJson(res, 502, { error: 'lichess_account_fetch_failed', status: accountRes.status, detail: accountRes.data });
    }
    var account = accountRes.data;

    var sessionToken = lichess.randomSessionToken();
    await lichess.saveSession(sessionToken, {
        accessToken: accessToken,
        username: account.username,
        createdAt: Date.now()
    });

    return lichess.sendJson(res, 200, {
        sessionToken: sessionToken,
        username: account.username,
        perfs: account.perfs || {}
    });
}

async function handleMe(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var accountRes = await lichess.lichessFetch(auth.session.accessToken, '/api/account');
    if (!accountRes.ok) {
        return lichess.sendJson(res, 502, { error: 'lichess_account_fetch_failed', status: accountRes.status });
    }

    return lichess.sendJson(res, 200, {
        username: accountRes.data.username,
        perfs: accountRes.data.perfs || {}
    });
}

async function handleLogout(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (auth) {
        /* Best-effort token revocation - if this endpoint/shape turns out
         * to be wrong, logging out of *this app* still works fine either
         * way since we delete our own session regardless. */
        try {
            await lichess.lichessFetch(auth.session.accessToken, '/api/token', { method: 'DELETE' });
        } catch (e) { /* ignore - not critical */ }
        await lichess.deleteSession(auth.token);
    }
    return lichess.sendJson(res, 200, { ok: true });
}

async function handleChallengeCreate(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var username = (body.username || '').toString().trim();
    var clockLimitSec = parseInt(body.clockLimitSec, 10);
    var clockIncrementSec = parseInt(body.clockIncrementSec, 10);
    var color = ['white', 'black', 'random'].indexOf(body.color) >= 0 ? body.color : 'random';
    var rated = !!body.rated;

    if (!username || isNaN(clockLimitSec) || isNaN(clockIncrementSec)) {
        return lichess.sendJson(res, 400, { error: 'bad_request' });
    }

    var result = await lichess.lichessFetch(auth.session.accessToken, '/api/challenge/' + encodeURIComponent(username), {
        method: 'POST',
        form: {
            rated: rated,
            'clock.limit': clockLimitSec,
            'clock.increment': clockIncrementSec,
            color: color,
            variant: 'standard'
        }
    });

    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'challenge_create_failed', detail: result.data });
    }

    return lichess.sendJson(res, 200, {
        challengeId: result.data.id,
        status: result.data.status,
        url: result.data.url
    });
}

async function handleChallengeRespond(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var challengeId = (body.challengeId || '').toString();
    var action = (body.action || '').toString();
    if (!challengeId || (action !== 'accept' && action !== 'decline')) {
        return lichess.sendJson(res, 400, { error: 'bad_request' });
    }

    var result = await lichess.lichessFetch(auth.session.accessToken, '/api/challenge/' + encodeURIComponent(challengeId) + '/' + action, { method: 'POST' });
    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'challenge_respond_failed', detail: result.data });
    }

    return lichess.sendJson(res, 200, { ok: true });
}

/* Checks whether an outgoing challenge has turned into a started game, by
 * looking for it in the account's list of ongoing games rather than
 * depending on a dedicated "get challenge status" endpoint - Lichess
 * convention is that an accepted challenge's game shares its id, and
 * /api/account/playing is a plain, poll-friendly GET (unlike the
 * challenge/game stream endpoints), which is what this whole app's
 * polling-only architecture needs. */
async function handleChallengeStatus(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
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
}

/* NOTE ON CLOCKS: /api/account/playing's entries expose a single
 * `secondsLeft` for whoever's turn it currently is, not a clean
 * both-sides-always split the way this app's own room clocks work - so
 * the Lichess game screen shows one "time left" reading for the side to
 * move rather than two always-visible clocks. If real API access later
 * shows richer per-side clock data is available, that's a small
 * client-side enhancement, not a redesign. */
async function handleGameState(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
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

    /* Not in the "now playing" list any more - it ended. Fetch the final
     * result for display. */
    var exportRes = await lichess.lichessFetch(auth.session.accessToken, '/api/game/export/' + encodeURIComponent(gameId) + '?pgnInJson=true');
    if (!exportRes.ok) {
        return lichess.sendJson(res, 200, { active: false, finished: true, status: 'unknown' });
    }
    var g2 = exportRes.data;
    /* Defensive: some Lichess API versions return `status` as a plain
     * string ("mate"), others as {id, name} - handle either shape rather
     * than assume, since this couldn't be checked live. */
    var statusValue = (g2.status && typeof g2.status === 'object') ? g2.status.name : g2.status;
    return lichess.sendJson(res, 200, {
        active: false,
        finished: true,
        status: statusValue,
        winner: lichess.normalizeColor(g2.winner),
        players: g2.players || null,
        pgn: g2.pgn || null
    });
}

async function handleMove(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
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
}

async function handleResign(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var gameId = (body.gameId || '').toString();
    if (!gameId) { return lichess.sendJson(res, 400, { error: 'bad_request' }); }

    var result = await lichess.lichessFetch(auth.session.accessToken, '/api/board/game/' + encodeURIComponent(gameId) + '/resign', { method: 'POST' });
    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'resign_failed', detail: result.data });
    }

    return lichess.sendJson(res, 200, { ok: true });
}

async function handleDraw(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var gameId = (body.gameId || '').toString();
    var accept = body.accept !== false; /* offering a draw and accepting one are both .../draw/yes */
    if (!gameId) { return lichess.sendJson(res, 400, { error: 'bad_request' }); }

    var result = await lichess.lichessFetch(auth.session.accessToken, '/api/board/game/' + encodeURIComponent(gameId) + '/draw/' + (accept ? 'yes' : 'no'), { method: 'POST' });
    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'draw_action_failed', detail: result.data });
    }

    return lichess.sendJson(res, 200, { ok: true });
}

/* There's no plain polling GET for "list my pending incoming challenges"
 * as far as this app's author could confirm without live API access - only
 * a stream (/api/stream/event). This endpoint samples that stream for a
 * bounded window each time it's called (see _lichess.js sampleEventStream)
 * so the client can still just poll a normal request/response endpoint
 * every 15-20s, same as everything else in this app. That interval - not
 * "instant" - is the accepted tradeoff for staying entirely polling-based. */
async function handlePollEvents(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var events = await lichess.sampleEventStream(auth.session.accessToken, '/api/stream/event', SAMPLE_MS);
    var myUsername = (auth.session.username || '').toLowerCase();

    var incomingChallenges = [];
    var gameStarts = [];

    for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.type === 'challenge' && ev.challenge) {
            var ch = ev.challenge;
            var challengerId = (ch.challenger && (ch.challenger.id || ch.challenger.name) || '').toLowerCase();
            if (challengerId && challengerId !== myUsername) {
                incomingChallenges.push({
                    id: ch.id,
                    challengerName: ch.challenger ? (ch.challenger.name || ch.challenger.id) : 'Unknown',
                    challengerRating: ch.challenger ? ch.challenger.rating : null,
                    rated: !!ch.rated,
                    variant: ch.variant ? ch.variant.key : null,
                    timeControl: ch.timeControl || null,
                    color: ch.color || 'random'
                });
            }
        } else if (ev.type === 'gameStart' && ev.game) {
            gameStarts.push({ gameId: ev.game.id });
        }
    }

    return lichess.sendJson(res, 200, { challenges: incomingChallenges, gameStarts: gameStarts });
}

var ACTIONS = {
    'oauth-exchange': handleOauthExchange,
    'me': handleMe,
    'logout': handleLogout,
    'challenge-create': handleChallengeCreate,
    'challenge-respond': handleChallengeRespond,
    'challenge-status': handleChallengeStatus,
    'game-state': handleGameState,
    'move': handleMove,
    'resign': handleResign,
    'draw': handleDraw,
    'poll-events': handlePollEvents
};

module.exports = async function handler(req, res) {
    var action = req.query && req.query.action;
    var fn = ACTIONS.hasOwnProperty(action) ? ACTIONS[action] : null;
    if (!fn) { return lichess.sendJson(res, 404, { error: 'unknown_action' }); }

    try {
        return await fn(req, res);
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
