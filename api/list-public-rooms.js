var roomLib = require('./_room.js');

var MAX_LISTED = 20;

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        return roomLib.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var codes = await roomLib.listPublicRoomCodes();
        var rooms = [];

        for (var i = 0; i < codes.length; i++) {
            var code = codes[i];
            var r = await roomLib.getRoom(code);
            if (!r || r.status !== 'waiting') {
                /* Lazily clean up the lobby set: a room can leave the
                 * "waiting" state (or expire entirely) without whoever did
                 * it remembering to unlist it - e.g. its TTL just ran out. */
                await roomLib.removeFromPublicList(code);
                continue;
            }
            rooms.push({ room: code, createdAt: r.createdAt });
        }

        rooms.sort(function (a, b) { return b.createdAt - a.createdAt; });
        if (rooms.length > MAX_LISTED) { rooms = rooms.slice(0, MAX_LISTED); }

        return roomLib.sendJson(res, 200, { rooms: rooms });
    } catch (err) {
        return roomLib.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
