var roomLib = require('./_room.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return roomLib.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var code = (req.query && req.query.room || '').toString().toUpperCase().trim();
        if (!code) { return roomLib.sendJson(res, 400, { error: 'missing_room' }); }

        var r = await roomLib.getRoom(code);
        if (!r) { return roomLib.sendJson(res, 404, { error: 'room_not_found' }); }

        /* Lazily catch a clock running out even when nobody has tried to
         * move - both players' periodic polling is what notices this, not
         * a background timer (serverless functions don't have one). */
        var timeoutCheck = roomLib.checkTimeout(r);
        if (timeoutCheck.justFinished) { await roomLib.saveRoom(code, r); }

        var response = {
            moves: r.moves,
            status: r.status,
            result: r.result,
            whitePresent: !!r.whiteToken,
            blackPresent: !!r.blackToken
        };
        var timerFields = roomLib.timerFields(r);
        for (var key in timerFields) {
            if (timerFields.hasOwnProperty(key)) { response[key] = timerFields[key]; }
        }

        return roomLib.sendJson(res, 200, response);
    } catch (err) {
        return roomLib.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
