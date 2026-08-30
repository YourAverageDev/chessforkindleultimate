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
        perfs: accountRes.data.perfs || {},
        count: accountRes.data.count || null,
        createdAt: accountRes.data.createdAt || null
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

    /* Not in the "now playing" list any more - usually because it ended,
     * but a real game reported live testing "bugs" (pieces freezing, the
     * game randomly appearing over) traced back to here: nowPlaying can
     * apparently miss a still-very-much-ongoing game for a poll or two
     * (a transient listing gap, not a real end), and this code used to
     * treat that miss alone as confident proof the game was over. Since
     * the client takes "finished" as final (stops polling, shows the
     * game-over screen, and refuses further moves), a false positive here
     * looked exactly like the reported symptoms. Now this only reports
     * finished when the export endpoint POSITIVELY confirms a real
     * terminal status - any other outcome (the export call itself failing,
     * or coming back without a recognizable terminal status) is reported
     * as an ordinary failed lookup instead, which the client already
     * treats as "poll hiccup, try again" rather than "game over". */
    var TERMINAL_STATUSES = {
        mate: true, resign: true, stalemate: true, timeout: true, outoftime: true,
        draw: true, aborted: true, cheat: true, noStart: true, variantEnd: true
    };

    var exportRes = await lichess.lichessFetch(auth.session.accessToken, '/api/game/export/' + encodeURIComponent(gameId) + '?pgnInJson=true');
    if (!exportRes.ok) {
        return lichess.sendJson(res, 502, { error: 'game_lookup_failed' });
    }
    var g2 = exportRes.data;
    /* Defensive: some Lichess API versions return `status` as a plain
     * string ("mate"), others as {id, name} - handle either shape rather
     * than assume, since this couldn't be checked live. */
    var statusValue = (g2.status && typeof g2.status === 'object') ? g2.status.name : g2.status;
    if (!statusValue || !TERMINAL_STATUSES.hasOwnProperty(statusValue)) {
        return lichess.sendJson(res, 502, { error: 'game_lookup_inconclusive' });
    }
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

/* Puzzles need no Lichess login at all - /api/puzzle/daily and
 * /api/puzzle/next are public reads. Response shape is this app's
 * best-effort reconstruction (again, no live access while writing this):
 * { game: { pgn: "e4 e5 Nf3 ..." }, puzzle: { id, rating, themes,
 * initialPly, solution: ["e2e4", ...] } } - `pgn` is the SAN movetext of
 * the whole game the puzzle was taken from, and the client replays it
 * with its own chess engine up to `initialPly` to reconstruct the start
 * position, since there's no FEN field to just read directly. See
 * js/chessEngine.js's replayPgnToPly/sanToMove and js/app.js's puzzle
 * loading code for that logic and its own fallback for getting the
 * solution's move-0 convention (setup move vs. solver's first move)
 * backwards if this assumption turns out wrong on first real contact. */
function normalizePuzzleResponse(data) {
    var game = (data && data.game) || {};
    var puzzle = (data && data.puzzle) || {};
    return {
        puzzleId: puzzle.id || null,
        rating: (typeof puzzle.rating === 'number') ? puzzle.rating : null,
        themes: puzzle.themes || [],
        initialPly: (typeof puzzle.initialPly === 'number') ? puzzle.initialPly : 0,
        solution: puzzle.solution || [],
        pgn: game.pgn || ''
    };
}

async function handlePuzzleDaily(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var result = await lichess.lichessFetch(null, '/api/puzzle/daily');
    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'puzzle_fetch_failed', detail: result.data });
    }
    return lichess.sendJson(res, 200, normalizePuzzleResponse(result.data));
}

async function handlePuzzleNext(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var result = await lichess.lichessFetch(null, '/api/puzzle/next');
    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'puzzle_fetch_failed', detail: result.data });
    }
    return lichess.sendJson(res, 200, normalizePuzzleResponse(result.data));
}

