import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// T26 — pipeline/stages/encode.ts (Functional Design R-Q5, R-Q6, R-Q7, R-I12, R-I14, R-I35;
// Technical Design §7.3, §7.4, §7.6).
//
// The decisions — modes, defines, colour plan, gate, tie-break — are unit-tested in
// src/pipeline/stages/encode-plan.spec.ts. This file proves that ImageMagick carries them out, on all
// three engines: pinned effort, exact lossless, R-Q6 in both directions, colour and alpha carried,
// metadata absent.
//
// Same constraints as resize.spec.ts: no DOM lib and no path alias in tests/e2e, so modules are
// imported inside `page.evaluate` by served path. The frame builders below are pure and import
// nothing, which is why WebKit accepts them from `addInitScript` scope.
const ENCODE_MODULE_PATH = '/src/pipeline/stages/encode.ts'
const DECODE_MODULE_PATH = '/src/pipeline/stages/decode.ts'
const COLOUR_MODULE_PATH = '/src/pipeline/stages/colour.ts'
const LOADER_MODULE_PATH = '/src/pipeline/codecs/loader.ts'

type Content = 'flat' | 'photo' | 'translucent'
type Mode = 'lossy' | 'lossless'

interface RgbaFrame {
  width: number
  height: number
  pixels: Uint8Array
  colour: unknown
  sourceOrientation: unknown
}

// Declared for the page callbacks; defined by the init script below.
declare function makeFrame(content: Content, width: number, height: number): RgbaFrame
declare function fourcc(bytes: Uint8Array, offset: number): string
declare function contains(bytes: Uint8Array, ascii: string): boolean
declare function quality(value: number): { kind: 'quality'; value: number; lossless: boolean }
declare function avifProfile(bytes: Uint8Array): number | null

/** The slice of magick-wasm's `IMagickImage` these callbacks touch. */
interface MagickImageLike {
  width: number
  height: number
  quality: number
  orientation: number
  readonly profileNames: readonly string[]
  settings: { setDefine(format: string, name: string, value: string): void }
  alpha(action: number): void
  getProfile(name: string): { data: Uint8Array } | null
  getPixels<T>(callback: (collection: { toByteArray(...args: unknown[]): T }) => T): T
  write<T>(format: string, callback: (data: Uint8Array) => T): T
}

function fixture(name: string): number[] {
  return Array.from(
    readFileSync(fileURLToPath(new URL(`../fixtures/decode/${name}`, import.meta.url))),
  )
}

const ICC_PROFILE = fixture('icc-profile.bin')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as Record<string, unknown>

    // A deterministic generator, so every engine encodes identical frames.
    const random = (seed: number) => () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed / 4294967296
    }

    scope.makeFrame = (content: string, width: number, height: number) => {
      const pixels = new Uint8Array(width * height * 4)
      const next = random(2026)
      const palette = Array.from({ length: 256 }, () => [
        Math.floor(next() * 256),
        Math.floor(next() * 256),
        Math.floor(next() * 256),
      ])

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4
          let rgba: number[]

          if (content === 'flat') {
            // Six flat blocks and a border: a logo or a diagram, the case lossless wins.
            const block = Math.floor((x * 3) / width) + 3 * Math.floor((y * 2) / height)
            const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8
            rgba = border ? [20, 20, 20, 255] : [...palette[block * 40]!, 255]
          } else {
            // A photographic stand-in: smooth gradients plus sensor-like noise, many distinct colours.
            const noise = () => Math.floor((next() - 0.5) * 24)
            const clamp = (v: number) => Math.max(0, Math.min(255, v))
            rgba = [
              clamp(Math.floor((x * 255) / width) + noise()),
              clamp(Math.floor((y * 255) / height) + noise()),
              clamp(Math.floor(((x + y) * 255) / (width + height)) + noise()),
              content === 'translucent' ? Math.floor((x * 255) / (width - 1)) : 255,
            ]
          }

          pixels.set(rgba, i)
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

    scope.fourcc = (bytes: Uint8Array, offset: number) =>
      String.fromCharCode(...bytes.subarray(offset, offset + 4))

    scope.contains = (bytes: Uint8Array, ascii: string) => {
      const needle = Array.from(ascii, (c) => c.charCodeAt(0))
      outer: for (let i = 0; i <= bytes.length - needle.length; i += 1) {
        for (let j = 0; j < needle.length; j += 1) {
          if (bytes[i + j] !== needle[j]) continue outer
        }
        return true
      }
      return false
    }

    scope.quality = (value: number) => ({ kind: 'quality', value, lossless: value > 95 })

    // The AV1 profile byte inside `av1C`: 1 means 4:4:4, 0 means 4:2:0.
    scope.avifProfile = (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length - 8; i += 1) {
        if (String.fromCharCode(...bytes.subarray(i, i + 4)) === 'av1C') {
          return (bytes[i + 5]! >> 5) & 7
        }
      }
      return null
    }
  })

  await page.goto('/')
})

