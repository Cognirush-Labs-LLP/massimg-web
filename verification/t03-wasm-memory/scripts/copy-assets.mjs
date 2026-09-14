// Copies the magick-wasm browser build out of node_modules into public/vendor
// so the static server can serve it over http(s) without a bundler. Run
// automatically before `pnpm test` (see package.json "pretest").
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkgDir = join(root, 'node_modules', '@imagemagick', 'magick-wasm', 'dist');
const destDir = join(root, 'public', 'vendor', 'magick-wasm');

const files = [
  ['index.js', 'index.js'],
  [join('x64', 'magick.wasm'), join('x64', 'magick.wasm')],
];

for (const [src, dest] of files) {
  const srcPath = join(pkgDir, src);
  const destPath = join(destDir, dest);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
}

console.log(`Copied magick-wasm dist assets to ${destDir}`);
