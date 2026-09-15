// The page half of T23's D3 measurement: does an embedded ICC profile survive each encoder path in
// Technical Design §4.2?
//
// In a browser rather than in Node because two of the paths are browser-only — gifsicle-wasm-browser
// manages its own Worker, and @jsquash/oxipng fetches its WASM over HTTP. Everything else could have
// run in Node, but running all of them in one place makes the comparison one measurement rather than
// two half-measurements taken under different conditions.
//
// D3's claim is "ICC profiles survive every encoder path". Each path below answers it with one of
// three outcomes: the profile is present and byte-identical, present but changed, or gone.

import {
  ImageMagick,
  initializeImageMagick,
  ImageProfile,
  MagickFormat,
  MagickReadSettings,
} from '@imagemagick/magick-wasm'
import gifsicle from 'gifsicle-wasm-browser'
import optimise, { init as initOxipng } from '@jsquash/oxipng/optimise.js'
import UPNG from 'upng-js'
import { APNGOptimizer } from 'apng-optimizer'

// `new URL(specifier, import.meta.url)` rather than a `?url` import: this is the idiom
// src/pipeline/codecs/loader.ts uses, and the one Vite resolves through a package's exports map.
const magickWasmUrl = new URL('@imagemagick/magick-wasm/magick.wasm', import.meta.url)
const apngWasmUrl = new URL('apng-optimizer/apng-optimizer.wasm', import.meta.url)

const WIDTH = 64
const HEIGHT = 48

let ready = null
function ensureReady() {
  if (!ready) ready = initializeImageMagick(magickWasmUrl)
  return ready
}

function testPixels() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4
      pixels[i] = (x * 4) & 255
      pixels[i + 1] = (y * 5) & 255
      pixels[i + 2] = 128
      pixels[i + 3] = 255
    }
  }
  return pixels
}

function readWithSettings(pixels, mutate, format) {
  return ImageMagick.read(
    pixels,
    new MagickReadSettings({ format: MagickFormat.Rgba, width: WIDTH, height: HEIGHT, depth: 8 }),
    (image) => {
      image.quality = 90
      mutate?.(image)
      let out = null
      image.write(format, (data) => {
        out = new Uint8Array(data)
      })
      return out
    },
  )
}

/** What ImageMagick can see of a file's ICC profile, compared against the profile that went in. */
function inspect(bytes, icc) {
  try {
    return ImageMagick.read(bytes, (image) => {
      const profile = image.getColorProfile()
      if (!profile) return { bytes: bytes.length, profile: 'absent', identical: false }
      const data = new Uint8Array(profile.data)
      const identical = data.length === icc.length && data.every((v, i) => v === icc[i])
      return {
        bytes: bytes.length,
        profile: 'present',
        profileBytes: data.length,
        identical,
        description: profile.description,
      }
    })
  } catch (error) {
    return { bytes: bytes.length, profile: 'unreadable', identical: false, error: String(error).slice(0, 200) }
  }
}

// ---------------------------------------------------------------------------------------------
// PNG chunk surgery, for the APNG path.
//
// UPNG takes raw RGBA and writes its own chunks, so there is no profile for it to preserve — the
// question §7.7 actually needs answered is whether one can be *attached* to what it produces, since
// the alternative it names is converting animated PNG to sRGB and recording a caveat.
// ---------------------------------------------------------------------------------------------

function pngChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    found.push({ type, start: offset, end: offset + 12 + length })
    if (type === 'IEND') break
    offset += 12 + length
  }
  return found
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Rebuilds a PNG with an `iCCP` chunk carrying `icc`, dropping any `sRGB` chunk.
 *
 * `sRGB` and `iCCP` are mutually exclusive in the PNG specification and UPNG writes `sRGB`, so
 * leaving it in place produces a file libpng warns about ("iCCP: too many profiles") and whose
 * colour two readers may disagree about.
 */
