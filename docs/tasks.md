# Mass Image Compressor Web: Tasks

A sequential build plan. Each task is sized for one agent session: large enough to be a coherent unit of work, small enough that the whole task fits comfortably in context alongside the code it touches.

## Repository layout

```
docs/
  functional-design.md
  technical-design.md
  assumptions.md
  task-notes/
    T01.md, T02.md, ...
3rd_party_licenses/
src/
LICENSE
```

## How to work through this list

Tasks run in order. A task's dependencies are always earlier in the list, so "the previous task is done" is sufficient to start.

Before starting any task:

1. Read `docs/functional-design.md` for every requirement ID the task names.
2. Read the Technical Design section the task names.
3. Read the handover notes of the two or three most recent completed tasks. Not all of them.

A task is finished when its **Done when** conditions all hold and its handover note is written. Not before.

### Handover notes

Every task writes `docs/task-notes/T<nn>.md` before finishing. This file is how the next agent avoids rediscovering what you learned.

```markdown
# T<nn> — <title>

**Status:** complete | complete with caveats | blocked

## What was built
Two or three sentences. What exists now that did not before.

## Files touched
Paths, with one line each on what they do.

## Decisions made
Anything you chose that the design documents did not specify.
State the alternatives you rejected and why. If you made no such
decision, write "none".

## Surprises
Anything that did not behave as the design documents predicted.
Measurements that differ from the Assumptions Register. APIs that
did not work as described. Write "none" if nothing.

## What the next task should know
Gotchas, partial work, conventions you established that are not
yet written down elsewhere.

## Requirements covered
R-xx, R-yy. And any requirement you could not satisfy, with the reason.
```

### Rules

**Do not invent requirements.** If the design documents do not answer a question, the answer is not yours to choose silently. Small implementation choices go in the handover note under Decisions made. Anything that changes user-visible behaviour is a blocker: stop, write the note with status `blocked`, and state the question.

**When measurement contradicts the Assumptions Register, update it.** The register is a living document. Change the entry in place, record the new confidence and evidence, and note it under Surprises. An assumption that fails may invalidate a Technical Design decision; if it does, say so rather than quietly working around it.

**Principles outrank requirements.** Functional Design §1.4. If a requirement conflicts with a principle, the requirement is wrong. Flag it rather than implementing it.

**Tests are part of the task, not a later task.** A task that adds a pure function adds its unit tests. There is no cleanup phase at the end of this list.

---

# Phase 0 — Verification

These settle assumptions that decide architecture. Running them first prevents building on a wrong answer.

### T01 — OPFS streaming and download memory behaviour

**Assumption:** B4, the largest unknown in the project. Also E1.
**Technical Design:** §9.2

Build a throwaway Playwright harness, outside `src/`, that writes a large file into OPFS in chunks and downloads it.

- Write 1 GB, then 3 GB, in chunks, into OPFS.
- Trigger a download of the finished file.
- Record peak tab memory during the write and during the download.
- Repeat on Chromium, Firefox and WebKit.

**Done when:** `docs/task-notes/T01.md` records peak memory per browser per phase, and `assumptions.md` entries B4 and E1 are updated with measured evidence and a revised confidence. If B4 fails, the note states which of the two fallbacks in Technical Design §9.2 applies per browser.

### T02 — AVIF encode speed on real photographs

**Assumption:** D7, currently 95% but measured on synthetic noise.
**Technical Design:** §7.3

Assemble twenty real photographs of varied content. Encode each at `heic:speed` 6, 7, 8 and 9, at quality 70.

- Record size and time per setting.
- Compare quality with a perceptual metric, not by eye alone.

**Done when:** the note recommends one speed setting with the data behind it, `assumptions.md` D7 is updated, and Technical Design §7.3 carries the chosen value rather than a range.

### T03 — WASM memory reclamation in a browser

**Assumption:** C2, currently 75% on a weak proxy.
**Technical Design:** §8.2

In a browser, process images of increasing size through ImageMagick WASM, disposing between each. Read `WebAssembly.Memory.prototype.buffer.byteLength` and tab memory after each.