test('JPEG, WebP and AVIF are written in their own container, at the frame size', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ encodePath, loaderPath }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()
      const out: Record<string, unknown> = {}

      for (const format of ['jpeg', 'webp', 'avif']) {
        const low = await encodeFrame(makeFrame('photo', 160, 120), format, quality(30))
        const high = await encodeFrame(makeFrame('photo', 160, 120), format, quality(90))
        const bytes: Uint8Array = high.bytes
        const read = ImageMagick.read(bytes, (image: MagickImageLike) => ({
          width: image.width,
          height: image.height,
          quality: image.quality,
        }))

        out[format] = {
          head: Array.from(bytes.subarray(0, 12)),
          riff: fourcc(bytes, 0) + fourcc(bytes, 8),
          ftyp: fourcc(bytes, 4) + fourcc(bytes, 8),
          read,
          lowBytes: low.bytes.byteLength,
          highBytes: bytes.byteLength,
          owned: bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength,
        }
      }

      return out as Record<
        string,
        {
          head: number[]
          riff: string
          ftyp: string
          read: { width: number; height: number; quality: number }
          lowBytes: number
          highBytes: number
          owned: boolean
        }
      >
    },
    { encodePath: ENCODE_MODULE_PATH, loaderPath: LOADER_MODULE_PATH },
  )

  expect(result.jpeg!.head.slice(0, 3)).toEqual([0xff, 0xd8, 0xff])
  expect(result.webp!.riff).toBe('RIFFWEBP')
  expect(result.avif!.ftyp).toBe('ftypavif')
  // JPEG records its quality in the quantization tables; ImageMagick reads it back.
  expect(result.jpeg!.read.quality).toBe(90)

  for (const format of ['jpeg', 'webp', 'avif']) {
    const r = result[format]!
    expect(r.read, format).toMatchObject({ width: 160, height: 120 })
    expect(r.lowBytes, `${format} quality 30 is smaller than 90`).toBeLessThan(r.highBytes)
    expect(r.owned, `${format} bytes own their buffer`).toBe(true)
  }
})

test('effort is pinned: AVIF speed 9 and WebP method 4, never the library default (§7.3)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ encodePath, loaderPath }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const magick = await (await import(/* @vite-ignore */ loaderPath)).ensureImageMagick()
      const { ImageMagick, MagickFormat, MagickReadSettings, AlphaAction } = magick
      const frame = makeFrame('photo', 400, 300)

      const direct = (format: string, q: number, defines: [string, string, string][]) =>
        ImageMagick.read(
          frame.pixels,
          new MagickReadSettings({
            format: MagickFormat.Rgba,
            width: frame.width,
            height: frame.height,
            depth: 8,
          }),
          (image: MagickImageLike) => {
            image.alpha(AlphaAction.Off)
            image.quality = q
            for (const [f, name, value] of defines) image.settings.setDefine(f, name, value)
            return image.write(format, (data) => Array.from(data))
          },
        ) as number[]

      const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
        a.length === b.length && Array.from(a).every((v, i) => v === b[i])

      const avif = await encodeFrame(frame, 'avif', quality(60))
      const webp = await encodeFrame(makeFrame('photo', 400, 300), 'webp', quality(60))

      return {
        avifMatchesSpeed9: same(
          avif.bytes,
          direct(MagickFormat.Avif, 60, [[MagickFormat.Heic, 'speed', '9']]),
        ),
        avifMatchesDefault: same(avif.bytes, direct(MagickFormat.Avif, 60, [])),
        avifMatchesSpeed6: same(
          avif.bytes,
          direct(MagickFormat.Avif, 60, [[MagickFormat.Heic, 'speed', '6']]),
        ),
        webpAttempts: webp.attempts,
        webpMatchesMethod4: same(
          webp.bytes,
          direct(MagickFormat.WebP, 60, [[MagickFormat.WebP, 'method', '4']]),
        ),
        webpMatchesMethod6: same(
          webp.bytes,
          direct(MagickFormat.WebP, 60, [[MagickFormat.WebP, 'method', '6']]),
        ),
      }
    },
    { encodePath: ENCODE_MODULE_PATH, loaderPath: LOADER_MODULE_PATH },
  )

  expect(result.avifMatchesSpeed9).toBe(true)
  expect(result.avifMatchesDefault).toBe(false)
  expect(result.avifMatchesSpeed6).toBe(false)
  // The photo frame is gated to lossy only, so the kept bytes are the method-4 lossy encode.
  expect(result.webpAttempts).toEqual(['lossy'])
  expect(result.webpMatchesMethod4).toBe(true)
  expect(result.webpMatchesMethod6).toBe(false)
})

