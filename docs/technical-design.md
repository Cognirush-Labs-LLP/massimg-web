# Mass Image Compressor Web: Technical Design

Implementation architecture for the behaviour defined in the Functional Design. Requirement IDs (`R-xx`) refer to that document. Assumption IDs (`A1`, `B4`, `D7` and so on) refer to the Assumptions Register, and every decision that rests on an unverified assumption names it.

Where an assumption is below 75% confidence, the decision is written together with the fallback it reverts to if the assumption fails. Those are marked **Contingent**.

---

## 1. Stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript, `strict` | Including `noUncheckedIndexedAccess` |
| Framework | Vue 3, Composition API, `<script setup>` | |
| Build | Vite | Shares its pipeline with the test runner |
| State | Pinia | Stores listed in §3 |
| Unit and integration tests | Vitest | Not Jest, see below |
| Browser tests | Playwright | Chromium, Firefox, WebKit |
| Formatting and linting | Prettier, ESLint, `vue-tsc` | All three in CI |
| Deployment | Static files to Hostinger | §11 |

**Vitest rather than Jest.** Jest against a Vite project needs a parallel transform configuration that drifts from the real build. The specific pain here is ESM plus WASM plus workers, which is where Jest's module handling is weakest. Vitest runs through the same resolution and transform as production. Its API is close enough to Jest that agent-written tests transfer without retraining.

**`vue-tsc` from the first commit.** Vue templates are type-checked by a separate tool rather than by the compiler. TypeScript was chosen partly so an implementing agent gets machine-checkable feedback, and without `vue-tsc` in CI that feedback does not cover templates. Adding it later means fixing a backlog of errors at the worst time.

### 1.1 Two rules specific to Vue

**Binary data never enters the reactive graph.** Vue 3 proxies objects deeply. A `File`, `ArrayBuffer`, `Blob` or `ImageBitmap` inside reactive state gets wrapped, which costs performance across hundreds of records and can break structured cloning when the object is posted to a worker.

The rule: reactive stores hold metadata only. Binary data lives in a plain non-reactive `Map` keyed by image id, outside any store. Where a binary value must sit on a reactive object, it is wrapped in `markRaw`.

```ts
// module-scope, deliberately not reactive
const sourceFiles = new Map<ImageId, File>()
const thumbnails = new Map<ImageId, Blob>()
```

This is enforced by a lint rule and by a unit test that asserts no store contains a value failing `isProxy` checks against the known binary types.

**Component boundaries follow the stage modes.** Gallery, Preview, Edit and Processing are separate components mounted exclusively, so leaving a mode unmounts its state and its listeners. R-M4 requires releasing mode-specific image data on mode change, and tying that to the component lifecycle makes the release automatic rather than remembered. The one deliberate exception is the bounded, batch-scoped thumbnail Blob cache: its generation owner is Gallery-scoped, but completed entries may survive mode changes to prevent source rereads.

---

## 2. Module structure

```
src/
  app/            shell, routing, mode switching
  stores/         Pinia stores (§3)
  domain/         pure logic, no DOM, no Vue, fully unit-testable
    edit.ts         edit record, crop arithmetic (§6)
    job.ts          job description, settings resolution
    format.ts       format routing, extension rules
    naming.ts       output names, collision handling
    report.ts       report model and serialisation
    sizes.ts        byte formatting, two implementations (§10)
  pipeline/       worker-side processing
    worker.ts       message loop
    stages/         decode, orient, edit, resize, encode, optimise
    codecs/         one adapter per library
  platform/       browser capability wrappers
    opfs.ts, picker.ts, folder.ts, download.ts, capability.ts
  ui/             components, one directory per stage mode
  i18n/           locale files and context files (§10)
```

`domain/` is the important boundary. It contains no browser APIs and no Vue, so every rule in the Functional Design that can be expressed as a pure function is unit-testable without a browser. Crop arithmetic, format routing, naming, the caveat set in R-X46, and the PNG quality rescale in R-Q11 all live there.

---

## 3. State model

Four stores. They hold metadata; binary data is in the non-reactive maps described in §1.1.

### 3.1 `useBatchStore`

```ts
interface ImageRecord {
  id: ImageId
  name: string              // original filename, extension preserved exactly (R-X43)
  relativePath: string | null  // folder input only (R-I25)
  sizeBytes: number
  width: number
  height: number
  sourceFormat: Format
  isAnimated: boolean
  frameCount: number | null
  hasTransparency: boolean | null   // null until tested (R-C13, D5)
  edit: EditRecord | null
  status: 'ready' | 'failed'
  failure: FailureReason | null
}
```

Insertion order is the array order (R-G5). `hasTransparency` is nullable because detection requires a decode and is done lazily.

### 3.2 `useSettingsStore`

Batch-wide settings: quality mode and value, dimension rule and value, format. These are the inputs to job resolution. Any change invalidates every in-flight preview (R-P3).

### 3.3 `useRunStore`

Run progress: counts by state, accumulated input and output bytes, failures, caveats. Populated by worker messages. Exists only during and immediately after a run.

### 3.4 `useUiStore`

Stage mode, current image index, gallery view mode, drawer open state, comparison tab.

### 3.5 The edit record

R-C4 makes rotation part of the edit, and §4.5 requires the structure to accept future operations without restructuring the pipeline.

```ts
type EditOp =
  | { kind: 'rotate'; quarterTurns: 0 | 1 | 2 | 3 }
  | { kind: 'crop'; rect: NormalisedRect; zoom: number; background: Rgba }

interface EditRecord {
  ops: EditOp[]        // ordered, applied in sequence
  version: number      // bumped on change, used for preview invalidation
}
```

Ops are an ordered list rather than named fields. Adding an operation later means adding a variant and a stage, not changing every consumer. The pipeline walks `ops` in order; the UI in this version only ever produces a rotate followed by a crop, but nothing in the pipeline assumes that.

`rect` is normalised to fractions of the source image rather than pixels, so it survives a change of display size, a different viewport, or a resize of the browser window.

`version` is what preview caching compares against. Since we retain nothing (R-B1), it is used to discard a result that arrives after the edit changed, not to look anything up.

---

## 4. Job model

**One pipeline serves preview and run.** This is the single most important structural rule in the document. A job is a pure description; executing it is a pure function of that description.

```ts
interface Job {
  imageId: ImageId
  source: File                 // or the raw bytes, posted to the worker
  edit: EditRecord | null
  settings: ResolvedSettings   // batch settings resolved for this one image
  intent: 'preview' | 'run'
}
```

`intent` affects only what is returned. A preview returns the encoded bytes plus measured size; a run returns the same plus the caveat list for the report. It never affects how the image is processed. This gives R-X2 for free and eliminates the class of bug where the preview does not match the download.

### 4.1 Settings resolution

Batch settings become per-image settings before the job is built, in `domain/job.ts`. This is where most of the Functional Design's conditional behaviour lives, and it is entirely pure:

- Format resolution under "Don't change" (R-F1, R-F2).
- Animated substitution when a still-only format is chosen (R-F6).
- Crop overriding the dimension rule (R-D1); rotation not overriding it (R-D4).
- PNG quality rescale and lossless threshold (R-Q11, R-Q12).
- Lossless selection above 95 (R-Q5).
- Alpha flattening decision and fill colour (R-C17).

Because it is pure and takes no browser APIs, every rule above is a table-driven unit test.

### 4.2 Stage dispatch

Output paths differ in shape, and three of them leave ImageMagick partway through. A job declares its stages and the worker executes them in order.

| Output | Stages |
| --- | --- |
| JPEG | decode, orient, edit, resize, encode |
| WebP still | decode, orient, edit, resize, encode, second-encode compare (R-Q6) |
| AVIF still | decode, orient, edit, resize, encode |
| PNG still | decode, orient, edit, resize, quantize, optimise, compare against lossless (R-Q14) |
| GIF, still or animated | decode (frames), orient, edit, resize, encode-gif, gifsicle, keep the smaller (T28) |
| WebP animated | decode-frames, edit-frames, resize-frames, encode, second-encode compare (R-Q6), restore frame durations (T29) |
| PNG animated | decode-frames, edit-frames, resize-frames, assemble-apng, patch loop count, optimise-apng, attach `iCCP` (T29). Always lossless, R-Q15 — no quantize and no compare |
| Any output, size target | the matching row above, with everything from its first encode onward repeated over the quality slider until the target is met or eight iterations are spent (§7.5, T30). Decode, orient, edit and resize run once |

