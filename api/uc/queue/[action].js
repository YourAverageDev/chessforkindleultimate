var uc = require('../_uc.js');

/* Vercel's Hobby plan caps a deployment at 12 Serverless Functions - the
 * same limit api/lichess/[action].js already ran into and solved the same
 * way (see that file's own comment). This dynamic route (`[action].js`
 * matches /api/uc/queue/<anything>) folds join/status/cancel into one
 * function instead of three - the client's URLs (js/ultimateChess.js) are
 * unchanged, since /api/uc/queue/join etc. still resolve to this file. */

async function handleJoin(req, res) {
    if (req.method !== 'POST') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var body = await uc.readJsonBody(req);
    var playerId = (body.playerId || '').toString();
    var timeControlSec = parseInt(body.timeControlSec, 10);
    var incrementSec = parseInt(body.incrementSec, 10);
    if (!playerId || isNaN(timeControlSec) || isNaN(incrementSec)) {
        return uc.sendJson(res, 400, { error: 'bad_request' });
    }
    var result = await uc.joinQueue(playerId, timeControlSec, incrementSec);
    return uc.sendJson(res, 200, result);
}

async function handleStatus(req, res) {
    if (req.method !== 'GET') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var ticketId = (req.query && req.query.ticketId || '').toString();
    if (!ticketId) { return uc.sendJson(res, 400, { error: 'missing_ticket_id' }); }
    var result = await uc.pollStatus(ticketId);
    return uc.sendJson(res, 200, result);
}

async function handleCancel(req, res) {
    if (req.method !== 'POST') { return uc.sendJson(res, 405, { error: 'method_not_allowed' }); }
    var body = await uc.readJsonBody(req);
    var ticketId = (body.ticketId || '').toString();
    if (!ticketId) { return uc.sendJson(res, 400, { error: 'missing_ticket_id' }); }
    var result = await uc.cancelQueue(ticketId);
    return uc.sendJson(res, 200, result);
}

var ACTIONS = {
    join: handleJoin,
    status: handleStatus,
    cancel: handleCancel
};

module.exports = async function handler(req, res) {
    var action = req.query && req.query.action;
    var fn = ACTIONS.hasOwnProperty(action) ? ACTIONS[action] : null;
    if (!fn) { return uc.sendJson(res, 404, { error: 'unknown_action' }); }

    try {
        return await fn(req, res);
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