- Include at least one image above 40 megapixels.
- If the heap does not return, find how many large images can be processed before failure.

**Done when:** C2 is updated with measured evidence, and the note states either that no worker recycling is needed or the pixel budget after which a worker must be replaced.

---

# Phase 1 — Foundation

### T04 — Project scaffold

**Technical Design:** §1, §2

Vite, Vue 3, TypeScript in `strict` with `noUncheckedIndexedAccess`, Pinia, Vitest, Prettier, ESLint, `vue-tsc`. Directory structure exactly as Technical Design §2.

- All of `vue-tsc`, ESLint and Prettier run in a single `npm run check`.
- A trivial passing test proves Vitest resolves modules the same way the build does.

**Done when:** `npm run check` and `npm test` both pass on a clean checkout, and the directory tree matches §2.

### T05 — Playwright and CI

**Technical Design:** §13

Playwright configured for Chromium, Firefox and WebKit. CI runs `check`, unit tests and browser tests.

**Done when:** a placeholder browser test passes on all three engines in CI.

### T06 — Licence and attribution scaffold

**Technical Design:** §7.2
**Requirements:** R-V4

- `LICENSE` at root, AGPL v3.
- `3rd_party_licenses/` populated with the directory per component listed in §7.2.
- Licence texts for statically linked components sourced from upstream. These are not in `node_modules` and a dependency walker will not find them. aom needs its PATENTS file as well as LICENSE.
- A script that lists any bundled component without a licence directory.

**Done when:** every component in the §7.2 table has a directory with real upstream text, and the script reports nothing missing.

### T07 — Design tokens and base styles

**Functional Design:** §14.1, §14.2, R-L4
**Technical Design:** §11

Colour tokens, type scale, radii, spacing. System font stacks only, one proportional and one monospace — no bundled webfont, per §14.2.

- Logical properties only: `inline-start`, `inline-end`, `padding-inline`. No `left` or `right` in layout rules.
- A lint rule that fails on physical direction properties in stylesheets.

**Done when:** a demo page renders every token, and the lint rule catches a deliberately added `margin-left`.

### T08 — i18n scaffold

**Functional Design:** R-L1, R-L2, R-L5
**Technical Design:** §11

`i18n/en/messages.json` and `i18n/en/context.json`, the translation function, and the CI check that fails when a key exists in one file but not the other.

- Parameterised strings only. A lint rule or test that catches runtime concatenation of translated fragments.

**Done when:** the CI check fails on a deliberately orphaned key, and a component renders a parameterised string correctly.

---

# Phase 2 — Domain

Pure logic. No DOM, no Vue, no browser APIs. Every task here is fully unit-testable, and the tests are the specification.

### T09 — Core types

**Technical Design:** §3

`ImageRecord`, `EditRecord`, `EditOp`, `Job`, `ResolvedSettings`, `Format`, `FailureReason`, `Caveat`, and the id types.

- `EditOp` is a discriminated union and `EditRecord.ops` is an ordered array, per §3.5. Do not collapse it to named fields even though the UI currently produces only two operations.

**Done when:** types compile and a fixture of each shape exists for later tests.

### T10 — Size formatting

**Functional Design:** R-X32, R-X33, R-L3
**Technical Design:** §9.3

`domain/sizes.ts` exporting **two** formatters that must never be merged.

- Report formatter: 1024-byte units, two decimals, always dot-decimal, locale-independent.
- UI formatter: through `Intl.NumberFormat`.

**Done when:** a test asserts the report formatter produces identical output under `en-US`, `de-DE` and `hi-IN`, and that the UI formatter does not.

### T11 — Format routing

**Functional Design:** R-F1 to R-F8, R-I8
**Technical Design:** §4.1

`domain/format.ts`. Resolves the batch format setting to a per-image output format.

- "Don't change" per image.
- Non-encodable input resolves to JPEG.
- Animated source with a still-only format resolves to animated WebP, and reports the substitution as a caveat.
- Animated AVIF rejected.
- Alpha capability per format.

**Done when:** a table-driven test covers every combination of input format, animated flag and format setting.

### T12 — Output naming

