// The ImageMagick side of T20's measurement (C5's method: "time native reduced-size decoding and
// the ImageMagick path where native decoding is unavailable").
//
// Two jobs here:
//   1. Read every fixture's intrinsic dimensions, so the harness page can bound both axes without a
//      probe decode — exactly as the real service reads them from ImageRecord.
//   2. Time the ImageMagick thumbnail operation for the formats a browser cannot decode natively,
//      which is what Technical Design §10.4's fallback would cost. Measured in Node rather than in
//      the page because pipeline/codecs/loader.ts (T22) does not exist yet, so there is no in-app
//      ImageMagick to measure; the WASM work itself is the same either way.

import fs from 'node:fs';
import { initializeImageMagick, ImageMagick, MagickFormat } from '@imagemagick/magick-wasm';

let initialised = false;

async function ensureInitialised() {
  if (initialised) return;
  const wasmBytes = fs.readFileSync(
    new URL('./node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm', import.meta.url),
  );
  await initializeImageMagick(wasmBytes);
  initialised = true;
}

export async function readDimensions(fixtures) {
  await ensureInitialised();

  const measured = [];
  for (const fixture of fixtures) {
    const bytes = fs.readFileSync(fixture.path);
    let width = 0;
    let height = 0;
    try {
      ImageMagick.read(bytes, (image) => {
        width = image.width;
        height = image.height;
      });
    } catch (error) {
      // A fixture ImageMagick itself cannot read is not a thumbnail finding; drop it and say so.
      console.log(`  skipping unreadable ${fixture.format} fixture: ${error.message}`);
      continue;
    }
    measured.push({ ...fixture, index: measured.length, width, height });
  }
  return measured;
}

/** Times ImageMagick's own thumbnail operation for one fixture, to the same bound and format. */
export async function timeMagickThumbnail(fixture, maxEdge, format, quality) {
  await ensureInitialised();

  const bytes = fs.readFileSync(fixture.path);
  const start = performance.now();
  let thumbBytes = 0;
  let width = 0;
  let height = 0;

  ImageMagick.read(bytes, (image) => {
    // `resize` with a geometry that bounds both axes preserves aspect ratio; ImageMagick's
    // `thumbnail` differs only in stripping metadata, which we want too.
    image.thumbnail(maxEdge, maxEdge);
    image.quality = Math.round(quality * 100);
    width = image.width;
    height = image.height;
    image.write(format === 'image/webp' ? MagickFormat.WebP : MagickFormat.Jpeg, (data) => {
      thumbBytes = data.length;
    });
  });

  return {
    index: fixture.index,
    format: fixture.format,
    totalMs: performance.now() - start,
    sourceBytes: bytes.length,
    thumbBytes,
    width,
    height,
  };
}
