var room = require('./_room.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return room.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var body = await room.readJsonBody(req);
        var isPublic = !!body.public;

        var code = await room.createRoomCode();
        var token = room.randomToken();
        var now = Date.now();

        await room.saveRoom(code, {
            moves: [],
            whiteToken: token,
            blackToken: null,
            status: 'waiting',
            result: null,
            public: isPublic,
            createdAt: now,
            lastMoveAt: now,
            /* 10-minute clock, Public Server Play only - private room-code
             * games (Create Game/Join Game) stay untimed. turnStartedAt
             * stays null until join-room.js starts the clock, since white
             * can't be "on the clock" while nobody has joined yet. */
            timerEnabled: isPublic,
            whiteTimeLeftMs: isPublic ? room.PUBLIC_TIME_CONTROL_MS : null,
            blackTimeLeftMs: isPublic ? room.PUBLIC_TIME_CONTROL_MS : null,
            turnStartedAt: null
        });

        if (isPublic) { await room.addToPublicList(code); }

        return room.sendJson(res, 200, { room: code, token: token, color: 'w' });
    } catch (err) {
        return room.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
