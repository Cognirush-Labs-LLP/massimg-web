// T23 — colour management (docs/assumptions.md D3 and A13, Technical Design §7.7).
//
// Two measurements, one run:
//
//   D3 "ICC profiles survive every encoder path" — an embedded profile taken through each encoder
//      in §4.2's stage table, in three browsers. Reported per path as identical / changed / gone.
//
//   A13 "Colour is often signalled by CICP, not an ICC profile" — a *real* HEIC, rewritten in
//      memory to signal its colour only with an `nclx` box, decoded and read with the shipped
//      pipeline/stages/colour.ts. This is the half that cannot live in the permanent suite: no
//      CICP-only HEIC can be committed (see heic.mjs).
//
// The profile used is tests/fixtures/decode/icc-profile.bin — built by scripts/build-test-fixtures.mjs,
// so it is this repository's own bytes and carries no third-party licence.
//
// Run: pnpm install && pnpm test. T23_QUICK=1 does Chromium only. The D3 half needs no `.env`; the
// A13 half reads PHOTO_FIXTURES_DIR and reports `skipped` with a reason if it is unset or has no
// suitable file. No filename, path or image content from that directory reaches results.json.

import { chromium, firefox, webkit } from 'playwright'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

import { initializeImageMagick, ImageMagick } from '@imagemagick/magick-wasm'
import { colrBoxes, heifCandidates, rewriteToCicpOnly } from './heic.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const QUICK = Boolean(process.env.T23_QUICK)
const PORT = 5181
const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit }

/** Display P3 primaries, sRGB transfer, BT.601 matrix — the same values the committed fixture uses. */
const CICP = { primaries: 12, transfer: 13, matrix: 6, fullRange: true }

function readEnvVar(name) {
  let content
  try {
    content = readFileSync(join(REPO_ROOT, '.env'), 'utf8')
  } catch {
    return null
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() === name) return line.slice(eq + 1).trim() || null
  }
  return null
}

function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url)
        .then(resolve)
        .catch(() => {
          if (Date.now() > deadline) reject(new Error(`server did not start: ${url}`))
          else setTimeout(attempt, 200)
        })
    }
    attempt()
  })
}

// ---------------------------------------------------------------------------------------------
// A13 — a real HEIC whose colour is signalled only by CICP.
// ---------------------------------------------------------------------------------------------

function samplePixels(bytes) {
  return ImageMagick.read(bytes, (image) => ({
    width: image.width,
    height: image.height,
    iccDescription: image.getColorProfile()?.description ?? null,
    profileNames: [...image.profileNames],
    // ImageMagick's own idea of the primaries, for the record: it is the same default for every
    // file, which is why it cannot be used as colour evidence.
    chromaticityRed: [image.chromaticity.red.x, image.chromaticity.red.y],
    head: Array.from(image.getPixels((p) => p.toByteArray(0, 0, Math.min(8, image.width), 1, 'RGB')).slice(0, 24)),
  }))
}

