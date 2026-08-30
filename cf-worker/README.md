# Ultimate Chess Matchmaking - Cloudflare Worker

This is a **completely separate backend** from the rest of this project.
The main site (`index.html`, `js/*.js`, `api/*.js`) is a static site plus
Vercel serverless functions, backed by Upstash Redis and integrated with
Lichess. This folder is a standalone Cloudflare Worker, backed by two
Durable Objects, with **no Lichess dependency and no shared state with
anything else in this repo**. It only exists to power one feature: the
"Ultimate Chess Matchmaking" button on the home screen.

Nothing here was verified against a live Cloudflare account from the
sandbox this was built in (no Cloudflare credentials available there) -
but the actual matchmaking, move-validation, and clock logic **was**
tested end-to-end using `wrangler dev --local`, which runs Cloudflare's
real open-source Workers runtime (`workerd`) entirely on your own
machine, no account needed. That covered: two players matching, a full
game with real moves (including rejecting illegal moves and out-of-turn
moves), resignation, cancel-search, and - importantly - a game correctly
resolving to a timeout **via the Durable Object's alarm, with neither
player ever polling again** (simulating both sides disconnecting). It was
also tested through the actual site's UI in two separate real browser
contexts talking to the Worker across two different localhost ports
(a genuine cross-origin request, so this also confirms the CORS setup
works). What's *not* verified is anything specific to Cloudflare's actual
production edge network (multi-region behavior, real TLS/domain routing,
production rate limits) - that only shows up once you deploy for real.

## Why this architecture

- **Two Durable Object classes.** `Matchmaker` (`src/matchmaker.js`) is a
  single global instance holding the waiting-player queue. `GameRoom`
  (`src/gameRoom.js`) is one instance per match, holding that match's
  board, move list, and both clocks. A Durable Object processes requests
  to itself one at a time, in order - so two players clicking "Find
  Match" within the same millisecond can never both grab the same third
  waiting player. That's not a defensive check added on top of a
  key-value store (which is what this project's other queues, backed by
  Upstash Redis, have to do); it's a structural property of Durable
  Objects, and it's the main reason this feature uses them.
- **HTTP long-polling, not WebSockets**, same reasoning as everywhere
  else in this project: this has to work on a Kindle Paperwhite 6th-gen
  browser, and long-lived connections are the thing that breaks there.
  The client polls `/uc/queue/status` and `/uc/game/state` on a plain
  timer; every response is small, plain JSON.
- **Durable Object alarms as a disconnect/abandonment backstop.** Besides
  the same lazy "has this side's clock actually run out, checked against
  wall-clock time" logic this project's own online rooms already use
  (checked on every request), each `GameRoom` also schedules a Durable
  Object alarm for roughly when the side to move would flag. Alarms fire
  even if nobody ever makes another request - so a game where both
  players simply close their tabs still resolves to a real result on its
  own, which a plain request-driven backend can't do without a separate
  scheduled job.
- **Chess rules**: `src/chessEngine.js` is a synced copy of
  `../js/chessEngine.js` (the main site's own rules engine - move
  generation, check/checkmate/stalemate detection, everything), unchanged
  except for one added `export default` line at the bottom, since this
  Worker uses ES modules and the main copy is written be usable from
  both a plain `<script>` tag and Node's CommonJS `require`. If you ever
  change the rules engine, copy the update here too.
- **Identity**: each browser gets a random `playerId` (via
  `js/ultimateChess.js`, stored in `localStorage`), not a real account.
  It's never shown to the opponent, only used so the server knows which
  side of a `GameRoom` is asking. This is intentionally lightweight - it
  is not a security system, and isn't trying to be one for a casual,
  anonymous matchmaking feature.

## API (all under `/uc/`)

