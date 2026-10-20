import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { skipWebKitOutsideMac } from './webkit-platform'

// T28 — the GIF path end to end (Functional Design R-Q8, R-Q9, R-Q10, R-F5, R-I12; Technical Design
// §4.2's GIF row, §7.3, §7.4).
//
//   ImageMagick writes the GIF  ->  gifsicle optimises it  ->  keep whichever is smaller
//
// Three rules shape the assertions, and the first two are T29's, kept deliberately.
//
//   1. **The numbers come from our own container reader**, `animation-plan.ts`'s `readGifAnimation`,
//      which shares no code with either encoder and is itself unit-tested against hand-built
//      containers. Asking ImageMagick what it just wrote would be asking the wrong witness.
//   2. **The fixtures were written by ffmpeg**, never by ImageMagick or gifsicle. A round trip
//      through the library under test only proves the library agrees with itself (T26, T27).
//   3. **The one fixture that can show what gifsicle is for is `anim-scene.gif`.** Every other
//      animated fixture is flat colour, which is the worst case for both of gifsicle's levers —
//      `-O2` finds nothing unchanged between frames and `--lossy` finds no near-duplicate palette
//      entries to merge. See `sceneFrameImage` in scripts/build-animated-fixtures.mjs.
//
// Same DOM/dynamic-import constraint as animation.spec.ts: tests/e2e compiles under
// tsconfig.node.json, so the modules under test are imported inside `page.evaluate` by their served
// paths and every result is mapped to a plain serializable shape before it crosses back to Node.
const ANIMATION_MODULE_PATH = '/src/pipeline/stages/animation.ts'
const ANIMATION_PLAN_MODULE_PATH = '/src/pipeline/stages/animation-plan.ts'
const DECODE_MODULE_PATH = '/src/pipeline/stages/decode.ts'
const FRAME_MODULE_PATH = '/src/pipeline/stages/frame.ts'
const GIF_MODULE_PATH = '/src/pipeline/stages/gif.ts'
const RESIZE_MODULE_PATH = '/src/pipeline/stages/resize.ts'
const JOB_MODULE_PATH = '/src/domain/job.ts'

// What scripts/build-animated-fixtures.mjs wrote, restated so that a change to the generator which
// nobody meant fails a test rather than quietly moving the goalposts.
const WIDTH = 64
const HEIGHT = 64
const DELAYS_MS = [40, 120, 40, 200, 80, 40]
const FRAME_COUNT = 6
/** The stored NETSCAPE2.0 value in every six-frame fixture. GIF stores repeats, so this plays 4. */
const STORED_LOOPS = 3

/** The scene fixture (T28): ten frames, 128x96, one moving block over a fixed detailed background. */
const SCENE_FRAMES = 10
const SCENE_DELAY_MS = 40

/** The white 16x16 marker, sampled at its centre. */
const MARKER = { x: 8, y: 8 }
/** Inside the flat colour field, clear of both the marker and the transparent corner. */
const BODY = { x: 32, y: 32 }
/** Inside the fully transparent 24x24 corner. */
const HOLE = { x: 50, y: 50 }

/** One flat colour per frame, so "frame 3 is frame 3" is checkable rather than "there are six". */
const FRAME_COLOURS = [
  [230, 25, 25],
  [25, 200, 25],
  [25, 60, 230],
  [235, 215, 30],
  [30, 210, 215],
  [220, 40, 210],
]

/** GIF is a palette format; this margin absorbs a future regeneration picking a nearby palette. */
const CHANNEL_TOLERANCE = 8

function fixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/animated/${name}`, import.meta.url))),
  )
}

function decodeFixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/decode/${name}`, import.meta.url))),
  )
}

const ICC_PROFILE = decodeFixture('icc-profile.bin')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

/**
 * The size the stage should have returned: the smaller candidate, or ImageMagick's alone when
 * gifsicle never produced one.
 *
 * `sizes.gifsicle` is nullable because gifsicle genuinely fails sometimes — about one run in five on
 * WebKit, measured (see `GIFSICLE_ATTEMPTS`). Four attempts make that rare rather than impossible,
 * so a test that assumed a number here would be the flakiest test in the suite.
 */
