# Chess for Kindle Ultimate
Website: chessforkindleultimate.vercel.app
A tiny, dependency-free chess game built to run well on old Kindle e-ink
browsers (as far back as the Kindle Keyboard / Kindle Touch era), while
still working fine on modern browsers and Kindle Fire tablets.

## Why it's built this way

Old Kindle browsers use ancient WebKit engines: no ES6 (`let`/`const`,
arrow functions, classes, template literals), no Flexbox/Grid, no
`fetch`/`Promise`, slow single-core CPUs, and a grayscale e-ink screen with
slow refresh. Everything here is written around those constraints:

- **Plain ES5 JavaScript** (`var`, function declarations) across all three
  scripts — no build step, no transpiler, no bundler needed.
- **No external libraries or CDN scripts.** The whole game — rules engine,
  UI, and AI — is self-contained in this repo. Nothing is fetched over the
  network at runtime, so it also works offline once loaded.
- **`<table>`-based board layout**, not Flexbox/Grid, for guaranteed layout
  support on old rendering engines.
- **A single small sprite sheet** (`img/pieces.png`, 6x2 grid, ~47KB) for
  all twelve piece images, positioned with percentage-based
  `background-position`/`background-size` so one image request covers the
  whole board and every square recolors/repositions correctly at any
  responsive board size with no JS resize math.
- **Full page repaints are avoided**: the board table is built once, and
  moves only update the ~64 existing cells' text/class rather than
  rebuilding the DOM, which keeps e-ink flicker to a minimum.
- **The AI runs in time-boxed chunks** (one search depth per iteration,
  yielded back to the browser via `setTimeout`) so a slow CPU never looks
  like it has frozen the page, and always returns *some* legal move inside
  its time budget regardless of hardware speed.

## About the "SmartForwarder" engine snippet

The snippet included in the request doesn't actually run: its only
`<script>` tag loads `https://cloudflare.com` instead of the chess.js
library it depends on, so `new Chess()` throws immediately in any browser.
Beyond that, relying on a third-party CDN library is a poor fit for an
offline-friendly, old-Kindle-first static site anyway (extra network
round-trip, another point of failure, no guarantee an ancient WebKit build
even parses that library cleanly).

`js/ai.js` reimplements the same idea the snippet was going for —
iterative-deepening negamax search with alpha-beta pruning, material
scoring, and a hard time cap — as a small, self-contained engine built
directly on this project's own rules engine (`js/chessEngine.js`), with no
network dependency at all.

## Piece artwork — please read before publishing this publicly

