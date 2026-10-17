# Mass Image Compressor Web: Functional Design

Scope: responsive web app (mobile-first) for batch image compression, resizing, format conversion, rotation and single-image cropping. Accepts individual files or whole folders. All processing happens in the browser. No account and no server-side upload; an explicit Share action may hand completed outputs to a system target selected by the user.

Requirement IDs are stable and referenced by the Technical Design and Tasks documents. Do not renumber them.

---

## 1. Product summary

A single-screen tool. The user brings images in, sets one compression target, one dimension rule and one output format, runs the batch, and then downloads the result: a single file for one image, a ZIP for many. On a supported platform, a run that started with no more than ten accepted images may instead share its successful images through the system share sheet. A large staging area doubles as gallery, result preview, edit workspace and progress view, so the user never leaves the screen.

### 1.1 Goals

- Compress a batch in three decisions or fewer: target, size, format.
- Make the result verifiable before delivery, by showing the actual compressed image and its actual size.
- Support the manual operations that batch settings cannot express: rotation and cropping of a single image.
- Work on a phone without hiding the primary action.
- Keep peak memory low enough that mobile Safari does not kill the tab.

### 1.2 Non-goals

- Editing beyond rotation and crop in this version. See §4.5 for what the architecture must leave room for.
- Server-side processing, accounts, history or cloud storage.
- Platform-named export presets (rationale in §14.4).
- Video, PDF or RAW input.

### 1.3 Relationship to the desktop product

This is a funnel for the desktop application, not a replacement. It targets users who want a quick one-off compression without installing anything. Where the web version cannot match the desktop version (large batches, very large files, formats the browser cannot decode), the failure message is an opportunity to mention the desktop product, but the web tool must be independently useful and must not be crippled to drive installs.


### 1.4 Guiding principles

These govern decisions not yet anticipated. When a requirement below and a principle here conflict, the principle wins and the requirement is wrong.

**P1. Do no harm.** Never produce a result that loses data or surprises the user without saying so. Dropping frames, flattening transparency, stripping metadata, changing an extension the user asked to keep: each is either prevented, or done and stated in the interface and the report. Silence is the failure, not the operation.

**P2. Support it properly or not at all.** A format or feature that works in some conditions and fails in others is not supported. Where reliability is known to differ by platform, the feature is offered where it is reliable and withheld where it is not. That is first-class support scoped honestly, not a partial promise.

**P3. Keep it simple.** The target user wants a smaller photo and knows little else. Add an option because many people need it, never because it is cheap to build. Prefer a safe default to a control. Cognitive load is a cost paid by every user, including those who never touch the setting.

**P4. Verify before assuming.** Stability outranks speed of design. A belief about how something behaves is recorded in the assumptions register with a test, not written into a requirement as fact.

**P5. Never return a larger file for the same format when the original satisfies the request.** If input and output formats match, no edit or actual dimension change was requested, and the re-encoded output is not smaller, the original-side candidate is kept. A format change or a transformation the original does not satisfy is the case where a size increase is legitimate, because the user asked for it.

### 1.5 Language

The interface ships in English and is built to be translated without restructuring.

- R-L1 No user-facing string is written inline. Every string lives in a locale file keyed by identifier.
- R-L2 A parallel context file accompanies the locale file, giving each key the situation it appears in, what the surrounding UI does, and any length constraint. A translator working from keys and strings alone cannot tell a verb from a noun in English, and this is where translation quality is lost. This file exists once, in English; it is never translated and never duplicated per locale, and every locale's strings are read alongside this same file (Technical Design §11).
- R-L3 The report is not translated. It is machine-readable, so its keys stay English and its numbers stay dot-decimal regardless of interface language. The interface and the report never share a number formatter.
- R-L4 Layout uses direction-neutral properties throughout, so a right-to-left locale mirrors without rewriting layout rules. The side panel and the mobile drawer are on the inline-end side, not the right.
- R-L5 Text that is composed from parts at runtime uses a single parameterised string per sentence. Sentences are never assembled by concatenating fragments, because word order differs by language.

---

## 2. Layout and regions

Three regions:

| Region | Role |
| --- | --- |
| Header | Product mark, context breadcrumb, mobile Options button |
| Stage | Gallery / Preview / Edit / Processing, the largest area on screen |
| Side panel | Compression settings and primary action |

### 2.1 Header

- Wordmark plus a tint dot.
- Breadcrumb, uppercase mono, reflecting stage state: `6 SELECTED`, `PREVIEW · abc.jpg`, `EDIT · abc.jpg`, `PROCESSING`.
- **Options** button: visible on mobile only, rendered as a solid tint-red pill with a `☰` mark so it carries the same visual weight as the primary action.

### 2.2 Stage

Fills all remaining width. Owns a mode-specific toolbar row and a scrollable body.

### 2.3 Side panel

- Desktop (>=900px): static right column, 344px, always visible, separated by a grey border. Never collapsible. Showing it is preferred to hiding it.
- Mobile (<900px): off-canvas drawer sliding in from the right, width `min(340px, 88vw)`, with a scrim over the stage. A sticky **Hide** button pins to the top of the drawer.
- Sections in order: Quality, Dimension, Format. Grey 1px borders separate the sections only, not individual controls.
- The panel is not available during Processing (§6), where it is replaced by run status.

---

## 3. Stage modes

Four modes: Gallery, Preview, Edit, Processing. Exactly one is active.

### 3.1 Mode transition rules

| From | Trigger | To |
| --- | --- | --- |
| Gallery (empty) | First image accepted, count == 1 | Preview |
| Gallery (empty) | First images accepted, count > 1 | Gallery |
| Gallery | Tile clicked | Preview for that image |
| Preview | Back action | Gallery |
| Preview | Images added, new count > 1 | Gallery |
| Preview | Edit action | Edit mode |
| Preview | Current image removed | Gallery, or Preview of the remaining image if count becomes 1 |
| Edit | Apply, Cancel or Remove edit | Preview for the same image |
| Gallery / Preview | Primary action pressed | Processing |
| Processing | Run finished, Back to images | Gallery |
| Processing | Cancel | Gallery |
| Any | Last image removed | Gallery (empty state) |

**Requirements**

- R-M1 When the batch reaches exactly one image by any route (initial add, or removal), the app shows Preview for that image rather than a one-tile gallery.
- R-M2 When the batch grows beyond one image while Preview is open, the app returns to Gallery.
- R-M3 Preview offers an **Add more images** action, which opens the file picker. Adding from here follows R-M2.
- R-M4 Mode changes release all full-resolution decoded data and all preview or run encoded data for
  the outgoing mode (see §9). The bounded, batch-scoped thumbnail cache in R-G3 may remain so returning
  to Gallery does not reread large source files; R-G12 still stops all thumbnail generation outside
  Gallery.
- R-M5 Leaving Processing with undelivered results is governed by R-X18.
- R-M6 The physical browser back button is integrated with this mode state machine: one synthetic
  history entry is pushed per nested stage mode (Preview, Edit, Processing), plus one base guard
  entry for Gallery pushed once at app start — Gallery is the app's only route (R-S1) and otherwise
  has no history entry of its own. A back press never exits the app outright while either is live.
- R-M7 A first back press while in a nested stage performs that stage's own default back
  transition — the same transition its on-screen back control performs (Preview → Gallery, Edit →
  Preview) — silently, with no confirmation. Extensible to any stage mode added in the future
  without new navigation-handling code: a stage needs an explicit entry only when its default back
  transition isn't "return to Gallery."
- R-M8 A back press while in Processing is governed by R-X18/R-X19 instead of R-M7's default.
- R-M9 A second back press, once already at Gallery (the base guard entry), is treated as leave
  intent: a confirmation offers **Stay** and **Leave**. Stay re-arms the guard; Leave allows the
  browser's own back navigation to proceed.

### 3.2 Gallery view

**Empty state.** Dashed drop zone covering the stage: headline "Drop images to compress", a mono line of accepted formats and limits, a **Select images** button and a **Select folder** button. Drag and drop anywhere on the stage is accepted, for files and for folders.

**Two view modes.** The Gallery renders either as a thumbnail grid or as a list. The list carries no thumbnails, so it costs one row per file and no image decoding at all.

| Mode | Shows | Suited to |
| --- | --- | --- |
| Grid | Thumbnail, filename, `W×H · size` | Small batches, visual selection |
| List | Relative path, filename, `W×H · size` | Large batches and folder input |

- R-G7 The view mode is a user-visible toggle in the toolbar.
- R-G8 The app selects the initial mode automatically: grid below a threshold file count, list at or above it, and list always for folder input. The user can override, and the override persists for the session.
- R-G9 In list mode no thumbnails are generated at all. Nothing is decoded until the user opens Preview.
- R-G10 In grid mode thumbnails are generated only for tiles that are visible or close to visible, and
  the grid is virtualized. Scrolling quickly through a large batch must not queue work for every tile it
  passes. The batch permits at most the runtime-configured thumbnail limit of source-read attempts; its
  initial default is 100. An attempt is charged when reading starts and is not refunded after failure or
  cancellation. Once the budget is exhausted, uncached tiles show a neutral placeholder; this is not an
  error. Cached thumbnails are not evicted merely to generate thumbnails for other tiles, because that
  would cause repeated source reads while scrolling.
