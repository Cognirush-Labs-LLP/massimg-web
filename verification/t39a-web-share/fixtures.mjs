// Fixture selection for T39-A: one real file per encodable output format (JPEG, PNG, WebP, AVIF,
// GIF — the set `src/domain/format.ts` actually encodes to).
//
// The photographs live outside the repo, at the path in the root .env (AGENTS.md, "Test/verification
// photo fixtures"). Nothing is ever copied into the repo: `server.mjs` streams the chosen file's
// bytes straight from PHOTO_FIXTURES_DIR on request, and no original filename ever leaves this
// module or reaches a client or results.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readEnvVar(name) {
  const content = fs.readFileSync(path.join(repoRoot, '.env'), 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === name) return line.slice(eq + 1).trim();
  }
  throw new Error(`${name} not found in .env`);
}

const EXCLUDED_DIRECTORIES = /^(PngSuite|test output|test2|unable_to_read_metadata|video)/i;

function walk(dir, matcher, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.test(entry.name)) continue;
      walk(full, matcher, found);
    } else if (matcher.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

// Matches the five formats `src/domain/format.ts`'s MIME_TYPES actually covers.
const FORMATS = {
  jpeg: { pattern: /\.jpe?g$/i, mime: 'image/jpeg' },
  png: { pattern: /\.png$/i, mime: 'image/png' },
  webp: { pattern: /\.webp$/i, mime: 'image/webp' },
  avif: { pattern: /\.avif$/i, mime: 'image/avif' },
  gif: { pattern: /\.gif$/i, mime: 'image/gif' },
};

/** Median-by-size candidate: deterministic, and avoids both the smallest (near-empty) and the
 * largest (outlier) file in a format with few real candidates (e.g. this fixture set's one AVIF). */
function pickMedian(candidates) {
  const sorted = candidates
    .map((file) => ({ file, size: fs.statSync(file).size }))
    .sort((a, b) => a.size - b.size);
  return sorted[Math.floor(sorted.length / 2)];
}

const cache = new Map();

export function resolveFixture(format) {
  const spec = FORMATS[format];
  if (!spec) {
    throw new RangeError(`unknown fixture format: ${format}`);
  }
  if (cache.has(format)) {
    return cache.get(format);
  }
  const root = readEnvVar('PHOTO_FIXTURES_DIR');
  const candidates = walk(root, spec.pattern).filter((file) => !path.basename(file).startsWith('.'));
  const picked = pickMedian(candidates);
  if (!picked) {
    throw new Error(`no ${format} fixtures found under PHOTO_FIXTURES_DIR`);
  }
  const resolved = { path: picked.file, size: picked.size, mime: spec.mime };
  cache.set(format, resolved);
  return resolved;
}

export const SUPPORTED_FORMATS = Object.keys(FORMATS);
