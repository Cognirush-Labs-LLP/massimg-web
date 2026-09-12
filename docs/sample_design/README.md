# Sample design

Imported from the Claude Design project used to sketch this app's UI:
https://claude.ai/design/p/ba7fd510-594d-4596-8dfb-a7f3161a9fa8 ("Responsive Image Compressor Web App").

This is a **visual and interaction reference only** — a working click-through prototype with simulated
compression (images are striped placeholders, sizes are estimated by a formula, not a real encoder). It
predates and does not fully match `docs/functional-design.md` / `docs/technical-design.md`, which are
authoritative. Where they conflict, the design documents win.

It is also built on a different stack (a small React-based runtime, `support.js`) than the actual app
(Vue 3 — see `docs/technical-design.md` §1), so it is not a component source to port from, only a
reference for layout, colour, type, spacing and interaction behaviour (crop dragging, zoom/background
fill semantics, the accordion, panel responsiveness, and so on).

## Files

- `Image Compressor.dc.html` — the prototype. Open it in a browser (serve the folder rather than
  opening via `file://`, since it fetches `./support.js`) to click through Gallery, Preview and Crop
  modes.
- `support.js` — the Claude Design runtime that renders the `.dc.html` file. Generated code, not
  hand-written; don't edit it.
- `Functional Requirements.md` — the draft requirements written alongside the prototype. Superseded by
  `docs/functional-design.md`; kept here for the rationale notes in §6 (design system) and the open
  items in §7, some of which map directly onto tasks in `docs/tasks.md`.

## Viewing it

```sh
npx serve docs/sample_design
# or: python3 -m http.server --directory docs/sample_design
```

Then open `Image Compressor.dc.html` at the served URL.
