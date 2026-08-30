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

/* Difficulty levels labeled with an approximate Elo rating, chess.com-style.
 * These aren't a precisely calibrated rating (this is a plain alpha-beta
 * searcher, not a neural-net engine tuned against real player data) - the
 * numbers are a familiar, easy-to-compare way to communicate the same
 * depth/time/randomness knobs the engine has always used. Randomness above
 * 0 occasionally has the "wrong" (non-best) move chosen so low levels are
 * genuinely beatable rather than just shallow-but-perfect. */
var DIFFICULTY_CONFIGS = {
    400: { maxDepth: 1, timeLimit: 300, randomness: 0.60 },
    800: { maxDepth: 1, timeLimit: 400, randomness: 0.35 },
    1200: { maxDepth: 2, timeLimit: 600, randomness: 0.18 },
    1600: { maxDepth: 2, timeLimit: 900, randomness: 0.06 },
    2000: { maxDepth: 3, timeLimit: 1200, randomness: 0.02 },
    2400: { maxDepth: 4, timeLimit: 1800, randomness: 0 }
};

var currentState = null;
var currentLegalMoves = [];
var selectedSquare = null;
var pendingPromotionMoves = null;
var mode = null; /* '2p', 'ai', or 'online' */
var aiColor = 'b';
var currentLevel = 1200;
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

/* Chess clock state (Public Server Play only). clockWhiteMs/clockBlackMs
 * are the snapshot each side had AS OF clockTurnStartedAt - the side whose
 * turn it is has theirs still ticking down locally between polls, via
 * clockTickTimer, so the display doesn't visibly freeze for 1.5s at a time. */
var onlineTimerEnabled = false;
var clockWhiteMs = 0;
var clockBlackMs = 0;
var clockTurnStartedAt = null;
var clockTickTimer = null;
var clockTimeoutFetchFired = false;

/* Lichess play state. lichessSession mirrors what's persisted in
 * localStorage by lichess.js (kept in a JS var too so we're not calling
 * into localStorage on every frame). lichessGameId/lichessColor are also
 * persisted (see LS_LICHESS_GAME below) specifically so a killed/reloaded
 * page can resume a game in progress - old Kindle hardware getting the tab
 * evicted under memory pressure is a real scenario, not a hypothetical. */
var LS_LICHESS_GAME = 'lc_active_game';
var lichessSession = null; /* { token, username, perfs } */
var lichessGameId = null;
var lichessColor = null;
var lichessPendingChallengeId = null;
var lichessSelectedColor = 'random';
var lichessSelectedRated = false;
var lichessMoveInFlight = false;
var lichessPollFailCount = 0;
var lichessIncomingChallenges = [];

/* Puzzle mode state. No Lichess login needed - the puzzle endpoints are
 * public. puzzleSolution is the full UCI move list Lichess returns
 * (alternating: opponent's setup move, then solver, opponent, solver...);
 * puzzleSolverIndex is which entry comes next. puzzleAutoPlaying blocks
 * board input while the opponent's scripted reply is being played out. */
var puzzleSolution = [];
var puzzleSolverIndex = 0;
var puzzleColor = 'w';
var puzzleAutoPlaying = false;
var puzzleRating = null;
var puzzleThemes = [];

/* Game Replay state (Lichess "My Games" and "Import PGN" both feed this).
 * replayStates[i] is the position after replayMoves[i-1]/replaySanTokens[i-1]
 * (replayStates[0] is the start position) - prev/next just changes
 * replayIndex and re-renders from the precomputed array, no incremental
 * move application needed. replayReturnScreen is which screen "Back to
 * List" should return to, since replay can be entered from more than one
 * place. */
var lichessMyGames = [];
var replayStates = [];
var replayMoves = [];
var replaySanTokens = [];
var replayIndex = 0;
var replayPgnText = '';
var replayReturnScreen = 'splash';

/* Watch Games (TV) state - re-polls a plain game export every tick rather
 * than holding a stream open (see api/lichess/[action].js's handleWatchGame
 * for why), consistent with this app's polling-only architecture. */
var watchGameId = null;

/* Kindle pairing state (this device's own pairing code, while displayed
 * and waiting to be linked from another device). */
var lichessPairingCode = null;

/* Find Match state. matchSelectedRated mirrors lichessSelectedRated's role
 * for the Challenge screen, but kept separate since the two screens can be
 * open independently and shouldn't share selection state. */
var lichessFindMatchTicketId = null;
var matchSelectedRated = false;

/* Find Match with Lichess Players state (real Lichess seek - see
 * api/lichess/_lichess.js's openBoundedSeek). seekSelectedRated mirrors
 * matchSelectedRated's role for the This-Site screen, kept separate for
 * the same reason. */
var lichessSeekId = null;
var seekSelectedRated = false;

function setText(el, str) {
    if (el.textContent !== undefined) { el.textContent = str; }
    else { el.innerText = str; }
}

var ALL_SCREENS = [
    'splash', 'local-rooms', 'difficulty',
    'online-menu', 'online-public', 'online-public-list', 'online-join', 'online-waiting',
    'lichess-login', 'lichess-menu', 'lichess-challenge', 'lichess-waiting', 'lichess-incoming',
    'puzzle-menu',
    'lichess-my-games', 'lichess-import-pgn', 'lichess-game-pgn',
    'tv-list', 'lichess-profile', 'lichess-analysis',
    'lichess-pairing', 'lichess-link-device', 'lichess-find-match', 'lichess-matching',
    'lichess-find-match-lichess', 'lichess-matching-lichess',
    'game'
];

function showScreen(name) {
    OnlineClient.stopPolling();
    stopClockTick();
    for (var i = 0; i < ALL_SCREENS.length; i++) {
        var screenName = ALL_SCREENS[i];
        document.getElementById(screenName + '-screen').style.display = (screenName === name) ? 'block' : 'none';
    }
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

            var onDark = (file + rank) % 2 === 0;
            var coordColorClass = onDark ? 'coord-on-dark' : 'coord-on-light';
            if (col === 0) {
                var rankLabel = document.createElement('span');
                rankLabel.className = 'coord-label ' + coordColorClass;
                setText(rankLabel, String(rank + 1));
                td.appendChild(rankLabel);
            }
            if (row === 7) {
                var fileLabel = document.createElement('span');
                fileLabel.className = 'coord-label coord-file ' + coordColorClass;
                setText(fileLabel, String.fromCharCode(97 + file));
                td.appendChild(fileLabel);
            }

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
    var clocks = document.getElementById('chess-clocks');
    var lichessClock = document.getElementById('lichess-clock');
    var banner = document.getElementById('reconnect-banner');
    var puzzleInfo = document.getElementById('puzzle-info');
    var statusH = (statusBar && statusBar.offsetHeight) || 30;
    var controlsH = (controls && controls.offsetHeight) || 60;
    var clocksH = (clocks && clocks.offsetHeight) || 0; /* 0 when hidden (display:none) */
    var lichessClockH = (lichessClock && lichessClock.offsetHeight) || 0;
    var bannerH = (banner && banner.offsetHeight) || 0;
    var puzzleInfoH = (puzzleInfo && puzzleInfo.offsetHeight) || 0;
    var reserved = statusH + controlsH + clocksH + lichessClockH + bannerH + puzzleInfoH + 40; /* margins/padding breathing room */

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
    } else if (mode === 'lichess' && !gameOver) {
        text = (currentState.turn === lichessColor ? 'Your move' : "Waiting for opponent's move") + checkSuffix;
    } else if (mode === 'puzzle' && !gameOver) {
        text = 'Find the best move for ' + turnName + checkSuffix;
    } else if (mode === 'replay') {
        text = 'Move ' + replayIndex + ' of ' + (replayStates.length - 1) + checkSuffix;
    } else if (mode === 'watch') {
        text = 'Watching live';
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
    if (mode === 'online') { commitOnlineMove(chosen); }
    else if (mode === 'lichess') { commitLichessMove(chosen); }
    else if (mode === 'puzzle') { commitPuzzleMove(chosen); }
    else { commitMove(chosen); }
}