test('above 95 WebP is exact; AVIF is highest-quality 4:4:4, not lossless (R-Q5, D9)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ encodePath, loaderPath }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()

      const compare = async (format: string, value: number, content: Content) => {
        const source = makeFrame(content, 120, 90)
        const expected = source.pixels.slice()
        const encoded = await encodeFrame(source, format, quality(value))
        const decoded = ImageMagick.read(encoded.bytes, (image: MagickImageLike) =>
          image.getPixels((c) => c.toByteArray(0, 0, image.width, image.height, 'RGBA')),
        ) as Uint8Array

        let rgb = 0
        let alpha = 0
        for (let i = 0; i < expected.length; i += 4) {
          alpha = Math.max(alpha, Math.abs(expected[i + 3]! - decoded[i + 3]!))
          // The colour of a fully transparent pixel is not part of the image.
          if (expected[i + 3] === 0) continue
          for (let k = 0; k < 3; k += 1) {
            rgb = Math.max(rgb, Math.abs(expected[i + k]! - decoded[i + k]!))
          }
        }

        return {
          rgb,
          alpha,
          mode: encoded.mode as Mode,
          attempts: encoded.attempts as Mode[],
          chunk: fourcc(encoded.bytes, 12),
          // av1C's second byte holds the AV1 profile: 1 is 4:4:4, 0 is 4:2:0.
          av1Profile: avifProfile(encoded.bytes),
        }
      }

      return {
        webp96: await compare('webp', 96, 'photo'),
        webp100: await compare('webp', 100, 'translucent'),
        avif80: await compare('avif', 80, 'photo'),
        avif96: await compare('avif', 96, 'photo'),
        avif100: await compare('avif', 100, 'translucent'),
        jpeg100: await compare('jpeg', 100, 'photo'),
      }
    },
    { encodePath: ENCODE_MODULE_PATH, loaderPath: LOADER_MODULE_PATH },
  )

  for (const key of ['webp96', 'webp100'] as const) {
    expect(result[key], key).toMatchObject({ rgb: 0, alpha: 0, mode: 'lossless' })
    expect(result[key].attempts).toEqual(['lossless'])
  }
  expect(result.webp96.chunk).toBe('VP8L')

  // D9: AOM's lossless mode is unusable in this build — the file it writes is wrong in every
  // browser — so a request above 95 is the highest quality AOM will encode, with no chroma
  // subsampling. It is lossy, and says so.
  for (const key of ['avif96', 'avif100'] as const) {
    expect(result[key], key).toMatchObject({ mode: 'lossy', attempts: ['lossy'], av1Profile: 1 })
    expect(result[key].rgb, key).toBeGreaterThan(0)
    expect(result[key].rgb, key).toBeLessThanOrEqual(12)
  }
  // Below 96 the chroma is left at ImageMagick's default.
  expect(result.avif80.av1Profile).toBe(0)

  expect(result.jpeg100.mode).toBe('lossy')
  expect(result.jpeg100.rgb).toBeGreaterThan(1)
})