async function measureRealHeic(readCicp, resolveFrameColour) {
  const directory = readEnvVar('PHOTO_FIXTURES_DIR')
  if (!directory) {
    return { status: 'skipped', reason: 'PHOTO_FIXTURES_DIR is not set in .env' }
  }

  await initializeImageMagick(
    readFileSync(join(__dirname, 'node_modules', '@imagemagick', 'magick-wasm', 'dist', 'x86', 'magick.wasm')),
  )

  const candidates = heifCandidates(directory)
  if (candidates.length === 0) {
    return { status: 'skipped', reason: 'no HEIC/HEIF/AVIF files under PHOTO_FIXTURES_DIR' }
  }

  // What the real files in the set actually signal, with no filename recorded.
  const survey = candidates.map(({ extension, bytes }) => {
    const boxes = colrBoxes(bytes)
    let decoded = null
    try {
      decoded = samplePixels(bytes)
    } catch {
      /* unreadable by ImageMagick; recorded as such */
    }
    return {
      extension,
      sizeBytes: bytes.length,
      colrBoxes: boxes.map((entry) =>
        entry.kind === 'nclx'
          ? { kind: entry.kind, primaries: entry.primaries, transfer: entry.transfer, matrix: entry.matrix }
          : { kind: entry.kind, payloadBytes: entry.payloadBytes },
      ),
      imageMagickReportsIcc: decoded ? decoded.iccDescription !== null : null,
      shippedReaderFindsCicp: readCicp(new Uint8Array(bytes)),
      // What the frame would actually carry. The interesting row is a file with *both* an ICC
      // profile and an `nclx` box associated with its primary item: R-I12 names the profile as the
      // thing preserved, so `icc` is the correct answer and `cicp` would be a regression.
      shippedResolvesTo: decoded
        ? resolveFrameColour(
            decoded.iccDescription === null
              ? null
              : { profile: new Uint8Array(0), description: decoded.iccDescription },
            new Uint8Array(bytes),
          ).kind
        : null,
    }
  })

  const rewritable = candidates.find(
    ({ extension, bytes }) => /heic|heif/i.test(extension) && colrBoxes(bytes).some((b) => b.kind === 'prof'),
  )
  if (!rewritable) {
    return {
      status: 'partial',
      reason: 'no real HEIC with an ICC colr box to rewrite into a CICP-only one',
      survey,
    }
  }

  const original = samplePixels(rewritable.bytes)
  const rewritten = rewriteToCicpOnly(rewritable.bytes, CICP)
  const afterRewrite = samplePixels(rewritten)
  const readBack = readCicp(new Uint8Array(rewritten))

  return {
    status: 'measured',
    survey,
    cicpOnlyHeic: {
      sourceSizeBytes: rewritable.bytes.length,
      dimensions: `${original.width}x${original.height}`,
      original: {
        iccDescription: original.iccDescription,
        profileNames: original.profileNames,
        shippedReaderFindsCicp: readCicp(new Uint8Array(rewritable.bytes)),
      },
      cicpOnly: {
        iccDescription: afterRewrite.iccDescription,
        profileNames: afterRewrite.profileNames,
        imageMagickChromaticityRed: afterRewrite.chromaticityRed,
        shippedReaderFindsCicp: readBack,
      },
      // The whole point: identical pixels, no ICC profile, and the colour recoverable only through
      // the `colr` box. A pipeline that asks ImageMagick alone sees an untagged image here.
      pixelsIdentical: JSON.stringify(original.head) === JSON.stringify(afterRewrite.head),
      cicpRoundTripped:
        readBack !== null &&
        readBack.primaries === CICP.primaries &&
        readBack.transfer === CICP.transfer &&
        readBack.matrix === CICP.matrix,
    },
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const icc = Array.from(readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'decode', 'icc-profile.bin')))

  // The shipped colr reader, loaded from source rather than reimplemented here, so A13's conclusion
  // is about the module that ships. colour.ts imports only types, so no alias resolution is needed.
  const repoServer = await createServer({
    root: REPO_ROOT,
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    // This server exists only to load one module through `ssrLoadModule`; without this it scans the
    // app entry point for dependencies to pre-bundle and reports the `@/` alias as unresolvable,
    // which is noise rather than a finding (the alias lives in the repository's own vite.config.ts,
    // which `configFile: false` deliberately does not load).
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  const { readCicp, resolveFrameColour } = await repoServer.ssrLoadModule(
    '/src/pipeline/stages/colour.ts',
  )

  process.stdout.write('A13 — real HEIC CICP signalling\n')
  const heic = await measureRealHeic(readCicp, resolveFrameColour)
  process.stdout.write(`  ${heic.status}${heic.reason ? `: ${heic.reason}` : ''}\n`)
  if (heic.cicpOnlyHeic) {
    process.stdout.write(
      `  pixels identical after rewrite: ${heic.cicpOnlyHeic.pixelsIdentical}, CICP round-tripped: ${heic.cicpOnlyHeic.cicpRoundTripped}\n`,
    )
  }
  await repoServer.close()

  process.stdout.write('\nD3 — ICC survival per encoder path\n')
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: __dirname,
    stdio: 'ignore',
  })
  const engines = {}
  try {
    await waitForServer(`http://localhost:${PORT}/`)

    for (const [name, engine] of Object.entries(ENGINES)) {
      const browser = await engine.launch()
      const page = await browser.newPage()
      page.on('pageerror', (error) => process.stdout.write(`    page error: ${error.message}\n`))
      page.on('console', (message) => {
        if (message.type() === 'error') process.stdout.write(`    console: ${message.text()}\n`)
      })
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })
      await page.waitForFunction(() => Boolean(window.t23))
      engines[name] = await page.evaluate((bytes) => window.t23.measureIccSurvival(bytes), icc)
      await browser.close()

      process.stdout.write(`  ${name}\n`)
      for (const [path, result] of Object.entries(engines[name])) {
        process.stdout.write(
          `    ${path.padEnd(24)} profile=${result.profile}${result.profile === 'present' ? ` identical=${result.identical}` : ''}\n`,
        )
      }
    }
  } finally {
    vite.kill()
  }

  const results = {
    task: 'T23',
    measuredAt: new Date().toISOString(),
    profileBytes: icc.length,
    a13: heic,
    d3: { engines },
  }
  writeFileSync(join(__dirname, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  process.stdout.write('\nwrote results.json\n')
}

await main()