`img/pieces.png` is chess.com's "Classic" piece set, pulled from
[GiorgioMegrelli/chess.com-boards-and-pieces](https://github.com/GiorgioMegrelli/chess.com-boards-and-pieces),
a community repo that mirrors images scraped directly from chess.com's own
CDN. That repo carries no license grant for the artwork, and it's
chess.com's proprietary art, not something freely licensed for reuse — so
bundling it here is a real copyright/ToS risk if this project is deployed
publicly or shared widely, not just a formality. This was used because it's
what was explicitly requested after the previous placeholder pieces were
rejected as unrecognizable, but it's worth being aware of before, say,
pushing this to a public Vercel URL. A lower-risk swap later would be a
clearly-licensed set such as the CC-BY-SA "cburnett" pieces used by
Wikipedia/Lichess (different, more detailed art style) — replacing
`img/pieces.png` with a same-layout sprite (6 columns: k,q,b,n,r,p; 2 rows:
white,black) is the only change that would take.

## Project structure

```
index.html          Markup for all screens (splash, difficulty, board, online, overlays)
css/style.css        Flat-color, table/block layout styling, no gradients/flex/grid
js/chessEngine.js    Pure rules engine: legal moves, check/mate/stalemate, castling,
                     en passant, promotion, draw detection (also used from Node - see below)
js/ai.js             Iterative-deepening alpha-beta search used for "Play vs Computer"
js/online.js         XHR client for the /api online-play routes (polling, no WebSockets)
js/lichess.js        Lichess OAuth (PKCE, with a bundled pure-JS SHA-256) + Board API client
js/ultimateChess.js  XHR client for Ultimate Chess Matchmaking ("Find Match" random-opponent
                     play, via api/uc/*.js) - independent of both online.js and lichess.js
js/app.js            UI controller: screens, board rendering, click handling, game flow
api/_redis.js         Shared Upstash Redis REST wrapper, used by both api/_room.js and api/uc/
api/_room.js          Shared server-side helpers (room/token/replay logic) for room-code play
api/create-room.js    POST - creates a room (optionally public), returns a code + player token
api/join-room.js      POST - joins an existing room as the second player
api/move.js           POST - validates and applies a move server-side (turn + legality checks)
api/state.js          GET  - polled by both clients for the room's current move list/status
api/cancel-room.js    POST - lets the creator delete a room that's still waiting for an opponent
api/list-public-rooms.js  GET - lists open public rooms for the "Public Server Play" lobby
api/uc/_uc.js             Shared helpers for Ultimate Chess Matchmaking (queue + game room logic)
api/uc/[...path].js       All six Ultimate Chess Matchmaking endpoints (queue/join, queue/status,
                          queue/cancel, game/state, game/move, game/resign) in one dynamic route -
                          see its own header comment for why (Vercel's 12-function Hobby cap)
api/lichess/_lichess.js          Shared helpers: OAuth token exchange, session storage, Lichess API proxy
api/lichess/oauth-exchange.js    POST - completes login, returns our session token
api/lichess/me.js                GET  - current Lichess username + ratings
api/lichess/logout.js            POST - clears the session (and best-effort revokes the Lichess token)
api/lichess/challenge-create.js  POST - challenges a Lichess username
api/lichess/challenge-respond.js POST - accept/decline an incoming challenge
api/lichess/challenge-status.js  GET  - poll target while waiting for a challenge to be accepted
api/lichess/game-state.js        GET  - current FEN/clock/status for one Lichess game
api/lichess/move.js              POST - sends a move (UCI) to a Lichess game
api/lichess/resign.js            POST - resigns a Lichess game
api/lichess/draw.js              POST - offers/accepts a draw
api/lichess/poll-events.js       GET  - bounded sample of incoming challenges (see caveat below)
package.json         No runtime dependencies
vercel.json          Static hosting config with light caching headers for the assets
```

## Features

- **Splash screen** with two top-level paths: **Play Lichess** (real
  opponents via your Lichess account) and **Local Rooms** (everything that
  doesn't need an account: **2 Player** pass-and-play, **Play vs Computer**
  at six Elo-labeled levels from 400 to 2400, and this app's own **Play
  Online** room system).
- Full chess rules: castling (both sides), en passant, pawn promotion
  (choose queen/rook/bishop/knight), check/checkmate/stalemate detection,
  draw by insufficient material or the 50-move rule, draw by threefold
  repetition.
- Tap-to-move interaction: tap a piece to see its legal destinations
  highlighted, tap a destination to move.
- Undo (steps back one full turn in AI mode so it's always your move
  again), flip board, new game, and a menu button.
- The board is sized in JS from the device's actual viewport (not a fixed
  CSS size), so it fills the screen on whatever Kindle/tablet it's running
  on, and re-sizes on rotation.
- **Move history** (standard algebraic notation, e.g. "1. e4 e5 2. Nf3")
  and a **captured-pieces tray** are shown for every mode - local, online,
  Lichess, puzzles, replay, and watching. Both are derived purely from
  chess rules (`chessEngine.js`'s `moveToSan`/`computeCapturedPieces`),
  not tracked as separate events, so they can't drift out of sync with
  the board and needed no per-mode special-casing to add.
- **Enhanced Mode** (a text link on the splash screen, and a button on the
  game screen itself): an opt-in, remembered-per-device preference that
  makes buttons and clocks bigger and easier to tap. Off by default so
  the baseline experience is unchanged; it's pure CSS (font-size/padding
  behind a body class), so turning it on doesn't cost anything on old
  Kindle hardware either.

