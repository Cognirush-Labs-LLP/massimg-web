# Backlog

Open gaps from a core-image-processing audit (baseline commit `4911c43`) that are not queued as
a direct code change — each needs a product decision, a genuinely new capability, or dedicated
test infrastructure before it can be fixed reliably. Every entry below is already disclosed to
users in `content/en/faq.md` unless marked otherwise — nobody is being told something false, but the
underlying code gap is still there.

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

---

CICP and metadata *test coverage* gaps the original audit listed separately are tracked here
under BL-002 and BL-001/BL-006 rather than as their own entries, since fixing those backlog items
is what the missing coverage would need to test against.