**Functional Design:** R-X21, R-X22, R-X43, R-X44
**Technical Design:** §9.4

`domain/naming.ts`.

- Under "Don't change" the original extension is reproduced byte for byte including case. `photo.JPG` stays `photo.JPG`; `image.jpeg` does not become `image.jpg`.
- On format change, the canonical extension.
- Collisions resolved per directory, not globally. `a/photo.jpg` and `b/photo.jpg` never collide.

**Done when:** tests cover mixed-case extensions, format conversions that map two inputs onto one name, and a folder tree that must produce no renames.

### T13 — Crop and rotation arithmetic

**Functional Design:** R-C1 to R-C12
**Technical Design:** §6

`domain/edit.ts`. The heart of Edit mode and entirely pure.

- `fitScale`, `drawScale`, output dimensions, typed-dimension inverse, spill detection, ratio locking, quarter-turn rotation with dimension swap and refit.
- The rectangle is normalised to source fractions, not pixels.

**Done when:** the worked example table in Technical Design §6 passes verbatim as a test fixture, including the 8000×6000 spill row, and rotation composes correctly on top of it.

### T14 — Settings resolution

**Functional Design:** R-D1 to R-D4, R-Q1 to R-Q5, R-Q11, R-Q12, R-C17
**Technical Design:** §4.1, §7.4

`domain/job.ts`. Batch settings become per-image resolved settings.

- Crop overrides the dimension rule; rotation does not.
- PNG quality rescale `70 + (q - 10) × 30 / 90`, lossless from 85.
- Lossless above 95 for other formats.
- Alpha flattening decision and fill colour.

**Done when:** a table-driven test covers the PNG curve at 10, 40, 70, 85, 86 and 100, and every crop-versus-dimension combination.

### T15 — Caveats and the report model

**Functional Design:** R-X34, R-X35, R-X36, R-X37, R-X46
**Technical Design:** §9.3

`domain/report.ts`. The model, and YAML serialisation to the shape in §9.3.

- The caveat set is fixed and closed. Implement exactly the nine conditions in R-X46, no more and no fewer.
- Ordinary successes counted, not listed. Non-image files never mentioned. Relative paths throughout.
- Exact bytes on summary totals only.

**Done when:** a fixture run with failures, skips and four different caveats serialises to valid YAML that parses back to the same model.

### T16 — Input classification

**Functional Design:** R-I2, R-I4, R-I23, R-F8
**Technical Design:** §10.2

`domain/classify.ts`. Three buckets: supported image, image we cannot handle, not an image.

- Magic bytes, not extensions. A JPEG named `.png` is a JPEG.
- APNG detected by the `acTL` chunk. This is load-bearing: ImageMagick's PNG reader silently returns one frame otherwise.
- Animated AVIF detected and rejected.

**Done when:** tests cover a mislabelled JPEG, a single-frame PNG, an APNG, an animated AVIF, a PSD and a docx.

---

# Phase 3 — Platform

Thin wrappers over browser APIs, each independently testable in Playwright.

### T17 — Capability detection

**Technical Design:** §10.1, §10.3, §12

`platform/capability.ts`. Feature detection, never user-agent sniffing.

- OPFS availability, including the private-browsing case.
- Folder picker availability.
- `crossOriginIsolated`.

**Done when:** a browser test asserts correct detection on all three engines, and in a private window where the runner supports it.

### T18 — File and folder selection

**Functional Design:** R-I24 to R-I32, R-I31
**Technical Design:** §10.1
**Assumption:** B5

`platform/picker.ts` and `platform/folder.ts`.

- File picker, folder picker, and drop handling for both files and directory entries.
- Recursive traversal retaining `webkitRelativePath`.
- Hidden and system files skipped silently: dot-prefixed, `Thumbs.db`, `desktop.ini`.
- Symlinks not followed. Depth cap enforced.
- Where folder selection is unavailable, the capability flag reports it so the UI can hide the control rather than fail.

**Done when:** a browser test selects and drops a nested fixture tree on all three engines and produces identical file lists, and B5 is updated with what iOS-equivalent WebKit actually did.