### Online play

Two ways to find an opponent, both under **Play Online**:

- **Create Game / Join Game** — a private 5-character room code you share
  with someone directly (over text, etc.).
- **Public Server Play** — no code needed. **Create Room** puts you in an
  open lobby anyone can find; **Join Room** shows a live list of everyone
  currently waiting, tap one to join it. The list polls every 3s while
  you're browsing it. Public games are timed: **10 minutes per side** -
  run out and you lose on time. Create Game/Join Game stay untimed.

Either way, the board updates automatically for both sides once a game
starts — no manual refresh.

This deliberately does not use WebSockets: old Kindle browsers are
unreliable WebSocket clients, so instead each browser just polls a small
serverless API (`/api/state`) every 1.5s with plain `XMLHttpRequest`, which
has worked on every browser for decades. All moves are validated
server-side by the exact same rules engine the client uses
(`js/chessEngine.js`, reused from Node via `module.exports`) before being
accepted, so a modified/buggy client can't play an illegal move or move on
the other player's turn — the server's move list is always the source of
truth, and each client replays it fresh whenever it changes.

**Setup required for online play to work once deployed:** the API routes
need a place to store room state. In the Vercel dashboard, open the
project → **Storage** tab → create a database → choose the Redis-backed
option (marketed as "Vercel KV" / an Upstash Redis integration) → connect
it to this project. That's it — Vercel injects the `KV_REST_API_URL` /
`KV_REST_API_TOKEN` environment variables automatically, and `api/_room.js`
picks them up (or the `UPSTASH_REDIS_REST_URL` / `_TOKEN` names, if you
connect Upstash directly instead) with no code changes and no npm
dependency. Without a KV store connected, the 2 Player and vs Computer
modes work fine, but Online Play will show a "Something went wrong" error
when creating or joining a room.

## Ultimate Chess Matchmaking

A second matchmaking flow, separate from both Lichess play and this
project's room-code online rooms above - no room code, no Lichess
account. "Find Match" automatically pairs you with another waiting
player and drops you into a dedicated game room with server-authoritative
moves and chess clocks; matches Cancel Search too.

It's the same Vercel + Redis backend as the room-code system
(`api/uc/*.js`, using the same KV store set up above) rather than a
separate deployment - no separate account, CLI, or deploy step needed.
The waiting queue is one Redis LIST per time control: joining always
tries an atomic `LPOP` first (Redis pops are indivisible, so two players
hitting "Find Match" at the same moment can never both grab the same
waiting opponent) before pushing itself as the new queue tail. Game state
reuses the exact same move-list-replay approach as the room-code
system - the same lazy "has this side's clock actually run out, checked
against wall-clock time" logic, checked on every poll and before every
move. It talks to the browser over plain HTTP long-polling, same as
everywhere else in this app - no WebSockets.

## Lichess play

**Play Lichess** lets you log in with a real Lichess account and play real
opponents, rated or casual, with your own time control and color choice.
This is "Phase 1" of a larger wishlist — deliberately scoped to the
highest-priority half (login, challenge/play, live moves, clocks,
reconnection, reliable move handling, resign/draw, the Kindle-friendly
board) and not the rest (game history, replay, PGN import/export, puzzles,
opening explorer, spectating) — before going further.

### Please read this before relying on it

