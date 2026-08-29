var lichess = require('./_lichess.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return lichess.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
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
    } catch (err) {
        return lichess.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
