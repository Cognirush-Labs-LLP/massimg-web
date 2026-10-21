function skipGifSubBlocks(bytes: Uint8Array, start: number): number | undefined {
  let offset = start
  for (;;) {
    if (offset >= bytes.length) return undefined
    const blockSize = bytes[offset]!
    offset += 1
    if (blockSize === 0) return offset
    if (offset + blockSize > bytes.length) return undefined
    offset += blockSize
  }
}

/**
 * The number of image descriptors in a GIF, walked block by block, or `undefined` when `bytes` does
 * not start with a GIF signature. Every step advances by at least one byte and stops at the end of
 * the data, so a damaged or truncated file ends the walk rather than looping.
 */
export function countGifFrames(bytes: Uint8Array): number | undefined {
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (bytes.length < 13 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
    return undefined
  }

  const screenPacked = bytes[10]!
  let offset = 13
  if (screenPacked & 0x80) {
    offset += 3 * (1 << ((screenPacked & 0x07) + 1))
  }

  let frameCount = 0
  outer: while (offset < bytes.length) {
    const marker = bytes[offset]!
    offset += 1
    switch (marker) {
      case 0x21: {
        if (offset >= bytes.length) break outer
        offset += 1
        const next = skipGifSubBlocks(bytes, offset)
        if (next === undefined) break outer
        offset = next
        break
      }
      case 0x2c: {
        frameCount += 1
        if (offset + 9 > bytes.length) break outer
        const localPacked = bytes[offset + 8]!
        offset += 9
        if (localPacked & 0x80) {
          offset += 3 * (1 << ((localPacked & 0x07) + 1))
        }
        if (offset >= bytes.length) break outer
        offset += 1
        const next = skipGifSubBlocks(bytes, offset)
        if (next === undefined) break outer
        offset = next
        break
      }
      default:
        break outer
    }
  }

  return frameCount
}