This was built **without live access to Lichess's API docs or a real
account** — this sandbox's network policy blocks `lichess.org` entirely, so
none of it could be verified against the real service while writing it.
What's in `api/lichess/_lichess.js`, `js/lichess.js`, and the other
`api/lichess/*.js` files is a best-confidence reconstruction from general
knowledge of Lichess's long-stable public API, tested as thoroughly as
possible against a local mock that reproduces the documented shapes and
endpoints — but "the mock behaved correctly" isn't the same as "the real
API behaves this way." **The first real test of the OAuth login and the
Board API calls needs to happen against your actual Lichess account.** If
something doesn't work, the likely fix is small and localized (a field
name, a body encoding, an endpoint path) — start with whichever
`api/lichess/*.js` file corresponds to the failing action, and check
Vercel's function logs for the actual error Lichess returned.

Specific things that couldn't be confirmed and are worth checking first:
- The **OAuth token exchange** body encoding (form-urlencoded, per the
  OAuth2 RFC — `api/lichess/_lichess.js`'s `exchangeCodeForToken`) and
  whether Lichess's PKCE flow truly needs no app pre-registration (used
  here on that assumption, with `client_id: "chess-for-kindle-ultimate"`
  hardcoded in both `js/lichess.js` and `api/lichess/_lichess.js` — if
  Lichess does reject an unregistered client_id, register one at
  lichess.org and update both files to match).
- The exact field names in `/api/account/playing` and `/api/challenge/*`
  responses (`api/lichess/game-state.js`, `challenge-status.js`,
  `challenge-create.js`).
- Whether `/api/game/export/{id}` needs `?pgnInJson=true` or a different
  parameter/header to return JSON instead of raw PGN.

### Why some of this looks different from a "normal" Lichess client

- **No WebSockets, no long-lived streams anywhere in this app's own
  infrastructure.** Lichess's real-time push (moves, incoming challenges)
  is delivered over long-lived NDJSON streams
  (`/api/stream/event`, `/api/board/game/stream/{id}`) - old Kindle
  browsers can't reliably hold a connection like that open, and a Vercel
  serverless function can't run forever either. So: live game moves are
  read from `/api/account/playing`, a plain polling-friendly GET, every
  ~2s. Incoming challenges have no such plain GET as far as could be
  confirmed, so `api/lichess/poll-events.js` instead opens
  `/api/stream/event` itself, reads whatever arrives in a bounded ~7-second
  window, and returns that - the client calls this endpoint every 15-20s
  while sitting on a relevant screen. **That interval, not instant
  delivery, is the deliberate tradeoff for staying entirely
  polling-based**, confirmed as acceptable up front.
- **Only one "time left" reading, not two always-visible clocks.**
  `/api/account/playing` exposes a single `secondsLeft` for whichever side
  is on the clock, not a clean both-sides split - so the Lichess game
  screen shows one live reading rather than reusing the two-box clock UI
  from Public Server Play. If real API access later turns up richer
  per-side clock data, upgrading the display is a small client-side change.
- **Draw offers can only be sent, not detected.** Whether the opponent has
  offered a draw appears to live only in the streamed game state, which
  this app deliberately doesn't hold open - so there's a single "Offer/
  Accept Draw" button that calls Lichess's `draw/yes` endpoint either way
  (which is what that endpoint is for regardless of which side calls it),
  rather than a popup that says "your opponent offered a draw."
- **Reconnection** shows a "Reconnecting…" banner after 2 consecutive
  failed polls without tearing down the board or game state, and keeps
  retrying at the same interval - this is a thin UX layer over polling
  that was already resilient by construction (a failed poll simply
  reschedules the next one, same as it always has). Separately, the active
  game (its id and your color) is persisted to `localStorage`, so a full
  page reload or a killed tab - a real scenario on old Kindle hardware
  under memory pressure, not just a hypothetical - resumes straight back
  into the game instead of losing it.
- **Undo is hidden for Lichess games** (same treatment as this app's own
  online rooms) since a real Lichess game can't be locally rewound.

### Kindle pairing and Find Match

Old Kindle browsers (6th-gen "Experimental Browser" and similar) often
can't complete a TLS handshake with `lichess.org` at all — outdated
cipher suites, TLS version, or SNI support. Redirecting one to Lichess's
OAuth page, like the normal "Log In with Lichess" button does, would just
fail to load. So the Kindle never does that:

