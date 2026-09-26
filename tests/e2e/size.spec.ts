import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// T30 — pipeline/stages/size.ts (Functional Design R-Q2, R-Q3, R-Q4, R-Q10; Technical Design §7.5).
//
// The search itself — where to probe, when to stop, what to keep, R-Q3's caveat — is unit-tested in
// src/pipeline/stages/size-plan.spec.ts against a size model. This file proves the two claims a
// model cannot make:
//
//   1. **A searched file is a file the quality path would also have produced.** Every probe goes
//      through `qualityForSlider` and then through the shipped stage, so the kept bytes are compared
//      here against a direct encode at the slider the search settled on. If the two ever differ, the
//      size path has grown a second set of format rules, which is the thing it was built not to do.
//   2. **The iteration counts in §7.5 are what the real axes produce**, not what a monotone model
//      produces: PNG's two-valued axis stops early, an animated PNG never searches at all (R-Q15),
//      and a GIF whose `--lossy` does nothing stops at the second probe (T28).
//
// Same constraints as encode.spec.ts and png.spec.ts: tests/e2e has no DOM lib and no path alias, so
// modules are imported inside `page.evaluate` by served path and the frame builder in
// `addInitScript` imports nothing.
const SIZE_MODULE_PATH = '/src/pipeline/stages/size.ts'
const ENCODE_MODULE_PATH = '/src/pipeline/stages/encode.ts'
const PNG_MODULE_PATH = '/src/pipeline/stages/png.ts'
const ANIMATION_MODULE_PATH = '/src/pipeline/stages/animation.ts'
const ANIMATION_PLAN_MODULE_PATH = '/src/pipeline/stages/animation-plan.ts'
const JOB_MODULE_PATH = '/src/domain/job.ts'

type Content = 'photo' | 'flat' | 'shaded'

interface RgbaFrame {
  width: number
  height: number
  pixels: Uint8Array
  colour: unknown
  sourceOrientation: unknown
}

declare function makeFrame(content: Content, width: number, height: number): RgbaFrame

function animatedFixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/animated/${name}`, import.meta.url))),
  )
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>

    scope.makeFrame = (content: string, width: number, height: number) => {
      const pixels = new Uint8Array(width * height * 4)
      const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
      let seed = 2027
      const next = () => {
        seed = (seed * 1103515245 + 12345) >>> 0
        return seed / 4294967296
      }

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4

          if (content === 'flat') {
            // Six flat blocks: well under 256 colours, so PNG quantizes it exactly and GIF's lossy
            // pass has nothing to merge. The inert end of both axes.
            const block = Math.floor((x * 3) / width) + 3 * Math.floor((y * 2) / height)
            pixels.set([30 + block * 30, 200 - block * 20, (block * 57) & 255, 255], i)
          } else if (content === 'shaded') {
            // A shaded illustration: thousands of colours from smooth shading over hard shape
            // edges, which a palette holds comfortably. This is the content that makes PNG's axis
            // genuinely two-valued — a quantized file well under the lossless one, with nothing in
            // between (§7.4).
            const u = x / width
            const v = y / height
            const shade = 0.55 + 0.45 * Math.sin(u * 3.1) * Math.cos(v * 2.3)
            const base = v > 0.55 + 0.1 * Math.sin(u * 7) ? [76, 122, 84] : [140, 196, 230]
            pixels.set(
              [clamp(base[0]! * shade), clamp(base[1]! * shade), clamp(base[2]! * shade), 255],
              i,
            )
          } else {
            // A photographic stand-in: sensor-like noise over a gradient, which every lossy encoder
            // spends real bytes on and which gives the quality axis something to move.
            const noise = () => (next() - 0.5) * 40
            pixels.set(
              [
                clamp((x * 255) / width + noise()),
                clamp((y * 255) / height + noise()),
                clamp(((x + y) * 255) / (width + height) + noise()),
                255,
              ],
              i,
            )
          }
        }
      }

      return {
        width,
        height,
        pixels,
        colour: { kind: 'untagged' },
        sourceOrientation: { kind: 'absent' },
      }
    }
  })

  await page.goto('/')
})

test('a still search returns the best-quality file that fits, and it is the quality path’s own file', async ({
  page,
}) => {
  const measured = await page.evaluate(
    async ({ sizePath, encodePath, jobPath }) => {
      const { encodeStillToSize } = await import(/* @vite-ignore */ sizePath)
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { qualityForSlider } = await import(/* @vite-ignore */ jobPath)
      const frame = makeFrame('photo', 320, 240)

      // A target between what this frame weighs at the two ends of the slider, so the search has to
      // do its interior work rather than answering from an end probe.
      const at10 = await encodeFrame(frame, 'jpeg', qualityForSlider(10, 'jpeg'))
      const at100 = await encodeFrame(frame, 'jpeg', qualityForSlider(100, 'jpeg'))
      const targetBytes = Math.round((at10.bytes.byteLength + at100.bytes.byteLength) / 2)

      const searched = await encodeStillToSize(frame, 'jpeg', targetBytes)
      const direct = await encodeFrame(frame, 'jpeg', qualityForSlider(searched.slider, 'jpeg'))
      const above = await encodeFrame(
        frame,
        'jpeg',
        qualityForSlider(Math.min(100, searched.slider + 2), 'jpeg'),
      )

      return {
        targetBytes,
        endBytes: [at10.bytes.byteLength, at100.bytes.byteLength],
        keptBytes: searched.bytes.byteLength,
        slider: searched.slider,
        reachedTarget: searched.reachedTarget,
        probeCount: searched.probes.length,
        probes: searched.probes,
        caveats: searched.caveats,
        identicalToDirect:
          searched.bytes.byteLength === direct.bytes.byteLength &&
          searched.bytes.every((byte: number, index: number) => byte === direct.bytes[index]),
        twoAboveBytes: above.bytes.byteLength,
      }
    },
    { sizePath: SIZE_MODULE_PATH, encodePath: ENCODE_MODULE_PATH, jobPath: JOB_MODULE_PATH },
  )

  // The target really is interior, so the assertions below are about the search and not about an end.
  expect(measured.endBytes[0]).toBeLessThan(measured.targetBytes)
  expect(measured.endBytes[1]).toBeGreaterThan(measured.targetBytes)

  expect(measured.reachedTarget).toBe(true)
  expect(measured.keptBytes).toBeLessThanOrEqual(measured.targetBytes)
  expect(measured.caveats).toEqual([])
  expect(measured.probeCount).toBeLessThanOrEqual(8)
  expect(measured.probes[0]?.slider).toBe(10)
  expect(measured.probes[1]?.slider).toBe(100)

  // Claim 1: the bytes are the ones the slider alone would have produced at that position.
  expect(measured.identicalToDirect).toBe(true)

  // And it is the *best* quality that fits: two positions higher does not fit. One higher is not
  // asserted — §7.5's cap can land one position short, which `size-plan.spec.ts` bounds exactly.
  expect(measured.twoAboveBytes).toBeGreaterThan(measured.targetBytes)
})

test('an unreachable target keeps the smallest result, records R-Q3’s caveat, and costs one encode', async ({
  page,
}) => {
  const measured = await page.evaluate(
    async ({ sizePath, encodePath, jobPath }) => {
      const { encodeStillToSize } = await import(/* @vite-ignore */ sizePath)
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { qualityForSlider } = await import(/* @vite-ignore */ jobPath)
      const frame = makeFrame('photo', 320, 240)
      const targetBytes = 500

      const searched = await encodeStillToSize(frame, 'jpeg', targetBytes)
      const lowest = await encodeFrame(frame, 'jpeg', qualityForSlider(10, 'jpeg'))

      return {
        targetBytes,
        keptBytes: searched.bytes.byteLength,
        lowestBytes: lowest.bytes.byteLength,
        slider: searched.slider,
        reachedTarget: searched.reachedTarget,
        probes: searched.probes,
        caveats: searched.caveats,
        head: Array.from(searched.bytes.subarray(0, 3)),
      }
    },
    { sizePath: SIZE_MODULE_PATH, encodePath: ENCODE_MODULE_PATH, jobPath: JOB_MODULE_PATH },
  )

  // R-Q3: the image is not failed, and what it achieved is what it keeps.
  expect(measured.head).toEqual([0xff, 0xd8, 0xff])
  expect(measured.reachedTarget).toBe(false)
  expect(measured.slider).toBe(10)
  expect(measured.keptBytes).toBe(measured.lowestBytes)
  expect(measured.keptBytes).toBeGreaterThan(measured.targetBytes)

  // One encode, not eight: nothing above the lowest quality can be smaller than it.
  expect(measured.probes).toEqual([{ slider: 10, bytes: measured.lowestBytes }])

  // R-X46's row: the caveat states the target and what was achieved.
  expect(measured.caveats).toEqual([
    {
      kind: 'size-target-not-reached',
      targetBytes: measured.targetBytes,
      achievedBytes: measured.keptBytes,
    },
  ])
})

test('a generous target is answered at the top of the slider in two encodes, never by inflating the file', async ({
  page,
}) => {
  const measured = await page.evaluate(
    async ({ sizePath, encodePath, jobPath }) => {
      const { encodeStillToSize } = await import(/* @vite-ignore */ sizePath)
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { qualityForSlider } = await import(/* @vite-ignore */ jobPath)
      const frame = makeFrame('photo', 320, 240)
      const at100 = await encodeFrame(frame, 'jpeg', qualityForSlider(100, 'jpeg'))
      const targetBytes = at100.bytes.byteLength * 4

      const searched = await encodeStillToSize(frame, 'jpeg', targetBytes)

      return {
        targetBytes,
        bestBytes: at100.bytes.byteLength,
        keptBytes: searched.bytes.byteLength,
        slider: searched.slider,
        probes: searched.probes.map((probe: { slider: number }) => probe.slider),
      }
    },
    { sizePath: SIZE_MODULE_PATH, encodePath: ENCODE_MODULE_PATH, jobPath: JOB_MODULE_PATH },
  )

  expect(measured.probes).toEqual([10, 100])
  expect(measured.slider).toBe(100)
  // R-Q2: the target is a ceiling, not a quota. The file is the best quality the slider offers and
  // is nowhere near the target it was allowed to fill.
  expect(measured.keptBytes).toBe(measured.bestBytes)
  expect(measured.keptBytes).toBeLessThan(measured.targetBytes)
})

test('the search covers WebP, AVIF, PNG and GIF, and each keeps a file of its own format', async ({
  page,
}) => {
  test.slow()

  const measured = await page.evaluate(
    async ({ sizePath }) => {
      const { encodeStillToSize } = await import(/* @vite-ignore */ sizePath)
      const frame = makeFrame('photo', 200, 150)
      const formats = ['webp', 'avif', 'png', 'gif'] as const
      const rows: {
        format: string
        bytes: number
        slider: number
        reachedTarget: boolean
        probes: number
        caveats: string[]
        head: number[]
      }[] = []

      for (const format of formats) {
        // One target for all four, deliberately: they do not all reach it — a photographic PNG
        // cannot come close — and what is asserted below is that each one either fits or says it
        // could not, never that it fits.
        const searched = await encodeStillToSize(frame, format, 9_000)

        rows.push({
          format,
          bytes: searched.bytes.byteLength,
          slider: searched.slider,
          reachedTarget: searched.reachedTarget,
          probes: searched.probes.length,
          caveats: searched.caveats.map((caveat: { kind: string }) => caveat.kind),
          head: Array.from(searched.bytes.subarray(0, 12)),
        })
      }

      return rows
    },
    { sizePath: SIZE_MODULE_PATH },
  )

  const byFormat = (format: string) => {
    const row = measured.find((entry) => entry.format === format)

    if (row === undefined) {
      throw new Error(`no measurement for ${format}`)
    }

    return row
  }

  for (const row of measured) {
    expect(row.probes, row.format).toBeLessThanOrEqual(8)
    expect(row.probes, row.format).toBeGreaterThanOrEqual(1)

    // R-Q3, for every format: either the file is under the target, or the report says it is not.
    if (row.reachedTarget) {
      expect(row.bytes, row.format).toBeLessThanOrEqual(9_000)
      expect(row.caveats, row.format).not.toContain('size-target-not-reached')
    } else {
      expect(row.bytes, row.format).toBeGreaterThan(9_000)
      expect(row.caveats, row.format).toContain('size-target-not-reached')
    }
  }

  // Each kept file is really that format, read from its own signature.
  expect(String.fromCharCode(...byFormat('webp').head.slice(8, 12))).toBe('WEBP')
  expect(String.fromCharCode(...byFormat('avif').head.slice(4, 12))).toBe('ftypavif')
  expect(byFormat('png').head.slice(0, 8)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(String.fromCharCode(...byFormat('gif').head.slice(0, 6))).toMatch(/^GIF8[79]a$/)
})

test('PNG’s two-valued axis stops the search early instead of spending the whole budget', async ({
  page,
}) => {
  const measured = await page.evaluate(
    async ({ sizePath, pngPath, jobPath }) => {
      const { encodeStillToSize } = await import(/* @vite-ignore */ sizePath)
      const { encodePng } = await import(/* @vite-ignore */ pngPath)
      const { qualityForSlider } = await import(/* @vite-ignore */ jobPath)
      // Shaded content: libimagequant holds it in a palette at every position it can meet, so the
      // whole of the slider below R-Q12's point returns the identical file, and everything at or
      // above it returns the lossless one (§7.4). Two outcomes, no curve.
      const frame = makeFrame('shaded', 240, 180)
      const lossless = await encodePng(frame, qualityForSlider(100, 'png'))
      const quantized = await encodePng(frame, qualityForSlider(10, 'png'))

      // Between the two outcomes the axis has, so the search must resolve the step.
      const targetBytes = Math.round((lossless.bytes.byteLength + quantized.bytes.byteLength) / 2)
      const searched = await encodeStillToSize(frame, 'png', targetBytes)

      return {
        targetBytes,
        losslessBytes: lossless.bytes.byteLength,
        quantizedBytes: quantized.bytes.byteLength,
        keptBytes: searched.bytes.byteLength,
        probes: searched.probes,
        caveats: searched.caveats,
        reachedTarget: searched.reachedTarget,
      }
    },
    { sizePath: SIZE_MODULE_PATH, pngPath: PNG_MODULE_PATH, jobPath: JOB_MODULE_PATH },
  )

  // The premise: this frame really does have two outcomes, a smaller one and a larger one.
  expect(measured.quantizedBytes).toBeLessThan(measured.losslessBytes)

  // §7.4 says a PNG size search cannot binary-search `minimum` usefully. It does not have to: the
  // third probe returns a file of a size already seen, which ends the search (see `nextSizeProbe`).
  expect(measured.probes.map((probe: { slider: number }) => probe.slider)).toEqual([10, 100, 55])
  expect(measured.reachedTarget).toBe(true)
  expect(measured.keptBytes).toBe(measured.quantizedBytes)
  // The quantized candidate is what was kept, so the report says the PNG is not lossless (R-X46).
  expect(measured.caveats).toEqual([{ kind: 'png-quantized' }])
})

test('an axis that does nothing costs two encodes, not eight', async ({ page }) => {
  const measured = await page.evaluate(
    async ({ sizePath, encodePath, jobPath }) => {
      const { encodeStillToSize } = await import(/* @vite-ignore */ sizePath)
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { qualityForSlider } = await import(/* @vite-ignore */ jobPath)
      // Flat colour into WebP: R-Q6's lossless candidate wins at every slider position, and a
      // lossless file does not change with the quality asked for. So the axis returns the identical
      // bytes from 10 to 100 — the same shape T28 measured for GIF's `--lossy` on flat content, in a
      // codec with no retry behaviour to make the assertion flaky (T28's WebKit race).
      const frame = makeFrame('flat', 240, 180)
      const at10 = await encodeFrame(frame, 'webp', qualityForSlider(10, 'webp'))
      const at100 = await encodeFrame(frame, 'webp', qualityForSlider(100, 'webp'))
      const searched = await encodeStillToSize(frame, 'webp', at10.bytes.byteLength + 1_000)

      return {
        endBytes: [at10.bytes.byteLength, at100.bytes.byteLength],
        keptBytes: searched.bytes.byteLength,
        probes: searched.probes,
        slider: searched.slider,
      }
    },
    { sizePath: SIZE_MODULE_PATH, encodePath: ENCODE_MODULE_PATH, jobPath: JOB_MODULE_PATH },
  )

  // The precondition: this really is an axis that does nothing.
  expect(measured.endBytes[0]).toBe(measured.endBytes[1])

  // Which the search discovers by probing both ends, with no test for inertness anywhere in it: the
  // top fits because the bottom did, and there is nothing left to look for.
  expect(measured.probes.map((probe: { slider: number }) => probe.slider)).toEqual([10, 100])
  expect(measured.slider).toBe(100)
  expect(measured.keptBytes).toBe(measured.endBytes[1])
})

test('an animated search fits the target, keeps every frame (R-Q10), and never searches an APNG (R-Q15)', async ({
  page,
}) => {
  test.slow()

  const measured = await page.evaluate(
    async ({ sizePath, animationPath, planPath, source }) => {
      const { encodeAnimatedToSize } = await import(/* @vite-ignore */ sizePath)
      const { decodeAnimation } = await import(/* @vite-ignore */ animationPath)
      const plan = await import(/* @vite-ignore */ planPath)
      const animation = await decodeAnimation(new Uint8Array(source))

      const webp = await encodeAnimatedToSize(animation, 'webp', 200_000)
      const png = await encodeAnimatedToSize(animation, 'png', 200_000)
      const gif = await encodeAnimatedToSize(animation, 'gif', 200_000)

      const readWebp = plan.readWebpAnimation(webp.bytes)
      const readPng = plan.readApngAnimation(png.bytes)
      const readGif = plan.readGifAnimation(gif.bytes)

      return {
        sourceFrames: animation.frames.length,
        webp: {
          bytes: webp.bytes.byteLength,
          probes: webp.probes.length,
          reachedTarget: webp.reachedTarget,
          frames: readWebp.frameCount,
        },
        png: {
          bytes: png.bytes.byteLength,
          probes: png.probes.length,
          slider: png.slider,
          reachedTarget: png.reachedTarget,
          frames: readPng.frameCount,
        },
        gif: {
          bytes: gif.bytes.byteLength,
          probes: gif.probes.length,
          reachedTarget: gif.reachedTarget,
          frames: readGif.frameCount,
        },
      }
    },
    {
      sizePath: SIZE_MODULE_PATH,
      animationPath: ANIMATION_MODULE_PATH,
      planPath: ANIMATION_PLAN_MODULE_PATH,
      source: animatedFixture('anim-6f.gif'),
    },
  )

  expect(measured.sourceFrames).toBe(6)

  for (const [format, row] of Object.entries(measured).filter(([key]) => key !== 'sourceFrames')) {
    const animated = row as { bytes: number; reachedTarget: boolean; frames: number }

    expect(animated.reachedTarget, format).toBe(true)
    expect(animated.bytes, format).toBeLessThanOrEqual(200_000)
    // R-Q10: the search never buys size by dropping frames.
    expect(animated.frames, format).toBe(6)
  }

  // R-Q15: an animated PNG is lossless at every slider position, so there is nothing to search and
  // exactly one encode is paid for.
  expect(measured.png.probes).toBe(1)
  expect(measured.png.slider).toBe(100)
})
