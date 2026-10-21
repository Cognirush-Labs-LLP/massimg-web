# T50 — ImageMagick resource limits as a decompression-bomb guard

Settles the safety half of assumption **C3** (`docs/assumptions.md`): when a file declares an image
far larger than the device can hold, does ImageMagick's own `ResourceLimits` turn that into a
catchable error in every engine, with the WASM instance still usable afterwards?

Everything is synthetic. A few-hundred-byte to tens-of-KB file declares an enormous image; only the
declared size and how little data backs it matter.

```sh
pnpm install
pnpm test            # copies the x86 build into public/vendor, then runs every engine and variant
node run.mjs chromium guard           # one engine, one variant
node calibrate.mjs                    # bytes of `memory` limit ImageMagick charges per pixel
node calibrate-frames.mjs             # listLength needed per animation frame
node scripts/make-fixtures.mjs        # rebuilds public/fixtures/ (the committed tests/fixtures/limits/ are copies)
```

`run.mjs` runs each fixture in a fresh page per engine and per limits variant, then decodes a known-good
image in the same page to show whether the instance survived. Results: `results.json`.

## What it found

See `docs/assumptions.md` C3 for the full record. In short: the defaults allow bombs (a 1.6-gigapixel
PNG decodes on Firefox and WebKit; a 3000-frame GIF aborts the instance with `exit(1)`); `area` and
`memory` do nothing unless `disk = 0` stops the cache spilling into the WASM heap; with the combined
guard every bomb fails in a few milliseconds with a catchable error on all three engines.

## Device runs

`android-ramp.mjs` runs the real pipeline worker on a real Android phone: the app's dev server is reached over `adb reverse`, the phone's Chrome is driven over CDP, and each step opens a fresh tab while a sampler reads the summed PSS of Chrome's renderer processes with `dumpsys meminfo`.

```sh
adb reverse tcp:5173 tcp:5173; adb reverse tcp:8790 tcp:8790
adb forward tcp:9222 localabstract:chrome_devtools_remote
(cd ../.. && pnpm vite --port 5173 --strictPort)      # leave the source tree alone while it runs
node scripts/make-android-fixtures.mjs && node scripts/make-anim-fixtures.mjs
node android-ramp.mjs [stepIdPrefix]                    # results: android-results.json
adb reverse --remove-all; adb forward --remove-all; adb shell svc power stayon false
```

Results and what they mean: `docs/assumptions.md` C3. `probe-cap.mjs`, `probe-anim.mjs` and `probe-anim2.mjs` are the desktop reproductions used to explain two surprises (the exclusive `area` limit, and hand-built one-pixel-frame GIFs that the animated-WebP encoder refuses).
