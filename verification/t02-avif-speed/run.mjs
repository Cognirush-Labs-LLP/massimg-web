// T02 verification harness — AVIF encode speed on real photographs.
//
// For each of 20 real photographs (selected deterministically from the machine-local
// PHOTO_FIXTURES_DIR, never hardcoded here — see AGENTS.md "Test/verification photo
// fixtures"), encodes to AVIF at heic:speed 6, 7, 8 and 9, quality 70. Records output
// size and wall-clock encode time, then measures perceptual similarity to the source
// with ImageMagick's own SSIM compare metric (see docs/task-notes/T02.md for rationale).
//
// Run: pnpm test  (equivalent to `node run.mjs`)

import { initializeImageMagick, ImageMagick, MagickFormat, ErrorMetric } from '@imagemagick/magick-wasm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const scratchDir = path.join(__dirname, '.scratch');
fs.mkdirSync(scratchDir, { recursive: true });

function readEnvVar(name) {
  const envPath = path.join(repoRoot, '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === name) return line.slice(eq + 1).trim();
  }
  throw new Error(`${name} not found in .env`);
}

const fixturesDir = readEnvVar('PHOTO_FIXTURES_DIR');

// --- Photo selection (deterministic, no filenames hardcoded here) ---------------------
//
// Source: MIC_Demo/input_image, a folder on the fixtures drive of ~145 real JPEGs
// (portraits, drone shots, architecture, product photography) contributed by a mix of
// photographers and cameras. We stride-sample the folder sorted by file size (a proxy
// for resolution/detail) to get spread across content and resolution, then add one
// nature photo (asian_hathi.jpg, a different subject: an elephant) from the parent
// folder for additional variety. This algorithm is reproducible against the same
// directory; it intentionally avoids embedding the individual (personally-tagged)
// filenames in a committed file.
const inputDir = path.join(fixturesDir, 'MIC_Demo', 'input_image');
const candidates = fs
  .readdirSync(inputDir)
  .filter((f) => /\.jpe?g$/i.test(f))
  .map((f) => ({ name: f, size: fs.statSync(path.join(inputDir, f)).size }))
  .sort((a, b) => a.size - b.size);

const STRIDE = 7;
const OFFSET = 2;
const picked = [];
for (let i = OFFSET; i < candidates.length && picked.length < 19; i += STRIDE) {
  picked.push(candidates[i]);
}

const selectedPaths = [
  ...picked.map((f) => path.join(inputDir, f.name)),
  path.join(fixturesDir, 'MIC_Demo', 'asian_hathi.jpg'),
];

if (selectedPaths.length !== 20) {
  throw new Error(`expected 20 photos, got ${selectedPaths.length}`);
}
for (const p of selectedPaths) {
  if (!fs.existsSync(p)) throw new Error(`selected fixture missing: ${p}`);
}

// --- ImageMagick init -------------------------------------------------------------------

const wasmBytes = fs.readFileSync(
  new URL('./node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm', import.meta.url),
);
await initializeImageMagick(wasmBytes);

const SPEEDS = [6, 7, 8, 9];
const QUALITY = 70;
const results = [];

for (let photoIndex = 0; photoIndex < selectedPaths.length; photoIndex++) {
  const srcPath = selectedPaths[photoIndex];
  const srcBuf = fs.readFileSync(srcPath);
  const sourceSizeBytes = srcBuf.length;

  ImageMagick.read(srcBuf, (orig) => {
    const width = orig.width;
    const height = orig.height;
    console.log(`\n[photo ${photoIndex + 1}/20] ${width}x${height}, source ${sourceSizeBytes} bytes`);

    for (const speed of SPEEDS) {
      orig.quality = QUALITY;
      orig.settings.setDefine(MagickFormat.Heic, 'speed', String(speed));

      const t0 = performance.now();
      orig.write(MagickFormat.Avif, (encodedData) => {
        const encodeMs = performance.now() - t0;
        const encodedSizeBytes = encodedData.length;

        // Perceptual quality: ImageMagick's own SSIM compare metric, encoded result
        // decoded back and compared against the original. compare() returns a
        // "distortion" value where 0 = identical; we report ssim = 1 - distortion so
        // higher is better, consistent with how SSIM is normally read.
        let ssim = null;
        ImageMagick.read(encodedData, (encoded) => {
          const distortion = orig.compare(encoded, ErrorMetric.StructuralSimilarity);
          ssim = 1 - distortion;
        });

        console.log(
          `  speed ${speed}: ${encodedSizeBytes} bytes, ${encodeMs.toFixed(0)} ms, ssim ${ssim.toFixed(5)}`,
        );

        results.push({
          photoIndex,
          width,
          height,
          sourceSizeBytes,
          speed,
          encodedSizeBytes,
          encodeMs,
          ssim,
        });

        // Keep one encoded sample per photo/speed in scratch for spot-checking; not committed.
        fs.writeFileSync(
          path.join(scratchDir, `photo${photoIndex + 1}-speed${speed}.avif`),
          encodedData,
        );
      });
    }
  });
}

fs.writeFileSync(path.join(scratchDir, 'results.json'), JSON.stringify(results, null, 2));

// --- Aggregate summary --------------------------------------------------------------

const bySpeed = new Map();
for (const r of results) {
  if (!bySpeed.has(r.speed)) bySpeed.set(r.speed, []);
  bySpeed.get(r.speed).push(r);
}

console.log('\n=== Aggregate summary (mean over 20 photos) ===');
console.log('speed | mean size (KB) | mean time (ms) | mean SSIM | min SSIM | max time (ms)');
for (const speed of SPEEDS) {
  const rows = bySpeed.get(speed);
  const meanSize = rows.reduce((s, r) => s + r.encodedSizeBytes, 0) / rows.length / 1024;
  const meanTime = rows.reduce((s, r) => s + r.encodeMs, 0) / rows.length;
  const meanSsim = rows.reduce((s, r) => s + r.ssim, 0) / rows.length;
  const minSsim = Math.min(...rows.map((r) => r.ssim));
  const maxTime = Math.max(...rows.map((r) => r.encodeMs));
  console.log(
    `${speed}     | ${meanSize.toFixed(1).padStart(9)} | ${meanTime.toFixed(0).padStart(10)} | ${meanSsim.toFixed(5)} | ${minSsim.toFixed(5)} | ${maxTime.toFixed(0)}`,
  );
}

fs.writeFileSync(
  path.join(scratchDir, 'summary.json'),
  JSON.stringify(
    SPEEDS.map((speed) => {
      const rows = bySpeed.get(speed);
      return {
        speed,
        meanSizeKB: rows.reduce((s, r) => s + r.encodedSizeBytes, 0) / rows.length / 1024,
        meanEncodeMs: rows.reduce((s, r) => s + r.encodeMs, 0) / rows.length,
        meanSsim: rows.reduce((s, r) => s + r.ssim, 0) / rows.length,
        minSsim: Math.min(...rows.map((r) => r.ssim)),
        maxEncodeMs: Math.max(...rows.map((r) => r.encodeMs)),
      };
    }),
    null,
    2,
  ),
);

console.log('\nDone. Full per-encode data: .scratch/results.json, summary: .scratch/summary.json');