Stages share one intermediate representation, an RGBA frame buffer with dimensions and an optional ICC profile. Without this, the GIF and animated paths each grow their own copy of the resize and edit logic, which is how the two drift apart. An animation is that same `Frame`, in a list, with a delay per frame and a loop count (`Animation` in `pipeline/stages/frame.ts`), so `edit-frames` and `resize-frames` are the still stages mapped rather than reimplemented.

**GIF is one row for both still and animated** (T28). A still image reaches `stages/gif.ts` as an animation of one frame (`singleFrameAnimation`), because gifsicle takes a GIF and returns a GIF whether or not it moves and ImageMagick writes a one-image collection the same way it writes a many-image one. Two rows would have meant two copies of the colour handling, the gifsicle call and every assertion made about the result. The row ends in a comparison rather than an encode because gifsicle is not always the winner: it is 69–83% smaller where frames share content, and **larger** on a still photograph (A7).

**A size target repeats the encode stages and nothing else** (§7.5). Decode, orient, edit and resize do not depend on the quality asked for, so they run once and the search re-encodes the frame — or every frame — it left behind. Each probe is the whole of its format's encode row, not one codec call, which is why a PNG probe is two candidates and a GIF probe is an ImageMagick write plus a gifsicle pass. R-Q2's pass-through is decided before the decode: an image already under the target that the job asks nothing else of never enters the chain at all.

**Both animated rows end in byte surgery, and neither ending is optional.** ImageMagick's WebP writer replaces any frame delay under 10 ms with 100 ms, and UPNG hardcodes `acTL.num_plays` to 0 whatever it is asked for — so the durations are put back into the `ANMF` chunks and the loop count into `acTL` after each encoder has run (T29). The `iCCP` goes on last of all, because apng-optimizer strips one attached before it (D3).

---

## 5. Workers and concurrency

### 5.1 Pool

A small pool of dedicated workers, sized from `navigator.hardwareConcurrency` with a low cap. The cap exists because concurrency multiplies peak memory (R-X8, R-B2), and memory is the binding constraint rather than CPU.

Starting point: `min(hardwareConcurrency - 1, 3)` on desktop and `1` on mobile. **Contingent on C3 and C4**, both of which are currently low confidence. If iOS proves tighter than expected, mobile stays at one worker and the batch cap drops.

### 5.2 Lazy codec loading

ImageMagick's WASM is 14.8 MB uncompressed (A1), before gifsicle, oxipng and the quantizer. The landing page has an SEO job (§11), so nothing large may block first paint.

| Module | Loaded when |
| --- | --- |
| ImageMagick | First image is added, or on idle after first paint |
| gifsicle | First job resolves to GIF output |
| oxipng, quantizer | First job resolves to PNG output |
| UPNG, apng-optimizer | First job resolves to animated PNG |
| UPNG | **Also** whenever the *source* is an animated PNG, whatever the output format |

The last row is not symmetry for its own sake. **ImageMagick's WASM build cannot decode an APNG**: `readCollection` returns one frame from a six-frame file and raises nothing (measured in T29; D6 recorded the same of the still reader at A5, which is why R-I4 exists). So UPNG is the *decoder* on that path as well as the assembler, and an APNG going to animated WebP needs it although the output has nothing to do with PNG. `codecsForSettings` therefore reads `ResolvedSettings.sourceFormat`, not only `format`.

