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
| A7 | gifsicle-wasm-browser scope and licence | 100 | TESTED | — |
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
| B6 | Cross-origin isolation needed for threads | 90 | OPEN | P2 |
| B7 | x64 build requires memory64 | 80 | TESTED | P2 |
| B9 | Host can set custom response headers | 70 | OPEN | P2 |
| C1 | File handles are not backed by memory | 90 | DOC | P1 |
| C2 | WASM memory is reclaimed after large images | 92 | TESTED | P1 |
| C3 | Practical per-image and per-batch limits | 30 | OPEN | P2 |
| C4 | iOS Safari termination threshold | 25 | OPEN | P1 |
| C5 | Thumbnail generation throughput | 85 | TESTED | P2 |
| C7 | Animated sources processed incrementally | 95 | REFUTED | P2 |
| C8 | Six WASM modules coexist acceptably, loaded lazily | 80 | TESTED | P2 |
| D1 | Size-target search is affordable | 99 | TESTED | P2 |
| D2 | WebP lossless wins on graphics, loses on photos | 98 | TESTED | P2 |
| D3 | ICC profiles survive every encoder path | 92 | TESTED | P2 |
| D4 | EXIF auto-orientation correct for all eight values | 95 | TESTED | P2 |
| D5 | Transparency detection is cheap | 85 | TESTED | P3 |
| D6 | APNG input detection via `acTL` | 95 | TESTED | P3 |
| D7 | AVIF encode speed is controllable and default is bad | 95 | TESTED | P1 |
| D8 | PNG quantization quality via ImageMagick alone | 95 | REFUTED | P2 |
| D9 | Lossless AVIF is unusable in this build | 95 | TESTED | P2 |
| E1 | Streaming ZIP holds bounded memory | 76 | OPEN | P2 |
| E2 | `predictLength` is exact | 100 | TESTED | P3 |
| E3 | ZIP compression level not worth paying for | 80 | OPEN | P3 |
| F1 | vite-ssg produces genuinely static per-route HTML | 95 | TESTED | P2 |
| F2 | Analytics beacon fires on a cache-served page load | 60 | OPEN | P3 |

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

### A7 `TESTED` `100%` gifsicle-wasm-browser scope

**Settled** (T28, `verification/t28-gif/results.json`, ten subjects in Chromium, Firefox and WebKit). Gifsicle 1.92 complete, MIT wrapper, no dependencies, 368 KB unpacked. GIF in, GIF out only. `--lossy` and `-O1/-O2/-O3` all executed. The pipeline uses only those two — resizing, cropping and rotation are already done by the time a GIF is written, in RGBA, by stages that every format shares.

**The size comparison A7 asked for**, against ImageMagick's own GIF writer with no lossy pass on either side, at slider 100:

| Subject | Frames | ImageMagick | gifsicle | Smaller by |
| --- | --- | --- | --- | --- |
| `anim-scene.gif` (fixture) | 10 at 128x96 | 93,634 B | 15,533 B | **83.4%** |
| Generated scene, large | 16 at 480x360 | 1,399,271 B | 356,857 B | **74.5%** |
| `anim-disposal.gif` | 6 at 64x64 | 1,345 B | 362 B | **73.1%** |
| Generated scene | 10 at 128x96 | 96,180 B | 29,441 B | **69.4%** |
| `anim-6f.gif` | 6 at 64x64 | 1,155 B | 1,043 B | 9.7% |
| Generated flat | 10 at 128x96 | 1,607 B | 1,581 B | 1.6% |
| `anim-16f-400.webp` | 16 at 400x400 | 22,137 B | 22,105 B | 0.1% |
| Generated photographic | 12 at 320x240 | 624,526 B | 624,462 B | 0.0% |
| Real photograph, still | 1 at 1280x1920 | 1,136,991 B | 1,137,165 B | **−0.02%** |
| Real photograph, still | 1 at 4000x6000 | 9,958,239 B | 9,959,329 B | **−0.01%** |

**R-Q8's "substantially smaller" is true, and it is true for one specific reason.** ImageMagick writes every frame in full; gifsicle's `-O2` finds what a frame shares with its predecessor and stores the rest as transparency. So the saving tracks *inter-frame redundancy* and nothing else. Where consecutive frames share most of their pixels it is 69–83%; where every pixel changes every frame — the flat fixtures, where each frame is a different solid colour, and the photographic one, where the whole field moves — it is nothing at all, and on the still photograph gifsicle's output is **1,090 bytes larger** than the input it was given. The stage therefore keeps whichever candidate is smaller rather than assuming.

**`--lossy` is the lever for the content `-O2` cannot help**, and it is a large one: the still photograph goes from 9,959,329 B to 1,474,499 B at `--lossy=200`, and the photographic animation from 624,462 to 201,498. See `gifLossyLevel` in `src/pipeline/stages/gif-plan.ts` for how the slider maps onto it and why the band is 20 to 200.

**`-O3` is not free after all**, which corrects Technical Design §7.3's rationale rather than its conclusion. It is byte-identical to `-O2` on eight of the ten subjects and *smaller* on two — 29,441 → 28,618 (2.8%) and 356,857 → 343,588 (3.7%) — the larger of those for 1.9x the time, and it costs time on the eight where it returns nothing (89 ms against 177 on one). The setting stays at `-O2`; the reason is now "a small measured gain that costs more than it returns" rather than "no gain".

**It is not reliable, and the wrapper is why.** `gifsicle-wasm-browser` resolves a run when the WASM module calls its `output` callback and rejects — with `undefined` — when the module's own promise settles first, with nothing ordering the two. On `anim-16f-400.webp` at slider 95, 250 attempts per engine: **Chromium 0 failures, Firefox 0, WebKit 44 (17.6%)**; a second run of 80 gave WebKit 18 (22.5%). Nine other subjects failed zero times on any engine. `stages/gif.ts` therefore asks up to four times (`GIFSICLE_ATTEMPTS`) and keeps ImageMagick's own GIF if it still has nothing. Verified after that change, 80 runs per engine: **no job failed on any engine**; WebKit retried 14 times in 80, mean 1.24 attempts, and exhausted all four once.

**Not covered by this test.** Memory. gifsicle builds a fresh Worker per `run()` and terminates it on completion, so nothing accumulates between jobs, but the peak cost of one run on a large GIF is unmeasured and belongs with T50's limits. Also unestablished: *why* WebKit loses that race so much more often, and whether the rate depends on the input at all. The licence question is **A12** and is untouched by any of this.

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

**Settled, by taking the second module.** T22 added the `imagequant` package (347 KB wasm, 153 KB gzipped) and T27 built the PNG path on it. **D8 is refuted**: ImageMagick's own quantizer is both worse at the same colour count and, decisively, has no quality floor to refuse an image it cannot quantize well — which is the mechanism R-Q11's floor is made of. A9 itself is unchanged and stays a binary finding; what it fed is now decided.

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