test('R-Q6 keeps the smaller output in both directions, and the gate skips photographs', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ encodePath, loaderPath }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const magick = await (await import(/* @vite-ignore */ loaderPath)).ensureImageMagick()
      const { ImageMagick, MagickFormat, MagickReadSettings, AlphaAction } = magick

      // The two candidates, encoded independently with the §7.3 recipe.
      const both = (frame: RgbaFrame) =>
        (['lossy', 'lossless'] as const).map((mode) =>
          ImageMagick.read(
            frame.pixels,
            new MagickReadSettings({
              format: MagickFormat.Rgba,
              width: frame.width,
              height: frame.height,
              depth: 8,
            }),
            (image: MagickImageLike) => {
              image.alpha(AlphaAction.Off)
              if (mode === 'lossy') image.quality = 70
              else image.settings.setDefine(MagickFormat.WebP, 'lossless', 'true')
              image.settings.setDefine(MagickFormat.WebP, 'method', '4')
              return image.write(MagickFormat.WebP, (data) => Array.from(data))
            },
          ),
        ) as [number[], number[]]

      const run = async (content: Content, width: number, height: number) => {
        const frame = makeFrame(content, width, height)
        const [lossy, lossless] = both(frame)
        const encoded = await encodeFrame(frame, 'webp', quality(70))
        const kept = Array.from(encoded.bytes as Uint8Array)

        return {
          attempts: encoded.attempts as Mode[],
          mode: encoded.mode as Mode,
          uniqueColors: encoded.uniqueColors as number,
          chunk: fourcc(encoded.bytes, 12),
          lossyBytes: lossy.length,
          losslessBytes: lossless.length,
          keptIsLossy: kept.length === lossy.length && kept.every((v, i) => v === lossy[i]),
          keptIsLossless:
            kept.length === lossless.length && kept.every((v, i) => v === lossless[i]),
        }
      }

      return {
        flat: await run('flat', 400, 300),
        // 30,000 pixels cannot hold more distinct colours than the gate allows, so a small photograph
        // always attempts both — and loses the lossless attempt.
        smallPhoto: await run('photo', 200, 150),
        photo: await run('photo', 400, 300),
      }
    },
    { encodePath: ENCODE_MODULE_PATH, loaderPath: LOADER_MODULE_PATH },
  )

  // A flat graphic: both attempted, lossless smaller, lossless kept.
  expect(result.flat.attempts).toEqual(['lossy', 'lossless'])
  expect(result.flat.losslessBytes).toBeLessThan(result.flat.lossyBytes)
  expect(result.flat).toMatchObject({ mode: 'lossless', chunk: 'VP8L', keptIsLossless: true })

  // A small photograph: the gate lets lossless run, it loses, and lossy is kept.
  expect(result.smallPhoto.attempts).toEqual(['lossy', 'lossless'])
  expect(result.smallPhoto.lossyBytes).toBeLessThan(result.smallPhoto.losslessBytes)
  expect(result.smallPhoto).toMatchObject({ mode: 'lossy', chunk: 'VP8 ', keptIsLossy: true })

  // A photograph: the gate skips the lossless attempt it would lose (§7.6).
  expect(result.flat.uniqueColors).toBeLessThanOrEqual(7)
  expect(result.photo.uniqueColors).toBe(65_537)
  expect(result.photo.attempts).toEqual(['lossy'])
  expect(result.photo.lossyBytes).toBeLessThan(result.photo.losslessBytes)
  expect(result.photo).toMatchObject({ mode: 'lossy', keptIsLossy: true })
})

