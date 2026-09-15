// A13's half of T23's measurement: CICP signalling in a *real* HEIC.
//
// No CICP-only HEIC can be committed to this repository. The build has no HEVC encoder (A11), so
// one cannot be generated; and a real one is a copyrighted photograph, which AGENTS.md forbids
// committing along with the directory it comes from. So this module reads the machine-local photo
// fixtures directory at measurement time (read-only, never written, never named in any output) and
// constructs the fixture in memory.
//
// The construction is a same-size, in-place overwrite of the file's existing `colr` box: the box
// keeps its length and its type, and its payload becomes an `nclx` record instead of an embedded
// ICC profile, with the remainder zero-filled. Nothing else in the file moves, so every `iloc`
// offset into `mdat` stays valid and the HEVC bitstream is untouched — which is what makes the
// result a genuine HEIC that a decoder reads normally, rather than a mock.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CONTAINERS = new Set(['meta', 'iprp', 'ipco'])

export function readBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found = []

  const walk = (start, end, depth) => {
    let offset = start
    while (offset + 8 <= end && depth < 8) {
      let size = view.getUint32(offset)
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
      let header = 8
      if (size === 1) {
        size = Number(view.getBigUint64(offset + 8))
        header = 16
      } else if (size === 0) {
        size = end - offset
      }
      if (size < header || offset + size > end) return
      found.push({ type, start: offset, payload: offset + header, end: offset + size, size })
      if (CONTAINERS.has(type)) walk(offset + header + (type === 'meta' ? 4 : 0), offset + size, depth + 1)
      offset += size
    }
  }

  walk(0, bytes.length, 0)
  return found
}

export function colrBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return readBoxes(bytes)
    .filter((box) => box.type === 'colr')
    .map((box) => {
      const kind = String.fromCharCode(
        bytes[box.payload],
        bytes[box.payload + 1],
        bytes[box.payload + 2],
        bytes[box.payload + 3],
      )
      return kind === 'nclx'
        ? {
            kind,
            box,
            primaries: view.getUint16(box.payload + 4),
            transfer: view.getUint16(box.payload + 6),
            matrix: view.getUint16(box.payload + 8),
            fullRange: (bytes[box.payload + 10] & 0x80) !== 0,
          }
        : { kind, box, payloadBytes: box.size - (box.payload - box.start) - 4 }
    })
}

/**
 * A copy of `bytes` whose `prof` colr box has become an `nclx` one of exactly the same size.
 * Returns null when the file has no ICC-carrying colr box to convert.
 */
export function rewriteToCicpOnly(bytes, { primaries, transfer, matrix, fullRange }) {
  const profile = colrBoxes(bytes).find((entry) => entry.kind === 'prof' || entry.kind === 'rICC')
  if (!profile) return null

  const copy = new Uint8Array(bytes)
  const at = profile.box.payload
  copy.fill(0, at, profile.box.end)
  copy.set([0x6e, 0x63, 0x6c, 0x78], at) // "nclx"
  const view = new DataView(copy.buffer)
  view.setUint16(at + 4, primaries)
  view.setUint16(at + 6, transfer)
  view.setUint16(at + 8, matrix)
  copy[at + 10] = fullRange ? 0x80 : 0
  return copy
}

/**
 * Every **distinct** HEIF-family file under the fixtures directory, as bytes. No path or filename
 * leaves here.
 *
 * Deduplicated by content hash: the walk is recursive and the directory holds copies of the same
 * photograph in more than one place, so counting files found would report a larger and more varied
 * sample than actually exists. Five paths, three images.
 */
export function heifCandidates(directory, maxBytes = 32 * 1024 * 1024) {
  const found = []
  const seen = new Set()

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (/\.(heic|heif|avif)$/i.test(entry.name)) {
        try {
          if (statSync(path).size <= maxBytes) {
            const bytes = readFileSync(path)
            const digest = createHash('sha256').update(bytes).digest('hex')
            if (!seen.has(digest)) {
              seen.add(digest)
              found.push({
                extension: entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase(),
                bytes,
              })
            }
          }
        } catch {
          /* unreadable; not a finding */
        }
      }
    }
  }

  walk(directory)
  return found
}