**Measured in T29, and the answer is "sometimes, and not the way this entry assumed".** The pipeline uses UPNG at `cnum: 0` — lossless — and leaves quantization to apng-optimizer, per §7.1's role split (A6). On an 8-frame 200x200 photographic APNG the optimiser's lossless branch took UPNG's 51,108 bytes down to **42,411**, a 17% saving that earns its place. On a 16-frame 400x400 flat animation it went the other way: UPNG wrote **8,915** bytes and every optimiser setting came back *larger* — 10,459 at `deflateMethod` 0, 11,038 at 1, 9,927 at 2. Its quantizer is worse still on photographic frames, returning 101,349 bytes at `minQuality` 50 and above and 236,609 at 10, against the lossless 42,411, with no way to report that it had not met the request — which is why **R-Q15 removed the quantized candidate from this path altogether** rather than relying on a size comparison to hide it.

**One follow-up, unowned.** With the quantizer gone the path now writes exactly one candidate: UPNG assembles, apng-optimizer optimises, and that output ships whether or not it is smaller than what UPNG produced. On the flat animation above it is *larger* — 11,038 bytes against UPNG's 8,915. Comparing the two and keeping the smaller would be nearly free, since both already exist in memory, and would make this path's guarantee "no worse than the assembler" rather than "whatever the optimiser returned". Nobody owns that yet.

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

**Why not higher.** iOS Safari — the platform with the tightest OPFS quota (B2, ~20% of disk) and the one most likely to diverge — is out of scope for this task (needs real hardware; deferred to T50) and remains completely unverified. Desktop WebKit here is Playwright's bundled build, not shipping Safari. Everything ran on one machine (macOS) with a synthetic, single-byte-pattern payload rather than a real image/archive, and the two runs, while consistent, are not a large sample. Firefox's absolute baseline (~1 GB RSS at idle) is unexpectedly high for a blank automation profile, though it is flat rather than size-proportional, which is the property B4 actually claims.

**Method.** Write 1 GB, then 3 GB, into OPFS in chunks. Trigger a download. Watch tab memory in the browser task manager. Pass condition: peak stays far below file size. Test Chrome, Firefox, Safari desktop and iOS Safari separately. *(T01 completed this for Chromium, Firefox and desktop WebKit via Playwright's OS-process-RSS proxy rather than the manual task manager; iOS Safari on real hardware is still open, see T50.)*

**Fallback if false.** Chrome uses `showSaveFilePicker` with `createWritable`. Other browsers get a hard batch cap from measured in-memory assembly. Not engaged for any engine T01 tested — B4 held on Chromium, Firefox and desktop WebKit. If iOS Safari (T50) turns out to fail, it falls into the "other browsers" fallback (hard batch cap from measured in-memory assembly), since `showSaveFilePicker` is Chromium-only.

---

### B5 `TESTED` `90%` `P2` Folder input works across browsers

`<input webkitdirectory>` supported in Chrome, Firefox and Safari, each file carrying a usable `webkitRelativePath`. Dropped folders traversable with `DataTransferItem.webkitGetAsEntry`.

**Measured** (T18, `tests/e2e/folder.spec.ts`). A nested fixture tree (three real files at three depths, a dot-prefixed file, `Thumbs.db`, `desktop.ini`, and a dot-prefixed directory whose contents must not appear at all) was selected via `page.setInputFiles()` against a real `<input webkitdirectory>` element on Chromium, Firefox and desktop WebKit. On every engine, `webkitRelativePath` came back exactly as expected — including the hidden dotfile, the two named system files and the entire hidden directory, all of which the browser *does* surface to script (nothing filters them out before JavaScript sees them; `platform/folder.ts` does that filtering). No divergence between engines: desktop WebKit's folder-picker behaviour was identical to Chromium's and Firefox's on every case tested, including the depth-cap and file-count-cap rejection paths. The drop path (`DataTransferItem.webkitGetAsEntry`) could not be exercised with a genuine OS-level drag on any engine — no browser-automation tool can synthesize one, since `webkitGetAsEntry()` only returns a real entry for browser-populated items, never for script-constructed ones (see `docs/task-notes/T18.md`) — so its traversal logic (identical code path to the picker's cap/filter logic, sharing the same relative-path convention) was proven instead by calling `readDroppedFolder()` directly with a structurally faithful mock `FileSystemDirectoryEntry`/`FileSystemFileEntry` graph, and cross-checked to produce an identical file list to the real picker-based traversal of the same tree.