### T19 — Origin-private storage

**Functional Design:** R-X38, R-X40, R-X42
**Technical Design:** §9.2
**Depends on:** T01's findings

`platform/opfs.ts`. Write, read, delete, and quota preflight via `navigator.storage.estimate()`.

- Cleanup on application start, on leaving the Processing view, and after download.
- The in-memory fallback path for private browsing.

**Done when:** a browser test writes, reads back and deletes a multi-hundred-MB file on all three engines, and the fallback engages when OPFS is absent.

### T20 — Thumbnails

**Functional Design:** R-G3, R-G4, R-G9, R-G10, R-G12
**Technical Design:** §10.4
**Assumption:** C5

`platform/thumbnails.ts` using `createImageBitmap` with both dimensions bounded as the primary path. Use
ImageMagick's thumbnail operation only as a fallback for supported inputs the browser cannot decode
natively, not the full processing pipeline.

- Lazy, for visible and near-visible tiles only. A batch may start at most `maximumThumbnails` source reads
  and retain at most that many thumbnail Blobs. Read this value from the shared runtime limits
  configuration, with a shipped default of 100; do not hard-code it in the service, UI or tests. Once
  spent, the budget is not replenished by eviction; uncached tiles use placeholders without reporting an
  error.
- The generation owner is Gallery grid mode. Leaving Gallery or switching to list mode clears queued work,
  stops the active job, and rejects raced completions. Use worker termination where the underlying decode
  cannot be cancelled directly.
- Thumbnails stored as encoded blobs in a non-reactive map, never in a store.
- Measure JPEG against WebP for generation time, retained bytes and peak memory; do not choose the encoded
  thumbnail format from intuition. Bound both axes, not only width.

**Done when:** time, retained Blob bytes and peak memory are measured over 50 mixed-size photographs; C5
is updated; and the note recommends the file-count threshold for R-G8 and the encoded thumbnail format. A
browser test injects a small limit and proves that scrolling starts no more than that many reads, uncached
tiles become placeholders without an error, revisiting cached tiles causes no reread, changing the runtime
limit requires no thumbnail-service change, and leaving Gallery during an active job leaves no thumbnail
worker or continuing CPU/memory growth.

---

# Phase 4 — Pipeline

### T21 — Worker protocol and pool

**Functional Design:** R-X8, R-X26 to R-X29
**Technical Design:** §5.1, §5.3

`pipeline/worker.ts` and the pool.

- Message protocol: job in, result or error out, with a monotonic token per job.
- Pool sized `min(hardwareConcurrency - 1, 3)` on desktop, 1 on mobile, read from one configuration module.
- Cancellation: between-jobs flag, discard-on-arrival by token, terminate-and-respawn as escape hatch.

**Done when:** a browser test proves a cancelled run stops after at most one further job, and that a superseded preview result is discarded rather than rendered.

### T22 — Codec loading

**Technical Design:** §5.2
**Assumption:** C8

`pipeline/codecs/loader.ts`. Lazy initialisation per module.

- ImageMagick on first image added or on idle after first paint.
- gifsicle, oxipng, quantizer, UPNG loaded on first job that needs them.

**Done when:** a browser test asserts first paint is not blocked by any WASM fetch, and that a GIF job triggers the gifsicle load and a JPEG job does not. C8 updated with measured bundle and memory figures.

### T23 — Decode, orientation and colour

**Functional Design:** R-I9, R-I10, R-I11, R-I12 to R-I16, R-I35
**Technical Design:** §7.7
**Assumptions:** A13, D3, D4

`pipeline/stages/decode.ts`.

- EXIF orientation applied to pixels, output written upright with no orientation tag.
- The frame representation carries colour as **either** an ICC profile **or** CICP values. HEIC and AVIF commonly signal colour with an `nclx` box and no profile at all. Treating such an image as untagged sRGB shifts its colour silently.
- HEIC decoded as ordinary input, no capability branch.

**Done when:** the eight-orientation EXIF test set produces eight upright outputs including the mirrored cases, a CICP-signalled HEIC round-trips with correct colour, and A13, D3 and D4 are updated.