- R-G11 List mode groups by directory when the batch came from a folder, preserving the tree. Grid mode does not group.
- R-G12 Thumbnail generation runs only while Gallery is active in grid mode. Leaving Gallery or switching
  to list mode immediately clears queued work and stops every in-flight thumbnail job. A completion that
  races with cancellation is discarded and its decoded data is released; no thumbnail work continues in
  the background.

**Populated state.**

- Title "Your Images" with a mono meta line: image count and total input size. No estimated output size appears here, because nothing has been compressed yet (see §14.3).
- An affordance line above the grid: "Click an image to preview the result, rotate or crop it".
- Grid mode: responsive thumbnail grid, `auto-fill` with a configurable minimum tile width. Each tile shows thumbnail, filename (truncated), and `W×H · human-readable size`.
- List mode: one row per image showing relative path where present, filename, and `W×H · human-readable size`.
- Overlays and badges appear in both modes.
- Toolbar actions: **Add images**, **Add folder**, **Clear**, view mode toggle.

**Tile badges.** Zero or more, in this order when several apply:

| Badge | Meaning |
| --- | --- |
| `EDITED` | A rotation or crop is stored for this image |
| `ANIMATED` | Multi-frame source, will be written as an animated format |
| `SKIPPED` | The most recent completed run omitted this image because its size ceiling was unreachable |
| `FAILED` | Processing failed for this image (see §10) |

**Requirements**

- R-G1 Clicking a tile or row opens Preview mode for that image.
- R-G2 Removing an image does not change any other image's settings.
- R-G3 Thumbnails, where generated, are bounded in dimensions and encoded size (§9), and no more than the
  runtime-configured thumbnail limit of encoded thumbnail Blobs are retained for a batch. The initial
  default is 100. They are the only per-image pixel data retained for Gallery. Removing an image,
  invalidating its thumbnail after an edit, or clearing the batch releases its Blob and revokes its object
  URL.
- R-G4 Thumbnails reflect stored rotation and crop.
- R-G5 The batch preserves insertion order. Adding appends; it does not re-sort. Folder input inserts in traversal order.
- R-G6 **Clear** removes all images and returns to the empty state. It requires no confirmation, because re-selecting files is cheap and a confirmation dialog on a touch device costs more than the mistake.

### 3.3 Preview mode

Shows one image fitted inside the available stage area, with the side panel still visible.

**Encoding on entry.** Opening Preview runs a real encode of that image at the current settings. There is no estimation.

- R-P1 On entering Preview, the app immediately begins encoding and shows a "Creating preview" state with a visible animated progress indicator in the frame.
- R-P2 The **Compressed** tab is selected by default when the encode completes.
- R-P3 Changing any setting that affects output (quality, size target, dimension rule and its value, format, rotation, crop) supersedes any in-flight encode and starts a new one, debounced so that a dragged slider produces one encode after the drag settles, not one per step. Superseding is defined in R-X28: the in-flight result is discarded on arrival rather than interrupted.
- R-P4 While an encode is in flight, the comparison figures are hidden rather than showing stale values.

**Comparison control (top centre).**

```
500 KB   [ Original | Compressed ]   250 KB   50% down
```

- The pill is a single toggle. Clicking anywhere on it flips between Original and Compressed, so the user can flick back and forth without aiming at a specific half.
- Left value: original file size. Right value: actual selected output size after R-X24. Trailing value: percentage change.
- R-P5 When the output is larger than the input, the trailing figure shows an increase, with an up glyph and non-tint colour. It is never suppressed or shown as zero.

**Transform line (below).** Mono, one line, describing this image only:

```
abc.jpeg  1000×1000  ->  abc.webp  500×500
```

Reflects the current format, rotation, crop and dimension settings for this image. Under the "Don't change" format setting, the output extension matches the input.

**Toolbar.** Back to images, **Add more images**, a `3 / 6` stepper for moving through the batch, and **Edit** or **Edit changes**.

**Requirements**

- R-P6 The frame preserves the image's true aspect ratio at all viewport sizes. The stage is measured and the frame given contain-fit dimensions. The image is never stretched.
- R-P7 The stepper wraps at both ends and preserves the selected comparison tab. Stepping releases the outgoing image's data and encodes the incoming one.
- R-P8 Animated sources play in the frame on both tabs, so the user can see that animation survived.

**Zoom/pan inspector.** The frame supports direct-manipulation zoom and pan: wheel or pinch to zoom
about the pointer, drag to pan. There is no slider — a small toolbar beside the comparison pill
offers **Fit** and **Actual size**, plus a live zoom percent readout. "Actual size" means true
1:1 pixels of whichever tab is active; "Fit" is the same contain-fit rest state R-P6 describes.

- R-P9 Flipping between Original and Compressed keeps the same patch of the image in view and
  preserves true **pixel density**, not apparent on-screen size: a Compressed output viewed at its
  own 100% shows Original at the fraction of its own pixels that reproduces the same screen
  footprint (a 500×500 output of a 1000×1000 source is shown at 50% on Original, not at the same
  size as before). This holds from the very first, unzoomed view, not only once the user has
  manually zoomed in. Matching the density this way may require zooming past a tab's own usual
  ceiling; when it does, the ceiling yields rather than clamping the match away.
- R-P10 Any settings or edit change that causes the Compressed output to regenerate (quality,
  size target, dimension rule, format, rotation or crop) brings the Compressed tab to the front at
  its own actual size, centred — the user is never left looking at an Original that does not match
  a change they just made. This does not apply to R-P7's stepper, which still preserves whichever
  tab was selected when stepping to a different image.

### 3.4 Edit mode

Entered from Preview. Edits are per-image, always applied to the image currently in the frame. This version offers rotation and crop.

**Controls**

- Toolbar: output `W` and `H` px inputs (editable, typing a value resizes the crop rectangle), **Rotate left**, **Rotate right**, **Remove edit** (only when an edit already exists), **Cancel**, **Apply**.
- Ratio row above the frame: `Free · 1:1 · 4:5 · 16:9 · 9:16`. Selecting a ratio locks the crop rectangle's proportions for dragging, resizing and typed dimensions.
- Crop rectangle over the image with four corner handles, draggable to reposition and resizable from any corner. Area outside the rectangle is darkened to show what will be discarded. A live `W×H` badge sits inside the rectangle.
- Zoom slider below the frame with a numeric readout.
- Background row, conditional (see below).

**Rotation**

- R-C1 Rotation is in 90 degree steps only. Free-angle rotation is out of scope for this version.
- R-C2 Rotation is applied to the image before the crop rectangle is interpreted. The user always draws the rectangle on the image as displayed.
- R-C3 Rotating by 90 or 270 degrees swaps the frame's width and height. The displayed crop rectangle, any locked ratio and the typed `W` and `H` values are re-fitted so the chips and the on-screen rectangle never disagree.
- R-C4 Rotation is part of the image's stored edit. Pressing **Apply** after rotating stores an edit for that image even if the crop rectangle was not moved, in which case the rectangle covers the whole rotated image.
- R-C5 **Remove edit** clears rotation and crop together and returns to Preview.
- R-C6 Rotation is not offered for animated sources, for the same reason as R-C16.

**Two independent scales.** These must not be conflated.

- *Display scale* is chosen by the app to fit the image, and where necessary the whole crop rectangle, inside the available stage area. It has no effect on output.
- *Zoom* is chosen by the user and changes how much of the source image falls inside the crop rectangle, and therefore changes the output dimensions.

**Requirements**

- R-C7 Zooming in yields smaller output dimensions from the same rectangle. Zooming out yields larger ones. Exact arithmetic is specified in the Technical Design.
- R-C8 When the proposed crop is larger than the staging area can show at 1:1, the app reduces the display scale. The on-screen rectangle shrinks; the typed output `W` and `H` continue to report true output pixels.
- R-C9 Output dimensions include any padded spill area. They are not clamped to the original image size. Producing an output larger than the input is a legitimate result of zooming out, and the background fill exists to serve it.
- R-C10 **Cancel** restores rotation, the crop rectangle, ratio, zoom and background to their values on entering Edit mode, and returns to Preview.
- R-C11 A locked ratio is re-fitted to the new image's dimensions when the user steps to another image.
- R-C12 The crop rectangle cannot leave the frame, and has a minimum size in output pixels.

**Background fill.** The background row appears only when the crop rectangle extends beyond the image edges, which can happen when zooming out past the fit point. That spill area contains no source pixels and must be filled.

- Swatches: Black, White, Transparent.
- A colour picker for anything else. There are no numeric R, G, B or A fields; four numeric inputs are expert controls in a tool built for people who want a smaller photo (P3).
- The frame renders the chosen colour over a checkerboard so partial alpha is legible.