| Method | Path | Body / Query | What it does |
|---|---|---|---|
| POST | `/uc/queue/join` | `{playerId, timeControlSec, incrementSec}` | Joins the queue; matches immediately if a compatible partner is already waiting. Returns `{ticketId, matched, gameId?, color?}`. Calling this again with the same `playerId` while already queued returns the *same* ticket rather than creating a duplicate. |
| GET | `/uc/queue/status?ticketId=` | - | Poll while waiting. Returns `{found, matched, gameId?, color?}`. |
| POST | `/uc/queue/cancel` | `{ticketId}` | Leaves the queue. A no-op (doesn't discard the game) if a match already landed. |
| GET | `/uc/game/state?gameId=&playerId=` | - | Current game state: `{found, fen, lastMove, moves, turnStartedAt, whiteTimeLeftMs, blackTimeLeftMs, turn, status, result, yourColor, timeControlSec, incrementSec}`. |
| POST | `/uc/game/move` | `{gameId, playerId, from, to, promotion}` | Validates and applies a move server-side. `from`/`to` are 0-63 board indices (rank-major, a1=0), matching this project's own internal move representation. Returns `{ok, state}` or `{ok:false, error}`. |
| POST | `/uc/game/resign` | `{gameId, playerId}` | Ends the game as a resignation. |

## Deploying

1. **Install wrangler** (Cloudflare's CLI) if you don't have it:
   ```
   npm install -g wrangler
   ```
   (or just use `npx wrangler ...` for every command below, no global
   install needed).

2. **Log in to your Cloudflare account:**
   ```
   cd cf-worker
   npx wrangler login
   ```
   This opens a browser window to authorize wrangler. A free Cloudflare
   account is enough - Durable Objects with the SQLite storage backend
   (what `wrangler.toml` requests via `new_sqlite_classes`) are available
   on Workers' free plan.

3. **Deploy:**
   ```
   npx wrangler deploy
   ```
   The first deploy runs the `[[migrations]]` block in `wrangler.toml`,
   which allocates storage for the `Matchmaker` and `GameRoom` classes.
   Don't edit or remove that migrations block later - if you ever rename
   or restructure a Durable Object class, add a *new* migrations block
   with a new `tag` instead (see [Cloudflare's Durable Objects migration
   docs](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).

4. **Copy the deployed URL.** Wrangler prints something like:
   ```
   https://ultimate-chess-matchmaking.YOUR-SUBDOMAIN.workers.dev
   ```
   (If you'd rather use your own domain, add a custom domain or route to
   this Worker in the Cloudflare dashboard - Workers → your Worker →
   Settings → Domains & Routes - then use that domain instead.)

5. **Point the site's client at it.** Open `../js/ultimateChess.js` and
   change the `API_BASE` constant near the top from the placeholder to
   your real Worker URL:
   ```js
   var API_BASE = 'https://ultimate-chess-matchmaking.YOUR-SUBDOMAIN.workers.dev';
   ```
   Then redeploy the main site (Vercel) as usual - this file is part of
   the main site's static assets, not the Worker.

6. **Try it.** Open the site in two different browsers (or one normal
   window plus one private/incognito window - `localStorage` is
   per-profile, and a stable `playerId` is exactly what tells the two
   sides apart), tap "Ultimate Chess Matchmaking" → "Find Match" in both,
   and you should be matched into a game within a second or two.

### Local testing without a Cloudflare account

`wrangler dev --local` runs Cloudflare's real Workers runtime entirely on
your own machine (no login, no network needed) - this is exactly how the
backend logic here was verified before shipping:

```
cd cf-worker
npx wrangler dev --local
```

This prints a `http://localhost:8787`-style URL. Temporarily point
`API_BASE` in `js/ultimateChess.js` at that local URL, open `index.html`
through a local static server (e.g. `python3 -m http.server 8000` from
the repo root) in two browser windows, and play a full game locally
before ever touching a real Cloudflare account.

## Cost

Cloudflare's Workers free plan includes 100,000 requests/day and Durable
Objects with SQLite storage. At the polling intervals this client uses
(roughly one request per player every 1.2-1.5 seconds while actively
searching or playing), that's comfortably enough for casual/hobby-scale
traffic. If this ever gets busy enough to matter, Cloudflare's dashboard
under Workers & Pages shows real usage against the free tier's limits.

## Tightening CORS (optional)

`src/index.js` currently sends `Access-Control-Allow-Origin: *` - fine
for this feature (there's no cookie or ambient credential to protect;
every request explicitly carries its own `playerId`), but if you'd
rather restrict it to your exact site origin, change the `CORS_HEADERS`
object at the top of that file to your domain instead of `'*'` and
redeploy the Worker.