### T24 — Edit stages

**Functional Design:** R-C1 to R-C17
**Technical Design:** §4.2, §6

`pipeline/stages/edit.ts`. Consumes `EditRecord.ops` in order.

- Rotation before crop. Crop with spill and background fill. Alpha handling per output format.
- Walk the ops array generically. Do not special-case a rotate-then-crop pair.

**Done when:** outputs match `domain/edit.ts` predictions to the pixel for the §6 fixture table, and a spill crop produces the expected fill.

### T25 — Resize

**Functional Design:** R-N1, R-N2, R-D1
**Technical Design:** §4.2

`pipeline/stages/resize.ts`. Fit within long edge, fixed width, fixed height, and the crop override.

**Done when:** tests cover downscale, upscale, no-op when already within the limit, and a cropped image ignoring the dimension rule.

### T26 — Still encoding

**Functional Design:** R-Q5, R-Q6, R-Q7
**Technical Design:** §7.3, §7.4, §7.6

JPEG, WebP and AVIF.

- Effort settings from §7.3. AVIF uses the speed chosen in T02, never the library default.
- R-Q6: below 96, WebP encodes both ways and keeps the smaller, with the content gate.

**Done when:** the D2 measurements reproduce, the gate skips the lossless attempt on photographs, and the smaller output is kept in both directions.

### T27 — PNG path

**Functional Design:** R-Q11, R-Q12, R-Q14
**Technical Design:** §7.1, §7.3
**Assumption:** D8

libimagequant, then oxipng at level 2.

- R-Q14: compare quantized against lossless and keep the smaller.
- Verify the 70 floor produces no visible banding at the lowest reachable setting. If it does, raise the floor and record it.

**Done when:** ten representative PNGs are measured, D8 is updated, and the note states whether the R-Q11 floor should change.

### T28 — GIF path

**Run this after T29.** Its Done-when needs animated fixtures, but only single-frame decode existed
when this list was written, so whichever of the two goes first has to build the multi-frame
representation and pay C7's memory measurement. That work belongs in T29, whose Done-when is already
written about frames, delays and loop count; this task then consumes it. Execution order is
T27 → T29 → T28 → T30. Decided in T27, with the user.

**Functional Design:** R-Q8
**Technical Design:** §7.3
**Assumption:** A7

ImageMagick produces the GIF, gifsicle compresses it at `-O2` with `--lossy` derived from quality.

**Done when:** output is measurably smaller than ImageMagick's GIF writer alone on animated fixtures, and A7 is updated with executed evidence.

### T29 — Animated paths

**Run this before T28**, and see the note there for why. This task owns the multi-frame
representation — §4.2's `decode-frames`, `edit-frames`, `resize-frames` — which the GIF path then
reuses.

**Functional Design:** R-F5, R-Q9, R-Q10, R-B6
**Technical Design:** §4.2
**Assumption:** C7

Animated WebP through ImageMagick. Animated PNG through UPNG assembly and apng-optimizer.

- Frame delays, loop count and disposal preserved. Frame count never reduced.
- Measure peak memory against frame count. If it scales linearly, say so, because it constrains the frame budget.

**Done when:** animated GIF, WebP and APNG fixtures round-trip with frame count, delays and loop intact, and C7 is updated.

### T30 — Size targeting

**Functional Design:** R-Q2, R-Q3, R-Q4
**Technical Design:** §7.5

Binary search over the quality parameter, capped at 8 iterations.

- Never upsize to meet a target. An image already smaller passes through untouched.
- Unreachable target keeps the smallest achieved result and records the caveat.
- Re-measure AVIF with the T02 speed setting and decide whether R-Q4 needs to disable any format.

**Done when:** iteration counts and wall times are recorded per format, D1 is updated, and R-Q4's exclusion list is decided from data.

---

# Phase 5 — Interface

### T31 — Shell and layout

**Functional Design:** §2, R-R1 to R-R5, R-A1
**Technical Design:** §1.1

Header, stage container, side panel, responsive behaviour at 900px, mobile drawer with focus trapping.

- Stage modes are exclusively mounted components, so leaving a mode unmounts its state. This is how R-M4 is satisfied automatically.