- R-C13 When the effective output format supports alpha (PNG, WebP, AVIF, GIF, or "Don't change" resolving to one of these), the default fill is fully transparent and the Transparent swatch is available.
- R-C14 When the effective output format does not support alpha (JPEG, or "Don't change" resolving to JPEG), the Transparent swatch is hidden, the fill renders and exports opaque, and the hint reads "JPEG has no transparency, pick a fill colour".
- R-C17 Where transparency will be flattened, the Preview transform line says so and the report records it (P1). No background control is offered outside Edit mode; white is used. There is no way to convert transparency into an alpha-free format without choosing a colour, so the operation is not avoidable, only disclosed.
- R-C15 Switching format to JPEG does not destroy the stored alpha value. It is preserved in state, rendered and exported as opaque while JPEG is selected, and restored if the user switches back to an alpha-capable format.
- R-C16 Editing is disabled for animated sources in this version. The Edit action is not offered for an image carrying the `ANIMATED` badge, and the reason is stated inline.

---

## 4. Side panel settings

All settings in this panel are batch-wide. The only per-image settings are rotation and crop.

### 4.1 Quality

Target selector, segmented, two options.

**Quality**

- Slider, 10 to 100, with a large mono numeric readout.
- Shortcut chips: `LOW 40`, `MED 70`, `HIGH 90`. Chips set the slider value; the slider remains freely adjustable.
- R-Q1 The quality value has different meaning per format. The panel does not expose this difference. The mapping is defined in §7.

**Size**

- Numeric text box plus a `KB` and `MB` unit toggle.
- The encoder targets that file size per image, not for the batch total.
- R-Q2 If an image is already smaller than the size target, it is not re-encoded up to the target. Non-PNG files are passed through unchanged. A PNG or animated PNG is still run through the lossless PNG optimiser, and the smaller of that result and the original is kept. The same rule applies when "Don't change" resolves to PNG. The tool never increases file size to meet a target.
- R-Q3 A size target is a hard per-image ceiling: every downloadable or shareable size-targeted output is no larger than the requested bytes. If the ceiling cannot be reached at the requested format and dimensions, the pipeline returns a typed `size-target-unreachable` outcome containing the target, effective format, requested output dimensions and smallest achieved size. Preview replaces the image frame with the warning rather than displaying the oversized attempt; Processing skips the image, and no oversized bytes enter the UI, a direct download, a ZIP or a share payload. This constraint outcome is not an encode failure and is not a success caveat.
- For exactly one still image, Preview shows the R-Q3 warning immediately and then checks verified recovery alternatives in order. A still PNG source whose effective output is PNG is first tested as JPEG and offered only if it fits; if real transparency was flattened, the action names the fill color (opaque white outside Edit by default). The current format is then searched at smaller dimensions and the largest measured fitting dimensions that fit at quality 30 or better, followed by the highest fitting quality at those dimensions, are offered. Once that fit exists, Preview also offers the next lower standard controlled edge from the ladder `[240, 360, 480, 640, 720, 800, 1024, 1080, 1280, 1440, 1600, 1920, 2048, 2160, 2560, 2880, 3200, 3840, 4096]` without another recovery probe; its action states no byte size, and the ordinary hard-ceiling Preview encode verifies it after selection. No alternative is applied without a click.
- Multi-image batches and animations receive no automatic recovery search. The warning explains that the size setting applies to the whole batch, or that repeated multi-frame searches are too expensive. If no single-image alternative is verified, Preview says so without disabled or speculative actions.
- Leaving Preview cancels queued recovery jobs and prevents a completed step from dispatching the next one. A codec call already executing in WASM may finish, but its result is discarded; returning to Preview resumes the same worker pool without accumulating an unbounded recovery queue.
- R-Q4 Size targeting requires repeated encodes. Where the cost is prohibitive for a format, the Size option is disabled with a stated reason when that format is selected. Which formats those are is determined in the Technical Design.

### 4.2 Dimension

Exactly one option may be active. Rendered as an accordion of radio rows; the selected row expands to reveal its value field and shortcut chips, and all other children stay collapsed.

| Option | Value | Shortcut chips |
| --- | --- | --- |
| Original size | none | none |
| Fit within long edge | one px value | HD 1280, FHD 1920, 2K 2560, 4K 3840, IG 1080 |
| Fixed width | one px value | IG 1080, WEB 1200, MAIL 800, PRINT 3000 |
| Fixed height | one px value | IG 1350, HD 720, FHD 1080 |

- Shortcut chips only write a number into the field. The field is always editable, so no "Custom" entry is needed.
- "Fit within long edge" only downscales. Images already inside the limit are untouched.
- R-N1 Fixed width and Fixed height preserve aspect ratio; the other dimension is derived.
- R-N2 Fixed width and Fixed height upscale when the source is smaller than the target. This is the only path by which the tool enlarges an image from a batch setting, and it is what the user asked for.
- Rotation and crop are not listed here. They live in Edit mode because they are per-image, not batch rules.

**Edit interaction with Dimension**

- R-D1 An image with a crop applied takes its output size from the crop. Batch dimension settings are ignored for that image.
- R-D2 With more than one image and at least one cropped, a note appears in the Dimension section: "Crop applied to N images. Their crop overrides the setting below; the rest follow it."
- R-D3 With exactly one image, and it is cropped, the Dimension rows are disabled and the note explains why.
- R-D4 Rotation alone does not override the dimension rule. A rotated but uncropped image follows the batch setting, applied to its rotated dimensions.

### 4.3 Format

Dropdown, in this order:

| Option | Notes |
| --- | --- |
| **Don't change** | Default. Each image keeps its input format. |
| JPEG | No alpha, no animation. |
| PNG | Still or animated. A still PNG is quantized below a slider value of 85, within the bound in R-Q11; an animated one is always lossless, R-Q15. |
| WebP | Still or animated. |
| AVIF | Still only. |
| GIF | For graphics and animation. Produces worse results than JPEG for photographs, stated inline in the dropdown. |

APNG is not a separate entry. An animated source written as PNG produces an animated PNG with a `.png` extension, which is what the format is. Exposing "APNG" as a choice would make the user decide something they have no reason to understand (P3), and flattening their animation because they picked PNG would lose data silently (P1).

**Requirements**

- R-F1 "Don't change" is the default and preserves each image's input format independently.
- R-F2 When the input format cannot be written by the encoder (for example HEIC, TIFF, BMP, JPEG XL), "Don't change" resolves to JPEG for that image, and the transform line shows the real output extension.
- R-F3 Format selection drives: the output extension in the transform line, alpha availability in the Edit background control, and the encoder path.
- R-F4 With "Don't change" selected, the primary action meta line reads "Original formats" rather than naming one format.

**Animated sources**

- R-F5 Animated output is supported for GIF, WebP and PNG. An animated source keeps its animation when the selected format is one of these, or when the format is "Don't change" and the source is one of these.
- R-F6 When a still-only format (JPEG, AVIF) is selected for a batch containing an animated source, that image is written as animated WebP rather than flattened to one frame. The tile, the Preview transform line and the report all state the substitution (P1).
- R-F7 Animated AVIF output is not supported. AVIF remains available as a still format, where it is the main reason people want it.
- R-F8 Animated AVIF input is rejected at selection time with a message naming the reason. It is not silently flattened (P1) and not partially supported (P2).

### 4.4 Primary action

- Label: **Compress**, with a count for batches, for example `Compress (6)`.
- Meta line beneath it states facts only: `6 images · Original formats · ZIP`, or `WEBP · 1920×1440` for a single image.
- R-A1 The button is visible at all times. On mobile it sits in a fixed bottom bar outside the drawer, so opening or hiding Options never hides it. On desktop it is pinned to the panel footer.
- R-A2 No aggregate output size is claimed before compression runs.
- R-A3 The button is disabled when the batch is empty.
- R-A4 Pressing it enters Processing mode (§6). It does not deliver anything directly. Download and any available Share action are explicit in the Processing view.
- A known single-image R-Q3 miss does not disable Compress. Running it produces the same authoritative skip and a zero-output completion, which explains why no delivery action exists.

### 4.5 Architectural note on editing

Editing will expand beyond rotation and crop. The per-image state must therefore be modelled as an ordered, extensible edit record rather than two fixed fields, so that future operations can be added without restructuring the pipeline, the preview invalidation logic or the thumbnail regeneration path. The Technical Design specifies the shape of that record. The user-facing mode is named Edit for the same reason, even though it currently offers two operations.

---

## 5. Input handling

### 5.1 Accepted formats

Based on the verified capabilities of the chosen toolchain (§13).

| Format | Decode | Encode |
| --- | --- | --- |
| JPEG | Yes | Yes |
| PNG | Yes | Yes |
| PNG, animated (APNG) | Yes | Yes, written as `.png` |
| WebP, still and animated | Yes | Yes, still and animated |
| AVIF, still | Yes | Yes |
| AVIF, animated | Rejected, R-F8 | No |
| GIF, still and animated | Yes | Yes, still and animated |
| BMP, TIFF, JPEG XL, JPEG 2000 | Yes | No |
| HEIC / HEIF | Yes | No |

**Three classes of input.** The distinction drives what appears in the report (§6.6).

