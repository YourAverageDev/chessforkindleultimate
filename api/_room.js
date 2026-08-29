/* _room.js - shared helpers for the online-play API routes.
 * Storage: Upstash Redis via its plain REST API (no npm dependency at all -
 * just Node's built-in global fetch, available on Vercel's Node 18+
 * runtime). This works with either the "Vercel KV" quick-create flow
 * (env vars KV_REST_API_URL / KV_REST_API_TOKEN) or a directly-connected
 * Upstash Redis integration (UPSTASH_REDIS_REST_URL / _TOKEN) - whichever
 * one is present in the project's environment variables is used.
 */
var ChessEngine = require('../js/chessEngine.js');
var crypto = require('crypto');

var ROOM_TTL_SECONDS = 6 * 60 * 60; /* abandoned/finished rooms expire after 6h */
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* no 0/O/1/I - avoids ambiguity when read aloud/typed */

function getCreds() {
    var url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    var token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
        throw new Error('No KV store configured. Add "Vercel KV" (or an Upstash Redis integration) to this project in the Vercel dashboard Storage tab.');
    }
    return { url: url, token: token };
}

async function redisCommand(commandArray) {
    var creds = getCreds();
    var res = await fetch(creds.url, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + creds.token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(commandArray)
    });
    var data = await res.json();
    if (data.error) { throw new Error('KV error: ' + data.error); }
    return data.result;
}

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
    readJsonBody: readJsonBody,
    sendJson: sendJson,
    ROOM_TTL_SECONDS: ROOM_TTL_SECONDS
};
