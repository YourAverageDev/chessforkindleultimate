var roomLib = require('./_room.js');
var ChessEngine = require('../js/chessEngine.js');

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return roomLib.sendJson(res, 405, { error: 'method_not_allowed' });
    }

    try {
        var body = await roomLib.readJsonBody(req);
        var code = (body.room || '').toString().toUpperCase().trim();
        var token = (body.token || '').toString();
        var from = body.from;
        var to = body.to;
        var promotion = body.promotion || null;

        if (!code || !token || typeof from !== 'number' || typeof to !== 'number') {
            return roomLib.sendJson(res, 400, { error: 'bad_request' });
        }

        var r = await roomLib.getRoom(code);
        if (!r) { return roomLib.sendJson(res, 404, { error: 'room_not_found' }); }
        if (r.status !== 'active') { return roomLib.sendJson(res, 409, { error: 'game_not_active', status: r.status, result: r.result }); }

        var myColor = null;
        if (token === r.whiteToken) { myColor = 'w'; }
        else if (token === r.blackToken) { myColor = 'b'; }
        if (!myColor) { return roomLib.sendJson(res, 403, { error: 'invalid_token' }); }

        var state = roomLib.replay(r.moves);
        if (state.turn !== myColor) { return roomLib.sendJson(res, 403, { error: 'not_your_turn' }); }

        var legal = ChessEngine.generateLegalMoves(state);
        var found = null;
        for (var i = 0; i < legal.length; i++) {
            if (legal[i].from === from && legal[i].to === to && legal[i].promotion === promotion) {
                found = legal[i];
                break;
            }
        }
        if (!found) { return roomLib.sendJson(res, 400, { error: 'illegal_move' }); }

        r.moves.push({ from: from, to: to, promotion: promotion });
        var newState = ChessEngine.makeMove(state, found);
        var outcome = roomLib.statusAndResult(newState);
        if (outcome.finished) {
            r.status = 'finished';
            r.result = outcome.result;
        }
        r.lastMoveAt = Date.now();
        await roomLib.saveRoom(code, r);

        return roomLib.sendJson(res, 200, { moves: r.moves, status: r.status, result: r.result });
    } catch (err) {
        return roomLib.sendJson(res, 500, { error: 'server_error', message: String(err && err.message || err) });
    }
};