| Class | Examples | Treatment |
| --- | --- | --- |
| Supported image | the table above | Processed |
| Image we cannot handle | PSD, camera raw, SVG, ICO | Rejected and **listed** in the report |
| Not an image | txt, docx, xlsx, pdf, zip, video | Skipped silently, never listed |

- R-I1 The accepted formats line in the empty state reflects what the running browser and build can actually handle.
- R-I2 Files in the second class are rejected at selection time with the file name and the reason, and are recorded for the report.
- R-I3 Rejection of some files does not prevent the remaining files in the same selection from being added.
- R-I4 An APNG file must be detected as animated rather than read as a single-frame PNG. Detection is by the presence of the `acTL` chunk, not by file extension.
- R-I23 Classification is by content where cheaply possible, not by extension alone. A JPEG named `.png` is processed as a JPEG.

### 5.2 HEIC

HEIC decoding is confirmed working in the build on every browser. It is ordinary input, with no capability check and no browser-specific behaviour.

- R-I5 HEIC files are accepted and decoded like any other input.
- R-I8 HEIC is never an output format. The build contains no HEVC encoder. Under "Don't change" it resolves to JPEG per R-F2.
- R-I34 Live Photo and portrait-mode HEIC files carry auxiliary and depth images alongside the primary image. Only the primary image is processed. Where such a file is detected, the report records that auxiliary images were not carried through (P1).

### 5.3 Folder input

A folder can be selected through a picker or dropped onto the stage. The folder is scanned recursively, supported images are added, and the output ZIP mirrors the source structure exactly.

- R-I24 Folder input is offered by a **Select folder** button and by dropping a folder onto the stage.
- R-I25 The tree is traversed recursively. Each accepted file retains its path relative to the selected folder root.
- R-I26 The ZIP reproduces that structure. `holiday/day1/beach.jpg` in becomes `holiday/day1/beach.webp` out.
- R-I27 Hidden and system files are skipped silently and never appear in the report. This includes dot-prefixed names, `Thumbs.db` and `desktop.ini`.
- R-I28 Empty directories are not represented in the output.
- R-I29 A selected folder containing no supported images is reported plainly at selection time rather than producing an empty batch.
- R-I30 Traversal depth and total file count are capped. Breaching either is reported at selection time with the actual figure and the cap, before any file is added.
- R-I31 Where folder selection is unavailable on the platform, the control is hidden rather than shown and failing. File selection remains available.
- R-I32 Symbolic links are not followed.

**Consequence for naming.** Collision handling (R-X22) is scoped per directory. `a/photo.jpg` and `b/photo.jpg` do not collide and are never renamed.

That directory-scoped rule applies to the ZIP. A share payload has no directory structure, so R-X53 defines a separate, global collision rule for the flattened shared file names.

**Consequence for the Gallery.** Filename alone stops identifying an image once the batch spans a tree, so the list view shows relative paths and becomes the default for folder input (R-G8, R-G11).

### 5.4 Orientation

- R-I9 EXIF orientation is applied to the pixels at decode, before any rotation, crop or resize. The output is written upright with no orientation tag.
- R-I10 The orientation tag is not copied to the output. Copying it while the rotation has already been applied would cause conforming viewers to rotate a second time, and PNG, GIF and WebP have no orientation tag that viewers honour reliably.
- R-I11 User rotation (R-C1) composes on top of the EXIF-corrected image, not on the raw stored pixels.

### 5.5 Colour management

- R-I12 An embedded ICC colour profile is preserved in the output when the output format can carry one (JPEG, PNG, APNG, WebP, AVIF, GIF).
- R-I13 (retired, kept as a numbered placeholder so existing references to it stay meaningful) Originally: "when the output format cannot carry a profile (GIF), the image is converted to sRGB using the embedded profile before encoding." Measurement (T28) found GIF is not that format in this build: ImageMagick's GIF coder writes and reads back a profile through a de facto application extension, and it survives gifsicle byte for byte (D3). GIF is covered by R-I12 instead, on both encode and decode (CORE-005); no currently supported output format triggers a conversion under this clause.
- R-I14 When no profile is embedded, the image is treated as sRGB and no profile is added.
- R-I15 Pixel values are not converted between colour spaces. (R-I13 no longer requires this of any currently supported format — see its note. CICP-signalled colour going to a format that cannot carry the signal is a separate, open gap; see R-I35 and CORE-003.) A Display P3 photo stays in Display P3.
- R-I16 The Preview frame renders the encoded output directly rather than drawing it through a canvas, so the browser applies the embedded profile and the preview matches the downloaded file.
- R-I35 Colour is not always carried by an ICC profile. HEIC and AVIF commonly signal it as CICP values (primaries, transfer function, matrix coefficients) with no profile present. Such signalling is read and honoured, and carried to the output where the format can express it, or resolved into the pixels where it cannot. An image whose colour is described only by CICP must not be treated as untagged sRGB.

### 5.6 Metadata

- R-I17 EXIF, IPTC and XMP metadata are stripped from output by default, including GPS location. This reduces file size and avoids publishing location data the user may not know is present.
- R-I18 The ICC colour profile is not metadata for the purpose of R-I17 and is governed by §5.5.

### 5.7 Limits

Selection limits are enforced before processing. Delivery limits are enforced at the earliest point at which the completed output facts they depend on exist.

| Limit | Value | Behaviour on breach |
| --- | --- | --- |
| Files per batch | to be set in Technical Design | Excess files rejected, count stated |
| Single file size | to be set in Technical Design | File rejected with its size and the cap |
| Single image pixels | to be set in Technical Design | File rejected with its dimensions and the cap |
| Animated frame count | to be set in Technical Design | File rejected |
| Animated total pixels | to be set in Technical Design | File rejected |
| Folder traversal depth | to be set in Technical Design | Selection rejected, depth stated |
| Available storage quota | from `navigator.storage.estimate()` | Reject if Download cannot fit; otherwise disable only Share when its extra copies cannot fit, §6.7 |
| Files eligible for Share | 10 accepted images at run start | Share output is not retained or offered; Download is unchanged |
| Total Share output bytes | to be set by T39-A and confirmed by T50 | Share is omitted after the run; Download remains available |

- R-I19 Limits are lower on memory-constrained browsers where this can be detected. The tool prefers rejecting a file up front to having the tab killed mid-batch.
- R-I20 Every limit message names the actual value and the cap, so the user can see how far over they are.
- R-I21 Rejection messages caused by a hard browser or memory limit mention that the desktop application has no such limit.
- R-I22 Animated sources are subject to a frame budget as well as a pixel budget, because frame count multiplies decoded memory.
- R-I33 Storage quota differs sharply by platform and is checked before a run rather than assumed. See §6.7.

## 6. Processing view

A full stage mode, entered by the primary action. It owns the screen: the settings panel is replaced by run status.

### 6.1 During the run

- R-X1 The run covers every image in the batch, in grid order.
- R-X2 The run re-encodes every image from its source file, including any image previewed earlier. Nothing is reused, per §9.
- R-X3 The view shows a counter in mono, `2 / 10 processed`, as the primary status.
- R-X4 A donut chart shows the proportion of succeeded, skipped, failed and pending. It is a progress indicator and decoration. Every number it encodes is also present as text beside it. No information exists only inside the donut.
- R-X5 A running total of size reduction is shown, updated as images complete, expressed as bytes saved and as a percentage of the input processed so far. These are measured figures, not projections.
- R-X6 The current file name is not required. Per-image identity matters only for failures.
- R-X7 A **Cancel** action is available throughout.
- R-X8 Images are processed with bounded concurrency, not all at once, so peak memory stays within the budget in §9.
- R-X9 Files rejected at selection time are not represented in the counter. They never entered the batch. They do appear in the report (§6.6).

### 6.2 Cancellation semantics

A WASM encode cannot be interrupted once it has started. Cancellation therefore has a defined meaning rather than an assumed one.

- R-X26 **Cancel** stops the run after the image currently in flight completes. The wait is bounded by one image, not by the remaining batch.
- R-X27 The button reports this honestly: it reads **Cancel** before being pressed and **Stopping** afterwards, and remains visible until the run halts.
- R-X28 A settings change during Preview does not interrupt the encode in flight. The result is discarded on arrival and a new encode starts. Debouncing (R-P3) keeps the number of discarded encodes small.
- R-X29 Where a single job exceeds a duration threshold and the user is waiting, the worker may be terminated and recreated. This costs a full codec re-initialisation and is an escape hatch, not the normal path.

### 6.3 Failures and skips within a run

- R-X10 A failure on one image does not abort the run. The image is counted as failed and the run continues.
- R-X11 Failed images are listed by file name with their reasons, in the view, as text.
- R-X12 Failed images are excluded from the output. The output is built from the successes.
- R-X13 If every image failed, no output is produced and the failure list is the whole result.
- An accepted image with a `size-target-unreachable` result is counted and listed as **Skipped**, separately from technical failures. Its reason includes the target, smallest achieved size, effective format and requested dimensions. It contributes no output bytes or savings and is absent from output assembly.
- Starting a run clears previous `FAILED` and `SKIPPED` image states. Its completed statuses persist when returning to Gallery until another run starts; settings changes alone do not rewrite the prior run result. A Preview-time miss is local and does not set `SKIPPED`.
- If there are no successes, no output, Download or Share action is produced. Processing lists all skipped and failed images with their reasons; this includes a known single-image miss when the user presses Compress.

