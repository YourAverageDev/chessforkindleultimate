/* _room.js - shared helpers for the online-play API routes.
 * Storage: Upstash Redis via api/_redis.js's plain REST wrapper - see that
 * file for how credentials are picked up.
 */
var ChessEngine = require('../js/chessEngine.js');
var crypto = require('crypto');
var redisCommand = require('./_redis.js').redisCommand;

var ROOM_TTL_SECONDS = 6 * 60 * 60; /* abandoned/finished rooms expire after 6h */
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* no 0/O/1/I - avoids ambiguity when read aloud/typed */
var PUBLIC_TIME_CONTROL_MS = 10 * 60 * 1000; /* 10 minutes per side, Public Server Play only */

function roomKey(code) { return 'chessroom:' + code; }

var PUBLIC_ROOMS_KEY = 'chessroom:public';

async function getRoom(code) {
    var raw = await redisCommand(['GET', roomKey(code)]);
    if (!raw) { return null; }
    return JSON.parse(raw);
}

async function saveRoom(code, room) {
    await redisCommand(['SET', roomKey(code), JSON.stringify(room), 'EX', ROOM_TTL_SECONDS]);
}

async function deleteRoom(code) {
    await redisCommand(['DEL', roomKey(code)]);
}

async function addToPublicList(code) {
    await redisCommand(['SADD', PUBLIC_ROOMS_KEY, code]);
}

async function removeFromPublicList(code) {
    await redisCommand(['SREM', PUBLIC_ROOMS_KEY, code]);
}

async function listPublicRoomCodes() {
    var codes = await redisCommand(['SMEMBERS', PUBLIC_ROOMS_KEY]);
    return codes || [];
}

function randomCode() {
    var out = '';
    for (var i = 0; i < 5; i++) {
        out += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    }
    return out;
}

async function createRoomCode() {
    for (var attempt = 0; attempt < 8; attempt++) {
        var code = randomCode();
        var existing = await getRoom(code);
        if (!existing) { return code; }
    }
    throw new Error('Could not allocate a room code, please try again.');
}

function randomToken() {
    return crypto.randomBytes(16).toString('hex');
}

/* Replays a room's move list through the rules engine to get the current
 * position. The move list is the single source of truth stored in Redis -
 * simpler and far less bug-prone than trying to keep an incrementally
 * updated board in sync across requests. */
function replay(moves) {
    var state = ChessEngine.createInitialState();
    for (var i = 0; i < moves.length; i++) {
        var mv = moves[i];
        var legal = ChessEngine.generateLegalMoves(state);
        var found = null;
        for (var j = 0; j < legal.length; j++) {
            if (legal[j].from === mv.from && legal[j].to === mv.to && legal[j].promotion === (mv.promotion || null)) {
                found = legal[j];
                break;
            }
        }
        if (!found) { throw new Error('Corrupt move history at index ' + i); }
        state = ChessEngine.makeMove(state, found);
    }
    return state;
}

function statusAndResult(state) {
    var legal = ChessEngine.generateLegalMoves(state);
    var status = ChessEngine.getStatus(state, legal);
    if (status === 'checkmate') {
        return { finished: true, result: (state.turn === 'w' ? 'black' : 'white') + '_wins_checkmate' };
    }
    if (status === 'stalemate') { return { finished: true, result: 'draw_stalemate' }; }
    if (status === 'draw-50move') { return { finished: true, result: 'draw_50move' }; }
    if (status === 'draw-material') { return { finished: true, result: 'draw_material' }; }
    return { finished: false, result: null };
}

/* Timeout is checked lazily (on every /api/state poll and before every
 * /api/move), rather than on a server-side timer, since serverless
 * functions don't have a persistent background process to run one in
 * anyway - the room object always has enough information (whose turn it
 * is, and when that turn started) to determine "has this side run out of
 * time?" from wall-clock time alone. Mutates and returns `room`; the
 * caller is responsible for persisting it if `finished` comes back true. */
function checkTimeout(room) {
    if (!room.timerEnabled || room.status !== 'active' || !room.turnStartedAt) {
        return { room: room, justFinished: false };
    }
    var state = replay(room.moves);
    var elapsed = Date.now() - room.turnStartedAt;
    var turn = state.turn;
    var remaining = (turn === 'w' ? room.whiteTimeLeftMs : room.blackTimeLeftMs) - elapsed;

    if (remaining > 0) { return { room: room, justFinished: false }; }

    if (turn === 'w') { room.whiteTimeLeftMs = 0; } else { room.blackTimeLeftMs = 0; }
    room.status = 'finished';
    room.result = (turn === 'w' ? 'black' : 'white') + '_wins_timeout';
    return { room: room, justFinished: true };
}

function timerFields(room) {
    return {
        timerEnabled: !!room.timerEnabled,
        whiteTimeLeftMs: room.timerEnabled ? room.whiteTimeLeftMs : null,
        blackTimeLeftMs: room.timerEnabled ? room.blackTimeLeftMs : null,
        turnStartedAt: room.timerEnabled ? room.turnStartedAt : null
    };
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') { return req.body; }
    if (typeof req.body === 'string' && req.body.length) {
        try { return JSON.parse(req.body); } catch (e) { return {}; }
    }
    return new Promise(function (resolve) {
        var chunks = [];
        req.on('data', function (c) { chunks.push(c); });
        req.on('end', function () {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
            catch (e) { resolve({}); }
        });
        req.on('error', function () { resolve({}); });
    });
}

function sendJson(res, statusCode, obj) {
    res.status(statusCode).json(obj);
}

module.exports = {
    getRoom: getRoom,
    saveRoom: saveRoom,
    deleteRoom: deleteRoom,
    addToPublicList: addToPublicList,
    removeFromPublicList: removeFromPublicList,
    listPublicRoomCodes: listPublicRoomCodes,
    createRoomCode: createRoomCode,
    randomToken: randomToken,
    replay: replay,
    statusAndResult: statusAndResult,
    checkTimeout: checkTimeout,
    timerFields: timerFields,
    readJsonBody: readJsonBody,
    sendJson: sendJson,
    ROOM_TTL_SECONDS: ROOM_TTL_SECONDS,
    PUBLIC_TIME_CONTROL_MS: PUBLIC_TIME_CONTROL_MS
};
