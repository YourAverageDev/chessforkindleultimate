/* app.js - UI controller: screens, board rendering, input handling, game flow.
 * Plain ES5, DOM Level 1/2 APIs only (getElementById, createElement, plain
 * onclick handler assignment) - deliberately avoids anything that might be
 * missing on an old Kindle e-ink browser (no querySelector reliance, no
 * addEventListener requirement, no Promises).
 */

/* Piece artwork is a single sprite sheet (img/pieces.png): 6 columns
 * (k,q,b,n,r,p) x 2 rows (white,black), each cell square. Percentage-based
 * background-position/background-size means each square shows the right
 * piece regardless of the board's current rendered size - no JS resize
 * math needed, and it stays correct across the responsive breakpoints. */
var SPRITE_COL = { k: '0%', q: '20%', b: '40%', n: '60%', r: '80%', p: '100%' };
var SPRITE_ROW = { w: '0%', b: '100%' };

var DIFFICULTY_CONFIGS = {
    easy: { maxDepth: 1, timeLimit: 400, randomness: 0.35 },
    medium: { maxDepth: 2, timeLimit: 900, randomness: 0.08 },
    hard: { maxDepth: 4, timeLimit: 1800, randomness: 0 }
};

var currentState = null;
var currentLegalMoves = [];
var selectedSquare = null;
var pendingPromotionMoves = null;
var mode = null; /* '2p', 'ai', or 'online' */
var aiColor = 'b';
var currentLevel = 'medium';
var flipped = false;
var historyStack = [];
var positionCounts = {};
var lastMove = null;
var gameOver = false;

/* Online play state. onlineColor is which side this browser is playing;
 * onlineAppliedMoveCount tracks how many of the server's authoritative
 * moves have been applied locally, so polling only has to notice "the
 * count changed" rather than diff move lists. */
var onlineRoom = null;
var onlineToken = null;
var onlineColor = null;
var onlineAppliedMoveCount = 0;

function setText(el, str) {
    if (el.textContent !== undefined) { el.textContent = str; }
    else { el.innerText = str; }
}

function showScreen(name) {
    OnlineClient.stopPolling();
    document.getElementById('splash-screen').style.display = (name === 'splash') ? 'block' : 'none';
    document.getElementById('difficulty-screen').style.display = (name === 'difficulty') ? 'block' : 'none';
    document.getElementById('online-menu-screen').style.display = (name === 'online-menu') ? 'block' : 'none';
    document.getElementById('online-public-screen').style.display = (name === 'online-public') ? 'block' : 'none';
    document.getElementById('online-public-list-screen').style.display = (name === 'online-public-list') ? 'block' : 'none';
    document.getElementById('online-join-screen').style.display = (name === 'online-join') ? 'block' : 'none';
    document.getElementById('online-waiting-screen').style.display = (name === 'online-waiting') ? 'block' : 'none';
    document.getElementById('game-screen').style.display = (name === 'game') ? 'block' : 'none';
    hideOverlay('promo-overlay');
    hideOverlay('gameover-overlay');
}

function setMessage(id, msg) {
    setText(document.getElementById(id), msg || '');
}

function describeRequestError(err) {
    if (!err) { return 'Something went wrong. Please try again.'; }
    if (err.network) { return 'Network error — check your connection.'; }
    var code = err.data && err.data.error;
    if (code === 'room_not_found') { return 'Room not found.'; }
    if (code === 'room_full') { return 'That room already has two players.'; }
    if (err.data && err.data.message) { return err.data.message; }
    return 'Something went wrong. Please try again.';
}

function hideOverlay(id) {
    document.getElementById(id).style.display = 'none';
}

function boardIndexForVisual(row, col, isFlipped) {
    var rank, file;
    if (!isFlipped) { rank = 7 - row; file = col; }
    else { rank = row; file = 7 - col; }
    return rank * 8 + file;
}