A worker that needs a module it has not loaded loads it and then proceeds. **C8 (80%, T22):** measured — one worker loading every module it might need stays within 116–152 MB of idle baseline on desktop across all three engines, nowhere near a level that forces the heterogeneous-pool contingency below. Not yet measured: up to three pipeline workers (§5.1's desktop cap) loading codecs *concurrently*, which could plausibly be 2–3× that figure. If three modules in one worker prove too heavy after all, they split across workers by codec, and the pool becomes heterogeneous.

### 5.3 Cancellation

A WASM call cannot be interrupted once entered. §6.2 of the Functional Design commits to specific semantics, implemented as follows.

**Between jobs (R-X26).** A shared flag, checked by the worker before starting each job. The run stops after the image in flight. This is the normal path and costs at most one image of waiting.

**Discard on arrival (R-X28).** Every job carries a monotonic token. The main thread records the latest token per image; a result whose token is stale is dropped. Preview settings changes use this, combined with a debounce so that a dragged slider produces one job rather than dozens.

**Terminate and respawn (R-X29).** `worker.terminate()` is the only true interrupt and costs a full codec re-initialisation. It is used only when a single job exceeds a threshold and the user is waiting. The threshold is set from measured re-init cost, not guessed.

Debounce interval: 300 ms after the last input event. Long enough that a slider drag produces one job, short enough that it feels immediate.

---

## 6. Edit arithmetic

Two scales that must never be conflated (Functional Design §3.4).

**Definitions.** All in pixels unless stated.

- `Ws`, `Hs`: source dimensions, after EXIF orientation (R-I9) and user rotation (R-C2).
- `Wf`, `Hf`: the frame, the area of the stage available for the image.
- `fitScale = min(Wf / Ws, Hf / Hs)`: the scale at which the whole image fits the frame. Chosen by the app.
- `z`: the user's zoom, from the slider.
- `drawScale = fitScale × z`: the scale at which the image is actually drawn.
- Crop rectangle in frame coordinates: `rx, ry, rw, rh`. Constrained to the frame (R-C12).

**Output dimensions.**

```
outW = rw / drawScale
outH = rh / drawScale
```

Zooming in raises `drawScale`, so the same rectangle covers fewer source pixels and output shrinks. Zooming out lowers it and output grows, which is R-C7.

**Worked example.** Source 4000×3000, frame 800×600.

`fitScale = min(800/4000, 600/3000) = 0.2`

| Zoom | drawScale | Image drawn as | Crop rect 400×300 gives | Spill |
| --- | --- | --- | --- | --- |
| 1.0 | 0.20 | 800×600 | 2000×1500 | none |
| 2.0 | 0.40 | 1600×1200 | 1000×750 | none |
| 0.5 | 0.10 | 400×300 | 4000×3000 | none, exactly covers |
| 0.25 | 0.05 | 200×150 | 8000×6000 | yes, all four sides |

The last row is R-C9: output 8000×6000 containing the 4000×3000 source centred, with background fill around it. Larger than the input, and correct.

**Typed dimensions.** When the user types `outW`, the rectangle is resized to `rw = outW × drawScale`, clamped to the frame and to the minimum size. With a ratio locked, `rh` follows and `outH` is derived.

**Spill detection.** The image occupies, in frame coordinates, a rectangle of `Ws × drawScale` by `Hs × drawScale` centred in the frame. Spill exists when the crop rectangle is not fully contained in it. That test drives whether the background row appears at all.

**Rotation.** Applied to `Ws` and `Hs` before any of the above. A quarter turn swaps them, `fitScale` is recomputed, and the rectangle and any locked ratio are refitted (R-C3).

All of this is pure arithmetic in `domain/edit.ts`, so the table above is literally a test fixture.

---

## 7. Codecs

### 7.1 Libraries

| Library | Role | Licence | Size |
| --- | --- | --- | --- |
| `@imagemagick/magick-wasm` 0.0.43 | Decode, orient, edit, resize, colour, most encoding | Apache-2.0 | 14.8 MB |
| `gifsicle-wasm-browser` | GIF compression | MIT wrapper, **GPL v2-only** inside, see §7.2 | ~368 KB |
| `@jsquash/oxipng` 2.3.0 | PNG lossless optimisation | Apache-2.0 | 164 KB |
| libimagequant, as `imagequant` 0.1.2 | PNG quantization | GPL v3, compatible with AGPL v3 | 347 KB, 153 KB gzipped (T22, T27) |
| `upng-js` | Animated PNG assembly | MIT | small, pure JS |
| `apng-optimizer` | Animated PNG optimisation | ISC | 276 KB |
| `client-zip` | ZIP streaming | MIT | small |

### 7.2 Licensing

**The project is released under AGPL v3.**

AGPL is the deliberate choice for a web tool: anyone may host a modified clone, and AGPL is what obliges them to publish their changes. GPL would not, because hosting is not distribution.

**Compatibility of the dependency set.**

| Dependency | Licence | Compatible with AGPL v3 |
| --- | --- | --- |
| ImageMagick WASM | Apache-2.0 | Yes, one-way |
| `@jsquash/oxipng` | Apache-2.0 | Yes, one-way |
| libimagequant | GPL v3 | Yes, see below |
| `upng-js`, `client-zip` | MIT | Yes |
| `apng-optimizer` | ISC | Yes |
| gifsicle | **GPL v2-only** | Not under the GPL route, see below |

**libimagequant.** GPL v3 contains an explicit permission to link or combine a covered work with software licensed under AGPL v3 into a single combined work. A GPL v3 dependency therefore composes into an AGPL v3 project without conflict.

**Gifsicle.** Its README states GPL version 2, and only version 2, which is incompatible with both GPL v3 and AGPL v3. The same README offers an alternative grant: copy, distribute or alter it freely provided source copyright notices are kept intact, with the restriction that anyone using it in a product whose source will not be available to the end user must contact the author first. An AGPL v3 release makes the source available, so the restriction does not apply and the alternative grant is permissive enough to coexist. **A12**, 90%.

A second question sits underneath: whether separately compiled WASM modules exchanging byte arrays constitute one combined work at all. If they do not, the incompatibility never arises. Both points are worth a lawyer's confirmation before release, though neither blocks implementation, since the fallback without gifsicle is ImageMagick's own GIF writer at worse compression.

**Attribution structure.**

```
3rd_party_licenses/
  imagemagick/        LICENSE, NOTICE
  libde265/           COPYING
  libheif/            COPYING
  libwebp/            COPYING
  aom/                LICENSE, PATENTS
  lcms2/              COPYING
  libjpeg-turbo/      LICENSE
  libpng/             LICENSE
  gifsicle/           COPYING, README licence section
  oxipng/             LICENSE
  libimagequant/      COPYING
  upng-js/            LICENSE
  apng-optimizer/     LICENSE
  client-zip/         LICENSE
```

Note that the ImageMagick WASM binary statically links many of these. Their licence texts are not recoverable from the shipped artefact, so each must be sourced from upstream and committed deliberately. A build step that only walks `node_modules` will miss every one of them.

**Obligations to satisfy in the application itself.**

- A `LICENSE` file at the repository root and per-file notices.
- A credits page listing every bundled component, its licence, and a link to its source.
- A prominent link to the application's own source. AGPL's network provision is written for server-side software, and this application runs in the browser, but a visible source link satisfies it plainly rather than by argument.

**Firewall against the desktop product.** AGPL reaches further than GPL. No module may be shared between this application and the proprietary desktop product. They are separate codebases today; the risk is a future convenience, copying a helper across, which would place the desktop product's source under obligation.

### 7.3 Effort settings

No codec runs at maximum effort. The measured returns are small and the time costs are severe.

| Codec | Setting | Rationale |
| --- | --- | --- |
| AVIF | `heic:speed` 9, never the default; `heic:chroma` 444 above slider 95 | **D7**: on twenty real photographs, speed 9 is 9.94x faster than speed 6 and 2.10x faster than speed 8 on average, with mean SSIM flat across speeds 6-9 (0.9857-0.9861) and under 1% size difference between speeds 8 and 9. Default is 7611 ms vs. 452 ms for speed 9 on the original single-image measurement |
| WebP | `method` 4, the library default, not 6 | Method 6 costs several times the time for low single-digit size gains |
| oxipng | `level` 2, not 6 | **T27** (`verification/t27-png/results.json`, `effort.oxipngLevels`), on a 1000×750 photographic PNG of 631,590 B with its metadata already stripped: level 0 is 631,362 B in 120 ms, level 1 590,281 in 455, **level 2 590,049 in 802**, and levels 3, 4 and 6 return the *identical* 590,049 B in 2,118, 2,231 and 5,173 ms. Nothing above level 2 paid for itself; one subject, so the flatness is not established in general |
| libimagequant | `speed` 3 — not 1, which is maximum effort here, and not the library default 4 | **T27**, ten generated PNGs and fourteen real files. One generated image aborts at every speed; of the other nine, **six produce the same output size across speeds 1 to 6** and three differ by at most 168 B. Time across speeds 2 to 6 varies by at most 25 ms per image, with speed 1 up to 87 ms slower on one. Speeds 8 and 10 are 1.25x to 2.26x faster and change the output on seven of the nine — a grey ramp went 2,231 B at SSIM 1.0000 to 2,356 at 0.9980, while a gradient got *smaller*, 27,147 to 22,423, for 0.0005 of SSIM. What separates 3 from the default is the *achievable* quality: the highest `minimum` the quantizer can meet is identical at speeds 1 and 3 on all 24 images and one point lower at speed 4 on three of them — the same three real photographs on all three engines — and never higher. That number is what R-Q11's floor is compared against |
| gifsicle | `-O2`, not `-O3` | **T28** (`verification/t28-gif/results.json`, `summary.optimizeLevels`), ten subjects. `-O1` to `-O2` is the step that matters, and it is sometimes enormous: 60,613 B to 29,441 on a ten-frame scene, 818,272 to 356,857 on a sixteen-frame one. `-O3` is *byte-identical* on eight of the ten and smaller on two, by 2.8% and 3.7% — the larger of those for 1.9x the time, and it costs time on the eight where it returns nothing (89 ms against 177 on one). The conclusion stands; the old rationale ("`-O3` tries every option per frame", implying no gain) did not — the gain is real, small, and paid for on every image that does not get it |
| PNG deflate | Default, no zopfli | apng-optimizer's zopfli setting stays low for the same reason |
| apng-optimizer | `deflateMethod` 1, the library default (7zip), not 2 (zopfli); `iter` 5, not the default 15 | **T29.** Measured on an 8-frame 200×200 photographic APNG and a 16-frame 400×400 flat one. **Method 2 is out on time alone:** 11,696 ms and 49,162 ms against method 1's 821 and 1,962, for 3.1% and 10.1% of size — 49 s for a single 16-frame animation, before a batch multiplies it. **Method 0 against method 1 is genuinely close and points both ways:** method 1 is 5.4% smaller on the photograph (42,411 B against 44,820) and 5.5% *larger* on the flat animation (11,038 against 10,459), while being 4×–10× slower on both. Two subjects cannot settle that, so the default stays; method 0 is the lever if this proves too slow in a real batch. These figures were taken when the path still ran the optimiser twice per animation (a quantized candidate as well as a lossless one); R-Q15 has since removed the second run, so the wall times above are now paid once rather than twice, and the relative comparison between methods is unaffected. **`iter` 5 is past the knee:** on the photograph, 1 gives 42,660 B in 343 ms, 3 gives 42,417 in 580, 5 gives 42,412 in 619, 10 gives 42,401 in 719, 15 gives 42,411 in 813 and 30 gives 42,401 in 1,105 — everything from 3 up is within 16 bytes, and the default 15 is not even the smallest of them |

**oxipng runs single-threaded, and that is not a choice.** `@jsquash/oxipng` ships both builds and picks the multi-threaded one only inside a Worker with `hardwareConcurrency > 1` and `wasm-feature-detect`'s `threads()` passing — which needs `SharedArrayBuffer`, which needs COOP and COEP. Measured in a real Worker on all three engines with no such headers (T27, B6): the single-threaded build initialises everywhere. So oxipng spawns no thread pool, and a pool of *N* pipeline workers costs *N* oxipng heaps rather than *N* × cores (§8.1).

**`optimiseAlpha` stays off on both PNG branches** (`results.json`, `effort.optimiseAlpha`). It rewrites the colour beneath fully transparent pixels so the rows compress better, and it is worth real bytes — **28,330 down to 1,488** on a 1000×750 frame whose fully transparent field held noise, a 19x saving for a change nobody can see. It stays off on the lossless branch because that branch exists to be lossless and R-Q12 makes PNG lossless early precisely for that reputation: measured on the same frame, with the option off the decoded pixels match the source exactly, visible and hidden alike, and with it on they differ by up to 255 under the transparent field. It stays off on the quantized branch because it buys nothing there — libimagequant has already collapsed every fully transparent pixel onto one palette entry, and oxipng measured the same 1,488 bytes either way. **This is a size win being declined on principle, and the numbers are here so it can be overruled.**

**D7 is 99% confident.** The original measurement used synthetic noise, which is unusually hostile to AVIF and might have flattened the quality difference between speed settings. T02 repeated the comparison on twenty real photographs at speeds 6 through 9 with quality 70 and an SSIM perceptual check: quality was statistically indistinguishable across all four speeds (mean SSIM 0.9857-0.9861), and speed 9 was 2.1x faster than speed 8 for under 1% more size. Speed 9 is the chosen value, not a range.

### 7.4 Quality mapping

Implements Functional Design §7.1. The mapping is pure and lives in `domain/job.ts`.

| Format | Slider 96 to 100 | Slider 10 to 95 |
| --- | --- | --- |
| JPEG | quality as given | quality as given |
| PNG | lossless from 85 (R-Q12) | `70 + (q - 10) × 30 / 90`, rounded to the nearest whole number and used as libimagequant's **minimum** (T27) |
| WebP | `lossless=true` | lossy, plus lossless comparison (R-Q6) |
| AVIF | **not lossless in this build** — the slider value capped at 99, chroma 4:4:4 (D9) | quality as given |
| GIF | no `--lossy` | `--lossy` = `20 × 10^((95 − q) / 85)`, so 20 at slider 95 and 200 at slider 10 (T28) |

**The PNG rounding happens after the lossless decision, not before it.** `domain/job.ts` keeps the exact mapped value — slider 20 is 73.333… — because R-Q12 pins the lossless point to slider 85, where the mapping reaches 95 exactly. Rounding first would make slider 84 (94.666… → 95) lossless one step early. `pipeline/stages/png-plan.ts` rounds at the quantizer boundary instead, to the nearest whole number, which leaves R-Q11's three named values (10 → 70, 85 → 95, 100 → 100) untouched. The rounding is not cosmetic: the value crosses into WebAssembly, where a fraction is truncated silently rather than rejected.

**The mapped value is libimagequant's `minimum`, which makes R-Q11's floor a guarantee rather than a judgement** (T27, D8). libimagequant aborts rather than producing a file it cannot bring up to `minimum`, and the job then keeps its lossless PNG. Nothing below the floor can therefore be written, whatever the content.

**So below slider 85 the PNG slider changes *which* images are quantized, not how hard.** libimagequant's `target` is 100 (§7.3), so an image it can quantize gets the same file at every slider value it can meet; what the slider moves is `minimum`, and therefore the point at which an image stops being quantizable and falls back to lossless. Measured over 24 images (T27): 14 kept a quantized file at slider 10 and 10 at slider 84, with the mean saving falling from 45.8% to 39.0%. This satisfies R-Q1 — the panel does not expose the difference — and is the behaviour R-Q11 asks for read literally, since the requirement remaps the slider onto "a quantization quality with a floor of 70" and says nothing about colour counts. It is a consequence two later pieces of work depend on:

- **Size targeting (§7.5, T30)** searches this axis anyway, and it is cheap precisely *because* it has two outcomes: a search that has seen the same file size twice has learnt everything the axis can tell it, and stops. Measured at two or three encodes rather than eight. The alternative this section used to recommend — searching `target` instead — was measured in T30 and is not an axis at all: see §7.5.
- **Any UI that explains the quality control** should not describe the PNG slider as trading size against fidelity in the way it does for JPEG. On PNG it trades *how many images stay lossless* against size, which is the conservative direction R-Q11 and P1 intend.

**The GIF mapping is geometric, and both of its ends are measured** (T28, `verification/t28-gif/results.json`; the derivation and the figures are in `gifLossyLevel`). Three things decided it:

- *The band starts at 20, not at gifsicle's own 1.* Levels below about 20 make the file **bigger** — 678,115 bytes against 624,462 with no lossy pass at all on a photographic animation, 32,676 against 29,441 on a scene — because a small level perturbs the palette enough to defeat `-O2`'s inter-frame optimisation without merging enough colours to pay for it. A slider position that reliably enlarges the output is not a quality control.
- *The scale multiplies rather than adds*, because size falls logarithmically with the level: 328,211 B at 20, 260,252 at 40, 197,629 at 100, 165,540 at 200. A linear map would spend a third of the available size range in the first fifth of the slider's travel and leave the rest of it nearly inert.
- *The band ends at 200, which is a decision about what slider 10 means.* The curve does not flatten there — 150 to 200 is still 15% of the file on the photographic animation — so the argument for stopping short would have to be about visible speckle rather than about wasted effort. Slider 10 asks for the smallest file the format can produce, as it does for JPEG, and gets it. The mean channel error at each level is in the results file, so this is overrulable from data.

**gifsicle is asked up to four times, and the job never fails because it did not answer** (T28, `GIFSICLE_ATTEMPTS`). Its wrapper races its own resolve against its own reject, and on WebKit the reject wins about one run in five — measured at 17.6% and 22.5% on two runs of the same subject, against zero on Chromium and Firefox. When four attempts produce nothing, the path keeps ImageMagick's own GIF: the user gets a larger file rather than no file. Measured once per eighty runs on WebKit after the retry was added, and never on the other two engines.

**`stages/gif.ts` then keeps whichever of the two candidates is smaller**, which bounds the cost of getting any of this wrong: the user can never receive a file larger than ImageMagick's own writer would have produced. It does *not* compare against a third candidate — gifsicle with `-O2` and no lossy pass — and on one subject of nine that costs 1.9% at slider 95. The third pass was declined because it is a full extra gifsicle run on every lossy job, up to 1.2 s on a large still, to recover under 2% on the one shape of content where the lossy pass is marginal anyway.

### 7.5 Size targeting

A binary search over the quality **slider**, capped at eight iterations. `pipeline/stages/size-plan.ts` holds the decisions — where to probe next, when to stop, which candidate to keep, R-Q3's caveat — and `size.ts` binds them to the encoders. **Measured in T30** across three engines, five still subjects and three animations: `verification/t30-size/results.json`.

**The search moves the slider, not a codec's own parameter.** Every probe maps its position through `domain/job.ts`'s `qualityForSlider` and then runs the same stage the quality path runs, so the file a size target produces is the file that slider position produces by hand — asserted byte for byte in `tests/e2e/size.spec.ts`. Everything §7.4 and §7.6 decide therefore still holds under a target: R-Q6's comparison and its content gate, R-Q11's floor, R-Q12's lossless point, R-Q14's pick and R-Q15's lossless animation. It is also how PNG and GIF are searched at all without a second set of format rules, since §7.4's mapping already makes the slider libimagequant's `minimum` and gifsicle's `--lossy`.

**The probe order is the bottom of the slider, then the top, then the interior**, and each of the first two can end the search on its own:

- *The bottom misses the target.* Nothing above it can be smaller, so R-Q3 applies after **one** encode: the smallest achieved result is kept and the caveat recorded.
- *The top fits.* The best quality the slider offers is affordable, in **two** encodes. R-Q2's other half is structural here — the target is a ceiling, and the search never encodes above slider 100 to fill it.
- *Both ends return the same size.* The axis does nothing, so the top fits whenever the bottom did and the search has already stopped at two. **Nothing in the code detects an unresponsive axis; the probe order makes detecting one unnecessary.** T28 measured `--lossy` to be byte-identical from 1 to 200 on flat animations, which is the case this exists for.

**A file size seen twice also ends it.** When an interior probe returns a size already measured, the axis is a plateau rather than a curve — on every axis measured that means the *same file* — and bisecting further would only move a boundary the user never sees. This is what makes PNG cheap: §7.4's axis has two outcomes, and the third probe lands on one of them. The risk it takes is a curve that is flat between two probes and rises again inside the interval; no measured axis has that shape, and in T30's runs the only exact ties were PNG's, which are identical files, and adjacent-position ties on AVIF, which cost nothing.

**The eight-iteration cap costs at most one slider position.** Six interior probes do not quite resolve the 89 positions between the two ends. Checked exhaustively against a monotone axis for all 91 answers the band can have (`size-plan.spec.ts`), the search lands on the best fitting position or one below it, never further.

**The measured table** (T30), the shipped search to a 150 KB target on a 1600×1200 photographic frame — D1's own image shape and target — on all three engines. The **bytes are identical on all three**; only the times differ:

| Format | Iterations | Chromium | Firefox | WebKit | Kept |
| --- | --- | --- | --- | --- | --- |
| JPEG | 8 | 461 ms | 606 ms | 504 ms | slider 43, 151,062 B |
| WebP | 8 | 4,280 ms | 5,040 ms | 4,063 ms | slider 23, 149,426 B |
| AVIF | 8 | 1,420 ms | 1,604 ms | 1,387 ms | slider 47, 150,491 B |
| PNG | **1** | 1,832 ms | 1,933 ms | 1,739 ms | slider 10, 2,639,098 B — **not reached** (R-Q3) |
| GIF | **1** | 500 ms | 663 ms | 509 ms | slider 10, 375,759 B — **not reached** (R-Q3) |

**The iteration count is a property of the axis, not of the content or the engine.** Over 375 searches — five subjects, five targets, five formats, three engines — only four counts ever occur: **1** where the lowest quality already misses (R-Q3), **2** where the highest already fits or the axis is inert, **8** where there is a curve to bisect, and **3** on PNG, where the third probe lands on a plateau. Nothing between 4 and 7 was ever observed, on any format.

| Format | 1 iteration | 2 | 3 | 8 | ms per iteration |
| --- | --- | --- | --- | --- | --- |
| JPEG | 15 | 18 | — | 42 | 6–88 |
| WebP | 15 | 27 | — | 33 | 24–1,568 |
| AVIF | 15 | 21 | — | 39 | 14–276 |
| PNG | 24 | 33 | 18 | — | 117–4,911 |
| GIF | 21 | 24 | — | 30 | 61–674 |

**AVIF: the question D1 left open is now a measured pair rather than an estimate.** The same frame, the same 150 KB target, the same search, with the one define changed — §7.3's `heic:speed` 9 against the library's own default:

| | Wall time | Iterations | Kept |
| --- | --- | --- | --- |
| **`heic:speed` 9** (shipped) | **1,489 ms** | 8 | slider 47, 150,491 B |
| Library default | 16,040 ms | 8 | slider 46, 128,569 B |

**10.8× faster, for the same iteration count and one slider position of quality.** D1's original figure was 29,317 ms at the default on different hardware; the ratio is the part that transfers. At §7.3's settings AVIF's search is the **second cheapest of the five**, both per iteration (14–276 ms against WebP's 24–1,568) and in the worst case measured (1,604 ms against WebP's 7,485) — so the format D1 was ready to exclude is one of the two this should least worry about.

**R-Q4's exclusion list is empty.** The requirement disables the Size option "where the cost is prohibitive for a format", and the Technical Design decides which those are. On this evidence, none. The worst single image measured, over every engine, subject and target:

| Format | Worst | Iterations | Where |
| --- | --- | --- | --- |
| JPEG | 645 ms | 8 | Firefox, 1600×1200 photograph |
| AVIF | 1,604 ms | 8 | Firefox, 1600×1200 photograph |
| GIF | 5,388 ms | 8 | Firefox, 1600×1200 photograph |
| WebP | 7,485 ms | 8 | Firefox, 1600×1200 palette-like |
| PNG | 12,666 ms | **3** | Firefox, real photograph at 1600 px |

Nothing here is the half-minute-per-image AVIF was at the default speed, which is the case R-Q4 was written against. **PNG is the one a reasonable person might still exclude** — it is the slowest per image *and* the one whose targets are most often unreachable — but its cost is three encodes of a format that is expensive per encode, not a search that runs away: the same image in quality mode is one of those encodes. The numbers are here so that this can be overruled from data rather than from impression.

**PNG is the slowest per encode and the narrowest in reach, and that is §7.4's axis showing through.** A photographic frame has *no* axis at all: the quantizer cannot meet R-Q11's floor at any slider position, so both ends of the band return the identical lossless file (2,639,098 B on the subject above) and the search costs one or two encodes. Where quantization does succeed the axis has exactly two values, and the third probe finds that out — every one of the 18 three-iteration searches in the corpus is a PNG, every one probed 10, 100 and 55, and every one stopped because 55 returned the size 10 had already returned. **A PNG size target is therefore cheap to attempt and often impossible to meet**, which is exactly the case R-Q3 exists for.

**This section's own earlier recommendation for PNG does not survive measurement.** It read: "A PNG size search wants `target` as its variable, and D8 records what that costs in quality." Tested in T30 with `minimum` pinned at R-Q11's floor of 70 and `target` swept from 70 to 100 — the whole of the axis, because libimagequant raises `VALUE_OUT_OF_RANGE` for a target below the minimum, so R-Q11's floor caps the axis at 31 points before anything else does:

| Subject | `target` 70 | 85 | 100 | Shape |
| --- | --- | --- | --- | --- |
| Photographic, 1600×1200 | aborts | aborts | aborts | **No axis at all** — the floor is unreachable at every target |
| Flat graphic | 708 B | 708 B | 708 B | **Inert** |
| Palette-like illustration | 132,536 B (12 colours) | 144,642 B | **57,066 B** (197) | **Inverted** — a lower target is 2.3× *larger* |
| Real photograph 1 | 423,844 B | 560,207 B | 626,021 B | Monotone, 1.5× range |
| Real photograph 2 | 239,559 B | 361,577 B | 800,098 B | Monotone, 3.3× range |

So it is a real axis on two subjects of five, **inverted on a third**, and absent on the other two — libimagequant dithers harder to compensate for a lower target, which is the same mechanism §7.3's `QUANTIZER_TARGET_QUALITY` records. A binary search over it would hand a user asking for a smaller file a larger one. **The slider stays the axis.** What the alternative would have bought is recorded rather than discarded: on the two real photographs it would have reached 423,844 B and 239,559 B instead of 626,021 B and 800,098 B — a genuine 1.5×–3.3× more reach, and still nowhere near the 150 KB target either of them was asked for.

**An animated search re-encodes every frame, so its cost is per frame and per iteration.** R-Q10 forbids the cheaper lever — no frame is ever dropped to reach a target — so quality is the only axis, and `encodeAnimatedToSize` pays the whole animation on each probe. Measured (Chromium; Firefox is 10–20% slower and WebKit matches Chromium):

| Subject | WebP | APNG | GIF |
| --- | --- | --- | --- |
| 6 frames, 64×64 | 2 it, 12 ms | **1 it**, 25 ms | 2 it, 55 ms |
| 10 frames, 128×96 | 8 it, 158 ms (20 ms/it) | **1 it**, 49 ms | 8 it, 440 ms (55 ms/it) |
| 16 frames, 400×400 | 2 it, 514 ms (257 ms/it) | **1 it**, 1,946 ms | 2 it, 932 ms (466 ms/it) |

**Animated PNG never searches at all**, because R-Q15 leaves it no axis: `sizeSearchBand` gives it a single position and it encodes once. That matters most where it costs most — apng-optimizer is the most expensive animated encoder here, at about 2 s for a 16-frame 400×400 animation.

**R-Q2 is decided before the decode.** An image whose *source file* is already at or under the target is returned unchanged rather than re-encoded — but only when the job asks nothing else of it: same format, no dimension rule, no rotation or crop. That is R-X45's test, applied to R-Q2 (`requestIsSatisfiedBySource` in `domain/job.ts`, which R-X24 will reuse), and returning the original when a resize was requested would return the wrong file. The report records `original-kept`. **The passed-through file keeps whatever metadata it carried**, exactly as R-X24's substitution does, which is a known tension with R-I17 and is recorded in docs/task-notes/T30.md for the user rather than resolved here.

### 7.6 The two comparison rules

R-Q6 (WebP) and R-Q14 (PNG) both encode twice and keep the smaller. **D2 measured** the WebP case at 1600×1200:

| Content | Lossy q70 | Lossless | Winner |
| --- | --- | --- | --- |
| Photographic | 518,150 B, 1155 ms | 1,357,564 B, 2862 ms | Lossy by 2.6x |
| Flat graphic | 16,586 B, 224 ms | 522 B, 64 ms | Lossless by 32x |

Both halves earn their place. The gate permitted by R-Q6 is worth building: unique colour count separates these cases cleanly, and skipping the lossless attempt on photographs saves 2.9 seconds per image.

**T26 reproduced this in browsers** with the shipped stage (D2): the direction holds on all three engines, but the saving on real photographs fitted to 1600 px is about 1 second per image in this build, not 2.9. The gate skips the lossless attempt when a frame has more than 65,536 distinct RGBA values; across 311 real images no lossless win had more than 2,034, so the limit is set well above that and errs toward attempting.

**R-Q14's own value, measured in T27** across ten generated PNGs and fourteen real files, at slider 10:

| Outcome | Images |
| --- | --- |
| Quantized candidate kept | 14 of 24 |
| Quantizer aborted at R-Q11's floor, lossless stands | 2 of 24 |
| Both candidates ran, lossless kept | 8 of 24 |

Where the quantized file is kept it is 45.8% smaller than the lossless one on average. Where lossless is kept, it is kept by a small margin or by none: four of the eight are exact ties (few-colour images that libimagequant reproduces perfectly, which oxipng then encodes identically) and the other four win by 12, 40, 41 and 84 bytes. **So R-Q14's value is almost never bytes — it is that ten of twenty-four images keep a genuinely lossless PNG and no `png-quantized` caveat, which the slider alone would not have given them.** It is cheap to have: the quantized attempt is 47–116 ms on a 1000×750 image and 0.7–1.4 s on a 1600 px photograph, and PNG has no equivalent of R-Q6's content gate because the abort *is* the gate.

**Neither rule reaches an animated PNG, because that path has nothing to compare (T29, R-Q15).** apng-optimizer wraps libimagequant but exposes **no refusal**: where the still path's `set_quality(minimum, target)` aborts when it cannot reach R-Q11's floor — which is what makes that floor a guarantee by construction (D8) — `optAPNG`'s `minQuality` is a request it neither meets nor reports on. Measured on an 8-frame 200×200 photographic APNG, `minQuality` of 50, 70, 90, 99 and 100 all returned the *same* 101,349-byte file with no `PLTE` at all, and `minQuality: 10` returned a 256-colour file of **236,609 bytes against the lossless branch's 42,411** — 5.6× larger, silently.

A quantized candidate would therefore be quantized to an unknown quality at every slider position, with no floor and no way to detect that the floor had been missed. `pickSmaller` would stop the user receiving a *larger* file but could not stop it banding, which is the precise outcome R-Q11 exists to prevent. **Animated PNG is written losslessly instead** — decided with the user in T29 and recorded as R-Q15 — which keeps R-Q11's intent by removing the only path that could violate it, and halves the work, since `optAPNG` then runs once per animation rather than twice.

**R-Q6 *does* reach animated WebP** (T29, with the user). The requirement is written about WebP rather than about still WebP, and a GIF converted to animated WebP is exactly the flat, few-colour content it wins on, so declining to run it there would forfeit the case it was written for. What §7.6 does not define is the gate, since the cost on an animation is one extra encode per frame rather than one: `animation-encode.ts` reads the first, middle and last frames and takes the **highest** distinct-colour count. Three frames rather than one, because an animation's first frame is not reliably representative — a title card or a fade-in can be far flatter than the footage behind it. Three rather than all, because scanning every frame is the per-frame cost the gate exists to avoid. The maximum decides, so the gate errs as this section asks: a skipped attempt that would have won costs bytes, an attempted one that loses costs only time.

**Unlike R-Q6, PNG's comparison runs unconditionally below the lossless point.** The two rules also differ in who enforces the floor: WebP's lossless attempt is skipped by a content gate this codebase computes, while PNG's quantized attempt is refused by libimagequant itself when it cannot reach R-Q11's mapped quality (§7.4, D8).

### 7.7 Colour management

`lcms` is in the build (A2). The rule is preserve, not convert (R-I12 to R-I16). The ICC profile travels through the pipeline as part of the frame representation and is written by the encoder — **except where the encoder is not ImageMagick, which is now two paths rather than one.**

**Still PNG (T27) has the same problem animated PNG has, and the same fix.** §4.2's "quantize" step is not a pixel transform: `Imagequant.process()` returns a *finished PNG*, and that PNG carries `IHDR PLTE tRNS IDAT IEND` and no `iCCP`. So `pipeline/stages/png.ts` lifts the `iCCP` chunk out of ImageMagick's own lossless write — whole, header and CRC together, never re-encoded — and splices it into libimagequant's output. Measured on all three engines: the profile reads back byte-identical to the source's, and the splice may go before or after oxipng with byte-identical results. It goes before, so oxipng emits the final chunk set. Chromium and WebKit apply the resulting profile when they draw the file; Firefox's 2D canvas does not colour-manage in this build, so there the profile is proven present and byte-identical but not proven honoured.

**A second finding from the same work: ImageMagick's PNG writer adds colour and metadata chunks of its own** — `cHRM` on every file, plus `tIME`, three `tEXt` timestamps, and for a profiled image a *duplicate* of the profile as a `zTXt` "Raw profile type icc". `cHRM` beside an `iCCP` is a second, disagreeing description of the same colour, which is the class of mistake this section exists to prevent. Neither `png:exclude-chunk` nor `image.strip()` removes them without removing the `iCCP` too, so `png-plan.ts`'s `rewritePngChunks` keeps a whitelist instead — which is also what makes R-I17 structural for PNG rather than a define's promise.

**D3 is now 90% and measured** (T23, all three engines, `verification/t23-decode/`). The profile survives ImageMagick's JPEG, PNG, WebP, AVIF and GIF writers byte-identically, and survives oxipng and gifsicle too. The weak point was correctly predicted to be animated PNG but sits in a different component than expected, and it is avoidable:

- **UPNG** writes no `iCCP` chunk and does write an `sRGB` chunk, but an `iCCP` spliced into its output reads back identically — so UPNG is not the obstacle.
- **apng-optimizer** strips a valid `iCCP` from the APNG it is given.
- Attaching the profile **after** the optimiser has run preserves it exactly.

So the animated PNG path is assembled as *UPNG → apng-optimizer → attach `iCCP`, dropping the `sRGB` chunk*, and the contingency this section previously named — converting to sRGB for animated PNG only and recording a `colour-converted` caveat — **is not needed**. It remains the fallback if a future optimiser version defeats the ordering.

**CICP, not just ICC (A13) — settled, and worse than assumed.** The frame representation carries colour as either an ICC profile or a set of CICP values, because HEIC and AVIF commonly signal colour with an `nclx` box and no profile at all. A13's open half is answered: **ImageMagick neither applies nor reports CICP on decode.** For a CICP-only HEIC it returns no profile, no attribute carrying the values, and its own default BT.709 primaries from `image.chromaticity` — the same default it returns for a Display P3 file — so there is no way to recover the signal by asking ImageMagick harder. `heic:preserve-cicp` governs writing, not reading.

`pipeline/stages/colour.ts` therefore parses the `colr` box out of the source bytes, resolving the **primary item's** property through `pitm` → `ipma` → `ipco` rather than taking the first `nclx` in the file, since one `ipco` is shared with auxiliary items such as an alpha plane. `FrameColour` is a three-way union — `icc`, `cicp`, `untagged` — so a CICP-signalled image can never reach the encoder as untagged sRGB, and "no signal at all" stays distinct from "a signal that says the default". Where both an ICC profile and an `nclx` box are associated with the primary item, the profile wins (R-I12); a real AVIF in the test set is arranged exactly that way.

---

## 8. Memory

### 8.1 Budget

Decoded pixels dominate: width × height × 4 bytes per frame, at Q8 (A1). A 12 megapixel photo is roughly 48 MB decoded. Encoded results are a few hundred KB and are not the problem.

**An animated source costs that per frame, and then 2.2× to 2.8× again.** C7 is **refuted**, measured in T29 (`verification/t29-animated/results.json`) on all three engines: peak process RSS above a post-codec baseline is linear in frame count (R² ≥ 0.994) and linear in frame area (R² ≥ 0.999). The *marginal* multiplier — the fitted slope over the arithmetic `frames × w × h × 4` — is 2.293×, 2.733× and 2.637× per frame on Chromium, Firefox and WebKit. **The figure to budget against is the total one**, peak over arithmetic at the top of each sweep, which is higher because it includes the fixed overhead the slope excludes: up to **2.80×** (128 frames of 400×400 on WebKit). In absolute terms, 128 frames of 400×400 cost 193–219 MB above baseline for 78.1 MB of pixels, and 16 frames of 1200×1200 cost 205–235 MB for 87.9 MB. The frames exist twice at once by construction: inside ImageMagick's heap after `coalesce()`, and in the JS heap as the owned buffers the worker transfers. Releasing each `MagickImage` as its pixels are lifted does not lower the peak — ImageMagick's heap growth is byte-identical at 55,771,136 with the dispose and without, on all three engines — because `coalesce()` materialises every frame before the first pixel is extracted. So **R-B6's "wherever the format allows it" is, for this decoder, nowhere.** The animated frame budget in Functional Design §5.7 is therefore the binding limit for these inputs rather than the pixel cap, and §5.1's worker cap multiplies it.

The rules from Functional Design §9, as implementation constraints:

- One full-resolution decode in flight per worker, released before the next.
- Gallery's batch-scoped cache holds at most the configured thumbnail limit of bounded encoded thumbnail
  Blobs and nothing else. It may retain completed entries while another mode is active, but performs no
  generation there. List mode performs no generation (R-G9), and uncached entries remain placeholders
  after the read budget is spent.
- Preview holds one working set: decoded source for the Original tab, encoded result for the Compressed tab. Released on mode change, step, or settings change.
- Run outputs stream to storage as they are produced (§9), so the archive never accumulates in memory.

### 8.2 Worker recycling

**Contingent on C2**, currently 75%. Measured in Node, memory stayed flat across five consecutive 1600×1200 encodes with disposal between each. That is a weak proxy: Node resident memory is not the browser WASM heap, and 1600×1200 is modest next to a 50 megapixel phone photo.

If a browser test shows the heap does not return, workers are recycled after a threshold of processed pixels. The pool already supports replacing a worker, since §5.3 needs terminate-and-respawn regardless.

### 8.3 Limits

Every value in Functional Design §5.7 is a placeholder. **C3 is 30% confident and C4 is 25%.** They are derived from measurement, not chosen, and the code reads them from one configuration module so that changing them is a single edit.

The 200-file limit inherited from the original design draft is not defended by anything and should be assumed wrong until measured.

---

## 9. Output

### 9.1 Archive assembly

`client-zip` produces a `ReadableStream`. That stream is piped into a file in the Origin Private File System as the run proceeds, so memory holds one entry at a time rather than the archive (R-X38).

**E2 measured `predictLength` as byte-exact** across 50 entries with nested paths and non-ASCII filenames, so the quota preflight in R-X40 uses a real number rather than an estimate.

ZIP entries are stored rather than deflated for already-compressed formats (**E3**, 80%). PNG and GIF may still deflate usefully, so the setting is per entry.

### 9.2 Storage

OPFS is Baseline Widely available (**B1**, 97%). Quota comes from `navigator.storage.estimate()`, and differs sharply by platform: roughly 60% of disk on Chromium, roughly 20% on iOS WebKit (**B2**).

**Contingent on B4, 60% and the largest unknown in the project.** The claim is that handing a finished OPFS file to a download streams from disk rather than materialising in RAM. If it fails:

- Chrome falls back to `showSaveFilePicker` with `createWritable`, which writes directly to the user's chosen path. That requires the save location to be chosen in the user gesture, so compression would have to start after the Download press on Chrome only.
- Other browsers fall back to in-memory assembly with a hard batch cap derived from measurement.

This is the one place where the architecture would change shape rather than adjust a number, which is why B4 is second in the verification order.

Private browsing has no OPFS (**B3**), so the in-memory path is needed regardless. The stored archive is deleted after download, on leaving the Processing view, and on application start (R-X42).

### 9.3 The report

`domain/report.ts` builds a model; serialisation is separate and produces YAML with a `.txt` extension.

```yaml
# Mass Image Compressor
Run: 2026-09-13 14:22:05

Summary:
  Images processed: 128
  Succeeded: 124
  Failed: 2
  Skipped: 2
  Input size: 412.66 MB
  Output size: 88.21 MB
  Saved: 324.45 MB (78.6%)
  Exact bytes:
    Input: 432708301
    Output: 92494233
    Saved: 340214068

Settings:
  Quality: 70
  Format: Original formats
  Dimension: Fit within long edge, 1920 px

Failed:
  - file: holiday/day2/DSC_4417.jpg
    reason: File could not be decoded

Skipped:
  - file: holiday/logo.psd
    reason: Photoshop documents are not supported

Notes:
  - file: holiday/day1/banner.png
    note: Transparency flattened to white, JPEG has no alpha channel
  - file: holiday/day3/panorama.jpg
    note: Original kept, re-encoding produced a larger file
```

Rules implemented here: sizes human-readable to two decimals using 1024-byte units (R-X32), exact bytes on summary totals only (R-X33), ordinary successes counted but not listed (R-X35), non-image files never mentioned (R-X36), relative paths throughout (R-X37), and the fixed caveat set (R-X46).

`domain/sizes.ts` exports **two** formatters. One for the report, always dot-decimal and locale-independent. One for the interface, through `Intl.NumberFormat`. They must never be the same function (R-L3), and a unit test asserts the report formatter is unaffected by locale.

### 9.4 Naming

`domain/naming.ts`, pure. Under "Don't change" the original extension is reproduced byte for byte including case (R-X43). When the format changes, the canonical extension is used (R-X44). Collisions are resolved per directory, not globally (R-X22), so a folder tree never produces spurious renames.

---

## 10. Input

### 10.1 Selection

Three entry points: file picker, folder picker (`webkitdirectory`), and drop. Drop handles both files and directory entries via `DataTransferItem.webkitGetAsEntry`.

**B5 is 75% confident.** Folder input may not work on iOS Safari. R-I31 requires hiding the control rather than letting it fail, so the platform layer feature-detects and the UI binds to that.

### 10.2 Classification

Three buckets (Functional Design §5.1): supported image, image we cannot handle, not an image. Classification reads magic bytes rather than trusting the extension (R-I23). APNG is detected by the `acTL` chunk (R-I4, **D6**), which matters because ImageMagick's PNG reader silently returns only the first frame otherwise. Animated AVIF is detected and rejected (R-F8).

### 10.3 HEIC

**A8 is settled.** A real Apple HEIC decoded in 410 ms at 1500×1000 with correct pixels, and re-encoded to JPEG cleanly. HEIC is ordinary input on every browser. No capability probe, no browser branch. HEIC is never an output (**A11**: no x265 in the build).

Live Photo and portrait-mode files carry auxiliary and depth images. Only the primary image is processed, and R-I34 requires recording that in the report.

### 10.4 Thumbnails

`createImageBitmap` with bounded resize dimensions is the primary path. For a supported input that the
browser cannot decode natively, use ImageMagick's thumbnail operation as a fallback, not the full
processing pipeline. Both paths are generated lazily for visible and near-visible tiles only, with
virtualization (R-G10). In list mode, none at all (R-G9).

The thumbnail service owns two batch-scoped, non-reactive structures: the encoded Blob cache and a count
of source-read attempts. Both ceilings read the same `maximumThumbnails` value from the runtime limits
configuration; neither the service, UI nor tests hard-code the number. The shipped default is 100.
Starting a read consumes one attempt, including a read that later fails or is cancelled. There is no LRU
replacement: after either ceiling is reached, uncached tiles render a neutral placeholder instead of
evicting an entry and rereading sources as the user scrolls. Completed entries persist across
Gallery/Preview/Edit mode changes and are released on image removal, edit invalidation, or batch clear;
every release also revokes the corresponding object URL.

The generation queue and its execution context belong to the mounted Gallery grid. Unmounting Gallery or
switching to list mode clears the queue and stops the active job. Where the decoding primitive cannot be
cancelled directly, generation runs in an isolated worker that can be terminated. A generation token
prevents a raced completion from entering the cache after cancellation. No thumbnail decoding or encoding
may continue while Preview, Edit, Processing, or Gallery list mode is active (R-G12).

T20 measures JPEG and WebP thumbnail encoding time, retained size and peak memory rather than selecting a
format by assumption. Thumbnail dimensions bound both axes; a width-only bound is not sufficient for a
pathologically tall image.

**C5 is 55% confident** about throughput. It sets the threshold in R-G8, so until measured the app defaults to list mode at a conservative file count.

---

## 11. Internationalisation

English ships first; the structure supports translation without restructuring (R-L1 to R-L5).

Two parallel files per locale:

```
i18n/
  en/
    messages.json     key -> string
    context.json      key -> translator context
```

`context.json` carries, per key, the situation the string appears in, what the surrounding control does, and any length constraint. A translator working from keys and strings alone cannot tell a verb from a noun in English, and that is where translation quality is lost. A CI check fails when a key exists in `messages.json` without an entry in `context.json`.

Other rules with implementation consequences:

- No runtime concatenation. One parameterised string per sentence (R-L5), because word order differs by language.
- Logical CSS properties throughout: `inline-start`, `inline-end`, `padding-inline`. The side panel and drawer are on the inline-end side, not the right (R-L4).
- The report is never translated (R-L3). See §9.3.

Locale routing is a real path, `massimg.com/es/`, with `hreflang`. Client-side switching alone would give one indexable page, which defeats the point for a site whose job is to rank.

---

## 12. Hosting and delivery

Static files on Hostinger. HTTPS is mandatory rather than advisable, since OPFS requires a secure context.

**B9 is 70% confident** that custom response headers can be set via `.htaccess`. This matters twice: cache headers on the large WASM payloads, and COOP/COEP if a threaded build is used (**B6**). If headers cannot be set, the threaded build is unavailable and single-threaded performance becomes the baseline.

**B7**: the x86 build is wasm32 with a roughly 4 GB ceiling; the x64 build needs memory64 and failed to instantiate under Node 22. Start with x86 for compatibility.

### 12.1 Load strategy

The landing page exists to rank for "compress image online" and its translations, so it must be fast. Nothing in §7.1 may block first paint.

1. HTML, CSS and the Vue shell, small enough to render immediately.
2. ImageMagick's WASM fetched on idle after first paint, or on first interaction, whichever comes first.
3. Every other codec on first use (§5.2).

WASM payloads get long cache lifetimes and content-hashed filenames. They change rarely and are the largest thing we ship.

---

## 13. Testing

| Layer | Tool | Covers |
| --- | --- | --- |
| `domain/` | Vitest | Crop arithmetic (§6 table as fixture), settings resolution, quality mapping, naming and collisions, report model, size formatting, caveat set |
| Pipeline | Vitest with real WASM | Per-format encode, quality mapping end to end, the two comparison rules, animated round-trips |
| Components | Vitest, Vue Test Utils | Mode transitions against the table in Functional Design §3.1 |
| Browser | Playwright, three engines | Folder input, OPFS, download, worker cancellation, memory behaviour |
| Fixtures | — | Eight-orientation EXIF set (**D4**), ICC-tagged images (**D3**), animated GIF and APNG, a real HEIC (**A8**), transparent PNGs, deep folder trees |

The fixture set is the part most likely to be skipped and most likely to catch real bugs. D4 in particular fails on the mirrored orientations, not the rotations, and only a full test set finds that.

T23 built the first of these: `tests/fixtures/decode/`, generated by `scripts/build-test-fixtures.mjs` — the eight-orientation EXIF set, an ICC-tagged JPEG and AVIF, a CICP-signalled AVIF, and the untagged counterpart of each. Uprightness is asserted by pixel content rather than dimensions, because 2 and 4 share their output dimensions with 1 and 3, and 5 and 7 with 6 and 8: a dimensions-only check passes on all eight while every flip is wrong. **A real HEIC cannot be committed** — the build has no HEVC encoder (A11) and a real one is a copyrighted photograph — so HEIC decode, including the CICP-only case, is proven against the machine-local fixture directory in `verification/t23-decode/` instead.

---

## 14. Assumption dependencies

Which sections change if an entry fails.

| Assumption | Conf | Section at risk | Consequence if false |
| --- | --- | --- | --- |
| **B4** | 90 | §9.2 | Architecture changes shape. Chrome defers compression to the Download press; others get a hard cap |
| **A13** | 95 | §7.7 | Settled in T23 for the mechanism — ImageMagick reports nothing about CICP, so the pipeline parses the `colr` box itself. The *frequency* clause is unconfirmed: no naturally CICP-only file in the local sample |
| **D7** | 99 | §7.3 | Confirmed on twenty real photographs (T02); residual risk is untested content types, not the direction |
| **D1** | 99 | §7.5 | **Settled in T30.** The search costs 1, 2, 3 or 8 encodes and nothing between; AVIF at §7.3's speed is 10.8× quicker than at the library default, so **R-Q4 excludes no format**. Residual risk is wall time on hardware slower than a desktop, not the structure |
| **C2** | 92 | §8.2 | Workers recycle on a pixel budget; throughput drops |
| **C4** | 25 | §8.3 | Mobile caps fall, possibly far |
| **C3** | 30 | §8.3 | Every limit value changes; no structural change |
| **D8** | 95 | §7.2 | **Refuted in T27.** ImageMagick's own quantizer is worse at equal colour count and has no quality floor at all, which is the mechanism R-Q11's floor is made of. libimagequant stays, at 347 KB. The floor stays at 70 |
| **C7** | 95 | §8.1, §4.2 | **Refuted in T29.** Peak memory is linear in frame count *and* in frame area, at a marginal 2.29×–2.73× the coalesced frame data and up to **2.80×** measured total, on all three engines. No structural change — coalescing is forced by R-Q9 and by resize correctness — but §5.7's animated frame budget is set from this rather than guessed, and it binds before the pixel cap does |
| **C8** | 80 | §5.2 | Codecs split across workers; pool becomes heterogeneous. Measured in T22 for one worker on desktop; the 3-concurrent-worker case is the residual risk |
| **B5** | 75 | §10.1 | Folder input hidden on platforms that cannot do it |
| **B9**, **B6** | 70, 90 | §12 | Threaded build unavailable; single-threaded baseline. **Measured in T27**: with no COOP/COEP, all three engines refuse `SharedArrayBuffer` and oxipng takes its single-threaded build, which is the baseline this design already assumes |
| **C5** | 85 | §10.4 | List view becomes the default at a lower threshold. Measured in T20: the threshold is `maximumThumbnails`, and no fallback was needed |
| **D3** | 90 | §7.7 | Measured in T23: every path preserves the profile except apng-optimizer, which is avoided by attaching `iCCP` after it runs. The sRGB-conversion contingency is no longer needed |
| **E1** | 76 | §9.1 | Batch caps tighten |

**B4 is now settled** (T01, 90%): it held on Chromium, Firefox and desktop WebKit, so no fallback and no structural change are needed for those engines. iOS Safari is untested and deferred to T46, but that no longer blocks starting implementation the way an open B4 would have. The gifsicle licence question in §7.2 needs a legal answer before release but does not block implementation, since the fallback is ImageMagick's own GIF writer at worse compression.