function onSquareClick(idx) {
    if (gameOver) { return; }
    if (mode === 'replay' || mode === 'watch') { return; }
    if (mode === 'ai' && currentState.turn === aiColor) { return; }
    if (mode === 'online' && currentState.turn !== onlineColor) { return; }
    if (mode === 'lichess' && (currentState.turn !== lichessColor || lichessMoveInFlight)) { return; }
    if (mode === 'puzzle' && (currentState.turn !== puzzleColor || puzzleAutoPlaying)) { return; }

    var piece = currentState.board[idx];

    if (selectedSquare !== null) {
        var matches = [];
        for (var i = 0; i < currentLegalMoves.length; i++) {
            var mv = currentLegalMoves[i];
            if (mv.from === selectedSquare && mv.to === idx) { matches.push(mv); }
        }
        if (matches.length === 1) {
            if (mode === 'online') { commitOnlineMove(matches[0]); }
            else if (mode === 'lichess') { commitLichessMove(matches[0]); }
            else if (mode === 'puzzle') { commitPuzzleMove(matches[0]); }
            else { commitMove(matches[0]); }
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
    var isLichess = (mode === 'lichess');
    var isPuzzle = (mode === 'puzzle');
    var isReplay = (mode === 'replay');
    var isWatch = (mode === 'watch');
    document.getElementById('btn-new').style.display = (isOnline || isLichess || isPuzzle || isReplay || isWatch) ? 'none' : 'inline-block';
    document.getElementById('btn-undo').style.display = (isOnline || isLichess || isPuzzle || isReplay || isWatch) ? 'none' : 'inline-block';
    document.getElementById('btn-resign').style.display = isLichess ? 'inline-block' : 'none';
    document.getElementById('btn-draw').style.display = isLichess ? 'inline-block' : 'none';
    document.getElementById('replay-controls').style.display = isReplay ? 'block' : 'none';
    document.getElementById('btn-watch-stop').style.display = isWatch ? 'inline-block' : 'none';
}

function startGame(selectedMode, level) {
    mode = selectedMode;
    if (mode === 'ai') {
        aiColor = 'b';
        currentLevel = level || 1200;
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
    document.getElementById('lichess-clock').style.display = 'none';
    document.getElementById('puzzle-info').style.display = 'none';
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
    onlineTimerEnabled = false;
    clockTimeoutFetchFired = false;
    document.getElementById('lichess-clock').style.display = 'none';
    document.getElementById('puzzle-info').style.display = 'none';
    showScreen('game');
    startClockTick();
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

    applyTimerFields(data);

    var localStatus = ChessEngine.getStatus(currentState, currentLegalMoves);
    if (data.status === 'finished') {
        if (!gameOver) {
            gameOver = true;
            OnlineClient.stopPolling();
            stopClockTick();
            showGameOver(onlineResultMessage(data.result));
        }
    } else if (isThreefoldRepetition() && !gameOver) {
        gameOver = true;
        OnlineClient.stopPolling();
        stopClockTick();
        showGameOver('Draw by repetition');
    } else {
        updateStatusText(localStatus);
    }
}

function onlineResultMessage(result) {
    var messages = {
        white_wins_checkmate: 'White wins by checkmate',
        black_wins_checkmate: 'Black wins by checkmate',
        white_wins_timeout: 'White wins on time',
        black_wins_timeout: 'Black wins on time',
        draw_stalemate: 'Draw by stalemate',
        draw_50move: 'Draw (50-move rule)',
        draw_material: 'Draw (insufficient material)'
    };
    return messages[result] || 'Game over';
}

/* ---- chess clock (Public Server Play only) ---- */

/* Called from every poll response, not just ones where the move count
 * changed - the very first poll after a game starts has zero moves either
 * way, and that's exactly when the clock needs its initial values, so this
 * can't be folded into the "did anything change" check applyServerState
 * uses for the board/selection state. */
function applyTimerFields(data) {
    if (!data.timerEnabled) { return; }
    onlineTimerEnabled = true;
    clockWhiteMs = data.whiteTimeLeftMs;
    clockBlackMs = data.blackTimeLeftMs;
    clockTurnStartedAt = data.turnStartedAt;
    clockTimeoutFetchFired = false;
    updateClockDisplay();
}

function formatClock(ms) {
    if (ms < 0) { ms = 0; }
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function updateClockDisplay() {
    var box = document.getElementById('chess-clocks');
    if (!onlineTimerEnabled) { box.style.display = 'none'; return; }
    box.style.display = 'block';

    var whiteMs = clockWhiteMs;
    var blackMs = clockBlackMs;
    if (clockTurnStartedAt && !gameOver) {
        var elapsed = Date.now() - clockTurnStartedAt;
        if (currentState.turn === 'w') { whiteMs -= elapsed; } else { blackMs -= elapsed; }
    }
    if (whiteMs < 0) { whiteMs = 0; }
    if (blackMs < 0) { blackMs = 0; }

    setText(document.getElementById('clock-white'), formatClock(whiteMs));
    setText(document.getElementById('clock-black'), formatClock(blackMs));

    var whiteBox = document.getElementById('clock-white-box');
    var blackBox = document.getElementById('clock-black-box');
    whiteBox.className = 'clock-box' + (currentState.turn === 'w' && !gameOver ? ' clock-active' : '') + (whiteMs < 30000 ? ' clock-low' : '');
    blackBox.className = 'clock-box' + (currentState.turn === 'b' && !gameOver ? ' clock-active' : '') + (blackMs < 30000 ? ' clock-low' : '');

    /* Don't wait for the next 1.5s poll to notice a local countdown hit
     * zero - ask the server right away so both sides see the timeout
     * result as soon as possible. The server's reply is still what
     * actually ends the game (via applyServerState), this just triggers
     * that check sooner than the regular poll interval would. */
    var sideOnClockMs = (currentState.turn === 'w') ? whiteMs : blackMs;
    if (sideOnClockMs <= 0 && !gameOver && !clockTimeoutFetchFired) {
        clockTimeoutFetchFired = true;
        OnlineClient.fetchState(onlineRoom, function (err, data) {
            if (!err && data) { applyServerState(data); }
        });
    }
}

function startClockTick() {
    stopClockTick();
    clockTickTimer = setInterval(updateClockDisplay, 500);
}

function stopClockTick() {
    if (clockTickTimer) { clearInterval(clockTickTimer); clockTickTimer = null; }
}

function onOnlineGameUpdate(err, data) {
    if (err || !data) { return; } /* transient network hiccup - just retry next tick */
    applyTimerFields(data);
    if (data.moves.length !== onlineAppliedMoveCount || (data.status === 'finished' && !gameOver)) {
        applyServerState(data);
    }
}

function commitOnlineMove(mv) {
    var moverColor = currentState.turn; /* before commitMove flips it to the opponent */
    commitMove(mv); /* optimistic local apply for instant feedback */

    /* Mirror the server's own clock bookkeeping locally so the display
     * doesn't jump: without this, updateClockDisplay would compute the
     * new side-to-move's elapsed time from the *previous* turnStartedAt
     * (i.e. since the move-before-last), making their clock appear to
     * suddenly drop by however long the side who just moved was thinking. */
    if (onlineTimerEnabled && clockTurnStartedAt) {
        var elapsedByMover = Date.now() - clockTurnStartedAt;
        if (moverColor === 'w') { clockWhiteMs = Math.max(0, clockWhiteMs - elapsedByMover); }
        else { clockBlackMs = Math.max(0, clockBlackMs - elapsedByMover); }
        clockTurnStartedAt = Date.now();
    }
    updateClockDisplay();

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

/* ---- Lichess play ---- */

function lichessSessionToken() {
    return lichessSession ? lichessSession.token : null;
}

function loadLichessSessionFromStorage() {
    var stored = LichessClient.getStoredSession();
    lichessSession = stored;
    return stored;
}

function saveActiveLichessGame(gameId, color) {
    lichessGameId = gameId;
    lichessColor = color;
    try {
        if (gameId) { window.localStorage.setItem(LS_LICHESS_GAME, JSON.stringify({ gameId: gameId, color: color })); }
        else { window.localStorage.removeItem(LS_LICHESS_GAME); }
    } catch (e) { /* no persistence available - reconnection-after-reload just won't work on this browser */ }
}

function loadActiveLichessGameFromStorage() {
    try {
        var raw = window.localStorage.getItem(LS_LICHESS_GAME);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

function formatLichessError(err) {
    if (err && err.network) { return 'Network error — check your connection.'; }
    if (err && err.data && err.data.detail && err.data.detail.error) { return err.data.detail.error; }
    if (err && err.status === 401) { return 'Your Lichess login expired. Please log in again.'; }
    return 'Something went wrong. Please try again.';
}

function goToLichessHome() {
    if (!loadLichessSessionFromStorage()) {
        setMessage('lichess-login-error', '');
        showScreen('lichess-login');
        return;
    }
    showLichessMenu();
}

function loginWithLichess() {
    LichessClient.startLogin(); /* full-page redirect to lichess.org - never returns to this function */
}

function showLichessMenu() {
    setMessage('lichess-menu-error', '');
    setText(document.getElementById('lichess-me-text'), 'Logged in as ' + lichessSession.username + '…');
    showScreen('lichess-menu');

    LichessClient.fetchMe(lichessSessionToken(), function (err, data) {
        if (err || !data) {
            if (err && err.status === 401) {
                LichessClient.clearStoredSession();
                lichessSession = null;
                showScreen('lichess-login');
                setMessage('lichess-login-error', 'Your login expired. Please log in again.');
            }
            return;
        }
        var perfs = data.perfs || {};
        var bits = [];
        var order = ['bullet', 'blitz', 'rapid', 'classical'];
        for (var i = 0; i < order.length; i++) {
            var p = perfs[order[i]];
            if (p && typeof p.rating === 'number') { bits.push(order[i] + ' ' + p.rating); }
        }
        setText(document.getElementById('lichess-me-text'), 'Logged in as ' + data.username + (bits.length ? ' (' + bits.join(', ') + ')' : ''));
    });

    refreshLichessIncomingBadge();
}

function refreshLichessIncomingBadge() {
    LichessClient.pollEvents(lichessSessionToken(), function (err, data) {
        if (err || !data) { return; }
        lichessIncomingChallenges = data.challenges || [];
        var badge = document.getElementById('lichess-incoming-badge');
        setText(badge, lichessIncomingChallenges.length ? ' (' + lichessIncomingChallenges.length + ')' : '');
    });
}

function logoutOfLichess() {
    LichessClient.logout(function () {
        lichessSession = null;
        showScreen('splash');
    });
}

/* ---- challenge a player ---- */

function openLichessChallengeScreen() {
    setMessage('lichess-challenge-error', '');
    document.getElementById('lichess-username-input').value = '';
    lichessSelectedColor = 'random';
    lichessSelectedRated = false;
    updateChoiceButtons();
    showScreen('lichess-challenge');
}

function updateChoiceButtons() {
    var whiteBtn = document.getElementById('btn-color-white');
    var blackBtn = document.getElementById('btn-color-black');
    var randomBtn = document.getElementById('btn-color-random');
    whiteBtn.className = 'big-btn small-btn choice-btn' + (lichessSelectedColor === 'white' ? ' selected' : '');
    blackBtn.className = 'big-btn small-btn choice-btn' + (lichessSelectedColor === 'black' ? ' selected' : '');
    randomBtn.className = 'big-btn small-btn choice-btn' + (lichessSelectedColor === 'random' ? ' selected' : '');

    var casualBtn = document.getElementById('btn-rated-casual');
    var ratedBtn = document.getElementById('btn-rated-rated');
    casualBtn.className = 'big-btn small-btn choice-btn' + (!lichessSelectedRated ? ' selected' : '');
    ratedBtn.className = 'big-btn small-btn choice-btn' + (lichessSelectedRated ? ' selected' : '');
}

function sendLichessChallenge() {
    setMessage('lichess-challenge-error', '');
    var username = document.getElementById('lichess-username-input').value.replace(/^\s+|\s+$/g, '');
    if (!username) { setMessage('lichess-challenge-error', 'Enter a Lichess username.'); return; }

    var tc = document.getElementById('lichess-timecontrol-select').value.split(',');
    var clockLimitSec = parseInt(tc[0], 10);
    var clockIncrementSec = parseInt(tc[1], 10);

    LichessClient.createChallenge(lichessSessionToken(), {
        username: username,
        clockLimitSec: clockLimitSec,
        clockIncrementSec: clockIncrementSec,
        color: lichessSelectedColor,
        rated: lichessSelectedRated
    }, function (err, data) {
        if (err || !data) { setMessage('lichess-challenge-error', formatLichessError(err)); return; }
        lichessPendingChallengeId = data.challengeId;
        setText(document.getElementById('lichess-waiting-text'), 'Waiting for ' + username + ' to accept the challenge.');
        setMessage('lichess-waiting-error', '');
        showScreen('lichess-waiting');
        OnlineClient.startPolling(function (cb) {
            LichessClient.checkChallengeStatus(lichessSessionToken(), lichessPendingChallengeId, cb);
        }, 2000, onLichessChallengeStatusUpdate);
    });
}

function onLichessChallengeStatusUpdate(err, data) {
    if (err || !data) { setMessage('lichess-waiting-error', formatLichessError(err)); return; }
    setMessage('lichess-waiting-error', '');
    if (data.started) {
        OnlineClient.stopPolling();
        beginLichessGame(data.gameId, data.color);
    }
}

/* ---- incoming challenges ---- */

function openLichessIncomingScreen() {
    setMessage('lichess-incoming-error', '');
    showScreen('lichess-incoming');
    refreshLichessIncomingList();
}

function refreshLichessIncomingList() {
    LichessClient.pollEvents(lichessSessionToken(), function (err, data) {
        if (err || !data) { setMessage('lichess-incoming-error', formatLichessError(err)); return; }
        lichessIncomingChallenges = data.challenges || [];
        renderLichessIncomingList();
    });
}

function renderLichessIncomingList() {
    var container = document.getElementById('lichess-incoming-list');
    var emptyMsg = document.getElementById('lichess-incoming-empty');
    container.innerHTML = '';

    if (lichessIncomingChallenges.length === 0) {
        emptyMsg.style.display = 'block';
        return;
    }
    emptyMsg.style.display = 'none';

    for (var i = 0; i < lichessIncomingChallenges.length; i++) {
        var ch = lichessIncomingChallenges[i];
        var item = document.createElement('div');
        item.className = 'room-list-item';

        var nameEl = document.createElement('div');
        nameEl.className = 'room-list-code';
        setText(nameEl, ch.challengerName + (ch.challengerRating ? ' (' + ch.challengerRating + ')' : ''));
        item.appendChild(nameEl);

        var metaEl = document.createElement('div');
        metaEl.className = 'room-list-meta';
        var tcText = ch.timeControl && ch.timeControl.show ? ch.timeControl.show : 'Unknown time control';
        setText(metaEl, tcText + (ch.rated ? ' · Rated' : ' · Casual'));
        item.appendChild(metaEl);

        var acceptBtn = document.createElement('a');
        acceptBtn.href = 'javascript:void(0)';
        acceptBtn.className = 'room-list-join-btn';
        setText(acceptBtn, 'Accept');
        acceptBtn.setAttribute('onclick', 'respondToLichessChallenge(\'' + ch.id + '\',\'accept\')');
        item.appendChild(acceptBtn);

        var declineBtn = document.createElement('a');
        declineBtn.href = 'javascript:void(0)';
        declineBtn.className = 'text-link';
        setText(declineBtn, 'Decline');
        declineBtn.setAttribute('onclick', 'respondToLichessChallenge(\'' + ch.id + '\',\'decline\')');
        item.appendChild(declineBtn);

        container.appendChild(item);
    }
}

function respondToLichessChallenge(challengeId, action) {
    LichessClient.respondToChallenge(lichessSessionToken(), challengeId, action, function (err, data) {
        if (err || !data) { setMessage('lichess-incoming-error', formatLichessError(err)); return; }
        if (action === 'decline') { refreshLichessIncomingList(); return; }
        /* Accepted - the resulting game shares the challenge's id. We don't
         * know our assigned color from this response alone, so ask
         * game-state for it once the game is confirmed active. */
        LichessClient.fetchGameState(lichessSessionToken(), challengeId, function (err2, data2) {
            if (!err2 && data2 && data2.active) { beginLichessGame(challengeId, data2.color); }
            else { refreshLichessIncomingList(); }
        });
    });
}

/* ---- playing a Lichess game ---- */

function beginLichessGame(gameId, color) {
    mode = 'lichess';
    lichessMoveInFlight = false;
    lichessPollFailCount = 0;
    gameOver = false;
    selectedSquare = null;
    historyStack = [];
    saveActiveLichessGame(gameId, color);
    flipped = (color === 'b');
    currentState = ChessEngine.createInitialState();
    recomputeLegalMoves();
    buildBoardTable();
    updateBoardDisplay();
    updateStatusText();
    applyModeControlVisibility();
    document.getElementById('lichess-clock').style.display = 'block';
    document.getElementById('chess-clocks').style.display = 'none';
    document.getElementById('puzzle-info').style.display = 'none';
    setReconnecting(false);
    showScreen('game');
    OnlineClient.startPolling(function (cb) {
        LichessClient.fetchGameState(lichessSessionToken(), gameId, cb);
    }, 2000, onLichessGameUpdate);
}

function setReconnecting(isReconnecting) {
    document.getElementById('reconnect-banner').style.display = isReconnecting ? 'block' : 'none';
}

function lichessResultMessage(data) {
    var statusMap = {
        mate: 'Checkmate',
        resign: 'Resignation',
        stalemate: 'Stalemate',
        timeout: 'Timeout',
        outoftime: 'Time forfeit',
        draw: 'Draw',
        aborted: 'Game aborted',
        cheat: 'Ended (rules violation)',
        noStart: 'Opponent never started'
    };
    var reason = statusMap[data.status] || 'Game over';
    if (data.status === 'draw' || data.status === 'stalemate' || data.status === 'aborted') { return reason; }
    if (data.winner) {
        var winnerName = (data.winner === lichessColor) ? 'You' : 'Opponent';
        return winnerName + ' won — ' + reason;
    }
    return reason;
}

function onLichessGameUpdate(err, data) {
    /* A poll that was already in flight when we sent our own move can
     * land after commitLichessMove's optimistic local update but still
     * reflect the position from BEFORE Lichess processed that move -
     * applying it would visibly revert the just-made move for a moment
     * (reported as choppy/laggy play) until the next poll catches up.
     * Since commitLichessMove's own callback already re-syncs from
     * Lichess if the move is ever rejected, it's safe to just skip a
     * routine poll landing while a send is still in flight and let the
     * next one (after it resolves) apply the real, current position. */
    if (lichessMoveInFlight) { return; }

    if (err || !data) {
        lichessPollFailCount++;
        if (lichessPollFailCount >= 2) { setReconnecting(true); }
        return;
    }
    lichessPollFailCount = 0;
    setReconnecting(false);
    applyLichessState(data);
}

function applyLichessState(data) {
    if (data.active) {
        currentState = ChessEngine.stateFromFen(data.fen);
        lastMove = data.lastMove ? ChessEngine.uciToMove(data.lastMove) : null;
        selectedSquare = null;
        recomputeLegalMoves();
        updateBoardDisplay();
        updateLichessClockDisplay(data.secondsLeft, data.isMyTurn);
        updateStatusText();
        return;
    }

    /* Game finished (or was never found - treat as finished/unknown). */
    if (!gameOver) {
        gameOver = true;
        OnlineClient.stopPolling();
        saveActiveLichessGame(null, null);
        showGameOver(lichessResultMessage(data));
    }
}

function updateLichessClockDisplay(secondsLeft, isMyTurn) {
    var box = document.getElementById('lichess-clock');
    if (typeof secondsLeft !== 'number') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    var m = Math.floor(secondsLeft / 60);
    var s = secondsLeft % 60;
    var label = isMyTurn ? 'Your time: ' : "Opponent's time: ";
    setText(box, label + m + ':' + (s < 10 ? '0' : '') + s);
}

function commitLichessMove(mv) {
    if (lichessMoveInFlight) { return; } /* a move is already in flight - never send a second one on top of it */
    var uci = ChessEngine.moveToUci(mv);

    lichessMoveInFlight = true;
    currentState = ChessEngine.makeMove(currentState, mv);
    lastMove = { from: mv.from, to: mv.to };
    selectedSquare = null;
    recomputeLegalMoves();
    updateBoardDisplay();
    var localStatus = ChessEngine.getStatus(currentState, currentLegalMoves);
    updateStatusText(localStatus);

    LichessClient.sendMove(lichessSessionToken(), lichessGameId, uci, false, function (err) {
        lichessMoveInFlight = false;
        if (!err) { return; }
        /* Rejected (stale state, race, expired session, etc.) - Lichess is
         * authoritative here, so pull its real state rather than trust our
         * optimistic guess any further. */
        LichessClient.fetchGameState(lichessSessionToken(), lichessGameId, function (err2, data2) {
            if (!err2 && data2) { applyLichessState(data2); }
        });
    });
}

function resignLichessGame() {
    if (mode !== 'lichess' || !lichessGameId) { return; }
    LichessClient.resign(lichessSessionToken(), lichessGameId, function () { /* result arrives via the next poll */ });
}

function offerOrAcceptLichessDraw() {
    if (mode !== 'lichess' || !lichessGameId) { return; }
    LichessClient.draw(lichessSessionToken(), lichessGameId, true, function () { /* result/offer state arrives via the next poll */ });
}

/* On startup, if a Lichess game was left active (tab killed, reload, the
 * device itself losing power - all real scenarios on old Kindle hardware),
 * try to resume it before showing the splash screen. */
function tryResumeLichessGame() {
    if (!loadLichessSessionFromStorage()) { return false; }
    var saved = loadActiveLichessGameFromStorage();
    if (!saved || !saved.gameId) { return false; }
    LichessClient.fetchGameState(lichessSessionToken(), saved.gameId, function (err, data) {
        if (err || !data) { showScreen('splash'); return; }
        if (data.active) { beginLichessGame(saved.gameId, saved.color); }
        else { saveActiveLichessGame(null, null); showScreen('splash'); }
    });
    return true;
}

/* ---- puzzles ---- */

function openPuzzleMenu() {
    setMessage('puzzle-menu-error', '');
    showScreen('puzzle-menu');
}

function formatPuzzleError(err) {
    if (err && err.network) { return 'Network error — check your connection.'; }
    return 'Could not load a puzzle right now. Please try again.';
}

function requestDailyPuzzle() {
    setMessage('puzzle-menu-error', '');
    LichessClient.fetchDailyPuzzle(onPuzzleDataLoaded);
}

function requestNextPuzzle() {
    setMessage('puzzle-menu-error', '');
    LichessClient.fetchNextPuzzle(onPuzzleDataLoaded);
}

function onPuzzleDataLoaded(err, data) {
    if (err || !data || !data.solution || !data.solution.length) {
        setMessage('puzzle-menu-error', formatPuzzleError(err));
        return;
    }
    startPuzzleFromData(data);
}

/* Lichess's puzzle "solution" list is documented (for the puzzle CSV
 * export, which this app's author could confirm without live API access -
 * the live JSON endpoints could not be checked) as starting with the
 * opponent's own "setup" move, i.e. `initialPly` replays to the position
 * BEFORE that move, not the position the solver actually sees. This tries
 * that convention first and falls back to treating the replayed position
 * as the puzzle's start (solution[0] being the solver's own first move)
 * if solution[0] doesn't turn out to be a legal move there - covers either
 * convention without needing to guess correctly up front. */
function startPuzzleFromData(data) {
    var replayState = ChessEngine.replayPgnToPly(data.pgn, data.initialPly);
    if (!replayState) {
        setMessage('puzzle-menu-error', 'Could not read that puzzle. Please try another.');
        return;
    }

    var solution = data.solution;
    var puzzleState = replayState;
    var solverIndex = 0;

    if (solution.length) {
        var legalAtReplay = ChessEngine.generateLegalMoves(replayState);
        var setupMove = ChessEngine.findMoveByUci(legalAtReplay, solution[0]);
        if (setupMove) {
            puzzleState = ChessEngine.makeMove(replayState, setupMove);
            solverIndex = 1;
        }
    }

    if (solverIndex >= solution.length) {
        setMessage('puzzle-menu-error', 'Could not read that puzzle. Please try another.');
        return;
    }

    mode = 'puzzle';
    puzzleSolution = solution;
    puzzleSolverIndex = solverIndex;
    puzzleColor = puzzleState.turn;
    puzzleAutoPlaying = false;
    puzzleRating = data.rating;
    puzzleThemes = data.themes || [];
    currentState = puzzleState;
    historyStack = [];
    lastMove = null;
    gameOver = false;
    selectedSquare = null;
    flipped = (puzzleColor === 'b');
    recomputeLegalMoves();
    buildBoardTable();
    updateBoardDisplay();
    updateStatusText();
    applyModeControlVisibility();
    document.getElementById('lichess-clock').style.display = 'none';
    document.getElementById('chess-clocks').style.display = 'none';

    var infoBox = document.getElementById('puzzle-info');
    var infoText = puzzleRating ? ('Puzzle rating: ' + puzzleRating) : 'Puzzle';
    if (puzzleThemes.length) { infoText += '  ·  ' + puzzleThemes.slice(0, 3).join(', '); }
    setText(infoBox, infoText);
    infoBox.style.display = 'block';

    showScreen('game');
    sizeBoard();
}

function commitPuzzleMove(mv) {
    if (gameOver || puzzleAutoPlaying) { return; }
    var uci = ChessEngine.moveToUci(mv);
    var expected = puzzleSolution[puzzleSolverIndex];

    if (uci !== expected) {
        selectedSquare = null;
        updateBoardDisplay();
        setText(document.getElementById('status-text'), 'Not quite — try again.');
        return;
    }

    currentState = ChessEngine.makeMove(currentState, mv);
    lastMove = { from: mv.from, to: mv.to };
    selectedSquare = null;
    recomputeLegalMoves();
    updateBoardDisplay();
    puzzleSolverIndex++;

    if (puzzleSolverIndex >= puzzleSolution.length) {
        gameOver = true;
        showGameOver('Puzzle solved!');
        return;
    }

    setText(document.getElementById('status-text'), 'Correct!');
    puzzleAutoPlaying = true;
    setTimeout(playPuzzleOpponentReply, 500);
}

function playPuzzleOpponentReply() {
    var replyUci = puzzleSolution[puzzleSolverIndex];
    var legalNow = ChessEngine.generateLegalMoves(currentState);
    var replyMove = ChessEngine.findMoveByUci(legalNow, replyUci);
    puzzleAutoPlaying = false;

    if (!replyMove) {
        /* The reconstructed position and Lichess's own no longer agree -
         * likely the PGN-replay/SAN-parsing assumptions above didn't hold
         * for this particular puzzle. Rather than get stuck, end the
         * puzzle attempt cleanly so the player can just grab another one. */
        gameOver = true;
        showGameOver("Couldn't continue this puzzle — please try another.");
        return;
    }

    currentState = ChessEngine.makeMove(currentState, replyMove);
    lastMove = { from: replyMove.from, to: replyMove.to };
    recomputeLegalMoves();
    updateBoardDisplay();
    puzzleSolverIndex++;

    if (puzzleSolverIndex >= puzzleSolution.length) {
        gameOver = true;
        showGameOver('Puzzle solved!');
    } else {
        updateStatusText();
    }
}

/* ---- my games / game replay / PGN ---- */

function openLichessMyGames() {
    setMessage('lichess-my-games-error', '');
    document.getElementById('lichess-my-games-list').innerHTML = '';
    document.getElementById('lichess-my-games-empty').style.display = 'none';
    showScreen('lichess-my-games');
    LichessClient.fetchMyGames(lichessSessionToken(), function (err, data) {
        if (err || !data) { setMessage('lichess-my-games-error', formatLichessError(err)); return; }
        lichessMyGames = data.games || [];
        renderMyGamesList();
    });
}

function resultLabel(g) {
    if (g.result === 'win') { return 'Won'; }
    if (g.result === 'loss') { return 'Lost'; }
    if (g.result === 'draw') { return 'Draw'; }
    if (g.result === 'ongoing') { return 'Ongoing'; }
    return 'Game';
}

function renderMyGamesList() {
    var container = document.getElementById('lichess-my-games-list');
    var emptyMsg = document.getElementById('lichess-my-games-empty');
    container.innerHTML = '';

    if (lichessMyGames.length === 0) {
        emptyMsg.style.display = 'block';
        return;
    }
    emptyMsg.style.display = 'none';

    for (var i = 0; i < lichessMyGames.length; i++) {
        var g = lichessMyGames[i];
        var oppName, oppRating;
        if (g.myColor === 'w') { oppName = g.black.name; oppRating = g.black.rating; }
        else if (g.myColor === 'b') { oppName = g.white.name; oppRating = g.white.rating; }
        else { oppName = g.white.name + ' vs ' + g.black.name; oppRating = null; }

        var item = document.createElement('div');
        item.className = 'room-list-item';

        var nameEl = document.createElement('div');
        nameEl.className = 'room-list-code';
        setText(nameEl, 'vs ' + oppName + (oppRating ? ' (' + oppRating + ')' : ''));
        item.appendChild(nameEl);

        var metaEl = document.createElement('div');
        metaEl.className = 'room-list-meta';
        var metaBits = [resultLabel(g)];
        if (g.speed) { metaBits.push(g.speed); }
        metaBits.push(g.rated ? 'Rated' : 'Casual');
        if (g.opening && g.opening.name) { metaBits.push(g.opening.name); }
        setText(metaEl, metaBits.join(' · '));
        item.appendChild(metaEl);

        var replayBtn = document.createElement('a');
        replayBtn.href = 'javascript:void(0)';
        replayBtn.className = 'room-list-join-btn';
        setText(replayBtn, 'Replay');
        replayBtn.setAttribute('onclick', 'openGameReplayFromLichess(\'' + g.id + '\')');
        item.appendChild(replayBtn);

        container.appendChild(item);
    }
}

function openGameReplayFromLichess(gameId) {
    var g = null;
    for (var i = 0; i < lichessMyGames.length; i++) {
        if (lichessMyGames[i].id === gameId) { g = lichessMyGames[i]; break; }
    }
    if (!g) { return; }

    var replay = ChessEngine.replayFullGame(g.moves || '');
    if (!replay) {
        setMessage('lichess-my-games-error', "Could not read that game's moves.");
        return;
    }
    startReplay(replay.states, replay.moves, replay.sanTokens, g.pgn, 'lichess-my-games');
}

function openImportPgnScreen() {
    setMessage('lichess-import-error', '');
    document.getElementById('import-pgn-input').value = '';
    showScreen('lichess-import-pgn');
}

function loadImportedPgn() {
    setMessage('lichess-import-error', '');
    var text = document.getElementById('import-pgn-input').value;
    if (!text || !text.replace(/^\s+|\s+$/g, '')) {
        setMessage('lichess-import-error', 'Paste a PGN first.');
        return;
    }
    var replay = ChessEngine.replayFullGame(text);
    if (!replay || replay.states.length < 2) {
        setMessage('lichess-import-error', "Couldn't read that PGN — check the format and try again.");
        return;
    }
    startReplay(replay.states, replay.moves, replay.sanTokens, text, 'lichess-import-pgn');
}

/* Reused for both "My Games" (moves come pre-resolved from Lichess) and
 * "Import PGN" (moves come from whatever the user pasted) - either way,
 * by this point it's just a precomputed list of positions to step through,
 * read-only. */
function startReplay(states, moves, sanTokens, pgnText, returnScreen) {
    mode = 'replay';
    replayStates = states;
    replayMoves = moves;
    replaySanTokens = sanTokens || [];
    replayPgnText = pgnText || '';
    replayIndex = 0;
    replayReturnScreen = returnScreen || 'splash';
    gameOver = false;
    selectedSquare = null;
    flipped = false;
    buildBoardTable();
    showReplayPosition();
    applyModeControlVisibility();
    document.getElementById('lichess-clock').style.display = 'none';
    document.getElementById('chess-clocks').style.display = 'none';
    document.getElementById('puzzle-info').style.display = 'none';
    showScreen('game');
}

function showReplayPosition() {
    currentState = replayStates[replayIndex];
    lastMove = (replayIndex > 0) ? { from: replayMoves[replayIndex - 1].from, to: replayMoves[replayIndex - 1].to } : null;
    selectedSquare = null;
    recomputeLegalMoves();
    updateBoardDisplay();
    updateStatusText();
}

function replayGoto(index) {
    if (index < 0 || index >= replayStates.length) { return; }
    replayIndex = index;
    showReplayPosition();
}

function replayFirst() { replayGoto(0); }
function replayPrev() { replayGoto(replayIndex - 1); }
function replayNext() { replayGoto(replayIndex + 1); }
function replayLast() { replayGoto(replayStates.length - 1); }

/* Fallback for when a game has no ready-made PGN text (e.g. a Lichess
 * "My Games" entry where the `pgn` field wasn't available) - builds a
 * plain, numbered movetext string from the SAN tokens already used to
 * replay it. */
function reconstructPgnFromSan(sanTokens) {
    var parts = [];
    for (var i = 0; i < sanTokens.length; i++) {
        if (i % 2 === 0) { parts.push((Math.floor(i / 2) + 1) + '.'); }
        parts.push(sanTokens[i]);
    }
    return parts.join(' ');
}

function openPgnViewScreen() {
    var text = (replayPgnText && replayPgnText.length) ? replayPgnText : reconstructPgnFromSan(replaySanTokens);
    document.getElementById('pgn-text-display').value = text;
    setMessage('pgn-copy-status', '');
    showScreen('lichess-game-pgn');
}

/* execCommand('copy') is old and near-universally supported (including on
 * ancient WebKit), but not guaranteed - .select() at least highlights the
 * text either way, so the fallback message ("copy manually") is always
 * actionable even where the automatic copy doesn't work. */
function copyPgnText() {
    var ta = document.getElementById('pgn-text-display');
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    setMessage('pgn-copy-status', ok ? 'Copied!' : 'Text selected — copy it manually.');
}

/* ---- watch games (TV) ---- */

function openTvChannelsScreen() {
    setMessage('tv-list-error', '');
    document.getElementById('tv-channel-list').innerHTML = '';
    document.getElementById('tv-list-empty').style.display = 'none';
    showScreen('tv-list');
    LichessClient.fetchTvChannels(function (err, data) {
        if (err || !data) { setMessage('tv-list-error', formatLichessError(err)); return; }
        renderTvChannelList(data.channels || []);
    });
}

var tvChannelsCache = [];

function renderTvChannelList(channels) {
    tvChannelsCache = channels;
    var container = document.getElementById('tv-channel-list');
    var emptyMsg = document.getElementById('tv-list-empty');
    container.innerHTML = '';

    if (channels.length === 0) {
        emptyMsg.style.display = 'block';
        return;
    }
    emptyMsg.style.display = 'none';

    for (var i = 0; i < channels.length; i++) {
        var c = channels[i];
        var item = document.createElement('div');
        item.className = 'room-list-item';

        var nameEl = document.createElement('div');
        nameEl.className = 'room-list-code';
        setText(nameEl, c.channel);
        item.appendChild(nameEl);

        var metaEl = document.createElement('div');
        metaEl.className = 'room-list-meta';
        setText(metaEl, c.name + (c.rating ? ' (' + c.rating + ')' : ''));
        item.appendChild(metaEl);

        var watchBtn = document.createElement('a');
        watchBtn.href = 'javascript:void(0)';
        watchBtn.className = 'room-list-join-btn';
        setText(watchBtn, 'Watch');
        watchBtn.setAttribute('onclick', 'beginWatchGame(\'' + c.gameId + '\')');
        item.appendChild(watchBtn);

        container.appendChild(item);
    }
}

function beginWatchGame(gameId) {
    mode = 'watch';
    watchGameId = gameId;
    gameOver = false;
    selectedSquare = null;
    flipped = false;
    lastMove = null;
    currentState = ChessEngine.createInitialState();
    recomputeLegalMoves();
    buildBoardTable();
    updateBoardDisplay();
    applyModeControlVisibility();
    document.getElementById('lichess-clock').style.display = 'none';
    document.getElementById('chess-clocks').style.display = 'none';
    var infoBox = document.getElementById('puzzle-info');
    setText(infoBox, 'Loading game…');
    infoBox.style.display = 'block';
    setText(document.getElementById('status-text'), 'Watching live');
    showScreen('game');
    sizeBoard();
    OnlineClient.startPolling(function (cb) { LichessClient.fetchWatchGame(watchGameId, cb); }, 3000, onWatchGameUpdate);
}

function onWatchGameUpdate(err, data) {
    if (err || !data) { return; } /* transient poll failure - just wait for the next tick */

    var replay = ChessEngine.replayFullGame(data.moves || '');
    if (replay) {
        currentState = replay.states[replay.states.length - 1];
        var lastMv = replay.moves.length ? replay.moves[replay.moves.length - 1] : null;
        lastMove = lastMv ? { from: lastMv.from, to: lastMv.to } : null;
        selectedSquare = null;
        recomputeLegalMoves();
        updateBoardDisplay();
    }

    var whiteText = (data.white ? data.white.name : '?') + (data.white && data.white.rating ? ' (' + data.white.rating + ')' : '');
    var blackText = (data.black ? data.black.name : '?') + (data.black && data.black.rating ? ' (' + data.black.rating + ')' : '');
    setText(document.getElementById('puzzle-info'), whiteText + ' vs ' + blackText);

    if (data.status && data.status !== 'started' && data.status !== 'created') {
        if (!gameOver) {
            gameOver = true;
            OnlineClient.stopPolling();
            showGameOver('This game has ended.');
        }
        return;
    }

    setText(document.getElementById('status-text'), 'Watching live — ' + (currentState.turn === 'w' ? 'White' : 'Black') + ' to move');
}

function stopWatchingGame() {
    OnlineClient.stopPolling();
    watchGameId = null;
    showScreen('tv-list');
}

/* ---- profile ---- */

var PERF_LABELS = {
    bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical',
    correspondence: 'Correspondence', chess960: 'Chess960', kingOfTheHill: 'King of the Hill',
    threeCheck: 'Three-check', antichess: 'Antichess', atomic: 'Atomic', horde: 'Horde',
    racingKings: 'Racing Kings', crazyhouse: 'Crazyhouse', puzzle: 'Puzzles'
};

function openLichessProfile() {
    setMessage('lichess-profile-error', '');
    document.getElementById('lichess-profile-content').innerHTML = '';
    showScreen('lichess-profile');
    LichessClient.fetchMe(lichessSessionToken(), function (err, data) {
        if (err || !data) { setMessage('lichess-profile-error', formatLichessError(err)); return; }
        renderLichessProfile(data);
    });
}

function renderLichessProfile(data) {
    var container = document.getElementById('lichess-profile-content');
    container.innerHTML = '';

    var nameEl = document.createElement('h2');
    setText(nameEl, data.username);
    container.appendChild(nameEl);

    if (data.count) {
        var countEl = document.createElement('p');
        countEl.className = 'hint';
        setText(countEl, data.count.all + ' games played · ' + data.count.win + 'W / ' + data.count.loss + 'L / ' + data.count.draw + 'D');
        container.appendChild(countEl);
    }

    var perfs = data.perfs || {};
    for (var key in PERF_LABELS) {
        if (!PERF_LABELS.hasOwnProperty(key)) { continue; }
        var p = perfs[key];
        if (!p || typeof p.rating !== 'number') { continue; }

        var row = document.createElement('div');
        row.className = 'room-list-item';

        var label = document.createElement('div');
        label.className = 'room-list-code';
        setText(label, PERF_LABELS[key] + ': ' + p.rating + (p.prov ? '?' : ''));
        row.appendChild(label);

        var meta = document.createElement('div');
        meta.className = 'room-list-meta';
        setText(meta, (p.games || 0) + ' games played');
        row.appendChild(meta);

        container.appendChild(row);
    }
}

/* ---- position analysis (opening explorer / tablebase) ---- */

function openAnalysisScreen() {
    var fen = ChessEngine.stateToFen(currentState);
    setMessage('lichess-analysis-error', '');
    document.getElementById('analysis-content').innerHTML = 'Loading…';
    showScreen('lichess-analysis');
    LichessClient.fetchExplorer(fen, 'lichess', function (err, data) {
        renderAnalysis(err, data, fen);
    });
}

function renderAnalysis(err, data, fen) {
    var container = document.getElementById('analysis-content');
    container.innerHTML = '';

    if (err || !data) {
        setMessage('lichess-analysis-error', formatLichessError(err));
        return;
    }

    var total = (data.white || 0) + (data.draws || 0) + (data.black || 0);
    var summary = document.createElement('p');
    summary.className = 'hint';
    if (total > 0) {
        var wp = Math.round((data.white / total) * 100);
        var dp = Math.round((data.draws / total) * 100);
        var bp = 100 - wp - dp;
        setText(summary, total + ' database games — White ' + wp + '% / Draw ' + dp + '% / Black ' + bp + '%');
    } else {
        setText(summary, 'No database games found for this exact position.');
    }
    container.appendChild(summary);

    var moves = data.moves || [];
    for (var i = 0; i < moves.length && i < 10; i++) {
        var m = moves[i];
        var mTotal = (m.white || 0) + (m.draws || 0) + (m.black || 0);
        var row = document.createElement('div');
        row.className = 'room-list-item';

        var label = document.createElement('div');
        label.className = 'room-list-code';
        setText(label, m.san);
        row.appendChild(label);

        var meta = document.createElement('div');
        meta.className = 'room-list-meta';
        var pct = mTotal > 0 ? (' · W ' + Math.round(m.white / mTotal * 100) + '% D ' + Math.round(m.draws / mTotal * 100) + '% B ' + Math.round(m.black / mTotal * 100) + '%') : '';
        setText(meta, mTotal + ' games' + pct);
        row.appendChild(meta);

        container.appendChild(row);
    }

    LichessClient.fetchTablebase(fen, function (err2, tbData) {
        if (err2 || !tbData || !tbData.available) { return; }

        var tbHeader = document.createElement('h3');
        setText(tbHeader, 'Tablebase (perfect play)');
        container.appendChild(tbHeader);

        var catText = document.createElement('p');
        catText.className = 'hint';
        setText(catText, 'Result: ' + (tbData.category || 'unknown') + (typeof tbData.dtz === 'number' ? ' (DTZ ' + tbData.dtz + ')' : ''));
        container.appendChild(catText);

        var tbMoves = tbData.moves || [];
        for (var j = 0; j < tbMoves.length; j++) {
            var tm = tbMoves[j];
            var trow = document.createElement('div');
            trow.className = 'room-list-item';
            var tlabel = document.createElement('div');
            tlabel.className = 'room-list-code';
            setText(tlabel, tm.san + ' — ' + (tm.category || '?'));
            trow.appendChild(tlabel);
            container.appendChild(trow);
        }
    });
}

/* ---- Kindle pairing ---- */

/* Reached from the "Pair via Code" button on the login screen - for a
 * device (like an old Kindle) that can't do the OAuth redirect. This
 * screen never contacts lichess.org itself; it only ever talks to our own
 * origin (pairing-create/pairing-status), same as everything else this
 * app does on a Kindle. */
function openLichessPairingScreen() {
    setMessage('pairing-error', '');
    setText(document.getElementById('pairing-code-display'), '------');
    showScreen('lichess-pairing');
    LichessClient.pairingCreate(function (err, data) {
        if (err || !data) { setMessage('pairing-error', 'Could not start pairing. Please try again.'); return; }
        lichessPairingCode = data.code;
        setText(document.getElementById('pairing-code-display'), data.code);
        OnlineClient.startPolling(function (cb) {
            LichessClient.pairingStatus(lichessPairingCode, cb);
        }, 3000, onPairingPollUpdate);
    });
}

function onPairingPollUpdate(err, data) {
    if (err || !data || !data.found) { return; } /* a transient poll hiccup here shouldn't show an error - just wait for the next tick */
    if (data.linked && data.sessionToken) {
        OnlineClient.stopPolling();
        LichessClient.adoptSession(data.sessionToken, data.username);
        lichessSession = LichessClient.getStoredSession();
        showLichessMenu();
    }
}

function cancelPairing() {
    OnlineClient.stopPolling();
    lichessPairingCode = null;
    showScreen('lichess-login');
}

/* Reached from "Link Another Device" on the Lichess menu - run on the
 * device that's ALREADY logged in (phone/PC), to hand its session to a
 * Kindle showing a pairing code. */
function openLinkDeviceScreen() {
    setMessage('link-device-error', '');
    document.getElementById('link-device-code-input').value = '';
    showScreen('lichess-link-device');
}

function submitLinkDevice() {
    setMessage('link-device-error', '');
    var code = document.getElementById('link-device-code-input').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { setMessage('link-device-error', 'Enter the code shown on the other device.'); return; }
    LichessClient.pairingLink(lichessSessionToken(), code, function (err, data) {
        if (err || !data) {
            var msg = (err && err.status === 400) ? 'That code is invalid or has expired.' : formatLichessError(err);
            setMessage('link-device-error', msg);
            return;
        }
        showLichessMenu();
    });
}

/* ---- Find Match ---- */

function openLichessFindMatchScreen() {
    setMessage('find-match-error', '');
    matchSelectedRated = false;
    updateMatchChoiceButtons();
    showScreen('lichess-find-match');
}

function updateMatchChoiceButtons() {
    var casualBtn = document.getElementById('btn-match-rated-casual');
    var ratedBtn = document.getElementById('btn-match-rated-rated');
    casualBtn.className = 'big-btn small-btn choice-btn' + (!matchSelectedRated ? ' selected' : '');
    ratedBtn.className = 'big-btn small-btn choice-btn' + (matchSelectedRated ? ' selected' : '');
}

function startFindMatch() {
    setMessage('find-match-error', '');
    var tc = document.getElementById('lichess-findmatch-timecontrol-select').value.split(',');
    var clockLimitSec = parseInt(tc[0], 10);
    var clockIncrementSec = parseInt(tc[1], 10);

    LichessClient.findMatchStart(lichessSessionToken(), {
        timeControlSec: clockLimitSec,
        incrementSec: clockIncrementSec,
        rated: matchSelectedRated
    }, function (err, data) {
        if (err || !data) { setMessage('find-match-error', formatLichessError(err)); return; }
        lichessFindMatchTicketId = data.ticketId;
        setMessage('matching-error', '');
        showScreen('lichess-matching');
        if (data.matched && data.gameId) { onFoundMatch(data.gameId); return; }
        OnlineClient.startPolling(function (cb) {
            LichessClient.findMatchPoll(lichessSessionToken(), lichessFindMatchTicketId, cb);
        }, 2500, onFindMatchPollUpdate);
    });
}

function onFindMatchPollUpdate(err, data) {
    if (err || !data) { setMessage('matching-error', formatLichessError(err)); return; }
    if (data.matched && data.gameId) {
        OnlineClient.stopPolling();
        setMessage('matching-error', '');
        onFoundMatch(data.gameId);
        return;
    }
    /* lastError means a partner WAS found but starting the Lichess game
     * between you failed (see api/lichess/[action].js's tryMatchTicket) -
     * still retrying against other candidates, but worth surfacing so
     * "stuck searching" doesn't look identical to "nobody else is
     * searching right now". */
    setMessage('matching-error', data.lastError ? 'Found an opponent, but the game could not be started yet — retrying…' : '');
}

function onFoundMatch(gameId) {
    LichessClient.fetchGameState(lichessSessionToken(), gameId, function (err, data) {
        if (!err && data && data.active) { beginLichessGame(gameId, data.color); }
        else {
            setMessage('matching-error', 'Match found but the game could not be loaded. Please try again.');
            showScreen('lichess-menu');
        }
    });
}

function cancelFindMatch() {
    OnlineClient.stopPolling();
    if (lichessFindMatchTicketId) {
        LichessClient.findMatchCancel(lichessSessionToken(), lichessFindMatchTicketId, function () { /* best-effort - screen is already leaving either way */ });
    }
    lichessFindMatchTicketId = null;
    showScreen('lichess-menu');
}

/* ---- Find Match with Lichess Players (real Lichess seek) ---- */

function openLichessSeekScreen() {
    setMessage('seek-error', '');
    seekSelectedRated = false;
    updateSeekChoiceButtons();
    showScreen('lichess-find-match-lichess');
}

function updateSeekChoiceButtons() {
    var casualBtn = document.getElementById('btn-seek-rated-casual');
    var ratedBtn = document.getElementById('btn-seek-rated-rated');
    casualBtn.className = 'big-btn small-btn choice-btn' + (!seekSelectedRated ? ' selected' : '');
    ratedBtn.className = 'big-btn small-btn choice-btn' + (seekSelectedRated ? ' selected' : '');
}

/* Each seekStart/seekPoll call can take several seconds (the server holds
 * a real Lichess seek connection open for a bounded window before
 * replying - see api/lichess/_lichess.js's openBoundedSeek) - the small
 * 300ms interval below is mostly there to yield between calls, not to
 * pace them; the server-side hold is what actually paces the search. */
function startSeekMatch() {
    setMessage('seek-error', '');
    var tc = document.getElementById('lichess-seek-timecontrol-select').value.split(',');
    var timeMinutes = parseInt(tc[0], 10);
    var incrementSec = parseInt(tc[1], 10);

    LichessClient.seekStart(lichessSessionToken(), {
        timeMinutes: timeMinutes,
        incrementSec: incrementSec,
        rated: seekSelectedRated
    }, function (err, data) {
        if (err || !data) { setMessage('seek-error', formatLichessError(err)); return; }
        lichessSeekId = data.seekId;
        setMessage('matching-lichess-error', '');
        showScreen('lichess-matching-lichess');
        if (data.matched && data.gameId) { onFoundSeekMatch(data.gameId, data.color); return; }
        OnlineClient.startPolling(function (cb) {
            LichessClient.seekPoll(lichessSessionToken(), lichessSeekId, cb);
        }, 300, onSeekPollUpdate);
    });
}

function onSeekPollUpdate(err, data) {
    if (err || !data) { setMessage('matching-lichess-error', formatLichessError(err)); return; }
    setMessage('matching-lichess-error', '');
    if (data.matched && data.gameId) {
        OnlineClient.stopPolling();
        onFoundSeekMatch(data.gameId, data.color);
    }
}

function onFoundSeekMatch(gameId, color) {
    if (color) { beginLichessGame(gameId, color); return; }
    /* Fallback in case color ever comes back empty - reuses the exact same
     * lookup the "This Site" and manual-challenge flows already do. */
    LichessClient.fetchGameState(lichessSessionToken(), gameId, function (err, data) {
        if (!err && data && data.active) { beginLichessGame(gameId, data.color); }
        else {
            setMessage('matching-lichess-error', 'Match found but the game could not be loaded. Please try again.');
            showScreen('lichess-menu');
        }
    });
}

function cancelSeekMatch() {
    OnlineClient.stopPolling();
    if (lichessSeekId) {
        LichessClient.seekCancel(lichessSessionToken(), lichessSeekId, function () { /* best-effort - screen is already leaving either way */ });
    }
    lichessSeekId = null;
    showScreen('lichess-menu');
}

function undoMove() {
    if (mode === 'online' || mode === 'lichess' || mode === 'puzzle' || mode === 'replay' || mode === 'watch') { return; }
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
    document.getElementById('btn-play-lichess').onclick = function () { goToLichessHome(); };
    document.getElementById('btn-local-rooms').onclick = function () { showScreen('local-rooms'); };
    document.getElementById('btn-local-rooms-back').onclick = function () { showScreen('splash'); };
    document.getElementById('btn-puzzles').onclick = function () { openPuzzleMenu(); };
    document.getElementById('btn-watch-games').onclick = function () { openTvChannelsScreen(); };
    document.getElementById('btn-tv-list-back').onclick = function () { showScreen('splash'); };
    document.getElementById('btn-watch-stop').onclick = function () { stopWatchingGame(); };
    document.getElementById('btn-puzzle-menu-back').onclick = function () { showScreen('splash'); };
    document.getElementById('btn-puzzle-daily').onclick = function () { requestDailyPuzzle(); };
    document.getElementById('btn-puzzle-random').onclick = function () { requestNextPuzzle(); };

    document.getElementById('btn-2p').onclick = function () { startGame('2p', null); };
    document.getElementById('btn-vs-ai').onclick = function () { showScreen('difficulty'); };
    document.getElementById('btn-diff-back').onclick = function () { showScreen('local-rooms'); };

    document.getElementById('btn-diff-400').onclick = function () { startGame('ai', 400); };
    document.getElementById('btn-diff-800').onclick = function () { startGame('ai', 800); };
    document.getElementById('btn-diff-1200').onclick = function () { startGame('ai', 1200); };
    document.getElementById('btn-diff-1600').onclick = function () { startGame('ai', 1600); };
    document.getElementById('btn-diff-2000').onclick = function () { startGame('ai', 2000); };
    document.getElementById('btn-diff-2400').onclick = function () { startGame('ai', 2400); };

    document.getElementById('btn-new').onclick = function () { startGame(mode, currentLevel); };
    document.getElementById('btn-undo').onclick = function () { undoMove(); };
    document.getElementById('btn-flip').onclick = function () { flipBoard(); };
    document.getElementById('btn-menu').onclick = function () { showScreen('splash'); };
    document.getElementById('btn-resign').onclick = function () { resignLichessGame(); };
    document.getElementById('btn-draw').onclick = function () { offerOrAcceptLichessDraw(); };

    document.getElementById('btn-gameover-new').onclick = function () {
        if (mode === 'online') { showScreen('online-menu'); }
        else if (mode === 'lichess') { showScreen('lichess-menu'); }
        else if (mode === 'puzzle') { requestNextPuzzle(); }
        else { startGame(mode, currentLevel); }
    };
    document.getElementById('btn-gameover-menu').onclick = function () { showScreen('splash'); };

    document.getElementById('promo-q').onclick = function () { pickPromotion('q'); };
    document.getElementById('promo-r').onclick = function () { pickPromotion('r'); };
    document.getElementById('promo-b').onclick = function () { pickPromotion('b'); };
    document.getElementById('promo-n').onclick = function () { pickPromotion('n'); };

    document.getElementById('btn-online').onclick = function () { showScreen('online-menu'); };
    document.getElementById('btn-online-back').onclick = function () { showScreen('local-rooms'); };
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

    document.getElementById('btn-lichess-login').onclick = function () { loginWithLichess(); };
    document.getElementById('btn-lichess-login-back').onclick = function () { showScreen('splash'); };
    document.getElementById('btn-lichess-pair').onclick = function () { openLichessPairingScreen(); };
    document.getElementById('btn-pairing-cancel').onclick = function () { cancelPairing(); };
    document.getElementById('btn-lichess-link-device').onclick = function () { openLinkDeviceScreen(); };
    document.getElementById('btn-link-device-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-link-device-submit').onclick = function () { submitLinkDevice(); };
    document.getElementById('btn-lichess-find-match').onclick = function () { openLichessFindMatchScreen(); };
    document.getElementById('btn-find-match-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-find-match-submit').onclick = function () { startFindMatch(); };
    document.getElementById('btn-matching-cancel').onclick = function () { cancelFindMatch(); };
    document.getElementById('btn-match-rated-casual').onclick = function () { matchSelectedRated = false; updateMatchChoiceButtons(); };
    document.getElementById('btn-match-rated-rated').onclick = function () { matchSelectedRated = true; updateMatchChoiceButtons(); };
    document.getElementById('btn-lichess-find-match-lichess').onclick = function () { openLichessSeekScreen(); };
    document.getElementById('btn-seek-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-seek-submit').onclick = function () { startSeekMatch(); };
    document.getElementById('btn-matching-lichess-cancel').onclick = function () { cancelSeekMatch(); };
    document.getElementById('btn-seek-rated-casual').onclick = function () { seekSelectedRated = false; updateSeekChoiceButtons(); };
    document.getElementById('btn-seek-rated-rated').onclick = function () { seekSelectedRated = true; updateSeekChoiceButtons(); };
    document.getElementById('btn-lichess-menu-back').onclick = function () { showScreen('splash'); };
    document.getElementById('btn-lichess-logout').onclick = function () { logoutOfLichess(); };
    document.getElementById('btn-lichess-challenge').onclick = function () { openLichessChallengeScreen(); };
    document.getElementById('btn-lichess-incoming').onclick = function () { openLichessIncomingScreen(); };
    document.getElementById('btn-lichess-my-games').onclick = function () { openLichessMyGames(); };
    document.getElementById('btn-lichess-profile').onclick = function () { openLichessProfile(); };
    document.getElementById('btn-lichess-profile-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-lichess-import-pgn').onclick = function () { openImportPgnScreen(); };
    document.getElementById('btn-lichess-my-games-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-lichess-my-games-refresh').onclick = function () { openLichessMyGames(); };
    document.getElementById('btn-import-pgn-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-import-pgn-load').onclick = function () { loadImportedPgn(); };
    document.getElementById('btn-replay-first').onclick = function () { replayFirst(); };
    document.getElementById('btn-replay-prev').onclick = function () { replayPrev(); };
    document.getElementById('btn-replay-next').onclick = function () { replayNext(); };
    document.getElementById('btn-replay-last').onclick = function () { replayLast(); };
    document.getElementById('btn-replay-pgn').onclick = function () { openPgnViewScreen(); };
    document.getElementById('btn-replay-back').onclick = function () { showScreen(replayReturnScreen); };
    document.getElementById('btn-replay-analyze').onclick = function () { openAnalysisScreen(); };
    document.getElementById('btn-analysis-back').onclick = function () { showScreen('game'); };
    document.getElementById('btn-pgn-copy').onclick = function () { copyPgnText(); };
    document.getElementById('btn-pgn-view-back').onclick = function () { showScreen('game'); };
    document.getElementById('btn-lichess-challenge-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-lichess-incoming-back').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-lichess-incoming-refresh').onclick = function () { refreshLichessIncomingList(); };
    document.getElementById('btn-lichess-waiting-cancel').onclick = function () { showScreen('lichess-menu'); };
    document.getElementById('btn-lichess-send-challenge').onclick = function () { sendLichessChallenge(); };

    document.getElementById('btn-color-white').onclick = function () { lichessSelectedColor = 'white'; updateChoiceButtons(); };
    document.getElementById('btn-color-black').onclick = function () { lichessSelectedColor = 'black'; updateChoiceButtons(); };
    document.getElementById('btn-color-random').onclick = function () { lichessSelectedColor = 'random'; updateChoiceButtons(); };
    document.getElementById('btn-rated-casual').onclick = function () { lichessSelectedRated = false; updateChoiceButtons(); };
    document.getElementById('btn-rated-rated').onclick = function () { lichessSelectedRated = true; updateChoiceButtons(); };

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

    /* On every load: first check whether this is Lichess redirecting back
     * from the OAuth consent screen; if not, try resuming a Lichess game
     * left active (tab killed/reloaded); only if neither applies does the
     * app fall back to the ordinary splash screen. */
    LichessClient.handleOAuthCallback(function (err, result) {
        if (result) {
            lichessSession = LichessClient.getStoredSession();
            showLichessMenu();
            return;
        }
        if (err) {
            showScreen('lichess-login');
            setMessage('lichess-login-error', err.message || 'Login failed. Please try again.');
            return;
        }
        if (!tryResumeLichessGame()) {
            showScreen('splash');
        }
    });
}

init();