/* "My Games" - the logged-in user's recent game history. Requests both
 * `moves=true` (bare SAN movetext, e.g. "e4 e5 Nf3 ...") and
 * `pgnInJson=true` (a fully formatted PGN with headers) per game, so the
 * client can replay a game (using `moves`, via chessEngine's
 * replayFullGame) and show/copy its PGN (using `pgn`) without a second
 * request per game. As with the rest of this file, the exact field names
 * below are this app's best-effort reading of Lichess's docs, not
 * something checked against a real account or response. */
async function handleMyGames(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var username = auth.session.username || '';
    var path = '/api/games/user/' + encodeURIComponent(username) + '?max=20&moves=true&opening=true&pgnInJson=true';
    var result = await lichess.lichessFetchNdjson(auth.session.accessToken, path);
    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'games_fetch_failed' });
    }

    var myUsernameLower = username.toLowerCase();
    var games = [];
    for (var i = 0; i < result.lines.length; i++) {
        var g = result.lines[i];
        var players = g.players || {};
        var white = players.white || {};
        var black = players.black || {};
        var whiteName = (white.user && white.user.name) || (white.aiLevel ? ('Computer (level ' + white.aiLevel + ')') : 'Anonymous');
        var blackName = (black.user && black.user.name) || (black.aiLevel ? ('Computer (level ' + black.aiLevel + ')') : 'Anonymous');

        var myColor = null;
        if (white.user && (white.user.name || '').toLowerCase() === myUsernameLower) { myColor = 'w'; }
        else if (black.user && (black.user.name || '').toLowerCase() === myUsernameLower) { myColor = 'b'; }

        var winnerColor = lichess.normalizeColor(g.winner);
        var outcome;
        if (!g.status || g.status === 'started' || g.status === 'created') { outcome = 'ongoing'; }
        else if (!winnerColor) { outcome = 'draw'; }
        else if (myColor && winnerColor === myColor) { outcome = 'win'; }
        else if (myColor) { outcome = 'loss'; }
        else { outcome = 'unknown'; }

        games.push({
            id: g.id,
            rated: !!g.rated,
            speed: g.speed || null,
            perf: g.perf || null,
            createdAt: g.createdAt || null,
            status: g.status || null,
            white: { name: whiteName, rating: (typeof white.rating === 'number') ? white.rating : null },
            black: { name: blackName, rating: (typeof black.rating === 'number') ? black.rating : null },
            myColor: myColor,
            result: outcome,
            opening: g.opening ? { eco: g.opening.eco, name: g.opening.name } : null,
            moves: g.moves || '',
            pgn: g.pgn || null
        });
    }

    return lichess.sendJson(res, 200, { games: games });
}

/* Watch Games (TV): both of these are public, unauthenticated Lichess
 * endpoints - no session needed, same as the puzzle actions. */

async function handleTvChannels(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var result = await lichess.lichessFetch(null, '/api/tv/channels');
    if (!result.ok) {
        return lichess.sendJson(res, result.status || 502, { error: 'tv_channels_fetch_failed', detail: result.data });
    }
    var data = result.data || {};
    var channels = [];
    for (var key in data) {
        if (!data.hasOwnProperty(key)) { continue; }
        var c = data[key];
        if (!c || !c.gameId) { continue; }
        channels.push({
            channel: key,
            name: (c.user && c.user.name) || 'Unknown',
            rating: (typeof c.rating === 'number') ? c.rating : null,
            gameId: c.gameId
        });
    }
    return lichess.sendJson(res, 200, { channels: channels });
}

/* Spectating re-polls a plain game export on every tick rather than
 * holding any kind of stream open - consistent with the rest of this
 * app's polling-only architecture, and much simpler than trying to sample
 * a spectator move stream (there's a public one - /api/stream/game/{id} -
 * but this app's author couldn't confirm its exact line shape without
 * live access, whereas /api/game/export/{id} is the same endpoint
 * game-state's own finished-game fallback already uses). */