test('an ICC profile is written verbatim to every format and mode (R-I12)', async ({ page }) => {
  const result = await page.evaluate(
    async ({ encodePath, decodePath, loaderPath, source }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { decodeFrame } = await import(/* @vite-ignore */ decodePath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()
      const out: Record<string, number[] | null> = {}

      for (const [format, value] of [
        ['jpeg', 80],
        ['webp', 80],
        ['webp', 100],
        ['avif', 80],
        ['avif', 100],
      ] as const) {
        const frame = await decodeFrame(new Uint8Array(source))
        const encoded = await encodeFrame(frame, format, quality(value))
        out[`${format}${value}`] = ImageMagick.read(encoded.bytes, (image: MagickImageLike) => {
          const profile = image.getProfile('icc')
          return profile ? Array.from(profile.data) : null
        })
      }

      return out
    },
    {
      encodePath: ENCODE_MODULE_PATH,
      decodePath: DECODE_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
      source: fixture('icc-p3.jpg'),
    },
  )

  for (const [key, profile] of Object.entries(result)) {
    expect(profile, key).toEqual(ICC_PROFILE)
  }
})

test('CICP is written back into AVIF; an untagged frame gains no profile (R-I35, R-I14)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ encodePath, decodePath, colourPath, loaderPath, cicpSource, untaggedSource }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { decodeFrame } = await import(/* @vite-ignore */ decodePath)
      const { readCicp } = await import(/* @vite-ignore */ colourPath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()

      const encode = async (source: number[], format: string, value: number) => {
        const frame = await decodeFrame(new Uint8Array(source))
        const encoded = await encodeFrame(frame, format, quality(value))
        return {
          cicp: readCicp(encoded.bytes),
          profiles: ImageMagick.read(encoded.bytes, (image: MagickImageLike) => [
            ...image.profileNames,
          ]),
        }
      }

      // A frame whose CICP names a matrix this build does not actually convert with.
      const encodeFrameColour = async (colour: unknown, format: string) => {
        const encoded = await encodeFrame(
          { ...makeFrame('photo', 32, 24), colour },
          format,
          quality(80),
        )
        return { cicp: readCicp(encoded.bytes) }
      }

      const reject = async (colour: unknown, format: string) => {
        const frame = { ...makeFrame('photo', 32, 24), colour }
        try {
          const encoded = await encodeFrame(frame, format, quality(80))
          return {
            ok: true,
            profiles: ImageMagick.read(encoded.bytes, (image: MagickImageLike) => [
              ...image.profileNames,
            ]),
          }
        } catch (error) {
          return { ok: false, name: (error as Error).name }
        }
      }

      const p3 = {
        kind: 'cicp',
        cicp: { primaries: 12, transfer: 13, matrix: 6, fullRange: false },
      }
      const unspecified = {
        kind: 'cicp',
        cicp: { primaries: 2, transfer: 2, matrix: 2, fullRange: true },
      }

      return {
        cicpLossy: await encode(cicpSource, 'avif', 80),
        cicpHighQuality: await encode(cicpSource, 'avif', 100),
        untaggedAvif: await encode(untaggedSource, 'avif', 80),
        untaggedHighQuality: await encode(untaggedSource, 'avif', 100),
        untaggedWebp: await encode(untaggedSource, 'webp', 80),
        bt709Matrix: await encodeFrameColour(
          { kind: 'cicp', cicp: { primaries: 1, transfer: 13, matrix: 1, fullRange: false } },
          'avif',
        ),
        p3ToJpeg: await reject(p3, 'jpeg'),
        p3ToWebp: await reject(p3, 'webp'),
        unspecifiedToJpeg: await reject(unspecified, 'jpeg'),
      }
    },
    {
      encodePath: ENCODE_MODULE_PATH,
      decodePath: DECODE_MODULE_PATH,
      colourPath: COLOUR_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
      cicpSource: fixture('cicp-p3.avif'),
      untaggedSource: fixture('untagged.avif'),
    },
  )

  // The primaries and transfer are the source's, at every quality.
  expect(result.cicpLossy.cicp).toMatchObject({ primaries: 12, transfer: 13, matrix: 6 })
  expect(result.cicpHighQuality.cicp).toMatchObject({ primaries: 12, transfer: 13, matrix: 6 })
  expect(result.cicpLossy.profiles).not.toContain('icc')

  // The matrix written is the one this build's writer really converts with, not the source's label:
  // a file that claims BT.709 while holding BT.601 samples decodes 10 units out (measured, T26).
  expect(result.bt709Matrix.cicp).toMatchObject({ primaries: 1, transfer: 13, matrix: 6 })

  // Nothing is added to an untagged frame — no profile and no colour box — at any quality.
  expect(result.untaggedAvif.cicp).toBeNull()
  expect(result.untaggedAvif.profiles).not.toContain('icc')
  expect(result.untaggedWebp.profiles).not.toContain('icc')
  expect(result.untaggedHighQuality.cicp).toBeNull()
  expect(result.untaggedHighQuality.profiles).not.toContain('icc')

  expect(result.p3ToJpeg).toEqual({ ok: false, name: 'UnsupportedColourError' })
  expect(result.p3ToWebp).toEqual({ ok: false, name: 'UnsupportedColourError' })
  expect(result.unspecifiedToJpeg.ok).toBe(true)
  expect(result.unspecifiedToJpeg.profiles).not.toContain('icc')
})

