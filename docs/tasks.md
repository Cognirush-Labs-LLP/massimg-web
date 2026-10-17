# Mass Image Compressor Web: Tasks

A sequential build plan. Each task is sized for one agent session: large enough to be a coherent unit of work, small enough that the whole task fits comfortably in context alongside the code it touches.

## Repository layout

```
content/
  en/, es/, ...        public page markdown, English is the fallback (§12.4)
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

- The caveat set is fixed and closed. Implement exactly the eight conditions in R-X46, no more and no fewer; T36-A moved an unreachable size ceiling to structured Skipped reporting.
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

### T31 — Shell, routing and static generation

**Functional Design:** §2, R-R1 to R-R5, R-A1, R-S1
**Technical Design:** §1.1, §2, §12.2, §12.3
**Assumption:** F1

The largest task in this phase, and deliberately so: it replaces the placeholder root
that T04 through T08 have been building against, and the app's shape afterwards is what
every later interface task builds inside. Two halves.

**The app becomes a routed, statically generated site.** `src/config/site.ts` holding the
canonical base URL (env-driven), the supported-locale list and the default locale.
`vue-router` with the tool at `/`; the content routes arrive with their pages in T44.
`vite-ssg` replacing the `createApp(...).mount()` entry, so each route is rendered to
real HTML at build time.

- **Settle F1 here, not later.** It is 70% confident and the whole §12 SEO surface rests
  on it. Build the site, fetch a route's HTML file from disk, and assert its content is
  present without executing any script. If vite-ssg cannot do that, this is the moment to
  substitute a different prerenderer — while one route exists rather than twelve tasks of
  interface.
- **Everything after this is authored under a build-time rendering constraint.** vite-ssg
  runs each route in Node, so `window`, `document`, `navigator`, WASM, workers and OPFS
  are unavailable during that pass and belong in client-only lifecycle hooks. The
  existing `scheduleImageMagickPreload()` call in `main.ts` moves accordingly. Getting
  this right now is nearly free; retrofitting it across T32 to T42 is not.

**The compressor's own shell, inside that route.** Header, stage container, side panel,
responsive behaviour at 900px, mobile drawer with focus trapping.

- Stage modes are exclusively mounted components, so leaving a mode unmounts its state. This is how R-M4 is satisfied automatically.
- The tool is one route; its four stage modes are internal state and never become URLs (R-S1).
- Removes the T07 and T08 demo components parked on the placeholder root, as both of those handover notes anticipated, and rewrites the placeholder e2e test T05 flagged.

**Done when:** the panel is static above 900px and a drawer below, the primary action is
visible in both, the drawer traps focus and returns it on close, a production build emits
a static HTML file for the tool route whose content is present without JavaScript, and F1
is updated with that result.

### T32 — Stores

**Technical Design:** §3, §1.1

The four Pinia stores.

- Binary data lives in non-reactive module-scope maps, never in a store.
- A test asserts no store holds a proxied `File`, `Blob`, `ArrayBuffer` or `ImageBitmap`.

**Done when:** that test passes and the mode transition table in Functional Design §3.1 is encoded as store logic.

### T33 — Gallery, grid view

**Split into T33-A and T33-B** when T33-B/T34's planning surfaced that no earlier task turns a
picked/dropped `File` into an `ImageRecord` in the batch store (T18 deliberately stopped short of
this; T32 confirmed it didn't add it either) — a prerequisite both the grid and list views need,
decided with the user to be built once as shared infrastructure rather than inside the grid task.
See `docs/task-notes/T33-A.md` for the full rationale and decisions.

#### T33-A — Gallery infrastructure

**Functional Design:** R-G1 to R-G3, R-G5, R-G6, R-I3
**Technical Design:** §1.1, §10.1, §10.2

Selection ingest (classify → `ImageRecord` → `useBatchStore`), binary source-file storage
(`platform/source-files.ts`), a lazy/killable background dimension-probe service (`W×H` resolved
in the background, never blocking selection, stopped the instant Processing starts), the
batch-wide `Clear` action, capability-gated controls (R-I31), and the empty state and toolbar UI
shared by both the grid (T33-B) and list (T34) views — everything except the virtualized grid
body itself.

**Done when:** selecting or dropping files/folders produces real `ImageRecord`s in the batch store
with `width`/`height` starting unresolved and updating once the background probe completes, a file
the build cannot classify is skipped without blocking the rest of the selection (R-I3), Clear
empties the batch with no confirmation and releases every source file, and the dimension-probe
worker is provably terminated (no further callbacks, no continuing worker) the moment the stage
mode becomes `processing`.

#### T33-B — Gallery, grid view

**Functional Design:** R-G1 to R-G6, R-G10, R-G12
**Technical Design:** §10.4
**Depends on:** T33-A

Virtualized thumbnail grid body, plugged into T33-A's empty state/toolbar/ingest. Tiles with
thumbnails, badges (`EDITED`/`ANIMATED`/`SKIPPED`/`FAILED`) and remove.

**Done when:** 500 fixture images scroll smoothly, thumbnails generate only for visible or near-visible
tiles, the source-read and retained-Blob counts never exceed the injected runtime limit, tiles outside the
spent budget show placeholders, leaving the grid stops thumbnail work, and removing one leaves others
untouched.

### T34 — Gallery, list view

**Functional Design:** R-G7 to R-G12
**Depends on:** T33-A

List view with relative paths, directory grouping for folder input, and the mode toggle with automatic
selection by file count, added into T33-A's shared toolbar.

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

- Debounce 1000 ms. Superseded results discarded by token.
- The frame renders the encoded output directly rather than through a canvas, so the browser applies the colour profile (R-I16).

**Done when:** dragging the quality slider produces one encode rather than many, the size shown is measured rather than estimated, and stepping releases the outgoing working set before decoding the next.

### T36-A — Hard size ceiling and recovery

**Functional Design:** R-Q3, §3.2, §3.3, §6.3 to §6.6, §10
**Technical Design:** §3.1, §3.3, §3.5, §4, §5.3, §7.5.1
**Depends on:** T36

Turn Size into a hard per-image ceiling. Replace oversized successes and the old caveat with a typed
`size-target-unreachable` metadata result; Preview replaces the image frame with its warning, while
run/packaging skips it.

- For one still image, use the Preview pool to check verified PNG→JPEG and smaller-dimension
  alternatives in order. After a verified dimension fit, derive one free next-lower standard-edge
  action without another probe. Dimension recovery must fit at quality 30 or better, and its
  standard-edge ladder extends through 4096 px. Results are metadata-only and actions remain
  advisory until clicked.
- Cancel the Preview pool queue on mode exit and resume it on re-entry; in-flight WASM may finish
  and be discarded, but repeated Gallery/Preview navigation must not accumulate queued recovery.
- Add the bounded eight-probe dimension planner and the trailing post-crop resize edit operation.
- Add skipped run/image/report state and the `SKIPPED` Gallery badge. Do not reuse the worker
  protocol's cancellation-time `skipped` message.
- Update Functional, Technical and UI Design, the existing FAQ answers, D10 and downstream tasks.

**Done when:** every emitted size-targeted output is at or below its target; unreachable run jobs
carry no output bytes; single-still actions appear only after verified fits at the recovery quality
floor; batches and animations dispatch no recovery jobs; crop composition survives a recovery resize;
skipped totals/reporting exclude their bytes; and the bounded-search, Preview, pool and three-engine
regression tests pass.

### T37 — Edit mode

**Functional Design:** R-C1 to R-C17, R-K4
**Technical Design:** §6

Rotation buttons, crop rectangle with handles, ratio row, zoom slider, background row when spill exists, Apply, Cancel, Remove edit.

- Background control is swatches plus a colour picker. No numeric RGBA fields.
- Keyboard: move and resize the rectangle, Escape cancels, Enter applies.
- Consume T36-A's trailing resize operation: Cancel preserves it, applying changed crop geometry
  removes it, and Remove edit clears it with the other operations.

**Done when:** the on-screen output dimensions match `domain/edit.ts` exactly, Cancel restores every value including rotation, and the background row appears only on spill.

### T37-A — Same-format output selection

**Functional Design:** P5, R-P5, R-X24, R-X45, R-X46
**Technical Design:** §4, §4.2, §7.5
**Depends on:** T30, T36, T37

Apply the source-vs-encoded byte decision once inside the shared pipeline, after each format has
produced its best candidate. Same-format outputs with no edit and no actual dimension change keep
the source-side candidate whenever the encode is equal or larger; PNG/APNG first losslessly
optimises that source candidate. Requested transformations retain their encoded bytes and record a
larger-output warning when applicable. Preview renders the selected bytes and states when the
original or losslessly optimised original was used.

**Done when:** quality and size jobs, still and animated paths, Preview and run intent all make the
same selection; no-op dimension rules qualify while real transformations do not; exact ties keep
the source; R-X45 caveats contain measured sizes; Preview's figures and disclosure describe the
selected bytes; the real `bapu.jpg` regression shows 0% change and the original-kept disclosure;
and the domain, report, component and three-engine worker/Preview regressions pass.

### T36-B — Pixel-density-matched tab switching and forced regenerate switch

**Functional Design:** R-P9, R-P10 (new)
**Technical Design:** §4 (new subsection on the inspector's coordinate space)
**Depends on:** T36, T37

Switching the Original/Compressed tab preserves on-screen pixel density, not apparent box size, from
the first view onward: a Compressed output viewed at its own 100% shows Original at the true fraction
of its own pixels that reproduces the same screen footprint, not at the same apparent size as before.
Density matching may exceed a tab's normal zoom ceiling rather than clamp it away. Any same-image
settings- or edit-driven regenerate (quality, format, dimension, rotation, crop) forces the Compressed
tab to the front at its own actual size, centred, so the user is never left looking at an Original
that does not match a change they just made; stepping to a different image still preserves the
selected tab (R-P7) untouched. This task also backfills Functional, Technical and UI Design for the
zoom/pan inspector itself (T36's own scope, built without ever being added to those documents).

- `domain/viewport.ts`'s canonical scale is pinned to the Original tab's own convention (Original
  always has 1:1 pixel correspondence with canonical space); only the Compressed-side projections
  convert scale, via a new `nativePixelsPerCanonicalPixel` ratio.
- Both tabs' predicted/decoded sizes are threaded through `usePreviewViewport`/`PreviewFrame` as a new
  `tabSizes` value, independent of which tab is actually showing, so the match works from the very
  first view (placeholder estimates) rather than only once both rasters have loaded.
- Rotation stays exempt from pixel-perfectness: it does not change pixel counts, only axis
  orientation, so no part of this task attempts to correct for it.

**Done when:** a tab switch at rest or any zoom level matches true pixel density per
`domain/viewport.ts`'s projection math; a density match can exceed the usual zoom ceiling; a same-image
settings/edit change lands Compressed at its own actual size, centred; stepping to a different image
does not force a switch; and the viewport, PreviewFrame, Preview and preview e2e regression suites
pass.

### T38 — Processing view

**Functional Design:** §6.1 to §6.4, R-X26, R-X27
**Technical Design:** §5.3

Counter, donut, running reduction total, skipped/failure lists, Cancel, then conditional Download and Back to images.

- Every number in the donut also present as text. No information exists only inside it.
- Cancel reads Stopping after being pressed, and the run halts after at most one more image.
- Consume T36-A's result union. Count unreachable accepted images as Skipped, set structured
  `skipReason`, exclude them from output/savings, clear prior failed/skipped states at run start,
  and omit Download when no image succeeds.

**Done when:** a run with deliberate failures continues to completion, reports correct counts, and the donut's data is fully readable as text with the chart hidden.

### T39 — Errors and rejections

**Functional Design:** §5.1, §5.3, §10, R-E1 to R-E3, R-F8, R-I2, R-I3, R-I20,
R-I21, R-I23, R-I29, R-I30

Selection-time rejection list, per-image failure marking, and every condition in the §10 table.

- One dismissible list, not one alert per file.
- Every message names the file and states what to do next. "Something went wrong" appears nowhere.
- Keep the size-ceiling skip message and badge distinct from decode/encode/memory failures.
- The ordinary **Select images** / **Add images** picker uses `accept="image/*"`, remains
  `multiple`, and has no `capture` attribute. `accept` is a native-picker hint only: classification
  continues to inspect the file bytes and never trusts its extension or browser-supplied MIME type.
- Folder selection and drag/drop remain unfiltered at the browser boundary so every entry reaches
  the same classification path. Supported images are added, unsupported images become named
  rejection entries, and ordinary non-image files are skipped silently.
- Selection-time rejection entries live in `useBatchStore`; this task defines their final type,
  lifecycle, dismissal behaviour and clearing behaviour rather than introducing a separate store.
- A file classified as supported but found corrupt or undecodable during decode remains visible as
  a per-image failure. It is not rewritten as a selection-time rejection or a size-ceiling skip.
- A folder with no supported images is reported plainly. Traversal-depth and file-count breaches
  reject the selection before anything is added and name the actual value, cap and next action.

**Done when:** each row of the §10 table has a test that triggers it and asserts the message content;
the ordinary picker is tested with `accept="image/*"`, `multiple` and no `capture`; equivalent picker,
folder and drop inputs produce the same classification outcomes; and a mixed selection proves that
supported images are added, unsupported images (including camera raw and animated AVIF) are named in
the rejection list, ordinary non-images are absent from it, and decode failures remain distinct from
both selection-time rejections and size-ceiling skips. Folder-empty and traversal-cap tests assert the
reported figures and remediation.

---

# Phase 6 — Output

### T39-A — Multi-file Web Share verification

**Functional Design:** R-X47 to R-X53, R-V5
**Technical Design:** §9.1, §9.2, §13
**Assumption:** E4
**Depends on:** T39

Build a focused verification harness before adding the second output sink. Use real iOS Safari and
Android Chrome, plus every available shipping desktop implementation; Playwright engine presence is
not evidence for a native share sheet.

- Share 1, 2 and 10 OPFS-backed image files in one call, covering JPEG, PNG, WebP, AVIF, GIF and a
  mixed-format array. Record the preliminary and exact `canShare` results separately.
- Exercise a successful native handoff, user cancellation and a rejected/failed handoff. Confirm
  that `share()` runs from a fresh activation and that its resolved/rejected result matches the
  state the app can safely promise.
- Increase total payload bytes until rejection or the largest safe tested value. Measure process
  memory where the platform exposes it; otherwise record tab survival, reload and target receipt.
- Repeat the bounded cases through the in-memory fallback where private browsing makes OPFS
  unavailable.

**Done when:** `docs/task-notes/T39-A.md` contains the device/browser/target matrix, exact payloads,
memory or survival evidence, cancellation/failure results and a recommended `maximumShareBytes`;
E4 is updated in place; and any finding that makes ten files unsafe lowers the Functional Design
limit before T40 rather than being hidden behind implementation fallback.

### T40 — Archive and share-output assembly

**Functional Design:** R-X30, R-X38 to R-X40, R-X42, R-X47, R-X48, R-X51, R-X52
**Technical Design:** §9.1, §9.2
**Depends on:** T01, T19, T39-A

`client-zip` streamed into OPFS as the run proceeds. For a run that starts with 1–10 accepted
images and passes the preliminary file-share probe, tee each successful final output into a
separate run-scoped OPFS file without encoding twice or retaining the batch in memory.

- Entries stored rather than deflated for already-compressed formats, per entry.
- Compression starts on the primary action, not on Download, unless T01 forced the Chrome fallback.
- Accept only T36-A `output` variants as entries; skipped images never enter a direct output or ZIP.
- Skip ZIP creation for an exactly one-image run. For every larger run, retain the first success as
  the possible R-X16 direct-download result and release it after the second success unless the
  Share path still owns that same file.
- Replace OPFS's single archive slot with an idempotently cleaned run artifact set: archive,
  individual output handles and public name/MIME metadata. Keep the reduced-cap in-memory
  implementation equivalent.
- Extend quota preflight to the combined artifacts. If the archive fits but Share copies do not,
  run Download-only; do not reject a batch the existing path can deliver.
- Apply T39-A's measured total-byte cap to the exact completed share outputs and expose one cleanup
  operation that T42 can call when its exact payload validation fails.

**Done when:** the unchanged 200-image Download-only run holds memory near one entry and produces a
valid directory-preserving archive; an eligible 1-image run keeps one direct artifact and an
eligible 10-image run writes bounded-memory individual copies alongside its archive; an 11-image
run opens no Share sink; quota tests distinguish archive failure from Share-only fallback; and
cancellation, storage failure, startup and Processing exit
remove the complete artifact set. A multi-image run with exactly one success still retains that
image for direct Download without retaining Share copies when the starting count exceeded ten.

### T41 — Report generation

**Functional Design:** §6.6, R-X31
**Technical Design:** §9.3
**Depends on:** T15

Wire the report model to real run data and write it into the archive.

- Serialize T36-A's structured unreachable reason under Skipped; it is not a success caveat and its
  bytes do not contribute to output or savings totals.

**Done when:** a run producing failures, skips and caveats writes a report whose totals reconcile against the exact byte counts, and which parses as YAML.

### T42 — Download, share and leaving

**Functional Design:** R-X15 to R-X20, R-X41, R-X42, R-X47 to R-X50, R-X53, R-X54, R-V5,
R-K9, R-M6 to R-M9, R-K12
**Technical Design:** §3.3, §9.1, §9.2, §9.4

Explicit Download and conditional Share. Single-image Download remains direct with no ZIP or
report; multi-image Download remains the ZIP. Share hands every successful individual image to the
system in one call and never includes the ZIP or report. The three-way confirmation governs
undelivered results. Physical back-button navigation remains integrated with the mode state
machine: a first back press performs each nested stage's default transition (Processing following
R-X18/R-X19 instead), and a second back press at Gallery raises a Stay/Leave confirmation.

- A zero-success completion (all skipped and/or failed) has no artifact or delivery action. A
  single success still downloads and shares directly even when other images were skipped.
- `platform/share.ts` owns preliminary capability detection, exact `canShare({ files })` validation
  and `navigator.share({ files })`. The component never invokes the browser API directly, and the
  platform call contains files only.
- Show Share only for an eligible run whose exact successful files and byte total pass. Flatten
  folder paths and resolve basename collisions globally in grid order; keep ZIP collision handling
  directory-scoped.
- Replace the run store's `downloaded` boolean with `pending | downloaded | shared`. A resolved
  Share or completed Download cleans every artifact and fulfils the run; `AbortError` and other
  failures stay pending, with only non-cancellation failures shown inline and retryable.
- After delivery succeeds, keep the completed Processing view and its summary visible, replace both
  delivery actions with a checked **Download started** or **Shared** state, and make **Back to
  images** the remaining primary action. Only that action or browser Back returns to Gallery; the
  delivered path does not show the undelivered-results confirmation.
- Keep the leaving dialog exactly three-way — Download and leave, Leave without downloading, Stay.
  Do not add Share to it.
- Add the visible Share label, retryable failure copy and the two outcome-specific completion
  messages to the English message catalogue and its shared translator-context file; do not
  introduce literal component strings.
- The back-button guard and its two dialogs (`useBackNavigationGuard`, `ConfirmDialog.vue`) land
  ahead of the rest of this task's download/report wiring — `downloadFinishedRun()`
  (`src/pipeline/run-download.ts`) is a scoped-out stub until this task's own run-output retention
  and archive assembly exist; wire the explicit Download button to that same function rather than
  duplicating its single-vs-ZIP logic.
- Re-read `content/en/faq.md` after implementation and minimally correct any answer made false by
  Share. Do not add a new FAQ question without user approval.

**Done when:** starting batches of 1 and 10 expose Download and, when the stubbed exact capability
accepts, Share; 11 exposes Download only even if later failures leave fewer successes; a single
success uses one direct file; multiple successes download a ZIP with report and share images only;
folder-share collisions receive deterministic global suffixes; exact rejection hides Share;
cancellation and failure retain the results; the first successful delivery removes every artifact;
replaces both delivery actions with the outcome-specific checked state while the completed summary
remains visible; Back to images and browser Back then reach Gallery without an undelivered-results
confirmation; the other existing confirmations and physical-back transitions still pass with
delivery state replacing download state; and zero successes expose neither action.

---

# Phase 7 — Public site

### T43 — Site shell and navigation

**Functional Design:** R-S2, R-S3
**Technical Design:** §12.2, §12.3
**Depends on:** T31

The outer chrome every route renders inside: a header carrying navigation and a footer.
The router, the site config and static generation already exist from T31; this task adds
the site's own furniture and the remaining routes' entries, so T44 has somewhere to
mount its pages.

- The tool route mounts its existing header/stage/panel shell (T31) unchanged inside
  this outer shell. The compressor does not lose or duplicate its own chrome.
- Route entries for `/faq`, `/privacy`, `/terms` and `/desktop`, plus the
  locale-prefixed variants derived from `src/config/site.ts`. Their content is T44's.
- The footer carries the source-code link R-V4 requires; T49 owns the credits page it
  points at.

**Done when:** header and footer render on every route including the tool's, the tool
remains fully interactive beneath them, and each new route resolves to a page rather
than a 404.

### T44 — Public content pages

**Functional Design:** R-S4, R-S5
**Technical Design:** §12.4
**Depends on:** T43

FAQ, Privacy, Terms and Desktop pages rendered from markdown, one file per supported
locale under `content/<locale>/<page>.md`, falling back to the English file where a
locale's file is absent. The FAQ already sits at `content/en/faq.md`, relocated when
this phase was designed; the other three pages are new files. This task builds the
rendering and fallback mechanism, not the relocation.

- Placeholder content for Privacy and Terms ships now; the legal text is future work
  by someone else and does not block this task.
- This is a distinct mechanism from the interface string catalogue in §1.5 — a content
  page is prose a person edits directly, not a set of keyed strings — and T48
  (Language completeness) does not cover it.

**Done when:** all four pages render for the default locale, and a page with no
locale-specific file falls back to English rather than erroring.

### T45 — SEO surface

**Functional Design:** R-S6 to R-S10
**Technical Design:** §12.5
**Depends on:** T43, T44

Per-route title, description, canonical URL, Open Graph and Twitter card metadata;
`WebApplication`/`SoftwareApplication` structured data on the tool route and
`FAQPage` structured data on the FAQ route; a build-time script generating
`sitemap.xml` from the real routes in the site config, `robots.txt` with the sitemap
location and an explicit allow entry for named AI crawlers, and an `llms.txt` file at
the site root.

- No hidden or crawler-only content is added anywhere in this task; R-K11 applies to
  the site as much as to the tool.
- `FAQPage` structured data is a courtesy to engines that read it, not an expected
  Google rich result.

**Done when:** every route's rendered HTML carries its own title and canonical tag
distinct from every other route's, `sitemap.xml` lists exactly the real routes and
none of the tool's internal modes, and `robots.txt` validates against the sitemap it
names.

### T46 — Progressive Web App and usage visibility

**Functional Design:** R-S11 to R-S14, R-V3
**Technical Design:** §12.6
**Assumption:** F2
**Depends on:** T31

A web app manifest and a generated service worker for offline installability, and a
client-triggered, cookieless analytics beacon (Cloudflare Web Analytics) as the
usage-visibility mechanism R-V3 anticipates.

- The service worker's runtime-caching configuration explicitly excludes the analytics
  domain, so a future caching-strategy change cannot silently swallow it.
- The privacy line (R-V1) is revised to name exactly what the beacon collects, per
  R-V3.
- Build the beacon against a placeholder token (no Cloudflare account needed to verify
  the mechanism or the Playwright test below); add a bullet to T51-A naming the token
  and its file so the real value is not forgotten at release.

**Done when:** the app installs and opens offline after a first visit, a Playwright
test confirms a page load served entirely from the service worker's cache still fires
the analytics request, and F2 is updated with the result.

---

# Phase 8 — Completeness

### T47 — Accessibility

**Functional Design:** §12, R-K1 to R-K11

Keyboard operation throughout, live-region announcements, accessible names, reduced motion, no information carried by colour alone.

- R-K10 is a review gate here as much as a build step: an accessible name is added only where a control has no visible text label, never as a redundant addition to a control that already has one, and never anywhere as crawler-facing text.

**Done when:** every flow is completable by keyboard alone, an automated audit passes on each stage mode, and run progress announces at intervals rather than per image.

### T48 — Language completeness

**Functional Design:** R-L1 to R-L5
**Technical Design:** §11

Every user-facing string extracted with context, including any accessible-name string added under R-K10. A pseudo-locale for testing.

- A test renders every screen in a right-to-left pseudo-locale and asserts no physical-direction layout leaks.
- A test asserts the report is unaffected by interface locale.
- Move the context file from `src/i18n/en/context.json` up to `src/i18n/context.json` and update its importers. T08 placed it inside the English directory before the shared-versus-per-locale question was settled (§11); adding a second locale is the moment it has to move, so that no locale ever gets a context file of its own.
- Public content pages (FAQ, Privacy, Terms, Desktop, T44) use per-locale markdown with English fallback, not this message catalogue. This task's scope is interface strings only.

**Done when:** no literal user-facing string remains in any component, and both tests pass.

### T49 — Privacy, credits and source

**Functional Design:** R-V1 to R-V5
**Technical Design:** §7.2
**Depends on:** T43

The local-processing line, including its explicit user-directed Share qualification, the credits
page listing every bundled component with licence and source link, and the link to the application's
own source.

The credits page is a route on the router built in T31, generated from
`3rd_party_licenses/` rather than authored prose — it needs no locale fallback and is
not one of T44's four content pages. The source-code link lives in the site footer
built by T43. If T46 (PWA and usage visibility) has already run, R-V3's disclosure
names exactly what the analytics beacon collects; if not, the privacy line states plainly that
nothing is collected yet. Share is described as a handoff to the system target the user chooses,
not as processing or an app upload, and the app never claims to know the selected target.

**Done when:** a test asserts no network request carries image bytes, file names, dimensions or
sizes; a Share test asserts that only the completed `File[]` reaches the platform wrapper after an
explicit click; and the credits page covers every directory in `3rd_party_licenses/`.

### T50 — Limits

**Functional Design:** §5.7, R-I19 to R-I22, R-I33, R-X47, R-X48
**Technical Design:** §8.3
**Assumptions:** C3, C4, E4

One runtime configuration module holding every limit, including `maximumThumbnails`,
`maximumShareFiles` and `maximumShareBytes`. Selection limits are
enforced at selection time; operational limits such as the thumbnail budget are injected into their
owning service.

- Derive values by measurement on desktop and on a real phone. The 200-file figure inherited from the original design draft is not defended by anything.
- C4 needs a physical iPhone, including an older low-memory model.
- Re-run T39-A's ten-file and maximum-byte Share cases on that older iPhone. Keep the product ceiling
  at ten only if it survives; lower the byte or file limit and update E4 and §5.7 if measurement says
  otherwise.

**Done when:** every limit has a measured value with its evidence, C3, C4 and E4 are updated, and
Functional Design §5.7 carries real numbers instead of placeholders.

### T51 — End-to-end suite

**Technical Design:** §13

The full fixture set and journeys across three engines: single image, mixed batch, folder tree,
animated batch, a run with failures, cancellation, leaving without delivery, stubbed Share
availability/success/cancellation/failure, the 10-versus-11 starting-count boundary, and the public
routes (FAQ, Privacy, Terms, Desktop, `sitemap.xml`, `robots.txt`) reachable and rendering correctly.

**Done when:** the suite passes on all three engines in CI and takes an acceptable time to run.

---

# Phase 9 — Release

### T51-A — Release placeholder audit

**Depends on:** T44, T46

Every non-production stand-in value that earlier tasks shipped so implementation would
not block on something outside engineering's control, swapped for the real value before
the production build in T52 reads it.

Known entries, accumulated as earlier tasks created them:

- `VITE_SITE_BASE_URL` (`src/config/site.ts`) — falls back to a non-production placeholder
  when unset; must resolve to the real canonical production URL.
- The Cloudflare Web Analytics token (T46) — built against a placeholder token so the
  beacon mechanism and its Playwright test could be verified without waiting on a
  Cloudflare account; must resolve to the real token.
- The Privacy and Terms page copy (T44) — placeholder prose shipped so the routes were
  not withheld waiting on legal text; must resolve to the final legal copy.

A task that ships a non-production stand-in for a real value (API token, production URL,
legal or other externally-sourced copy) adds a bullet here, naming the value and the file
it lives in, at the time it ships it — this list is the only place that tracks them, so an
item left off here is an item this audit will not know to check.

**Done when:** every bullet above is confirmed resolved to its real value, grepping the
codebase for known placeholder markers (the non-production URL fallback, any placeholder
token string) turns up nothing reachable from the production build, and this task's
handover note records what each value was set to (without committing secrets).

### T52 — Build and deploy

**Technical Design:** §12
**Assumptions:** B6, B9

Production build, content-hashed WASM with long cache lifetimes, deployment to Hostinger, `.htaccess` headers.

- Verify COOP and COEP actually apply and that `crossOriginIsolated` is true. If headers cannot be set, the threaded build is unavailable and single-threaded is the baseline.
- Locale routing as real paths with `hreflang` is built in T43, not here; this task verifies it survives the production deploy rather than building it.

**Done when:** the site serves over HTTPS, headers verified by fetching them, B6 and B9 updated, and first paint measured on a throttled mobile connection.

### T53 — Licence compliance audit

**Technical Design:** §7.2
**Assumption:** A12

Final pass before release.

- Every bundled component, including everything statically linked inside the ImageMagick WASM, has its licence text committed and is credited.
- The gifsicle question in A12 has a recorded answer. If it went against us, remove gifsicle and fall back to ImageMagick's GIF writer.
- No module is shared with the proprietary desktop product.

**Done when:** the audit script reports nothing missing, A12 records a decision rather than a question, and the note confirms the desktop firewall holds.
