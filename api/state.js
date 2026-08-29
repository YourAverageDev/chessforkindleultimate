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

        return roomLib.sendJson(res, 200, {
            moves: r.moves,
            status: r.status,
            result: r.result,
            whitePresent: !!r.whiteToken,
            blackPresent: !!r.blackToken
        });
    } catch (err) {
        return roomLib.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
