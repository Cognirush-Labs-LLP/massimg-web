# Mass Image Compressor Web: Assumptions Register

Every claim the design rests on, its confidence, the evidence behind it, and the test that would settle what is still open.

The purpose is to stop design decisions resting on plausible-sounding but unchecked statements. Several claims early in this project were stated confidently and later refuted by a short test. Those are recorded in §7 rather than quietly deleted, because the pattern of error is itself useful.

## How to use this document

**Confidence** is a judgement about how likely the claim is to hold, given what is known now. It is not the same as status. A claim can be `UNVERIFIED` at 85% because the indirect evidence is strong, or `VERIFIED-TEST` at 90% because the test was run on synthetic data rather than real files.

| Band | Meaning |
| --- | --- |
| 95 to 100 | Directly tested in this project, or true by specification |
| 75 to 94 | Strong indirect evidence. Would be surprising to be wrong |
| 50 to 74 | Plausible with real doubt. Do not build on it without a test |
| Below 50 | A guess. Treat any design resting on it as provisional |

**Status** records where the evidence came from.

| Status | Meaning |
| --- | --- |
| `TESTED` | Confirmed by running code in this project |
| `BINARY` | Confirmed by inspecting the shipped WASM binary |
| `DOC` | Confirmed from primary documentation or specification |
| `OPEN` | Not yet established |
| `REFUTED` | Tested and found false |

**Priority.** `P1` blocks architecture. `P2` blocks a requirement or a limit value. `P3` affects quality or polish.

When an entry is settled, update it in place. Do not delete refuted entries. Test measurements in this document come from a Node 22 container on server hardware, single-threaded. Browser and phone figures will differ, and where that matters it is said.

---

## 1. Summary

| ID | Claim | Conf | Status | Pri |
| --- | --- | --- | --- | --- |
| A1 | Build is ImageMagick 7.1.2-30 Q8 wasm32 | 100 | TESTED | — |
| A2 | Delegate list as recorded | 100 | TESTED | — |
| A3 | Animated WebP and GIF encoding work | 100 | TESTED | — |
| A4 | APNG unavailable from ImageMagick, ffmpeg delegate | 100 | TESTED | — |
| A5 | UPNG.js produces valid APNG | 100 | TESTED | — |
| A6 | apng-optimizer is an optimizer, not an encoder | 100 | TESTED | — |
| A7 | gifsicle-wasm-browser scope and licence | 95 | DOC | — |
| A8 | HEIC decoding works | 100 | TESTED | — |
| A9 | libimagequant is **not** linked into the build | 95 | BINARY | P2 |
| A10 | UPNG `cnum` quantization is effective | 100 | TESTED | P3 |
| A11 | HEIC encoding is impossible in this build | 95 | BINARY | — |
| A12 | Gifsicle's alternative licence permits AGPL v3 use | 90 | DOC | P2 |
| A13 | Colour often signalled by CICP, not ICC | 95 | TESTED | P2 |
| B1 | OPFS available across target browsers | 97 | DOC | P1 |
| B2 | OPFS quota differs sharply by platform | 90 | DOC | P2 |
| B3 | OPFS unavailable in private browsing | 90 | DOC | P2 |
| B4 | OPFS download does not materialise in RAM | 90 | TESTED | P1 |
| B5 | Folder input works across browsers | 90 | TESTED | P2 |
| B6 | Cross-origin isolation needed for threads | 85 | OPEN | P2 |
| B7 | x64 build requires memory64 | 80 | TESTED | P2 |
| B9 | Host can set custom response headers | 70 | OPEN | P2 |
| C1 | File handles are not backed by memory | 90 | DOC | P1 |
| C2 | WASM memory is reclaimed after large images | 92 | TESTED | P1 |
| C3 | Practical per-image and per-batch limits | 30 | OPEN | P2 |
| C4 | iOS Safari termination threshold | 25 | OPEN | P1 |
| C5 | Thumbnail generation throughput | 85 | TESTED | P2 |
| C7 | Animated sources processed incrementally | 45 | OPEN | P2 |
| C8 | Six WASM modules coexist acceptably, loaded lazily | 80 | TESTED | P2 |
| D1 | Size-target search is affordable | 95 | TESTED | P2 |
| D2 | WebP lossless wins on graphics, loses on photos | 98 | TESTED | P2 |
| D3 | ICC profiles survive every encoder path | 90 | TESTED | P2 |
| D4 | EXIF auto-orientation correct for all eight values | 95 | TESTED | P2 |
| D5 | Transparency detection is cheap | 70 | OPEN | P3 |
| D6 | APNG input detection via `acTL` | 90 | TESTED | P3 |
| D7 | AVIF encode speed is controllable and default is bad | 95 | TESTED | P1 |
| D8 | PNG quantization quality via ImageMagick alone | 40 | OPEN | P2 |
| E1 | Streaming ZIP holds bounded memory | 76 | OPEN | P2 |
| E2 | `predictLength` is exact | 100 | TESTED | P3 |
| E3 | ZIP compression level not worth paying for | 80 | OPEN | P3 |

---

## 2. Toolchain capability

### A1 `TESTED` `100%` Build identity

`@imagemagick/magick-wasm` 0.0.43 is ImageMagick 7.1.2-30, Q8, wasm32. The binary is 14.8 MB uncompressed. Q8 means 8 bits per channel, so decoded pixel cost is width by height by 4 bytes rather than double that.

**Affects.** §9 memory policy, all limit calculations in §5.7.

**Evidence.** `Magick.imageMagickVersion`.

---

### A2 `TESTED` `100%` Delegate list

`bzlib freetype heic jng jp2 jpeg jxl lcms lqr openexr png raw tiff webp xml zlib`.

**Affects.** §5.1 accepted formats, §5.5 colour management via `lcms`, A8, A9.

---

### A3 `TESTED` `100%` Animated WebP and GIF encoding

Six frames at 400×400 written and read back as six. WebP 279 ms, GIF 439 ms, AVIF 1267 ms.

**Affects.** R-F5, R-F6.

**Method.** Build a `MagickImageCollection`, set `format` on each frame, `write(format, cb)`, read back, assert frame count.

**Note.** Animated AVIF was dropped by decision (R-F7), not capability. It encodes correctly. Given D7, the cost argument against it is weaker than it was when the decision was made, and it is reasonable to revisit.

---

### A4 `TESTED` `100%` APNG cannot be written by ImageMagick in WASM

ImageMagick's APNG writer shells out to `ffmpeg`. WASM cannot spawn processes. Every format ImageMagick implements through an external delegate is unavailable for the same reason.

**Evidence.** `FailedToExecuteCommand 'ffmpeg' -nostdin -loglevel error -i '/tmp/magick-...%d.webp' -plays 0 -filter:v`.

---

### A5 `TESTED` `100%` UPNG.js produces valid APNG

**Evidence.** Chunk inventory: `IHDR:1 sRGB:1 acTL:1 fcTL:6 IDAT:1 fdAT:5 IEND:1`. Round-tripped as six frames with correct delays.

---

### A6 `TESTED` `100%` apng-optimizer is an optimizer, not an encoder

Exports only `createOptimizer` and `optAPNG`. APNG in, APNG out. Cannot assemble frames.

**Consequence.** The animated PNG path is ImageMagick for frames, UPNG to assemble, apng-optimizer to shrink.

---

### A7 `DOC` `95%` gifsicle-wasm-browser scope

