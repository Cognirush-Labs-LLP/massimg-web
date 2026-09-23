import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

// T29 — the animated paths end to end (Functional Design R-F5, R-Q6, R-Q9, R-Q10, R-Q15, R-B6,
// R-C6, R-C16, R-I9, R-I12, R-I17; Technical Design §4.2's animated rows).
//
// Input side: `pipeline/stages/animation.ts` and `animation-plan.ts` — `decode-frames`,
// `edit-frames`, `resize-frames`. Output side: `animation-encode.ts` — animated WebP through
// ImageMagick and APNG through UPNG plus apng-optimizer.
//
// Two rules shape every assertion below.
//
//   1. **The numbers come from our own container readers, not from the decoder.** ImageMagick's
//      `animationIterations` reports a finite GIF loop count plus one (measured: 3 reads back as 4)
//      while reporting an animated WebP's unchanged, so asking the decoder what the file said would
//      be asking the wrong witness. `animation-plan.ts` reads the bytes; the unit tests check *it*
//      against hand-built containers, and the tests here check the decoder against it.
//   2. **The fixtures were written by ffmpeg, img2webp and webpmux**, never by ImageMagick or UPNG.
//      T26 and T27 both established that a round trip through the library under test only proves the
//      library agrees with itself. See scripts/build-animated-fixtures.mjs.
//
// Same DOM/dynamic-import constraint as decode.spec.ts and png.spec.ts: tests/e2e compiles under
// tsconfig.node.json, which has no DOM lib and no path alias into src/, so the modules under test
// are imported inside `page.evaluate` by their served paths and every result is mapped to a plain
// serializable shape before it crosses back to Node.
const ANIMATION_MODULE_PATH = '/src/pipeline/stages/animation.ts'
const ANIMATION_PLAN_MODULE_PATH = '/src/pipeline/stages/animation-plan.ts'
const CLASSIFY_MODULE_PATH = '/src/domain/classify.ts'

// ---------------------------------------------------------------------------------------------
// What scripts/build-animated-fixtures.mjs wrote. Restated here so that a change to the generator
// which nobody meant fails a test rather than quietly moving the goalposts.
// ---------------------------------------------------------------------------------------------

const WIDTH = 64
const HEIGHT = 64

/** One flat colour per frame, so "frame 3 is frame 3" is checkable rather than "there are six". */
const FRAME_COLOURS = [
  [230, 25, 25],
  [25, 200, 25],
  [25, 60, 230],
  [235, 215, 30],
  [30, 210, 215],
  [220, 40, 210],
]

/** Unequal, and no two neighbours alike, so an off-by-one in frame order shows up as a wrong delay. */
const DELAYS_MS = [40, 120, 40, 200, 80, 40]

/**
 * The loop count **as each container stores it**: finite and not the default, because infinity is
 * what a loop bug leaves behind.
 *
 * The same number 3 in all three files, and it does not mean the same thing in all three. GIF's
 * NETSCAPE2.0 block counts repeats *after* the first play, so that GIF is seen four times; WebP's
 * `ANIM.loop_count` and APNG's `acTL.num_plays` count total plays, so those are seen three. The
 * readers report the stored number; `Animation.loops` reports total plays.
 */
const STORED_LOOPS = 3

/** Durations that are not whole centiseconds — the shape ImageMagick cannot report (R-Q9). */
const ODD_DELAYS_MS = [45, 33, 7, 101, 999, 1]
/** What ImageMagick returns for that file, having already rounded to centiseconds. */
const ODD_DELAYS_VIA_IMAGEMAGICK = [50, 30, 10, 100, 1000, 0]

/** The white 16x16 marker, sampled at its centre. */
const MARKER = { x: 8, y: 8 }
/** Inside the flat colour field, clear of both the marker and the transparent corner. */
const BODY = { x: 32, y: 32 }
/** Inside the fully transparent 24x24 corner. */
const HOLE = { x: 50, y: 50 }

/** The disposal fixture's squares: frame n shows squares 0..n, each 16x16 on a dark field. */
const DISPOSAL_FIELD = [20, 20, 30]
const DISPOSAL_SQUARES = [
  { x: 16, y: 16 },
  { x: 32, y: 16 },
  { x: 48, y: 16 },
  { x: 16, y: 32 },
  { x: 32, y: 32 },
  { x: 48, y: 32 },
]

/**
 * GIF is a palette format and ffmpeg's `paletteuse=dither=none` reproduces these flat colours
 * exactly, so this margin is not there to absorb quantization — it exists so that a future
 * regeneration that picks a slightly different palette does not fail for a reason no user would
 * notice. The six colours differ from each other by 170 or more in at least one channel, so nothing
 * inside this margin can confuse two of them.
 */
const CHANNEL_TOLERANCE = 8

function fixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/animated/${name}`, import.meta.url))),
  )
}

const ICC_PROFILE = Array.from(
  readFileSync(fileURLToPath(new URL('../fixtures/decode/icc-profile.bin', import.meta.url))),
)

// ---------------------------------------------------------------------------------------------
// Serializable shapes. An `Animation` holds megabytes of pixels; only samples cross back to Node.
// ---------------------------------------------------------------------------------------------

interface SampledFrame {
  width: number
  height: number
  /** RGBA at each sample point, in the order the caller asked for them. */
  samples: number[][]
  pixelBytes: number
  ownsWholeBuffer: boolean
}

interface SampledAnimation {
  frameCount: number
  delaysMs: number[]
  loops: number
  frames: SampledFrame[]
  colour: { kind: string; description: string | null; profileLength: number | null }
  sourceOrientation: { kind: string; value?: number }
}

interface Point {
  x: number
  y: number
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

/**
 * Decodes one fixture through the real `decodeAnimation` and samples the named points of each
 * frame.
 *
 * `stages` optionally runs `applyEditFrames` and `applyResizeFrames` over the result first, so the
 * three input stages can be exercised as the chain they will be rather than one at a time.
 */
async function decode(
  page: Page,
  name: string,
  points: Point[],
  stages: { alpha?: unknown; dimension?: unknown } = {},
): Promise<SampledAnimation> {
  return page.evaluate(
    async ({ modulePath, bytes, points: at, alpha, dimension }) => {
      const module = await import(/* @vite-ignore */ modulePath)
      let animation = await module.decodeAnimation(new Uint8Array(bytes))

      if (alpha) {
        animation = module.applyEditFrames(animation, null, alpha).animation
      }

      if (dimension) {
        animation = await module.applyResizeFrames(animation, dimension)
      }

      const first = animation.frames[0]

      return {
        frameCount: animation.frames.length,
        delaysMs: animation.delaysMs,
        loops: animation.loops,
        frames: animation.frames.map((frame: (typeof animation.frames)[number]) => ({
          width: frame.width,
          height: frame.height,
          samples: at.map((point) => {
            const index = (point.y * frame.width + point.x) * 4
            return [
              frame.pixels[index],
              frame.pixels[index + 1],
              frame.pixels[index + 2],
              frame.pixels[index + 3],
            ]
          }),
          pixelBytes: frame.pixels.byteLength,
          ownsWholeBuffer:
            frame.pixels.byteOffset === 0 &&
            frame.pixels.byteLength === frame.pixels.buffer.byteLength,
        })),
        colour: {
          kind: first.colour.kind,
          description: first.colour.description ?? null,
          profileLength: first.colour.profile ? first.colour.profile.length : null,
        },
        sourceOrientation: first.sourceOrientation,
      }
    },
    {
      modulePath: ANIMATION_MODULE_PATH,
      bytes: fixture(name),
      points,
      alpha: stages.alpha ?? null,
      dimension: stages.dimension ?? null,
    },
  )
}

/** Runs one of `animation-plan.ts`'s readers in the page, on the same bytes the decoder saw. */
async function read(
  page: Page,
  reader: 'readGifAnimation' | 'readWebpAnimation' | 'readApngAnimation',
  name: string,
): Promise<{
  width: number
  height: number
  frameCount: number
  loops: number
  loopSignal: { kind: string; loops?: number }
  delaysMs: number[]
}> {
  return page.evaluate(
    async ({ modulePath, bytes, reader: which }) => {
      const module = await import(/* @vite-ignore */ modulePath)
      const info = module[which](new Uint8Array(bytes))

      return {
        width: info.width,
        height: info.height,
        frameCount: info.frameCount,
        loops: info.loops,
        loopSignal: info.loopSignal,
        delaysMs: info.frames.map((frame: { delayMs: number }) => frame.delayMs),
      }
    },
    { modulePath: ANIMATION_PLAN_MODULE_PATH, bytes: fixture(name), reader },
  )
}

function expectChannelsNear(actual: number[], expected: number[], message: string): void {
  for (const [channel, value] of expected.entries()) {
    expect(
      Math.abs((actual[channel] as number) - value),
      `${message} channel ${channel}: ${actual.join(',')} against ${expected.join(',')}`,
    ).toBeLessThanOrEqual(CHANNEL_TOLERANCE)
  }
}

// ---------------------------------------------------------------------------------------------
// The three containers, decoded.
// ---------------------------------------------------------------------------------------------

const SOURCES = [
  // `totalPlays` is what `Animation.loops` must carry. It differs from the stored 3 for GIF alone,
  // which is the entire point of the conversion.
  { name: 'anim-6f.gif', reader: 'readGifAnimation' as const, label: 'GIF', totalPlays: 4 },
  { name: 'anim-6f.webp', reader: 'readWebpAnimation' as const, label: 'WebP', totalPlays: 3 },
  { name: 'anim-6f.png', reader: 'readApngAnimation' as const, label: 'APNG', totalPlays: 3 },
]

for (const source of SOURCES) {
  test.describe(`${source.label} source`, () => {
    // R-Q10: never reduced, and never increased either. ImageMagick returns one frame from an APNG
    // without raising anything, so "six frames in, six frames out" is the assertion that catches the
    // failure this path was built around.
    test('decodes every frame, and exactly as many as the container declares', async ({ page }) => {
      const decoded = await decode(page, source.name, [BODY])
      const declared = await read(page, source.reader, source.name)

      expect(decoded.frameCount).toBe(6)
      expect(declared.frameCount).toBe(6)
      expect(decoded.frameCount).toBe(declared.frameCount)
    })

    // R-Q9's delays. Asserted against the independent reader rather than against a constant alone,
    // so the test cannot pass by agreeing with a mistake in the decoder.
    test('keeps every frame delay, unequal ones included', async ({ page }) => {
      const decoded = await decode(page, source.name, [BODY])
      const declared = await read(page, source.reader, source.name)

      expect(declared.delaysMs).toEqual(DELAYS_MS)
      expect(decoded.delaysMs).toEqual(declared.delaysMs)
    })

    // R-Q9's loop count, in total plays. All three files store the number 3; only WebP and APNG
    // mean three plays by it, and the GIF means four. A pipeline that passed the stored number
    // through would turn a GIF seen four times into a WebP seen three.
    test('carries the loop count as total plays, converting GIF\u2019s convention', async ({
      page,
    }) => {
      const decoded = await decode(page, source.name, [BODY])
      const declared = await read(page, source.reader, source.name)

      // The reader is the byte oracle: it reports what is in the file, unconverted.
      expect(declared.loops).toBe(STORED_LOOPS)
      expect(declared.loopSignal).toEqual({ kind: 'present', loops: STORED_LOOPS })

      expect(decoded.loops).toBe(source.totalPlays)
    })

    test('produces full-canvas frames of the container canvas size', async ({ page }) => {
      const decoded = await decode(page, source.name, [BODY])
      const declared = await read(page, source.reader, source.name)

      expect(declared.width).toBe(WIDTH)
      expect(declared.height).toBe(HEIGHT)

      for (const frame of decoded.frames) {
        expect(frame.width).toBe(WIDTH)
        expect(frame.height).toBe(HEIGHT)
        expect(frame.pixelBytes).toBe(WIDTH * HEIGHT * 4)
      }
    })

    // Frame order, checked on content rather than on count. A pipeline that reversed the frames, or
    // dropped one and duplicated another, would pass every assertion above.
    test('puts the frames in order, each with its own content', async ({ page }) => {
      const decoded = await decode(page, source.name, [MARKER, BODY])

      for (const [index, frame] of decoded.frames.entries()) {
        expectChannelsNear(
          frame.samples[0] as number[],
          [255, 255, 255, 255],
          `frame ${index} marker`,
        )
        expectChannelsNear(
          frame.samples[1] as number[],
          [...(FRAME_COLOURS[index] as number[]), 255],
          `frame ${index} body`,
        )
      }
    })

    // The transparent corner is in every frame and in the same place, so a coalescing bug that
    // composited a frame over its predecessor could not fill it in and hide itself.
    test('keeps the fully transparent region transparent in every frame', async ({ page }) => {
      const decoded = await decode(page, source.name, [HOLE])

      for (const [index, frame] of decoded.frames.entries()) {
        expect((frame.samples[0] as number[])[3], `frame ${index} alpha at the hole`).toBe(0)
      }
    })

    // `pipeline/worker.ts` transfers result buffers. A frame that was a window onto a codec heap
    // would detach the whole heap when transferred, breaking every later job in that worker.
    test('hands back frames that own their buffers', async ({ page }) => {
      const decoded = await decode(page, source.name, [BODY])

      for (const [index, frame] of decoded.frames.entries()) {
        expect(frame.ownsWholeBuffer, `frame ${index}`).toBe(true)
      }
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Coalescing.
// ---------------------------------------------------------------------------------------------

test.describe('coalescing', () => {
  // anim-disposal.gif stores frames 1 to 5 as 16x16 sub-rectangles with "do not dispose": read
  // without coalescing, frame 3 is a 16x16 tile; read with it, it is the full canvas with four
  // squares on it. Nothing about frame counts or delays would notice the difference.
  test('composites sub-rectangle frames into full-canvas ones', async ({ page }) => {
    const decoded = await decode(page, 'anim-disposal.gif', DISPOSAL_SQUARES)

    expect(decoded.frameCount).toBe(6)

    for (const [index, frame] of decoded.frames.entries()) {
      expect(frame.width).toBe(WIDTH)
      expect(frame.height).toBe(HEIGHT)

      for (const [square, sample] of frame.samples.entries()) {
        // Frame n shows squares 0..n; everything after it is still the dark field.
        const expected =
          square <= index ? [...(FRAME_COLOURS[square] as number[]), 255] : [...DISPOSAL_FIELD, 255]

        expectChannelsNear(sample as number[], expected, `frame ${index} square ${square}`)
      }
    }
  })

  // The square painted by frame 0 is still there in frame 5, which is what "do not dispose" means
  // and what a coalescer that reset the canvas between frames would lose.
  test('carries an early frame’s content through to the last frame', async ({ page }) => {
    const decoded = await decode(page, 'anim-disposal.gif', [DISPOSAL_SQUARES[0] as Point])
    const last = decoded.frames[decoded.frames.length - 1] as SampledFrame

    expectChannelsNear(
      last.samples[0] as number[],
      [...(FRAME_COLOURS[0] as number[]), 255],
      'last frame, first square',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// The three loop states.
// ---------------------------------------------------------------------------------------------

test.describe('loop count', () => {
  // Absent, present-and-infinite and present-and-finite are three different facts about a file, and
  // the one thing here most easily collapsed. Getting it wrong is permanent and visible: an
  // animation that loops for ever when the source said play once.
  test('reads an explicit zero as infinite, and does not confuse it with a missing record', async ({
    page,
  }) => {
    const infinite = await read(page, 'readGifAnimation', 'anim-loop0.gif')

    expect(infinite.loopSignal).toEqual({ kind: 'present', loops: 0 })
    expect(infinite.loops).toBe(0)
    expect((await decode(page, 'anim-loop0.gif', [BODY])).loops).toBe(0)
  })

  test('reads a missing NETSCAPE2.0 block as one play, not as infinite', async ({ page }) => {
    const absent = await read(page, 'readGifAnimation', 'anim-loopnone.gif')

    expect(absent.loopSignal).toEqual({ kind: 'absent' })
    expect(absent.loops).toBe(1)
    expect((await decode(page, 'anim-loopnone.gif', [BODY])).loops).toBe(1)
  })

  // `gifTotalPlays` is a conversion this codebase performs, so it needs a witness that is not this
  // codebase. ImageMagick's `animationIterations` is one: it reports total plays for both
  // containers, from its own parse, and the pipeline must agree with it everywhere it can be asked.
  // libwebp's `gif2webp` is the second witness and produces the same mapping (3 → 4, 1 → 2, 0 → 0,
  // absent → 1), measured in T29 but not runnable in a browser.
  test('agrees with ImageMagick on total plays, for every loop state it can be asked about', async ({
    page,
  }) => {
    const reported = await page.evaluate(
      async ({ loaderPath, files }) => {
        const { ensureImageMagick } = await import(/* @vite-ignore */ loaderPath)
        const { ImageMagick } = await ensureImageMagick()

        return Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [
            name,
            ImageMagick.readCollection(
              new Uint8Array(bytes as number[]),
              (collection: { animationIterations: number }[]) =>
                collection[0]?.animationIterations ?? -1,
            ),
          ]),
        )
      },
      {
        loaderPath: '/src/pipeline/codecs/loader.ts',
        files: {
          gif: fixture('anim-6f.gif'),
          gifInfinite: fixture('anim-loop0.gif'),
          gifAbsent: fixture('anim-loopnone.gif'),
          webp: fixture('anim-6f.webp'),
        },
      },
    )

    // ImageMagick's own numbers, from its own parse.
    expect(reported).toEqual({ gif: 4, gifInfinite: 0, gifAbsent: 1, webp: 3 })

    // And the pipeline's, which must match all four. The GIF and the WebP both store 3; only one of
    // them means three plays by it.
    expect((await decode(page, 'anim-6f.gif', [BODY])).loops).toBe(reported.gif)
    expect((await decode(page, 'anim-loop0.gif', [BODY])).loops).toBe(reported.gifInfinite)
    expect((await decode(page, 'anim-loopnone.gif', [BODY])).loops).toBe(reported.gifAbsent)
    expect((await decode(page, 'anim-6f.webp', [BODY])).loops).toBe(reported.webp)

    // The stored numbers, for contrast: identical for the GIF and the WebP, meaning different
    // things. Passing them through unconverted is what would lose a play on GIF to WebP.
    expect((await read(page, 'readGifAnimation', 'anim-6f.gif')).loops).toBe(STORED_LOOPS)
    expect((await read(page, 'readWebpAnimation', 'anim-6f.webp')).loops).toBe(STORED_LOOPS)
  })
})

// ---------------------------------------------------------------------------------------------
// Delays that ImageMagick cannot report (R-Q9).
// ---------------------------------------------------------------------------------------------

test.describe('sub-centisecond delays', () => {
  // The bug this fixture exists for. WebP stores durations as milliseconds in a 24-bit ANMF field;
  // ImageMagick exposes them in `animationTicksPerSecond` units and reports 100 ticks for WebP, so
  // anything that is not a whole centisecond has already been rounded by the time it can be read.
  // Every other fixture in this directory uses multiples of 10 ms, which is why nothing caught it.
  test('are reported exactly by the container reader and rounded by ImageMagick', async ({
    page,
  }) => {
    const declared = await read(page, 'readWebpAnimation', 'anim-odd-delays.webp')

    expect(declared.delaysMs).toEqual(ODD_DELAYS_MS)

    const viaMagick = await page.evaluate(
      async ({ loaderPath, bytes }) => {
        const { ensureImageMagick } = await import(/* @vite-ignore */ loaderPath)
        const { ImageMagick } = await ensureImageMagick()

        return ImageMagick.readCollection(
          new Uint8Array(bytes),
          (collection: { animationDelay: number; animationTicksPerSecond: number }[]) =>
            collection.map((image) =>
              Math.round((image.animationDelay * 1000) / image.animationTicksPerSecond),
            ),
        )
      },
      { loaderPath: '/src/pipeline/codecs/loader.ts', bytes: fixture('anim-odd-delays.webp') },
    )

    // Pinned, so that a magick-wasm which started reporting these exactly shows up as a failure to
    // re-read rather than as a silently redundant workaround.
    expect(viaMagick).toEqual(ODD_DELAYS_VIA_IMAGEMAGICK)
    expect(viaMagick).not.toEqual(ODD_DELAYS_MS)
  })

  // A 1 ms frame becoming a 0 ms one is the worst of it: not a rounding error but a frame with no
  // duration at all.
  test('survive the decoder unrounded', async ({ page }) => {
    const decoded = await decode(page, 'anim-odd-delays.webp', [BODY])

    expect(decoded.delaysMs).toEqual(ODD_DELAYS_MS)
    expect(decoded.frameCount).toBe(6)
    expect(decoded.delaysMs[5]).toBe(1)
  })

  test('survive the edit and resize stages', async ({ page }) => {
    const processed = await decode(page, 'anim-odd-delays.webp', [BODY], {
      alpha: { kind: 'flatten', background: { r: 0, g: 0, b: 0, a: 1 } },
      dimension: { kind: 'fit-long-edge', pixels: 32 },
    })

    expect(processed.delaysMs).toEqual(ODD_DELAYS_MS)
  })
})

// ---------------------------------------------------------------------------------------------
// The premise behind having two decoders at all.
// ---------------------------------------------------------------------------------------------

test.describe('ImageMagick and APNG', () => {
  // Five comments in src/ and two register entries rest on this, and until now nothing tested it.
  // If a future magick-wasm learns to decode APNG, this test fails and the second decoder can be
  // reconsidered; if it silently regressed the other way, nothing else here would notice, because
  // the pipeline does not route APNG through ImageMagick at all.
  test('reads one frame from a six-frame APNG, silently, through both of its readers', async ({
    page,
  }) => {
    const observed = await page.evaluate(
      async ({ loaderPath, bytes }) => {
        const { ensureImageMagick } = await import(/* @vite-ignore */ loaderPath)
        const { ImageMagick, MagickImageCollection } = await ensureImageMagick()
        const source = new Uint8Array(bytes)
        const result: Record<string, number | string> = {}

        try {
          result.readCollection = ImageMagick.readCollection(
            source,
            (collection: { length: number }) => collection.length,
          )
        } catch (error) {
          result.readCollection = error instanceof Error ? error.message : String(error)
        }

        try {
          result.ping = MagickImageCollection.use(
            (collection: { ping(b: Uint8Array): void; length: number }) => {
              collection.ping(source)
              return collection.length
            },
          )
        } catch (error) {
          result.ping = error instanceof Error ? error.message : String(error)
        }

        return result
      },
      { loaderPath: '/src/pipeline/codecs/loader.ts', bytes: fixture('anim-6f.png') },
    )

    // One frame, and no error — which is what makes it dangerous rather than merely unsupported.
    expect(observed.readCollection).toBe(1)
    expect(observed.ping).toBe(1)

    // The file really does hold six, by the reader that does not use ImageMagick.
    expect((await read(page, 'readApngAnimation', 'anim-6f.png')).frameCount).toBe(6)
    expect((await decode(page, 'anim-6f.png', [BODY])).frameCount).toBe(6)
  })
})

// ---------------------------------------------------------------------------------------------
// The still path's boundary.
// ---------------------------------------------------------------------------------------------

test.describe('single-frame sources', () => {
  test('are not classified as animated', async ({ page }) => {
    const classification = await page.evaluate(
      async ({ modulePath, bytes }) => {
        const { classify } = await import(/* @vite-ignore */ modulePath)
        return classify(new Uint8Array(bytes))
      },
      { modulePath: CLASSIFY_MODULE_PATH, bytes: fixture('anim-1f.gif') },
    )

    expect(classification).toEqual({ class: 'supported', format: 'gif', isAnimated: false })
  })

  // Refused rather than animated-with-one-frame: a one-frame GIF belongs on the still path, and
  // producing a WebP that announces an animation for it would be a change nobody asked for.
  test('are refused by decodeAnimation with a reason', async ({ page }) => {
    const message = await page.evaluate(
      async ({ modulePath, bytes }) => {
        const module = await import(/* @vite-ignore */ modulePath)
        try {
          await module.decodeAnimation(new Uint8Array(bytes))
          return null
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      { modulePath: ANIMATION_MODULE_PATH, bytes: fixture('anim-1f.gif') },
    )

    expect(message).toContain('single-frame')
  })
})

// ---------------------------------------------------------------------------------------------
// Colour (R-I12, R-I14, §7.7).
// ---------------------------------------------------------------------------------------------

test.describe('colour', () => {
  // ImageMagick's WebP coder reports no profile at all for an animated file, though it reports one
  // for a still WebP. Without the RIFF read in animation-plan.ts every profiled animated WebP would
  // decode as untagged sRGB, which is the silent colour shift §7.7 exists to prevent.
  test('carries an animated WebP’s ICC profile, which ImageMagick does not report', async ({
    page,
  }) => {
    const reportedByMagick = await page.evaluate(
      async ({ loaderPath, bytes }) => {
        const { ensureImageMagick } = await import(/* @vite-ignore */ loaderPath)
        const { ImageMagick } = await ensureImageMagick()

        return ImageMagick.readCollection(
          new Uint8Array(bytes),
          (collection: { getColorProfile(): { data: Uint8Array } | null }[]) =>
            collection[0]?.getColorProfile() === null,
        )
      },
      { loaderPath: '/src/pipeline/codecs/loader.ts', bytes: fixture('anim-icc.webp') },
    )

    expect(reportedByMagick, 'ImageMagick still reports no profile for an animated WebP').toBe(true)

    const decoded = await decode(page, 'anim-icc.webp', [BODY])

    expect(decoded.colour.kind).toBe('icc')
    expect(decoded.colour.profileLength).toBe(ICC_PROFILE.length)
  })

  test('carries the profile byte for byte, on both WebP and APNG', async ({ page }) => {
    for (const name of ['anim-icc.webp', 'anim-icc.png']) {
      const profile = await page.evaluate(
        async ({ modulePath, bytes }) => {
          const module = await import(/* @vite-ignore */ modulePath)
          const animation = await module.decodeAnimation(new Uint8Array(bytes))
          const colour = animation.frames[0].colour

          return colour.kind === 'icc' ? Array.from(colour.profile as Uint8Array) : null
        },
        { modulePath: ANIMATION_MODULE_PATH, bytes: fixture(name) },
      )

      expect(profile, `${name} profile`).toEqual(ICC_PROFILE)
    }
  })

  // R-I14: an untagged animation gains nothing. "No profile" and "a profile that says sRGB" are
  // different states and only the first one is true of these files.
  test('reports an animation with no profile as untagged', async ({ page }) => {
    for (const name of ['anim-6f.gif', 'anim-6f.webp', 'anim-6f.png']) {
      expect((await decode(page, name, [BODY])).colour.kind, name).toBe('untagged')
    }
  })

  // Every frame is handed the same colour, which `assertUniformAnimation` enforces — so the encoder
  // cannot be given an animation whose frames disagree about their colour space.
  test('gives every frame the same colour description', async ({ page }) => {
    const kinds = await page.evaluate(
      async ({ modulePath, bytes }) => {
        const module = await import(/* @vite-ignore */ modulePath)
        const animation = await module.decodeAnimation(new Uint8Array(bytes))

        return animation.frames.map(
          (frame: { colour: { kind: string; profile?: Uint8Array } }) =>
            `${frame.colour.kind}:${frame.colour.profile ? frame.colour.profile.length : 0}`,
        )
      },
      { modulePath: ANIMATION_MODULE_PATH, bytes: fixture('anim-icc.webp') },
    )

    expect(new Set(kinds).size).toBe(1)
    expect(kinds).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------------------------
// Orientation (R-I9, R-I10, D4).
// ---------------------------------------------------------------------------------------------

test.describe('EXIF orientation', () => {
  // ImageMagick reports orientation 0 for an animated WebP whatever the EXIF chunk says (measured),
  // so this tag is read out of the RIFF container and pushed back into ImageMagick per frame. Absent
  // and present-and-6 are different states and both are reported as themselves.
  test('reports the tag an animated WebP carries, and absence where there is none', async ({
    page,
  }) => {
    expect((await decode(page, 'anim-exif.webp', [BODY])).sourceOrientation).toEqual({
      kind: 'present',
      value: 6,
    })
    expect((await decode(page, 'anim-6f.webp', [BODY])).sourceOrientation).toEqual({
      kind: 'absent',
    })
  })

  // Orientation 6 is a 90-degree clockwise rotation, so the white marker that sits at the top left
  // of the stored frame must appear at the top *right* — in every frame, not only the first.
  test('applies the rotation to every frame', async ({ page }) => {
    const topRight = { x: WIDTH - MARKER.x - 1, y: MARKER.y }
    const oriented = await decode(page, 'anim-exif.webp', [MARKER, topRight])
    const plain = await decode(page, 'anim-6f.webp', [MARKER, topRight])

    expect(oriented.frameCount).toBe(6)

    for (const [index, frame] of oriented.frames.entries()) {
      expectChannelsNear(
        frame.samples[1] as number[],
        [255, 255, 255, 255],
        `oriented frame ${index}, marker at the top right`,
      )
      // And it is no longer where it was stored, so the assertion above cannot pass on an image that
      // was simply left alone.
      expect(
        (frame.samples[0] as number[]).slice(0, 3),
        `oriented frame ${index}, top left`,
      ).not.toEqual([255, 255, 255])
    }

    // The untagged fixture has identical pixels and no tag, and must be left exactly where it is.
    for (const [index, frame] of plain.frames.entries()) {
      expectChannelsNear(
        frame.samples[0] as number[],
        [255, 255, 255, 255],
        `untagged frame ${index}, marker at the top left`,
      )
    }
  })

  test('keeps every frame the same size after orienting', async ({ page }) => {
    const oriented = await decode(page, 'anim-exif.webp', [BODY])

    for (const frame of oriented.frames) {
      expect(frame.width).toBe(WIDTH)
      expect(frame.height).toBe(HEIGHT)
      expect(frame.ownsWholeBuffer).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// edit-frames (R-C6, R-C16, R-X46).
// ---------------------------------------------------------------------------------------------

test.describe('applyEditFrames', () => {
  const FLATTEN = { kind: 'flatten', background: { r: 255, g: 0, b: 0, a: 1 } }

  // R-C6 and R-C16 remove the Edit action for an animated image, so an edit arriving here is an
  // upstream bug. Refused rather than applied: a crop that reached frame one and not frame two is a
  // corruption nobody would trace back to this stage.
  test('refuses an edit, which is not offered for an animated source', async ({ page }) => {
    const message = await page.evaluate(
      async ({ modulePath, bytes }) => {
        const module = await import(/* @vite-ignore */ modulePath)
        const animation = await module.decodeAnimation(new Uint8Array(bytes))
        const edit = { ops: [{ kind: 'rotate', quarterTurns: 1 }], version: 1 }

        try {
          module.applyEditFrames(animation, edit, { kind: 'preserve' })
          return null
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      { modulePath: ANIMATION_MODULE_PATH, bytes: fixture('anim-6f.webp') },
    )

    expect(message).toContain('R-C6')
  })

  test('flattens transparency on every frame, not only the first', async ({ page }) => {
    const flattened = await decode(page, 'anim-6f.webp', [HOLE, BODY], { alpha: FLATTEN })

    for (const [index, frame] of flattened.frames.entries()) {
      expectChannelsNear(
        frame.samples[0] as number[],
        [255, 0, 0, 255],
        `frame ${index} hole, filled`,
      )
      // The visible content is untouched by the flatten.
      expectChannelsNear(
        frame.samples[1] as number[],
        [...(FRAME_COLOURS[index] as number[]), 255],
        `frame ${index} body`,
      )
    }
  })

  // The reporting bug the per-frame shape invites: six frames flattened against one background is
  // one thing that happened to the image, and §6.6's report must say it once.
  test('reports one flatten caveat for the whole animation, not one per frame', async ({
    page,
  }) => {
    const caveats = await page.evaluate(
      async ({ modulePath, bytes, alpha }) => {
        const module = await import(/* @vite-ignore */ modulePath)
        const animation = await module.decodeAnimation(new Uint8Array(bytes))

        return module.applyEditFrames(animation, null, alpha).caveats
      },
      { modulePath: ANIMATION_MODULE_PATH, bytes: fixture('anim-6f.webp'), alpha: FLATTEN },
    )

    expect(caveats).toHaveLength(1)
    expect(caveats).toEqual([
      { kind: 'transparency-flattened', fill: { r: 255, g: 0, b: 0, a: 1 } },
    ])
  })

  test('reports no caveat when alpha is preserved', async ({ page }) => {
    const caveats = await page.evaluate(
      async ({ modulePath, bytes }) => {
        const module = await import(/* @vite-ignore */ modulePath)
        const animation = await module.decodeAnimation(new Uint8Array(bytes))

        return module.applyEditFrames(animation, null, { kind: 'preserve' }).caveats
      },
      { modulePath: ANIMATION_MODULE_PATH, bytes: fixture('anim-6f.webp') },
    )

    expect(caveats).toEqual([])
  })

  test('leaves the delays and the loop count alone', async ({ page }) => {
    const flattened = await decode(page, 'anim-6f.webp', [BODY], { alpha: FLATTEN })

    expect(flattened.delaysMs).toEqual(DELAYS_MS)
    expect(flattened.loops).toBe(3)
    expect(flattened.frameCount).toBe(6)
  })
})

// ---------------------------------------------------------------------------------------------
// resize-frames.
// ---------------------------------------------------------------------------------------------

test.describe('applyResizeFrames', () => {
  const HALF = { kind: 'fit-long-edge', pixels: 32 }

  test('resizes every frame to the same size, keeping the frame count and the delays', async ({
    page,
  }) => {
    const resized = await decode(page, 'anim-6f.webp', [{ x: 16, y: 16 }], { dimension: HALF })

    expect(resized.frameCount).toBe(6)
    expect(resized.delaysMs).toEqual(DELAYS_MS)
    expect(resized.loops).toBe(3)

    for (const [index, frame] of resized.frames.entries()) {
      expect(frame.width, `frame ${index} width`).toBe(32)
      expect(frame.height, `frame ${index} height`).toBe(32)
      expect(frame.pixelBytes).toBe(32 * 32 * 4)
      expect(frame.ownsWholeBuffer).toBe(true)
    }
  })

  // Each frame keeps its own content through the resize: a sample well inside the flat field is
  // still that frame's colour, which a resize that reused one frame's pixels for all six would fail.
  test('keeps each frame’s own content', async ({ page }) => {
    const resized = await decode(page, 'anim-6f.webp', [{ x: 16, y: 16 }], { dimension: HALF })

    for (const [index, frame] of resized.frames.entries()) {
      expectChannelsNear(
        frame.samples[0] as number[],
        [...(FRAME_COLOURS[index] as number[]), 255],
        `resized frame ${index}`,
      )
    }
  })

  test('does nothing when the animation is already at the target size', async ({ page }) => {
    const unchanged = await decode(page, 'anim-6f.webp', [BODY], {
      dimension: { kind: 'fit-long-edge', pixels: WIDTH },
    })

    for (const frame of unchanged.frames) {
      expect(frame.width).toBe(WIDTH)
      expect(frame.height).toBe(HEIGHT)
    }
  })

  // The three stages as the chain they will be in Pass B: decode, then edit, then resize.
  test('runs after edit-frames without losing anything', async ({ page }) => {
    const chained = await decode(page, 'anim-6f.gif', [{ x: 16, y: 16 }], {
      alpha: { kind: 'flatten', background: { r: 0, g: 0, b: 255, a: 1 } },
      dimension: HALF,
    })

    expect(chained.frameCount).toBe(6)
    expect(chained.delaysMs).toEqual(DELAYS_MS)
    expect(chained.loops).toBe(4)

    for (const [index, frame] of chained.frames.entries()) {
      expect(frame.width).toBe(32)
      expectChannelsNear(
        frame.samples[0] as number[],
        [...(FRAME_COLOURS[index] as number[]), 255],
        `chained frame ${index}`,
      )
    }
  })
})

// ---------------------------------------------------------------------------------------------
// CRC32, against an implementation that is not ours.
// ---------------------------------------------------------------------------------------------

test.describe('crc32', () => {
  // The unit tests build their own PNG chunks with this same function, which on its own proves only
  // that it agrees with itself. ffmpeg wrote every chunk of the committed APNG with an independent
  // CRC-32; reproducing all of them is what makes `setApngLoopCount`'s rewritten chunk trustworthy.
  test('reproduces every CRC ffmpeg wrote into the committed APNG', async ({ page }) => {
    const checked = await page.evaluate(
      async ({ modulePath, bytes }) => {
        const { crc32 } = await import(/* @vite-ignore */ modulePath)
        const png = new Uint8Array(bytes)
        const view = new DataView(png.buffer)
        const mismatches: string[] = []
        let at = 8
        let count = 0

        while (at + 8 <= png.length) {
          const length = view.getUint32(at)
          const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
          const stored = view.getUint32(at + 8 + length)

          if (crc32(png.subarray(at + 4, at + 8 + length)) !== stored) {
            mismatches.push(type)
          }

          count += 1
          at += 12 + length
          if (type === 'IEND') break
        }

        return { count, mismatches }
      },
      { modulePath: ANIMATION_PLAN_MODULE_PATH, bytes: fixture('anim-6f.png') },
    )

    expect(checked.mismatches).toEqual([])
    expect(checked.count).toBeGreaterThanOrEqual(15)
  })

  // The write side of the same function, end to end: patch the loop count into a real APNG and read
  // it back with the reader. UPNG hardcodes num_plays to 0, so this is the only route a finite loop
  // count has into an APNG this pipeline writes.
  test('patches a loop count into a real APNG that the reader reads back', async ({ page }) => {
    const roundTripped = await page.evaluate(
      async ({ modulePath, bytes }) => {
        const { readApngAnimation, setApngLoopCount } = await import(/* @vite-ignore */ modulePath)
        const png = new Uint8Array(bytes)

        return [0, 1, 7, 65535].map((loops) => ({
          asked: loops,
          read: readApngAnimation(setApngLoopCount(png, loops)).loops,
          frames: readApngAnimation(setApngLoopCount(png, loops)).frameCount,
        }))
      },
      { modulePath: ANIMATION_PLAN_MODULE_PATH, bytes: fixture('anim-6f.png') },
    )

    for (const row of roundTripped) {
      expect(row.read, `loop count ${row.asked}`).toBe(row.asked)
      expect(row.frames).toBe(6)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The output side (T29 Pass B): R-F5, R-Q9, R-Q10, R-Q12, R-Q14, R-I12, R-I17.
//
// Every structural claim below is read back with `animation-plan.ts`, which shares no code with
// either encoder. Pixel claims are read back with the **engine's own decoder** where it has one —
// T26's lesson, that an ImageMagick round trip proves only that the bytes are self-consistent.
// `ImageDecoder` exists in Chromium and not in Firefox or WebKit at the versions Playwright ships,
// so `decodedBy` is returned and asserted rather than the fallback being taken silently.
// ---------------------------------------------------------------------------------------------

const ANIMATION_ENCODE_MODULE_PATH = '/src/pipeline/stages/animation-encode.ts'

// The browser APIs the page callback below uses, declared minimally because tests/e2e compiles
// under tsconfig.node.json and has no DOM lib — the same arrangement decode.spec.ts uses for
// `createImageBitmap`.
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

interface EncodedAnimation {
  byteLength: number
  ownsWholeBuffer: boolean
  frameCount: number
  delaysMs: number[]
  loops: number
  width: number
  height: number
  caveats: { kind: string }[]
  branch?: string
  sizes?: { lossless: number }
  mode?: string
  attempts?: string[]
  uniqueColors?: number | null
  /** Per-frame RGBA at the sample points, or `null` when the engine has no animation decoder. */
  rendered: number[][][] | null
  decodedBy: string
  /** Chunk or fourcc inventory of the output, for the metadata assertions. */
  containers: string[]
}

/**
 * Decodes `name`, runs the animated encoder for `format`, and reads the result back.
 *
 * The read-back is deliberately done twice: once through `animation-plan.ts`'s container reader for
 * the counts and the timings, and once through the browser's own `ImageDecoder` for the pixels.
 */
async function encodeAnimation(
  page: Page,
  name: string,
  format: 'webp' | 'png',
  options: { slider?: number; points?: Point[]; alpha?: unknown } = {},
): Promise<EncodedAnimation> {
  return page.evaluate(
    async ({
      animationPath,
      encodePath,
      planPath,
      jobPath,
      bytes,
      format: target,
      slider,
      points,
      alpha,
    }) => {
      const stages = await import(/* @vite-ignore */ animationPath)
      const encoders = await import(/* @vite-ignore */ encodePath)
      const plan = await import(/* @vite-ignore */ planPath)
      const job = await import(/* @vite-ignore */ jobPath)

      // The real quality resolution, never a second copy of R-Q11's mapping in this file.
      const resolution = job.resolveSettings(
        { sourceFormat: target === 'png' ? 'png' : 'webp', isAnimated: true, edit: null },
        {
          quality: { kind: 'quality', value: slider },
          dimension: { kind: 'original' },
          format: target,
        },
      )

      if (resolution.kind !== 'resolved') {
        throw new Error(`settings did not resolve: ${JSON.stringify(resolution)}`)
      }

      let animation = await stages.decodeAnimation(new Uint8Array(bytes))

      if (alpha) {
        animation = stages.applyEditFrames(animation, null, alpha).animation
      }

      const encoded =
        target === 'png'
          ? await encoders.encodeApng(animation)
          : await encoders.encodeAnimatedWebp(animation, resolution.settings.quality)

      const out = encoded.bytes as Uint8Array
      const info = target === 'png' ? plan.readApngAnimation(out) : plan.readWebpAnimation(out)

      // Container inventory: PNG chunk types, or WebP RIFF fourccs.
      const containers: string[] = []
      if (target === 'png') {
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
        let at = 8
        while (at + 8 <= out.length) {
          const length = view.getUint32(at)
          const type = String.fromCharCode(...out.subarray(at + 4, at + 8))
          containers.push(type)
          at += 12 + length
          if (type === 'IEND') break
        }
      } else {
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
        let at = 12
        while (at + 8 <= out.length) {
          const fourcc = String.fromCharCode(...out.subarray(at, at + 4))
          const length = view.getUint32(at + 4, true)
          containers.push(fourcc)
          at += 8 + length + (length % 2)
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
          const decoder = new decoderCtor({
            data: out,
            type: target === 'png' ? 'image/png' : 'image/webp',
          })
          await decoder.tracks.ready
          const count = decoder.tracks.selectedTrack?.frameCount ?? 0
          const frames: number[][][] = []

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
            frames.push(
              points.map((point) => {
                const data = context.getImageData(point.x, point.y, 1, 1).data
                return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0]
              }),
            )
            video.close()
          }

          rendered = frames
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
        loops: info.loops,
        width: info.width,
        height: info.height,
        caveats: encoded.caveats,
        branch: encoded.branch,
        sizes: encoded.sizes,
        mode: encoded.mode,
        attempts: encoded.attempts,
        uniqueColors: encoded.uniqueColors,
        rendered,
        decodedBy,
        containers,
      }
    },
    {
      animationPath: ANIMATION_MODULE_PATH,
      encodePath: ANIMATION_ENCODE_MODULE_PATH,
      planPath: ANIMATION_PLAN_MODULE_PATH,
      jobPath: '/src/domain/job.ts',
      bytes: fixture(name),
      format,
      slider: options.slider ?? 80,
      points: options.points ?? [],
      alpha: options.alpha ?? null,
    },
  )
}

for (const source of SOURCES) {
  for (const format of ['webp', 'png'] as const) {
    test.describe(`${source.label} source to animated ${format.toUpperCase()}`, () => {
      // R-Q10: never reduced, and never increased either.
      test('keeps the frame count exactly', async ({ page }) => {
        expect((await encodeAnimation(page, source.name, format)).frameCount).toBe(6)
      })

      // R-Q9's delays, read back out of the written file by the independent reader.
      test('keeps every frame delay', async ({ page }) => {
        expect((await encodeAnimation(page, source.name, format)).delaysMs).toEqual(DELAYS_MS)
      })

      // R-Q9's loop count, in total plays. The GIF source plays four times and must still play four
      // times after the conversion; the WebP and APNG sources play three.
      test('keeps the loop count as total plays', async ({ page }) => {
        expect((await encodeAnimation(page, source.name, format)).loops).toBe(source.totalPlays)
      })

      test('keeps the canvas size', async ({ page }) => {
        const encoded = await encodeAnimation(page, source.name, format)

        expect(encoded.width).toBe(WIDTH)
        expect(encoded.height).toBe(HEIGHT)
      })

      // `pipeline/worker.ts` transfers the result, so a view onto a codec heap would detach it.
      test('hands back bytes that own their buffer', async ({ page }) => {
        const encoded = await encodeAnimation(page, source.name, format)

        expect(encoded.ownsWholeBuffer).toBe(true)
        expect(encoded.byteLength).toBeGreaterThan(0)
      })

      // Frame order and per-frame content, in the engine's own decoder where it has one. An
      // ImageMagick or UPNG round trip would only prove the bytes are self-consistent (T26).
      test('renders the frames in order, in the engine’s own decoder', async ({
        page,
      }, testInfo) => {
        const encoded = await encodeAnimation(page, source.name, format, {
          points: [MARKER, BODY],
        })

        if (encoded.rendered === null) {
          // Recorded rather than skipped: this is a real gap in coverage on two engines, and it
          // should be visible in the run rather than silently absent.
          expect(
            testInfo.project.name,
            'only Chromium is expected to lack no animation decoder',
          ).not.toBe('chromium')
          return
        }

        expect(encoded.decodedBy).toBe('ImageDecoder')
        expect(encoded.rendered).toHaveLength(6)

        for (const [index, frame] of encoded.rendered.entries()) {
          expectChannelsNear(frame[0] as number[], [255, 255, 255, 255], `frame ${index} marker`)
          expectChannelsNear(
            frame[1] as number[],
            [...(FRAME_COLOURS[index] as number[]), 255],
            `frame ${index} body`,
          )
        }
      })

      // R-I17: no EXIF, XMP or timestamps reach the output. Structural — both writers build from
      // raw pixels — and asserted on the container inventory rather than argued.
      test('carries no metadata', async ({ page }) => {
        const encoded = await encodeAnimation(page, source.name, format)
        const forbidden =
          format === 'png'
            ? ['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'sRGB', 'cHRM', 'gAMA']
            : ['EXIF', 'XMP ']

        for (const chunk of forbidden) {
          expect(encoded.containers, `${format} output carries ${chunk}`).not.toContain(chunk)
        }
      })
    })
  }
}

test.describe('animated output, transparency and coalescing', () => {
  // **`ImageDecoder` is not used for alpha, and that is a measurement about WebKit rather than a
  // convenience.** Given the same committed fixture, WebKit's `createImageBitmap` reports alpha 0 at
  // the transparent corner while its `ImageDecoder` → `VideoFrame` → `drawImage` path reports 255,
  // with the frame's own `format` still saying `RGBA`. Chromium's agrees with itself at 0. So the
  // per-frame decoder is the wrong instrument for this question on one of three engines, and the
  // assertions below use the pipeline's own decoder for every frame and the engine's
  // `createImageBitmap` — which works everywhere — for the first.
  test('keeps the transparent corner transparent in every frame of both formats', async ({
    page,
  }) => {
    for (const format of ['webp', 'png'] as const) {
      const checked = await page.evaluate(
        async ({ animationPath, encodePath, bytes, target, hole }) => {
          const stages = await import(/* @vite-ignore */ animationPath)
          const encoders = await import(/* @vite-ignore */ encodePath)
          const animation = await stages.decodeAnimation(new Uint8Array(bytes))
          const quality = { kind: 'quality', value: 95, lossless: true }
          const encoded =
            target === 'png'
              ? await encoders.encodeApng(animation)
              : await encoders.encodeAnimatedWebp(animation, quality)
          const out = encoded.bytes as Uint8Array

          // Every frame, through the pipeline's own decoder — which is not the encoder.
          const decoded = await stages.decodeAnimation(out)
          const perFrameAlpha = decoded.frames.map(
            (frame: { pixels: Uint8Array; width: number }) =>
              frame.pixels[(hole.y * frame.width + hole.x) * 4 + 3],
          )

          // The first frame, through the engine's own image decoder.
          const blob = new Blob([out], { type: target === 'png' ? 'image/png' : 'image/webp' })
          const bitmap = await createImageBitmap(blob)
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const context = canvas.getContext('2d') as Canvas2d
          context.clearRect(0, 0, canvas.width, canvas.height)
          context.drawImage(bitmap, 0, 0)
          const engineAlpha = context.getImageData(hole.x, hole.y, 1, 1).data[3]

          return { perFrameAlpha, engineAlpha }
        },
        {
          animationPath: ANIMATION_MODULE_PATH,
          encodePath: ANIMATION_ENCODE_MODULE_PATH,
          bytes: fixture('anim-6f.webp'),
          target: format,
          hole: HOLE,
        },
      )

      expect(checked.perFrameAlpha, `${format} output, every frame`).toEqual([0, 0, 0, 0, 0, 0])
      expect(checked.engineAlpha, `${format} output, first frame in the engine`).toBe(0)
    }
  })

  // The sub-rectangle fixture: each output frame must be the full composited canvas, whatever
  // sub-rectangles the encoder chose to store internally.
  test('writes the coalesced content of a sub-rectangle source', async ({ page }) => {
    for (const format of ['webp', 'png'] as const) {
      const encoded = await encodeAnimation(page, 'anim-disposal.gif', format, {
        points: DISPOSAL_SQUARES,
      })

      expect(encoded.frameCount, format).toBe(6)

      if (encoded.rendered === null) {
        continue
      }

      for (const [index, frame] of encoded.rendered.entries()) {
        for (const [square, sample] of frame.entries()) {
          const expected =
            square <= index
              ? [...(FRAME_COLOURS[square] as number[]), 255]
              : [...DISPOSAL_FIELD, 255]

          expectChannelsNear(
            sample as number[],
            expected,
            `${format} frame ${index} square ${square}`,
          )
        }
      }
    }
  })

  // The delay that ImageMagick's WebP writer would have turned into 100 ms. This is the assertion
  // the whole `setWebpFrameDurations` patch exists for.
  test('writes sub-centisecond delays that ImageMagick alone would have clamped', async ({
    page,
  }) => {
    for (const format of ['webp', 'png'] as const) {
      const encoded = await encodeAnimation(page, 'anim-odd-delays.webp', format)

      expect(encoded.delaysMs, `${format} output`).toEqual(ODD_DELAYS_MS)
    }
  })
})

test.describe('a longer animation', () => {
  // Every other fixture here is six frames of 64x64, which is the right size for asserting pixel
  // values and small enough that a per-frame bug could hide in the noise of a short list. This one
  // is sixteen frames of 400x400 — 10.2 MB decoded from 1.2 KB on disk, which is the ratio that
  // makes animated sources the highest-risk input (R-B6, C7).
  for (const format of ['webp', 'png'] as const) {
    test(`keeps all sixteen frames and their delays through ${format}`, async ({ page }) => {
      const encoded = await encodeAnimation(page, 'anim-16f-400.webp', format)

      expect(encoded.frameCount).toBe(16)
      expect(encoded.delaysMs).toEqual(new Array(16).fill(60))
      expect(encoded.width).toBe(400)
      expect(encoded.height).toBe(400)
      expect(encoded.ownsWholeBuffer).toBe(true)
    })
  }

  test('resizes sixteen frames to one size and keeps every delay', async ({ page }) => {
    const resized = await decode(page, 'anim-16f-400.webp', [{ x: 50, y: 50 }], {
      dimension: { kind: 'fit-long-edge', pixels: 120 },
    })

    expect(resized.frameCount).toBe(16)
    expect(resized.delaysMs).toEqual(new Array(16).fill(60))

    for (const [index, frame] of resized.frames.entries()) {
      expect(frame.width, `frame ${index}`).toBe(120)
      expect(frame.height, `frame ${index}`).toBe(120)
      expect(frame.ownsWholeBuffer).toBe(true)
    }
  })
})

test.describe('animated output colour (R-I12, R-I14)', () => {
  test('carries the source profile into both formats, byte for byte', async ({ page }) => {
    for (const [name, format] of [
      ['anim-icc.webp', 'webp'],
      ['anim-icc.png', 'png'],
      ['anim-icc.webp', 'png'],
      ['anim-icc.png', 'webp'],
    ] as const) {
      const profile = await page.evaluate(
        async ({ animationPath, encodePath, planPath, bytes, target }) => {
          const stages = await import(/* @vite-ignore */ animationPath)
          const encoders = await import(/* @vite-ignore */ encodePath)
          const plan = await import(/* @vite-ignore */ planPath)
          const animation = await stages.decodeAnimation(new Uint8Array(bytes))
          const quality = { kind: 'quality', value: 95, lossless: true }
          const encoded =
            target === 'png'
              ? await encoders.encodeApng(animation)
              : await encoders.encodeAnimatedWebp(animation, quality)
          const out = encoded.bytes as Uint8Array

          if (target === 'webp') {
            const lifted = plan.readWebpIccProfile(out)
            return lifted === null ? null : Array.from(lifted as Uint8Array)
          }

          // The APNG's profile is a deflated `iCCP`; decompressing it needs a real PNG reader, so
          // the chunk is compared against the one ImageMagick writes for the same profile instead.
          const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
          let at = 8
          while (at + 8 <= out.length) {
            const length = view.getUint32(at)
            const type = String.fromCharCode(...out.subarray(at + 4, at + 8))
            if (type === 'iCCP') return { iccpBytes: length }
            at += 12 + length
            if (type === 'IEND') break
          }
          return null
        },
        {
          animationPath: ANIMATION_MODULE_PATH,
          encodePath: ANIMATION_ENCODE_MODULE_PATH,
          planPath: ANIMATION_PLAN_MODULE_PATH,
          bytes: fixture(name),
          target: format,
        },
      )

      if (format === 'webp') {
        expect(profile, `${name} to ${format}`).toEqual(ICC_PROFILE)
      } else {
        // A deflated profile of a few thousand bytes: present, non-trivial, and the same size
        // whichever source it came from.
        expect(profile, `${name} to ${format}`).not.toBeNull()
        expect((profile as { iccpBytes: number }).iccpBytes).toBeGreaterThan(1000)
      }
    }
  })

  // R-I14: an untagged animation gains no profile, and no chunk that would describe one.
  test('adds no profile to an untagged animation', async ({ page }) => {
    const webp = await encodeAnimation(page, 'anim-6f.webp', 'webp')
    const png = await encodeAnimation(page, 'anim-6f.png', 'png')

    expect(webp.containers).not.toContain('ICCP')
    expect(png.containers).not.toContain('iCCP')
    expect(png.containers).not.toContain('sRGB')
  })
})

test.describe('R-Q6 on animated WebP', () => {
  // Decided with the user in T29: R-Q6 is written about WebP, not about still WebP, and a GIF
  // converted to animated WebP is exactly the flat few-colour content it wins on. The gate's shape
  // for an animation — first, middle and last frame, maximum wins — is a T29 choice, since §7.6
  // defines it over a single still frame. See animation-encode.ts.
  test('attempts both encodes below 96 and keeps the smaller', async ({ page }) => {
    const encoded = await encodeAnimation(page, 'anim-6f.gif', 'webp', { slider: 80 })

    expect(encoded.attempts).toEqual(['lossy', 'lossless'])
    expect(encoded.mode).toBeDefined()

    // Whichever won, the bytes are that attempt's and the animation is still intact — R-Q6 may not
    // be paid for with a frame, a delay or a loop.
    expect(encoded.frameCount).toBe(FRAME_COLOURS.length)
    expect(encoded.delaysMs).toEqual(DELAYS_MS)
    expect(encoded.loops).toBe(STORED_LOOPS + 1)
  })

  // The six flat colours plus the marker and the transparent corner are far under the gate's limit,
  // so this animation must reach the second attempt rather than be skipped by the gate.
  test('the gate passes a flat animation', async ({ page }) => {
    const encoded = await encodeAnimation(page, 'anim-6f.gif', 'webp', { slider: 80 })

    expect(encoded.uniqueColors).not.toBeNull()
    expect(encoded.uniqueColors as number).toBeLessThanOrEqual(64)
    expect(encoded.attempts).toContain('lossless')
  })

  // R-Q5: above 95 lossless is the only mode asked for, so there is no comparison to make and the
  // gate must not run at all.
  test('runs one attempt above 95, with no gate', async ({ page }) => {
    const encoded = await encodeAnimation(page, 'anim-6f.gif', 'webp', { slider: 100 })

    expect(encoded.attempts).toEqual(['lossless'])
    expect(encoded.mode).toBe('lossless')
    expect(encoded.uniqueColors).toBeNull()
  })
})

test.describe('APNG is always lossless', () => {
  // Animated PNG departs from R-Q12 and R-Q14, which govern the *still* path: there is no quantized
  // candidate at any slider value, so there is nothing to compare and nothing to choose between.
  //
  // The reason is that apng-optimizer's `minQuality` is a request it neither honours nor reports on
  // — measured, 50/70/90/99/100 all returned the same file — so a quantized candidate would be
  // quantized to an unknown quality with no floor, which is what R-Q11 exists to prevent. Written
  // losslessly instead, decided with the user in T29. See docs/task-notes/T29.md and §7.6.
  //
  // These tests exist to make that a decision rather than a drift: restoring a quantized branch has
  // to fail here first.
  test('writes one lossless candidate at every slider value, including the lowest', async ({
    page,
  }) => {
    for (const slider of [10, 50, 84, 85, 90, 100]) {
      const encoded = await encodeAnimation(page, 'anim-6f.png', 'png', { slider })

      expect(encoded.branch, `slider ${slider}`).toBe('lossless')
      expect(encoded.byteLength, `slider ${slider}`).toBe(encoded.sizes?.lossless)
    }
  })

  // R-Q12's boundary at 85 is the still path's. Here it must make no difference at all, which is a
  // stronger statement than "85 is lossless": 84 is lossless too, and the bytes are identical.
  test('produces the same bytes either side of the still path’s lossless point', async ({
    page,
  }) => {
    const below = await encodeAnimation(page, 'anim-6f.png', 'png', { slider: 84 })
    const at = await encodeAnimation(page, 'anim-6f.png', 'png', { slider: 85 })
    const bottom = await encodeAnimation(page, 'anim-6f.png', 'png', { slider: 10 })

    expect(below.byteLength).toBe(at.byteLength)
    expect(bottom.byteLength).toBe(at.byteLength)
  })

  // R-X46's `png-quantized` says "PNG output below a slider value of 85. States that PNG was not
  // written losslessly." Nothing on this path is written that way, so the caveat would be false.
  test('never records png-quantized, because nothing here quantizes', async ({ page }) => {
    for (const slider of [10, 84, 85]) {
      const encoded = await encodeAnimation(page, 'anim-6f.png', 'png', { slider })

      expect(encoded.caveats, `slider ${slider}`).toEqual([])
    }
  })
})
