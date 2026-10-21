# UI Design — T31 to T39

This document bridges the requirement IDs in `functional-design.md` and the
architectural rules in `technical-design.md` into concrete, implementable UI
behaviour: layout, state, control mechanics, copy, motion and error handling. It
exists because a visual mockup (`docs/sample_design/Image Compressor.dc.html`) was
produced early, before the functional design was finished, and the two now disagree
in a few places. This document is the resolution.

## 0. How to use this document

**Precedence when sources conflict:** `functional-design.md` > this document >
the sample HTML. The sample is a visual reference for chrome, spacing, colour and
type — not a spec. Anywhere this document departs from the sample, it says so
explicitly, with the reason, so nobody "fixes" the implementation back toward the
mockup.

**Cross-reference — task to section:**

| Task | Title | Section here |
|---|---|---|
| T31 | Shell, routing and static generation | §2, §3 |
| T32 | Stores | §4 |
| T33 | Gallery, grid view | §5, §6 |
| T34 | Gallery, list view | §7 |
| T35 | Side panel settings | §8, §9, §10 |
| T36 | Preview mode | §11 |
| T37 | Edit mode | §12 |
| T38 | Processing view | §13 |
| T39 | Errors and rejections | §14 |

Cross-cutting sections §1 (visual language), §15 (motion) and §16 (accessibility)
apply to every task above; read them once, not per-task.

Every subsection below states the requirement IDs it satisfies so it can be traced
back to `functional-design.md`. Read `functional-design.md` for the *why*; read this
document for the *how*.

---

## 1. Visual language reference

Full token definitions are T07's output (`src/styles/tokens.css`); this is a quick
anchor so the behavioural sections below can be read without cross-referencing that
file constantly.

| Token | Value | Use |
|---|---|---|
| Tint | `#cf0000` | Primary action, active/selected states, crop outline, reduction figure |
| Text primary | `#ffffff` | Body text, icons |
| Background | `#000000` | App background |
| Surface | `#060606` – `#121212` | Panel, drawer, cards, tiles, inputs |
| Border (group) | `#242424` | Section separators, header/panel borders |
| Border (control) | `#2c2c2c` | Input, button, chip borders |
| Text muted | `#7e7e7e` – `#a2a2a2` | Secondary text, section micro-labels, passive metadata |

### Typefaces — system fonts only

**No webfonts are bundled or fetched.** Both roles below resolve to whatever the
reader's platform provides. This is a deliberate change from the original design
(which named Archivo and JetBrains Mono) and from `functional-design.md` §14.2,
which has been updated to match.

The reason is multilingual support: a bundled Latin webfont covers only the
scripts it ships subsets for, so any locale outside that set silently falls back
to a system font anyway — producing a *different* look per language, plus a
download that buys nothing for those readers. The system stack is already correct
for every script the reader's OS supports, costs no bytes, and never flashes
unstyled text.

- **UI role** — proportional system sans: `-apple-system, BlinkMacSystemFont,
  'Segoe UI', Roboto, Helvetica, Arial, sans-serif` (plus
  `'Apple Color Emoji', 'Segoe UI Emoji'` at the tail).
- **Data role** — system monospace: `ui-monospace, SFMono-Regular, Menlo,
  Consolas, 'Liberation Mono', monospace`. Used for every number: file sizes,
  pixel dimensions, the `N / N` stepper and processed counter, the breadcrumb,
  quality readout, zoom readout.

Two consequences of dropping named fonts, which the implementation must respect:

- **Cap the heaviest weight at 700, not 800.** Weight 800 is not reliably a real
  cut across system families and gets synthesised (smeared) where it's missing.
  Use 700 for the wordmark and primary action, 600 for section headings and
  functional micro-labels, and normal weight for body. Where the wordmark needs
  more presence than 700 gives, get it from size, letter-spacing and colour — not
  from a heavier weight.
- **The data role's job is aligned digits, not a particular look.** Set
  `font-variant-numeric: tabular-nums` wherever numbers update in place (the
  processed counter, the reduction total, the quality readout, size figures), so
  digits don't jitter as values change. This matters more than which monospace
  family resolves, and it works in the proportional stack too if a monospace face
  is unavailable.
- Section headings are uppercase with wide letter-spacing. Functional micro-labels
  (`OUTPUT`, `ZOOM`, `RATIO`, `BACKGROUND`, `TARGET`, `PICK ONE`) are small,
  weight 600, `#a2a2a2` — quiet, not competing with content. Apply the uppercasing
  with CSS `text-transform`, never by uppercasing strings in the message
  catalogue, since not every script has a case mapping (R-L1).
- Radii: 6–7px for chips and small fields, 8–10px for controls and accordion rows,
  11–12px for the primary button and the stage frame.
- **Tint is reserved for action and state, and is never decorative.** The donut in
  Processing (§13) is the one place colour distinguishes categories, and for exactly
  that reason it is fully redundant with text (R-X4, R-K8).
- **Colour never carries information alone.** Wherever colour signals a state
  (size increased, a tile failed, a row is selected), a glyph, label or icon carries
  the same information (R-K8). See §11 (increase glyph) and §6 (FAILED badge is a
  text badge, not a red border alone).
- Dark theme only; no light theme is in scope for T31–T39.

---

## 2. App shell & responsive behaviour

**Satisfies:** R-R1–R-R5, R-A1, R-S1, functional-design §2, §11.

Everything below describes the compressor's own chrome, which lives on **one route**.
Its four stage modes (§3) are internal state, never URLs (R-S1). T31's other half — the
router, the site config and static generation — is specified in technical-design §12.2
and §12.3 rather than here, and the outer site header and footer that wrap this shell
arrive later, in T43. Two consequences for anyone implementing this section: the regions
below are mounted inside a route component rather than at the application root, and
every component here is rendered once in Node at build time, so browser APIs belong in
client-only lifecycle hooks.

### Regions

Three regions, always present: **header**, **stage**, **side panel**.

```
Desktop (>=900px)                          Mobile (<900px)
┌──────────────────────┬──────────┐        ┌──────────────────────┐
│ wordmark · crumb     │          │        │ wordmark · crumb  [☰]│
├──────────────────────┤  Side    │        ├──────────────────────┤
│ stage toolbar (wraps)│  panel   │        │ stage toolbar (wraps)│
├──────────────────────┤  344px   │        ├──────────────────────┤
│                      │  static  │        │                      │
│  stage body          │  column  │        │  stage body          │
│  (scrolls)           │          │        │  (scrolls)           │
│                      ├──────────┤        ├──────────────────────┤
│                      │ Compress │        │      Compress        │
│                      │ meta line│        │      meta line       │
└──────────────────────┴──────────┘        └──────────────────────┘
                                            panel = off-canvas drawer
                                            over the stage; bottom bar
                                            stays outside it
```

- **Breakpoint: 900px.** The layout is space-driven, not device-driven (R-R1) — a
  narrow desktop window gets the mobile drawer behaviour, a large tablet gets the
  static column.
- **Header:** wordmark ("Compressor") + a small tint dot, then the breadcrumb in
  mono uppercase, then (mobile only) the **Options** button — a solid tint pill
  with a menu glyph, same visual weight as the primary action since it is the only
  way to reach settings on mobile.
- **Breadcrumb text by mode:**

Uppercase mono in all four cases:

| Mode | Breadcrumb |
|---|---|
| Gallery | `6 SELECTED` |
| Preview | `PREVIEW · abc.jpg` |
| Edit | `EDIT · abc.jpg` |
| Processing | `PROCESSING` |

