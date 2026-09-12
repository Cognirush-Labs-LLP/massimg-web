# Online Image Compressor — Functional Requirements

Status: draft for review
Scope: responsive web app (mobile-first) for batch image compression, resizing, format conversion and single-image cropping. Client-side; no account required.
Prototype: `Image Compressor.dc.html`

---

## 1. Product summary

A single-screen tool. The user brings images in, sets one compression target, one dimension rule and one output format, and downloads the result — a single file for one image, a ZIP for many. A large staging area doubles as gallery, result preview and crop workspace, so the user never leaves the screen.

### 1.1 Goals

- Compress a batch in three decisions or fewer: target, size, format.
- Make the result verifiable before download (original vs compressed comparison per image).
- Support the one manual operation that batch settings cannot express: cropping a single image.
- Work on a phone without hiding the primary action.

### 1.2 Non-goals

- Editing beyond crop (no filters, rotation, retouching, annotation).
- Server-side processing, accounts, history, or cloud storage.
- Platform-named export presets (see §6.4 for the rationale).

---

## 2. Layout and regions

Three regions:

| Region | Role |
| --- | --- |
| Header | Product mark, context breadcrumb, mobile Options button |
| Stage | Gallery / Preview / Crop — the largest area on screen |
| Side panel | Compression settings + primary action |

### 2.1 Header

- Wordmark plus a tint dot.
- Breadcrumb, uppercase mono, reflecting stage state: `6 SELECTED`, `PREVIEW · abc.jpg`, `CROP · abc.jpg`.
- **Options** button: visible on mobile only, rendered as a solid tint-red pill with a `☰` mark so it carries the same visual weight as the primary action.

### 2.2 Stage

Fills all remaining width. Owns a mode-specific toolbar row (title or back/step/crop controls) and a scrollable body.

### 2.3 Side panel

- Desktop (≥900px): static right column, 344px, always visible, separated by a grey border. Never collapsible — showing it is preferred to hiding it.
- Mobile (<900px): off-canvas drawer sliding in from the right, width `min(340px, 88vw)`, with a scrim over the stage. A sticky **Hide →** button pins to the top of the drawer.
- Sections in order: Quality, Dimension, Format. Grey 1px borders separate the sections only, not individual controls.

---

## 3. Stage modes

### 3.1 Gallery view (default)

**Empty state.** Dashed drop zone covering the stage: headline "Drop images to compress", a mono line of accepted formats and limits (`JPEG · PNG · WEBP · AVIF · up to 200 files`), and a **Select images** button opening the file picker. Drag-and-drop anywhere on the stage is accepted.

**Populated state.**
- Title "Your Images" with a mono meta line: image count and total input size. **No estimated output size is shown here** — nothing has been compressed yet.
- An affordance line above the grid: "Click an image to preview the result or crop it".
- Responsive thumbnail grid, `auto-fill` with a configurable minimum tile width.
- Each tile shows: thumbnail, filename (truncated), and `W×H · human-readable size`.
- Tile overlays: a `CROPPED` badge (top-left) when the image has a crop applied; a `×` remove button (top-right).
- Toolbar actions: **Add images**, **Clear**.

**Requirements**
- R-G1 Clicking a tile opens Preview mode for that image.
- R-G2 Removing a tile does not change other images' settings.
- R-G3 When exactly one image is present the app opens Preview mode for it instead of a one-tile gallery.

### 3.2 Preview mode

Shows one image fitted inside the available stage area, with the side panel still visible.

**Comparison control (top centre).**

```
500 KB   [ Original | Compressed ]   250 KB   50% ↓
```

- The pill is a **single toggle**: clicking anywhere on it flips between Original and Compressed, so the user can flick back and forth without aiming at a specific half.
- Left value: original file size. Right value: projected compressed size. Trailing value: percentage reduction with a ↓ glyph.

**Transform line (below).** Mono, one line:

```
abc.jpeg  1000×1000  →  abc.webp  500×500
```

Reflects the current format and dimension settings, including any applied crop.

**Toolbar.** `← Images` (back to gallery), a `‹ 3 / 6 ›` stepper for moving through the batch, and **Crop** / **Edit crop**.