test('translucency survives WebP and AVIF; an opaque frame writes no alpha plane', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ encodePath, loaderPath }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()

      const alphaError = async (format: string, value: number) => {
        const source = makeFrame('translucent', 120, 90)
        const expected = source.pixels.slice()
        const encoded = await encodeFrame(source, format, quality(value))
        const decoded = ImageMagick.read(encoded.bytes, (image: MagickImageLike) =>
          image.getPixels((c) => c.toByteArray(0, 0, image.width, image.height, 'RGBA')),
        ) as Uint8Array
        let max = 0
        for (let i = 3; i < expected.length; i += 4) {
          max = Math.max(max, Math.abs(expected[i]! - decoded[i]!))
        }
        return {
          max,
          hasAlphaMarker: contains(encoded.bytes, 'ALPH') || contains(encoded.bytes, 'auxC'),
        }
      }

      const opaque = async (format: string) => {
        const encoded = await encodeFrame(makeFrame('photo', 120, 90), format, quality(80))
        return {
          chunk: fourcc(encoded.bytes, 12),
          alph: contains(encoded.bytes, 'ALPH'),
          auxC: contains(encoded.bytes, 'auxC'),
        }
      }

      return {
        webpLossy: await alphaError('webp', 90),
        webpLossless: await alphaError('webp', 100),
        avifLossy: await alphaError('avif', 90),
        avifLossless: await alphaError('avif', 100),
        opaqueWebp: await opaque('webp'),
        opaqueAvif: await opaque('avif'),
      }
    },
    { encodePath: ENCODE_MODULE_PATH, loaderPath: LOADER_MODULE_PATH },
  )

  expect(result.webpLossless.max).toBe(0)
  expect(result.avifLossless.max).toBe(0)
  expect(result.webpLossy.max).toBeLessThanOrEqual(32)
  expect(result.avifLossy.max).toBeLessThanOrEqual(32)
  expect(result.avifLossy.hasAlphaMarker).toBe(true)

  expect(result.opaqueWebp).toMatchObject({ chunk: 'VP8 ', alph: false })
  expect(result.opaqueAvif.auxC).toBe(false)
})

test('no EXIF, XMP or orientation reaches the output, even from a source that had them (R-I10, R-I17)', async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ encodePath, decodePath, loaderPath, source }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const { decodeFrame } = await import(/* @vite-ignore */ decodePath)
      const { ImageMagick } = await (
        await import(/* @vite-ignore */ loaderPath)
      ).ensureImageMagick()
      const out: Record<string, { profiles: string[]; orientation: number; exif: boolean }> = {}

      for (const format of ['jpeg', 'webp', 'avif']) {
        const frame = await decodeFrame(new Uint8Array(source))
        const encoded = await encodeFrame(frame, format, quality(80))
        out[format] = {
          ...ImageMagick.read(encoded.bytes, (image: MagickImageLike) => ({
            profiles: [...image.profileNames],
            orientation: image.orientation,
          })),
          exif: contains(encoded.bytes, 'Exif'),
        }
      }

      return {
        sourceHasExif: contains(new Uint8Array(source), 'Exif'),
        out,
      }
    },
    {
      encodePath: ENCODE_MODULE_PATH,
      decodePath: DECODE_MODULE_PATH,
      loaderPath: LOADER_MODULE_PATH,
      source: fixture('orientation-6.jpg'),
    },
  )

  expect(result.sourceHasExif).toBe(true)

  for (const [format, r] of Object.entries(result.out)) {
    expect(r.exif, format).toBe(false)
    for (const name of ['exif', 'xmp', 'iptc', '8bim']) {
      expect(r.profiles, format).not.toContain(name)
    }
    expect([0, 1], format).toContain(r.orientation)
  }
})