Gifsicle 1.92 complete, MIT, no dependencies, 368 KB unpacked. GIF in, GIF out only. Exposes `--lossy`, `-O1/-O2/-O3`, `--resize`, `--crop`, `--rotate`.

**Why not 100.** Package metadata and README read, but not executed, since it is browser-only.

**Method to close.** Run it in a Playwright-driven page against a real animated GIF and compare output size against ImageMagick's own GIF writer.

---

### A8 `TESTED` `100%` `P1` HEIC decoding works

**Settled.** A real Apple-produced HEIC (`ftypheic`, brands `mif1 MiHE miaf MiHB heic`, 943,756 bytes) decoded correctly.

| Measure | Result |
| --- | --- |
| Decode time | 410 ms for 1500×1000 |
| Dimensions | 1500×1000, depth 8 |
| Pixel data | mean 150.51, stddev 31.81, visually confirmed correct |
| Re-encode to JPEG q80 | 288,841 bytes in 143 ms |

**Consequence.** HEIC is ordinary input on every browser. R-I6, the browser capability check, and the Safari-only fallback are all deleted from Functional Design §5.2. HEIC remains impossible as output (A11).

**Not covered by this test.** A Live Photo or portrait-mode file carrying depth and auxiliary images. Worth testing before release, since those are common on iPhones and are where a decoder is most likely to pick the wrong image item.

---

### A13 `TESTED` `95%` `P2` Colour is often signalled by CICP, not an ICC profile

**Claim.** HEIC and AVIF frequently carry colour information as an `nclx` box (CICP: primaries, transfer function, matrix coefficients) instead of an embedded ICC profile. The colour management requirements are written entirely around ICC profiles and do not cover this.

The claim has two halves, and T23 settled them to different degrees. Read them separately — the mechanism half is what the code depends on.

#### The mechanism half: settled, and worse than assumed

**ImageMagick does not surface CICP at all.** Measured on the real HEIC and AVIF files in the local test set and on a real HEIC rewritten to signal its colour only with CICP (`verification/t23-decode/`):

| What was asked of ImageMagick | Answer for a CICP-only HEIC |
| --- | --- |
| `getColorProfile()` | `null` |
| `profileNames` | `["exif"]` — no `icc` |
| `attributeNames` | nothing carrying primaries, transfer or matrix |
| `image.chromaticity` | BT.709 primaries (0.64, 0.33) — **its own default, returned for every file including a Display P3 one** |

So chromaticity is not a fallback source of evidence, and a pipeline that asks ImageMagick alone sees an untagged image. The `heic:preserve-cicp` define exists, but it governs *writing*; nothing applies or reports CICP on decode. This half is as close to certain as a measurement gets.

**Consequence, implemented.** `pipeline/stages/colour.ts` parses the `colr` box out of the source bytes itself, resolving the **primary item's** property through `pitm` → `ipma` → `ipco` rather than taking the first `nclx` in the file. `FrameColour` is a three-way union — `icc`, `cicp`, `untagged` — so "signalled by CICP" can never arrive at the encoder as "untagged sRGB".

**Measured, on a real HEIC** (`verification/t23-decode/results.json`, `a13.cicpOnlyHeic`). A 1.19 MB, 4032×3024 Apple HEIC carrying a Display P3 ICC profile was copied in memory and its 560-byte `colr` box overwritten in place, same size, with an `nclx` payload of 12/13/6:

| | Original | Rewritten to CICP-only |
| --- | --- | --- |
| ICC profile reported | Display P3 | none |
| CICP found by the shipped reader | none | 12 / 13 / 6, full range |
| Decoded pixels | — | **byte-identical to the original** |

Identical pixels, no profile, and the colour recoverable only through the box ImageMagick ignores.

#### The frequency half: not confirmed by this sample

**The local sample contains no naturally CICP-only file.** Of **three distinct** HEIF-family images (five paths; the directory holds duplicates, and `heifCandidates` now deduplicates by content hash so the count cannot be inflated again):

| File | `colr` boxes | ImageMagick sees | Frame resolves to |
| --- | --- | --- | --- |
| HEIC, 1.19 MB | `prof` only | Display P3 ICC | `icc` |
| HEIC, 381 KB (`msf1` sequence) | none | nothing | `untagged` |
| AVIF, 7.6 KB | `prof` **and** `nclx` 2/2/2 | sRGB ICC | `icc` |

Zero files signal colour by CICP *instead of* a profile. The one CICP-only file in evidence is the one this task manufactured. On this sample the frequency clause is mildly counter-indicated, not supported — it rests on the prevalence of the format's use in the wild (Apple's own `heic:preserve-cicp` define exists for a reason, and the AVIF here does carry an `nclx`), not on anything measured here.

**Why 95 and not 100.** The mechanism is settled and the handling is implemented and tested on all three engines; that alone would justify a higher figure. The claim as written is about *frequency*, and three files — one of them an image sequence — cannot establish it. Raising the entry to certainty on the strength of the neighbouring proposition would be the substitution this register exists to avoid.

**How the evidence is held.** The real-HEIC half is a **recorded measurement, not a regression guard**: it runs only from `verification/t23-decode/` and only when `PHOTO_FIXTURES_DIR` is set, never in CI. If HEIC handling broke tomorrow, nothing committed would fail. The committed cross-engine tests use a generated AVIF — the same ISO/IEC 23008-12 container and the same `colr`/`nclx` box, exercising the identical code path, since `readCicp` never inspects the brand and `decode.ts` has no format switch.

**What would close the frequency half.** A HEIC straight off a recent iPhone in a wide-gamut capture mode, or an AVIF from a camera or encoder that writes `nclx` without a profile, examined for a `colr nclx` and no `prof`.

---

### A9 `BINARY` `95%` `P2` libimagequant is not linked

**Claim.** The build does not contain libimagequant. The single `imagequant` hit is `GetImageQuantizeError`, which is ImageMagick's own function.

**Affects.** R-Q11 and R-Q14. PNG quantization must come from ImageMagick's internal quantizer, or from a second WASM module, and the two differ in quality.

**Method to close.** See D8, which is the decision this feeds.

---

### A10 `TESTED` `100%` `P3` UPNG `cnum` quantization is effective

**Measured**, 8 frames at 400×300 of photographic content:

| cnum | Size | Time |
| --- | --- | --- |
| 0 (lossless) | 346.1 KB | 566 ms |
| 256 | 110.3 KB | 499 ms |
| 128 | 94.6 KB | 375 ms |
| 64 | 80.4 KB | 260 ms |
| 32 | 66.9 KB | 166 ms |

Quantization is both smaller and faster. An earlier test showed no effect, but used flat-colour frames with almost no unique colours, which is why that result was recorded as inconclusive rather than negative.

**Open question this raises.** UPNG quantizes adequately on its own. Whether apng-optimizer earns its place in the bundle is now a measurement, not an assumption.

---

### A12 `DOC` `90%` `P2` Gifsicle's alternative licence permits use in an AGPL v3 project

**Claim.** Gifsicle is GPL v2-only, which conflicts with the project's AGPL v3 licence, but its alternative grant permits use because the project publishes its source.

**Affects.** Whether gifsicle can be shipped at all. Without it, GIF compression falls back to ImageMagick's own writer, which is substantially worse.

**Evidence.** Gifsicle's README states GPL version 2 and only version 2, and separately offers an alternative grant conditioned on source availability.

**Why not higher.** Licence interpretation is not an engineering judgement, and there is a second unresolved question about whether separately compiled WASM modules form one combined work.