**Done when:** the panel is static above 900px and a drawer below, the primary action is visible in both, and the drawer traps focus and returns it on close.

### T32 — Stores

**Technical Design:** §3, §1.1

The four Pinia stores.

- Binary data lives in non-reactive module-scope maps, never in a store.
- A test asserts no store holds a proxied `File`, `Blob`, `ArrayBuffer` or `ImageBitmap`.

**Done when:** that test passes and the mode transition table in Functional Design §3.1 is encoded as store logic.

### T33 — Gallery, grid view

**Functional Design:** R-G1 to R-G6, R-G10, R-G12
**Technical Design:** §10.4

Empty state with both Select buttons and drop zone. Virtualized thumbnail grid. Tiles with badges and remove.

**Done when:** 500 fixture images scroll smoothly, thumbnails generate only for visible or near-visible
tiles, the source-read and retained-Blob counts never exceed the injected runtime limit, tiles outside the
spent budget show placeholders, leaving the grid stops thumbnail work, and removing one leaves others
untouched.

### T34 — Gallery, list view

**Functional Design:** R-G7 to R-G12

List view with relative paths, directory grouping for folder input, and the mode toggle with automatic selection by file count.

**Done when:** list mode decodes nothing at all and stops any grid thumbnail work when entered, grouping
reflects the source tree, and the automatic threshold uses the value T20 recommended.

### T35 — Side panel settings

**Functional Design:** §4.1 to §4.4, R-D2, R-D3

Quality with mode toggle and chips, the Dimension accordion, the Format dropdown, the primary action with its meta line.

- Exactly one dimension option active. Crop-override notes appear when they should.

**Done when:** every control writes to the settings store, the Dimension accordion allows only one selection, and the crop notes appear under the conditions in R-D2 and R-D3.

### T36 — Preview mode

**Functional Design:** R-P1 to R-P8, R-M3
**Technical Design:** §4, §5.3

Real encode on entry, Compressed tab by default, comparison toggle, transform line, stepper, Add more images.

- Debounce 300 ms. Superseded results discarded by token.
- The frame renders the encoded output directly rather than through a canvas, so the browser applies the colour profile (R-I16).

**Done when:** dragging the quality slider produces one encode rather than many, the size shown is measured rather than estimated, and stepping releases the outgoing working set before decoding the next.

### T37 — Edit mode

**Functional Design:** R-C1 to R-C17, R-K4
**Technical Design:** §6

Rotation buttons, crop rectangle with handles, ratio row, zoom slider, background row when spill exists, Apply, Cancel, Remove edit.

- Background control is swatches plus a colour picker. No numeric RGBA fields.
- Keyboard: move and resize the rectangle, Escape cancels, Enter applies.

**Done when:** the on-screen output dimensions match `domain/edit.ts` exactly, Cancel restores every value including rotation, and the background row appears only on spill.

### T38 — Processing view

**Functional Design:** §6.1 to §6.4, R-X26, R-X27
**Technical Design:** §5.3

Counter, donut, running reduction total, failure list, Cancel, then Download and Back to images.

- Every number in the donut also present as text. No information exists only inside it.
- Cancel reads Stopping after being pressed, and the run halts after at most one more image.

**Done when:** a run with deliberate failures continues to completion, reports correct counts, and the donut's data is fully readable as text with the chart hidden.

### T39 — Errors and rejections

**Functional Design:** §10, R-E1 to R-E3, R-I20, R-I21

Selection-time rejection list, per-image failure marking, and every condition in the §10 table.

- One dismissible list, not one alert per file.
- Every message names the file and states what to do next. "Something went wrong" appears nowhere.

**Done when:** each row of the §10 table has a test that triggers it and asserts the message content.

---

# Phase 6 — Output

### T40 — Archive assembly

**Functional Design:** R-X30, R-X38, R-X39, R-X40
**Technical Design:** §9.1, §9.2
**Depends on:** T01, T19

`client-zip` streamed into OPFS as the run proceeds. Quota preflight using `predictLength`.