function smallerOf(encoded: EncodedGif): number {
  return encoded.sizes.gifsicle === null
    ? encoded.sizes.imagemagick
    : Math.min(encoded.sizes.gifsicle, encoded.sizes.imagemagick)
}

interface Point {
  x: number
  y: number
}

interface EncodedGif {
  byteLength: number
  ownsWholeBuffer: boolean
  frameCount: number
  /** Milliseconds, as the written Graphic Control Extensions hold them. */
  delaysMs: number[]
  /** Total plays, through `gifTotalPlays` — the file stores repeats, not plays. */
  plays: number
  /** Whether the file carries a NETSCAPE2.0 block at all. Three states, not a nullable number. */
  loopSignal: string
  width: number
  height: number
  branch: string
  lossy: number | null
  sizes: { imagemagick: number; gifsicle: number | null }
  /** How many times gifsicle was asked. Above 1 means it failed and was retried. */
  gifsicleAttempts: number
  caveats: { kind: string }[]
  /** Every application extension identifier in the file, in order. */
  applications: string[]
  /** The bytes of the ICC application extension's payload, or null when there is none. */
  iccProfile: number[] | null
  /** Per-frame RGBA at the sample points, or `null` when the engine has no animation decoder. */
  rendered: number[][][] | null
  decodedBy: string
}

// The browser APIs the page callback uses, declared minimally because tests/e2e has no DOM lib.
interface Canvas2d {
  clearRect(x: number, y: number, width: number, height: number): void
  drawImage(image: unknown, x: number, y: number): void
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray }
}
declare const OffscreenCanvas: new (
  width: number,
  height: number,
) => { width: number; height: number; getContext(id: '2d'): Canvas2d | null }
declare const Blob: new (parts: BlobPart[], options?: { type: string }) => BlobPart
type BlobPart = unknown
declare function createImageBitmap(source: unknown): Promise<{ width: number; height: number }>

interface EncodeOptions {
  slider?: number
  points?: Point[]
  /** Decode as a still image and wrap it with `singleFrameAnimation`, as `executeJob` does. */
  still?: boolean
  dimension?: unknown
}

/**
 * Decodes `name`, runs `encodeGif`, and reads the result back.
 *
 * The read-back is deliberately done twice: once through `animation-plan.ts`'s GIF reader for the
 * counts and the timings, and once through the browser's own `ImageDecoder` for the pixels.
 */
