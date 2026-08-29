/* online.js - talks to the /api/* serverless routes for online play.
 * Uses plain XMLHttpRequest (not fetch) since fetch/Promise support is not
 * guaranteed on old Kindle browsers, while XHR has been available since
 * long before any Kindle browser existed.
 */
var OnlineClient = (function () {
    "use strict";

    var pollTimer = null;
    var pollToken = 0; /* invalidates in-flight requests from a previous startPolling/stopPolling */

    function request(method, url, body, callback) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) { return; }
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
            if (xhr.status >= 200 && xhr.status < 300 && data) {
                callback(null, data);
            } else {
                callback({ status: xhr.status, data: data }, null);
            }
        };
        xhr.onerror = function () {
            callback({ status: 0, data: null, network: true }, null);
        };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    function createRoom(callback) {
        request('POST', '/api/create-room', {}, callback);
    }

    function joinRoom(code, callback) {
        request('POST', '/api/join-room', { room: code }, callback);
    }

    function sendMove(code, token, move, callback) {
        request('POST', '/api/move', { room: code, token: token, from: move.from, to: move.to, promotion: move.promotion || null }, callback);
    }

    function fetchState(code, callback) {
        request('GET', '/api/state?room=' + encodeURIComponent(code), null, callback);
    }

    function startPolling(code, intervalMs, onUpdate) {
        stopPolling();
        var myToken = ++pollToken;
        var poll = function () {
            fetchState(code, function (err, data) {
                /* A request in flight when stopPolling() (or a fresh
                 * startPolling()) ran must not resurrect this loop or
                 * hand stale data to a callback that's since moved on -
                 * e.g. the waiting-room poll racing the switch into the
                 * actual game and reviving itself after the game's own
                 * polling has already started. */
                if (myToken !== pollToken) { return; }
                onUpdate(err, data);
                if (myToken !== pollToken) { return; }
                pollTimer = setTimeout(poll, intervalMs);
            });
        };
        pollTimer = setTimeout(poll, intervalMs);
    }

    function stopPolling() {
        pollToken++;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    return {
        createRoom: createRoom,
        joinRoom: joinRoom,
        sendMove: sendMove,
        fetchState: fetchState,
        startPolling: startPolling,
        stopPolling: stopPolling
    };
})();