function buildBoardTable() {
    var table = document.getElementById('board-table');
    table.innerHTML = '';
    for (var row = 0; row < 8; row++) {
        var tr = document.createElement('tr');
        for (var col = 0; col < 8; col++) {
            var idx = boardIndexForVisual(row, col, flipped);
            var file = idx % 8;
            var rank = (idx - file) / 8;
            var td = document.createElement('td');
            td.id = 'sqcell' + idx;
            td.className = ((file + rank) % 2 === 0) ? 'sq-dark' : 'sq-light';

            var a = document.createElement('a');
            a.href = 'javascript:void(0)';
            a.className = 'piece-link';
            a.id = 'sq' + idx;
            a.setAttribute('onclick', 'onSquareClick(' + idx + ')');
            td.appendChild(a);
            tr.appendChild(td);
        }
        table.appendChild(tr);
    }
    sizeBoard();
}

/* Sizes the board to fill the actual available screen space instead of a
 * fixed CSS pixel size. Old Kindle viewports vary a lot (and some ancient
 * WebKit builds don't scale a fixed-size layout up to fill the screen the
 * way a modern mobile browser would), so this measures the real viewport
 * and status-bar/controls heights each time and sets every square's size
 * directly, which is what actually makes the board look "full size"
 * rather than stuck at a small fixed default. */
function sizeBoard() {
    var vw = window.innerWidth || document.documentElement.clientWidth || 320;
    var vh = window.innerHeight || document.documentElement.clientHeight || 480;

    var statusBar = document.getElementById('status-bar');
    var controls = document.getElementById('controls');
    var statusH = (statusBar && statusBar.offsetHeight) || 30;
    var controlsH = (controls && controls.offsetHeight) || 60;
    var reserved = statusH + controlsH + 40; /* margins/padding breathing room */

    var availableW = vw - 12;
    var availableH = vh - reserved;
    var maxSquare = Math.floor(Math.min(availableW, availableH) / 8);
    if (maxSquare < 30) { maxSquare = 30; }
    if (maxSquare > 100) { maxSquare = 100; }

    for (var idx = 0; idx < 64; idx++) {
        var td = document.getElementById('sqcell' + idx);
        if (td) {
            td.style.width = maxSquare + 'px';
            td.style.height = maxSquare + 'px';
        }
    }
}

function updateBoardDisplay() {
    var checkedKingSquare = -1;
    if (ChessEngine.isKingInCheck(currentState, currentState.turn)) {
        checkedKingSquare = ChessEngine.findKing(currentState.board, currentState.turn);
    }

    var legalTargets = {};
    if (selectedSquare !== null) {
        for (var i = 0; i < currentLegalMoves.length; i++) {
            var mv = currentLegalMoves[i];
            if (mv.from === selectedSquare) {
                legalTargets[mv.to] = mv.captured ? 'capture' : 'move';
            }
        }
    }

    for (var idx = 0; idx < 64; idx++) {
        var td = document.getElementById('sqcell' + idx);
        var a = document.getElementById('sq' + idx);
        var file = idx % 8;
        var rank = (idx - file) / 8;
        var baseClass = ((file + rank) % 2 === 0) ? 'sq-dark' : 'sq-light';
        var extra = '';

        if (lastMove && (idx === lastMove.from || idx === lastMove.to)) { extra += ' sq-lastmove'; }
        if (legalTargets[idx] === 'move') { extra += ' sq-legal'; }
        if (legalTargets[idx] === 'capture') { extra += ' sq-legal-capture'; }
        if (idx === selectedSquare) { extra += ' sq-selected'; }
        if (idx === checkedKingSquare) { extra += ' sq-check'; }

        td.className = baseClass + extra;

        var piece = currentState.board[idx];
        if (piece) {
            a.style.backgroundImage = "url('/img/pieces.png')";
            a.style.backgroundPosition = SPRITE_COL[piece.type] + ' ' + SPRITE_ROW[piece.color];
        } else {
            a.style.backgroundImage = 'none';
        }
    }
}

function recomputeLegalMoves() {
    currentLegalMoves = ChessEngine.generateLegalMoves(currentState);
}

function recountPositions() {
    positionCounts = {};
    for (var i = 0; i < historyStack.length; i++) {
        var key = ChessEngine.positionKey(historyStack[i]);
        positionCounts[key] = (positionCounts[key] || 0) + 1;
    }
    var curKey = ChessEngine.positionKey(currentState);
    positionCounts[curKey] = (positionCounts[curKey] || 0) + 1;
}

function isThreefoldRepetition() {
    var key = ChessEngine.positionKey(currentState);
    return (positionCounts[key] || 0) >= 3;
}

