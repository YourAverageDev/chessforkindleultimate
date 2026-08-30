/* lichess.js - Lichess login (OAuth2 + PKCE) and Board API client.
 * Plain ES5, XMLHttpRequest only - same old-Kindle-compatibility rules as
 * online.js. PKCE needs a SHA-256 hash of the code verifier; old WebKit
 * has no Web Crypto (SubtleCrypto) at all, so this bundles a small,
 * independently-verified pure-JS SHA-256 (tested against the RFC 7636
 * Appendix B worked example and NIST test vectors before use) rather than
 * depending on a browser API this project's oldest target devices lack.
 *
 * All actual Lichess API calls happen server-side through /api/lichess/*
 * (see api/lichess/_lichess.js for the important caveat about those
 * endpoints being written without live access to Lichess's docs) - this
 * file only ever talks to our own origin, plus the one browser redirect to
 * lichess.org's login/consent page, which is unavoidable for OAuth.
 */
var LichessClient = (function () {
    "use strict";

    var AUTH_BASE = 'https://lichess.org/oauth';
    var CLIENT_ID = 'chess-for-kindle-ultimate'; /* must match api/lichess/_lichess.js */
    var SCOPES = 'board:play challenge:read challenge:write';

    var LS_SESSION = 'lc_session_token';
    var LS_USERNAME = 'lc_username';
    var LS_PERFS = 'lc_perfs';
    var LS_PKCE_VERIFIER = 'lc_pkce_verifier';
    var LS_PKCE_STATE = 'lc_pkce_state';
    var LS_PKCE_REDIRECT = 'lc_pkce_redirect';

    function storageGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function storageSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* no persistence available - login just won't be remembered */ }
    }
    function storageRemove(key) {
        try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }

    /* ---- SHA-256 (verified against RFC 6234/NIST test vectors: sha256("")
     * and sha256("abc") match the well-known reference digests, and the
     * derived PKCE code_challenge for RFC 7636 Appendix B's example
     * verifier matches that RFC's expected output exactly). Operates on
     * ASCII/Latin-1 strings only, which is all PKCE ever needs this for. */
    function sha256Bytes(asciiStr) {
        function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
        var mathPow = Math.pow;
        var maxWord = mathPow(2, 32);
        var i, j;
        var words = [];
        var asciiBitLength = asciiStr.length * 8;
        var hash = [];
        var k = [];
        var primeCounter = 0;
        var isComposite = {};

        for (var candidate = 2; primeCounter < 64; candidate++) {
            if (!isComposite[candidate]) {
                for (i = 0; i < 313; i += candidate) { isComposite[i] = candidate; }
                hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
                k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
            }
        }

        asciiStr += '\x80';
        while (asciiStr.length % 64 - 56) { asciiStr += '\x00'; }
        for (i = 0; i < asciiStr.length; i++) {
            j = asciiStr.charCodeAt(i);
            if (j >> 8) { throw new Error('sha256: ASCII input only'); }
            words[i >> 2] |= j << ((3 - i) % 4) * 8;
        }
        words[words.length] = ((asciiBitLength / maxWord) | 0);
        words[words.length] = (asciiBitLength);

        for (j = 0; j < words.length;) {
            var w = words.slice(j, j += 16);
            var oldHash = hash;
            hash = hash.slice(0, 8);

            for (i = 0; i < 64; i++) {
                var w15 = w[i - 15], w2 = w[i - 2];
                var a = hash[0], e = hash[4];
                var temp1 = hash[7]
                    + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
                    + ((e & hash[5]) ^ ((~e) & hash[6]))
                    + k[i]
                    + (w[i] = (i < 16) ? w[i] : (
                        (w[i - 16]
                            + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
                            + w[i - 7]
                            + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0
                    ));
                var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
                    + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
                hash = [(temp1 + temp2) | 0].concat(hash);
                hash[4] = (hash[4] + temp1) | 0;
            }

            for (i = 0; i < 8; i++) { hash[i] = (hash[i] + oldHash[i]) | 0; }
        }

        var bytes = [];
        for (i = 0; i < 8; i++) {
            for (j = 3; j >= 0; j--) { bytes.push((hash[i] >> (j * 8)) & 255); }
        }
        return bytes;
    }

    function base64UrlEncode(bytes) {
        var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var output = '';
        var i = 0;
        for (; i + 2 < bytes.length; i += 3) {
            var chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
            output += CHARS.charAt((chunk >> 18) & 63) + CHARS.charAt((chunk >> 12) & 63) + CHARS.charAt((chunk >> 6) & 63) + CHARS.charAt(chunk & 63);
        }
        var remaining = bytes.length - i;
        if (remaining === 1) {
            var chunk1 = bytes[i] << 16;
            output += CHARS.charAt((chunk1 >> 18) & 63) + CHARS.charAt((chunk1 >> 12) & 63);
        } else if (remaining === 2) {
            var chunk2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
            output += CHARS.charAt((chunk2 >> 18) & 63) + CHARS.charAt((chunk2 >> 12) & 63) + CHARS.charAt((chunk2 >> 6) & 63);
        }
        return output.replace(/\+/g, '-').replace(/\//g, '_');
    }

    function randomString(length) {
        var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var out = '';
        var haveCrypto = !!(window.crypto && window.crypto.getRandomValues);
        var randomBytes = null;
        if (haveCrypto) {
            try { randomBytes = new Uint8Array(length); window.crypto.getRandomValues(randomBytes); }
            catch (e) { randomBytes = null; }
        }
        for (var i = 0; i < length; i++) {
            var r = randomBytes ? randomBytes[i] : Math.floor(Math.random() * 256);
            out += CHARS.charAt(r % CHARS.length);
        }
        return out;
    }

    function redirectUriForLogin() {
        return window.location.origin + window.location.pathname;
    }

    /* Kicks off login by navigating the whole page to Lichess's OAuth
     * consent screen - there's no way around a full-page redirect for
     * OAuth (it's the user authenticating with Lichess, not with us), but
     * everything needed to complete the flow when Lichess redirects back
     * is stashed in localStorage first. */
    function startLogin() {
        var verifier = randomString(64);
        var challenge = base64UrlEncode(sha256Bytes(verifier));
        var state = randomString(24);
        var redirectUri = redirectUriForLogin();

        storageSet(LS_PKCE_VERIFIER, verifier);
        storageSet(LS_PKCE_STATE, state);
        storageSet(LS_PKCE_REDIRECT, redirectUri);

        var url = AUTH_BASE
            + '?response_type=code'
            + '&client_id=' + encodeURIComponent(CLIENT_ID)
            + '&redirect_uri=' + encodeURIComponent(redirectUri)
            + '&scope=' + encodeURIComponent(SCOPES)
            + '&code_challenge_method=S256'
            + '&code_challenge=' + encodeURIComponent(challenge)
            + '&state=' + encodeURIComponent(state);

        window.location.href = url;
    }

    function parseQueryParam(name) {
        var search = window.location.search || '';
        var match = new RegExp('[?&]' + name + '=([^&]*)').exec(search);
        return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
    }

    /* Called once on every page load. If this load is Lichess redirecting
     * back with ?code&state, completes the token exchange; otherwise a
     * quick no-op. Strips the OAuth params from the URL either way so a
     * later page refresh never tries to reuse an already-spent code. */
    function handleOAuthCallback(callback) {
        var code = parseQueryParam('code');
        var state = parseQueryParam('state');
        if (!code || !state) { callback(null); return; }

        var expectedState = storageGet(LS_PKCE_STATE);
        var verifier = storageGet(LS_PKCE_VERIFIER);
        var redirectUri = storageGet(LS_PKCE_REDIRECT) || redirectUriForLogin();

        window.history.replaceState({}, document.title, window.location.pathname);
        storageRemove(LS_PKCE_STATE);
        storageRemove(LS_PKCE_VERIFIER);
        storageRemove(LS_PKCE_REDIRECT);

        if (!expectedState || state !== expectedState || !verifier) {
            callback({ message: 'Login could not be verified. Please try again.' });
            return;
        }

        request('POST', '/api/lichess/oauth-exchange', null, { code: code, verifier: verifier, redirectUri: redirectUri }, function (err, data) {
            if (err || !data) { callback({ message: 'Login failed. Please try again.' }); return; }
            storageSet(LS_SESSION, data.sessionToken);
            storageSet(LS_USERNAME, data.username);
            storageSet(LS_PERFS, JSON.stringify(data.perfs || {}));
            callback(null, { username: data.username, perfs: data.perfs || {} });
        });
    }

    function getStoredSession() {
        var token = storageGet(LS_SESSION);
        if (!token) { return null; }
        var perfs = {};
        try { perfs = JSON.parse(storageGet(LS_PERFS) || '{}'); } catch (e) { perfs = {}; }
        return { token: token, username: storageGet(LS_USERNAME), perfs: perfs };
    }

    function clearStoredSession() {
        storageRemove(LS_SESSION);
        storageRemove(LS_USERNAME);
        storageRemove(LS_PERFS);
    }

    function logout(callback) {
        var session = getStoredSession();
        clearStoredSession();
        if (!session) { callback(); return; }
        request('POST', '/api/lichess/logout', session.token, null, function () { callback(); });
    }

    function request(method, url, sessionToken, body, callback) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (sessionToken) { xhr.setRequestHeader('X-Session-Token', sessionToken); }
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
            if (xhr.status >= 200 && xhr.status < 300 && data) { callback(null, data); }
            else { callback({ status: xhr.status, data: data }, null); }
        };
        xhr.onerror = function () { callback({ status: 0, data: null, network: true }, null); };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    function fetchMe(sessionToken, callback) {
        request('GET', '/api/lichess/me', sessionToken, null, callback);
    }

    function createChallenge(sessionToken, opts, callback) {
        request('POST', '/api/lichess/challenge-create', sessionToken, opts, callback);
    }

    function respondToChallenge(sessionToken, challengeId, action, callback) {
        request('POST', '/api/lichess/challenge-respond', sessionToken, { challengeId: challengeId, action: action }, callback);
    }

    function checkChallengeStatus(sessionToken, challengeId, callback) {
        request('GET', '/api/lichess/challenge-status?challengeId=' + encodeURIComponent(challengeId), sessionToken, null, callback);
    }

    function fetchGameState(sessionToken, gameId, callback) {
        request('GET', '/api/lichess/game-state?gameId=' + encodeURIComponent(gameId), sessionToken, null, callback);
    }

    function sendMove(sessionToken, gameId, uci, offeringDraw, callback) {
        request('POST', '/api/lichess/move', sessionToken, { gameId: gameId, uci: uci, offeringDraw: !!offeringDraw }, callback);
    }

    function resign(sessionToken, gameId, callback) {
        request('POST', '/api/lichess/resign', sessionToken, { gameId: gameId }, callback);
    }

    function draw(sessionToken, gameId, accept, callback) {
        request('POST', '/api/lichess/draw', sessionToken, { gameId: gameId, accept: accept }, callback);
    }

    function pollEvents(sessionToken, callback) {
        request('GET', '/api/lichess/poll-events', sessionToken, null, callback);
    }

    /* Puzzles need no session - the server proxies these to Lichess's
     * public, unauthenticated puzzle endpoints (see api/lichess/_lichess.js
     * and [action].js). */
    function fetchDailyPuzzle(callback) {
        request('GET', '/api/lichess/puzzle-daily', null, null, callback);
    }

    function fetchNextPuzzle(callback) {
        request('GET', '/api/lichess/puzzle-next', null, null, callback);
    }

    function fetchMyGames(sessionToken, callback) {
        request('GET', '/api/lichess/my-games', sessionToken, null, callback);
    }

    /* Watch Games (TV) and Position Analysis are both public - no session
     * needed, same as the puzzle endpoints. */
    function fetchTvChannels(callback) {
        request('GET', '/api/lichess/tv-channels', null, null, callback);
    }

    function fetchWatchGame(gameId, callback) {
        request('GET', '/api/lichess/watch-game?gameId=' + encodeURIComponent(gameId), null, null, callback);
    }

    function fetchExplorer(fen, db, callback) {
        request('GET', '/api/lichess/explorer?fen=' + encodeURIComponent(fen) + '&db=' + encodeURIComponent(db || 'lichess'), null, null, callback);
    }

    function fetchTablebase(fen, callback) {
        request('GET', '/api/lichess/tablebase?fen=' + encodeURIComponent(fen), null, null, callback);
    }

    return {
        startLogin: startLogin,
        handleOAuthCallback: handleOAuthCallback,
        getStoredSession: getStoredSession,
        clearStoredSession: clearStoredSession,
        logout: logout,
        fetchMe: fetchMe,
        createChallenge: createChallenge,
        respondToChallenge: respondToChallenge,
        checkChallengeStatus: checkChallengeStatus,
        fetchGameState: fetchGameState,
        sendMove: sendMove,
        resign: resign,
        draw: draw,
        pollEvents: pollEvents,
        fetchDailyPuzzle: fetchDailyPuzzle,
        fetchNextPuzzle: fetchNextPuzzle,
        fetchMyGames: fetchMyGames,
        fetchTvChannels: fetchTvChannels,
        fetchWatchGame: fetchWatchGame,
        fetchExplorer: fetchExplorer,
        fetchTablebase: fetchTablebase
    };
})();