**Requirements**
- R-P1 The frame preserves the image's true aspect ratio at all viewport sizes. The stage is measured and the frame given contain-fit dimensions; the image is never stretched.
- R-P2 The stepper wraps at both ends and preserves the current comparison tab.
- R-P3 Projected sizes are labelled as projections in this view only; they never appear as fact elsewhere (see §6.3).

### 3.3 Crop mode

Entered from Preview. Crop is a **per-image** operation, always applied to the image currently in the frame.

**Controls**
- Toolbar: output `W` × `H` px inputs (editable — typing a value resizes the crop rectangle), **Remove crop** (only when a crop already exists), **Cancel**, **Apply crop**.
- Ratio row above the frame: `Free · 1:1 · 4:5 · 16:9 · 9:16`. Selecting a ratio locks the crop rectangle's proportions for dragging, resizing and typed dimensions.
- Crop rectangle over the image with four corner handles; draggable to reposition, resizable from any corner. Area outside the rectangle is darkened to show what will be discarded. A live `W×H` badge sits inside the rectangle.
- Zoom slider (0.1× – 2×) below the frame with a numeric readout.
- Background row (conditional, see below).

**Zoom semantics.** The output frame is fixed; zoom scales the *image* inside it. Zooming in yields smaller output dimensions from the same rectangle; zooming out yields larger ones. Output dimensions are therefore `crop fraction ÷ zoom × original dimension`.

**Background fill.** Zooming out past 1× can make the crop rectangle extend beyond the image edges. When that happens — and only then — a Background row appears:
- Swatches: Black, White, Transparent.
- Numeric `R` `G` `B` fields (0–255) and an `A` field (0–1).
- `A` and the Transparent swatch are hidden when the selected output format has no alpha channel (JPEG). The hint then reads "JPEG has no transparency — pick a fill colour".
- The frame renders the chosen colour over a checkerboard so partial alpha is legible.

**Requirements**
- R-C1 Output dimensions include the padded spill area; they are not clamped to the original image size.
- R-C2 **Cancel** restores the crop rectangle, ratio and zoom to their values on entering crop mode and returns to Preview.
- R-C3 **Remove crop** clears the stored crop for that image and returns to Preview.
- R-C4 A locked ratio is re-fitted to the new image's dimensions when the user steps to another image, so the highlighted chip and the on-screen rectangle never disagree.
- R-C5 The crop rectangle cannot leave the frame, and has a minimum size.

---

## 4. Side panel settings

### 4.1 Quality

Target selector, segmented, two options.

**Quality**
- Slider, 10–100, with a large mono numeric readout.
- Shortcut chips: `LOW 40`, `MED 70`, `HIGH 90`. Chips set the slider value; the slider remains freely adjustable.

**Size**
- Numeric text box plus a `KB` / `MB` unit toggle.
- The encoder targets that file size per image.

### 4.2 Dimension

**Exactly one option may be active.** Rendered as an accordion of radio rows; the selected row expands to reveal its value field and shortcut chips, and all other children stay collapsed. (Checkboxes were rejected — they implied combinable rules; tabs were rejected as too heavy for four mutually exclusive options.)

| Option | Value | Shortcut chips |
| --- | --- | --- |
| Original size | — | — |
| Fit within long edge | one px value | HD 1280, FHD 1920, 2K 2560, 4K 3840, IG 1080 |
| Fixed width | one px value | IG 1080, WEB 1200, MAIL 800, PRINT 3000 |
| Fixed height | one px value | IG 1350, HD 720, FHD 1080 |

- Shortcut chips only write a number into the field; the field is always editable, so no "Custom" entry is needed.
- "Fit within long edge" only downscales; images already inside the limit are untouched.
- Crop is **not** listed here. It lives in Preview because it is per-image, not a batch rule.

**Crop interaction with Dimension**
- R-D1 An image with a crop applied takes its output size from the crop; batch dimension settings are ignored for that image.
- R-D2 With more than one image and at least one cropped, a note appears in the Dimension section: "Crop applied to N images. Their crop overrides the setting below; the rest follow it."
- R-D3 With exactly one image, and it is cropped, the Dimension rows are disabled and the note explains why.

