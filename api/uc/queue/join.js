var uc = require('../_uc.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return uc.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var body = await uc.readJsonBody(req);
        var playerId = (body.playerId || '').toString();
        var timeControlSec = parseInt(body.timeControlSec, 10);
        var incrementSec = parseInt(body.incrementSec, 10);
        if (!playerId || isNaN(timeControlSec) || isNaN(incrementSec)) {
            return uc.sendJson(res, 400, { error: 'bad_request' });
        }

        var result = await uc.joinQueue(playerId, timeControlSec, incrementSec);
        return uc.sendJson(res, 200, result);
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