### 6.4 On completion

- R-X14 The view shows final succeeded/skipped/failed counts, the total size reduction from successes, the skipped and failure lists if any, and **Back to images**. **Download** is also shown when at least one output succeeded. **Share** appears beside it only under R-X47 and R-X48.
- R-X15 **Download** and **Share** are explicit. The run never delivers automatically, because an automatic download can trigger a browser warning, Web Share requires a fresh user activation, and the user needs a clear moment at which the result leaves the app.
- R-X17 **Back to images** returns to Gallery with the batch, settings and edits intact, so the user can adjust and run again.

- R-X47 A run is eligible to retain share output only when it starts with between one and ten accepted images and the platform passes the preliminary file-sharing capability probe. Eligibility is fixed at run start: a run starting with eleven images remains Download-only even if failures or skips leave ten or fewer successes.
- R-X48 At completion, **Share** is shown only when there is at least one success, the successful outputs do not exceed the measured total-byte safety limit, and `navigator.canShare({ files })` accepts the exact completed `File[]`. Failure of any of these checks removes the individual share copies and leaves **Download** unchanged.

### 6.5 What gets delivered

- R-X16 A single successful image downloads as that image, with its output extension. No ZIP, no report. Requiring the user to unzip a single file is a cost with no benefit, and the screen already showed them what happened.
- R-X30 Two or more successful images download as a single ZIP containing the images and one `image_compression_report.txt`.
- R-X31 The report lives inside the ZIP, not alongside it, so it travels with the images.
- R-X49 Share passes every successful output as an individual image in one `navigator.share({ files })` call, in grid order. Failed and skipped images, the ZIP and `image_compression_report.txt` are never included. One success shares the same direct output that Download uses.
- R-X50 Download and Share are alternative delivery actions. Resolution of `navigator.share()` means the browser has handed the payload to the chosen target or operating system and counts as successful delivery; the app cannot know whether the target later used it. User cancellation is not an error. Cancellation or any handoff failure retains the results and both available actions; a non-cancellation failure is stated inline and Share can be retried.
- R-X54 After the first successful delivery, the completed Processing view remains open with its summary and skipped/failure lists. Download and Share are replaced by a checked, non-interactive completion state that identifies the outcome as **Download started** or **Shared**; **Back to images** becomes the remaining primary action. The app returns to Gallery only when the user selects that action or uses browser Back, and does not show the undelivered-results confirmation because delivery is complete.

### 6.6 The report

`image_compression_report.txt` is written for every multi-image run, whether or not anything went wrong. With folder input the user otherwise has no way to confirm that every file was found.

**Format.** YAML, with a `.txt` extension so that it opens in any text editor without a program association. It must read naturally to a person and parse cleanly to a program.

- R-X32 Sizes are human-readable and rounded to two decimal places, using 1024 bytes to the kilobyte: `12.33 MB`, not `12.332332 MB` and not `12931283`.
- R-X33 The run summary additionally carries exact byte counts for total input, total output and total saved, so the arithmetic can be checked. Per-file entries do not repeat them.
- R-X34 The report lists: the run summary, settings used, files that failed with the reason, files skipped because the format is an image we cannot handle or because R-Q3's size ceiling was unreachable, and every success that carried a caveat. An R-Q3 skipped reason is structured and contains target bytes, best achieved bytes, effective format and requested output dimensions.
- R-X46 A caveat is anything the user did not explicitly ask for and would not expect. The set is fixed, not open to judgement at implementation time:

| Caveat | Recorded when |
| --- | --- |
| Transparency flattened | Source had transparent pixels, output format has no alpha. States the fill colour used. |
| Animation substituted | Animated source written as WebP because the chosen format cannot animate. |
| Metadata removed | EXIF, IPTC or XMP was present and has been stripped. States whether GPS data was among it. |
| Original kept | The byte-for-byte original won under R-Q2 or R-X24. States whether it already met the size target or the re-encode was not smaller. |
| Output larger than input | R-X45 applied. States both sizes. |
| PNG quantized | PNG output below a slider value of 85. States that PNG was not written losslessly. |
| Colour converted | Colour information could not be carried by the output format and pixels were converted to sRGB. |
| Auxiliary images dropped | A Live Photo or depth-carrying HEIC was processed to its primary image only. |
- R-X35 Ordinary successes are counted in the summary but not listed individually. A four hundred line list of files that worked is noise.
- R-X36 Files that are not images are never mentioned, in any section. That a spreadsheet was not compressed needs no explanation.
- R-X37 Relative paths are used throughout when the batch came from a folder, so an entry identifies one file unambiguously.

### 6.7 Output assembly and storage

The archive is streamed to browser-owned storage as the run proceeds, rather than accumulated in memory and assembled at the end. A share-eligible run additionally retains its individual outputs, but large and unsupported runs remain on the archive-only path.

- R-X38 Each encoded image in a run that can produce multi-image delivery is appended to a ZIP being written into the Origin Private File System as the run progresses. Memory holds one entry at a time, not the archive. The first success is also the temporary direct-output candidate required if every other image fails or is skipped; it is released once a second success makes ZIP delivery certain unless R-X51 still needs it for Share.
- R-X39 Compression therefore begins when the user presses the primary action and does not wait for the Download press. Download moves the finished archive out of storage.
- R-X40 Before a run, the app checks available quota against the predicted stored artifacts. If the ordinary Download artifact will not fit, it rejects the batch up front and names both figures. If Download will fit but the additional Share copies will not, the run proceeds as Download-only under R-X52.
- R-X41 Where origin-private storage is unavailable, most notably in private browsing windows, the app falls back to in-memory assembly with a reduced batch cap, and says so when the cap is what blocks a batch.
- R-X42 The stored archive and every individual output copy are deleted after the first successful Download or Share, after cancellation, after the user leaves the Processing view, after a storage failure, and on application start, so abandoned runs do not accumulate.
- R-X51 For a run eligible under R-X47, each successful output is both appended to the normal ZIP path and written as a separate temporary file as it arrives. An exactly one-image run writes only its direct artifact because it can never need a ZIP. The extra write is a tee of the one encoded result, not a second encode, and it does not retain the batch in memory. A single successful output is one shared direct artifact rather than two copies of the same image.
- R-X52 The quota preflight for a share-eligible run includes the archive, every predicted individual output copy and filesystem overhead. The private-browsing fallback applies its measured in-memory cap to the combined artifacts. When the archive fits but the combined artifacts do not, the run becomes Download-only before processing; Share storage limits never weaken the ordinary Download path.

### 6.8 Leaving with undelivered results

- R-X18 Navigating away from a finished run before either delivery action succeeds raises a confirmation. It states that the results will be discarded and offers exactly three actions: **Download and leave**, **Leave without downloading**, and **Stay**. Share is not added to this dialog; Download remains the universal recovery action.
- R-X19 **Cancel** during a run does not raise this confirmation. There are no complete results to lose.
- R-X20 Cancelling stops after the image in flight, discards all partial results, and returns to Gallery with settings and edits intact.

### 6.9 Output naming

- R-X21 Output file names keep the input base name and take the output extension.
- R-X43 When the resolved output format equals the image's detected source format — whether because the setting is "Don't change" or because the user explicitly picked that same format — the original extension is reproduced byte for byte, including its case and its spelling. `photo.JPG` stays `photo.JPG`. `image.jpeg` does not become `image.jpg`, even if the user explicitly selects JPEG. Normalising an extension that names no real conversion is an unrequested change (P1).
- R-X44 When the resolved output format differs from the source format — a genuine conversion, a "Don't change" fallback (R-F2), or an animated substitution (R-F6) — the canonical extension for the resolved format is used: `.jpg`, `.png`, `.webp`, `.avif`, `.gif`.
- R-X22 When two outputs would collide within the same directory of the ZIP, later entries get a numeric suffix: `photo.jpg`, `photo-1.jpg`, `photo-2.jpg`. Collisions are possible even without duplicate input names, because format conversion can map two different inputs onto one output name. Files in different directories never collide.
- R-X53 Shared files have no directory tree. Their output basenames are therefore flattened into one namespace and collisions are resolved globally in grid order: `photo.jpg`, `photo-1.jpg`, `photo-2.jpg`. ZIP naming remains directory-scoped under R-X22.
- R-X23 The ZIP file name includes a timestamp so repeated runs do not overwrite each other in the downloads folder.
- R-X24 When the best encoded output of an image is not smaller than its input, the effective format is unchanged, no rotation or crop applies, and the resolved dimension rule leaves the decoded upright dimensions unchanged, the source-side candidate is written instead. This includes no-op **Fit within**, fixed-width and fixed-height rules, not only **Original size**. An exact byte-size tie keeps the source candidate. For PNG/APNG, the source candidate first receives the same lossless PNG optimisation as every other PNG output and competes directly with the encoded candidate; it is reported as `Original kept` only when the byte-for-byte source wins. Preview renders and measures the selected bytes, and a run records the outcome (P5).
- R-X45 The substitution in R-X24 does not happen when the user asked for a change that the original does not satisfy. A request that actually resizes the image, any rotation or crop, or a format conversion is honoured even if its output is larger in bytes. A larger same-format transformed output is recorded in the report as a warning; a format conversion needs no warning because the user explicitly requested it.
- R-X25 Results are retained only until the first successful Download or Share, or until the user leaves the Processing view. They are not carried back to Gallery.

