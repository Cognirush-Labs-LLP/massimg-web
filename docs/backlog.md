# Backlog

Open gaps from a core-image-processing audit (baseline commit `4911c43`) that are not queued as
a direct code change — each needs a product decision, a genuinely new capability, or dedicated
test infrastructure before it can be fixed reliably. Every entry below is already disclosed to
users in `content/en/faq.md` unless marked otherwise — nobody is being told something false, but the
underlying code gap is still there.

Entries from BL-010 onward come from the T51 end-to-end work and the follow-up Linux runs
(`docs/task-notes/T51.md`), not from the audit.

The same audit found five other findings that were straightforward to fix; those are already
fixed in code (`a866ab2`, `02a1679`, `4cc8229`, `0a3aa11`, `528bb8a`) and aren't tracked here.
T37-A later resolved CORE-004 by wiring R-X24 into the shared output-selection stage. The audit
also flagged AVIF's "lossless" quality as a specification conflict, but that was already an
accepted, tested deviation (`docs/assumptions.md` D9) disclosed in the FAQ, so it isn't tracked
here either.

## BL-001 — R-Q2 pass-through keeps the source's metadata (CORE-002)

- **Requirements:** P1, R-Q2, R-I17, R-X46
- **Disclosed:** `content/en/faq.md` §7, "Does the app preserve EXIF metadata, like camera info or GPS
  location?"
- **Location:** `src/pipeline/execute.ts` (the shared source-output selection paths).
- **Why backlog:** R-Q2 ("an image already under the target is passed through unchanged") and
  R-I17 ("metadata is stripped by default") cannot both hold for a source carrying EXIF/IPTC/XMP.
  Deciding which promise wins, and what the report says when it does, is a product call — T30's
  handover note (`docs/task-notes/T30.md`) flagged this explicitly rather than picking an answer.
- **Current disclosure:** the `original-kept` outcome carries a reason, so the report distinguishes
  an already-met size target from a measured re-encode that was not smaller. This fixes the old
  misleading wording without resolving the metadata conflict itself.