### 4.3 Format

Dropdown: JPEG, PNG, WebP, AVIF. Drives the output extension in the transform line, alpha availability in the crop background control, and the projected size in Preview.

### 4.4 Primary action

- Label: **Compress & Download**, with a count for batches — `Compress & Download (6)`.
- Meta line beneath it states facts only: `6 images · WEBP · ZIP`, or `WEBP · 1920×1440` for a single image.
- One image downloads directly; two or more download as a ZIP.

**Requirements**
- R-A1 The button is visible at all times. On mobile it sits in a fixed bottom bar outside the drawer, so opening or hiding Options never hides it. On desktop it is pinned to the panel footer.
- R-A2 No aggregate output size is claimed before compression runs.

---

## 5. Responsive behaviour

| Breakpoint | Panel | Primary action | Options button |
| --- | --- | --- | --- |
| ≥900px | Static 344px column, always shown | Panel footer | Hidden |
| <900px | Off-canvas drawer, sticky `Hide →` | Fixed bottom bar | Visible, tint-red |

- The layout is space-driven, not device-driven: whenever the panel fits, it is shown.
- Toolbar rows wrap rather than scroll horizontally.
- Touch targets in the stage and panel are at least 44px in their primary dimension.

---

## 6. Design system

### 6.1 Colour

| Token | Value | Use |
| --- | --- | --- |
| Tint | `#cf0000` | Primary action, active states, crop outline, reduction figure |
| Primary | `#ffffff` | Text, icons |
| Background | `#000000` | App background |
| Surface | `#060606` – `#121212` | Panel, controls, tiles |
| Border | `#242424` (group) / `#2c2c2c` (control) | Grey separators |
| Muted text | `#6e6e6e` – `#a2a2a2` | Secondary and label text |

Dark theme only. Tint is reserved for action and state; it is never decorative.

### 6.2 Typography

- Display and UI: **Archivo** — 800 for the wordmark and primary action, 700 for section headings and small functional labels, 600 for controls and chips.
- Data: **JetBrains Mono** — file sizes, dimensions, counters, breadcrumb, the `N / N` stepper.
- Section headings are uppercase with wide tracking. Functional micro-labels (OUTPUT, ZOOM, RATIO, BACKGROUND, R/G/B/A) use Archivo at 11.5–12px, weight 700, `#a2a2a2` — legible at a glance.
- Passive metadata (TARGET, PICK ONE) stays deliberately quiet in small mono grey.
- Rounded corners throughout: 6–7px on chips and small fields, 8–10px on controls and rows, 11–12px on the primary button and stage frame.

### 6.3 Honesty of numbers

Projected compressed size and percentage reduction appear only in Preview, next to the Original/Compressed toggle, where they read as a per-image projection tied to current settings. No estimated total appears next to the download button, because the true figure is not knowable before encoding.

### 6.4 Preset policy

Dimension shortcuts are plain numbers with short labels (`FHD 1920`, `IG 1080`), not platform export presets. Platform specs change and most platforms accept ranges, so a named preset ages into wrong advice. Fixed-frame presets are a different job and belong to crop, which is why aspect ratios (1:1, 4:5, 16:9, 9:16) live there — they express something a single number cannot.

---

## 7. Prototype scope and open items

Implemented in the prototype: all three stage modes, mode transitions, batch stepping, the comparison toggle, crop with ratio lock / zoom / background fill / cancel-restore, the single-select Dimension accordion with crop-override notes, format selection, responsive panel and the always-visible primary action. Compression itself is simulated; images are striped placeholders.

Open items for engineering:
1. Real encode pipeline (WASM codecs), per-image progress and cancel.
2. Size-target search strategy (binary search on quality) and its failure case when the target is unreachable.
3. Actual size and count limits, plus memory behaviour on large batches.
4. ZIP naming and filename collision rules.
5. EXIF and colour-profile handling: strip, preserve, or offer as a setting.
6. Keyboard support: arrow keys for stepping, Esc to exit crop, Enter to apply.
7. Persistence of settings between sessions.