## 7. Encoder behaviour

Verified against ImageMagick 7.1.2-30 Q8 wasm32 (`@imagemagick/magick-wasm` 0.0.43). Library selection is confirmed in the Technical Design; this section defines user-visible behaviour only.

### 7.1 Quality mapping

- R-Q5 Quality above 95 selects lossless encoding wherever the format supports it. PNG reaches that point earlier, at 85, for the reason in R-Q12.

| Format | Quality 96 to 100 | Quality 10 to 95 |
| --- | --- | --- |
| JPEG | Highest quality. No lossless mode exists for JPEG. | Encoder quality parameter |
| PNG, still | Lossless from a slider value of 85 upward, R-Q12 | Quantization via libimagequant, rescaled per R-Q11 |
| PNG, animated | Lossless | Lossless. See R-Q15 |
| WebP, still or animated | Lossless mode | Lossy, plus the check in R-Q6 |
| AVIF | Lossless mode | Encoder quality parameter |
| GIF | Palette preserved, no lossy pass | Lossy pass via gifsicle |

- R-Q6 For WebP below quality 96, the app also attempts a lossless encode and keeps whichever result is smaller. This wins on screenshots, logos and flat graphics and loses on photographs, so the Technical Design may gate the second attempt behind a cheap content check, provided the smaller output is still the one kept.
- R-Q7 Lossless AVIF frequently produces output larger than the input. R-X24 handles that case; the behaviour is not suppressed.
- R-Q11 Still PNG never uses the raw slider value. People pick PNG expecting losslessness, so quantizing to a slider value of 10 would produce banding they did not ask for and would not understand (P1, P3). The slider is remapped linearly onto a quantization quality with a floor of 70. Animated PNG does not quantize at all, R-Q15:

  `mapped = 70 + (q - 10) x 30 / 90`

  So 10 maps to 70, 40 to 80, 70 to 90, and 100 to 100. The lowest quantization quality any user can reach for PNG is 70.

- R-Q12 PNG becomes lossless at a slider value of 85, where the mapped value reaches 95. This is earlier than the 96 threshold that applies to other formats, and it is a consequence of the rescale rather than a special case. It errs in the safe direction: PNG is a lossless format by reputation, and reaching losslessness sooner is the conservative failure.
- R-Q13 The 70 floor is a starting value, not a measured one, and is subject to verification against real images.
- R-Q14 For still PNG below the lossless point, the app compares the quantized result against a lossless encode and keeps whichever is smaller. An image that already has few colours gains nothing from quantization and can lose a little. This mirrors R-Q6 for WebP and costs one extra encode of a format that is cheap to encode.
- R-Q15 Animated PNG is always written losslessly, at every slider value, and R-Q11, R-Q12 and R-Q14 do not apply to it. R-Q11's floor is only a guarantee because the still path's quantizer refuses to produce anything it cannot reach; the animated PNG optimiser wraps the same library but exposes no such refusal, so a quantized animation would be quantized to an unknown quality at every setting, with no way to detect that the floor had been missed. Writing losslessly keeps R-Q11's intent — no banding the user did not ask for — by removing the only path that could violate it (P1). Its structural APNG optimisation is followed by lossless oxipng refiltering and recompression, with the smaller candidate retained. Measured in T29 and the later PNG pass; the slider still governs animated WebP, which is where an animated source goes when the user asks for a smaller file.

### 7.2 Animated output

- R-Q8 Animated GIF compression is performed by gifsicle rather than by the general image pipeline, because its output is substantially smaller.
- R-Q9 Frame delays, loop count and disposal behaviour are preserved through every animated path.
- R-Q10 Frame count is never reduced. The tool does not drop frames to hit a size target.

---

## 8. Privacy

The tool processes everything locally. This is the main differentiator against server-side competitors and it is invisible unless stated.

- R-V1 A short persistent line states that image processing happens on the device and that results leave only when the user explicitly shares them. It appears in the empty state and remains reachable once images are loaded.
- R-V2 The claim must remain literally true. The app sends no image bytes, file names, dimensions or sizes over the network, including to analytics. An explicit Share action is a user-directed handoff to the operating system and chosen target under R-V5, not an app upload.
- R-V3 If analytics are added, they are limited to anonymous aggregate events, and the privacy line is revised to say exactly what is collected.
- R-V4 The interface carries a visible link to the application's own source code, and a credits page listing every bundled component with its licence and a link to its source. Both are requirements of the project's licence, not optional courtesies.
- R-V5 Share transfers only the completed output files named in R-X49, only after the user presses **Share** and chooses a system target. The app cannot inspect which targets are installed or which one the user selects, and it does not send a parallel copy anywhere.

---

## 9. Memory policy

Peak memory, not throughput, is the limiting factor. This section is a functional requirement because its effects are user-visible.

Two kinds of data are distinguished:

- *Decoded pixels*, which cost width by height by 4 bytes per frame. A 12 megapixel photo is roughly 48 MB decoded. These dominate memory. The build is Q8, so this is the true cost rather than double it.
- *Encoded bytes*, the compressed file, typically a few hundred KB.

**Requirements**

- R-B1 No encoded results are retained beyond the moment they are used. Previews are discarded on leaving Preview or on any settings change. Run outputs are held only as the OPFS-backed delivery artifacts described in R-X25, R-X38 and R-X51; no reactive store or in-memory collection retains the batch.
- R-B2 Full-resolution decoded pixels are held for the minimum time necessary and released immediately after use. The number of images decoded at full resolution at any one time is bounded and small.
- R-B3 The batch-scoped Gallery cache retains no more than the runtime-configured thumbnail limit of
  bounded, encoded thumbnail Blobs, plus file handles and metadata. It never retains full-resolution
  pixels. The cache may survive a mode change to avoid rereading source files, but generation is forbidden
  outside Gallery by R-G12 and the cache is released when the batch is cleared.
- R-B4 Preview holds a working set for the image on screen only: the decoded source needed to draw the Original tab, and the encoded result needed for the Compressed tab and its size figure. Both are released on leaving Preview, stepping to another image, or any settings change.
- R-B5 Stepping through a batch releases the outgoing image's working set before decoding the incoming one.
- R-B6 Animated sources are the highest-risk input, because decoded cost is frames multiplied by frame size. They are processed in a way that avoids holding every decoded frame simultaneously wherever the format allows it.

The accepted consequence: a compression run repeats work already done for a preview, and stepping backwards through a batch re-encodes. This is deliberate. Time is cheaper than a killed tab.

---

## 10. Errors and edge cases

Every condition below has a defined surface and message. No condition may fail silently or with a generic message.

| Condition | When detected | Surface |
| --- | --- | --- |
| Unsupported file type | Selection | Rejection list, file named |
| HEIC with no available decoder | Selection | Rejection list, message per R-I7 |
| File exceeds size or pixel cap | Selection | Rejection list with actual value and cap |
| Animated file exceeds frame or pixel budget | Selection | Rejection list, values stated |
| Batch exceeds file count | Selection | Rejection list, count stated |
| Corrupt or undecodable file | Decode | Marked failed, reason in the failure list |
| Encode failure | Run or preview | Marked failed; in Preview, an inline error in the frame with a retry |
| Size target unreachable | Run or preview | Preview replaces the image frame with the warning, verified single-still recovery actions and the derived lower standard-size choice; Processing records Skipped and emits no output for that image, per R-Q3 |
| Out of memory | Any | Run halts, partial results discarded, message recommends fewer or smaller images, and mentions the desktop application |
| ZIP assembly failure | Packaging | Error shown, no partial ZIP delivered |
| Download blocked by browser | Download | Message explaining the browser blocked it, with a retry |
| Exact file payload cannot be shared | Completion | Share omitted, individual copies deleted, Download remains available |
| User cancels the system share sheet | Share | No error; results and both available actions remain |
| Share handoff fails | Share | Inline error with retry; results and Download remain available |
| Animated AVIF input | Selection | Rejection list, reason named per R-F8 |
| Selected folder contains no supported images | Selection | Stated plainly, batch not created |
| Folder depth or file count exceeded | Selection | Rejection with actual figure and cap |
| Storage quota insufficient for predicted archive | Before run | Batch rejected, both figures named |
| Storage quota insufficient only for individual Share copies | Before run | Share path disabled for the run; Download proceeds unchanged |
| Origin-private storage unavailable | Startup | Reduced cap applied silently; stated only when a batch is blocked by it |
| Storage write failure mid-run | Run | Run halts, all stored artifacts deleted, message states no partial file was kept |
| Every image in a run failed or was skipped | End of run | No output, Download or Share action; failures and skips listed with reasons |

