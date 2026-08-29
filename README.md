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
js/app.js            UI controller: screens, board rendering, click handling, game flow
api/_room.js          Shared server-side helpers (Redis REST calls, room/token/replay logic)
api/create-room.js    POST - creates a room (optionally public), returns a code + player token
api/join-room.js      POST - joins an existing room as the second player
api/move.js           POST - validates and applies a move server-side (turn + legality checks)
api/state.js          GET  - polled by both clients for the room's current move list/status
api/cancel-room.js    POST - lets the creator delete a room that's still waiting for an opponent
api/list-public-rooms.js  GET - lists open public rooms for the "Public Server Play" lobby
package.json         No runtime dependencies
vercel.json          Static hosting config with light caching headers for the assets
```

## Features

- **Splash screen** with three modes: **2 Player** (pass-and-play),
  **Play vs Computer** (Easy / Medium / Hard), and **Play Online**.
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

### Online play

Two ways to find an opponent, both under **Play Online**:

- **Create Game / Join Game** — a private 5-character room code you share
  with someone directly (over text, etc.).
- **Public Server Play** — no code needed. **Create Room** puts you in an
  open lobby anyone can find; **Join Room** shows a live list of everyone
  currently waiting, tap one to join it. The list polls every 3s while
  you're browsing it.

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
- Online play has no resign/draw-offer button, no reconnect-with-a-new-
  device support (the player token lives only in that browser tab's
  memory), and abandoned rooms simply expire after 6 hours rather than
  being cleaned up immediately.