function updateStatusText(status) {
    status = status || ChessEngine.getStatus(currentState, currentLegalMoves);
    var turnName = currentState.turn === 'w' ? 'White' : 'Black';
    var checkSuffix = (status === 'check') ? ' — Check!' : '';
    var text;
    if (mode === 'ai' && currentState.turn === aiColor && !gameOver) {
        text = 'Computer is thinking...';
    } else if (mode === 'online' && !gameOver) {
        text = (currentState.turn === onlineColor ? 'Your move' : "Waiting for opponent's move") + checkSuffix;
    } else if (status === 'check') {
        text = turnName + ' to move — Check!';
    } else {
        text = turnName + ' to move';
    }
    setText(document.getElementById('status-text'), text);
}

function showGameOver(message) {
    setText(document.getElementById('gameover-text'), message);
    document.getElementById('gameover-overlay').style.display = 'block';
}

function handleStatus(status) {
    updateStatusText(status);
    if (status === 'checkmate') {
        gameOver = true;
        showGameOver((currentState.turn === 'w' ? 'Black' : 'White') + ' wins by checkmate');
    } else if (status === 'stalemate') {
        gameOver = true;
        showGameOver('Draw by stalemate');
    } else if (status === 'draw-50move') {
        gameOver = true;
        showGameOver('Draw (50-move rule)');
    } else if (status === 'draw-material') {
        gameOver = true;
        showGameOver('Draw (insufficient material)');
    } else if (isThreefoldRepetition()) {
        gameOver = true;
        showGameOver('Draw by repetition');
    }
}

function commitMove(mv) {
    if (gameOver || !mv) { return; }
    historyStack.push(currentState);
    currentState = ChessEngine.makeMove(currentState, mv);
    lastMove = { from: mv.from, to: mv.to };
    selectedSquare = null;
    recomputeLegalMoves();
    recountPositions();
    updateBoardDisplay();
    var status = ChessEngine.getStatus(currentState, currentLegalMoves);
    handleStatus(status);
    if (!gameOver && mode === 'ai' && currentState.turn === aiColor) {
        scheduleAIMove();
    }
}

function scheduleAIMove() {
    updateStatusText();
    setTimeout(function () {
        if (gameOver) { return; }
        ChessAI.findBestMove(currentState, DIFFICULTY_CONFIGS[currentLevel], function (move) {
            if (gameOver) { return; }
            commitMove(move);
        });
    }, 180);
}

function selectSquare(idx) {
    selectedSquare = idx;
    updateBoardDisplay();
}

function clearSelection() {
    selectedSquare = null;
    updateBoardDisplay();
}

var PROMO_BUTTON_IDS = { q: 'promo-q', r: 'promo-r', b: 'promo-b', n: 'promo-n' };

function showPromotionPicker(matches) {
    pendingPromotionMoves = matches;
    var color = currentState.turn;
    for (var type in PROMO_BUTTON_IDS) {
        if (!PROMO_BUTTON_IDS.hasOwnProperty(type)) { continue; }
        var el = document.getElementById(PROMO_BUTTON_IDS[type]);
        el.style.backgroundImage = "url('/img/pieces.png')";
        el.style.backgroundPosition = SPRITE_COL[type] + ' ' + SPRITE_ROW[color];
    }
    document.getElementById('promo-overlay').style.display = 'block';
}

function pickPromotion(pieceType) {
    if (!pendingPromotionMoves) { return; }
    var chosen = null;
    for (var i = 0; i < pendingPromotionMoves.length; i++) {
        if (pendingPromotionMoves[i].promotion === pieceType) { chosen = pendingPromotionMoves[i]; break; }
    }
    pendingPromotionMoves = null;
    hideOverlay('promo-overlay');
    if (!chosen) { return; }
    if (mode === 'online') { commitOnlineMove(chosen); } else { commitMove(chosen); }
}

function onSquareClick(idx) {
    if (gameOver) { return; }
    if (mode === 'ai' && currentState.turn === aiColor) { return; }
    if (mode === 'online' && currentState.turn !== onlineColor) { return; }

    var piece = currentState.board[idx];

    if (selectedSquare !== null) {
        var matches = [];
        for (var i = 0; i < currentLegalMoves.length; i++) {
            var mv = currentLegalMoves[i];
            if (mv.from === selectedSquare && mv.to === idx) { matches.push(mv); }
        }
        if (matches.length === 1) {
            if (mode === 'online') { commitOnlineMove(matches[0]); } else { commitMove(matches[0]); }
            return;
        }
        if (matches.length > 1) { showPromotionPicker(matches); return; }

        if (piece && piece.color === currentState.turn) { selectSquare(idx); return; }
        clearSelection();
        return;
    }

    if (piece && piece.color === currentState.turn) { selectSquare(idx); }
}