**Requirements**

- R-E1 Messages name the file and state what to do next. "Something went wrong" is not an acceptable message anywhere in the app.
- R-E2 Selection-time rejections appear as a dismissible list, not one alert per file.
- R-E3 A failed image stays in the grid so the user can see which one it was, and can remove it individually.

---

## 11. Responsive behaviour

| Breakpoint | Panel | Primary action | Options button |
| --- | --- | --- | --- |
| >=900px | Static 344px column, always shown | Panel footer | Hidden |
| <900px | Off-canvas drawer, sticky Hide | Fixed bottom bar | Visible, tint-red |

- R-R1 The layout is space-driven, not device-driven. Whenever the panel fits, it is shown.
- R-R2 Toolbar rows wrap rather than scroll horizontally.
- R-R3 Touch targets in the stage and panel are at least 44px in their primary dimension.
- R-R4 Crop handles are given a touch area larger than their visual size.
- R-R5 The Processing view is single-column on mobile, with the counter and donut above the detail text.

---

## 12. Accessibility

- R-K1 Every control is reachable and operable by keyboard.
- R-K2 Arrow keys step through the batch in Preview. Escape exits Edit without applying. Enter applies an edit.
- R-K3 The mobile drawer traps focus while open, returns focus to the Options button when closed, and closes on Escape.
- R-K4 The crop rectangle can be moved and resized by keyboard, with a modifier for coarse steps.
- R-K5 State changes that are only signalled visually (encode started, encode finished, image failed, run progress, run complete) are announced to assistive technology. Run progress is announced at intervals, not per image.
- R-K6 All controls have accessible names. The comparison toggle announces which view is active.
- R-K7 Animation and transitions respect `prefers-reduced-motion`.
- R-K8 Information is never carried by colour alone. The increase case in R-P5 uses a glyph as well as a colour, and the donut's segments are labelled in text per R-X4.
- R-K9 The confirmation in R-X18 is a focus-trapped dialog with **Stay** as the default focused action.
- R-K10 An accessible name is added only to a control that has no visible text label. A control that already has one is not given a separate accessible-name attribute, because its visible text is already its accessible name, and duplicating it doubles the translation burden for no accessibility gain. An accessible-name string is a key in the same message catalogue as visible text (R-L1) and carries the same context entry (R-L2). It is translated content, not a separate mechanism.
- R-K11 No text, visible or invisible, is added anywhere in the interface or the public site (§15) for a search engine or an AI crawler rather than for a person. A markup comment addressed to a crawler is not read by one, and text hidden from sighted users with no assistive-technology purpose is a dark pattern rather than an SEO technique, whatever benefit is claimed for it.
- R-K12 The confirmation in R-M9 is a focus-trapped dialog with **Stay** as the default focused action, the same pattern as R-K9 for its own, distinct dialog.

---

## 13. Toolchain

Recorded here because it determines several functional limits above. Selection and integration are the Technical Design's subject.

| Component | Role | Verified |
| --- | --- | --- |
| ImageMagick WASM 7.1.2-30 Q8 wasm32 | Decode, rotate, crop, resize, colour transforms, still encode, animated WebP and AVIF | Delegate list and multi-frame write confirmed |
| gifsicle-wasm-browser | GIF compression, lossy pass | Gifsicle 1.92, MIT, GIF in and GIF out only |
| UPNG.js | APNG assembly from frames | APNG chunk structure confirmed |
| apng-optimizer | APNG quantization and deflate optimization | APNG in and APNG out only, not an encoder |
| libimagequant | PNG and APNG quantization | Bundled inside apng-optimizer; standalone use to be confirmed |

Build delegates present: `bzlib freetype heic jng jp2 jpeg jxl lcms lqr openexr png raw tiff webp xml zlib`.

Notes that affect behaviour:

- APNG encoding is not available from ImageMagick in WASM. Its APNG writer shells out to `ffmpeg`, and WASM cannot spawn processes. Every format that ImageMagick implements through an external delegate is unavailable for the same reason.
- ImageMagick's PNG reader returns only the first frame of an APNG unless the file is addressed as an APNG explicitly. R-I4 exists because of this.
- Animated WebP and animated AVIF encoding both work in this build. Animated AVIF measured roughly four and a half times slower than animated WebP on trivial content, and the gap widens on photographic frames.
- The `lcms` delegate is what makes §5.4 implementable.

---

## 14. Design system

### 14.1 Colour

| Token | Value | Use |
| --- | --- | --- |
| Tint | `#cf0000` | Primary action, active states, crop outline, reduction figure |
| Primary | `#ffffff` | Text, icons |
| Background | `#000000` | App background |
| Surface | `#060606` to `#121212` | Panel, controls, tiles |
| Border | `#242424` (group), `#2c2c2c` (control) | Grey separators |
| Muted text | `#7e7e7e` to `#a2a2a2` | Secondary and label text |

Dark theme only. Tint is reserved for action and state. It is never decorative. The donut in R-X4 is the one place where colour distinguishes categories, and it is labelled in text for that reason.

The quiet end of Muted text was raised slightly from its original value (`#6e6e6e`) by T47, a WCAG AA 4.5:1 text-contrast audit actually failed against the panel/tile surface colours it is painted on, not only the pure-black app background. `#7e7e7e` is the smallest nudge along the same hue that clears 4.5:1 in every surface the token is actually used against.

Tint (`#cf0000`) keeps its original value: a handful of places use it as text colour on the black background at sizes/weights below the WCAG AA large-text threshold, where it measures 3.65:1 against the 4.5:1 normal-text minimum (it already clears the 3:1 large-text and non-text-UI-component minimums). Raising it enough to clear 4.5:1 as text would also raise it everywhere it is a button background under white text, landing on a markedly brighter red across the whole interface for one rule at one text size — rejected as visually disruptive for what it fixed. This is a known, accepted exception, not an oversight; see docs/task-notes/T47.md.

### 14.2 Typography

**System fonts only. No webfont is bundled or fetched.** A bundled Latin webfont covers only the scripts it ships subsets for, so every other locale falls back to a system font regardless — a different look per language, and a download that buys those readers nothing. The system stack is already correct for whatever scripts the reader's platform supports, costs no bytes, and never flashes unstyled text.

- Display and UI: the **proportional system sans** stack. 700 for the wordmark and primary action, 600 for section headings and small functional labels, normal weight for body text.
- Data: the **system monospace** stack. File sizes, dimensions, counters, breadcrumb, the `N / N` stepper, the `N / N processed` counter. Numbers that update in place carry `font-variant-numeric: tabular-nums` so digits do not jitter as values change.
- Weights above 700 are not used. Weight 800 is not a real cut in every system family and is synthesised where it is missing. Where the wordmark needs more presence, it comes from size, tracking and colour.
- Section headings are uppercase with wide tracking, applied as a CSS transform rather than uppercased strings, because not every script has a case mapping (R-L1). Functional micro-labels (OUTPUT, ZOOM, RATIO, BACKGROUND) use 11.5 to 12px, weight 600, `#a2a2a2`.
- Passive metadata (TARGET, PICK ONE) stays deliberately quiet in small mono grey.
- Rounded corners throughout: 6 to 7px on chips and small fields, 8 to 10px on controls and rows, 11 to 12px on the primary button and stage frame.

### 14.3 Honesty of numbers

Every size and percentage shown in the app is measured, not estimated. The comparison figures in Preview come from the actual selected bytes after a real encode and R-X24's source comparison. The reduction total in Processing accumulates from completed outputs. No aggregate output size appears next to the primary action, because it is not knowable before the run and would have to be a guess.

### 14.4 Preset policy

Dimension shortcuts are plain numbers with short labels (`FHD 1920`, `IG 1080`), not platform export presets. Platform specs change and most platforms accept ranges, so a named preset ages into wrong advice. Fixed-frame presets are a different job and belong to Edit mode, which is why aspect ratios (1:1, 4:5, 16:9, 9:16) live there. They express something a single number cannot.

---

## 15. Public site

The compressor is one page inside a small public site: pages that explain it, and the
pages a privacy-conscious audience expects to find. This section is scoped to the site
around the tool; the tool's own interface is specified in §§2-7.

### 15.1 Site structure

- R-S1 The compressor is a single route. Gallery, Preview, Edit and Processing (§3) are
  internal states of that one page; none of them is a separate URL, and none appears in
  the sitemap (R-S8). This is a routing decision, not an oversight, and treating a stage
  mode as a page does not revisit it.
- R-S2 A site shell — a header carrying navigation and a footer — wraps the tool and
  every public page alike. The tool renders inside the shell exactly as any other page
  does.
- R-S3 FAQ, Privacy, Terms and a Desktop information page are separate, real,
  independently addressable routes.

### 15.2 Content pages and translation

- R-S4 FAQ, Privacy, Terms and Desktop content is authored as markdown, one file per
  supported locale, kept apart from the interface string catalogue (§1.5). A content
  page is prose a person writes directly; R-L1 to R-L5 solve a problem — retranslating
  small fragments of interface chrome — that a page of continuous prose does not have.