- **Options recorded by the review:** container-level metadata stripping without a pixel
  re-encode (keeps R-Q2's byte-identical promise for pixels, breaks it for metadata bytes); or a
  distinct, truthful pass-through/metadata-retained caveat plus an amended R-I17.

## BL-002 — Non-sRGB CICP sources fail for every non-AVIF output (CORE-003)

- **Requirements:** R-I5, R-I8, R-I35
- **Disclosed:** `content/en/faq.md` §7, "What about the newer wide-color formats used by recent
  iPhones and AVIF photos (like Display P3)?"
- **Location:** `src/pipeline/stages/encode-plan.ts` (`unsupportedColour`); `src/pipeline/execute.ts`;
  `src/pipeline/worker.ts`.
- **Why backlog:** needs a genuinely new capability — CICP-to-sRGB pixel conversion — not a fix to
  existing code. A HEIC or AVIF source with Display-P3-style CICP signalling currently fails the
  job outright for JPEG/PNG/WebP/GIF output instead of converting; a HEIC input left on "Don't
  change" resolves to JPEG, so this is reachable without the user asking for a format conversion.
- **Option recorded by the review:** implement CICP→sRGB conversion for formats that cannot carry
  the signal, emit a `colour-converted` caveat, and keep the current AVIF carry-through unchanged.
  Needs real HEIC/AVIF CICP fixtures across still/animated and every output format.

## BL-004 — GIF only models alpha as boolean; partial transparency silently binarized (CORE-007)

- **Requirements:** P1, R-C13, R-X46
- **Disclosed:** `content/en/faq.md` §7, "Does GIF support transparency the same way PNG or WebP does?"
- **Location:** `src/domain/format.ts` (`supportsAlpha`); `src/domain/job.ts`; `src/pipeline/execute.ts`.
- **Why backlog:** needs a product decision on the disclosed policy — threshold/matte, format
  substitution, or outright rejection — before the alpha model can move from a boolean to
  none/binary/full. Semi-transparent edges, shadows and overlays currently turn fully solid or
  fully invisible with no caveat recorded.

## BL-005 — Animation timing rounding has no disclosed tolerance or per-run caveat (CORE-008)

- **Requirements:** P1, R-Q9
- **Disclosed:** `content/en/faq.md` §6, "Will the timing between frames be perfectly preserved?"
- **Location:** `src/pipeline/stages/gif-plan.ts` (`gifDelayCentiseconds`);
  `src/pipeline/stages/animation-plan.ts` (`apngDelayFraction`).
- **Why backlog:** GIF's centisecond rounding and APNG's rational-to-integer-millisecond
  conversion both change animation cadence without a caveat, and exact R-Q9 preservation is
  mathematically impossible for GIF's centisecond limit. The specification needs a tolerance and a
  disclosure/substitution rule before code can implement one; silently rounding is what's
  disclosed generically today, not decided per the spec.

## BL-006 — Source-derived metadata and auxiliary-image caveats have no producer (CORE-009)

- **Disclosed (partially):** `content/en/faq.md` §7 covers the metadata-removal policy and the Live
  Photo/portrait auxiliary-data loss in general terms. What is **not** disclosed anywhere: a
  specific run never tells the user "this file's GPS data was removed" or "this file's Live Photo
  data was dropped" — `metadata-removed` and `auxiliary-images-dropped` are declared in
  `src/domain/types.ts` and formatted in `src/domain/report.ts`, but no production code ever
  constructs one.
- **Requirements:** P1, R-I17, R-I34, R-X46
- **Location:** `src/domain/types.ts:90–99`; `src/domain/report.ts:103–126` (formatting only).
- **Why backlog:** needs new container-inspection code per format — EXIF/IPTC/XMP/GPS presence
  detection ahead of pixel decode, and HEIC auxiliary/depth-image detection — which is genuinely
  new scanning logic, not a wiring fix. Also depends on BL-001's outcome, since what
  "metadata removed" should mean on the R-Q2 pass-through path is exactly what BL-001 is deciding.

## BL-007 — Size-search algorithm assumes more monotonicity than proven

- **Requirements:** R-Q2–R-Q4 (size targeting)
- **Disclosed:** no — this is a coverage risk, not a behavior anyone has observed going wrong.
- **Location:** `src/pipeline/stages/size-plan.ts:148–183`.
- **Why backlog:** not a confirmed defect, an inspection-only risk. The search declares a target
  unreachable after only the low-slider probe, and treats two equal byte lengths as a plateau
  without comparing the bytes themselves. A non-monotonic encoder axis, or two distinct candidates
  that happen to land on the same size, could miss a fitting or higher-quality result. The
  measured corpus (five formats × five targets × five subjects × three engines, per T30) never
  showed such a curve. Needs an adversarial/synthetic encoder test corpus and a broader real-image
  corpus before deciding whether the algorithm itself needs to change.

## BL-008 — No mobile Safari / device-limit measurement for large animations

- **Requirements:** R-B2, R-B6, and memory safety generally
- **Disclosed:** `content/en/faq.md` §8 says mobile Safari's memory behavior "hasn't been verified yet."
- **Why backlog:** needs real device test infrastructure, not a code change. The longest committed
  browser fixture is 16 frames at 400×400; T29 measured larger generated cases on desktop only.
  There is no mobile Safari run and no regression threshold for resize/encode peak memory.

## BL-009 — HEIC-decoder-unavailable rejection has no live-browser trigger

- **Requirements:** §10 ("HEIC with no available decoder"), R-I2
- **Disclosed:** no — nothing to disclose; the condition cannot occur with the shipped build.
- **Location:** `src/platform/capability.ts` (`Capabilities.heicDecode`); `src/ui/gallery/ingest.ts`
  (`buildIngestOutcome`'s HEIC/HEIF branch); `src/ui/gallery/rejectionText.ts`
  (`rejection.reason.heicUnavailable`).
- **Why backlog:** the §10 row this rejection satisfies cites R-I7, which does not exist anywhere
  in `functional-design.md` — a dangling reference — and §5.2 confirms HEIC decode works on all
  three target engines today, since HEIC goes through ImageMagick WASM as ordinary input (T23) and
  the compiled-in codec list (assumptions.md A2) is a build-time fact, not something a browser API
  can be probed for at runtime. `Capabilities.heicDecode` is therefore hardcoded `true`, and the
  rejection path it feeds is verified only by unit tests that inject `heicDecode: false` directly —
  there is no way to make a real browser report it `false` with the current build. Revisit if a
  future build ever ships without HEIC support, or if genuine runtime HEIC-decode capability
  detection becomes possible.

## BL-010 — Firefox "Download and leave" can lose the download

- **Requirements:** R-X18, R-X25, R-X42
- **Disclosed:** `content/en/faq.md` §8, "Is there anything to watch out for when downloading in Firefox?"
- **Location:** `src/app/shell/useBackNavigationGuard.ts` (`download-and-leave`);
  `src/pipeline/run-download.ts`; the cleanup in `src/ui/processing/useProcessingRun.ts`.
- **What happens:** the app hands the file to the browser and calls `finishProcessing()` straight
  away, which unmounts Processing and deletes the run's stored files. Firefox reads the file
  lazily, so the download dies and the results are gone. The plain Download button is unaffected,
  because the files stay until the person leaves and "Download again" remains available.
- **Evidence (T51):** Linux Firefox, three workers: 7 of 40 runs; macOS Firefox: 1 of 40 with one
  worker, 8 of 40 with four. Delaying the teardown by 6 s let the download arrive in 40 of 40;
  delaying only the blob URL revoke changed nothing. Not seen on Chromium or WebKit, but only
  small archives were tested, so a large ZIP there is unverified.
- **Why backlog:** the fix is a design choice. Options: a grace period before cleanup (smallest
  change, keeps the dialog as designed); sweeping leftover files on the next start; or holding
  the file in memory (costs memory on big batches). Hiding the option for Firefox only was
  rejected: the race is not specific to Firefox, and it would change the R-X18 dialog.

## BL-011 — One oversized image can still halt a whole run

- **Requirements:** §10 ("Out of memory"), R-I22
- **Disclosed:** no.
- **Location:** `src/ui/processing/useProcessingRun.ts`; the `out-of-memory` failure kind.
- **Why backlog:** a product decision, not a confirmed defect. A worker failure of kind
  `out-of-memory` halts the run and discards partial results by design, while every other
  per-image failure only fails that image. The intended rule is that one bad image should not stop
  the rest, and a halt should mean a genuine run-level problem. T50 already made limit breaches
  per-image failures; what remains is deciding whether an encoder running out of memory on one
  image should do the same. A storage-write failure also halts the run, which is reasonable since
  nothing more can be saved, and both halt paths now log the underlying error to the console.

## BL-012 — `decode.spec.ts` "the fallback decode does not block the main thread" fails on Linux WebKit

- **Disclosed:** no.
- **Location:** `tests/e2e/decode.spec.ts` (the main-thread stall bound).
- **What happens:** the fallback decode for a format the browser cannot read (JPEG 2000) still
  produces its thumbnail, but the longest main-thread gap is 313 to 423 ms against a 250 ms bound
  on WebKit on Linux, every run, alone or in parallel. It passes on macOS WebKit. It predates T51.
- **Why backlog:** it will fail the Linux WebKit job in GitHub CI every time. Decide whether to
  skip it off macOS (`skipWebKitOutsideMac`) or loosen the bound, and whether the stall is real
  jank worth fixing for the few people on Linux WebKit.

## BL-013 — `folder-tree` journey skipped on non-Mac WebKit

- **Disclosed:** no.
- **Location:** `tests/e2e/journeys/folder-tree.spec.ts`.
- **What happens:** on Playwright's Linux WebKit the page intermittently stops answering the test
  after a folder selection (about 3% of runs: 2 of 30, 2 of 60, then 0 of 80). The screenshot at
  that moment shows the Gallery correct ("3 images"), so the app worked and the automation
  stalled. Cause not found. The test is skipped there, and the macOS run plus `folder.spec.ts`
  still cover folder selection. Revisit if Linux WebKit can be driven reliably, or if a real
  GNOME Web check (see BL-017) shows a real stall.

## BL-014 — Unexplained one-off test failures to watch

- **Disclosed:** no.
- **What happened:** 18 failures (`codecs.spec.ts:93`, `gallery-grid.spec.ts:209/250/267`,
  `preview.spec.ts:364/577`, on all three engines) in one full macOS run, then never again in two
  more full Mac runs and two full Linux runs. They all read counters from a module imported inside
  the page and got 0. Separately, `opfs.spec.ts:197` failed once on macOS WebKit under full load
  and passed 20 of 20 alone.
- **Why backlog:** no action unless they recur. If one does, run it alone, on `main`, and on
  another engine first (`CONTRIBUTING.md`), and capture the page state when it fails.

## BL-015 — The generated SEO files ignore `.env`

- **Disclosed:** no.
- **Location:** `scripts/generate-seo-files.mjs`.
- **What happens:** it reads `VITE_SITE_BASE_URL` from the shell environment only, whereas Vite
  also reads `.env` files for the page. Setting the URL only in `.env` would put the real URL in
  the canonical tags but leave `sitemap.xml`, `robots.txt` and `llms.txt` on the
  `site-base-url-not-set.invalid` placeholder. `tests/e2e-site/routes.spec.ts` would catch the
  mismatch because it compares the sitemap with each page's canonical URL.
- **Why backlog:** belongs with T51-A and T52. Either set the variable in the build's environment
  (for example `VITE_SITE_BASE_URL=https://massimg.com pnpm build`, or a GitHub Actions `env:`
  block), or make the script load `.env` the way Vite does.

## BL-016 — Cloudflare analytics: our own beacon or Cloudflare's automatic one

- **Requirements:** R-V3
- **Disclosed:** `content/en/faq.md` §2 ("Does the app track me…") describes the behavior; it does
  not say which mechanism supplies it.
- **Why backlog:** a decision for release. Cloudflare can inject its Web Analytics beacon at the
  edge once the site is proxied, which would need no token in our code. The design (§12.6) chose
  a beacon fired from the page so that visits served from the service worker's cache are still
  counted, which edge injection might miss. Running both would count visits twice. Suggested:
  keep our beacon with the real token (`VITE_CF_BEACON_TOKEN`, T51-A) and turn automatic
  injection off for the site. Verify in the Cloudflare dashboard before release.

## BL-017 — Pre-release browser checks not yet done

- **Disclosed:** `content/en/faq.md` §8 states GNOME Web and iPhone/iPad as untested.
- **What is missing:**
  - A run of the workflow on GitHub itself. Linux was run by hand on Ubuntu 26.04 with three
    workers; GitHub's runner is Ubuntu 24.04 with one.
  - A real Safari click-through of the footer links and one compression.
  - A compression run in real GNOME Web. Only page navigation was checked there, using
    WebKitGTK 2.52.6 through WebKitWebDriver (`webkitgtk-webdriver` and `xvfb` are installed on
    the Linux test machine), and WebDriver cannot read the browser's console.
  - A run on Windows. Only the Share handoff was measured there (Chrome, T39-A); the app itself
    has never been run on Windows, and `content/en/faq.md` §8 says so.
  - Other Android phones. One phone has been measured (Galaxy M34, Android 16, Chrome 155, 5.5 GB;
    T50), and the FAQ says only that. A 3 to 4 GB phone is where the PNG and AVIF encoder memory
    (not bounded by any limit) is expected to fail first.
  - Real iPhone and older low-memory phones (BL-008, E4).

## BL-018 — Privacy page does not mention Share

- **Disclosed:** `content/en/faq.md` §2 covers Share.
- **Why backlog:** `content/en/privacy.md` is final legal text and never mentions Share. Nothing
  in it is false (Share is an operating-system handoff, not a transmission to us), but a reader
  following the footer line finds nothing about it. A one-sentence addition for §2 was drafted
  during T49 and is waiting for the owner's approval; it is legal copy, so it is not an
  engineering change.

---

CICP and metadata *test coverage* gaps the original audit listed separately are tracked here
under BL-002 and BL-001/BL-006 rather than as their own entries, since fixing those backlog items
is what the missing coverage would need to test against.