test('every output decodes correctly in the engine that will display it', async ({ page }) => {
  // The other tests read the output back with ImageMagick — the library that wrote it — which cannot
  // notice a file that is well-formed but mislabelled. This one draws the output through the
  // browser's own decoder, which is what R-I16's Preview and the downloaded file actually use. It is
  // how T26 found that AOM's lossless AVIF renders black on WebKit (D9), and that a CICP matrix taken
  // from the source makes Chromium and Firefox invert a conversion that never happened.
  const result = await page.evaluate(
    async ({ encodePath }) => {
      const { encodeFrame } = await import(/* @vite-ignore */ encodePath)
      const scope = globalThis as unknown as {
        Blob: new (parts: [Uint8Array], options: { type: string }) => object
        URL: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void }
        Image: new () => { src: string; decode(): Promise<void> }
        document: {
          createElement(tag: 'canvas'): {
            width: number
            height: number
            getContext(type: '2d'): {
              drawImage(image: unknown, x: number, y: number): void
              getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }
            } | null
          }
        }
      }

      // Four flat saturated blocks: a lossy codec keeps a block centre within a few units, and any
      // colour-space or range mistake moves it by far more.
      const width = 160
      const height = 120
      const blocks = [
        [230, 20, 20],
        [20, 200, 30],
        [30, 40, 220],
        [240, 220, 30],
      ]
      const makeBlocks = (colour: unknown) => {
        const pixels = new Uint8Array(width * height * 4)
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const block = blocks[(Math.floor(x / 40) + Math.floor(y / 40)) % 4]!
            pixels.set([block[0]!, block[1]!, block[2]!, 255], (y * width + x) * 4)
          }
        }
        return { width, height, pixels, colour, sourceOrientation: { kind: 'absent' } }
      }

      const mediaType: Record<string, string> = {
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        avif: 'image/avif',
      }

      const measure = async (format: string, value: number, colour: unknown) => {
        const encoded = await encodeFrame(makeBlocks(colour), format, quality(value))
        const url = scope.URL.createObjectURL(
          new scope.Blob([encoded.bytes], { type: mediaType[format]! }),
        )
        try {
          const image = new scope.Image()
          image.src = url
          await image.decode()

          const canvas = scope.document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (context === null) throw new Error('no 2d context')
          context.drawImage(image, 0, 0)
          const data = context.getImageData(0, 0, width, height).data

          let max = 0
          // Block centres only: a lossy codec is entitled to ring at the edges between them.
          for (const [x, y] of [
            [20, 20],
            [60, 20],
            [100, 20],
            [140, 20],
            [20, 60],
            [140, 100],
          ]) {
            const expected = blocks[(Math.floor(x! / 40) + Math.floor(y! / 40)) % 4]!
            for (let band = 0; band < 3; band += 1) {
              max = Math.max(max, Math.abs(data[(y! * width + x!) * 4 + band]! - expected[band]!))
            }
          }

          return max
        } finally {
          scope.URL.revokeObjectURL(url)
        }
      }

      const untagged = { kind: 'untagged' }
      // BT.709 primaries and the sRGB transfer: the same colour an untagged frame has, so the
      // browser's own rendering is comparable, with a matrix this build does not convert with.
      const bt709 = {
        kind: 'cicp',
        cicp: { primaries: 1, transfer: 13, matrix: 1, fullRange: false },
      }

      return {
        jpeg90: await measure('jpeg', 90, untagged),
        webp70: await measure('webp', 70, untagged),
        webpLossless: await measure('webp', 100, untagged),
        avif80: await measure('avif', 80, untagged),
        avif100: await measure('avif', 100, untagged),
        avifCicp: await measure('avif', 80, bt709),
        // 96-100 adds `heic:chroma 444` on top of the CICP defines; the combination is its own path.
        avifCicpHigh: await measure('avif', 100, bt709),
      }
    },
    { encodePath: ENCODE_MODULE_PATH },
  )

  // Lossless WebP is exact wherever the engine draws it.
  expect(result.webpLossless).toBe(0)

  // Per-row bounds, not one loose one. Measured drift for the shipped recipes is 0-3 units and is
  // stable across engines and repetitions, while the two mistakes this test exists to catch measured
  // 5-240 (AOM's lossless AVIF) and 10 (a matrix label the pixels were not converted with). A single
  // bound of 6 would have let the untagged lossless AVIF through on Chromium, which measures exactly
  // 5 — so the plain rows, where nothing should move, are held to 2.
  const bounds: Record<string, number> = {
    jpeg90: 2,
    webp70: 2,
    webpLossless: 0,
    avif80: 2,
    avif100: 2,
    // A CICP-signalled file goes through a colour conversion in the writer and back in the decoder.
    avifCicp: 4,
    avifCicpHigh: 4,
  }

  for (const [label, max] of Object.entries(result)) {
    expect(
      max,
      `${label}: block centres drift by ${max} in this engine's decoder`,
    ).toBeLessThanOrEqual(bounds[label]!)
  }
})