- R-S5 Where a locale has no file for a given page, the English file for that page is
  served in its place, rather than an error or a missing page.

### 15.3 Discoverability

- R-S6 Every public route, the tool's own included, carries its own title, description,
  canonical URL, and Open Graph and Twitter card metadata. No two routes share a
  description.
- R-S7 The tool route carries WebApplication/SoftwareApplication structured data; the
  FAQ route carries FAQPage structured data. Both are offered to any engine that reads
  them; neither is required to produce a visible result for the site to be complete.
- R-S8 A sitemap.xml lists the real routes only. The stage modes excluded by R-S1 are
  not routes and are not listed.
- R-S9 A robots.txt names the sitemap's location and explicitly allows named,
  identifiable crawlers, in addition to its default allow. Hidden or crawler-only
  content of any kind, on any page, is excluded by R-K11; nothing in this section is a
  licence to add it.
- R-S10 An llms.txt file may be published at the site root, as a low-cost courtesy to a
  tool that reads it. It is not a channel the product depends on.

### 15.4 Legal content

- R-S11 The Privacy and Terms routes, and the pipeline that builds them, exist
  independent of their copy. Placeholder content ships until the legal text is written;
  the routes are not withheld waiting for it.

### 15.5 Installability and usage visibility

- R-S12 The application is installable as a Progressive Web App — a manifest and a
  service worker enabling offline use — consistent with every image already being
  processed on-device.
- R-S13 Usage visibility does not rely on server or edge access logs alone. A repeat
  visit served entirely from the service worker's cache may never reach the origin,
  undercounting exactly the loyal, offline-capable users the product exists for. Where
  usage is measured, a client-triggered event fired from the page itself does the
  measuring.
- R-S14 Where such measurement exists, it is the case R-V3 already anticipates:
  anonymous, aggregate, cookieless, and named exactly in the revised privacy line.

---

## 16. Decisions on record

Recorded so they are not relitigated.

| Decision | Rationale |
| --- | --- |
| No retention of encoded results outside delivery artifacts | Memory over speed. Preview work is repeated; completed run bytes live only in bounded OPFS/in-memory delivery storage until the first delivery or exit. |
| Preview performs a real encode | A projected size is a guess; the tool shows measured facts. |
| "Don't change" is the default format | Most users want smaller files, not different files. |
| Crop overrides the dimension rule; rotation does not | Crop states an explicit output size. Rotation does not. |
| Crop may produce output larger than input | A consequence of zooming out; background fill exists for it. |
| Background control lives only in Edit mode | Keeps the side panel to three decisions. |
| Alpha flattening outside Edit uses white | Matches what other tools do; no control offered unless complaints arrive. |
| JPEG preserves stored alpha, renders opaque | Switching format should not destroy a value the user set. |
| Rotation is 90 degree steps only | Free angle needs corner fill and breaks the ratio lock. |
| Rotation is part of the edit record | Remove edit clears both; rotation does not exist independently. |
| No editing of animated sources | Scope control for this version. |
| EXIF orientation baked, tag not copied | Copying it after applying it causes double rotation. |
| ICC profile preserved, not converted | Converting to sRGB loses gamut the source carried. |
| Other metadata stripped by default | Size and privacy, including GPS. |
| Delivery is explicit | Automatic download triggers browser warnings, Share requires a fresh activation, and both need a clear handoff moment. |
| Share only for runs starting with 1–10 accepted images | It serves the common small mobile batch without adding individual-file storage or writes to large desktop runs. |
| Share sends individual images, never the ZIP or report | Image-oriented system targets can consume the files directly; Download remains the archival path with structure and report. |
| Eligible runs keep ZIP and individual output artifacts | Both completion actions are immediate while the ten-file ceiling bounds the duplicated storage; quota and a measured byte cap remain mandatory. |
| Download and Share are alternative deliveries | The first successful handoff fulfils the run and releases every temporary artifact, preserving the existing short-lived result lifecycle. |
| Shared folder outputs use globally unique flattened names | System share payloads carry files, not the ZIP's directory tree; deterministic suffixes prevent silent collisions. |
| Quality above 95 means lossless | A simple rule the user can predict. |
| APNG output offered despite animated WebP being smaller | The encoder exists and the format has its uses. |
| Single image: no ZIP and no report | Unzipping one file is a cost with no benefit. The screen already showed the outcome. |
| Report written on every multi-image run | With folder input the user cannot otherwise confirm every file was found. |
| Report inside the ZIP | It travels with the images instead of being separated from them. |
| Non-image files never listed | That a spreadsheet was not compressed needs no explanation. |
| Images we cannot decode are listed | Their absence would otherwise look like a bug. |
| Archive streamed to origin-private storage | Removes the archive from the memory budget and keeps behaviour the same across browsers. |
| Compression starts on the primary action, not on Download | Streaming to storage removes the reason to defer it. |
| Cancel stops after the current image | A WASM encode cannot be interrupted. The alternative is a lie in the interface. |
| List view without thumbnails for large batches | Thumbnails require decoding every image. Filenames do not. |
| Thumbnail generation obeys one runtime-configured per-batch limit, initially 100 | Keeps CPU, decoded-memory pressure and retained thumbnail memory independent of batch size while allowing the limit to be tuned without changing thumbnail logic; later tiles use placeholders rather than causing rereads. |
| Thumbnail work exists only in Gallery grid mode | Preview, Edit and Processing must not compete with invisible background thumbnail decoding. |
| APNG is not a format choice; animated PNG output is just PNG | The user picked PNG. Whether it animates is a property of their source, not a decision to put in front of them. |
| Animated AVIF dropped, still AVIF kept | Still AVIF is why people want the format. Animated AVIF is slow, often larger, and rejecting it honestly beats supporting it badly. |
| PNG quality rescaled to a 70 to 95 floor | PNG means lossless to most people. A slider at 10 would produce banding they did not ask for. |
| Every PNG output receives lossless oxipng optimisation | A generous size target is a ceiling, not a reason to skip compression; the smaller candidate means the pass cannot make the file grow. |
| Extension reproduced exactly under Don't change | Changing `.JPG` to `.jpg` is a change the user did not request. |
| R-X24 does not override an explicit instruction | Returning the original when a resize was asked for returns the wrong dimensions. |
| No numeric RGBA fields | Four numeric inputs are expert controls in a tool for casual users. |
| Lossless above 95 stands, even when the file grows | At that setting the user is asking for fidelity, not for a smaller file. Keep-the-smaller rules apply below the threshold only. |

---

## 17. Items for the Technical Design

Functional behaviour above is settled. These are implementation questions that must be resolved before the Tasks document:

1. Whether the build's `heic` delegate actually decodes HEVC-coded HEIC, tested with a real file. This determines whether §5.2 keeps its browser fallback.
2. Standalone libimagequant for still PNG, or reuse of the copy inside apng-optimizer, or ImageMagick's own quantization. Bundle size and quality comparison.
3. Size-target search strategy per format, its iteration cost, and which formats make it too slow to offer (R-Q4).
4. Content check gating the second WebP encode in R-Q6.
5. Edit arithmetic: the exact relationship between rotation, crop rectangle, zoom, display scale and output dimensions, with a worked numeric example.
6. Shape of the extensible per-image edit record required by §4.5.
7. Concrete values for every limit in §5.7, derived from measured memory behaviour, including whether WASM memory can be reclaimed after a large image or whether the worker must be recreated.
8. Choice between the wasm32 and wasm64 builds, and the consequences for the memory ceiling and browser support.
9. Worker architecture and concurrency bound for R-X8, including how ImageMagick, gifsicle and the APNG path coexist.
10. Whether cross-origin isolation is required for a threaded build, and what that costs in deployment.
11. Debounce interval and cancellation mechanism for R-P3.
12. Transparency detection method for R-C13, robust to an alpha channel that is present but fully opaque.
13. ZIP library and its streaming behaviour under the memory budget.
14. Animated pipeline detail: frame decode, per-frame processing, reassembly, delay and disposal handling, for each of the four animated output formats.
15. APNG input detection and decoding path, given R-I4.
16. Origin-private storage: writing a ZIP incrementally, quota preflight accuracy, and whether handing the finished file to a download streams from disk rather than loading into memory.
17. Folder traversal mechanism per browser, and whether relative paths are available consistently through both the picker and the drop path.
18. Thumbnail generation strategy and the file-count threshold at which the list view becomes the default.
19. Report writer: YAML shape, size formatting, and the exact set of caveats that promote a success to a listed entry.
20. Worker termination and recreation cost, which sets the threshold in R-X29.
21. PNG quality rescale: confirming the 70 floor in R-Q11 against real images. The test is whether the floor is high enough that no PNG output shows banding at the lowest reachable setting.
22. Locale file format, the parallel context file format, and how both are kept in sync with the code.
23. Animated AVIF input detection, so R-F8 rejects it at selection rather than discovering it at decode.
24. Web Share capability detection, multi-file and OPFS-backed `File` handoff, bounded-memory limits, flattened naming and cleanup for R-X47 to R-X53.