async function handleWatchGame(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var rawGameId = (req.query && req.query.gameId || '').toString();
    if (!rawGameId) { return lichess.sendJson(res, 400, { error: 'missing_game_id' }); }

    /* Lichess's base game id is always 8 characters; a "full id" (as used
     * to link a specific player's view of a game) tacks on 4 more. If
     * handleTvChannels's `gameId` field ever turns out to actually be a
     * full id rather than the plain game id this app assumed, using it
     * as-is against /api/game/export/{id} would 404. Truncating is a
     * no-op (and therefore harmless) for an already-correct 8-char id, and
     * only matters if that assumption was wrong - can't confirm either
     * way without live access, so this is cheap insurance either way. */
    var gameId = rawGameId.length > 8 ? rawGameId.substring(0, 8) : rawGameId;

    /* `pgnInJson=true` is required here, not optional - without it,
     * /api/game/export/{id} returns raw PGN text (not JSON) by default,
     * lichessFetch's JSON.parse on that fails and silently falls back to
     * { raw: text }, and every field read below then comes back
     * empty/null - `ok:true` the whole time, since the HTTP call itself
     * succeeded. That looked exactly like "the board never loads": an
     * always-empty move list keeps the board frozen at the starting
     * position forever, with no error ever surfacing. Every other export
     * call in this file already includes this param (see handleGameState,
     * handleMyGames) - this one was just missing it. */
    var result = await lichess.lichessFetch(null, '/api/game/export/' + encodeURIComponent(gameId) + '?moves=true&pgnInJson=true');
    if (!result.ok) {
        console.error('watch-game: export failed for ' + gameId + ' (from ' + rawGameId + '): status ' + result.status + ' ' + JSON.stringify(result.data));
        return lichess.sendJson(res, result.status || 502, { error: 'watch_game_failed', status: result.status, detail: result.data });
    }
    var g = result.data || {};
    if (g.raw !== undefined) {
        /* lichessFetch's JSON.parse fell back - the response wasn't JSON
         * at all, so nothing below can be trusted. Report this as a real
         * failure instead of silently returning an empty/null game. */
        console.error('watch-game: export for ' + gameId + ' was not JSON: ' + String(g.raw).slice(0, 200));
        return lichess.sendJson(res, 502, { error: 'watch_game_bad_response' });
    }
    var players = g.players || {};
    var white = players.white || {};
    var black = players.black || {};
    return lichess.sendJson(res, 200, {
        gameId: g.id || gameId,
        status: g.status || null,
        winner: lichess.normalizeColor(g.winner),
        white: { name: (white.user && white.user.name) || 'Anonymous', rating: (typeof white.rating === 'number') ? white.rating : null },
        black: { name: (black.user && black.user.name) || 'Anonymous', rating: (typeof black.rating === 'number') ? black.rating : null },
        moves: g.moves || '',
        speed: g.speed || null,
        rated: !!g.rated
    });
}

/* Position Analysis: Opening Explorer (aggregated stats from real games at
 * this exact position) and the tablebase (perfect play once few enough
 * pieces remain). Both are public reads on their own hosts - see
 * _lichess.js's externalFetch. Field names below are, as ever in this
 * file, this app's best-effort reading of Lichess's docs rather than
 * something checked live. */
async function handleExplorer(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var fen = (req.query && req.query.fen || '').toString();
    if (!fen) { return lichess.sendJson(res, 400, { error: 'missing_fen' }); }
    var db = (req.query && req.query.db === 'masters') ? 'master' : 'lichess';
    var url = 'https://explorer.lichess.ovh/' + db + '?fen=' + encodeURIComponent(fen) + '&variant=standard';

    var result = await lichess.externalFetch(url);
    if (!result.ok || !result.data) {
        return lichess.sendJson(res, result.status || 502, { error: 'explorer_fetch_failed' });
    }
    var data = result.data;
    var moves = [];
    var rawMoves = data.moves || [];
    for (var i = 0; i < rawMoves.length; i++) {
        var m = rawMoves[i];
        moves.push({ uci: m.uci, san: m.san, white: m.white || 0, draws: m.draws || 0, black: m.black || 0 });
    }
    return lichess.sendJson(res, 200, {
        white: data.white || 0,
        draws: data.draws || 0,
        black: data.black || 0,
        opening: data.opening || null,
        moves: moves
    });
}

