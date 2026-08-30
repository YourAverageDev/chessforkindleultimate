/* ultimateChess.js - client for "Ultimate Chess Matchmaking", the
 * "Find Match" random-opponent flow. It's a separate matchmaking system
 * from this app's own room-code play (js/online.js) and from the Lichess
 * integration (js/lichess.js) - no room code, no Lichess account, just an
 * automatic pairing with another waiting player - but it talks to the same
 * Vercel + Redis backend as everything else in this app (api/uc/*.js),
 * over the same plain HTTP long-polling.
 *
 * Plain XMLHttpRequest (not fetch), same as online.js and lichess.js, for
 * the same reason: guaranteed availability on old Kindle browsers that
 * predate reliable fetch/Promise support.
 */
var UltimateClient = (function () {
    "use strict";

    var LS_PLAYER_ID = 'uc_player_id';

    function storageGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function storageSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* no persistence available - a fresh id will just be minted next time */ }
    }

    /* A random per-browser id, not a real account - this whole system is
     * anonymous matchmaking, so "who you are" is just "whoever is holding
     * this token", generated once and remembered locally. It is NEVER
     * shown to the opponent (the server only ever tells each side its own
     * color, never the other side's id), so this is safe to keep simple. */
    function getPlayerId() {
        var id = storageGet(LS_PLAYER_ID);
        if (!id) {
            id = 'p' + Math.floor(Math.random() * 1e9).toString(36) + Date.now().toString(36);
            storageSet(LS_PLAYER_ID, id);
        }
        return id;
    }

    /* xhr.timeout ensures a hung connection always resolves the request
     * one way or another, instead of leaving the poll loop's callback
     * waiting forever (see the identical fix/comment in online.js and
     * lichess.js). `done` stops timeout/onerror/onreadystatechange from
     * racing each other into a double callback. */
    function request(method, path, body, callback) {
        var xhr = new XMLHttpRequest();
        var done = false;
        function finish(err, data) {
            if (done) { return; }
            done = true;
            callback(err, data);
        }
        xhr.open(method, path, true);
        xhr.timeout = 12000;
        if (body) { xhr.setRequestHeader('Content-Type', 'application/json'); }
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
            if (xhr.status >= 200 && xhr.status < 300 && data) { finish(null, data); }
            else { finish({ status: xhr.status, data: data }, null); }
        };
        xhr.onerror = function () { finish({ status: 0, data: null, network: true }, null); };
        xhr.ontimeout = function () { finish({ status: 0, data: null, network: true, timeout: true }, null); };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    function joinQueue(timeControlSec, incrementSec, callback) {
        request('POST', '/api/uc/queue/join', { playerId: getPlayerId(), timeControlSec: timeControlSec, incrementSec: incrementSec }, callback);
    }

    function pollQueue(ticketId, callback) {
        request('GET', '/api/uc/queue/status?ticketId=' + encodeURIComponent(ticketId), null, callback);
    }

    function cancelQueue(ticketId, callback) {
        request('POST', '/api/uc/queue/cancel', { ticketId: ticketId }, callback);
    }

    function fetchGameState(gameId, callback) {
        request('GET', '/api/uc/game/state?gameId=' + encodeURIComponent(gameId) + '&playerId=' + encodeURIComponent(getPlayerId()), null, callback);
    }

    function sendMove(gameId, from, to, promotion, callback) {
        request('POST', '/api/uc/game/move', { gameId: gameId, playerId: getPlayerId(), from: from, to: to, promotion: promotion || null }, callback);
    }

    function resign(gameId, callback) {
        request('POST', '/api/uc/game/resign', { gameId: gameId, playerId: getPlayerId() }, callback);
    }

    return {
        getPlayerId: getPlayerId,
        joinQueue: joinQueue,
        pollQueue: pollQueue,
        cancelQueue: cancelQueue,
        fetchGameState: fetchGameState,
        sendMove: sendMove,
        resign: resign
    };
})();
