// Fixture selection for T20's measurement: 50 real photographs of mixed dimensions and formats.
//
// The photographs live outside the repo, at the path in the root .env (AGENTS.md, "Test/verification
// photo fixtures"). Nothing is copied into the repo and no original filename ever leaves this
// module: the harness addresses fixtures by index and the results record only format and dimensions.
// Selection is deterministic against the same directory — stride-sampling each format's candidates
// sorted by file size, which spreads the set across resolution and detail rather than picking a run
// of near-identical shots.

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

// PngSuite is a conformance suite of deliberately malformed and synthetic PNGs, not photographs.
// Including it both misses C5's "50 photographs" and breaks the dimension read on files that are
// invalid by design.
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

/** Stride-sample a size-sorted candidate list, so the picks spread across resolution. */
function sample(candidates, wanted) {
  const sorted = candidates
    .map((file) => ({ file, size: fs.statSync(file).size }))
    .sort((a, b) => a.size - b.size);

  if (sorted.length <= wanted) return sorted.map((entry) => entry.file);

  const stride = sorted.length / wanted;
  const picked = [];
  for (let i = 0; i < wanted; i++) {
    picked.push(sorted[Math.floor(i * stride)].file);
  }
  return picked;
}

// Format mix. JPEG and PNG dominate because they dominate real batches; WebP, HEIC, GIF and TIFF
// are included because they are where native decoding differs between engines — HEIC and TIFF are
// the ImageMagick-fallback cases the browser cannot decode at all.
const PLAN = [
  { format: 'jpeg', pattern: /\.jpe?g$/i, wanted: 26 },
  { format: 'png', pattern: /\.png$/i, wanted: 12 },
  { format: 'webp', pattern: /\.webp$/i, wanted: 5 },
  { format: 'heic', pattern: /\.(heic|heif)$/i, wanted: 4 },
  { format: 'gif', pattern: /\.gif$/i, wanted: 2 },
  { format: 'tiff', pattern: /\.tiff?$/i, wanted: 1 },
];

export const TOTAL_FIXTURES = PLAN.reduce((sum, entry) => sum + entry.wanted, 0);

// Spares per format, so a candidate ImageMagick cannot even read (the fixtures drive has a TIFF with
// a malformed orientation tag) can be dropped and the set still reach 50.
const SPARES = 2;

export function selectFixtures() {
  const root = readEnvVar('PHOTO_FIXTURES_DIR');
  const selected = [];

  for (const { format, pattern, wanted } of PLAN) {
    const candidates = walk(root, pattern).filter((file) => !path.basename(file).startsWith('.'));
    const picked = sample(candidates, wanted + SPARES);
    if (picked.length < wanted) {
      throw new Error(`only ${picked.length} ${format} fixtures available, wanted ${wanted}`);
    }
    for (const file of picked) {
      selected.push({ format, path: file, bytes: fs.statSync(file).size });
    }
  }

  return selected.map((entry, index) => ({ ...entry, index }));
}

/** Trims a dimension-read set back to the planned format mix, and reindexes it. */
export function trimToPlan(fixtures) {
  const trimmed = [];
  for (const { format, wanted } of PLAN) {
    const available = fixtures.filter((fixture) => fixture.format === format);
    if (available.length < wanted) {
      throw new Error(`only ${available.length} readable ${format} fixtures, wanted ${wanted}`);
    }
    trimmed.push(...available.slice(0, wanted));
  }
  return trimmed.map((entry, index) => ({ ...entry, index }));
}