Apply the uppercasing as a CSS `text-transform`, not by uppercasing the string in
the message catalogue — the filename is user data and some locales have no case
mapping (R-L1/R-L5).

- **Stage:** owns a mode-specific toolbar row (buttons, stepper, ratio chips —
  whatever that mode needs) plus a scrollable body. Toolbar rows **wrap**, they
  never scroll horizontally (R-R2).
- **Side panel:**
  - **≥900px:** static column, width 344px, positioned at the **inline-end** edge
    (`inset-inline-end` / logical flow order, not a hardcoded `right` — required by
    R-L4 so RTL locales flip correctly later), separated by a 1px `#242424`
    border, never collapsible. It is not hidden behind any toggle at this width.
  - **<900px:** off-canvas drawer, width `min(340px, 88vw)`, slides in from the
    inline-end edge, with a `rgba(0,0,0,.6)` scrim over the stage. A sticky **Hide**
    button pins to the top of the drawer's scroll area. Opening it is the Options
    button's only job; tapping the scrimmed stage or pressing Hide closes it.
  - The panel holds three sections in order — **Quality, Dimension, Format** — with
    1px `#242424` borders between sections only, not between individual controls
    within a section.
  - The panel is **not shown during Processing** (§13) — it is replaced entirely by
    run status; there is nothing to configure mid-run.
- **Drawer accessibility (R-K3):** while open, focus is trapped inside it; Escape
  closes it; closing (by Hide, scrim tap, or Escape) returns focus to the Options
  button that opened it.
- **Primary action (R-A1):** visible at all times, in both layouts.
  - Desktop: pinned to the side panel's footer, below the settings sections.
  - Mobile: a **bottom bar outside the drawer**. Opening or hiding the drawer
    never covers or removes it — a user can compress without ever opening Options,
    if the defaults suit them. It is the last item in the tool page's full-height
    column, not an overlay: always on screen, but taking its own space rather than
    floating over the stage. **The stage therefore reserves no bottom clearance for
    it.** T31 did build it as `position: fixed` and gave the stage and the drawer a
    96px clearance to match; T43 changed it to an ordinary flex item and left both
    clearances behind, which cost Preview roughly 17% of its frame height on a phone
    until they were removed. If it ever becomes an overlay again, the clearance has
    to return with it — `tests/e2e/app.spec.ts` pins the current contract.
- **Touch targets** are at least 44px in their primary dimension everywhere in the
  stage and panel (R-R3); crop handles get a touch-hit area larger than their
  visual size (R-R4, detailed in §12).
- **Processing view** is single-column on mobile with the counter and donut above
  the detail text, on all widths (R-R5) — Processing does not attempt a two-column
  layout at any breakpoint.

---

## 3. Mode state machine

**Satisfies:** R-M1–R-M9, functional-design §3.1.

Four stage modes: **Gallery**, **Preview**, **Edit**, **Processing**. Exactly one is
mounted at a time.

**Implementation constraint, not just a visual one:** a mode switch is an
*unmount of the outgoing mode's component tree and a mount of the incoming one* —
never a `v-if` toggle inside one persistent tree. This is deliberate and is *how*
R-M4 is satisfied: unmounting releases the outgoing mode's decoded pixel data,
in-flight encodes and listeners automatically, rather than relying on a component
remembering to clean up. Do not attempt to preserve component-local state (scroll
position, transient UI state) across a mode switch by hoisting it — if it needs to
survive, it belongs in a store (§4).

**One exception:** the thumbnail Blob cache (§6) is batch-scoped, not
Gallery-scoped, and its cached entries survive mode changes so returning to
Gallery does not re-read source files. Only its *generation* (the active decode
queue) is exclusive to the mounted Gallery grid — leaving Gallery, or switching to
list view within Gallery, stops generation immediately (R-G12).

### Transition table

| From | Trigger | To |
|---|---|---|
| Gallery (empty) | First image(s) accepted, resulting count == 1 | Preview |
| Gallery (empty) | First image(s) accepted, resulting count > 1 | Gallery |
| Gallery | Tile or row clicked | Preview, for that image |
| Preview | Back action | Gallery |
| Preview | Images added, new count > 1 | Gallery |
| Preview | Edit action | Edit, for the same image |
| Preview | Current image removed | Gallery, or Preview of the remaining image if count becomes 1 |
| Edit | Apply, Cancel, or Remove edit | Preview, for the same image |
| Gallery or Preview | Primary action pressed | Processing |
| Processing | Run finished, "Back to images" pressed | Gallery |
| Processing | Cancel | Gallery |
| Any | Last image removed | Gallery (empty state) |

Two rules worth calling out because they're easy to get backwards:

- **R-M1:** whenever the batch reaches *exactly one* image — by initial selection
  or by removing down to one — the app shows **Preview** for that image, not a
  one-tile Gallery grid. A single image never sits in Gallery.
- **R-M2:** if the batch *grows past one* while Preview is open (via "Add more
  images", R-M3), the app returns to **Gallery** rather than staying on the image
  that was being previewed.

### Browser back button

Gallery is the app's one route (§3's own framing, R-S1) — these four modes never become URLs, so
without extra handling a physical back-button press would simply leave the app from wherever it's
pressed.

- **R-M6:** one synthetic history entry is pushed per nested mode (Preview, Edit, Processing),
  plus one base guard entry for Gallery pushed once at app start.
- **R-M7:** a first back press in a nested mode performs that mode's own default back transition —
  the same one its on-screen back control performs (Preview → Gallery, Edit → Preview) — silently.
  A mode added later only needs an explicit entry in that transition table if its default isn't
  "return to Gallery"; nothing about back-button handling itself needs to change.
- **R-M8:** a back press in Processing instead follows R-X18/R-X19 (§14) — a plain Cancel raises
  no confirmation, but a completed, undownloaded run raises that three-way dialog.
- **R-M9:** a second back press, once already at Gallery, raises a Stay/Leave confirmation (§14)
  rather than exiting immediately — see "Leaving the app from the back button" in §14.

---

## 4. Store responsibilities

**Satisfies:** technical-design §3 (store shapes) and §1.1 (the
binary-data-never-enters-the-reactive-graph rule); R-B1 (no encoded result is
retained beyond the moment it is used — previews are discarded on leaving Preview
or on any settings change).

Four Pinia stores. All four hold **metadata only** — every `File`, `Blob`,
`ArrayBuffer` and `ImageBitmap` lives in a plain, non-reactive, module-scope `Map`
keyed by `ImageId`, outside any store, e.g.:

```ts
// module scope, deliberately outside Pinia's reactivity
const sourceFiles = new Map<ImageId, File>()
const thumbnails = new Map<ImageId, Blob>()
```

A unit test asserts no store value is a `File`/`Blob`/`ArrayBuffer`/`ImageBitmap`
or a reactive proxy of one. Where a binary value must sit on an object a store
touches, wrap it in `markRaw`.

### `useBatchStore`
Holds the `ImageRecord[]` for the current batch, in **insertion order** — adding
appends, it never re-sorts, and folder input inserts in traversal order (R-G5).
Also holds selection-time rejection entries (§14) and per-image `status`/`failure`.
Removing one image never touches another image's `edit` or settings (R-G2).

### `useSettingsStore`
Batch-wide settings only: quality mode + value, dimension rule + value, output
format. These are never per-image — the only per-image state is `edit`, which
lives on the `ImageRecord` itself. **Any change here invalidates every in-flight
preview encode** (R-P3): the settings store is the trigger, Preview mode (§11) is
the consumer that reacts to it via the debounce/token mechanism in §11.

