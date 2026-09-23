// Source animations for the C7 sweep, generated in Node at run time rather than committed.
//
// The sweep needs 128 frames at 400x400 and 16 frames at 1200x1200; committing those would put tens
// of megabytes of decoded-equivalent fixtures in the repository for a measurement that reproduces in
// a minute. The frame *content* comes from scripts/build-animated-fixtures.mjs, imported rather than
// copied, so there is one definition of what a frame looks like.
//
// **The WebP sources are written by ImageMagick, which is also what decodes them.** That would be
// circular for a correctness test and is not one: this harness measures how much memory decoding
// costs, and the source only has to be a valid animated WebP of the right shape. It is checked
// anyway — every generated source is read back through `readWebpAnimation`/`readApngAnimation`, the
// pipeline's own container readers, which share no code with ImageMagick or UPNG, and the harness
// refuses to run if the frame count or the canvas size is not what was asked for.
//
// The APNG sources are assembled here from chunks, with no encoder involved at all.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { largeFrameImage, pngChunk } from '../../scripts/build-animated-fixtures.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let magick = null

async function ensureMagick() {
  if (magick === null) {
    const module = await import('@imagemagick/magick-wasm')
    await module.initializeImageMagick(
      readFileSync(join(REPO_ROOT, 'node_modules', '@imagemagick', 'magick-wasm', 'dist', 'x86', 'magick.wasm')),
    )
    magick = module
  }

  return magick
}

/**
 * An animated WebP of `frameCount` frames at `size` x `size`, lossless so the decode has real pixels
 * to move rather than a solid colour the codec can shortcut.
 */
export async function animatedWebp(frameCount, size, delayMs = 60) {
  const { MagickFormat, MagickImage, MagickImageCollection, MagickReadSettings } =
    await ensureMagick()
  const settings = new MagickReadSettings({
    format: MagickFormat.Rgba,
    width: size,
    height: size,
    depth: 8,
  })

  return MagickImageCollection.use((collection) => {
    for (let index = 0; index < frameCount; index += 1) {
      // `MagickImage.create` hands back an image the collection takes ownership of. Building the
      // frames through `ImageMagick.read`'s callback form instead does not work: the callback's
      // image is disposed on return, and the binding refuses to hand the disposed instance back.
      const image = MagickImage.create(largeFrameImage(index, size, size, frameCount), settings)

      image.animationTicksPerSecond = 100
      image.animationDelay = Math.round(delayMs / 10)
      image.settings.setDefine(MagickFormat.WebP, 'lossless', 'true')
      collection.push(image)
    }

    collection[0].animationIterations = 0

    return collection.write(MagickFormat.WebP, (data) => new Uint8Array(data.slice()))
  })
}

/**
 * An animated PNG of `frameCount` frames at `size` x `size`, assembled from chunks.
 *
 * Every frame is a full-canvas `fdAT` with `dispose_op` 0 and `blend_op` 0 — the source shape UPNG's
 * `toRGBA8` has the least work to do with, which is the conservative choice for a memory
 * measurement: whatever this costs, a real APNG with sub-rectangles and blending costs at least as
 * much.
 */
export function animatedApng(frameCount, size, delayMs = 60) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const actl = Buffer.alloc(8)
  actl.writeUInt32BE(frameCount, 0)
  actl.writeUInt32BE(0, 4)

  const pieces = [PNG_SIGNATURE, Buffer.from(pngChunk('IHDR', [...ihdr])), Buffer.from(pngChunk('acTL', [...actl]))]
  let sequence = 0

  for (let index = 0; index < frameCount; index += 1) {
    const fctl = Buffer.alloc(26)
    fctl.writeUInt32BE(sequence, 0)
    sequence += 1
    fctl.writeUInt32BE(size, 4)
    fctl.writeUInt32BE(size, 8)
    fctl.writeUInt32BE(0, 12)
    fctl.writeUInt32BE(0, 16)
    fctl.writeUInt16BE(delayMs, 20)
    fctl.writeUInt16BE(1000, 22)
    fctl[24] = 0
    fctl[25] = 0
    pieces.push(Buffer.from(pngChunk('fcTL', [...fctl])))

    const rgba = largeFrameImage(index, size, size, frameCount)
    const stride = size * 4
    const raw = Buffer.alloc(size * (1 + stride))

    for (let y = 0; y < size; y += 1) {
      raw[y * (1 + stride)] = 0
      Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (1 + stride) + 1)
    }

    const compressed = deflateSync(raw, { level: 1 })

    if (index === 0) {
      pieces.push(Buffer.from(pngChunk('IDAT', [...compressed])))
    } else {
      const fdat = Buffer.alloc(4 + compressed.length)
      fdat.writeUInt32BE(sequence, 0)
      sequence += 1
      compressed.copy(fdat, 4)
      pieces.push(Buffer.from(pngChunk('fdAT', [...fdat])))
    }
  }

  pieces.push(Buffer.from(pngChunk('IEND', [])))

  return new Uint8Array(Buffer.concat(pieces))
}