**Method to close.** A lawyer reads both licences and the dependency graph. Record the answer in Technical Design §7.2.

---

### A11 `BINARY` `95%` HEIC encoding is impossible

No `x265` or `kvazaar` in the binary. `Encoder_HEVC` exists only as libheif's plugin interface with nothing behind it.

**Affects.** Confirms R-I8. HEIC is never an output format, and this is a capability limit rather than a product choice.

---

## 3. Browser platform

### B1 `DOC` `97%` `P1` OPFS is available across target browsers

Baseline Widely available since March 2023. Chrome 108, Firefox 111, Safari 16.4, Safari on iOS 16.4. Available in Web Workers. Requires a secure context.

**Method to close.** Feature-detect and round-trip a file on each target browser, including iOS Safari.

---

### B2 `DOC` `90%` `P2` OPFS quota differs sharply by platform

Chromium allows an origin up to 60% of total disk. On iOS every browser uses WebKit and is limited to roughly 20% of total disk per origin. Quota-managed storage can be evicted.

**Method to close.** `navigator.storage.estimate()` on each platform, compare against documented figures.

---

### B3 `DOC` `90%` `P2` OPFS unavailable in private browsing

Safari private windows do not provide OPFS. Firefox disables it in private mode.

**Affects.** R-X41 fallback.

---

### B4 `TESTED` `90%` `P1` Downloading an OPFS file does not materialise it in RAM

**Claim.** A `File` from an OPFS handle, passed to `URL.createObjectURL` and an anchor click, streams from disk rather than loading into memory.

**Affects.** Everything about large batches. If false, the memory ceiling on output is the same as in-memory assembly and the OPFS path buys nothing at the download step.

**Measured** (T01, `verification/t01-opfs-memory`). Wrote 1 GB then 3 GB into OPFS in 32 MB chunks, then triggered a download via `createObjectURL` + a synthetic anchor click, on Chromium, Firefox and WebKit under Playwright, sampling total RSS across the browser's whole OS process tree every 200 ms. Two full passes, consistent within a few percent:

| Engine | Idle baseline | Peak, 1 GB write | Peak, 1 GB download | Peak, 3 GB write | Peak, 3 GB download |
| --- | --- | --- | --- | --- | --- |
| Chromium | ~256–326 MB | ~352 MB | ~330–333 MB | ~367–398 MB | ~371–399 MB |
| Firefox | ~1002–1044 MB | ~1071–1072 MB | ~1045–1046 MB | ~1077–1078 MB | ~1050–1078 MB |
| WebKit | ~109–115 MB | ~109 MB | ~109–115 MB | ~109 MB | ~97–109 MB |

