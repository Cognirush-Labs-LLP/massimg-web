# T39-A — Web Share harness

Settles assumption **E4** (`docs/assumptions.md`): does multi-file `navigator.share({ files })`
safely hand off OPFS-backed outputs on real browsers? Needs real devices — "Playwright engine
presence is not evidence for a native share sheet" (`docs/tasks.md`, T39-A). There is no automated
`run.mjs` here; every share/cancel/fail interaction is done by hand, on-screen.

**This pass covers Android Chrome (real device), Windows Edge/Chrome, and macOS Safari/Chrome.**
iOS Safari needs a physical iPhone, which T50 already requires for C4 and which explicitly re-runs
these same cases — see that task before improvising an iOS Simulator run; a Simulator doesn't
reproduce the real memory/termination behaviour E4 is actually about.

## Running it

No install step — `server.mjs` has zero dependencies.

```sh
cd verification/t39a-web-share
node server.mjs
```

Prints the URL and reachability hints. The server listens on a **fixed** port, `8787` by default
(override with `PORT=...`), because Android port-forwarding needs the same literal port on both
ends.

### Reaching it from each target

- **macOS / Windows** — these are full OSes, not phones. Copy or clone this folder onto that
  machine and run `node server.mjs` there, then open `http://localhost:8787` directly in every
  browser installed. No forwarding needed, and this sidesteps the secure-context problem a plain
  LAN IP would hit (Web Share and OPFS both require a secure context; a bare LAN IP over HTTP is
  not one, but `localhost` always is).
- **Android** — the one target that can't run Node itself. Enable Developer Options → USB
  debugging, connect by USB, then:
  ```sh
  adb reverse tcp:8787 tcp:8787
  ```
  Open `http://localhost:8787` in Chrome on the phone — treated as a secure context exactly like
  real `localhost`, no certificate or tunnel needed.
- **iOS (for T50, not this pass)** — the equivalent of `adb reverse` is `libimobiledevice`'s
  `iproxy`: `brew install libimobiledevice`, then `iproxy 8787 8787` over USB, then open
  `http://localhost:8787` in Safari. Noted here so T50 doesn't have to rediscover it.

## What the page does

- **Capability probe** — raw `'share' in navigator` / `'canShare' in navigator`, a real OPFS
  functional probe, and a generic non-empty-file `canShare` probe (the `Capabilities.fileShare`
  shape from Technical Design §9.1).
- **Build a file set** — real JPEG/PNG/WebP/AVIF/GIF bytes fetched from `/fixture/:format` (streamed
  live from `PHOTO_FIXTURES_DIR`, never copied into the repo) and written into OPFS (or, with the
  OPFS checkbox off, built directly as in-memory `File`s — the private-browsing-fallback path).
- **Synthetic padding set** — zero-filled blobs of an exact target size, tagged with a chosen MIME
  type, for finding the total-byte rejection boundary without needing more real fixtures. Content is
  irrelevant to `canShare`/`share()`, which only look at `File.type` and size.
- **Exact `canShare`** and **Share** (fresh click, and a delayed variant that deliberately breaks
  the fresh-activation requirement to force a deterministic non-cancellation failure) — every
  outcome is logged on-screen and POSTed to `/results`, which appends it to `results.json`.
- A **crash marker**: right before a risky write or share, the page records intent in
  `sessionStorage` and clears it on success. If the page reloads with that marker still set, it
  logs and records that the previous attempt did not complete cleanly — useful on engines with no
  memory API (Safari).

## Test matrix — run this checklist on every browser you have

For each browser: probe capabilities once, then run each row, noting the on-screen log (it's also
in `results.json` afterward). Use the device note field at the top so results are attributable.

1. 1 file, each single format (JPEG, PNG, WebP, AVIF, GIF) — canShare, then Share (fresh click),
   deliver to a real target if possible.
2. 2 files, mixed formats — canShare, then Share.
3. 10 files, mixed formats — canShare, then Share.
4. Share now, then press **cancel** in the native sheet — confirm it logs `cancelled`, not `failed`.
5. **Share after 3s delay** — confirm it logs `failed` with a real error name/message, not
   `cancelled`.
6. Synthetic padding: ramp the target MB up (e.g. 50 → 100 → 200 → 500 → 1000) and re-run canShare/
   Share at each step until either is rejected or the tab visibly struggles. Record memory (or
   survival) at each step.
7. Repeat 1–3 with the OPFS checkbox off (in-memory fallback), and once in a real private/incognito
   tab (where the capability probe should report `opfs: false` on its own).

## After running

Hand the accumulated `results.json` (or a description of what happened) back so
`docs/task-notes/T39-A.md` and assumption E4 can be written up from real evidence.
