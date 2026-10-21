// Well-formed animated GIFs with a different full-canvas image in every frame, written by
// ImageMagick itself: `make-android-fixtures.mjs`'s hand-built one-pixel-frame GIFs decode fine but
// are not reliable input for the animated-WebP encoder, which is not what the ramp is measuring.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@imagemagick', 'magick-wasm');
const { initializeImageMagick, MagickImageCollection, MagickImage, MagickColor, MagickFormat } = await import(join(pkg, 'dist/index.js'));
await initializeImageMagick(readFileSync(join(pkg, 'dist/x86/magick.wasm')));

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fixtures', 'android');

function animation(side, frames, name) {
  MagickImageCollection.use((collection) => {
    for (let i = 0; i < frames; i++) {
      const image = MagickImage.create(new MagickColor((i * 37) % 256, (i * 91) % 256, (i * 17 + 40) % 256, 255), side, side);
      image.animationDelay = 10;
      collection.push(image);
    }
    collection.write(MagickFormat.Gif, (data) => writeFileSync(join(outDir, name), data));
  });
  console.log(name.padEnd(24), `${side}x${side} x ${frames}`, `${(side * side * frames / 1e6).toFixed(1)} M frame-px`);
}

animation(590, 100, 'anim-590x100.gif');
animation(1000, 300, 'anim-1000x300.gif');
animation(200, 100, 'anim-200x100.gif');
