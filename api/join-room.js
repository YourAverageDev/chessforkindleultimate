var roomLib = require('./_room.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return roomLib.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var body = await roomLib.readJsonBody(req);
        var code = (body.room || '').toString().toUpperCase().trim();
        if (!code) { return roomLib.sendJson(res, 400, { error: 'missing_room' }); }

        var r = await roomLib.getRoom(code);
        if (!r) { return roomLib.sendJson(res, 404, { error: 'room_not_found' }); }
        if (r.blackToken) { return roomLib.sendJson(res, 409, { error: 'room_full' }); }

        var token = roomLib.randomToken();
        r.blackToken = token;
        r.status = 'active';
        r.lastMoveAt = Date.now();
        if (r.timerEnabled) { r.turnStartedAt = Date.now(); } /* white's clock starts now */
        await roomLib.saveRoom(code, r);
        await roomLib.removeFromPublicList(code); /* no longer joinable - drop it from the lobby */

        return roomLib.sendJson(res, 200, { room: code, token: token, color: 'b' });
    } catch (err) {
        return roomLib.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
