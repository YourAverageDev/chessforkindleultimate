/* index.js - the Worker's public entry point.
 *
 * Everything under /uc/* (Ultimate Chess Matchmaking) is routed here to
 * one of two Durable Objects: Matchmaker (a single global instance - see
 * matchmaker.js for why) for the queue endpoints, or a GameRoom (one
 * instance per gameId) for everything about an actual match. This file's
 * only real jobs are: parse the path, forward the request to the right
 * Durable Object stub, and attach CORS headers (the frontend is served
 * from a different origin - Vercel - than this Worker, so every response,
 * including the OPTIONS preflight browsers send first for a JSON POST,
 * needs these).
 */
import { Matchmaker } from './matchmaker.js';
import { GameRoom } from './gameRoom.js';

export { Matchmaker, GameRoom };

/* Wide open (no accounts/cookies here to protect - a player is identified
 * by an opaque id in the request body/query, not ambient browser
 * credentials) - tighten to your exact site origin instead of '*' if
 * you'd rather; see cf-worker/README.md. */
var CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
};

function withCors(response) {
    var headers = new Headers(response.headers);
    for (var key in CORS_HEADERS) { headers.set(key, CORS_HEADERS[key]); }
    return new Response(response.body, { status: response.status, headers: headers });
}

function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status: status || 400,
        headers: { 'content-type': 'application/json' }
    });
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        var url = new URL(request.url);
        var path = url.pathname;

        try {
            if (path === '/uc/queue/join' && request.method === 'POST') {
                return withCors(await forwardToMatchmaker(env, '/queue/join', 'POST', await request.text()));
            }
            if (path === '/uc/queue/status' && request.method === 'GET') {
                return withCors(await forwardToMatchmaker(env, '/queue/status' + url.search, 'GET', null));
            }
            if (path === '/uc/queue/cancel' && request.method === 'POST') {
                return withCors(await forwardToMatchmaker(env, '/queue/cancel', 'POST', await request.text()));
            }

            if (path === '/uc/game/state' && request.method === 'GET') {
                var gameId = url.searchParams.get('gameId') || '';
                if (!gameId) { return withCors(jsonError('missing_game_id')); }
                return withCors(await forwardToGameRoom(env, gameId, '/state' + url.search, 'GET', null));
            }
            if ((path === '/uc/game/move' || path === '/uc/game/resign') && request.method === 'POST') {
                var bodyText = await request.text();
                var body;
                try { body = JSON.parse(bodyText); } catch (e) { body = {}; }
                var gid = (body.gameId || '').toString();
                if (!gid) { return withCors(jsonError('missing_game_id')); }
                var subPath = path === '/uc/game/move' ? '/move' : '/resign';
                return withCors(await forwardToGameRoom(env, gid, subPath, 'POST', bodyText));
            }

            return withCors(jsonError('not_found', 404));
        } catch (e) {
            return withCors(jsonError('server_error: ' + String((e && e.message) || e), 500));
        }
    }
};

function forwardToMatchmaker(env, path, method, bodyText) {
    var id = env.MATCHMAKER.idFromName('global');
    var stub = env.MATCHMAKER.get(id);
    var init = { method: method };
    if (bodyText !== null) {
        init.headers = { 'content-type': 'application/json' };
        init.body = bodyText;
    }
    return stub.fetch('https://matchmaker' + path, init);
}

function forwardToGameRoom(env, gameId, path, method, bodyText) {
    var id = env.GAME_ROOM.idFromName(gameId);
    var stub = env.GAME_ROOM.get(id);
    var init = { method: method };
    if (bodyText !== null) {
        init.headers = { 'content-type': 'application/json' };
        init.body = bodyText;
    }
    return stub.fetch('https://game-room' + path, init);
}