async function handleTablebase(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var fen = (req.query && req.query.fen || '').toString();
    if (!fen) { return lichess.sendJson(res, 400, { error: 'missing_fen' }); }
    var url = 'https://tablebase.lichess.ovh/standard?fen=' + encodeURIComponent(fen);

    var result = await lichess.externalFetch(url);
    if (!result.ok || !result.data) {
        /* Too many pieces on the board (outside tablebase range) is the
         * common, expected case here, not a real failure - just report
         * "nothing available" rather than an error. */
        return lichess.sendJson(res, 200, { available: false });
    }
    var data = result.data;
    var rawMoves = (data.moves || []).slice(0, 6);
    var moves = [];
    for (var i = 0; i < rawMoves.length; i++) {
        var m = rawMoves[i];
        moves.push({ uci: m.uci, san: m.san, category: m.category || null, dtz: (typeof m.dtz === 'number') ? m.dtz : null });
    }
    return lichess.sendJson(res, 200, {
        available: true,
        category: data.category || null,
        dtz: (typeof data.dtz === 'number') ? data.dtz : null,
        dtm: (typeof data.dtm === 'number') ? data.dtm : null,
        moves: moves
    });
}

/* ---- Kindle pairing ----
 * See _lichess.js's "Kindle pairing" section for the why. The Kindle calls
 * pairing-create (no auth - it has no session yet) and polls pairing-status
 * with the code it got back; a modern, already-logged-in device calls
 * pairing-link with that code plus ITS OWN session (via the normal
 * X-Session-Token auth every other endpoint uses). Nothing here talks to
 * lichess.org directly - it's pure bookkeeping over the existing session
 * store, reusing requireSession/getSessionByToken exactly as every other
 * authenticated action does. */

async function handlePairingCreate(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var code = await lichess.createPairCode();
    return lichess.sendJson(res, 200, { code: code });
}

async function handlePairingStatus(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var code = (req.query && req.query.code || '').toString().toUpperCase();
    if (!code) { return lichess.sendJson(res, 400, { error: 'missing_code' }); }

    var record = await lichess.getPairCode(code);
    if (!record) { return lichess.sendJson(res, 200, { found: false }); }
    if (!record.linked) { return lichess.sendJson(res, 200, { found: true, linked: false }); }

    /* One-time use: consume the code now that the Kindle has picked up the
     * session, so it can't be replayed by anyone who happened to see it. */
    await lichess.deletePairCode(code);
    return lichess.sendJson(res, 200, { found: true, linked: true, sessionToken: record.sessionToken, username: record.username });
}