function applyModeControlVisibility() {
    var isOnline = (mode === 'online');
    document.getElementById('btn-new').style.display = isOnline ? 'none' : 'inline-block';
    document.getElementById('btn-undo').style.display = isOnline ? 'none' : 'inline-block';
}

function startGame(selectedMode, level) {
    mode = selectedMode;
    if (mode === 'ai') {
        aiColor = 'b';
        currentLevel = level || 'medium';
    }
    currentState = ChessEngine.createInitialState();
    historyStack = [];
    lastMove = null;
    gameOver = false;
    selectedSquare = null;
    flipped = false;
    recomputeLegalMoves();
    recountPositions();
    buildBoardTable();
    updateBoardDisplay();
    updateStatusText();
    applyModeControlVisibility();
    showScreen('game');
}

/* ---- online play ---- */

function createOnlineGame(isPublic, errorTargetId) {
    var errorId = errorTargetId || 'online-menu-error';
    setMessage(errorId, '');
    OnlineClient.createRoom(isPublic, function (err, data) {
        if (err || !data) { setMessage(errorId, describeRequestError(err)); return; }
        onlineRoom = data.room;
        onlineToken = data.token;
        onlineColor = data.color;
        setText(document.getElementById('online-room-code'), onlineRoom);
        setMessage('online-waiting-error', '');
        showScreen('online-waiting');
        OnlineClient.startPolling(function (cb) { OnlineClient.fetchState(onlineRoom, cb); }, 1500, onOnlineWaitingUpdate);
    });
}

function onOnlineWaitingUpdate(err, data) {
    if (err) { setMessage('online-waiting-error', describeRequestError(err)); return; }
    setMessage('online-waiting-error', '');
    if (data && data.blackPresent) {
        OnlineClient.stopPolling();
        beginOnlineGame();
    }
}

function cancelOnlineWaitingRoom() {
    if (onlineRoom && onlineToken) {
        OnlineClient.cancelRoom(onlineRoom, onlineToken, function () {}); /* fire and forget */
    }
    showScreen('online-menu');
}

/* ---- public lobby ---- */

function openPublicLobbyList() {
    setMessage('online-public-list-error', '');
    showScreen('online-public-list');
    refreshPublicRoomList();
    OnlineClient.startPolling(function (cb) { OnlineClient.listPublicRooms(cb); }, 3000, onPublicListUpdate);
}

function refreshPublicRoomList() {
    OnlineClient.listPublicRooms(onPublicListUpdate);
}

function onPublicListUpdate(err, data) {
    if (err || !data) { setMessage('online-public-list-error', describeRequestError(err)); return; }
    setMessage('online-public-list-error', '');
    renderPublicRoomList(data.rooms || []);
}

function renderPublicRoomList(rooms) {
    var container = document.getElementById('public-room-list');
    var emptyMsg = document.getElementById('public-room-list-empty');
    container.innerHTML = '';

    if (rooms.length === 0) {
        emptyMsg.style.display = 'block';
        return;
    }
    emptyMsg.style.display = 'none';

    for (var i = 0; i < rooms.length; i++) {
        var room = rooms[i];
        var item = document.createElement('div');
        item.className = 'room-list-item';

        var codeEl = document.createElement('div');
        codeEl.className = 'room-list-code';
        setText(codeEl, room.room);
        item.appendChild(codeEl);

        var metaEl = document.createElement('div');
        metaEl.className = 'room-list-meta';
        var waitedSec = Math.max(0, Math.round((Date.now() - room.createdAt) / 1000));
        setText(metaEl, 'Waiting ' + waitedSec + 's');
        item.appendChild(metaEl);

        var joinBtn = document.createElement('a');
        joinBtn.href = 'javascript:void(0)';
        joinBtn.className = 'room-list-join-btn';
        setText(joinBtn, 'Join');
        joinBtn.setAttribute('onclick', 'joinPublicRoom(\'' + room.room + '\')');
        item.appendChild(joinBtn);

        container.appendChild(item);
    }
}