- Entries stored rather than deflated for already-compressed formats, per entry.
- Compression starts on the primary action, not on Download, unless T01 forced the Chrome fallback.

**Done when:** a 200-image run holds memory near one entry, the preflight rejects an oversized batch before starting, and the archive opens correctly with its directory structure intact.

### T41 — Report generation

**Functional Design:** §6.6, R-X31
**Technical Design:** §9.3
**Depends on:** T15

Wire the report model to real run data and write it into the archive.

**Done when:** a run producing failures, skips and caveats writes a report whose totals reconcile against the exact byte counts, and which parses as YAML.

### T42 — Download and leaving

**Functional Design:** R-X15 to R-X20, R-X41, R-X42, R-K9

Explicit Download. Single image downloads directly with no ZIP and no report. The three-way confirmation on leaving with undownloaded results. Cleanup.

**Done when:** a single-image run downloads one image file, a multi-image run downloads a ZIP, the confirmation offers all three actions with Stay focused by default, and no OPFS file survives any exit path.

---

# Phase 7 — Completeness

### T43 — Accessibility

**Functional Design:** §12, R-K1 to R-K9

Keyboard operation throughout, live-region announcements, accessible names, reduced motion, no information carried by colour alone.

**Done when:** every flow is completable by keyboard alone, an automated audit passes on each stage mode, and run progress announces at intervals rather than per image.

### T44 — Language completeness

**Functional Design:** R-L1 to R-L5
**Technical Design:** §11

Every user-facing string extracted with context. A pseudo-locale for testing.

- A test renders every screen in a right-to-left pseudo-locale and asserts no physical-direction layout leaks.
- A test asserts the report is unaffected by interface locale.

**Done when:** no literal user-facing string remains in any component, and both tests pass.

### T45 — Privacy, credits and source

**Functional Design:** R-V1 to R-V4
**Technical Design:** §7.2

The local-processing line, the credits page listing every bundled component with licence and source link, and the link to the application's own source.

**Done when:** a test asserts no network request carries image bytes, file names, dimensions or sizes, and the credits page covers every directory in `3rd_party_licenses/`.

### T46 — Limits

**Functional Design:** §5.7, R-I19 to R-I22, R-I33
**Technical Design:** §8.3
**Assumptions:** C3, C4

One runtime configuration module holding every limit, including `maximumThumbnails`. Selection limits are
enforced at selection time; operational limits such as the thumbnail budget are injected into their
owning service.

- Derive values by measurement on desktop and on a real phone. The 200-file figure inherited from the original design draft is not defended by anything.
- C4 needs a physical iPhone, including an older low-memory model.

**Done when:** every limit has a measured value with its evidence, C3 and C4 are updated, and Functional Design §5.7 carries real numbers instead of placeholders.

### T47 — End-to-end suite

**Technical Design:** §13

The full fixture set and journeys across three engines: single image, mixed batch, folder tree, animated batch, a run with failures, cancellation, and leaving without downloading.

**Done when:** the suite passes on all three engines in CI and takes an acceptable time to run.

---

# Phase 8 — Release

### T48 — Build and deploy

**Technical Design:** §12
**Assumptions:** B6, B9

Production build, content-hashed WASM with long cache lifetimes, deployment to Hostinger, `.htaccess` headers.

- Verify COOP and COEP actually apply and that `crossOriginIsolated` is true. If headers cannot be set, the threaded build is unavailable and single-threaded is the baseline.
- Locale routing as real paths with `hreflang`.

**Done when:** the site serves over HTTPS, headers verified by fetching them, B6 and B9 updated, and first paint measured on a throttled mobile connection.

### T49 — Licence compliance audit

**Technical Design:** §7.2
**Assumption:** A12

Final pass before release.

- Every bundled component, including everything statically linked inside the ImageMagick WASM, has its licence text committed and is credited.
- The gifsicle question in A12 has a recorded answer. If it went against us, remove gifsicle and fall back to ImageMagick's GIF writer.
- No module is shared with the proprietary desktop product.

**Done when:** the audit script reports nothing missing, A12 records a decision rather than a question, and the note confirms the desktop firewall holds.
