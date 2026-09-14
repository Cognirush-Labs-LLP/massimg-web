// The "bundle" half of C8's "measured bundle and memory figures" — a real production `vite build`
// of a probe entry that touches all six codec modules, read back from the emitted asset sizes rather
// than estimated from package.json `unpackedSize` (which includes source maps, READMEs, etc. that
// never ship). This is the same technique used to verify each npm package choice during planning
// (docs/task-notes/T22.md, "Decisions made" — the `imagequant` build-risk check).
//
// A dedicated temp entry file is used rather than src/harness.js, so this can run standalone without
// the dev server, and so the six chunks are attributed by which package emitted them.

import { build } from 'vite';
import { mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROBE = `
export async function loadImageMagick() {
  const magick = await import('@imagemagick/magick-wasm')
  const wasmUrl = new URL('@imagemagick/magick-wasm/magick.wasm', import.meta.url)
  await magick.initializeImageMagick(wasmUrl)
}
export async function loadGifsicle() {
  await import('gifsicle-wasm-browser')
}
export async function loadOxipng() {
  const m = await import('@jsquash/oxipng/optimise.js')
  await m.init()
}
export async function loadQuantizer() {
  await import('imagequant')
}
export async function loadUpng() {
  await import('upng-js')
}
export async function loadApngOptimizer() {
  const { APNGOptimizer } = await import('apng-optimizer')
  const wasmUrl = new URL('apng-optimizer/apng-optimizer.wasm', import.meta.url)
  return APNGOptimizer
}
// Call every export so nothing is tree-shaken away as unreachable — real production code reaches
// all six from pipeline/execute.ts's call graph, which this probe otherwise has no equivalent of.
await Promise.all([
  loadImageMagick(),
  loadGifsicle(),
  loadOxipng(),
  loadQuantizer(),
  loadUpng(),
  loadApngOptimizer(),
])
`;

export async function measureBundleSizes() {
  // Written inside this project, not the OS temp dir: bare-specifier resolution for the probe's
  // imports walks up from the importing file's own directory looking for node_modules, and the six
  // codec packages live in this project's, not one reachable from /tmp.
  const scratchDir = join(__dirname, '.probe-scratch');
  const entry = join(scratchDir, 'probe.js');
  const outDir = join(scratchDir, 'dist');
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(entry, PROBE);

  try {
    await build({
      root: __dirname,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        rollupOptions: { input: entry },
      },
    });

    const assetsDir = join(outDir, 'assets');
    const files = readdirSync(assetsDir);
    const sizeOf = (patterns) =>
      files
        .filter((file) => patterns.some((pattern) => file.includes(pattern)))
        .reduce((sum, file) => sum + statSync(join(assetsDir, file)).size, 0);

    // `gifsicle-wasm-browser` and `upng-js` have no separate .wasm asset — gifsicle embeds its own
    // worker source (with the WASM inside it) as a JS string, and UPNG is pure JS (§7.1) — so their
    // weight shows up as JS chunk size rather than a `gifsicle`/`upng`-named file. `entryChunkBytes`
    // is the probe's own tiny entry chunk (Rollup's default naming for the input file, not any
    // codec); every other unlabelled chunk goes to `otherChunkBytes`, which is predominantly those
    // two modules' JS.
    const byModule = {
      imagemagick: sizeOf(['magick']),
      oxipng: sizeOf(['oxipng', 'squoosh_oxipng']),
      quantizer: sizeOf(['imagequant']),
      apngOptimizer: sizeOf(['apng-optimizer']),
    };
    const labelledBytes = Object.values(byModule).reduce((sum, bytes) => sum + bytes, 0);
    byModule.total = files.reduce((sum, file) => sum + statSync(join(assetsDir, file)).size, 0);
    byModule.entryChunkBytes = sizeOf(['probe']);
    byModule.otherChunkBytes = byModule.total - labelledBytes - byModule.entryChunkBytes;

    return byModule;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
