# verification/

Throwaway harnesses that settle open questions from `docs/assumptions.md` and `docs/tasks.md` with
real measurements — encode/decode time, memory, output size — rather than guesses. Each `tNN-*`
folder is an independent, self-contained project: its own `package.json`, its own lockfile, run with
`node run.mjs` (or `npm test`) from inside that folder. Nothing here ships in the product; results are
recorded in each folder's `results.json` and written up in `docs/task-notes/TNN.md`.

| Folder | Settles | Needs real photos? |
|---|---|---|
| [t01-opfs-memory](t01-opfs-memory) | OPFS chunked write + download, peak tab memory per browser | No — synthetic bytes |
| [t02-avif-speed](t02-avif-speed) | AVIF `heic:speed` 6/7/8/9 on real photographs: size, time, SSIM | **Required** |
| [t03-wasm-memory](t03-wasm-memory) | WASM heap + tab memory across increasing image sizes | No — synthetic images |
| [t20-thumbnails](t20-thumbnails) | Thumbnail time/memory/bytes over 50 mixed photographs (C5) | **Required** |
| [t22-codecs](t22-codecs) | Lazy vs. eager codec loading, bundle size and memory (C8) | No — synthetic images |
| [t23-decode](t23-decode) | ICC profile survival (D3) and HEIC CICP signalling (A13) | Optional — A13 half skips without it |
| [t26-encode](t26-encode) | WebP lossy vs. lossless (D2), unique-colour gate calibration | Optional — degrades gracefully |
| [t27-png](t27-png) | libimagequant vs. ImageMagick quantizer on PNGs (D8) | Optional — degrades gracefully |
| [t28-gif](t28-gif) | gifsicle vs. ImageMagick GIF writer (A7) | Optional — degrades gracefully |
| [t29-animated](t29-animated) | Peak memory vs. frame count/size for animation decode (C7) | No — synthetic animations |
| [t30-size](t30-size) | Size-target search cost across formats (D1) | Optional — degrades gracefully |
| [t39a-web-share](t39a-web-share) | Multi-file Web Share on real iOS/Android/desktop browsers (E4) — manual, no `run.mjs` | **Required** |
| [t40-archive-memory](t40-archive-memory) | Streaming many entries through client-zip into OPFS, peak tab memory per browser (E1) | No — synthetic bytes |

## Real-photo fixtures

Several harnesses need actual photographs — synthetic images can't stand in for real photo entropy,
EXIF, and format quirks. Those photos are **never committed**. Instead:

1. Copy `.env.example` at the repo root to `.env` (gitignored) and set `PHOTO_FIXTURES_DIR` to an
   absolute path on your machine containing real photos in a mix of formats (JPEG, PNG, WebP, HEIC,
   GIF, TIFF — the exact mix needed depends on the task; t20 needs the widest spread, at least
   26 JPEG, 12 PNG, 5 WebP, 4 HEIC, 2 GIF and 1 TIFF, plus a couple of spares per format).
2. That directory is treated as **read-only** — nothing here writes into it, moves it, or renames
   anything inside it.
3. Harnesses address fixtures by **format and a deterministic size-sorted sample**, never by
   filename. No original filename, or the directory path itself, is ever recorded in `results.json`
   or committed anywhere.

Harnesses marked "Required" above throw if `PHOTO_FIXTURES_DIR` is unset or doesn't have enough files
of a needed format. Harnesses marked "Optional" run their synthetic-content measurement regardless and
just record a `skipped` note for the real-photo half of the result.

Full rules: [AGENTS.md § "Test/verification photo fixtures"](../AGENTS.md).

## Running a harness

```sh
cd verification/t20-thumbnails
npm install
npm run install-browsers   # only for harnesses with a Playwright devDependency
npm test                   # runs run.mjs
```

Some harnesses (`t01`, `t03`, `t20`) drive real browsers via Playwright and need the
`install-browsers` step first; check the folder's `package.json` for whether it has that script.