**Why not higher.** Everything above is desktop WebKit (Playwright's bundled build, run on macOS), not real iOS Safari, which is the platform this assumption was actually written to worry about. iOS Safari on real hardware is still completely unverified and remains T50's job, same caveat B4 carries for the same reason. The genuine OS-level drop path is untestable in *any* automation tool on *any* engine, not just unverified here — see Surprises in `docs/task-notes/T18.md`.

**Method.** On each browser, select a nested folder and log every `webkitRelativePath`. Drop the same folder and traverse, comparing the two file lists. Record iOS Safari explicitly. *(T18 completed the picker half for Chromium, Firefox and desktop WebKit exactly as specified. The drop half was completed as a direct call to `readDroppedFolder()` with a structural mock rather than a real OS-level drag — no automation tool can produce a genuine one — and its result was compared against the picker's file list for the same tree, which is the comparison this method was actually after. iOS Safari on real hardware remains open, see T50.)*

---

### B6 `TESTED` `95%` `P2` Cross-origin isolation required for threads

A threaded WASM build needs `SharedArrayBuffer`, which needs COOP and COEP.

**Measured in T27, when the published jSquash package still carried both oxipng builds.** It selected the multi-threaded one only inside a Worker, with `hardwareConcurrency > 1`, and when `wasm-feature-detect`'s `threads()` passed — and `threads()` is `new MessageChannel().port1.postMessage(new SharedArrayBuffer(1))` inside a `try`. Reproduced inside a real Worker on all three engines with no COOP/COEP headers set (`verification/t27-png/results.json`, and asserted in `tests/e2e/png.spec.ts` at the time):

| Engine | In a Worker | Cores | `new SharedArrayBuffer(1)` | postMessage of it | Threaded wasm validates | Build chosen |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium | yes | 8 | throws | throws | yes | single-threaded |
| Firefox | yes | 8 | throws | throws | yes | single-threaded |
| WebKit | yes | 8 | throws | throws | yes | single-threaded |

The "build chosen" column was **observed, not inferred**: the two builds were served from distinct URLs, and the browser test dispatched a real PNG job through the pipeline worker and observed the single-threaded URL rather than `codec/pkg-parallel/`. The predicate reproduction explains *why* that was the one chosen; the request showed that it really was.

So the claim's direction holds exactly: the engines all support threaded WebAssembly and all refuse `SharedArrayBuffer` without isolation. **The later APNG-compatible oxipng rebuild makes the measured outcome structural:** only the single-threaded 9.1.5 binary is bundled, instead of also shipping a parallel asset no supported deployment can select. A pool of *N* pipeline workers costs *N* oxipng heaps rather than *N* × cores.

**Why not 100.** A deployment with COOP/COEP remains untested, so the browser half of the claim is measured only in the configuration this product actually ships. Whether threads would be worth reintroducing is likewise unmeasured. Oxipng at level 2 was 31–138 ms on the original still-image measurements, which is not where the time went; the APNG pass increases the breadth of work but does not justify shipping an unreachable second binary.

**Method for the rest.** Serve the built app with COOP/COEP set and confirm the multi-threaded build initialises, that cross-origin resources still load, and what it costs in memory.

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
  independent constant means T50's measurement moves both together.
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
T50. The 50 fixtures come from one machine's photo library, so the format mix is representative of
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
T50.)*

---

### C7 `REFUTED` `95%` `P2` Animated sources can be processed without holding every frame

**Why it was low, and it was right to be.** ImageMagick's collection model reads all frames into a
collection, which suggested the opposite. It does the opposite. The conditional this entry ended on
— "if peak memory scales with frame count, the animated frame budget in §5.7 must be strict" — is
now an instruction rather than a hypothesis.

**Measured** (T29, `verification/t29-animated/results.json`; Chromium, Firefox and desktop WebKit,
each sweep point in its own fresh `launchPersistentContext` profile, peak process-tree RSS by the
`ps` sampler T01 established). The baseline for every point is taken **after** ImageMagick has
initialised, so A1's 14.8 MB of WASM is not counted against the frame count. *Arithmetic* is
`frames x width x height x 4`: the size of the coalesced representation itself, which is what every
figure has to be read against. The WASM column is the growth of ImageMagick's own
`WebAssembly.Memory`, captured by patching `WebAssembly.instantiate` (T03's technique).

**Frame count at a fixed 400x400 frame** (arithmetic 0.61 MB per frame), animated WebP through
`ImageMagick.readCollection` + `coalesce()`:

| Frames | Arithmetic | Chromium RSS | Firefox RSS | WebKit RSS | WASM heap growth |
| --- | --- | --- | --- | --- | --- |
| 8 | 4.9 MB | +21.9 MB | +5.5 MB | +27.0 MB | +0.0 MB |
| 16 | 9.8 MB | +35.3 MB | +28.9 MB | +38.5 MB | +7.1 MB |
| 32 | 19.5 MB | +57.8 MB | +54.0 MB | +62.6 MB | +24.0 MB |
| 64 | 39.1 MB | +90.9 MB | +106.5 MB | +118.0 MB | +53.2 MB |
| 128 | 78.1 MB | +193.0 MB | +210.5 MB | +218.7 MB | +127.6 MB |

**Frame size at a fixed 16 frames**, same decoder:

| Frame | Arithmetic | Chromium RSS | Firefox RSS | WebKit RSS | WASM heap growth |
| --- | --- | --- | --- | --- | --- |
| 200x200 | 2.4 MB | +17.5 MB | +10.3 MB | +23.1 MB | +0.0 MB |
| 400x400 | 9.8 MB | +35.3 MB | +28.5 MB | +36.6 MB | +7.1 MB |
| 800x800 | 39.1 MB | +100.5 MB | +101.4 MB | +106.8 MB | +53.2 MB |
| 1200x1200 | 87.9 MB | +205.5 MB | +235.3 MB | +231.4 MB | +128.5 MB |

**Fitted slopes, least squares:**

| Engine | RSS per frame at 400px | R² | RSS per decoded byte at 16 frames | R² |
| --- | --- | --- | --- | --- |
| Chromium | 1.40 MB | 0.994 | 2.194 | 1.000 |
| Firefox | 1.67 MB | 0.998 | 2.633 | 0.999 |
| WebKit | 1.61 MB | 1.000 | 2.456 | 0.999 |

The WASM growth is identical on all three engines to the byte, because it is ImageMagick's own
allocator rather than the browser's: **1.06 MB per frame at 400px (R² 0.997), 1.524 bytes per
decoded byte.**

**Verdict: refuted.** Peak memory is linear in frame count, linear in frame area, and the constant
is not one. The two factors were swept separately, as this entry's Method asked, and neither is
free: 128 frames at 400x400 cost 193–219 MB above baseline for 78.1 MB of pixels, and 16 frames at
1200x1200 cost 205–235 MB for 87.9 MB.

**The multiplier is 2.2x to 2.7x, and there are two of them.** The *marginal* cost is the fitted
slope divided by the arithmetic — what one more frame, or one more megapixel, adds:

| Engine | Marginal, per frame | Marginal, per decoded byte |
| --- | --- | --- |
| Chromium | 2.293x | 2.194x |
| Firefox | **2.733x** | 2.633x |
| WebKit | 2.637x | 2.456x |

**The figure a frame budget has to use is the other one**: total peak divided by total arithmetic at
the top of each sweep, which includes the fixed overhead the slope excludes.

| Engine | 128 frames at 400x400 | 16 frames at 1200x1200 |
| --- | --- | --- |
| Chromium | 2.47x | 2.34x |
| Firefox | 2.69x | 2.68x |
| WebKit | **2.80x** | 2.63x |

So: **plan on 2.8x**, not on the 2.2x the friendliest fit suggests.

Where the 2.2x–2.6x goes: the frames exist **twice at once**, once inside ImageMagick's heap after
`coalesce()` and once in the JS heap as the owned `Uint8Array`s the worker will transfer (that
second copy is not optional — a view onto the codec heap would detach the whole heap when
transferred). The remainder is the decoder's own working set and the browser's allocator slack.

**The per-frame release does not help, and that is measured rather than assumed.**
`stages/animation.ts` disposes each `MagickImage` as it lifts that frame's pixels, which is R-B6's
"avoids holding every decoded frame simultaneously wherever the format allows it". At 64 frames of
400x400, with and without that dispose, in fresh profiles:

**ImageMagick's heap growth is byte-identical — 55,771,136 bytes with the dispose and without, on
all three engines.** That is the evidence, and it is exact.

| Engine | RSS with dispose | RSS without | WASM growth, either way |
| --- | --- | --- | --- |
| Chromium | +90.16 MB | +90.88 MB | 55,771,136 B |
| Firefox | +104.25 MB | +104.14 MB | 55,771,136 B |
| WebKit | **+115.08 MB** | **+110.83 MB** | 55,771,136 B |

The RSS column settles nothing either way and is reported so that it cannot be quoted as though it
did: WebKit's dispose run is **4.25 MB higher** than its no-dispose run, against the ±1.9 MB
repeat spread this entry establishes below, at one run per cell. What the RSS figures support is
"no engine shows a saving", not "the two are identical"; a difference of a few megabytes in either
direction is beyond what this measurement can resolve.

The reason the heap figure comes out exact is structural: `coalesce()` materialises every frame
inside ImageMagick **before** the first pixel is extracted, so by the time there is anything to
dispose the peak has already been paid. **R-B6's "wherever the format allows it" is, for this
decoder, nowhere.** The dispose stays — it is free and it shortens the window in which both copies
are live — but it must not be quoted as a mitigation.

Both arms of this comparison run a decode loop written **inside the harness**, not the shipped
`decodeAnimation`, because the stage has no switch for turning its own dispose off. The loop is
otherwise the same sequence — `readCollection`, `coalesce()`, `getPixels` per frame — and it is the
only measurement in this entry that is not the shipped module.

**The APNG path is not a way out, though it is not uniformly worse either.** UPNG is pure
JavaScript, so ImageMagick's heap does not grow at all (+0.0 MB at every APNG point), but the frames
land in the JS heap instead. At **64 frames** of 400x400 it is comparable or worse — +139.4 MB on
Chromium, +117.5 on Firefox, +175.3 on WebKit, against +90.9, +106.5 and +118.0 through ImageMagick.
At **16 frames** it is mixed: Chromium is +27.66 against +35.28, which is **21% cheaper**, while
Firefox is 1.19x and WebKit 1.52x the collection path. Only two APNG points were measured, so the
shape of that curve is not established; what is established is that it is linear in the same way and
of the same order.

**Consequences.**

- **§5.7's animated frame budget must be set from this, and it is the binding limit, not the pixel
  cap.** A 12 megapixel still is 48 MB decoded; 128 modest animated frames are 200 MB of peak RSS.
  T33 owns the number; this entry is the evidence it should use.
- **Concurrency multiplies it.** §5.1's desktop cap of three workers means three of these at once.
- The architecture is not being reshaped to avoid it. Coalescing is forced — the three formats'
  disposal models differ, so a disposal *code* cannot cross a format change, and resizing a stored
  sub-rectangle in isolation is wrong. R-Q9 asks for disposal *behaviour*, which coalescing is how
  you preserve. The cost was accepted with the decision; this entry is it being counted.

**Precision of the RSS figures.** The 16-frame 400x400 point is measured twice per engine, once in
each sweep, and the two readings differ by 0.0 MB (Chromium), 0.4 MB (Firefox) and 1.9 MB (WebKit) —
so a difference of a couple of megabytes between two RSS rows means nothing. The WASM figures are
exact and repeat to the byte.

**Not measured.** No phone, so the figures that would settle C4 are still missing. No frame larger
than 1200x1200 and no animation longer than 128 frames; both sweeps are linear with R² ≥ 0.994
across their whole range, so extrapolating a little is reasonable and extrapolating far is not. The
source animations are flat-coloured, which is right for a memory measurement — decoded size does not
depend on content — but their *decode times* are not representative of real footage.

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
| oxipng 9.1.5 plus generated jSquash wrapper | 174 KB | Single-threaded only; the old dual-build package was replaced when APNG support was enabled |
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

### D1 `TESTED` `99%` `P2` Size-target search cost

**Originally measured**, binary search to a 150 KB target on a 1600×1200 photographic image:

| Format | Iterations | Total | Result |
| --- | --- | --- | --- |
| JPEG | 6 | 1260 ms | q=37, 148.7 KB |
| WebP | 6 | 3770 ms | q=17, 142.4 KB |
| AVIF, default speed | 7 | 29317 ms | q=44, 113.3 KB |

That entry ended: "AVIF at default speed is prohibitive, but see D7: at speed 9 the same search would be roughly 3 seconds, which changes the conclusion. R-Q4 should be decided after re-measuring with the speed define applied."

**Re-measured in T30 through the shipped search** (`pipeline/stages/size.ts`, §7.3's effort settings, `verification/t30-size/results.json`), same image shape and same 150 KB target, on Chromium, Firefox and WebKit. Every output format, not only the three above:

| Format | Iterations | Chromium | Firefox | WebKit | Kept |
| --- | --- | --- | --- | --- | --- |
| JPEG | 8 | 461 ms | 606 ms | 504 ms | slider 43, 151,062 B |
| WebP | 8 | 4,280 ms | 5,040 ms | 4,063 ms | slider 23, 149,426 B |
| AVIF | 8 | 1,420 ms | 1,604 ms | 1,387 ms | slider 47, 150,491 B |
| PNG | 1 | 1,832 ms | 1,933 ms | 1,739 ms | slider 10, 2,639,098 B — target not reached |
| GIF | 1 | 500 ms | 663 ms | 509 ms | slider 10, 375,759 B — target not reached |

The output bytes are identical on all three engines; only the times differ.

**The AVIF question is answered, by a measured pair rather than by the estimate.** Same frame, same target, same search, one define changed:

| | Wall time | Iterations | Kept |
| --- | --- | --- | --- |
| `heic:speed` 9, the shipped setting | **1,489 ms** | 8 | slider 47, 150,491 B |
| ImageMagick's default speed | 16,040 ms | 8 | slider 46, 128,569 B |

**10.8× faster for the same iteration count and one slider position.** The original 29,317 ms was different hardware; the ratio is what transfers, and "roughly 3 seconds" was if anything pessimistic. At §7.3's settings AVIF's search is the second fastest of the five formats and three times quicker than WebP's.

**Six to seven iterations was right about convergence and wrong about the shape.** Over 375 searches — five subjects, five targets, five formats, three engines — the iteration count takes exactly four values and never anything between 4 and 7:

| Count | Meaning | Where |
| --- | --- | --- |
| 1 | The lowest quality already misses the target (R-Q3) | 90 of 375 |
| 2 | The highest quality already fits, or the axis is inert | 123 of 375 |
| 3 | A probe landed on a plateau, so the axis had nothing more to say | 18 of 375, **all PNG** |
| 8 | There is a curve, and the cap stops the bisection | 144 of 375 |

The count is a property of the *axis*, not of the content or the engine: it is identical across Chromium, Firefox and WebKit for every subject. Wall time is the only engine-dependent part, and Firefox is 10–20% slower throughout.

**R-Q4's exclusion list is decided: it is empty.** The worst single image over every engine, subject and target — JPEG 645 ms, AVIF 1,604 ms, GIF 5,388 ms, WebP 7,485 ms, PNG 12,666 ms — contains nothing like the half-minute-per-image AVIF was at the default speed, which is the case the requirement was written against. §7.5 carries the table and the reasoning, including why PNG is the one that could still reasonably be overruled.

**Why not 100.** Three engines, five subjects and five targets per format, through the shipped stage rather than a reimplementation, and the iteration counts are identical across engines — so the structural claim is solid. What is left is content and hardware: two of the five subjects are real photographs, the rest are generated; every figure is desktop macOS on Apple silicon, and no phone was measured (C4). The wall times therefore transfer as ratios, not as absolutes.

---

### D2 `TESTED` `98%` `P2` WebP lossless wins on graphics and loses on photographs

**Measured**, 1600×1200:

| Content | Lossy q70 | Lossless | Winner |
| --- | --- | --- | --- |
| Photographic | 518,150 B in 1155 ms | 1,357,564 B in 2862 ms | Lossy, by 2.6x |
| Flat graphic | 16,586 B in 224 ms | 522 B in 64 ms | Lossless, by 32x |

R-Q6 is strongly justified. On graphics lossless is both 32 times smaller and four times faster. On photographs the lossless attempt wastes 2.9 seconds and is discarded.

**Consequence.** The content gate in R-Q6 is worth building, not just permitted. Unique colour count separates these two cases cleanly.

**Reproduced in T26, in browsers, with the shipped encode stage** (`verification/t26-encode/results.json`; Apple M1; WebP q70 method 4 lossy against `webp:lossless` method 4 — §7.3's recipe, not the defaults the figures above used). The direction reproduces on all three engines, and the bytes are identical across engines for the same pixels. The magnitudes do not reproduce, because the original content is not recoverable and content decides the ratio:

| Content, 1600×1200 unless stated | Unique colours | Lossy | Lossless | Winner |
| --- | --- | --- | --- | --- |
| Generated photographic stand-in (gradient + noise) | 1,264,694 | 69,288 B, 315–361 ms | 3,651,426 B, 5.9–8.0 s | Lossy, 53x |
| Generated flat graphic | 13 | 5,484 B, 157–185 ms | 460 B, 49–68 ms | Lossless, 12x |
| Canvas-drawn screenshot (text, gradient header) | 1,558–1,633 | ~63,500 B | 23,040–54,204 B | Lossless |
| Five real photographs, fitted to 1600 px | 42,275–831,312 | 41,564–179,102 B, 216–326 ms | 1.24–2.20 MB, 784–1,125 ms | Lossy, 12.3x–29.7x |

The screenshot row is a graphic that a classifier would be tempted by and the comparison handles correctly: lossless wins by 1.2x on Chromium and 2.8x on Firefox, on the same drawing, because the two engines rasterise the text differently.

**WebKit's screenshot row is excluded, as a harness artifact rather than a finding.** WebKit's `getImageData` returned alpha 254 on 23,360 pixels of a fully opaque canvas drawing, so the frame was not opaque, the lossless attempt carried a noisy alpha plane, and the output jumped to 129,402 B and lost. It says nothing about WebP, and the run records it as `opaque: false` for anyone re-reading the raw file. The pipeline never builds a frame this way — frames come from `decodeFrame` — but a future canvas-sourced frame would hit it, which is worth knowing.

**Gate calibration**, Chromium, 311 decodable images from the local set (60 JPEGs stride-sampled, 265 PNGs of which 14 would not decode), each fitted to 1600 px and encoded both ways:

- Lossless won 134 times, **never above 2,034 unique colours** (a 256×256 graphic). No JPEG photograph ever won lossless.
- Lossy won 177 times, including many low-colour images: lossless winning implies few colours, but few colours do not imply lossless winning.
- Scored by candidate limit, over the same set — no limit from 4,096 to 1,048,576 would have skipped a single lossless win; the difference is only time spent on losing attempts: 93 attempts / 6.5 s at 4,096, 107 / 9.9 s at 16,384, **122 / 19.4 s at 65,536**, 177 / 73 s at 1,048,576.
- Real photographs vary more than expected: 8 of the 60 sampled JPEGs had fewer than 65,536 colours at 1600 px (minimum 15,808), and each of those spends about 1 s on a losing lossless attempt.

**The shipped limit is 65,536** (`LOSSLESS_GATE_MAX_COLORS`): 32 times the largest observed lossless win. The corpus is thin exactly where the gate could hurt — only 43 of the PNGs are 0.25 MP or larger, and real UI screenshots with gradients and anti-aliased text can plausibly reach tens of thousands of colours — and a wrongly skipped attempt costs the user bytes while a wrongly run one costs only time. Lowering it to 16,384 would save roughly a second on about one photograph in eight, and is the obvious tuning if run time matters more; the data does not argue for going lower.

**The gate itself is cheap:** a 48 MP photographic frame exceeds the limit within 5–12 ms; a 48 MP flat frame is scanned in full in 157–189 ms.

---

### D9 `TESTED` `95%` `P2` Lossless AVIF is unusable in this build

**Measured in T26**, `@imagemagick/magick-wasm` 0.0.43, on Chromium, Firefox and WebKit.

AOM reads quality 100 as lossless. This build then refuses to encode — *"Only --enable_chroma_deltaq=0 can be used with --lossless=1"* — unless the file is labelled with the identity matrix (`heic:cicp p,t,0`). There is no define for chroma-delta-q: `heic:enable-chroma-deltaq` is rejected the same way, and the option is not in the binary's string table.

The identity-matrix file encodes, and ImageMagick reads it back within one unit. **Every browser renders it wrong**, because the `nclx` box that carries the matrix also carries a `full_range_flag` of 0, and no define can set it:

| Decoder | Maximum error at flat block centres |
| --- | --- |
| ImageMagick (the library that wrote it) | 1 |
| Chromium | 5 |
| Firefox | 16 |
| WebKit | 240 — the image is black |

A lossy 4:4:4 AVIF (`heic:chroma 444`, no CICP define) decodes within 1 in all three, so this is not WebKit's 4:4:4 support: it is the identity-matrix, limited-range file.

**Consequence.** R-Q5's "lossless wherever the format supports it" cannot be honoured for AVIF with this build. **Decided by the user:** AVIF at 96–100 encodes as highest-quality lossy with 4:4:4 chroma — the slider value, capped at 99 so the encoder never enters AOM's lossless mode, so 96 encodes at 96 and 100 at 99. All three engines decode the result within 1. This is a documented deviation from R-Q5, not a silent one: Functional Design §7.1's AVIF row still says "Lossless mode", and whoever owns that text should decide whether to amend it or keep it as an aspiration for a future build.

**Related, same measurement.** The writer converts RGB to YUV with BT.601 whatever matrix it labels the file with. Writing the *source's* matrix coefficients therefore tells decoders to invert a conversion that never happened: a file labelled BT.709 decoded 10 units out in Chromium and Firefox, one labelled BT.2020 12 units out, against 3 for BT.601 from identical pixels. `encode-plan.ts` writes the source's primaries and transfer — the two that describe the colour — with matrix 6.

**Why 95 and not higher.** Three engines, several recipes, one build. A later magick-wasm that exposes the full-range flag or the AOM parameter directly would change the conclusion, and the test in `tests/e2e/encode.spec.ts` that decodes output through the browser's own decoder is what would show it.

---

### D3 `TESTED` `92%` `P2` ICC profiles survive every encoder path

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
| UPNG → apng-optimizer → spliced `iCCP` → oxipng | present | yes |

**The weak point was correctly identified but is in the wrong component, and it is avoidable.** §7.7 predicted the animated PNG path would lose the profile because it leaves ImageMagick and passes through UPNG. UPNG does indeed write no `iCCP` — it takes raw RGBA and emits `IHDR sRGB PLTE tRNS IDAT IEND`, and that `sRGB` chunk actively declares the output sRGB. But an `iCCP` chunk spliced into its output is read back byte-identically, so UPNG is not the obstacle. **apng-optimizer is**: given an APNG that carries a valid `iCCP`, it strips it. Attaching the profile *after* the optimiser has run preserves it exactly.

**Confirmed in T29 on a real six-frame APNG, which is what T27's note asked for** — T23 measured this ordering on a *single-frame* file. An `iCCP` spliced into a six-frame APNG before `optAPNG` is absent from its output, along with UPNG's `sRGB`; attached afterwards it survives, and the optimiser changes none of the animation: 6 frames in and out, delays `[45, 33, 7, 101, 999, 1]` ms unchanged, `acTL.num_plays` of 3 unchanged. So the loop count is patched *before* the optimiser and the profile attached *after* it. **`png-plan.ts`'s `rewritePngChunks` is not what attaches it**: its whitelist has no `acTL`, `fcTL` or `fdAT`, so an APNG put through it comes out a still image (T27's note warned of exactly this). `animation-plan.ts`'s `attachApngIccp` keeps everything except a short drop list instead, which is the right default for a container whose chunk vocabulary is still growing.

**The animated *WebP* half of this entry is weaker than the table suggests.** "ImageMagick → WebP: present, identical" was measured on a **still** WebP. T29 measured the animated case and ImageMagick's WebP coder does not report `ICCP` or `EXIF` for an animated file at all — through `readCollection` or `read` — so the decoder reads the profile out of the RIFF container itself. On the *writing* side the profile is set on every frame and libwebp writes one `ICCP` for the file, which `tests/e2e/animation.spec.ts` checks byte-for-byte against the source profile on all three engines.

**Consequence: §7.7's contingency is not needed.** The fallback it names — "convert to sRGB for animated PNG only and record the caveat" — costs a real colour conversion and a `colour-converted` caveat on every wide-gamut animated PNG. It is avoided by ordering the animated-PNG assembly as *UPNG → apng-optimizer → attach `iCCP`, dropping any `sRGB` chunk → oxipng*. The APNG-specific optimiser still has to precede the profile because it strips one it receives; oxipng 9.1.5 accepts the finished profiled APNG and preserves its `iCCP`, `acTL` and `fcTL` chunks while recompressing frame data. `sRGB` and `iCCP` remain mutually exclusive, so the attachment step still drops `sRGB`.

**Extended by T27, for the still PNG path, and one sentence of the paragraph below was wrong.** §4.2's "quantize" step does *not* merely transform pixels: `Imagequant.process()` returns a **finished PNG**, and that PNG carries `IHDR PLTE tRNS IDAT IEND` and no `iCCP` at all — so the still PNG path has the same profile problem the animated one has, and the same fix. Measured on all three engines (`verification/t27-png/`, `tests/e2e/png.spec.ts`): ImageMagick's own `iCCP` chunk, moved whole into libimagequant's output, reads back byte-identical to the profile embedded in the source, before or after oxipng — the two orderings produce byte-identical files. Two things beyond T23's table came out of it: libimagequant writes no `sRGB` or `gAMA` either, so there is nothing to contradict the spliced profile; and **ImageMagick's PNG writer adds chunks of its own** — `cHRM`, `tIME`, three `tEXt` timestamps, and, for a profiled image, a second copy of the profile as a `zTXt` "Raw profile type icc" (3,441 bytes against the 2,381-byte `iCCP` on an image whose pixel data was 95 bytes). Neither `png:exclude-chunk` nor `image.strip()` removes them without removing the `iCCP` too, so the pipeline rewrites the chunk list itself. These byte figures are a one-off observation on a small test image rather than part of `results.json`; what the committed evidence asserts is the *presence* of the chunks — `tests/e2e/png.spec.ts` writes the same frame through ImageMagick with nothing stripped and checks `tEXt` and `tIME` are there, and that neither reaches the shipped file.

**Also measured by T27: Chromium and WebKit apply the resulting profile**, drawing a P3-tagged PNG differently from an untagged one with the same pixels. Firefox draws both identically — its 2D canvas does not colour-manage in this build — so on Firefox the profile is proven present and byte-identical but not proven honoured.

**Not measured.** R-I13's GIF conversion — converting to sRGB *using* the embedded profile before encoding — is an encode-stage behaviour and is not exercised here; what this measures is that the GIF path does not silently drop the profile, which is the risk D3 names. Surprisingly, both ImageMagick's GIF writer and gifsicle preserve the profile, so R-I13's conversion is a deliberate choice rather than a forced one.

**Why 90 and not higher.** Every path is measured on all three engines with identical results, and the still PNG path is now built and asserted (T27) — but the animated one is not (T29 owns it), and the measurement uses one profile rather than a range of profile sizes and versions. A very large profile could plausibly meet a size limit in one of these writers that a 6.6 KB one does not.

---

### D4 `TESTED` `95%` `P2` EXIF auto-orientation is correct for all eight values

**Settled in T23.** ImageMagick's `autoOrient()` is correct for all eight values, **including all four mirrored ones**, on Chromium, Firefox and WebKit with no engine divergence.

**Method.** A canonical upright 60×40 image — a 3×2 grid of six distinct saturated colours, non-square so an axis swap shows in the dimensions and asymmetric so a reflection shows in the pixels — was transformed by the *inverse* of each orientation value's display transform, encoded as JPEG, and given a hand-built APP1 EXIF segment containing exactly one tag (0x0112). The transforms and the EXIF were written independently of ImageMagick, so a shared bug could not cancel itself out. `scripts/build-test-fixtures.mjs` regenerates the set byte-identically; the eight files live in `tests/fixtures/decode/`.

**Result.** All eight decode to 60×40 with the canonical colours at the canonical cell positions. Values 5–8 arrive stored as 40×60 and come out 60×40. Uprightness is asserted by **pixel content, not dimensions** — 2 and 4 share their output dimensions with 1 and 3, and 5 and 7 with 6 and 8, so a transform that handled the rotations and mishandled every flip would pass a dimensions-only check on all eight. `tests/e2e/decode.spec.ts` runs one test per value per engine, 24 in all.

**The three states are distinguished.** A file with no EXIF orientation tag reports `Orientation.Undefined` (0); a file whose tag says 1 reports 1. `classifySourceOrientation` maps 0 to `{ kind: 'absent' }` and 1–8 to `{ kind: 'present', value }`, so "no tag" and "tag says upright" are never conflated. `autoOrient()` is a no-op on pixels in both cases.

**R-I10 holds structurally**, not by convention: `Frame` has no orientation field, so no later stage can copy a tag forward. Re-encoding a decoded frame produces a file with no `exif` profile and an orientation of 0 or 1, never the source's.

**Why 95 and not 100.** Two things are not covered. No file in the local photo set — 642 images — has an orientation above 1, so every value from 2 to 8 is evidenced by generated fixtures rather than by output from a real camera. And a HEIC carrying both the `irot`/`imir` transformative properties (which libheif applies itself) *and* an EXIF orientation tag would be at risk of a double rotation; no such file was obtainable, so that interaction is untested. R-I11's composition of user rotation on top of the corrected image is confirmed in T24 (`tests/e2e/edit.spec.ts`: an orientation 6 source decoded, turned and cropped, on all three engines).

---

### D5 `TESTED` `85%` `P3` Transparency detection is cheap

**Supporting evidence for the design.** The test HEIC, an ordinary photograph with no transparency, reported `hasAlpha: true`. This is concrete confirmation that channel presence is not evidence of transparency, which is why R-C13 requires a pixel-level test rather than a channel check.

**Measured in T24** (`tests/e2e/edit.spec.ts`, the D5 test, desktop, Apple M1). The edit stage's pixel-level test is a plain JavaScript loop over the alpha bytes of an already-decoded RGBA frame (`pipeline/stages/edit.ts`, `flatten`). On an 8000×6000 (48 MP) frame, JIT warmed:

| Engine | Full scan, fully opaque | Scan and blend, every pixel translucent |
| --- | --- | --- |
| Chromium | 46 ms | 256 ms |
| Firefox | 92 ms | 456 ms |
| WebKit | 45 ms | 192 ms |

The opaque case is the worst case for detection, since there is no early exit, and it is under 100 ms on every engine. A frame that size must be decoded before it can be scanned, and A8 measured 410 ms to decode a 1.5 MP HEIC, so the scan is small next to the decode that has to precede it (48 MP decode time itself was not measured here). **No sampling strategy is needed**, and the ImageMagick opacity test was not timed, because a full scan is already cheap enough that there is nothing to choose between.

**Why 85 and not higher.** It was measured on a desktop only, one run per engine, with a synthetic frame. A low-end phone could plausibly run it 5–10× slower, which would still be well under a second but has not been measured (C4's device work is the place to confirm it). It measures the in-pipeline scan on a decoded frame. It does not measure `ImageRecord.hasTransparency`'s lazy detection outside the pipeline (§3.1), whose cost is dominated by the decode it needs, not by the scan.

---

### D6 `TESTED` `95%` `P3` APNG input detection via `acTL`

Chunk-level detection works, confirmed in A5. ImageMagick's PNG reader returned one frame from a six-frame APNG, confirming the silent-truncation risk behind R-I4.

**Extended in T29, and the risk is worse than recorded.** The truncation is not a property of the *still* reader that a collection reader would avoid: `ImageMagick.readCollection` returns **one** frame from the same six-frame APNG, silently, and so does `MagickImageCollection.ping`. There is no way to decode an APNG's frames through this build at all, which is why `stages/animation.ts` decodes APNG through UPNG and §5.2's table gained a source-format row. `domain/classify.ts`'s `acTL` detection was confirmed against an APNG written by **ffmpeg** rather than by UPNG — a second encoder, which is what the "why not 100" below asked for — and `readApngAnimation` reads its six `fcTL` chunks and `acTL` correctly (`tests/e2e/animation.spec.ts`, three engines).

**Why not 100.** Two encoders now, not one, but still not a broad survey — an APNG whose `fcTL` chunks follow `IDAT` (so the still image is not frame 0) is a legal layout that no fixture here exercises.

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

### D8 `REFUTED` `95%` `P2` ImageMagick's own quantizer is good enough for PNG

**Claim, as originally written.** With libimagequant absent (A9), ImageMagick's internal quantizer can serve R-Q11 without adding a second WASM module.

**The premise was already stale when it was measured, and the question changed with it.** T22 chose the `imagequant` package and put it in the bundle; T27 built the PNG path on it. So the live question was not "can a second module be avoided" but "does the 347 KB (153 KB gzipped) earn its place". It does, and for a reason the original entry did not anticipate.

**Measured (T27, `verification/t27-png/`, Chromium, Firefox and WebKit; the table below is Chromium at slider 10 — R-Q11's mapped 70, the lowest setting any user can reach).** Ten generated PNGs in D8's own categories, plus six real photographs and eight real PNGs from the local set fitted to 1600 px. Both quantizers are given the **same colour count** — libimagequant's palette size — and both outputs are finished the same way, through the shipped chunk rewrite and oxipng level 2. Sizes are bytes, SSIM is `1 − ImageMagick's StructuralSimilarity` distortion, RMSE is its `RootMeanSquared`, and *banding* is the largest step introduced between two horizontally adjacent pixels whose source step was at most one unit — on a smooth ramp, exactly the height of a band edge.

| Generated, 1000×750 | lossless | libimagequant B / colours / SSIM / RMSE / banding | ImageMagick B / colours / SSIM / RMSE / banding |
| --- | --- | --- | --- |
| Screenshot, light | 72,638 | 37,765 / 256 / 1.0000 / 0.00085 / **5** | 56,714 / 177 / 0.9966 / 0.00352 / **54** |
| Screenshot, dark | 87,742 | 35,620 / 253 / 1.0000 / 0.00048 / **4** | 37,060 / 110 / 0.9997 / 0.00326 / **33** |
| Logo, hard alpha | 2,111 | 2,111 / 2 / — / 0.00000 / 0 | 2,111 / 2 / — / 0.00000 / 0 |
| Logo, soft alpha | 48,928 | 28,888 / 122 / 0.9004 / 0.00048 / 212† | 25,878 / 55 / 0.9367 / 0.00731 / 224† |
| Illustration, flat | 2,447 | 2,447 / 6 / 1.0000 / 0.00000 / 0 | 2,447 / 6 / 1.0000 / 0.00000 / 0 |
| Illustration, shaded | 60,472 | **32,123** / 195 / 0.9995 / 0.00127 / **2** | 112,822 / 70 / 0.9424 / 0.01299 / **93** |
| Gradient, sky | 28,444 | **27,147** / 256 / 0.9969 / 0.00329 / **8** | 119,777 / 130 / 0.9193 / 0.01695 / **47** |
| Gradient, grey ramp | 2,231 | 2,231 / — / 1.0000 / 0.00000 / 1 | 6,250 / — / 0.9804 / 0.00616 / 4 |
| Diagram | 9,831 | 4,216 / 47 / 1.0000 / 0.00032 / 1 | 4,390 / 21 / 1.0000 / 0.00191 / 15 |
| Photograph (synthetic) | 590,049 | **aborted — cannot reach quality 70** | 314,546 / 256 / 0.8275 / 0.03221 / **110** |

† Both figures are colour error under near-transparent pixels, where a quantizer is free to put anything. The largest error on a *fully opaque* pixel is 0 for libimagequant and 1 for ImageMagick.

Aggregated, at the same colour count:

| Set | Comparable images | Mean size, libimagequant ÷ ImageMagick | Mean RMSE ratio | libimagequant smaller | libimagequant higher SSIM |
| --- | --- | --- | --- | --- | --- |
| Ten generated | 9 | **0.730** | **0.102** | 6 | 6 |
| Six real photographs | 6 | 0.947 | 0.646 | 4 | 6 |
| Seven real PNGs | 7 | 1.087 | 0.058 | 2 | 3 |
| All fourteen real files | 13 | 1.022 | 0.329 | 6 | 9 |
| All 22 | 22 | 0.903 | 0.236 | 12 | 15 |

Photographs are split out because they are the row the rest of this entry is weakest on and the source a user is most likely to bring. On them libimagequant is **only 5% smaller on average and its error is 0.65 of ImageMagick's** — still ahead on both, but by a fraction of the margin the generated set shows, and on two of the six it is the larger file. The 1.022 and 0.329 in the "all real files" row are pulled by the seven real PNGs, most of which are 32×32 icons where neither quantizer has anything to do.

**Verdict: refuted, on two grounds, the second decisive.**

1. **Quality at equal colour count is not close on the content PNG is used for.** On the four smooth or shaded subjects — where banding is the failure R-Q11 names — libimagequant is 2.8x to 4.4x smaller *and* an order of magnitude closer to the source. ImageMagick reaches the same colour count by dithering harder, which both costs bytes and is what the grain looks like. On real photographs the margin narrows sharply — mean size ratio 0.947 and mean RMSE ratio 0.646 — and two of the six are smaller from ImageMagick. libimagequant is still ahead on both measures there, but by 5% and by a third rather than by the multiples the generated set shows.
2. **ImageMagick's quantizer has no quality floor, and R-Q11's floor is not expressible without one.** `image.quantize({ colors })` always produces a file; there is no "refuse if you cannot reach quality *q*". libimagequant's `set_quality(minimum, target)` aborts instead, which is what makes the 70 floor a guarantee by construction rather than a judgement (§7.4). The photograph in the table is the whole argument: libimagequant refuses it and the job keeps its lossless PNG, while ImageMagick quantizes it to SSIM 0.8275 with a banding step of 110 and no way to say no. A 32×32 real PNG behaves the same way — libimagequant aborts, ImageMagick turns a 166-byte lossless file into 1,510 bytes at SSIM 0.8638 with a banding step of 255.

**Bundle cost.** `imagequant` 0.1.2's wasm is 347 KB, 153 KB gzipped (T22's build measurement, reproduced by T27's production build). Against ImageMagick's own 14.8 MB that is 2.3%, and it buys both the output quality above and the only floor mechanism in the build.

**Where ImageMagick wins — all of it, including the row that matters most.** ImageMagick produced the smaller file on **7 of the 22 comparable images**:

| Image | libimagequant | ImageMagick | ImageMagick smaller by | Error |
| --- | --- | --- | --- | --- |
| Soft-alpha logo, 1000×750 | 28,888 B, 122 colours, RMSE 0.00048 | 25,878 B, 55 colours, RMSE 0.00731 | 10.4% | 15x worse |
| **Real photograph, 1067×1600** | 880,858 B, 256 colours, RMSE 0.00727, SSIM 0.9882 | 790,887 B, 256 colours, RMSE 0.01105, SSIM 0.9615 | **10.2%** | 1.5x worse |
| **Real photograph, 1067×1600** | 800,098 B, 256 colours, RMSE 0.00729, SSIM 0.9896 | 745,049 B, 256 colours, RMSE 0.01169, SSIM 0.9614 | **6.9%** | 1.6x worse |
| Real PNG, 32×32 | 284 B, RMSE 0.00000 | 244 B, RMSE 0.00000 | 14.1% | **none — both exact** |
| Real PNG, 32×32 | 426 B, RMSE 0.00000 | 385 B, RMSE 0.00000 | 9.6% | **none — both exact** |
| Real PNG, 32×32 | 1,452 B, RMSE 0.00000 | 1,247 B, RMSE 0.00394 | 14.1% | worse |
| Real PNG, 32×32 | 1,476 B, RMSE 0.00263 | 1,164 B, RMSE 0.00651 | 21.1% | 2.5x worse |

**Two of the seven are real photographs at full working size, 10.2% and 6.9% smaller**, and photographs are the most common PNG source a user will bring. They are the strongest counter-evidence in this entry and are named here rather than aggregated away. They cost 1.5x and 1.6x the error to get there, which is why the verdict does not turn on them — but "libimagequant produces smaller files" is not true of photographs, and nothing in this entry should be read as saying so.

**Two of the seven cost nothing at all**: both quantizers reproduce those 32×32 files exactly (RMSE 0.00000 either way) and ImageMagick's encoding of the same pixels is simply smaller. So the "smaller only by spending fewer colours and paying in error" reading is wrong on two counts — only 3 of the 7 spent fewer colours, and 2 of the 7 pay nothing.

**Time is mixed and never large.** On the nine generated images where both quantizers ran, libimagequant is faster on every one: 45–116 ms against 64–343 ms. The tenth aborted, so it has no libimagequant time to compare at all; ImageMagick spent 519 ms quantizing it, outside the range above. On the six 1600 px photographs libimagequant is faster on five (647–735 ms against 802–1,013 ms) and slower on the sixth (1,404 against 980).

**Where ImageMagick was not measured.** The copy of libimagequant inside `apng-optimizer` is not compared. The original Method named it as a way to avoid a second module; that avenue closed when T22 adopted the standalone package, and `apng-optimizer` takes an APNG in and gives an APNG out (A6) rather than exposing a quantizer, so using it here would mean assembling a single-frame APNG to quantize a still PNG.

**Why 95 and not 100.** The direction is not in doubt and the floor argument is structural. The residual is about the sample: twenty-four images, fourteen of them from one person's library, measured on one machine. The one number a larger corpus could move is the mean size ratio on real **photographs**, 0.947 over six files with two of them above parity — close enough that content could push it either way. That would not change the verdict, which rests on the floor and on the smooth and shaded content, but it would change how the size claim should be phrased.

**A metric caveat worth carrying.** ImageMagick's SSIM reads the colour *under* fully transparent pixels: the hard-alpha logo scores 0.6919 for an output whose visible pixels are identical to the source, and that single row is enough to pull a mean SSIM negative. On images with large transparent regions, RMSE and a peak error restricted to opaque pixels are the usable metrics; SSIM is not. The table above leaves SSIM out for that row rather than quoting it.

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

---

## 9. Public site and delivery

### F1 `TESTED` `95%` `P2` vite-ssg produces genuinely static, crawlable HTML per route

vite-ssg runs the app once per route at build time and is expected to write real,
route-specific HTML to disk — not one shared shell that depends on client-side
JavaScript to show different content per route. This matters because the whole reason
to move off a pure SPA is that a route's content must be present in the fetched
document.

**Measured** (T31, `pnpm build && pnpm verify:ssg`, and a direct read of the built
file). `vite-ssg@28.3.0` installed cleanly against `vite@^8.3.0` with no peer-dependency
warnings — the version pairing this project uses was itself an open question the task
brief flagged, and it resolved without needing a different prerenderer. A production
build renders `/` (the only route that exists at T31) to `dist/index.html`, which grew
from the pre-T31 placeholder's 0.40 kB (a bare `<div id="app"></div>`) to 2.13 KiB of
real markup. Reading the file directly off disk (`node:fs`, no browser, no script
execution — `scripts/verify-ssg-html.mjs`) shows the header wordmark, the live
breadcrumb text (`0 SELECTED`), all three side-panel section headings (`QUALITY`,
`DIMENSION`, `FORMAT`) and the primary action button's real interpolated label
(`Compress (0)`, not a template literal) already present in the HTML, each marked
`data-server-rendered="true"`. None of this depends on the `<script type="module"
async>` tag also present in the head — the content is baked into the served bytes
themselves, which is exactly the property this assumption claims.

**Why not higher.** The original Method text below asks for "a non-tool route" — T31
builds only the tool route (`/faq`, `/privacy`, `/terms`, `/desktop` arrive in T44), so
there is no second, differently-content route to compare against yet. The rendering
mechanism observed here is the same one T44's routes will go through — nothing in it
is tool-route-specific — so there is no concrete reason to expect a different result,
but "content differs correctly per route" specifically has not been directly observed,
only "content is real and present for the one route that exists." `@unhead/vue`
(per-route `<title>`/meta) is deliberately not installed yet (T45's job), so this run
still carries the same static `<title>` every route will start from. Held back from
100% for these two reasons, not because anything measured suggested a problem.

**Method.** Build the site, fetch a non-tool route's HTML file directly (no script
execution), and assert its `<title>`, meta description and visible body text are
present and correct without hydration. *(T31 completed this for the tool route only —
the one route that exists at this point in the build — reading `dist/index.html`
directly via Node's `fs` rather than fetching over HTTP, which satisfies "no script
execution" at least as strictly. The non-tool-route and meta-description halves of the
original method carry forward to T44/T45, over the same mechanism verified here.)*

**Affects.** Technical Design §12.3. If false, the SEO surface (§12.5) has nothing to
attach itself to, and a different SSG or prerendering plugin is substituted. *(Not
engaged — vite-ssg held.)*

---

### F2 `OPEN` `60%` `P3` The analytics beacon fires when the shell is served from the service worker's cache

Cloudflare Web Analytics is a client-side script; the concern is whether it still
executes and reports a page view when the HTML and its scripts are served entirely
from the service worker's cache rather than fetched from the network — the case this
design was chosen to cover.

**Method.** Load the app once online, force cache-only fetches (or go offline), reload,
and assert the analytics request still fires, using a Playwright test that intercepts
network requests.

**Affects.** Technical Design §12.6. If false, an alternative is a beacon fired from
the service worker's own lifecycle instead of the page, at the cost of per-view
granularity.
