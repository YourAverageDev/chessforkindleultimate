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
index.html          Markup for all screens (splash, difficulty, board, overlays)
css/style.css        Flat-color, table/block layout styling, no gradients/flex/grid
js/chessEngine.js    Pure rules engine: legal moves, check/mate/stalemate, castling,
                     en passant, promotion, draw detection
js/ai.js             Iterative-deepening alpha-beta search used for "Play vs Computer"
js/app.js            UI controller: screens, board rendering, click handling, game flow
vercel.json          Static hosting config with light caching headers for the assets
```

## Features

- **Splash screen** with two modes: **2 Player** (pass-and-play) and
  **Play vs Computer** (Easy / Medium / Hard).
- Full chess rules: castling (both sides), en passant, pawn promotion
  (choose queen/rook/bishop/knight), check/checkmate/stalemate detection,
  draw by insufficient material or the 50-move rule, draw by threefold
  repetition.
- Tap-to-move interaction: tap a piece to see its legal destinations
  highlighted, tap a destination to move.
- Undo (steps back one full turn in AI mode so it's always your move
  again), flip board, new game, and a menu button.
- Responsive board sizing via a couple of `@media` breakpoints, from small
  e-ink screens up to tablet-sized Fire displays.

## Running locally

No build step — it's static files. From the project root:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploying to Vercel

This is a plain static site, so Vercel needs no framework preset:

```bash
vercel --prod
```

or connect the repo in the Vercel dashboard with the framework preset set
to "Other" — no build command or output directory overrides are required.

## Known limitations

- Threefold repetition is tracked only for the moves played in the current
  game session (not persisted across reloads).
- The rare same-colored-bishops-only insufficient-material case isn't
  special-cased (still correctly plays on rather than misdetecting a draw).
- In "Play vs Computer" mode you always play White; there's no color
  picker (kept out to match the minimal, few-taps UI this was modeled on).
