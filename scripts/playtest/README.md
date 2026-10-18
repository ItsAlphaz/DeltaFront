# Playtest scripts

Browser-driving checks for the Capital System, CRISIS and the insurgency, and a rig for
the human sessions. They drive a **real headed Chrome** (real mouse and key events) against
the **real game** and read what the game itself reports. They are not part of the product and
not part of `npm test`; the evidence they gave is written up in
[docs/PreReleasePlaytest.md](../../docs/PreReleasePlaytest.md).

## What you need

Linux, `google-chrome-stable`, a display that is awake (the game refuses software WebGL),
Node 24+ (global `WebSocket`/`fetch`), and for the private stack `unshare` (unprivileged user
namespaces), `ip` and `ss`.

## Run a check against a private copy of the game

```
scripts/playtest/stack.sh node scripts/playtest/golden.mjs
```

`stack.sh` copies the working tree to a temp directory, starts Vite (9000) and the game server
(3000-3002) **from the copy inside a private network namespace**, runs the command, and stops
everything. Your own dev server is never touched, and a second Vite is never started in your
checkout (that would re-optimise `node_modules/.vite` and break your dev page). Screenshots,
logs and result files go to `$PLAYTEST_OUT` (default `$TMPDIR/deltafront-playtest-out`), never
into the repository. Each script prints `PASS`/`FAIL` lines and exits non-zero on a failure.

| Script                                        | Plan rows            | What it does                                                                                                                                                                                                | Time           |
| --------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `modals.mjs`                                  | 5.2 to 5.4           | The real Solo and Create Match screens, the server's copy of a new lobby, the public lobby feed                                                                                                             | 3 min          |
| `golden.mjs`                                  | 1.1, 4.4 to 4.7, 6.1 | A whole match, in order, with an assertion at every step: the fall, CRISIS, the resistance's orders with real clicks, refused orders, pause and menu, the timer, warnings and sounds, a replacement capital | 8 min          |
| `occupier.mjs`                                | 2.1                  | The other side: the capture banner and its sounds, the reward, the occupier's panel, the two-step Suppress, the troops that come home                                                                       | 3 min          |
| `matchend.mjs`                                | 6.2                  | The match ends during a CRISIS and a resistance                                                                                                                                                             | 4 min          |
| `presentation.mjs sizes\|backgrounds\|motion` | 4.2, 4.3, 4.6        | The CRISIS announcement at many sizes and densities, over several backgrounds, with reduced motion: geometry from the page, contrast measured on real screenshots                                           | 2 min per case |
| `multiclient.mjs`                             | 6.4 to 6.6           | Two real clients through the real game server: lobby, spawn, a fight, orders, reloads, state hashes compared, the server's log scanned                                                                      | 8 min          |

| `paid.mjs` | v0.8.0 | The paid capital in the real UI: nobody starts with one, the panel, the price, the purchase | 1 min |
| `cards.mjs` | v0.8.0 | The capital's side cards and building bar on a phone, a small window and with reduced motion: on screen, at the left, still when motion is reduced | 4 min |

v0.8.0: nobody starts with a capital, so `startMatch` buys both players' capitals (the same
order the picker sends) unless you pass `buyCapitals: false`; `multiclient.mjs` buys with
real clicks.

## The human sessions

```
node scripts/playtest/purchase.mjs            # v0.8.0: buy your capital, strain, bonuses, a raid, a replacement
node scripts/playtest/purchase.mjs --nukes    # the raider launches atom bombs; build a SAM
node scripts/playtest/purchase.mjs --gold 0   # save for it: watch the bar and the strain countdown
```

`purchase.mjs --selftest` plays the session with a script and checks it (no human). The sessions
below are the v0.7.0 ones; they now start with both capitals already bought.

```
node scripts/playtest/rig.mjs defender --raider strong
```

See `rig.mjs` (or run it with no arguments) and the human sessions in the plan. The rig runs
against your own dev client (`http://localhost:9000/`) by default; Solo does not use your dev
game server. It writes a timeline (state, messages, orders, the CRISIS clock) next to the
other output.

## Notes

- `hooks.js` is injected into every page. It only observes (and queues intents for **solo**
  matches: in a real match an injected intent would reach one client and desync it).
- A dev game server started before the Capital System's server code landed does not know the
  setting: Create Match lobbies on it have none. Restart `npm run dev` (the Vite client
  hot-reloads; the game server does not).
- Do not write to the repository while a run against your own dev client is going: Vite
  hot-reloads and a match in progress is lost. Runs through `stack.sh` are unaffected.
