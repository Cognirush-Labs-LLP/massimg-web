// Small typed facade over wasm-bindgen's generated glue. The glue and WASM are built from
// jSquash's oxipng wrapper with the Rust dependency pinned to oxipng 9.1.5. Keeping the generated
// file separate makes this hand-written boundary reviewable and gives the rest of the pipeline the
// same options shape it used before the compatibility-fixed APNG build was introduced.

import init, { optimise } from './oxipng-wasm.generated.js'

export interface OxipngOptions {
  level: number
  interlace: boolean
  optimiseAlpha: boolean
}

let ready: Promise<unknown> | null = null

export async function initOxipng(): Promise<void> {
  if (!ready) {
    ready = init()
  }

  await ready
}

export async function optimiseWithOxipng(
  data: ArrayBuffer,
  options: OxipngOptions,
): Promise<ArrayBuffer> {
  await initOxipng()
  const bytes = optimise(
    new Uint8Array(data),
    options.level,
    options.interlace,
    options.optimiseAlpha,
  )
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