async function encodeGif(
  page: Page,
  name: string,
  options: EncodeOptions = {},
): Promise<EncodedGif> {
  return page.evaluate(
    async ({
      animationPath,
      decodePath,
      framePath,
      gifPath,
      planPath,
      resizePath,
      jobPath,
      bytes,
      sourceFormat,
      slider,
      points,
      still,
      dimension,
    }) => {
      const stages = await import(/* @vite-ignore */ animationPath)
      const decode = await import(/* @vite-ignore */ decodePath)
      const frames = await import(/* @vite-ignore */ framePath)
      const gif = await import(/* @vite-ignore */ gifPath)
      const plan = await import(/* @vite-ignore */ planPath)
      const job = await import(/* @vite-ignore */ jobPath)
      const resize = await import(/* @vite-ignore */ resizePath)

      // The real quality resolution, never a second copy of §7.4's mapping in this file.
      const resolution = job.resolveSettings(
        { sourceFormat, isAnimated: !still, edit: null },
        {
          quality: { kind: 'quality', value: slider },
          dimension: dimension ?? { kind: 'original' },
          format: 'gif',
        },
      )

      if (resolution.kind !== 'resolved') {
        throw new Error(`settings did not resolve: ${JSON.stringify(resolution)}`)
      }

      const source = new Uint8Array(bytes)
      let animation = still
        ? frames.singleFrameAnimation(await decode.decodeFrame(source))
        : await stages.decodeAnimation(source)

      if (dimension) {
        animation = still
          ? frames.singleFrameAnimation(
              await resize.applyResize(animation.frames[0], resolution.settings.dimension),
            )
          : await stages.applyResizeFrames(animation, resolution.settings.dimension)
      }

      const encoded = await gif.encodeGif(animation, resolution.settings.quality)
      const out = encoded.bytes as Uint8Array
      const info = plan.readGifAnimation(out)

      // Application extensions, read here rather than by any module under test: walk the block
      // chain and collect each extension's 11-byte identifier, keeping the ICC payload whole. This
      // is the only independent witness to R-I12 on this path — a profile read back with
      // ImageMagick would only prove ImageMagick agrees with itself.
      const applications: string[] = []
      let iccProfile: number[] | null = null
      {
        let at = 13
        const packed = out[10] as number
        if (packed & 0x80) at += 3 * (1 << ((packed & 0x07) + 1))

        const skipBlocks = (start: number): { blocks: number[][]; end: number } => {
          const blocks: number[][] = []
          let offset = start
          for (;;) {
            const size = out[offset] as number
            offset += 1
            if (size === 0) return { blocks, end: offset }
            blocks.push(Array.from(out.subarray(offset, offset + size)))
            offset += size
          }
        }

        for (;;) {
          const marker = out[at]
          at += 1
          if (marker === 0x3b || marker === undefined) break

          if (marker === 0x21) {
            const label = out[at] as number
            const { blocks, end } = skipBlocks(at + 1)
            at = end
            if (label === 0xff && blocks[0]) {
              const identifier = String.fromCharCode(...blocks[0].slice(0, 11))
              applications.push(identifier)
              if (identifier.startsWith('ICCRGBG')) {
                // Every sub-block after the identifier, concatenated, is the profile.
                iccProfile = blocks.slice(1).flat()
              }
            }
            continue
          }

          if (marker === 0x2c) {
            const descriptorPacked = out[at + 8] as number
            at += 9
            if (descriptorPacked & 0x80) at += 3 * (1 << ((descriptorPacked & 0x07) + 1))
            at = skipBlocks(at + 1).end
            continue
          }

          break
        }
      }

      // The engine's own decoder, where it has one.
      let rendered: number[][][] | null = null
      let decodedBy = 'none'
      const decoderCtor = (globalThis as Record<string, unknown>).ImageDecoder as
        | (new (init: { data: Uint8Array; type: string }) => {
            tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }
            decode(options: { frameIndex: number }): Promise<{ image: unknown }>
          })
        | undefined

      if (decoderCtor && points.length > 0) {
        try {
          const decoder = new decoderCtor({ data: out, type: 'image/gif' })
          await decoder.tracks.ready
          const count = decoder.tracks.selectedTrack?.frameCount ?? 0
          const sampled: number[][][] = []

          for (let index = 0; index < count; index += 1) {
            const { image } = await decoder.decode({ frameIndex: index })
            const video = image as unknown as {
              displayWidth: number
              displayHeight: number
              close(): void
            }
            const canvas = new OffscreenCanvas(video.displayWidth, video.displayHeight)
            const context = canvas.getContext('2d') as Canvas2d
            context.clearRect(0, 0, canvas.width, canvas.height)
            context.drawImage(image, 0, 0)
            sampled.push(
              points.map((point) => {
                const data = context.getImageData(point.x, point.y, 1, 1).data
                return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0]
              }),
            )
            video.close()
          }

          rendered = sampled
          decodedBy = 'ImageDecoder'
        } catch {
          rendered = null
          decodedBy = 'none'
        }
      }

      return {
        byteLength: out.byteLength,
        ownsWholeBuffer: out.byteOffset === 0 && out.byteLength === out.buffer.byteLength,
        frameCount: info.frameCount,
        delaysMs: info.frames.map((frame: { delayMs: number }) => frame.delayMs),
        plays: plan.gifTotalPlays(info.loopSignal),
        loopSignal: info.loopSignal.kind,
        width: info.width,
        height: info.height,
        branch: encoded.branch,
        lossy: encoded.lossy,
        sizes: encoded.sizes,
        gifsicleAttempts: encoded.gifsicleAttempts,
        caveats: encoded.caveats,
        applications,
        iccProfile,
        rendered,
        decodedBy,
      }
    },
    {
      animationPath: ANIMATION_MODULE_PATH,
      decodePath: DECODE_MODULE_PATH,
      framePath: FRAME_MODULE_PATH,
      gifPath: GIF_MODULE_PATH,
      planPath: ANIMATION_PLAN_MODULE_PATH,
      resizePath: RESIZE_MODULE_PATH,
      jobPath: JOB_MODULE_PATH,
      bytes: name.endsWith('.jpg') ? decodeFixture(name) : fixture(name),
      sourceFormat: name.endsWith('.jpg')
        ? 'jpeg'
        : name.endsWith('.webp')
          ? 'webp'
          : name.endsWith('.png')
            ? 'png'
            : 'gif',
      slider: options.slider ?? 80,
      points: options.points ?? [],
      still: options.still ?? false,
      dimension: options.dimension ?? null,
    },
  )
}