async function attachIccToPng(png, icc) {
  const name = 'ICC profile'
  const compressed = await deflate(icc)
  const payload = new Uint8Array(name.length + 2 + compressed.length)
  for (let i = 0; i < name.length; i++) payload[i] = name.charCodeAt(i)
  payload[name.length] = 0
  payload[name.length + 1] = 0
  payload.set(compressed, name.length + 2)

  const chunk = new Uint8Array(12 + payload.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, payload.length)
  chunk.set([0x69, 0x43, 0x43, 0x50], 4) // "iCCP"
  chunk.set(payload, 8)
  view.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)))

  const chunks = pngChunks(png)
  const parts = [png.subarray(0, 8)]
  let inserted = false
  for (const c of chunks) {
    if (c.type === 'sRGB' || c.type === 'iCCP') continue
    if (!inserted && c.type !== 'IHDR') {
      parts.push(chunk)
      inserted = true
    }
    parts.push(png.subarray(c.start, c.end))
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// ---------------------------------------------------------------------------------------------

async function measureIccSurvival(iccArray) {
  await ensureReady()
  const icc = new Uint8Array(iccArray)
  const pixels = testPixels()
  const embed = (image) => image.setProfile(new ImageProfile('icc', icc))
  const paths = {}

  for (const [name, format] of [
    ['imagemagick-jpeg', MagickFormat.Jpeg],
    ['imagemagick-png', MagickFormat.Png],
    ['imagemagick-webp', MagickFormat.WebP],
    ['imagemagick-avif', MagickFormat.Avif],
    ['imagemagick-gif', MagickFormat.Gif],
  ]) {
    try {
      paths[name] = inspect(readWithSettings(pixels, embed, format), icc)
    } catch (error) {
      paths[name] = { profile: 'encode-failed', identical: false, error: String(error).slice(0, 200) }
    }
  }

  // PNG still: ImageMagick writes it, oxipng optimises it. §4.2's "quantize" step is
  // libimagequant, which transforms pixels and produces no file, so it is not a profile-carrying
  // step and is not measured here — whatever writes the PNG after it is.
  try {
    const png = readWithSettings(pixels, embed, MagickFormat.Png)
    await initOxipng()
    const optimised = new Uint8Array(await optimise(png, { level: 2, interlace: false }))
    paths['oxipng'] = inspect(optimised, icc)
  } catch (error) {
    paths['oxipng'] = { profile: 'failed', identical: false, error: String(error).slice(0, 200) }
  }

  // GIF: ImageMagick writes it, gifsicle optimises it.
  try {
    const gif = readWithSettings(pixels, embed, MagickFormat.Gif)
    const files = await gifsicle.run({
      input: [{ file: new Blob([gif], { type: 'image/gif' }), name: 'in.gif' }],
      command: ['-O2 in.gif -o /out/out.gif'],
    })
    const out = new Uint8Array(await files[0].arrayBuffer())
    paths['gifsicle'] = inspect(out, icc)
  } catch (error) {
    paths['gifsicle'] = { profile: 'failed', identical: false, error: String(error).slice(0, 200) }
  }

  // Animated PNG: UPNG assembles it, apng-optimizer optimises it. D3's named weak point.
  try {
    const frame = testPixels()
    const apng = new Uint8Array(UPNG.encode([frame.buffer], WIDTH, HEIGHT, 0))
    paths['upng'] = {
      ...inspect(apng, icc),
      chunks: pngChunks(apng).map((c) => c.type),
    }

    const withProfile = await attachIccToPng(apng, icc)
    paths['upng-with-spliced-iccp'] = {
      ...inspect(withProfile, icc),
      chunks: pngChunks(withProfile).map((c) => c.type),
    }

    const optimizer = await APNGOptimizer.createOptimizer(apngWasmUrl.href)
    const optimised = new Uint8Array(optimizer.optAPNG(withProfile))
    paths['apng-optimizer'] = {
      ...inspect(optimised, icc),
      chunks: pngChunks(optimised).map((c) => c.type),
    }

    // The order that decides whether §7.7's "convert to sRGB for animated PNG only" contingency is
    // needed at all: if the profile can be attached *after* the optimiser has run, nothing is lost
    // and no caveat has to be recorded.
    const optimisedThenTagged = await attachIccToPng(optimised, icc)
    paths['apng-optimizer-then-splice'] = {
      ...inspect(optimisedThenTagged, icc),
      chunks: pngChunks(optimisedThenTagged).map((c) => c.type),
    }
  } catch (error) {
    paths['upng'] = paths['upng'] ?? { profile: 'failed', identical: false }
    paths['apng-optimizer'] = { profile: 'failed', identical: false, error: String(error).slice(0, 200) }
  }

  return paths
}

window.t23 = { measureIccSurvival }