Pass condition ("peak stays far below file size") held on all three engines: peaks stay in the hundreds-of-MB range and barely move between 1 GB and 3 GB of file size, where a full in-memory materialisation would show peak minus baseline tracking the file size directly (i.e. roughly 3 GB more at the 3 GB size than at the 1 GB size). Confirmed byte counts (`file.size` after write; the downloaded file's size on disk) matched the target exactly in every run, so the low memory reading isn't an artefact of a truncated write or download. Full detail, per-phase numbers and methodology in `docs/task-notes/T01.md`.

**Why not higher.** iOS Safari — the platform with the tightest OPFS quota (B2, ~20% of disk) and the one most likely to diverge — is out of scope for this task (needs real hardware; deferred to T46) and remains completely unverified. Desktop WebKit here is Playwright's bundled build, not shipping Safari. Everything ran on one machine (macOS) with a synthetic, single-byte-pattern payload rather than a real image/archive, and the two runs, while consistent, are not a large sample. Firefox's absolute baseline (~1 GB RSS at idle) is unexpectedly high for a blank automation profile, though it is flat rather than size-proportional, which is the property B4 actually claims.

**Method.** Write 1 GB, then 3 GB, into OPFS in chunks. Trigger a download. Watch tab memory in the browser task manager. Pass condition: peak stays far below file size. Test Chrome, Firefox, Safari desktop and iOS Safari separately. *(T01 completed this for Chromium, Firefox and desktop WebKit via Playwright's OS-process-RSS proxy rather than the manual task manager; iOS Safari on real hardware is still open, see T46.)*

**Fallback if false.** Chrome uses `showSaveFilePicker` with `createWritable`. Other browsers get a hard batch cap from measured in-memory assembly. Not engaged for any engine T01 tested — B4 held on Chromium, Firefox and desktop WebKit. If iOS Safari (T46) turns out to fail, it falls into the "other browsers" fallback (hard batch cap from measured in-memory assembly), since `showSaveFilePicker` is Chromium-only.

---

### B5 `TESTED` `90%` `P2` Folder input works across browsers

`<input webkitdirectory>` supported in Chrome, Firefox and Safari, each file carrying a usable `webkitRelativePath`. Dropped folders traversable with `DataTransferItem.webkitGetAsEntry`.

**Measured** (T18, `tests/e2e/folder.spec.ts`). A nested fixture tree (three real files at three depths, a dot-prefixed file, `Thumbs.db`, `desktop.ini`, and a dot-prefixed directory whose contents must not appear at all) was selected via `page.setInputFiles()` against a real `<input webkitdirectory>` element on Chromium, Firefox and desktop WebKit. On every engine, `webkitRelativePath` came back exactly as expected — including the hidden dotfile, the two named system files and the entire hidden directory, all of which the browser *does* surface to script (nothing filters them out before JavaScript sees them; `platform/folder.ts` does that filtering). No divergence between engines: desktop WebKit's folder-picker behaviour was identical to Chromium's and Firefox's on every case tested, including the depth-cap and file-count-cap rejection paths. The drop path (`DataTransferItem.webkitGetAsEntry`) could not be exercised with a genuine OS-level drag on any engine — no browser-automation tool can synthesize one, since `webkitGetAsEntry()` only returns a real entry for browser-populated items, never for script-constructed ones (see `docs/task-notes/T18.md`) — so its traversal logic (identical code path to the picker's cap/filter logic, sharing the same relative-path convention) was proven instead by calling `readDroppedFolder()` directly with a structurally faithful mock `FileSystemDirectoryEntry`/`FileSystemFileEntry` graph, and cross-checked to produce an identical file list to the real picker-based traversal of the same tree.

**Why not higher.** Everything above is desktop WebKit (Playwright's bundled build, run on macOS), not real iOS Safari, which is the platform this assumption was actually written to worry about. iOS Safari on real hardware is still completely unverified and remains T46's job, same caveat B4 carries for the same reason. The genuine OS-level drop path is untestable in *any* automation tool on *any* engine, not just unverified here — see Surprises in `docs/task-notes/T18.md`.

**Method.** On each browser, select a nested folder and log every `webkitRelativePath`. Drop the same folder and traverse, comparing the two file lists. Record iOS Safari explicitly. *(T18 completed the picker half for Chromium, Firefox and desktop WebKit exactly as specified. The drop half was completed as a direct call to `readDroppedFolder()` with a structural mock rather than a real OS-level drag — no automation tool can produce a genuine one — and its result was compared against the picker's file list for the same tree, which is the comparison this method was actually after. iOS Safari on real hardware remains open, see T46.)*

---

### B6 `OPEN` `85%` `P2` Cross-origin isolation required for threads

A threaded WASM build needs `SharedArrayBuffer`, which needs COOP and COEP.

**Method.** Determine whether the chosen build is threaded. If it is, deploy with and without the headers and record what breaks.

---

### B7 `TESTED` `80%` `P2` The x64 build requires memory64

The x64 build failed to instantiate under Node 22 in this container, consistent with a memory64 requirement. The x86 build is wasm32 with a roughly 4 GB linear memory ceiling.

**Why not higher.** The failure is consistent with memory64 but the error was not conclusive on its own.

**Method.** Attempt instantiation of the x64 build in each target browser and record support and the ceiling reached.

---

### B9 `OPEN` `70%` `P2` The host can set custom response headers

Hostinger allows response headers on a static site via `.htaccess` or equivalent.

**Affects.** B6 directly, and cache-control on the large WASM payloads.

**Why only 70.** Shared hosting varies, and some plans ignore directives silently, which is worse than refusing them.

**Method.** Deploy with `.htaccess` setting COOP and COEP. Fetch and inspect response headers, then check `crossOriginIsolated` in the page. Repeat for long `Cache-Control` on a `.wasm`.

---

## 4. Memory and scale

### C1 `DOC` `90%` `P1` File handles are not backed by memory

Holding hundreds or thousands of `File` objects costs kilobytes. They are lazy references to bytes on disk; memory is consumed only on an explicit read.

**Method.** Select 1000 files, hold the array, measure tab memory before and after, then read one and measure again.

---

### C2 `TESTED` `92%` `P1` WASM memory is reclaimed after large images

**Measured, in a real browser (Chromium via Playwright, headless), superseding the earlier Node measurement below.** `@imagemagick/magick-wasm` 0.0.43 (x64 build), synthetic images (solid-colour canvases created directly in ImageMagick — content doesn't matter for this test, only decoded-buffer size does), each resized to half its dimensions and encoded to JPEG, disposed via the library's own `ImageMagick.read(...)` callback pattern. Read `WebAssembly.Memory.prototype.buffer.byteLength` from inside the page, plus summed RSS across the browser's full OS process tree (parent + every child process — Chromium is multi-process; see Method).

Phase 1, single pass, increasing size, disposing between each:

| Image | Megapixels | WASM heap after (MB) | Tab RSS after (MB) |
| --- | --- | --- | --- |
| 800×600 | 0.48 | 16.0 | 359.5 |
| 1600×1200 | 1.9 | 19.3 | 369.1 |
| 3000×2000 | 6 | 37.2 | 389.9 |
| 4000×3000 | 12 | 67.3 | 420.1 |
| 6000×4000 | 24 | 127.3 | 480.3 |
| 7000×5000 | 35 | 183.4 | 535.5 |
| 8000×6000 | **48** | 247.5 | 600.3 |
| 10000×8000 | 80 | 407.7 | 760.5 |

Phase 2, the 8000×6000 (48 MP) image repeated 25 times in the same tab: WASM heap held at exactly 407.7 MB and tab RSS held in a 760.6–762.0 MB band (±0.2%, consistent with sampling noise) for all 25 repeats. No crash, no unbounded growth, at any point in either phase.

**Reading this evidence.** `WebAssembly.Memory`'s buffer cannot shrink — the WASM spec has no shrink instruction, only `memory.grow` — so "the figure returns near its starting level," the pass condition as originally written, cannot literally apply to the WASM heap number; it can only ever plateau, never fall. The growth in Phase 1 is exactly that: the heap grows only when a bigger image needs more headroom than it already has, which is correct, expected behaviour, not a leak. The signal that actually distinguishes a leak from correct disposal is Phase 2: repeating the *same* 48 MP size 25 times caused **zero** further heap growth, meaning each disposed ~230 MB working set was returned to the allocator's free list and reused by the next iteration rather than accumulating. Had disposal been broken, Phase 2 would have grown roughly linearly (25 × ~230 MB ≈ 5.75 GB total) and very likely hit a ceiling and crashed well before repeat 25 (see B7 on the x64 build's actual addressable limit, still being pinned down separately). Tab RSS (which, unlike the WASM heap, genuinely can shrink) also plateaued rather than climbing, corroborating the same conclusion at the OS level.

**Conclusion: no worker recycling is needed.** Neither the WASM heap nor tab RSS grew without bound at any tested size, including one single image above 40 megapixels (48 MP, and pushed further to 80 MP) and sustained repeated processing of a 48 MP image 25 times in one tab. The pool's replace-a-worker capability (§5.3) stays for the reasons §5.3 already needs it (terminate-and-respawn on a stuck job), not because memory growth requires it.

**Why not higher.** Tested in Chromium only (the task did not ask for cross-engine coverage the way B4 did); Firefox and WebKit may differ. Tested up to 80 MP single-pass and 25 repeats at 48 MP — both plateaued cleanly, but a pathological pattern outside that range (e.g. many distinct large sizes interleaved, fragmenting the allocator differently than same-size repeats) was not tried. iOS Safari's tighter, non-catchable termination behaviour is C4's concern, not this one.

**Method.** Full harness, methodology notes and raw results: `verification/t03-wasm-memory/` (see `docs/task-notes/T03.md`). "Tab memory" was sampled by shelling out to `ps` for the RSS of the browser's root OS process plus every descendant (Chromium runs the renderer, GPU and network service as separate processes), taking the peak observed during each image's processing and the settled figure after disposal and a forced `--expose-gc` GC pass.

**Prior, Node measurement (superseded, kept for context).** Five consecutive encodes of a 1600×1200 image, disposing between each. Resident memory held flat at 286 MB and external memory did not grow. This was flagged at the time as a weak proxy — Node's resident memory is not the browser's WASM heap, and 1600×1200 is modest next to a 50 megapixel phone photo — which is exactly why this entry was re-tested in a browser rather than trusted at face value.

---

### C3 `OPEN` `30%` `P2` Practical per-image and per-batch limits

The values in §5.7 are placeholders. The 200-file limit is inherited from the original design draft and was never measured.

**Method.** On each platform, process images of increasing megapixel count until failure. Repeat varying animated frame count and frame size independently, since the two multiply. Repeat for batch size. Derive caps with a margin, lower on iOS.

---

### C4 `OPEN` `25%` `P1` iOS Safari termination threshold

iOS Safari kills tabs on memory pressure without a catchable error, so rejection must be preventive.

**Why so low.** No figure exists yet, and it varies by device and iOS version.

**Method.** On a real iPhone, process progressively larger batches until the tab reloads. Record the threshold and whether any error surfaces first. Repeat on an older low-memory device, not only a current model.

---

### C5 `TESTED` `85%` `P2` Thumbnail generation cost and representation

`createImageBitmap` with `resizeWidth` decodes and downscales natively, fast enough for lazy per-tile generation and much faster than the WASM path.

**Affects.** R-G8's threshold, the encoded thumbnail format and size bound, and whether the grid view is viable at all for large batches.

**Measured** (T20, `verification/t20-thumbnails/`, raw numbers in its `results.json`). 50 real photographs
of mixed formats (26 JPEG, 12 PNG, 5 WebP, 4 HEIC, 2 GIF, 1 TIFF) and mixed dimensions (0.007 MP to
34.6 MP, median 2.5 MP), each generated in a worker via `createImageBitmap` with both axes bounded,
then encoded from an `OffscreenCanvas`. Four configurations — 256 px and 384 px long edge, JPEG and
WebP at quality 0.75 — on Chromium, Firefox and desktop WebKit, each a full 50-image pass.

At the chosen 384 px bound, per thumbnail (decode + encode, medians; the mean is higher because the
34.6 MP fixture costs 135–352 ms):

| Engine | JPEG median | JPEG mean bytes | WebP median | WebP mean bytes | Retained per 100, WebP |
| --- | --- | --- | --- | --- | --- |
| Chromium | 12 ms | 13.4 KB | 20 ms | 9.8 KB | 0.96 MB |
| Firefox | 15 ms | 14.5 KB | 24 ms | 10.2 KB | 0.99 MB |
| WebKit | 20 ms | 27.4 KB | 24 ms | 130.3 KB | 12.72 MB |

**The core claim holds.** Native bounded decoding ran at a 12–24 ms median against 141–491 ms for
ImageMagick's `thumbnail` on the same HEIC fixtures — roughly 10–25× faster, comfortably inside what
lazy per-tile generation needs. Peak process-tree RSS over a full pass stayed 0–737 MB above an idle
baseline, driven by the largest source decodes rather than by the retained thumbnails, which never
exceeded 12.7 MB for a whole 100-thumbnail batch.

**Caveat added by T22, on the RSS figures only.** `memory-sampler.mjs`'s process-tree walk (used here
via `launchPersistentContext`) sums RSS by following `ppid` from the launched browser's PID. On macOS,
WebKit's own WebContent, GPU and Networking processes are reparented to PID 1 rather than staying
children of that PID, so this walk never sees them — T22 confirmed it directly with a live WebKit
launch (212 MB on those three processes, invisible to the walk, against 104 MB actually counted from
the wrapper and `Playwright` processes it does see). **Every WebKit RSS number in this entry —
including the `0` in "0–737 MB above an idle baseline" above and the "unchanged at 109" figure in
"Cancellation works" below — was produced with this un-fixed sampler and should be treated as an
undercount pending re-measurement.** Chromium and Firefox are not affected (their child processes stay
correctly parented), and this does not touch decode/encode timings or retained-byte figures, which
come from in-page measurement, not `ps`. Not re-measured here — out of T22's scope, since C5 is not
T22's assumption to re-open — see `docs/task-notes/T22.md` for the fix itself (`verification/t22-codecs/memory-sampler.mjs`).

**Choices this settles.**

- **Encoded format: WebP**, at quality 0.75. It is 25–30% smaller than JPEG on Chromium and Firefox,
  and it preserves the alpha a JPEG thumbnail of a transparent PNG would flatten to black. WebKit's
  WebP encoder is the outlier (see below) but even its worst case retains only 12.7 MB per batch,
  which is not enough to decide the format against a budget where one 12 MP decode is 48 MB (§8.1).
- **Dimension bound: 384 px on the long edge, applied to both axes.** Covers the mockup's 168 px
  minimum tile at device pixel ratio 2. The 256 px bound halves the bytes but is short of a
  retina tile.
- **R-G8's automatic threshold: 100 files — the same number as `maximumThumbnails`.** Above the read
  budget, grid mode cannot give every tile a thumbnail and the surplus renders as placeholders, which
  is exactly the case list mode serves better. Tying the threshold to the limit rather than to an
  independent constant means T46's measurement moves both together.
- **Cancellation works.** A worker generating continuously was terminated mid-flight on all three
  engines: **zero further completions afterwards** — proof that growth stops, rather than a late
  result merely being hidden, and true regardless of the RSS caveat above since it counts worker
  completions, not memory. Peak RSS in the 4 s after termination was at or below the peak during for
  Chromium and Firefox (982 MB after vs 1114 MB during; 1217 vs 1513); the WebKit figure ("unchanged at
  109") is one of the undercounted numbers described above and is not independent evidence either way.
  Confidence stands on the completion-count proof, which holds on all three engines including WebKit.

**Surprising, and recorded rather than smoothed over.**

- **Desktop WebKit decodes HEIC and TIFF natively; Chromium and Firefox do not.** All 50 fixtures
  generated on WebKit, 45 on the other two. The ImageMagick fallback in Technical Design §10.4 is
  therefore a Chromium/Firefox path, not a universal one.
- **WebKit's `convertToBlob` appears to ignore the quality argument for `image/webp`**, producing
  files ~4.8× larger than its own JPEG at the same bound (130.3 KB vs 27.4 KB mean). Its JPEG output
  is also about twice Chromium's. Worth re-checking on a later WebKit before treating the WebP
  numbers above as fixed.

**Why not higher.** Desktop only. C5's method also calls for a mid-range phone, and no device was
available; phone throughput and the memory headroom behind it are unmeasured and belong with C4 and
T46. The 50 fixtures come from one machine's photo library, so the format mix is representative of
that library rather than of every batch a user might bring.

**Method.** Over 50 photographs of mixed dimensions and formats, on desktop and a mid-range phone, time
native reduced-size decoding and the ImageMagick path where native decoding is unavailable. Compare JPEG
and WebP thumbnail encoding for elapsed time, retained Blob bytes and peak memory. Verify both dimensions
are bounded, then derive the file-count threshold at which Gallery should default to list mode. Also verify
that cancelling the Gallery generation owner stops CPU and memory growth rather than merely hiding a late
result. The product ceiling for source-read attempts and retained Blobs comes from the single runtime
`maximumThumbnails` limit in R-G3/R-G10, initially 100; measurement chooses representation and the lower
automatic-mode threshold, not a hidden hard-coded ceiling. *(T20 completed every part of this on
desktop across all three engines. The mid-range phone was not available and remains open, with C4 and
T46.)*

---

### C7 `OPEN` `45%` `P2` Animated sources can be processed without holding every frame

**Why low.** ImageMagick's collection model reads all frames into a collection, which suggests the opposite. If peak memory scales with frame count, the animated frame budget in §5.7 must be strict.

**Method.** Process animations of increasing frame count and measure peak memory against frames.

---

### C8 `TESTED` `80%` `P2` Six WASM modules coexist acceptably, loaded lazily

ImageMagick is 14.8 MB uncompressed on its own, before gifsicle and the APNG path. (§5.2's table
actually names six modules, not three — ImageMagick, gifsicle, oxipng, the quantizer, UPNG and
apng-optimizer — so this entry now covers all six; the title said "three" before any of them had a
chosen npm package.)

**Affects.** Load strategy, which matters because the landing page has an SEO job.

**Measured** (T22, `verification/t22-codecs/`, raw numbers in its `results.json`). Two independent
measurements: a real production `vite build` of a probe that reaches all six packages for bundle
size, and a live-browser harness (Chromium, Firefox, desktop WebKit, each `launchPersistentContext`
— T01's precedent) for peak process-tree RSS, comparing three scenarios per engine: **eager** (all
six loaded concurrently, immediately — the "lazy strategy not applied at all" baseline), **lazy**
(the shipped per-format strategy, exercised as a GIF job then a still-PNG job then an animated-PNG
job would trigger it in sequence), and **jpeg-only** (ImageMagick alone — the common case, since most
sessions never touch a GIF or PNG at all).

**Bundle, production build** (`build-sizes.mjs`, real `vite build` output, not `package.json`
`unpackedSize`):

| Module | Bytes | Notes |
| --- | --- | --- |
| ImageMagick (x86/wasm32) | 14.8 MB | Matches A1 exactly — confirms the build identity assumption from a second angle |
| oxipng (`@jsquash/oxipng`) | 399 KB | |
| quantizer (`imagequant`) | 347 KB | |
| apng-optimizer | 218 KB | |
| gifsicle + UPNG (JS-only chunk, see Surprises) | 719 KB | Neither emits a separate `.wasm` asset |
| **All six together** | **15.8 MB** | |

**Peak process-tree RSS over idle baseline, desktop** (each scenario in its own fresh browser
profile, to avoid one scenario's HTTP cache warming the next — see Surprises):

| Engine | Idle baseline | jpeg-only (+) | All six, eager (+) | All six, lazy-sequential (+) |
| --- | --- | --- | --- | --- |
| Chromium | 268 MB | 102 MB | 116 MB | 114 MB |
| Firefox | 1007 MB | 116 MB | 112 MB | 134 MB |
| WebKit | 332 MB | 126 MB | 152 MB | 144 MB |

**First paint, and the GIF/JPEG differentiation** — proven directly in a real browser rather than
inferred from bundle/memory numbers: `tests/e2e/codecs.spec.ts`, 21 assertions across all three
engines, no skips. No request naming ImageMagick fires before `domcontentloaded`; the idle-scheduled
preload (`app/main.ts` → `scheduleImageMagickPreload()`) fires within 10 s of `load` on every engine; a
job whose `settings.format` is `'gif'` causes a `gifsicle`-matching request and a `'jpeg'` job never
does (checked against the job's own settled outcome, not a timeout); a still-PNG job loads oxipng and
the quantizer but not UPNG/apng-optimizer, and vice versa for animated PNG; `ensureImageMagick()` is
memoised (a second call issues no further request).

**The core claim holds, with one genuine gap.** "Eager" and "lazy-sequential" converge to roughly the
same *peak* (114–152 MB across engines) because the lazy scenario, by design, still ends up loading
every module within the measured window — that is the right test for "does spreading the loads out
over time cost more peak memory than doing them all at once" (answer: no, not measurably). It is
**not** a test of the real saving, which is **jpeg-only being 12–30 MB lower** than loading all six —
the actual benefit for the common case, since most sessions never touch GIF or PNG output at all. The
genuine gap: this harness measured one page/context loading codecs **sequentially**, not §5.1's real
worst case of **up to three pipeline workers loading codecs concurrently** (a mixed batch with GIF,
PNG and JPEG jobs dispatched to different workers at once). Desktop's cap is 3 workers; if each
independently pays the full ~100–150 MB shown above at the same moment, peak could be 2–3× a single
page's figure, still likely comfortable against §8.1's ~48 MB-per-decode budget headroom but not
directly measured here. **That gap, plus desktop-only coverage (matching C3/C4's own caveat), is why
this is 80% and not higher.**

**Surprising, and recorded rather than smoothed over.**

- **Comparing scenarios in the same browser profile silently invalidated the first run.** The first
  pass ran "eager" then "lazy" in one `launchPersistentContext`, and Vite dev server's cacheable
  responses (ETag/304) meant "lazy" — running second — paid almost nothing (1 MB peak, 3 MB
  transferred) because "eager" had already warmed the HTTP cache. Each scenario now gets its own
  fresh profile. Worth remembering for any future measurement that compares "before" and "after" cache
  states on the same page.
- **A real bug in the `memory-sampler.mjs` technique T20 established, found and fixed here: WebKit's
  own child processes (WebContent, GPU, Networking — the processes that actually run page JS and hold
  the WASM heap) are reparented to PID 1 on macOS, not left as children of the launched browser
  process.** A pure ppid-tree walk from the found root PID therefore silently sees none of them.
  Confirmed directly via `ps -A -o pid=,ppid=,command=` during a live WebKit launch: the WebContent
  XPC service carried 100+ MB RSS with `ppid=1`. The fix (this project's `memory-sampler.mjs`, not
  T20's) unions the ppid-tree walk with every orphaned process sharing the same
  `ms-playwright/<engine>-<build>/` install directory as the root. Before the fix, WebKit's measured
  peak was indistinguishable from its idle baseline (+0–1 MB) for every scenario — a result that would
  have read as "WebKit is free," which is wrong. **T20's own C5 WebKit cancellation figures
  ("peak RSS... at or below the peak during... WebKit unchanged at 109 [MB]") were produced with the
  un-fixed technique and were not re-measured here; C5's WebKit numbers may be similarly affected.**
  Not fixed in T20's harness — out of this task's scope — but flagged here since a later task
  relying on C5's WebKit figures specifically should know.
- **`gifsicle-wasm-browser` and `upng-js` emit no separate `.wasm` file in a production build** — the
  former bundles its own worker source (WASM included) as a JS string, the latter is pure JS (§7.1
  already says so). Both show up as ordinary JS chunk weight, not a `.wasm` asset, which is why the
  bundle table above has no separate gifsicle/UPNG row.
- `imagequant` (the libimagequant wrapper, wasm-bindgen's "bundler" target — a historically
  bundler-unfriendly shape) built and ran correctly under this project's Vite 8.3 with no plugin,
  verified with a scratch build before it was adopted (docs/task-notes/T22.md, Decisions made).

**Choices this settles.**

- **No worker-heterogeneity split.** §5.2's contingency — "if three modules in one worker prove too
  heavy, they split across workers by codec" — does not trigger. One worker loading every module it
  might need stays within 116–152 MB of idle baseline on desktop, nowhere near a level that forces a
  heterogeneous pool. The concurrent-worker gap above means this is not the final word for the
  3-worker case, but nothing measured here points toward needing the split.
- **The lazy strategy as shipped (§5.2's table) is worth keeping as designed**, not simplified to
  "load everything after idle regardless of format" — the per-format gate is what gives a
  JPEG-only session its 12–30 MB saving, and the browser test proves the gate is real, not aspirational.

**Method.** Measure total bundle and peak memory with all three initialised, against lazy initialisation where gifsicle loads only for GIF output and UPNG only for animated PNG. Pass condition for lazy loading: first paint is not delayed by codecs the user may never invoke. *(T22 measured all six named modules in §5.2's table, not three — the "three" in the original method predates the six being individually named. The 3-concurrent-worker case remains open; see "The core claim holds, with one genuine gap" above.)*

---

## 5. Encoder behaviour

### D1 `TESTED` `95%` `P2` Size-target search cost

**Measured**, binary search to a 150 KB target on a 1600×1200 photographic image:

| Format | Iterations | Total | Result |
| --- | --- | --- | --- |
| JPEG | 6 | 1260 ms | q=37, 148.7 KB |
| WebP | 6 | 3770 ms | q=17, 142.4 KB |
| AVIF, default speed | 7 | 29317 ms | q=44, 113.3 KB |

Six to seven iterations converges. AVIF at default speed is prohibitive, but see D7: at speed 9 the same search would be roughly 3 seconds, which changes the conclusion. R-Q4 should be decided after re-measuring with the speed define applied.

**Why not 100.** One image, one target, synthetic content. Iteration count is stable; wall time is content-dependent.

---

### D2 `TESTED` `98%` `P2` WebP lossless wins on graphics and loses on photographs

**Measured**, 1600×1200:

| Content | Lossy q70 | Lossless | Winner |
| --- | --- | --- | --- |
| Photographic | 518,150 B in 1155 ms | 1,357,564 B in 2862 ms | Lossy, by 2.6x |
| Flat graphic | 16,586 B in 224 ms | 522 B in 64 ms | Lossless, by 32x |

R-Q6 is strongly justified. On graphics lossless is both 32 times smaller and four times faster. On photographs the lossless attempt wastes 2.9 seconds and is discarded.

**Consequence.** The content gate in R-Q6 is worth building, not just permitted. Unique colour count separates these two cases cleanly.

---

### D3 `TESTED` `90%` `P2` ICC profiles survive every encoder path

**Measured in T23** (`verification/t23-decode/results.json`), a 6,668-byte ICC v2 Display P3 profile embedded and read back through every encoder in §4.2's stage table, in Chromium, Firefox and WebKit. **All three engines gave identical results** — the table below is one column because there was nothing to split.

| Path | Profile after | Identical bytes |
| --- | --- | --- |
| ImageMagick → JPEG | present | yes |
| ImageMagick → PNG | present | yes |
| ImageMagick → WebP | present | yes |
| ImageMagick → AVIF | present | yes |
| ImageMagick → GIF | present | yes |
| ImageMagick → PNG → oxipng | present | yes |
| ImageMagick → GIF → gifsicle | present | yes |
| UPNG (animated PNG) | **gone** | — |
| UPNG + spliced `iCCP` | present | yes |
| UPNG + `iCCP` → apng-optimizer | **gone** | — |
| UPNG → apng-optimizer → spliced `iCCP` | present | yes |

**The weak point was correctly identified but is in the wrong component, and it is avoidable.** §7.7 predicted the animated PNG path would lose the profile because it leaves ImageMagick and passes through UPNG. UPNG does indeed write no `iCCP` — it takes raw RGBA and emits `IHDR sRGB PLTE tRNS IDAT IEND`, and that `sRGB` chunk actively declares the output sRGB. But an `iCCP` chunk spliced into its output is read back byte-identically, so UPNG is not the obstacle. **apng-optimizer is**: given an APNG that carries a valid `iCCP`, it strips it. Attaching the profile *after* the optimiser has run preserves it exactly.

**Consequence: §7.7's contingency is not needed.** The fallback it names — "convert to sRGB for animated PNG only and record the caveat" — costs a real colour conversion and a `colour-converted` caveat on every wide-gamut animated PNG. It can be avoided by ordering the animated-PNG assembly as *UPNG → apng-optimizer → attach `iCCP`, dropping any `sRGB` chunk*. Whichever task builds animated PNG output (T27) should take this ordering as measured rather than re-deriving it, and must drop the `sRGB` chunk when it attaches the profile: `sRGB` and `iCCP` are mutually exclusive in the PNG specification, and leaving both produces a file libpng warns about and whose colour two readers may disagree about.

**Not measured.** §4.2's "quantize" step (libimagequant) transforms pixels and produces no file, so it is not a profile-carrying step; whatever writes the PNG after it is what was measured. R-I13's GIF conversion — converting to sRGB *using* the embedded profile before encoding — is an encode-stage behaviour and is not exercised here; what this measures is that the GIF path does not silently drop the profile, which is the risk D3 names. Surprisingly, both ImageMagick's GIF writer and gifsicle preserve the profile, so R-I13's conversion is a deliberate choice rather than a forced one.

**Why 90 and not higher.** Every path is measured on all three engines with identical results, and the one failing path has a demonstrated fix — but the fix is not yet *built* (T27 owns it), and the measurement uses one profile rather than a range of profile sizes and versions. A very large profile could plausibly meet a size limit in one of these writers that a 6.6 KB one does not.

---

### D4 `TESTED` `95%` `P2` EXIF auto-orientation is correct for all eight values

**Settled in T23.** ImageMagick's `autoOrient()` is correct for all eight values, **including all four mirrored ones**, on Chromium, Firefox and WebKit with no engine divergence.

**Method.** A canonical upright 60×40 image — a 3×2 grid of six distinct saturated colours, non-square so an axis swap shows in the dimensions and asymmetric so a reflection shows in the pixels — was transformed by the *inverse* of each orientation value's display transform, encoded as JPEG, and given a hand-built APP1 EXIF segment containing exactly one tag (0x0112). The transforms and the EXIF were written independently of ImageMagick, so a shared bug could not cancel itself out. `scripts/build-test-fixtures.mjs` regenerates the set byte-identically; the eight files live in `tests/fixtures/decode/`.

**Result.** All eight decode to 60×40 with the canonical colours at the canonical cell positions. Values 5–8 arrive stored as 40×60 and come out 60×40. Uprightness is asserted by **pixel content, not dimensions** — 2 and 4 share their output dimensions with 1 and 3, and 5 and 7 with 6 and 8, so a transform that handled the rotations and mishandled every flip would pass a dimensions-only check on all eight. `tests/e2e/decode.spec.ts` runs one test per value per engine, 24 in all.

**The three states are distinguished.** A file with no EXIF orientation tag reports `Orientation.Undefined` (0); a file whose tag says 1 reports 1. `classifySourceOrientation` maps 0 to `{ kind: 'absent' }` and 1–8 to `{ kind: 'present', value }`, so "no tag" and "tag says upright" are never conflated. `autoOrient()` is a no-op on pixels in both cases.

**R-I10 holds structurally**, not by convention: `Frame` has no orientation field, so no later stage can copy a tag forward. Re-encoding a decoded frame produces a file with no `exif` profile and an orientation of 0 or 1, never the source's.

**Why 95 and not 100.** Two things are not covered. No file in the local photo set — 642 images — has an orientation above 1, so every value from 2 to 8 is evidenced by generated fixtures rather than by output from a real camera. And a HEIC carrying both the `irot`/`imir` transformative properties (which libheif applies itself) *and* an EXIF orientation tag would be at risk of a double rotation; no such file was obtainable, so that interaction is untested. R-I11's composition of user rotation on top of the corrected image is T24's to confirm.

---

### D5 `OPEN` `70%` `P3` Transparency detection is cheap

**Supporting evidence for the design.** The test HEIC, an ordinary photograph with no transparency, reported `hasAlpha: true`. This is concrete confirmation that channel presence is not evidence of transparency, which is why R-C13 requires a pixel-level test rather than a channel check.

**Method.** Time a minimum-alpha scan against ImageMagick's opacity test on large images. If neither is cheap, sample first and scan fully only on ambiguity.

---

### D6 `TESTED` `90%` `P3` APNG input detection via `acTL`

Chunk-level detection works, confirmed in A5. ImageMagick's PNG reader returned one frame from a six-frame APNG, confirming the silent-truncation risk behind R-I4.

**Why not 100.** Detection was confirmed on generated APNGs, not on files from varied encoders.

---

### D7 `TESTED` `99%` `P1` AVIF encode speed is controllable and the default is badly chosen

**Measured**, 1600×1200 photographic, quality 70:

| `heic:speed` | Size | Time |
| --- | --- | --- |
| default | 652.7 KB | 7611 ms |
| 2 | 697.8 KB | 182,964 ms |
| 5 | 693.4 KB | 41,552 ms |
| 8 | 651.8 KB | 875 ms |
| 9 | 649.4 KB | 452 ms |

Speed 9 is 17 times faster than the default and produced a marginally smaller file. The spread across the range is 400x in time and under 8% in size.

**Measured on real photographs (T02).** Twenty real JPEGs (2848–7200 px on the long edge, 1.7–8.2 MB), `heic:speed` 6/7/8/9, quality 70. Perceptual quality via ImageMagick's own SSIM compare (`ErrorMetric.StructuralSimilarity`, decoded AVIF vs. source), reported as `1 − distortion` so higher is better. Mean over 20 photos:

| `heic:speed` | Mean size | Mean time | Mean SSIM | Min SSIM | Max time |
| --- | --- | --- | --- | --- | --- |
| 6 | 1124.4 KB | 18,170 ms | 0.98607 | 0.98064 | 43,697 ms |
| 7 | 1184.3 KB | 9,236 ms | 0.98608 | 0.98073 | 20,328 ms |
| 8 | 1172.9 KB | 3,871 ms | 0.98570 | 0.98039 | 8,810 ms |
| 9 | 1191.6 KB | 1,793 ms | 0.98586 | 0.98058 | 2,971 ms |

Speed 9 is 9.94x faster than speed 6 on average (range 4.68x–16.01x across the set) and 2.10x faster than speed 8. Mean SSIM is flat across all four speeds (0.9857–0.9861, a 0.04-percentage-point spread); the largest quality range seen for any single photo across all four speeds was 0.00124 (photo with the most detail), smaller than the photo-to-photo variation in the set (SSIM 0.9804–0.9954 depending on content). Size does not fall monotonically with lower speed as expected: mean size is smallest at speed 6 and 5.6% larger at speed 9 (range −0.87% to +15.1% per photo, 18 of 20 photos larger at speed 9), presumably because `heic:speed` trades off rate-distortion search thoroughness in a way that isn't strictly monotonic in size at fixed quality. The size effect is real but small, well inside the "under 8%" spread already seen on synthetic noise, and dwarfed by the time difference.

**Affects.** Whether AVIF is usable at all. At the default, a 20-image AVIF batch takes over two minutes on server hardware and far longer on a phone. At speed 9 it is comparable to WebP. It also revisits D1 and the animated AVIF decision in R-F7.

**Why not 100.** Twenty photographs from one library is not exhaustive, and the mild non-monotonic size trend at higher speed was not anticipated, though it does not change the direction or the recommendation. Confidence in the direction (use a high speed, never the default) is effectively total; the small residual is about the magnitude generalising to arbitrary content.

**Closed.** Real photographs confirm the synthetic-noise finding rather than contradicting it: quality is statistically indistinguishable across speeds 6–9, and the size penalty at speed 9 is small. Technical Design §7.3 now specifies `heic:speed` 9 (not a range) for exactly this reason — speed 9 is 2.1x faster than speed 8 for no measurable quality cost and a size difference under 1% between those two settings.

---

### D8 `OPEN` `40%` `P2` ImageMagick's own quantizer is good enough for PNG

**Claim.** With libimagequant absent (A9), ImageMagick's internal quantizer can serve R-Q11 without adding a second WASM module.

**Why only 40.** libimagequant exists because naive quantizers produce visibly worse results at the same colour count. ImageMagick's is older and generally rated below it.

**Affects.** R-Q11, R-Q14, bundle size, and whether the 70 floor is set at the right place. A weaker quantizer argues for a higher floor.

**Method.** Ten representative PNGs: screenshots, logos with alpha, flat illustrations, a photograph saved as PNG. Quantize with ImageMagick, with a standalone libimagequant WASM build, and with the copy inside apng-optimizer. Compare size and a perceptual difference metric, and record the bundle cost of each.

---

## 6. Output

### E1 `OPEN` `76%` `P2` Streaming ZIP assembly holds bounded memory

A ZIP written incrementally into OPFS should hold memory proportional to one entry rather than the archive.

**Supporting evidence (T01), not a direct test.** T01's harness (`verification/t01-opfs-memory`) wrote a single 1 GB then 3 GB blob into OPFS in chunks and downloaded it, on Chromium, Firefox and WebKit, watching peak process RSS throughout. Peak memory stayed flat and far below file size in every case (see B4 above for the numbers) — i.e. the OPFS layer underneath a streaming ZIP writer does not itself force materialisation of what passes through it, on any of the three engines. That is consistent with, and mildly raises confidence in, E1's claim. It is not a substitute for E1's own test: T01 wrote one large contiguous blob, not a ZIP assembled incrementally from many small entries, so it says nothing about whether the ZIP-writing approach itself buffers entries, retains previously-written entries' bytes, or grows a central directory in memory. E1 stays `OPEN` — the dedicated test (T40: assemble a multi-gigabyte archive from many entries while watching tab memory) is still required before this can be marked `TESTED`.

**Method.** Assemble a multi-gigabyte archive from many entries while watching tab memory. Pass condition: peak stays near the largest single entry.

---

### E2 `TESTED` `100%` `P3` `predictLength` is exact

**Measured.** 50 entries, nested paths, non-ASCII filenames containing `é`. Predicted 552,169 bytes, actual 552,169 bytes.

**Affects.** The quota preflight in R-X40 can use a real number rather than an estimate.

---

### E3 `OPEN` `80%` `P3` ZIP compression level is not worth paying for

JPEG, WebP and AVIF are already compressed, so storing rather than deflating costs little and saves time. PNG and GIF outputs may still deflate usefully.

**Method.** Assemble a representative batch both ways and compare size and time.

---

## 7. Refuted

Kept deliberately. Each was stated with more confidence than the evidence supported, and each was refuted by a short test.

### X1 `REFUTED` ImageMagick depends on FFmpeg

**Claimed.** That an observed FFmpeg dependency on desktop indicated a library-level dependency.

**True.** FFmpeg is a delegate, invoked as an external process for formats ImageMagick does not handle natively. Core ImageMagick has no FFmpeg linkage. In WASM the distinction matters because process spawning is unavailable, so every delegate-based format is absent regardless of configuration.

**Settled by.** A4.

---

### X2 `REFUTED` HEIC is excluded from WASM builds for licensing reasons

**Claimed.** That HEVC patent exposure keeps libheif out of distributed WASM builds, so HEIC decoding must go through Safari's native decoder.

**True.** Both libheif and libde265 are in the binary. See A8.

**Lesson.** Reasoning about why a build probably lacks something is not a substitute for reading its delegate list. The reasoning was sound and the conclusion was wrong, which is the most dangerous combination.

---

### X3 `REFUTED` Animated WebP and AVIF encoding are unavailable

**Claimed.** That animated output should be restricted to GIF.

**True.** Both encode correctly and round-trip with frames intact. See A3.

---

### X4 `REFUTED` Compressed size can be projected without encoding

**Claimed.** Inherited from the original design draft, which described the Preview figure as a projection.

**True.** Producing a compressed preview requires the encode. Once it has run, the size is measured and projection is pointless.

---

### X5 `REFUTED` UPNG `cnum` has no useful effect

**Claimed.** Recorded as a doubt after a test showed identical output size at every `cnum` value.

**True.** The test content was flat colour with almost no unique colours. On photographic frames, `cnum` reduces size by more than 5x and encodes faster. See A10.

**Lesson.** A negative result on synthetic data is not a negative result.

---

## 8. Verification order

By dependency and cost, not document order.

1. **B4**, OPFS download memory. The largest unknown in the project.
2. **D7**, AVIF speed on real photographs. Decides whether AVIF is a first-class output and revisits two other decisions.
3. **C2**, WASM memory reclaim in a browser at realistic image sizes. Decides the worker architecture.
4. **C4**, iOS termination threshold. Decides whether protection can be preventive.
5. **A13**, CICP colour handling. Newly discovered and affects correctness rather than performance.
6. **D8**, PNG quantizer quality. Decides whether a second WASM module is needed.
7. **C3** and **C5**, limits and thumbnail throughput. Fill in §5.7 and set the R-G8 threshold.
8. **B5**, folder input. Decides whether the feature ships everywhere or degrades on iOS.
9. **B9** and **B6**, headers and isolation. Decide the build variant.
10. **E1**, streaming ZIP memory. Confirms the output path end to end.
11. Everything else in priority order.