### `useRunStore`
Exists only during and immediately after a Processing run. Holds progress counts
by state (pending/succeeded/skipped/failed), accumulated input and output bytes from
successes, the failure and structured skip lists, and caveats collected per image. Populated by worker result
messages as they arrive; reset when a new run starts.

### `useUiStore`
Holds interaction/navigation state that isn't part of the batch or its settings:
**stage mode** (which of the four modes in §3 is mounted — this is the field the
app shell reads to decide what to mount), **current image index** (active image
in Preview/Edit), **gallery view mode** (`grid` | `list`, §5–§7), **drawer open
state** (mobile Options drawer, §2), **comparison tab** (`original` | `compressed`,
§11).

### The edit record

`ImageRecord.edit` is an ordered, extensible array of operations, not two named
fields:

```ts
type EditOp =
  | { kind: 'rotate'; quarterTurns: 0 | 1 | 2 | 3 }
  | { kind: 'crop'; rect: NormalisedRect; zoom: number; background: Rgba }

interface EditRecord {
  ops: EditOp[]
  version: number
}
```

Edit mode (§12) today only ever produces a rotate op followed by a crop op, but
the UI layer must walk `ops` generically — it must not assume that order or that
there are exactly two entries, because more op kinds will be added later without
restructuring this shape. `rect` is normalised to **fractions of the source
image**, not pixels, so it survives viewport and window-resize changes untouched.
`version` is bumped on every edit change and is what Preview's discard-by-token
mechanism compares to invalidate a stale encode.

### Cross-store interaction rules

- A settings change (`useSettingsStore`) while Preview is mounted supersedes any
  in-flight encode; the stale result is discarded on arrival, never rendered
  (R-P3, R-X28 — mechanism detailed in §11).
- Batch count crossing the 1-image boundary (`useBatchStore.length`) drives mode
  transitions per §3's table (R-M1/R-M2) — this logic belongs in the store or a
  thin composable watching it, not duplicated in each component that can change
  the count (Gallery remove, Preview "Add more images", drop-anywhere).
- Removing the currently-active image in Preview re-targets `useUiStore`'s
  current index to the next reasonable image per the transition table, or exits
  to Gallery if none remain.

---

## 5. Gallery — empty state

**Satisfies:** R-G1–R-G6, R-V1, R-V3, functional-design §3.2, §8.

Full-stage dashed drop zone (border `1.5px dashed #303030`, radius ~14px):

- Headline: "Drop images to compress."
- A mono line stating accepted formats and the batch limit, e.g.
  `JPEG · PNG · WEBP · AVIF · GIF · up to N files` (N comes from the runtime limits
  config, T50 — never hard-code it in copy).
- **Two buttons**, not one: **Select images** and **Select folder**. The sample
  mockup has only a "Select images" button; the folder picker is a required
  affordance (R-I24–R-I32) that must be added here, and it should hide itself
  gracefully where the platform reports no folder-picker capability
  (`platform/capability.ts`) rather than appearing and failing.
- Drag-and-drop is accepted **anywhere on the stage**, for both loose files and
  dropped directory entries, not just onto the dashed box.
- **The privacy block** (R-V1, R-V3; added by T49, which is past this document's
  T31–T39 cross-reference table — the table was deliberately not widened): small,
  quiet, centred text below the buttons, in the same register as the formats line.
  Two complete sentences in **two separate elements** — the claim itself (processing
  on the device; a result leaves only when the user presses Share) and the analytics
  disclosure naming exactly what the site measures. Never one sentence assembled
  from two translated fragments (R-L5), and never a link: the footer on the same
  screen already links the Privacy page, and a third link inside the drop zone
  would compete with the drop target and the two calls to action. R-V1's other half —
  the claim staying *reachable* once images are loaded — is carried by the site
  footer's existing **Privacy** link, present in every stage mode. A longer privacy
  line in the compact footer was tried and rejected: below roughly 600px it wrapped
  that row onto a second line and took 30px off the stage, which showed up as a
  shorter Preview frame. Shortening the wording does not help, because the wrap is
  driven by the number of items on the row.

---

## 6. Gallery — grid view

**Satisfies:** R-G1–R-G6, R-G10, R-G12, technical-design §10.4.

### Populated header row (Gallery, both view modes)

- Title "Your Images" plus a mono meta line: image count and total input size.
  Use the **UI** size formatter from `domain/sizes.ts` (`Intl.NumberFormat`,
  locale-aware) — never the report formatter, which is deliberately
  locale-independent and exists only for the YAML report (R-L3). This applies to
  every byte figure in the interface, not just this line.
  No estimated output size appears anywhere in Gallery — nothing has been
  compressed yet (functional-design §14.3, honesty of numbers).
- Affordance line above the grid/list: "Click an image to preview the result,
  rotate or crop it."
- Toolbar: **Add images**, **Add folder**, the grid/list **view-mode toggle**
  (§7), **Clear**.
- **Clear removes everything and returns to the empty state with no confirmation**
  (R-G6) — re-selecting files is cheap, and a confirmation dialog costs more than
  the mistake, especially on touch.

### Tile anatomy (grid mode)

- Thumbnail — bounded on **both** width and height axes (a width-only bound fails
  on pathologically tall/wide sources).
- Filename, truncated with ellipsis.
- `W×H · size` on one line, using the UI size formatter.
- Badges, top-left, in this fixed order when more than one applies:
  **EDITED** (rotation, crop, or recovery resize stored) → **ANIMATED** (multi-frame source written
  as an animated format; **FIRST FRAME** replaces it when the animation will not survive the
  chosen format, R-F9) → **SKIPPED** (the last completed run could not meet its size ceiling)
  or **FAILED** (processing failed, §14). Badges are text
  labels with their own background, not colour-only indicators (§1's
  colour-never-alone rule).
- Remove control, top-right, a small × button; clicking it does not open the
  tile's Preview (stop propagation) and does not affect any other tile (R-G2).

### Thumbnail generation — lazy, bounded, LRU

- Generation targets **visible and near-visible tiles only**; the grid is
  virtualized so scrolling quickly through a large batch does not queue work for
  every tile it passes over (R-G10).
- The batch retains at most `maximumThumbnails` thumbnail Blobs (shipped default
  **100**, read from the runtime limits config) as an **LRU cache**. A tile
  currently in a visible window is always the freshest entry; once the cap is
  reached, generating a newly-visible, not-yet-cached tile evicts the
  least-recently-visible one instead of refusing to generate at all. A **neutral
  placeholder** — not an error state, not a spinner — shows only for the
  instant between a tile becoming visible and its (re)generation finishing, never
  permanently. Every eviction revokes the evicted thumbnail's object URL.
- **Lifecycle is strictly tied to the mounted Gallery grid component:**
  - Entering Gallery in grid mode starts the generation queue.
  - Leaving Gallery (any other mode), or switching to **list** view within
    Gallery, immediately clears queued work and stops every in-flight thumbnail
    job (R-G12). Where the underlying decode can't be cancelled directly,
    terminate its worker rather than let it finish uselessly.
  - A decode that completes after its owning context has already been torn down
    is discarded via a generation token, not written into the cache — this is the
    same discard-by-token pattern used for preview encodes (§11) and run jobs
    (§13), applied here to thumbnail generation.