function joinPublicRoom(code) {
    OnlineClient.stopPolling();
    joinOnlineGame(code, 'online-public-list-error');
}

function joinOnlineGame(rawCode, errorTargetId) {
    var errorId = errorTargetId || 'online-join-error';
    setMessage(errorId, '');
    var code = (rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { setMessage(errorId, 'Enter a room code.'); return; }
    OnlineClient.joinRoom(code, function (err, data) {
        if (err || !data) { setMessage(errorId, describeRequestError(err)); return; }
        onlineRoom = data.room;
        onlineToken = data.token;
        onlineColor = data.color;
        beginOnlineGame();
    });
}

function beginOnlineGame() {
    mode = 'online';
    currentState = ChessEngine.createInitialState();
    historyStack = [];
    positionCounts = {};
    lastMove = null;
    gameOver = false;
    selectedSquare = null;
    onlineAppliedMoveCount = 0;
    flipped = (onlineColor === 'b');
    recomputeLegalMoves();
    recountPositions();
    buildBoardTable();
    updateBoardDisplay();
    updateStatusText();
    applyModeControlVisibility();
    showScreen('game');
    OnlineClient.startPolling(function (cb) { OnlineClient.fetchState(onlineRoom, cb); }, 1500, onOnlineGameUpdate);
}

/* Replays the server's authoritative move list from scratch and updates
 * all local UI state from it. Used both for normal polling updates (the
 * opponent moved) and to recover if our own optimistic move ever gets
 * rejected - either way, the server's move list wins. */
function applyServerState(data) {
    var state = ChessEngine.createInitialState();
    var newLastMove = null;
    var counts = {};

    function tally(s) {
        var key = ChessEngine.positionKey(s);
        counts[key] = (counts[key] || 0) + 1;
    }
    tally(state);

    for (var i = 0; i < data.moves.length; i++) {
        var mv = data.moves[i];
        var legal = ChessEngine.generateLegalMoves(state);
        var found = null;
        for (var j = 0; j < legal.length; j++) {
            if (legal[j].from === mv.from && legal[j].to === mv.to && legal[j].promotion === (mv.promotion || null)) {
                found = legal[j];
                break;
            }
        }
        if (!found) { break; }
        state = ChessEngine.makeMove(state, found);
        tally(state);
        newLastMove = { from: mv.from, to: mv.to };
    }

    currentState = state;
    lastMove = newLastMove;
    positionCounts = counts;
    onlineAppliedMoveCount = data.moves.length;
    selectedSquare = null;
    recomputeLegalMoves();
    updateBoardDisplay();

    var localStatus = ChessEngine.getStatus(currentState, currentLegalMoves);
    if (data.status === 'finished') {
        if (!gameOver) {
            gameOver = true;
            OnlineClient.stopPolling();
            showGameOver(onlineResultMessage(data.result));
        }
    } else if (isThreefoldRepetition() && !gameOver) {
        gameOver = true;
        OnlineClient.stopPolling();
        showGameOver('Draw by repetition');
    } else {
        updateStatusText(localStatus);
    }
}

function onlineResultMessage(result) {
    var messages = {
        white_wins_checkmate: 'White wins by checkmate',
        black_wins_checkmate: 'Black wins by checkmate',
        draw_stalemate: 'Draw by stalemate',
        draw_50move: 'Draw (50-move rule)',
        draw_material: 'Draw (insufficient material)'
    };
    return messages[result] || 'Game over';
}

function onOnlineGameUpdate(err, data) {
    if (err || !data) { return; } /* transient network hiccup - just retry next tick */
    if (data.moves.length !== onlineAppliedMoveCount || (data.status === 'finished' && !gameOver)) {
        applyServerState(data);
    }
}

function commitOnlineMove(mv) {
    commitMove(mv); /* optimistic local apply for instant feedback */
    var sent = { from: mv.from, to: mv.to, promotion: mv.promotion || null };
    OnlineClient.sendMove(onlineRoom, onlineToken, sent, function (err) {
        if (!err) { return; }
        /* Our optimistic move wasn't accepted (stale state, race, etc.) -
         * fall back to whatever the server says actually happened. */
        OnlineClient.fetchState(onlineRoom, function (err2, data2) {
            if (!err2 && data2) { applyServerState(data2); }
        });
    });
}

function undoMove() {
    if (mode === 'online') { return; }
    if (historyStack.length === 0) { return; }
    gameOver = false;
    hideOverlay('gameover-overlay');
    var popCount = (mode === 'ai') ? 2 : 1;
    while (popCount > 0 && historyStack.length > 0) {
        currentState = historyStack.pop();
        popCount--;
    }
    selectedSquare = null;
    lastMove = null;
    recomputeLegalMoves();
    recountPositions();
    updateBoardDisplay();
    updateStatusText();
}

function flipBoard() {
    flipped = !flipped;
    buildBoardTable();
    updateBoardDisplay();
}

function init() {
    document.getElementById('btn-2p').onclick = function () { startGame('2p', null); };
    document.getElementById('btn-vs-ai').onclick = function () { showScreen('difficulty'); };
    document.getElementById('btn-diff-back').onclick = function () { showScreen('splash'); };

    document.getElementById('btn-diff-easy').onclick = function () { startGame('ai', 'easy'); };
    document.getElementById('btn-diff-medium').onclick = function () { startGame('ai', 'medium'); };
    document.getElementById('btn-diff-hard').onclick = function () { startGame('ai', 'hard'); };

    document.getElementById('btn-new').onclick = function () { startGame(mode, currentLevel); };
    document.getElementById('btn-undo').onclick = function () { undoMove(); };
    document.getElementById('btn-flip').onclick = function () { flipBoard(); };
    document.getElementById('btn-menu').onclick = function () { showScreen('splash'); };

    document.getElementById('btn-gameover-new').onclick = function () {
        if (mode === 'online') { showScreen('online-menu'); } else { startGame(mode, currentLevel); }
    };
    document.getElementById('btn-gameover-menu').onclick = function () { showScreen('splash'); };

    document.getElementById('promo-q').onclick = function () { pickPromotion('q'); };
    document.getElementById('promo-r').onclick = function () { pickPromotion('r'); };
    document.getElementById('promo-b').onclick = function () { pickPromotion('b'); };
    document.getElementById('promo-n').onclick = function () { pickPromotion('n'); };

    document.getElementById('btn-online').onclick = function () { showScreen('online-menu'); };
    document.getElementById('btn-online-back').onclick = function () { showScreen('splash'); };
    document.getElementById('btn-online-create').onclick = function () { createOnlineGame(false); };
    document.getElementById('btn-online-join').onclick = function () {
        setMessage('online-join-error', '');
        document.getElementById('online-code-input').value = '';
        showScreen('online-join');
    };
    document.getElementById('btn-online-join-back').onclick = function () { showScreen('online-menu'); };
    document.getElementById('btn-online-join-submit').onclick = function () {
        joinOnlineGame(document.getElementById('online-code-input').value);
    };
    document.getElementById('btn-online-cancel').onclick = function () { cancelOnlineWaitingRoom(); };

    document.getElementById('btn-online-public').onclick = function () {
        setMessage('online-public-error', '');
        showScreen('online-public');
    };
    document.getElementById('btn-public-back').onclick = function () { showScreen('online-menu'); };
    document.getElementById('btn-public-create').onclick = function () { createOnlineGame(true, 'online-public-error'); };
    document.getElementById('btn-public-join').onclick = function () { openPublicLobbyList(); };
    document.getElementById('btn-public-list-back').onclick = function () { showScreen('online-public'); };
    document.getElementById('btn-public-refresh').onclick = function () { refreshPublicRoomList(); };

    window.onresize = function () {
        if (document.getElementById('game-screen').style.display !== 'none') { sizeBoard(); }
    };
    window.onorientationchange = window.onresize;

    /* Covers leaving the waiting screen by closing the tab, navigating
     * away, or reloading - not just clicking Cancel. Only the room's
     * creator (not yet joined by anyone) is cleaned up here; an active
     * game is left alone. */
    window.onbeforeunload = function () {
        if (onlineRoom && onlineToken && document.getElementById('online-waiting-screen').style.display !== 'none') {
            OnlineClient.cancelRoomBeacon(onlineRoom, onlineToken);
        }
    };

    showScreen('splash');
}

init();
