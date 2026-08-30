/* _lichess.js - shared helpers for Lichess OAuth + API proxying.
 *
 * IMPORTANT CAVEAT: this is written from general knowledge of Lichess's
 * long-stable public API (OAuth2 + PKCE, Board API, challenges, the
 * account/event endpoints) - this sandbox's network policy blocks
 * lichess.org outright, so none of this could be checked against the live
 * API docs or a real account while writing it. The shapes below (field
 * names, endpoint paths) are a best-effort best-confidence reconstruction,
 * not a verified integration. Test the OAuth login first, since everything
 * else depends on it - if a specific call fails, the fix is almost always
 * a one-line adjustment here (a field name, a body encoding), not a
 * redesign.
 *
 * Sessions: after OAuth completes we mint our own opaque session token and
 * store {accessToken, lichessUsername} in Redis keyed by it (same Redis
 * store the online-play rooms already use). The browser only ever holds
 * OUR session token (in localStorage, for "remember login when possible"),
 * never the real Lichess access token - every Lichess API call happens
 * server-side through these endpoints, the same proxy pattern already
 * used for the online chess rooms.
 */
var crypto = require('crypto');

var LICHESS_BASE = 'https://lichess.org';
var CLIENT_ID = 'chess-for-kindle-ultimate';
var SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; /* 30 days - "remember login when possible" */

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
        headers: { Authorization: 'Bearer ' + creds.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(commandArray)
    });
    var data = await res.json();
    if (data.error) { throw new Error('KV error: ' + data.error); }
    return data.result;
}

function sessionKey(token) { return 'lichesssession:' + token; }

async function getSessionByToken(token) {
    if (!token) { return null; }
    var raw = await redisCommand(['GET', sessionKey(token)]);
    if (!raw) { return null; }
    return JSON.parse(raw);
}

async function saveSession(token, session) {
    await redisCommand(['SET', sessionKey(token), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS]);
}

async function deleteSession(token) {
    await redisCommand(['DEL', sessionKey(token)]);
}

function randomSessionToken() {
    return crypto.randomBytes(24).toString('hex');
}

/* Lichess speaks full-word colors ("white"/"black"); this app's own chess
 * engine and every other mode (2 Player, vs Computer, our own online
 * rooms) use single-char 'w'/'b' throughout - normalize at this boundary
 * so the client only ever deals with one convention. */
function normalizeColor(c) {
    if (c === 'white' || c === 'w') { return 'w'; }
    if (c === 'black' || c === 'b') { return 'b'; }
    return null;
}

function formEncode(obj) {
    var parts = [];
    for (var key in obj) {
        if (!obj.hasOwnProperty(key) || obj[key] === undefined || obj[key] === null) { continue; }
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(obj[key]));
    }
    return parts.join('&');
}

/* OAuth2's token endpoint is spec'd (RFC 6749) to take a form-urlencoded
 * body - using that rather than JSON for the widest chance of matching
 * whatever Lichess actually expects here. */
async function exchangeCodeForToken(code, verifier, redirectUri) {
    var body = formEncode({
        grant_type: 'authorization_code',
        code: code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID
    });
    var res = await fetch(LICHESS_BASE + '/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
    });
    var text = await res.text();
    var data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* leave data as {} */ }
    if (!res.ok || !data.access_token) {
        throw new Error('Lichess token exchange failed (' + res.status + '): ' + (data.error_description || data.error || text || 'unknown error'));
    }
    return data; /* { token_type, access_token, expires_in } */
}

/* Lichess's challenge/board-move endpoints take form-urlencoded (or empty)
 * bodies, not JSON - callers pass a plain object via `form` and this
 * encodes it, or omit it for a bodyless POST. */
async function lichessFetch(accessToken, path, options) {
    options = options || {};
    var headers = {};
    if (accessToken) { headers.Authorization = 'Bearer ' + accessToken; }
    var body;
    if (options.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = formEncode(options.form);
    }
    var res = await fetch(LICHESS_BASE + path, { method: options.method || 'GET', headers: headers, body: body });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data: data };
}

/* Reads a bounded window of an NDJSON stream (Lichess's /api/stream/event
 * and /api/board/game/stream/{id} are both this shape) and returns however
 * many complete JSON lines arrived before the deadline. There is no
 * "long-lived connection" anywhere in this app's own infrastructure by
 * design (old Kindle browsers can't hold one, and a Vercel serverless
 * function can't run forever either) - this bounded sampling is what lets
 * a normal request/response serverless function stand in for what would
 * otherwise be a permanent stream subscription. Hitting the deadline is
 * the expected, common case, not an error. */
async function sampleEventStream(accessToken, path, maxMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, maxMs);
    var events = [];
    try {
        var res = await fetch(LICHESS_BASE + path, {
            headers: { Authorization: 'Bearer ' + accessToken },
            signal: controller.signal
        });
        if (!res.body || !res.body.getReader) { return events; }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        for (;;) {
            var chunk = await reader.read();
            if (chunk.done) { break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop();
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].replace(/^\s+|\s+$/g, '');
                if (!line) { continue; }
                try { events.push(JSON.parse(line)); } catch (e) { /* skip malformed line */ }
            }
        }
    } catch (e) {
        /* Abort-on-timeout is the normal exit path, not a real failure. */
    } finally {
        clearTimeout(timer);
    }
    return events;
}

/* Lichess's game-list export endpoints (/api/games/user/{username}) speak
 * NDJSON (one JSON object per line), not a single JSON value - this reads
 * the whole (finite, bounded-by-`max=`) response body and parses it line
 * by line, unlike lichessFetch's single JSON.parse. Unlike the live event
 * stream (sampleEventStream), this isn't open-ended, so no time-bounded
 * sampling is needed - the response just ends once Lichess has sent the
 * requested number of games. */
async function lichessFetchNdjson(accessToken, path) {
    var headers = { Accept: 'application/x-ndjson' };
    if (accessToken) { headers.Authorization = 'Bearer ' + accessToken; }
    var res = await fetch(LICHESS_BASE + path, { headers: headers });
    var text = await res.text();
    var lines = [];
    if (res.ok) {
        var rawLines = text.split('\n');
        for (var i = 0; i < rawLines.length; i++) {
            var line = rawLines[i].replace(/^\s+|\s+$/g, '');
            if (!line) { continue; }
            try { lines.push(JSON.parse(line)); } catch (e) { /* skip malformed line */ }
        }
    }
    return { ok: res.ok, status: res.status, lines: lines };
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

/* Every authenticated endpoint resolves the caller's session this way -
 * the client sends our opaque session token (never the real Lichess
 * token) in this header. */
async function requireSession(req) {
    var token = (req.headers && req.headers['x-session-token']) || null;
    if (!token) { return null; }
    var session = await getSessionByToken(token);
    return session ? { token: token, session: session } : null;
}

module.exports = {
    LICHESS_BASE: LICHESS_BASE,
    CLIENT_ID: CLIENT_ID,
    normalizeColor: normalizeColor,
    getSessionByToken: getSessionByToken,
    saveSession: saveSession,
    deleteSession: deleteSession,
    randomSessionToken: randomSessionToken,
    exchangeCodeForToken: exchangeCodeForToken,
    lichessFetch: lichessFetch,
    lichessFetchNdjson: lichessFetchNdjson,
    sampleEventStream: sampleEventStream,
    formEncode: formEncode,
    readJsonBody: readJsonBody,
    sendJson: sendJson,
    requireSession: requireSession
};