- **Pairing.** The login screen has a second option, "Pair via Code."
  Tapping it asks our own server (never lichess.org) for a short code and
  displays it. On a phone or PC, you log in normally, tap "Link Another
  Device," and type that code in. The server then hands the Kindle the
  **same opaque session token** the phone already got from the normal
  OAuth flow (see `api/lichess/_lichess.js`) — not the real Lichess access
  token, which never leaves the server for any client, Kindle or
  otherwise. A pairing code is single-use (consumed the moment the Kindle
  picks it up) and expires after 10 minutes if never claimed. From that
  point on, the Kindle is a completely ordinary logged-in client — every
  existing Lichess feature (challenges, My Games, puzzles, watching,
  Find Match) works with zero special-casing for it.
- **Find Match.** Lichess's own matchmaking (`POST /api/board/seek`) has
  to keep a single HTTP request open until a match or cancellation
  happens — that fits neither a Vercel serverless function (hard
  execution-time limit) nor this app's polling-only client architecture,
  so it wasn't used. Instead, Find Match keeps its own short-lived queue
  (in the same Redis store as everything else): two of this app's users
  searching for the same time control/rated setting get matched with each
  other, and the server creates a real Lichess challenge between them
  (`api/lichess/[action].js`'s `createAndAcceptChallenge`, using the exact
  same `lichessFetch` call every other Lichess action already uses) and
  auto-accepts it. The resulting game is a completely normal Lichess game
  once found — this only changes how the two players are introduced to
  each other, not anything about how the game itself is played. Matching
  is checked lazily on each search/poll rather than via a background job
  (serverless functions have no persistent process to run one in), the
  same pattern `api/_room.js` already uses for online-room clock timeouts.
  This part of the queue logic is pure bookkeeping over this app's own
  Redis store, so — unlike the rest of the Lichess integration — it didn't
  need to be verified against Lichess's own API docs, only the challenge
  create/accept calls it drives did (same caveat as the rest of this
  section).

### Setup

Same Redis-backed store as the rest of online play (see below) - no
additional service to provision. The only Lichess-specific configuration
is the `CLIENT_ID` constant, which must match exactly between
`js/lichess.js` and `api/lichess/_lichess.js` (`chess-for-kindle-ultimate`
by default) if you ever need to change it.

## Running locally

The **2 Player** and **vs Computer** modes are static files, no server
logic needed:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

**Online play** needs the `/api` serverless functions to actually run,
which a plain static file server doesn't provide. Use the Vercel CLI's
local dev server instead (emulates the functions and reads a linked
project's KV credentials into `.env.local`):

```bash
npm i -g vercel
vercel link      # links this directory to your Vercel project
vercel env pull  # pulls the KV_REST_API_* vars into .env.local
vercel dev
```

## Deploying to Vercel

This is a static site with a few serverless functions under `/api`, so
Vercel needs no framework preset — it auto-detects `/api/*.js` as Node
functions:

```bash
vercel --prod
```

or connect the repo in the Vercel dashboard with the framework preset set
to "Other" — no build command or output directory overrides are required.
Remember the Storage step above if you want Online Play to work.

## Known limitations

- Threefold repetition is tracked only for the moves played in the current
  game session (not persisted across reloads).
- The rare same-colored-bishops-only insufficient-material case isn't
  special-cased (still correctly plays on rather than misdetecting a draw).
- In "Play vs Computer" mode you always play White; there's no color
  picker (kept out to match the minimal, few-taps UI this was modeled on).
- This app's own room system (Create/Join Game, Public Server Play) has no
  resign/draw-offer button, no reconnect-with-a-new-device support (the
  player token lives only in that browser tab's memory), and abandoned
  rooms simply expire after 6 hours rather than being cleaned up
  immediately. Lichess play has resign/draw and reconnection - see below.
