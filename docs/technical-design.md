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

**Component boundaries follow the stage modes.** Gallery, Preview, Edit and Processing are separate components mounted exclusively, so leaving a mode unmounts its state and its listeners. R-M4 requires releasing image data on mode change, and tying that to the component lifecycle makes the release automatic rather than remembered.

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
| GIF | decode, orient, edit, resize, encode-gif, gifsicle |
| WebP animated | decode-frames, edit-frames, resize-frames, encode |
| PNG animated | decode-frames, edit-frames, resize-frames, assemble-apng, optimise-apng |

Stages share one intermediate representation, an RGBA frame buffer with dimensions and an optional ICC profile. Without this, the GIF and animated paths each grow their own copy of the resize and edit logic, which is how the two drift apart.

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

A worker that needs a module it has not loaded loads it and then proceeds. **Contingent on C8**: if three modules in one worker prove too heavy, they split across workers by codec, and the pool becomes heterogeneous.

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
| libimagequant | PNG quantization | GPL v3, compatible with AGPL v3 | see §7.2 |
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
| AVIF | `heic:speed` 9, never the default | **D7**: on twenty real photographs, speed 9 is 9.94x faster than speed 6 and 2.10x faster than speed 8 on average, with mean SSIM flat across speeds 6-9 (0.9857-0.9861) and under 1% size difference between speeds 8 and 9. Default is 7611 ms vs. 452 ms for speed 9 on the original single-image measurement |
| WebP | `method` 4, the library default, not 6 | Method 6 costs several times the time for low single-digit size gains |
| oxipng | `level` 2, not 6 | Above level 2 the curve flattens sharply |
| gifsicle | `-O2`, not `-O3` | `-O3` tries every option per frame |
| PNG deflate | Default, no zopfli | apng-optimizer's zopfli setting stays low for the same reason |

**D7 is 99% confident.** The original measurement used synthetic noise, which is unusually hostile to AVIF and might have flattened the quality difference between speed settings. T02 repeated the comparison on twenty real photographs at speeds 6 through 9 with quality 70 and an SSIM perceptual check: quality was statistically indistinguishable across all four speeds (mean SSIM 0.9857-0.9861), and speed 9 was 2.1x faster than speed 8 for under 1% more size. Speed 9 is the chosen value, not a range.

### 7.4 Quality mapping

Implements Functional Design §7.1. The mapping is pure and lives in `domain/job.ts`.

| Format | Slider 96 to 100 | Slider 10 to 95 |
| --- | --- | --- |
| JPEG | quality as given | quality as given |
| PNG | lossless from 85 (R-Q12) | `70 + (q - 10) × 30 / 90`, then quantize |
| WebP | `lossless=true` | lossy, plus lossless comparison (R-Q6) |
| AVIF | lossless mode | quality as given |
| GIF | no `--lossy` | `--lossy` derived from quality |

### 7.5 Size targeting

Binary search over the quality parameter. **D1 measured** six to seven iterations to converge on a 1600×1200 image:

| Format | Iterations | Time at default effort |
| --- | --- | --- |
| JPEG | 6 | 1260 ms |
| WebP | 6 | 3770 ms |
| AVIF | 7 | 29,317 ms |

The AVIF figure is at the default speed. At speed 9 the same search is roughly 3 seconds, so R-Q4 should not exclude AVIF. Re-measure with §7.3 settings applied before deciding.

PNG and GIF search a different axis, colour count and lossy level, which converges differently and needs its own measurement.

Search caps at 8 iterations. If the target is unreachable, the smallest achieved result is kept and the caveat recorded (R-Q3).

### 7.6 The two comparison rules

R-Q6 (WebP) and R-Q14 (PNG) both encode twice and keep the smaller. **D2 measured** the WebP case at 1600×1200:

| Content | Lossy q70 | Lossless | Winner |
| --- | --- | --- | --- |
| Photographic | 518,150 B, 1155 ms | 1,357,564 B, 2862 ms | Lossy by 2.6x |
| Flat graphic | 16,586 B, 224 ms | 522 B, 64 ms | Lossless by 32x |

Both halves earn their place. The gate permitted by R-Q6 is worth building: unique colour count separates these cases cleanly, and skipping the lossless attempt on photographs saves 2.9 seconds per image.

### 7.7 Colour management

`lcms` is in the build (A2). The rule is preserve, not convert (R-I12 to R-I16). The ICC profile travels through the pipeline as part of the frame representation and is written by the encoder.

**D3 is 55% confident**, and the weak point is animated PNG, which leaves ImageMagick entirely and passes through UPNG. If the profile cannot survive that path, the choice is to convert to sRGB for animated PNG only and record the caveat, since silently shifted colour is worse than a recorded conversion.

**CICP, not just ICC (A13).** The frame representation must carry colour as either an ICC profile or a set of CICP values, because HEIC and AVIF commonly signal colour with an `nclx` box and no profile at all. The test HEIC did exactly this. A pipeline that only looks for an ICC profile would treat such an image as untagged sRGB and shift its colour silently. The build exposes `heic:preserve-cicp`, so the capability exists; whether ImageMagick applies CICP automatically on decode is the open part of A13.

---

## 8. Memory

### 8.1 Budget

Decoded pixels dominate: width × height × 4 bytes per frame, at Q8 (A1). A 12 megapixel photo is roughly 48 MB decoded. Encoded results are a few hundred KB and are not the problem.

The rules from Functional Design §9, as implementation constraints:

- One full-resolution decode in flight per worker, released before the next.
- Gallery holds a bounded thumbnail per image and nothing else. In list mode, not even that (R-G9).
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
Mass Image Compressor
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

`createImageBitmap` with `resizeWidth`, not the WASM pipeline. Generated lazily for visible tiles only, with virtualization (R-G10). In list mode, none at all (R-G9).

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

---

## 14. Assumption dependencies

Which sections change if an entry fails.

| Assumption | Conf | Section at risk | Consequence if false |
| --- | --- | --- | --- |
| **B4** | 90 | §9.2 | Architecture changes shape. Chrome defers compression to the Download press; others get a hard cap |
| **A13** | 95 | §7.7 | CICP-signalled colour shifts silently unless the pipeline carries it |
| **D7** | 99 | §7.3 | Confirmed on twenty real photographs (T02); residual risk is untested content types, not the direction |
| **C2** | 92 | §8.2 | Workers recycle on a pixel budget; throughput drops |
| **C4** | 25 | §8.3 | Mobile caps fall, possibly far |
| **C3** | 30 | §8.3 | Every limit value changes; no structural change |
| **D8** | 40 | §7.2 | Quantizer choice changes; the R-Q11 floor rises above 70 |
| **C8** | 60 | §5.2 | Codecs split across workers; pool becomes heterogeneous |
| **B5** | 75 | §10.1 | Folder input hidden on platforms that cannot do it |
| **B9**, **B6** | 70, 85 | §12 | Threaded build unavailable; single-threaded baseline |
| **C5** | 55 | §10.4 | List view becomes the default at a lower threshold |
| **D3** | 55 | §7.7 | Animated PNG converts to sRGB and records a caveat |
| **E1** | 76 | §9.1 | Batch caps tighten |

**B4 is now settled** (T01, 90%): it held on Chromium, Firefox and desktop WebKit, so no fallback and no structural change are needed for those engines. iOS Safari is untested and deferred to T46, but that no longer blocks starting implementation the way an open B4 would have. The gifsicle licence question in §7.2 needs a legal answer before release but does not block implementation, since the fallback is ImageMagick's own GIF writer at worse compression.
