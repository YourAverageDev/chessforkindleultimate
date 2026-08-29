var lichess = require('./_lichess.js');

var SAMPLE_MS = 7000; /* stay safely under typical serverless function time limits */

/* There's no plain polling GET for "list my pending incoming challenges"
 * as far as this app's author could confirm without live API access - only
 * a stream (/api/stream/event). This endpoint samples that stream for a
 * bounded window each time it's called (see _lichess.js sampleEventStream)
 * so the client can still just poll a normal request/response endpoint
 * every 15-20s, same as everything else in this app. That interval - not
 * "instant" - is the accepted tradeoff for staying entirely polling-based. */
module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
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
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