- Thumbnails are the **only** per-image pixel data retained for Gallery, bounded
  in both dimensions and encoded size (R-G3). Completed cache entries **persist
  across mode changes** (§3's stated exception) and are released on: image
  removal, edit invalidation (a crop/rotate changes what the thumbnail should
  show), batch clear, or LRU eviction once the cache is at capacity and a
  different tile needs generating. Every release also revokes the thumbnail's
  object URL (R-G3).
- Thumbnails reflect stored rotation and crop (R-G4) — an edited image's tile
  shows the edited framing, not the raw source.

---

## 7. Gallery — list view

**Satisfies:** R-G7–R-G12, functional-design §3.2. The sample mockup has no list
view at all; this section is a fresh design, not a reconciliation.

### Row anatomy

One row per image, **no thumbnail column** — list mode generates no thumbnails
and decodes nothing at all (R-G9):

- Relative path (only present for folder-sourced images) + filename.
- `W×H · size`, same UI size formatter as grid.
- Same badge set and order as grid tiles (EDITED → ANIMATED → SKIPPED/FAILED).
- Remove control, same behaviour as grid (no effect on other rows).

### Grouping

- When the batch came from folder input, rows are **grouped by directory**,
  preserving the source tree's order (R-G11) — a group header per directory,
  relative to the picked root.
- When the batch is loose files (no folder origin), there is no grouping — a
  flat list in insertion order, same as grid mode's ordering rule (R-G5).

### View-mode selection (R-G8)

- The app **auto-selects** the initial view: **grid** below a file-count
  threshold, **list** at or above it, and **list always** for folder input
  regardless of count.
- The threshold is the same `maximumThumbnails` runtime value used for the
  thumbnail budget (100 by default, per T20's measurement) — one number, one
  config source, not a separately-tuned constant.
- The user can override the auto-selected mode via the toolbar toggle; the
  override **persists for the session** (not saved beyond it).

### Interaction with grid's thumbnail lifecycle

Entering list mode is itself one of the triggers that stops grid thumbnail
generation (§6, R-G12) — restated here because T34 is implemented separately from
T33 and needs this rule at its own point of contact: switching to list mid-scroll
must cancel the grid's in-flight queue immediately, not let it drain in the
background.

---

## 8. Side panel — Quality

**Satisfies:** R-Q1–R-Q4, functional-design §4.1.

A segmented control with two options: **Quality** and **Size**. Only one target
type is active per batch.

### Quality target (default)

- Slider, range 10–100, with a large mono numeric readout above it.
- Three shortcut chips: `LOW 40`, `MED 70`, `HIGH 90`. Clicking a chip sets the
  slider to that value; the slider remains freely adjustable afterward — chips
  are shortcuts, not a locked mode.
- The panel never explains that quality means something different per output
  format (R-Q1) — that mapping is intentionally invisible here; it lives in
  `domain/job.ts`.

### Size target

- A numeric text field plus a `KB`/`MB` unit toggle, segmented like the quality
  chips.
- The value is a hard **per-image maximum**, never an exact byte request and never a batch total.
- Behavioural notes the panel's microcopy and Preview/Processing surfaces must
  honour, so implementers don't accidentally re-encode against these:
  - **R-Q2:** an image already smaller than the target passes through
    **unchanged** — never re-encoded upward to approach the target from below.
  - **R-Q3:** if the target can't be reached even at the lowest acceptable
    quality, Preview replaces the image frame with the warning and the run skips
    the image. Oversized bytes never reach the UI, Download or a ZIP; this is a
    constraint outcome, not a technical failure or success caveat.
- **R-Q4 hook:** where repeated encoding to hit a size target is prohibitively
  expensive for a given format, the Size option must be **disabled with a stated
  reason** when that format is selected. As of T30's measurements, no format is
  actually excluded — every format currently offers Size — but the disabling
  mechanism (disabled state + reason string) must exist in the control, not be
  bolted on later, since PNG is flagged as the slowest/most-often-unreachable
  case and may need it if further measurement changes that.

---

## 9. Side panel — Dimension

**Satisfies:** R-D1–R-D4, R-N1–R-N2, functional-design §4.2.

An accordion of **four radio rows**. Exactly one is active at a time; selecting a
row expands it to reveal its numeric field and shortcut chips, and collapses
every other row's children (they stay visible as collapsed rows, just without
their controls showing).

| Row | Value | Shortcut chips |
|---|---|---|
| Original size | none | — |
| Fit within long edge | one px value | `HD 1280` `FHD 1920` `2K 2560` `4K 3840` `IG 1080` |
| Fixed width | one px value | `IG 1080` `WEB 1200` `MAIL 800` `PRINT 3000` |
| Fixed height | one px value | `IG 1350` `HD 720` `FHD 1080` |

- Chips only **write a number into the field** — there is no separate "Custom"
  state to fall into; the field is always directly editable regardless of
  whether a chip was used.
- "Fit within long edge" only ever **downscales** — an image already inside the
  limit is left untouched.
- **R-N1:** Fixed width and Fixed height each derive the other dimension to
  preserve aspect ratio.
- **R-N2:** Fixed width and Fixed height are the **only** paths by which a batch
  setting can **upscale** a source smaller than the target — this asymmetry
  (Fit never upscales, Fixed width/height can) is intentional, not a bug to
  "fix" for consistency.
- Rotation and crop are **not** rows here — they are per-image edits that live
  entirely in Edit mode (§12), not batch-wide dimension rules.

### Interaction with crop (R-D1–R-D4)

- **R-D1:** an image with a crop applied takes its output size **from the crop**;
  the batch Dimension setting is ignored for that image specifically (other,
  uncropped images in the same batch still follow it).
- **R-D2:** with more than one image and at least one cropped, a note appears
  above the accordion: *"Crop applied to N images. Their crop overrides the
  setting below; the rest follow it."*
- **R-D3:** with exactly one image in the batch, and it is cropped, the entire
  Dimension accordion is **disabled**, with a note explaining why (its output
  size is already fixed by the crop, so the rows have nothing to control).
- **R-D4:** rotation alone (no crop) does **not** disable or override the
  Dimension rule — a rotated-only image still follows the batch setting, applied
  to its rotated dimensions.

### Row help (R-D5)

Each of Fit within long edge, Fixed width, and Fixed height carries a small icon-only "?"
affordance beside its row label (not Original size — its row already says "none").
Activating it opens the same small, centred, focus-trapped dialog shape already
established for the leave-confirmation dialogs (§13/§14): a scrim, a box centred on screen
(`min(360px, calc(100vw - 32px))` wide) with a title and a body paragraph — one shape for
both mobile and desktop. Unlike those dialogs, this one is purely informational, not an
irreversible choice, so it closes by its own Close button, Escape, *or* a scrim click, and
returns focus to the "?" that opened it.

- **Title:** the row's own label.
- **Body:** one short, plain sentence — what the rule does, nothing more. No mention of
  enlarging or shrinking here; that lives in the note below, not the main explanation.
- **Note:** a small, visually quieter line below the body (and below the diagram, for Fit
  within long edge) stating whether the rule can enlarge the image — a fragment, not
  required to be a full sentence ("Shrinks only — never enlarges." / "May enlarge small
  images."). Secondary information gets secondary typography: smaller size, the quietest
  text tone (`--color-text-muted-quiet`), not folded into the main sentence.
- **Diagram (Fit within long edge only):** a small, purely illustrative `aria-hidden`
  pair of rectangles — one landscape, one portrait — each with their longer side marked,
  making "long edge" legible at a glance without more prose. Not used for Fixed
  width/height, which have no ambiguous axis to illustrate. Uses `--color-primary` for the
  mark, never `--color-tint` (§14.1 reserves tint for action/state, not decoration).

---

## 10. Side panel — Format & primary action

**Satisfies:** R-F1–R-F8, R-A1–R-A4, functional-design §4.3–§4.4.

### Format dropdown

Six entries, in this exact order — **the sample mockup ships only four
(JPEG/PNG/WebP/AVIF); GIF and "Don't change" must be added**:

| Option | Notes |
|---|---|
| **Don't change** (default) | Each image keeps its own input format independently. |
| JPEG | No alpha, no animation. Shows the "WebP for animated images" checkbox (R-F9). |
| PNG | Still or animated; still PNG quantized below slider value 85 (R-Q11); animated PNG always lossless (R-Q15). |
| WebP | Still or animated. |
| AVIF | Still only — animated AVIF output is not supported. Shows the "WebP for animated images" checkbox (R-F9). |
| GIF | For graphics and animation; carries inline warning copy that it produces worse results than JPEG for photographs. |

- **R-F1/R-F2:** "Don't change" resolves per-image; where the input format can't
  actually be re-written by the encoder (HEIC, TIFF, BMP, JPEG XL), it resolves
  to JPEG for that image. This is never hidden from the user: the transform line
  (§11) shows the real output extension rather than claiming "unchanged".
- **R-F4:** with "Don't change" selected, the primary action's meta line reads
  **"Original formats"** rather than naming one format.
- **R-F6:** choosing a still-only format (JPEG or AVIF) for a batch containing an
  animated source does **not**, by default, flatten that source to one frame — it's
  written as animated WebP instead, and the substitution is stated on the tile, in the
  Preview transform line, and in the report.
- **R-F9:** a **"WebP for animated images"** checkbox sits beneath the dropdown
  whenever JPEG or AVIF is selected — independent of what is in the batch, so
  choosing the format before adding images still shows it. It is checked by
  default. Unchecked, animated sources are written from their first frame only,
  and the loss is disclosed in four places, none of them requiring a visit to
  Preview: a hint under the checkbox counting the affected animated images (amber
  with a ⚠ when unchecked, muted when checked); a **FIRST FRAME** badge in place
  of ANIMATED on each affected tile and row (amber text, still a text label); an
  amber ⚠ note on the Preview transform line; and the report's `Animation
  flattened` caveat. The hint is absent while the batch has no animated image.
- **R-F7/R-F8:** animated AVIF is never produced as output; animated AVIF as
  *input* is rejected at selection time (§14), not silently accepted and
  mishandled.
- No "APNG" entry exists separately from PNG — an animated source written as PNG
  simply produces an animated PNG file; exposing APNG as a distinct choice would
  ask the user to understand a distinction they have no reason to know about.

### Primary action

- Label: **Compress**, or **Compress (N)** for a batch of N.
- A meta line beneath it states **facts only**, never a size estimate:
  - Multi-image: `6 images · Original formats · ZIP`
  - Single image: `WEBP · 1920×1440`
- **R-A2:** no aggregate output size is ever shown before the run — it isn't
  knowable until images are actually encoded (functional-design §14.3).
- **R-A3:** disabled whenever the batch is empty.
- A known single-image hard-ceiling miss does not disable it; Processing remains the
  authoritative run and completes with that image under Skipped and no Download action.
- **R-A4:** pressing it always enters Processing (§13); it never downloads
  directly — Download is an explicit action inside Processing, after the run
  completes.

---

## 11. Preview mode

**Satisfies:** R-P1–R-P8, R-M3, functional-design §3.3.

Preview shows one image, fitted inside the available stage area; the side panel
remains visible (desktop) or reachable via Options (mobile) — settings can be
changed without leaving Preview.

### Entry and encoding

- **R-P1:** opening Preview (from Gallery, or by being the sole image on add)
  immediately starts a **real encode** at current settings — never an estimate —
  and the frame shows a "Creating preview" state with an animated progress
  indicator until it completes. The indicator respects reduced-motion preferences.
- **R-P2:** the **Compressed** tab is selected by default once the encode
  finishes.
- **R-P3/R-X28:** changing any setting that affects output — quality, size
  target, dimension rule or value, format, rotation, crop — supersedes any
  in-flight encode. The mechanism is **debounce 1000ms + discard-by-token**: each
  encode job carries a monotonic token; the UI records the latest token
  requested per image; a result whose token is stale on arrival is dropped, never
  rendered. The debounce means a dragged slider produces **one** encode after the
  drag settles, not one per tick.
- **R-P4:** while an encode is in flight, the comparison figures (below) are
  **hidden**, not left showing the previous (now stale) numbers.

### Comparison pill

Centered above the frame:

```
500 KB   [ Original | Compressed ]   250 KB   50% ↓
```

- A single pill; clicking **anywhere on it** flips between Original and
  Compressed — not two separate buttons.
- Left figure = original size, right figure = actual measured encoded size
  (never estimated), trailing figure = percentage change.
- **R-P5:** when the output is **larger** than the input, the trailing figure
  shows the increase with an **up glyph and a non-tint colour** — it is never
  suppressed, never shown as zero, and never relies on colour alone to signal the
  increase (§1's colour-never-alone rule, applied concretely here).

### Transform line

One mono line below the pill, reflecting current format/rotation/crop/dimension
settings for this specific image:

```
abc.jpeg  1000×1000  →  abc.webp  500×500
```

Whenever the resolved format matches the source format — under "Don't change" or an
explicit pick of the same format — the output extension matches the input extension
exactly (including case, per R-X43).

### Hard size ceiling and recovery

An unreachable Size setting is visible before any recovery analysis finishes:
“Couldn’t reach {target} as {width}×{height} {format}. Smallest possible at these
settings: {achieved}. This image will be skipped.” The warning replaces the image
frame; an oversized attempt is never shown as a Preview result.

For exactly one still image, the status then reads “Checking JPEG and smaller
dimensions…” beside a visible animated progress indicator, and verified actions
appear progressively as their tests complete:

- `Use JPEG · {size}` only for PNG→PNG when the tested JPEG fits.
- `Use JPEG with {color} background · {size}` when that JPEG test actually flattened
  transparency; outside Edit the existing white default applies.
- `Reduce to {width}×{height} · {size}` for the largest tested current-format
  dimensions that fit at quality 30 or better, after choosing the highest fitting
  quality at those dimensions.
- `Try {width}×{height} · higher quality` for the next lower standard controlled
  edge from the ladder 240, 360, 480, 640, 720, 800, 1024, 1080, 1280, 1440,
  1600, 1920, 2048, 2160, 2560, 2880, 3200, 3840 and 4096 pixels. This second dimension action costs
  no recovery probe and shows no unmeasured byte claim; selecting it runs the
  ordinary hard-ceiling Preview encode.

Every action is advisory until clicked. A click changes settings or appends/replaces
the image's single post-crop recovery resize, bumps the edit version, and triggers a
fresh ordinary Preview encode. No recovery bytes are reused. If no action is verified,
the status says so and shows no disabled alternatives. A batch instead says “The size
setting applies to all {count} images” and dispatches no recovery jobs. An animation
explains that automatic alternatives are not checked and it will be skipped.
Leaving Preview cancels queued recovery work and prevents its next step from being
dispatched. A codec operation already inside WASM may finish and be discarded;
returning resumes the warmed pool, so rapid navigation does not grow a work queue.

### Zoom/pan inspector

Beside the comparison pill, a small toolbar: **Fit**, **Actual size**, and a live
zoom percent readout (e.g. `100%`). The frame itself takes no slider or overlay
chrome — zoom and pan are primarily direct manipulation: wheel or pinch to zoom about
the pointer, drag to pan. "Fit" returns to the contain-fit rest state R-P6
describes; "Actual size" is true 1:1 pixels of whichever tab is showing, and
disables itself once the view is already there. Both buttons disable when there
is nothing to do (already at fit, or already at actual size).

- **R-K1 (keyboard):** when the frame itself has focus, arrow keys pan, `+`/`-`
  zoom in/out, and `Shift+0` resets to fit — the keyboard equivalent of the same
  gestures, layered on top rather than replacing them (T47).

- **R-P9:** flipping between Original and Compressed keeps the same patch of the
  image in view and preserves true **pixel density**, not apparent on-screen
  size. A Compressed output viewed at its own 100% shows Original at the
  fraction of its own pixels that reproduces the same screen footprint — a
  500×500 output of a 1000×1000 source appears at 50% on Original, not at the
  same apparent size as Compressed. This holds from the very first, unzoomed
  view onward, not only once the user has manually zoomed in. A pixel-density
  match may call for more zoom than a tab's own usual ceiling allows; when it
  does, the ceiling yields rather than the match being clamped away — the view
  may look softer/more interpolated at that extreme, which is expected.
  Rotation is exempt from this: it only reshuffles axes rather than changing
  pixel counts, so there is no pixel-perfect correspondence to preserve across
  it, and none is attempted.
- **R-P10:** changing any setting or edit that causes Compressed to regenerate
  (quality, size target, dimension rule, format, rotation, crop) brings the
  Compressed tab to the front at its own actual size, centred — so the user is
  never left looking at an Original that does not match a change they just
  made. This is distinct from, and does not override, R-P7 below: stepping to
  a different image still preserves whichever tab was selected.

### Toolbar

**Back to images**, **Add more images**, a `3 / 6` stepper (only when the batch
has more than one image), and **Edit** (or **Edit changes** once an edit already
exists on this image).

- **R-M3:** "Add more images" opens the file picker from inside Preview; if the
  resulting count exceeds one, the app follows R-M2 and returns to Gallery.
- **R-P6:** the frame preserves the image's true aspect ratio at any viewport
  size — the stage is measured, the frame is given contain-fit dimensions, the
  image is never stretched.
- **R-P7:** the stepper wraps at both ends and **preserves the selected
  comparison tab** across a step. Stepping releases the outgoing image's decoded
  and encoded working set before starting the incoming image's encode — not
  concurrently held.
- **R-P8:** an animated source plays in the frame on **both** tabs, so the user
  can visually confirm the animation survived compression.

---

## 12. Edit mode

**Satisfies:** R-C1–R-C17, R-K4, functional-design §3.4, technical-design §6.

Entered from Preview via **Edit** / **Edit changes**. Edits are per-image, always
applied to whichever image is currently in the frame. This version offers
**rotation and crop only**.

### Reading the arithmetic as UI behaviour

Technical Design §6 defines the pure math this section's controls must produce.
Restated in control terms, not formulas:

- The app picks a **display scale** that fits the (rotated) image inside the
  available frame — this is never something the user controls, and it has **no
  effect on output**.
- The **zoom slider** is the user-controlled scale on top of that fit. **Zooming
  in shrinks the output dimensions** for a fixed crop rectangle (more of the
  source is excluded per rectangle pixel); **zooming out grows them**, including
  past the source's own resolution — that's a legitimate result of the tool,
  not a bug, and is exactly when the background row (below) becomes relevant.
- **Typing into the output W or H field** resizes the crop rectangle on screen to
  match — it is the inverse of the same formula, not a separate code path. With a
  ratio locked, editing one dimension derives the other.
- **Rotating 90°/270°** swaps the working width/height, recomputes the display
  fit, and **refits** the crop rectangle and any locked ratio so the on-screen
  rectangle and the typed W/H never disagree afterward (R-C3). Rotation is
  applied to the image **before** the crop rectangle is interpreted — the user
  always draws on the image as currently displayed, post-rotation (R-C2).
- **Spill** (the crop rectangle extending beyond the image's own edges, which
  happens when zooming out past the point where the image exactly fills the
  rectangle) is exactly the condition that makes the **background row** appear.
  It is not always visible — only on spill.

### Controls

- **Ratio row**, above the frame: `Free · 1:1 · 4:5 · 16:9 · 9:16`. Selecting a
  ratio locks the crop rectangle's proportions for every subsequent drag, resize
  and typed-dimension edit, until Free is reselected.
- **Crop rectangle** over the image: four corner handles, draggable and
  resizable from any corner; the area outside it is darkened, showing what will
  be discarded; a live `W×H` badge sits inside the rectangle showing true output
  pixels (not on-screen pixels).
- **Output W / H** numeric fields in the toolbar — editable, see above.
- **Rotate left / Rotate right** — 90° steps only; free-angle rotation is out of
  scope (R-C1).
- **Remove edit** — only rendered when this image already has a stored edit;
  clears rotation, crop and any trailing recovery resize together and returns to Preview (R-C5).
- **Cancel** — restores rotation, crop rectangle, locked ratio, zoom and
  background **all** to their values on entering Edit mode, preserving any trailing
  recovery resize, then returns to
  Preview (R-C10). Rotation is included — a common mistake is to only restore the
  crop rectangle.
- **Apply** — stores the current rotation + crop as this image's edit, even if
  the user only rotated and never touched the rectangle (a rotate-only edit is
  still a real, storable edit covering the whole rotated image, R-C4). Applying
  changed crop geometry removes any prior recovery resize; Preview may offer a
  newly verified size for the new composition.

### Background row — resolves a direct sample-vs-spec conflict

The sample mockup implements this row with four numeric R/G/B/A `<input>` fields.
**That is superseded here.** Functional design (§3.4, R-C13/R-C14, principle P3
— "expert controls in a tool built for people who want a smaller photo") requires:

- **Swatches only:** Black, White, and — only when the effective output format
  supports alpha — Transparent.
- **A native colour picker** for anything else the swatches don't cover.
- **No numeric RGBA fields anywhere in this row.**

Behaviour:
- Shown only when spill exists (see above) — not a permanently visible row.
- The frame renders the chosen colour over a checkerboard backdrop so partial
  alpha remains legible.
- **R-C13:** when the effective format supports alpha (PNG, WebP, AVIF, GIF, or
  "Don't change" resolving to one of them), the default fill is fully
  transparent and the Transparent swatch is available.
- **R-C14:** when the effective format has no alpha (JPEG, or "Don't change"
  resolving to JPEG), the Transparent swatch is hidden, the fill renders and
  exports opaque, and the hint text reads "JPEG has no transparency — pick a
  fill colour."
- **R-C15:** switching to JPEG does not destroy a previously chosen alpha/colour
  value — it's preserved in state, just rendered opaque while JPEG is selected,
  and restored if the user switches back to an alpha-capable format.
- **R-C17:** outside Edit mode, no background control exists at all; where
  transparency will be flattened without the user having visited Edit, the
  Preview transform line states it and the report records it, and white is used
  as the fill.

### Other rules

- **R-C6/R-C16:** Edit is not offered at all for animated sources — no crop
  (R-C16) and no rotation (R-C6, which defers to R-C16's reason) — and the
  reason is **stated inline** next to where the Edit action would otherwise be,
  not left as a dead or silently missing button. Functional design does not fix
  the wording of that inline reason, so it is a copy decision for T37: say that
  editing animated images is not supported in this version, which is the
  accurate statement. Do not invent a technical justification in user-facing
  copy.
- **R-C7–R-C9, R-C12:** covered under "reading the arithmetic" above; the
  rectangle can never leave the frame and has a minimum output-pixel size.
- **R-C11:** a locked ratio is re-fitted to the next image's own dimensions when
  the user steps to another image via Preview's stepper and re-enters Edit.
- **R-K4 (keyboard):** the crop rectangle can be moved and resized with arrow
  keys, with a modifier key (e.g. Shift) for coarse steps; **Escape** cancels
  without applying; **Enter** applies. Touch hit area on the corner handles is
  larger than their visual size (R-R4).

---

## 13. Processing view

**Satisfies:** R-X1–R-X20, R-X26–R-X31, functional-design §6.1–§6.9.

Entered by the primary action. A full stage mode — the side panel is replaced
entirely by run status; there is nothing to configure mid-run.

### Layout

Single-column on every width (R-R5): counter and donut above the detail text,
even on desktop — Processing does not attempt a two-column layout.

### During the run

- **R-X1/R-X2:** every image in the batch is re-encoded from its source file, in
  grid order, including any image already previewed — nothing from Preview is
  reused.
- **R-X3:** the counter is the primary status, mono: `2 / 10 processed`.
- **R-X4:** a donut shows the proportion succeeded/skipped/failed/pending, but it is
  **decoration** — every number it encodes is also written out as text beside
  it. No information exists only inside the chart (so it can be hidden entirely
  under reduced motion or for accessibility without losing information, R-K8).
- **R-X5:** a running total of size reduction updates as images complete — bytes
  saved and a percentage, both **measured from completed encodes**, never
  projected from images not yet processed.
- **R-X6:** the current file name is not shown during the run — per-image
  identity only matters for the failure list (below).
- **R-X8:** images process with bounded concurrency (the worker pool, sized per
  technical-design §5.1), never all at once.
- **R-X9:** files rejected at selection time (§14) never appear in this counter —
  they never entered the batch — though they do appear in the report.

### Cancel

- **R-X7/R-X26:** **Cancel** is available throughout the run. Because a WASM
  encode in flight cannot be interrupted, Cancel stops the run **after the image
  currently in flight completes** — bounded by one image's wait, not the whole
  remaining batch.
- **R-X27:** the button's own label reports this honestly — it reads **Cancel**
  before it's pressed and **Stopping** immediately after, remaining visible until
  the run actually halts.
- **R-X19/R-X20:** Cancel does **not** raise the leave-confirmation dialog (§14)
  — there are no complete results yet to lose. Cancelling discards all partial
  results and returns to Gallery with the batch, settings and edits intact.
- **R-X29 (the escape hatch, not the normal path):** where a *single* job
  exceeds a duration threshold and the user is waiting, its worker may be
  terminated and recreated. This costs a full codec re-initialisation, so it is
  never the routine cancellation mechanism — Cancel uses the between-jobs flag
  above. The threshold comes from measured re-init cost, not a guess, and is
  still unmeasured (`jobTimeoutMs` is currently `null` in the runtime limits
  config); until it has a measured value, no watchdog fires. Treat a UI that
  silently hangs forever on one pathological image as a known, accepted gap
  rather than something to paper over with an arbitrary timeout.

### Failures and skips mid-run

- **R-X10:** a failure on one image does not abort the run — it's counted
  failed, and the run continues to the next image.
- **R-X11:** failed images are listed by file name with their failure reason, as
  plain text in the view.
- **R-X12/R-X13:** output is built only from successes. A technically failed image
  appears under **Failed**; an accepted image whose size ceiling was unreachable
  appears under **Skipped**, with target, smallest achieved size, effective format
  and requested dimensions. Skips add no output bytes or savings and never enter
  direct output or ZIP assembly. If there are no successes, no output or Download
  action exists and both lists form the visible result.
- A completed run's `SKIPPED`/`FAILED` tile state persists after Back to images.
  Starting the next run clears it; settings changes and Preview-time misses do not.

### On completion

- **R-X14:** the view shows final succeeded/skipped/failed counts, total size
  reduction from successes, both issue lists, and **Back to images**. **Download**
  appears only when at least one image succeeded.
- **R-X15:** Download is always explicit — the run never downloads
  automatically (an automatic download can trigger a browser warning and gives
  the user no clear moment of "it's done, here it is").
- **R-X17:** "Back to images" returns to Gallery with the batch, settings and
  edits **intact** — nothing is reset by viewing a completed run.
- **After a Download, the Download action stays on screen as "Download again",
  below the checked "Download started" line, as a secondary (outlined) action
  while **Back to images** takes primary.** The browser reports nothing back
  about whether a download actually saved — an anchor click resolves nothing and
  throws nothing — so the app cannot distinguish a saved file from one the
  browser silently declined. Pressing it again is the user's only recourse, and
  the run's outputs are deliberately kept on disk until the user leaves
  Processing (R-X42's cleanup moved to that point) so there is something to
  deliver. **Share is different and collapses to the checked state alone:**
  `navigator.share()` resolves only when the platform really accepted the
  payload, which is a genuine confirmation.

  This refines R-X54's "Download and Share are replaced by a checked,
  non-interactive completion state": the checked state appears exactly as
  described, but for Download it sits above a still-live retry rather than
  replacing the action outright. Deleting a run's only copy on an unverifiable
  signal destroyed results at the moment the app was least sure anything had
  been delivered, while telling the user it had worked.
- **R-X16:** a single successful image downloads directly as that image file
  (its real output extension) — no ZIP, no report file.
- **R-X30/R-X31:** two or more successful images download as a single ZIP
  containing the images plus `image_compression_report.txt` **inside** the
  archive, not offered as a separate download alongside it.

### Storage lifecycle (implementation obligation, not just a visual rule)

The staged archive in OPFS is **deleted** after a successful download, when the
user leaves the Processing view by any path, and again on application start
(R-X42) — this is a cleanup obligation the Processing component/store must
implement on unmount and on the "Back to images" / leave-confirmation actions
(§14), not something left to eventually get garbage collected.

---

## 14. Errors, rejections, and confirmations

**Satisfies:** R-E1–R-E3, R-I20, R-I21, R-X18, R-K9, functional-design §10.

**No condition may fail silently or with a generic message.** "Something went
wrong" appears nowhere in this interface (R-E1).

### Every condition and its surface

T39's completion bar is that **each row of functional-design §10 has a test that
triggers it and asserts the message content**. All eighteen rows are reproduced
here, grouped by the surface that renders them, so no row is discovered late:

| Condition | Detected | Surface |
|---|---|---|
| Unsupported file type | Selection | Rejection list, file named |
| HEIC with no available decoder | Selection | Rejection list, message per R-I7 |
| File exceeds size or pixel cap | Selection | Rejection list with actual value and cap |
| Animated file exceeds frame or pixel budget | Selection | Rejection list, values stated |
| Batch exceeds file count | Selection | Rejection list, count stated |
| Animated AVIF input | Selection | Rejection list, reason named per R-F8 |
| Selected folder contains no supported images | Selection | Stated plainly, batch not created |
| Folder depth or file count exceeded | Selection | Rejection with actual figure and cap |
| Corrupt or undecodable file | Decode | Marked failed, reason in the failure list |
| Encode failure | Run or preview | Marked failed; in Preview, an inline error in the frame with a retry |
| Size target unreachable | Run or preview | Preview shows the warning, verified single-still actions and the derived lower standard-size choice; Processing lists Skipped and emits no bytes for it |
| Out of memory | Any | Run halts, partial results discarded, message recommends fewer or smaller images and mentions the desktop application |
| ZIP assembly failure | Packaging | Error shown, no partial ZIP delivered |
| Download blocked by browser | Download | Message explaining the browser blocked it, with a retry |
| Storage quota insufficient for predicted archive | Before run | Batch rejected, both figures named |
| Origin-private storage unavailable | Startup | Reduced cap applied silently; stated only when a batch is blocked by it |
| Storage write failure mid-run | Run | Run halts, stored archive deleted, message states no partial file was kept |
| Every image in a run failed or was skipped | End of run | No output or Download action; failures and skips listed |

Four of these need a surface that isn't the selection-time list or a tile badge,
and are easy to miss because they only appear under conditions that are awkward
to reach by hand:

- **Out of memory** and **storage write failure mid-run** both *halt the run* and
  land in Processing (§13) as a terminal state, replacing the completion actions.
  The storage-failure message must explicitly state that no partial file was kept
  — a user who has just watched a progress bar needs to know there is nothing
  half-written to find.
- **ZIP assembly failure** and **download blocked by browser** happen *after* a
  run the user believes succeeded. Both surface in the completed Processing view
  next to Download, and the blocked-download case offers a retry rather than
  leaving the user to guess that their browser suppressed it.
- **Origin-private storage unavailable** is the one condition that is *deliberately
  silent* at detection (startup). It only becomes visible later, at the moment a
  batch is actually blocked by the reduced cap it caused — do not surface it as a
  startup warning.
- **Storage quota insufficient** is checked *before the run starts*, not during:
  the batch is rejected up front, naming both the predicted archive size and the
  available quota (R-I20's name-the-value-and-the-cap rule applies here too).

### Selection-time rejections

One **dismissible list**, shown once per selection action — never one alert per
rejected file (R-E2), covering the eight selection-row conditions in the table
above. Every entry names the actual file, states the actual value and the actual
cap (not just "too large"), and states what to do next (R-I20).

Two behaviours that are easy to get wrong:

- **Rejecting some files never blocks the rest** — the acceptable files in the
  same selection are added to the batch, and the list reports what was dropped
  alongside them. A partially-bad selection is not a failed selection.
- Rejected files never enter the batch, so they never appear in the Processing
  counter (R-X9) — but they **do** appear in the report's Skipped section, so
  they must be recorded at rejection time, not just rendered and forgotten.

Where a rejection stems from a hard browser or memory limit rather than a
deliberate product limit, its message also mentions that the desktop application
has no such limit (R-I21) — the constraint is the browser's, not a design
choice, and the user should know there's a way around it if they need one.

### Per-image failures

- **R-E3:** a failed image **stays visible in the grid/list** (badge: FAILED,
  §6) rather than disappearing — the user needs to see which one it was, and can
  remove it individually without affecting the rest of the batch.
- A Preview-time encode failure (distinct from a selection-time rejection) shows
  an **inline error directly in the frame**, with a retry action — this is a
  different surface from the dismissible list, because it's about one specific
  image the user is actively looking at, not a batch of rejections.

### Leaving a finished run with undownloaded results

- **R-X18:** navigating away from a **completed** Processing run without having
  downloaded raises a confirmation dialog: it states that the results will be
  discarded, and offers exactly three actions — **Download and leave**, **Leave
  without downloading**, **Stay**.
- **R-K9:** the dialog is focus-trapped, and **Stay** is the default-focused
  action — leaving is never the path of least resistance.
- Restated from §13: this dialog is **not** shown after a plain Cancel (R-X19) —
  only after a completed run with results still sitting undownloaded.
- A physical browser back-button press while Processing is mounted follows this same rule
  (R-M8): still running, or already downloaded → Cancel, no dialog; completed and undownloaded →
  this three-way dialog, with **Stay** re-arming the back-button guard rather than transitioning.

### Leaving the app from the back button

- **R-M9:** the app's one route (§3) has no second level of its own history beyond Gallery, so a
  second back press once already at Gallery — after a first press has already unwound any nested
  stage (Preview, Edit) back to it per R-M7 — is genuine leave intent, not a mode transition. It
  raises a confirmation with exactly two actions: **Stay**, **Leave**.
- **R-K12:** same pattern as R-K9 — focus-trapped, **Stay** default-focused — for this distinct
  dialog.
- Choosing **Leave** allows the browser's own back navigation to proceed; **Stay** re-arms the
  guard and keeps the user on Gallery.

### Toasts

Ephemeral, non-blocking confirmations (e.g. "Crop applied · 500×500", "Crop
removed") use the bottom-center toast pattern from the sample mockup: a small
dark pill, auto-dismissing after roughly 2.2 seconds. Its entrance animation
(slide up + fade) is subject to `prefers-reduced-motion` like everything else in
§15.

---

## 15. Motion

**Satisfies:** R-K7.

Every animation below is a **utility signal that a state changed**, not
decoration, and every one collapses to an instant, no-op transition when
`prefers-reduced-motion` is set.

| Element | Motion | Why it earns its place |
|---|---|---|
| Mobile drawer | Slide in/out (~200ms ease) from inline-end edge | Communicates the panel entering/leaving screen space, not just appearing |
| Scrim | Fade in/out with the drawer | Reinforces that the stage is temporarily inert while the drawer is open |
| Toast | Slide up + fade in (~180ms) | Draws the eye to a transient confirmation without a jarring pop |
| Dimension accordion row | Expand/collapse height (~150ms) | Shows which row is now active without a jump cut |
| Crop rectangle & handles | **No animation** — must track the pointer 1:1 | Any lag or easing here would make dragging feel broken |
| Comparison tab / segmented controls | **No animation** — instant switch | The whole point of the toggle is instant before/after feedback; easing would undercut it |
| Processing donut | Fills as results arrive, no easing beyond a simple transition | It's a live readout of real progress, not a decorative loop |

Nothing in this interface animates purely for polish — if an element's motion
doesn't communicate a state change, it doesn't get one.

---

## 16. Accessibility notes

**Satisfies:** R-K1–R-K11, functional-design §12. This is a consolidated checklist
pointing back to where each rule is detailed above, not a restatement of the
requirements themselves.

- **R-K1:** every control across all four modes is reachable and operable by
  keyboard — this is a review gate for each of T31–T39, not a separate task.
- **R-K2:** arrow keys step through the batch in Preview (the stepper, §11);
  Escape exits Edit without applying; Enter applies an edit (§12).
- **R-K3:** the mobile drawer traps focus, closes on Escape, and returns focus to
  the Options button on close (§2).
- **R-K4:** the crop rectangle is keyboard-movable and -resizable, with a coarse-
  step modifier (§12).
- **R-K5:** state changes that are otherwise only visual — an encode
  starting/finishing, an image failing, run progress, run completion — are
  announced to assistive technology; run progress is announced **at intervals**,
  not once per image (§13), to avoid flooding a screen reader during a large
  batch.
- **R-K6:** every control has an accessible name; the comparison toggle (§11)
  specifically announces which view (Original/Compressed) is currently active,
  since its state isn't conveyed by a persistent visible label.
- **R-K7:** motion respects `prefers-reduced-motion` throughout (§15).
- **R-K8:** colour never carries information alone — already threaded through
  §1 (general rule), §6 (FAILED badge is text, not just a red outline), §11 (the
  size-increase glyph), and §13 (the donut's full text redundancy).
- **R-K9:** the leave-with-undownloaded-results dialog (§14) is focus-trapped
  with **Stay** as its default-focused action.
- **R-K10:** an accessible name is added *only* where a control has no visible
  text label — the icon-only controls in this interface: the tile remove × (§6),
  the mobile Options and Hide buttons (§2), the rotate and crop-handle controls
  (§12), and the Dimension rows' "?" help buttons (§9, R-D5). A button that
  already reads "Compress", "Add images" or "Back to
  images" gets no `aria-label`; its visible text is already its accessible name,
  and duplicating it only doubles what has to be translated. Each name that *is*
  added is a catalogue key with a context entry like any other string (R-L1,
  R-L2) — not a literal in the template.
- **R-K11:** no text is added anywhere for a crawler rather than a person. No
  hidden keyword copy, no markup comments describing features to machines. This
  is a hard line, not a tradeoff to revisit for ranking.