// ---------------------------------------------------------------------------------------------
// R-Q10 and R-Q9: what comes out is what went in, from all three animated sources.
// ---------------------------------------------------------------------------------------------

const SOURCES = [
  // A GIF stores *repeats*, so its stored 3 is four plays and the output must store 3 again.
  { label: 'GIF', name: 'anim-6f.gif', plays: STORED_LOOPS + 1, stored: STORED_LOOPS },
  // WebP and APNG store *plays*, so their stored 3 is three plays and the output stores 2.
  { label: 'WebP', name: 'anim-6f.webp', plays: STORED_LOOPS, stored: STORED_LOOPS - 1 },
  { label: 'APNG', name: 'anim-6f.png', plays: STORED_LOOPS, stored: STORED_LOOPS - 1 },
]

for (const source of SOURCES) {
  test.describe(`${source.label} source to GIF`, () => {
    test('keeps the frame count exactly (R-Q10)', async ({ page }) => {
      expect((await encodeGif(page, source.name)).frameCount).toBe(FRAME_COUNT)
    })

    test('keeps every frame delay (R-Q9)', async ({ page }) => {
      expect((await encodeGif(page, source.name)).delaysMs).toEqual(DELAYS_MS)
    })

    // The conversion this whole path turns on: total plays in, the container's own convention out.
    test('keeps the loop count as total plays (R-Q9)', async ({ page }) => {
      expect((await encodeGif(page, source.name)).plays).toBe(source.plays)
    })

    test('keeps the canvas size', async ({ page }) => {
      const encoded = await encodeGif(page, source.name)

      expect([encoded.width, encoded.height]).toEqual([WIDTH, HEIGHT])
    })

    test('hands back bytes that own their buffer', async ({ page }) => {
      expect((await encodeGif(page, source.name)).ownsWholeBuffer).toBe(true)
    })

    // Colour only. WebKit's `ImageDecoder` reports 255 for a fully transparent pixel where
    // `createImageBitmap` reports 0 (recorded in T29), so the alpha claim is made against the
    // latter, in its own test below, rather than being skipped on one engine.
    test('renders the frames in order, in the engine’s own decoder', async ({ page }, testInfo) => {
      skipWebKitOutsideMac(
        testInfo.project.name,
        'Linux WebKit renders animated frames as blank pixels, so per-frame content cannot be checked',
      )

      const encoded = await encodeGif(page, source.name, { points: [BODY, MARKER] })

      if (encoded.decodedBy === 'none') {
        test.skip(true, 'this engine has no ImageDecoder')
        return
      }

      expect(encoded.rendered).toHaveLength(FRAME_COUNT)

      encoded.rendered?.forEach((frame, index) => {
        const [body, marker] = frame
        const expected = FRAME_COLOURS[index] as number[]

        for (let channel = 0; channel < 3; channel += 1) {
          expect(
            Math.abs((body?.[channel] ?? 0) - (expected[channel] as number)),
          ).toBeLessThanOrEqual(CHANNEL_TOLERANCE)
          expect(marker?.[channel]).toBeGreaterThan(255 - CHANNEL_TOLERANCE)
        }
      })
    })

    test('carries no comment or metadata extension', async ({ page }) => {
      const encoded = await encodeGif(page, source.name)

      // NETSCAPE2.0 is the loop record and belongs here; nothing else should be.
      expect(encoded.applications.filter((id) => id !== 'NETSCAPE2.0')).toEqual([])
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Transparency. GIF's is one palette index rather than a channel, which is the whole of the risk:
// a fully transparent pixel that is written as a colour instead comes back opaque.
// ---------------------------------------------------------------------------------------------

test('keeps the transparent corner transparent in every frame', async ({ page }) => {
  const checked = await page.evaluate(
    async ({ animationPath, gifPath, jobPath, bytes, hole }) => {
      const stages = await import(/* @vite-ignore */ animationPath)
      const gif = await import(/* @vite-ignore */ gifPath)
      const job = await import(/* @vite-ignore */ jobPath)

      const resolution = job.resolveSettings(
        { sourceFormat: 'webp', isAnimated: true, edit: null },
        {
          quality: { kind: 'quality', value: 80 },
          dimension: { kind: 'original' },
          format: 'gif',
        },
      )
      const animation = await stages.decodeAnimation(new Uint8Array(bytes))
      const encoded = await gif.encodeGif(animation, resolution.settings.quality)
      const out = encoded.bytes as Uint8Array

      // Every frame, through the pipeline's own decoder — which is not the encoder.
      const decoded = await stages.decodeAnimation(out)
      const perFrameAlpha = decoded.frames.map(
        (frame: { pixels: Uint8Array; width: number }) =>
          frame.pixels[(hole.y * frame.width + hole.x) * 4 + 3],
      )

      // The first frame, through the engine's own image decoder. `createImageBitmap` rather than
      // `ImageDecoder`: WebKit's `ImageDecoder` reports 255 here whatever the file says (T29).
      const blob = new Blob([out], { type: 'image/gif' })
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d') as Canvas2d
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(bitmap, 0, 0)

      return { perFrameAlpha, engineAlpha: context.getImageData(hole.x, hole.y, 1, 1).data[3] }
    },
    {
      animationPath: ANIMATION_MODULE_PATH,
      gifPath: GIF_MODULE_PATH,
      jobPath: JOB_MODULE_PATH,
      bytes: fixture('anim-6f.webp'),
      hole: HOLE,
    },
  )

  expect(checked.perFrameAlpha, 'every frame').toEqual([0, 0, 0, 0, 0, 0])
  expect(checked.engineAlpha, 'first frame in the engine').toBe(0)
})

// ---------------------------------------------------------------------------------------------
// The loop record's three states. `absent` is a state, not a missing number.
// ---------------------------------------------------------------------------------------------

test.describe('the loop record', () => {
  test('writes an infinite loop back as infinite', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-loop0.gif')

    expect(encoded.plays).toBe(0)
    expect(encoded.loopSignal).toBe('present')
  })

  // The state most easily confused with "loop for ever": a GIF with no NETSCAPE2.0 block plays once,
  // and the output must say the same thing the same way rather than writing an explicit 1.
  test('writes a file that plays once with no loop block at all', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-loopnone.gif')

    expect(encoded.plays).toBe(1)
    expect(encoded.loopSignal).toBe('absent')
    expect(encoded.applications).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// R-Q8: gifsicle is here because its output is substantially smaller. Measured, not assumed.
// ---------------------------------------------------------------------------------------------

test.describe('R-Q8, what gifsicle is for', () => {
  test('is substantially smaller than ImageMagick’s GIF writer alone', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-scene.gif', { slider: 100 })

    expect(encoded.branch).toBe('gifsicle')
    expect(encoded.sizes.gifsicle).not.toBeNull()
    // Measured at 93,634 -> 15,533 on Chromium, an 83% reduction. Half of that is the floor this
    // asserts, so a smaller win still passes and a lost optimisation does not.
    expect(encoded.sizes.gifsicle as number).toBeLessThan(encoded.sizes.imagemagick * 0.5)
    expect(encoded.byteLength).toBe(encoded.sizes.gifsicle)
  })

  // The guard that stops the fallback in rule 6 from hiding a permanently broken gifsicle: if the
  // optimiser ever stops working entirely, this is what says so instead of everyone quietly
  // receiving six-times-larger GIFs.
  test('asks gifsicle once when it answers, and uses what it says', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-scene.gif', { slider: 100 })

    expect(encoded.gifsicleAttempts).toBeGreaterThanOrEqual(1)
    expect(encoded.gifsicleAttempts).toBeLessThanOrEqual(4)
    expect(encoded.branch).toBe('gifsicle')
  })

  test('preserves the animation exactly while doing it', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-scene.gif', { slider: 100 })

    expect(encoded.frameCount).toBe(SCENE_FRAMES)
    expect(encoded.delaysMs).toEqual(new Array(SCENE_FRAMES).fill(SCENE_DELAY_MS))
    expect(encoded.plays).toBe(STORED_LOOPS + 1)
  })

  // §7.1's GIF row: above slider 95 the palette is preserved and no lossy pass runs.
  test('takes no lossy pass above slider 95', async ({ page }) => {
    expect((await encodeGif(page, 'anim-scene.gif', { slider: 96 })).lossy).toBeNull()
    expect((await encodeGif(page, 'anim-scene.gif', { slider: 100 })).lossy).toBeNull()
  })

  test('takes one at 95 and below, harder as the slider falls', async ({ page }) => {
    const gentle = await encodeGif(page, 'anim-scene.gif', { slider: 95 })
    const hard = await encodeGif(page, 'anim-scene.gif', { slider: 10 })

    expect(gentle.lossy).toBe(20)
    expect(hard.lossy).toBe(200)
    expect(hard.byteLength).toBeLessThan(gentle.byteLength)
  })

  // The slider moving must actually move the file, or the control is decorative.
  test('a lower slider produces a smaller file', async ({ page }) => {
    const sizes = []

    for (const slider of [100, 80, 40, 10]) {
      sizes.push((await encodeGif(page, 'anim-scene.gif', { slider })).byteLength)
    }

    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index]).toBeLessThan(sizes[index - 1] as number)
    }
  })

  // Rule 3 in gif.ts: on flat content the lossy pass can cost bytes, and the user never receives the
  // larger file. Which branch wins here is content-dependent; that the kept bytes are the smaller of
  // the two is not.
  test('never returns the larger of the two candidates', async ({ page }) => {
    for (const name of ['anim-6f.gif', 'anim-scene.gif', 'anim-disposal.gif']) {
      for (const slider of [10, 80, 100]) {
        const encoded = await encodeGif(page, name, { slider })

        expect(encoded.byteLength, `${name} at ${slider}`).toBe(smallerOf(encoded))
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The still path, which reaches the same encoder through `singleFrameAnimation`.
// ---------------------------------------------------------------------------------------------

test.describe('a still image to GIF', () => {
  test('writes one frame, with no loop block and no duration', async ({ page }) => {
    const encoded = await encodeGif(page, 'orientation-1.jpg', { still: true })

    expect(encoded.frameCount).toBe(1)
    expect(encoded.delaysMs).toEqual([0])
    expect(encoded.loopSignal).toBe('absent')
    expect(encoded.plays).toBe(1)
    expect(encoded.ownsWholeBuffer).toBe(true)
  })

  test('is compressed by gifsicle like an animated one', async ({ page }) => {
    const encoded = await encodeGif(page, 'orientation-1.jpg', { still: true, slider: 40 })

    expect(encoded.lossy).toBe(89)
    expect(encoded.byteLength).toBe(smallerOf(encoded))
  })

  // A single-frame GIF source is *not* animated (domain/classify.ts), so it takes this path too.
  test('takes a single-frame GIF through the still path', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-1f.gif', { still: true })

    expect(encoded.frameCount).toBe(1)
    expect([encoded.width, encoded.height]).toEqual([WIDTH, HEIGHT])
  })
})

// ---------------------------------------------------------------------------------------------
// Colour (R-I12). GIF *can* carry an ICC profile in this build — see `ColourFormat` in
// encode-plan.ts and docs/task-notes/T28.md; R-I13 has been corrected to say so.
// ---------------------------------------------------------------------------------------------

test.describe('animated output colour', () => {
  test('carries the source profile into the GIF, byte for byte', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-icc.webp')

    expect(encoded.applications).toContain('ICCRGBG1012')
    expect(encoded.iccProfile).toEqual(ICC_PROFILE)
  })

  test('adds no profile to an untagged animation (R-I14)', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-6f.gif')

    expect(encoded.iccProfile).toBeNull()
    expect(encoded.applications).toEqual(['NETSCAPE2.0'])
  })

  // The profile has to survive gifsicle as well as ImageMagick, and gifsicle is a separate program
  // with its own idea of which extensions are worth keeping. D3 measured this for a still GIF; this
  // is the animated case, on the branch that actually ships gifsicle's bytes.
  test('keeps the profile through the optimiser, not only through the writer', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-icc.webp', { slider: 10 })

    expect(encoded.branch).toBe('gifsicle')
    expect(encoded.iccProfile).toEqual(ICC_PROFILE)
  })

  // CORE-005: writing a profile is only half a round trip. `decodeAnimation` used to hardcode
  // `untagged` for every GIF, so this pipeline could not read back the profile it had just written —
  // proven here by feeding the GIF this suite already proves carries one straight back into the real
  // animated decoder.
  test('reads the profile back through the animated decoder it wrote it with (CORE-005)', async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ({ animationPath, gifPath, jobPath, bytes }) => {
        const stages = await import(/* @vite-ignore */ animationPath)
        const gif = await import(/* @vite-ignore */ gifPath)
        const job = await import(/* @vite-ignore */ jobPath)

        const resolution = job.resolveSettings(
          { sourceFormat: 'webp', isAnimated: true, edit: null },
          {
            quality: { kind: 'quality', value: 80 },
            dimension: { kind: 'original' },
            format: 'gif',
          },
        )

        if (resolution.kind !== 'resolved') {
          throw new Error(`settings did not resolve: ${JSON.stringify(resolution)}`)
        }

        const source = new Uint8Array(bytes)
        const animation = await stages.decodeAnimation(source)
        const encoded = await gif.encodeGif(animation, resolution.settings.quality)
        const roundTripped = await stages.decodeAnimation(encoded.bytes as Uint8Array)
        const colour = roundTripped.frames[0].colour as { kind: string; profile?: Uint8Array }

        return {
          frameCount: roundTripped.frames.length,
          everyFrameSameKind: roundTripped.frames.every(
            (frame: { colour: { kind: string } }) => frame.colour.kind === colour.kind,
          ),
          kind: colour.kind,
          profile: colour.profile ? Array.from(colour.profile) : null,
        }
      },
      {
        animationPath: ANIMATION_MODULE_PATH,
        gifPath: GIF_MODULE_PATH,
        jobPath: JOB_MODULE_PATH,
        bytes: fixture('anim-icc.webp'),
      },
    )

    expect(result.frameCount).toBeGreaterThan(1)
    expect(result.everyFrameSameKind).toBe(true)
    expect(result.kind).toBe('icc')
    expect(result.profile).toEqual(ICC_PROFILE)
  })

  test('reads an untagged GIF back as untagged, not as a false positive (R-I14)', async ({
    page,
  }) => {
    const kind = await page.evaluate(
      async ({ animationPath, bytes }) => {
        const stages = await import(/* @vite-ignore */ animationPath)
        const animation = await stages.decodeAnimation(new Uint8Array(bytes))

        return (animation.frames[0].colour as { kind: string }).kind
      },
      { animationPath: ANIMATION_MODULE_PATH, bytes: fixture('anim-6f.gif') },
    )

    expect(kind).toBe('untagged')
  })
})

// ---------------------------------------------------------------------------------------------
// Everything at once: resized, on the fixture whose frame count is not six.
// ---------------------------------------------------------------------------------------------

test.describe('a longer animation', () => {
  test('keeps all sixteen frames and their delays', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-16f-400.webp')

    expect(encoded.frameCount).toBe(16)
    expect(encoded.delaysMs).toEqual(new Array(16).fill(60))
  })

  test('resizes sixteen frames to one size and keeps every delay', async ({ page }) => {
    const encoded = await encodeGif(page, 'anim-16f-400.webp', {
      dimension: { kind: 'fit-long-edge', pixels: 100 },
    })

    expect([encoded.width, encoded.height]).toEqual([100, 100])
    expect(encoded.frameCount).toBe(16)
    expect(encoded.delaysMs).toEqual(new Array(16).fill(60))
  })
})

// ---------------------------------------------------------------------------------------------
// Sub-centisecond delays, which GIF cannot store. The conversion is ours, in gif-plan.ts.
// ---------------------------------------------------------------------------------------------

test('rounds delays GIF cannot express, and never to zero', async ({ page }) => {
  // The source stores [45, 33, 7, 101, 999, 1] ms.
  const encoded = await encodeGif(page, 'anim-odd-delays.webp')

  expect(encoded.delaysMs).toEqual([50, 30, 10, 100, 1000, 10])
})
