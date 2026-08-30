var uc = require('../_uc.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return uc.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var ticketId = (req.query && req.query.ticketId || '').toString();
        if (!ticketId) { return uc.sendJson(res, 400, { error: 'missing_ticket_id' }); }

        var result = await uc.pollStatus(ticketId);
        return uc.sendJson(res, 200, result);
    } catch (err) {
        return uc.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
