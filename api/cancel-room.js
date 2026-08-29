var roomLib = require('./_room.js');

/* Lets the room creator back out of a room that's still waiting for an
 * opponent - deletes it outright (rather than leaving it to expire on its
 * own TTL) so a stale room disappears from the public lobby immediately
 * and a joiner with an old private code gets a clean "not found" instead
 * of waiting forever for someone who already left. */
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return roomLib.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var body = await roomLib.readJsonBody(req);
        var code = (body.room || '').toString().toUpperCase().trim();
        var token = (body.token || '').toString();
        if (!code || !token) { return roomLib.sendJson(res, 400, { error: 'bad_request' }); }

        var r = await roomLib.getRoom(code);
        if (!r) { return roomLib.sendJson(res, 200, { ok: true }); } /* already gone */
        if (r.whiteToken !== token) { return roomLib.sendJson(res, 403, { error: 'not_room_owner' }); }
        if (r.status !== 'waiting') { return roomLib.sendJson(res, 409, { error: 'game_already_started' }); }

        await roomLib.deleteRoom(code);
        await roomLib.removeFromPublicList(code);

        return roomLib.sendJson(res, 200, { ok: true });
    } catch (err) {
        return roomLib.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
