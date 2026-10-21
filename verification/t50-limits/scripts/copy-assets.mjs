// Copies the x86 (wasm32) magick-wasm build — the one the product ships — into public/vendor.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'node_modules', '@imagemagick', 'magick-wasm', 'dist');
const destDir = join(root, 'public', 'vendor', 'magick-wasm');

for (const file of ['index.js', join('x86', 'magick.wasm')]) {
  mkdirSync(dirname(join(destDir, file)), { recursive: true });
  copyFileSync(join(pkgDir, file), join(destDir, file));
}
console.log(`Copied magick-wasm dist assets to ${destDir}`);