async function handlePairingLink(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var code = (body.code || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { return lichess.sendJson(res, 400, { error: 'missing_code' }); }

    var record = await lichess.getPairCode(code);
    if (!record) { return lichess.sendJson(res, 400, { error: 'invalid_or_expired_code' }); }

    /* Hands the Kindle the SAME opaque session token this device is using -
     * not a new one, and never the real Lichess access token underneath it
     * (that stays server-side either way, exactly as it already does for
     * every other client). Logging out from either device ends the shared
     * session for both, which is the expected behavior for a "linked"
     * device rather than a surprise. */
    await lichess.linkPairCode(code, auth.token, auth.session.username);
    return lichess.sendJson(res, 200, { ok: true });
}

/* ---- Find Match ----
 * Lichess's own seek API (POST /api/board/seek) requires holding a single
 * HTTP request open until a match or cancellation happens, which fits
 * neither a Vercel serverless function (hard execution time limit) nor
 * this app's polling-only client architecture - see _lichess.js's "Find
 * Match queue" section. So this matches two of the app's own logged-in
 * users against each other and creates a real Lichess challenge between
 * them with lichessFetch, the same primitive every other Lichess action in
 * this file already uses - no existing challenge/game code changes at all,
 * this just orchestrates two calls to it using two different sessions. */

async function createAndAcceptChallenge(challengerSession, accepterSession, clockLimitSec, clockIncrementSec, rated) {
    var createResult = await lichess.lichessFetch(challengerSession.accessToken, '/api/challenge/' + encodeURIComponent(accepterSession.username), {
        method: 'POST',
        form: { rated: rated, 'clock.limit': clockLimitSec, 'clock.increment': clockIncrementSec, color: 'random', variant: 'standard' }
    });
    if (!createResult.ok || !createResult.data || !createResult.data.id) {
        throw new Error('challenge_create_failed: ' + JSON.stringify(createResult.data));
    }
    var challengeId = createResult.data.id;

    var acceptResult = await lichess.lichessFetch(accepterSession.accessToken, '/api/challenge/' + encodeURIComponent(challengeId) + '/accept', { method: 'POST' });
    if (!acceptResult.ok) {
        throw new Error('challenge_accept_failed: ' + JSON.stringify(acceptResult.data));
    }
    return challengeId; /* shares its id with the resulting game, per the same convention challenge-status already relies on */
}

/* Called from both find-match-start (so two near-simultaneous searchers
 * can match immediately) and find-match-poll (so matching also completes
 * lazily on a later tick, regardless of timing) - same lazy-check pattern
 * api/_room.js already uses for online-room clock timeouts. Not
 * transactional (Upstash's plain REST API has no MULTI/WATCH here), so two
 * concurrent polls could in principle both grab the same third ticket -
 * for an app this size that's an acceptable, cheaply-mitigated risk (the
 * re-check right before creating the challenge below) rather than
 * something worth a distributed lock over. */
async function tryMatchTicket(myTicketId) {
    var myTicket = await lichess.getMatchTicket(myTicketId);
    if (!myTicket) { return null; }
    if (myTicket.matchedGameId) { return myTicket; }

    var ids = await lichess.listMatchQueueIds();
    for (var i = 0; i < ids.length; i++) {
        var otherId = ids[i];
        if (otherId === myTicketId) { continue; }

        var other = await lichess.getMatchTicket(otherId);
        if (!other || other.matchedGameId) {
            await lichess.removeFromMatchQueue(otherId); /* stale, expired, or already paired elsewhere - clean up lazily */
            continue;
        }
        if (other.username === myTicket.username) { continue; } /* don't match a user against their own other device */
        if (other.timeControlSec !== myTicket.timeControlSec || other.incrementSec !== myTicket.incrementSec || other.rated !== myTicket.rated) { continue; }

        var mySession = await lichess.getSessionByToken(myTicket.sessionToken);
        var otherSession = await lichess.getSessionByToken(other.sessionToken);
        if (!mySession || !otherSession) {
            console.error('find-match: skipping candidate ' + otherId + ' - session missing for ' + (!mySession ? myTicket.username : other.username));
            continue;
        }

        try {
            /* Best-effort re-check immediately before creating the game,
             * to shrink (not eliminate) the race window described above. */
            var recheckOther = await lichess.getMatchTicket(otherId);
            if (!recheckOther || recheckOther.matchedGameId) { continue; }

            var gameId = await createAndAcceptChallenge(mySession, otherSession, myTicket.timeControlSec, myTicket.incrementSec, myTicket.rated);

            myTicket.matchedGameId = gameId;
            other.matchedGameId = gameId;
            await lichess.saveMatchTicket(myTicketId, myTicket);
            await lichess.saveMatchTicket(otherId, other);
            await lichess.removeFromMatchQueue(myTicketId);
            await lichess.removeFromMatchQueue(otherId);
            return myTicket;
        } catch (e) {
            /* Surfaced two ways: logged here (check Vercel's function logs
             * for "find-match:" if search seems permanently stuck with a
             * genuine partner present), and recorded on the ticket so the
             * poll response can tell the client something more specific
             * than "still nobody available" - see handleFindMatchPoll. */
            var errMsg = String(e && e.message || e);
            console.error('find-match: challenge creation failed between ' + myTicket.username + ' and ' + other.username + ': ' + errMsg);
            myTicket.lastError = errMsg;
            await lichess.saveMatchTicket(myTicketId, myTicket);
            continue; /* this candidate didn't pan out - try the next one instead of failing the whole poll */
        }
    }
    return myTicket;
}

async function handleFindMatchStart(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var timeControlSec = parseInt(body.timeControlSec, 10);
    var incrementSec = parseInt(body.incrementSec, 10);
    var rated = !!body.rated;
    if (isNaN(timeControlSec) || isNaN(incrementSec)) { return lichess.sendJson(res, 400, { error: 'bad_request' }); }

    var ticketId = lichess.randomTicketId();
    await lichess.saveMatchTicket(ticketId, {
        sessionToken: auth.token,
        username: auth.session.username,
        timeControlSec: timeControlSec,
        incrementSec: incrementSec,
        rated: rated,
        createdAt: Date.now(),
        matchedGameId: null
    });
    await lichess.addToMatchQueue(ticketId);

    var result = await tryMatchTicket(ticketId);
    var matched = !!(result && result.matchedGameId);
    return lichess.sendJson(res, 200, { ticketId: ticketId, matched: matched, gameId: matched ? result.matchedGameId : null, lastError: (result && result.lastError) || null });
}

async function handleFindMatchPoll(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var ticketId = (req.query && req.query.ticketId || '').toString();
    if (!ticketId) { return lichess.sendJson(res, 400, { error: 'missing_ticket_id' }); }

    var result = await tryMatchTicket(ticketId);
    if (!result) { return lichess.sendJson(res, 200, { found: false }); }
    var matched = !!result.matchedGameId;
    return lichess.sendJson(res, 200, { found: true, matched: matched, gameId: matched ? result.matchedGameId : null, lastError: result.lastError || null });
}

async function handleFindMatchCancel(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var ticketId = (body.ticketId || '').toString();
    if (!ticketId) { return lichess.sendJson(res, 400, { error: 'missing_ticket_id' }); }

    var ticket = await lichess.getMatchTicket(ticketId);
    if (ticket && ticket.matchedGameId) {
        /* A match already went through - the game is real, don't discard
         * it just because a cancel and a match crossed in flight. */
        return lichess.sendJson(res, 200, { ok: true, alreadyMatched: true, gameId: ticket.matchedGameId });
    }

    await lichess.removeFromMatchQueue(ticketId);
    await lichess.deleteMatchTicket(ticketId);
    return lichess.sendJson(res, 200, { ok: true });
}

/* ---- Find Match with Lichess Players (real Lichess seek) ----
 * See _lichess.js's "Find Match with Lichess Players" section for the
 * architecture and its one real limitation (a bounded-window
 * approximation of an API that wants a single held-open connection).
 * SEEK_WINDOW_MS deliberately leaves headroom under a typical serverless
 * function's execution-time limit for the two /api/account/playing calls
 * around it (unlike poll-events's SAMPLE_MS, which has no such calls to
 * budget for). */
var SEEK_WINDOW_MS = 6000;

async function findNewGame(accessToken, existingGameIds) {
    var playing = await lichess.lichessFetch(accessToken, '/api/account/playing');
    if (!playing.ok) { return null; }
    var games = (playing.data && playing.data.nowPlaying) || [];
    for (var i = 0; i < games.length; i++) {
        if (existingGameIds.indexOf(games[i].gameId) === -1) {
            return { gameId: games[i].gameId, color: lichess.normalizeColor(games[i].color) };
        }
    }
    return null;
}

async function performSeekCycle(accessToken, seekRecord) {
    var found = await findNewGame(accessToken, seekRecord.existingGameIds);
    if (found) { return { matched: true, gameId: found.gameId, color: found.color }; }

    await lichess.openBoundedSeek(accessToken, seekRecord.params, SEEK_WINDOW_MS);

    var found2 = await findNewGame(accessToken, seekRecord.existingGameIds);
    if (found2) { return { matched: true, gameId: found2.gameId, color: found2.color }; }
    return { matched: false };
}

async function handleSeekStart(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var timeMinutes = parseInt(body.timeMinutes, 10);
    var incrementSec = parseInt(body.incrementSec, 10);
    var rated = !!body.rated;
    if (isNaN(timeMinutes) || isNaN(incrementSec)) { return lichess.sendJson(res, 400, { error: 'bad_request' }); }

    var playingBefore = await lichess.lichessFetch(auth.session.accessToken, '/api/account/playing');
    var existingGameIds = [];
    if (playingBefore.ok) {
        var games = (playingBefore.data && playingBefore.data.nowPlaying) || [];
        for (var i = 0; i < games.length; i++) { existingGameIds.push(games[i].gameId); }
    }

    var seekId = lichess.randomTicketId();
    var seekRecord = {
        sessionToken: auth.token,
        existingGameIds: existingGameIds,
        params: { timeMinutes: timeMinutes, incrementSec: incrementSec, rated: rated },
        startedAt: Date.now()
    };
    await lichess.saveSeekSession(seekId, seekRecord);

    var result = await performSeekCycle(auth.session.accessToken, seekRecord);
    return lichess.sendJson(res, 200, { seekId: seekId, matched: result.matched, gameId: result.gameId || null, color: result.color || null });
}

async function handleSeekPoll(req, res) {
    if (req.method !== 'GET') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var seekId = (req.query && req.query.seekId || '').toString();
    if (!seekId) { return lichess.sendJson(res, 400, { error: 'missing_seek_id' }); }

    var seekRecord = await lichess.getSeekSession(seekId);
    if (!seekRecord) { return lichess.sendJson(res, 200, { found: false }); }

    var result = await performSeekCycle(auth.session.accessToken, seekRecord);
    return lichess.sendJson(res, 200, { found: true, matched: result.matched, gameId: result.gameId || null, color: result.color || null });
}

async function handleSeekCancel(req, res) {
    if (req.method !== 'POST') { return lichess.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var auth = await lichess.requireSession(req);
    if (!auth) { return lichess.sendJson(res, 401, { error: 'not_logged_in' }); }

    var body = await lichess.readJsonBody(req);
    var seekId = (body.seekId || '').toString();
    if (!seekId) { return lichess.sendJson(res, 400, { error: 'missing_seek_id' }); }

    /* No live seek connection to explicitly abort here - each window is
     * already bounded and self-closing (see openBoundedSeek). Cancelling
     * just means "stop polling and forget this search," which deleting
     * the session record accomplishes: the next poll (if one somehow still
     * arrived) would find nothing and report found:false. */
    await lichess.deleteSeekSession(seekId);
    return lichess.sendJson(res, 200, { ok: true });
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
    'poll-events': handlePollEvents,
    'puzzle-daily': handlePuzzleDaily,
    'puzzle-next': handlePuzzleNext,
    'my-games': handleMyGames,
    'tv-channels': handleTvChannels,
    'watch-game': handleWatchGame,
    'explorer': handleExplorer,
    'tablebase': handleTablebase,
    'pairing-create': handlePairingCreate,
    'pairing-status': handlePairingStatus,
    'pairing-link': handlePairingLink,
    'find-match-start': handleFindMatchStart,
    'find-match-poll': handleFindMatchPoll,
    'find-match-cancel': handleFindMatchCancel,
    'seek-start': handleSeekStart,
    'seek-poll': handleSeekPoll,
    'seek-cancel': handleSeekCancel
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
