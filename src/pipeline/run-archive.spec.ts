import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageId } from '@/domain/types'
import { runtimeLimits } from '@/config/limits'

const opfsMocks = vi.hoisted(() => ({
  writeArchive: vi.fn<(source: unknown) => Promise<void>>(async () => {}),
  writeOutputCopy: vi.fn<(index: number, bytes: Uint8Array, meta: unknown) => Promise<void>>(
    async () => {},
  ),
  deleteOutputCopy: vi.fn<(index: number) => Promise<void>>(async () => {}),
  deleteRunArtifacts: vi.fn<() => Promise<void>>(async () => {}),
  checkCombinedQuota: vi.fn<
    (
      archiveBytes: number,
      shareBytes: number,
    ) => Promise<{
      archive: { ok: boolean; required: number; available: number }
      combined: { ok: boolean; required: number; available: number }
    }>
  >(async () => ({
    archive: { ok: true, required: 0, available: Infinity },
    combined: { ok: true, required: 0, available: Infinity },
  })),
}))

vi.mock('@/platform/opfs', () => opfsMocks)

const zipMocks = vi.hoisted(() => ({
  // Bypasses real ZIP construction entirely: run-archive.ts's own orchestration (queue ordering,
  // teeing, candidate lifecycle) is what this file tests, not client-zip's internals — those are
  // covered separately by the vendored library itself and by E2/E3 in docs/assumptions.md.
  makeZip: vi.fn((iterable: AsyncIterable<{ name: string; input: Uint8Array }>) => iterable),
  predictLength: vi.fn((entries: Iterable<{ size: number | bigint }>) => {
    let total = 0n
    for (const entry of entries) {
      total += BigInt(entry.size)
    }
    return total
  }),
}))

vi.mock('client-zip', () => zipMocks)

import { openRunArchiveSink, preflightRunArchive, type NamingEntry } from './run-archive'

const idA = 'image-a' as ImageId
const idB = 'image-b' as ImageId
const idC = 'image-c' as ImageId

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

/** Drains whatever `writeArchive` was handed (the queue itself, since `makeZip` is a passthrough
 * mock) and resolves with every entry it yielded, in order. */
async function drainArchive(): Promise<{ name: string; bytes: Uint8Array }[]> {
  const collected: { name: string; bytes: Uint8Array }[] = []
  opfsMocks.writeArchive.mockImplementationOnce(async (iterable: unknown) => {
    for await (const entry of iterable as AsyncIterable<{ name: string; input: Uint8Array }>) {
      collected.push({ name: entry.name, bytes: entry.input })
    }
  })
  return collected
}

beforeEach(() => {
  vi.clearAllMocks()
  zipMocks.makeZip.mockImplementation((iterable) => iterable)
})

describe('openRunArchiveSink — single-image run', () => {
  it('writes directly to output copy 0, never touching the archive', async () => {
    const sink = openRunArchiveSink({
      pathsByImage: new Map([[idA, 'a.jpg']]),
      multiImage: false,
      shareEligible: false,
    })

    await sink.submit(idA, bytes(1, 2, 3), 'jpeg')
    await sink.finish()

    expect(opfsMocks.writeOutputCopy).toHaveBeenCalledOnce()
    expect(opfsMocks.writeOutputCopy).toHaveBeenCalledWith(0, bytes(1, 2, 3), {
      name: 'a.jpg',
      mimeType: 'image/jpeg',
    })
    expect(opfsMocks.writeArchive).not.toHaveBeenCalled()
  })

  it('ignores a report entry when there is no queue to append it to', async () => {
    const sink = openRunArchiveSink({
      pathsByImage: new Map([[idA, 'a.jpg']]),
      multiImage: false,
      shareEligible: false,
    })

    await sink.submit(idA, bytes(1, 2, 3), 'jpeg')
    await expect(
      sink.finish({ path: 'image_compression_report.txt', bytes: bytes(9) }),
    ).resolves.toBeUndefined()

    expect(opfsMocks.writeArchive).not.toHaveBeenCalled()
  })
})

describe('openRunArchiveSink — multi-image, not Share-eligible', () => {
  it('keeps only the first success as the R-X16 candidate, releasing it on the 2nd success', async () => {
    const collected = await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'sub/b.png'],
        [idC, 'c.webp'],
      ]),
      multiImage: true,
      shareEligible: false,
    })

    await sink.submit(idA, bytes(1), 'jpeg')
    expect(opfsMocks.writeOutputCopy).toHaveBeenCalledOnce()
    expect(opfsMocks.writeOutputCopy).toHaveBeenCalledWith(0, bytes(1), {
      name: 'a.jpg',
      mimeType: 'image/jpeg',
    })

    await sink.submit(idB, bytes(2), 'png')
    expect(opfsMocks.deleteOutputCopy).toHaveBeenCalledOnce()
    expect(opfsMocks.deleteOutputCopy).toHaveBeenCalledWith(0)

    await sink.submit(idC, bytes(3), 'webp')
    // A 3rd success touches neither write nor delete again — only the first two matter.
    expect(opfsMocks.writeOutputCopy).toHaveBeenCalledOnce()
    expect(opfsMocks.deleteOutputCopy).toHaveBeenCalledOnce()

    await sink.finish()

    expect(collected.map((e) => e.name)).toEqual(['a.jpg', 'sub/b.png', 'c.webp'])
  })

  it('does not release the candidate while the 1st success is still writing it', async () => {
    // Two workers finishing close together submit concurrently; the delete must wait for the write.
    const events: string[] = []
    let finishWrite: () => void = () => {}
    opfsMocks.writeOutputCopy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            events.push('write finished')
            resolve()
          }
        }),
    )
    opfsMocks.deleteOutputCopy.mockImplementationOnce(async () => {
      events.push('delete')
    })

    await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
      ]),
      multiImage: true,
      shareEligible: false,
    })

    const first = sink.submit(idA, bytes(1), 'jpeg')
    const second = sink.submit(idB, bytes(2), 'png')

    // Let every microtask that can run, run: the delete must still be held back.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opfsMocks.deleteOutputCopy).not.toHaveBeenCalled()

    finishWrite()
    await Promise.all([first, second])
    await sink.finish()

    expect(events).toEqual(['write finished', 'delete'])
  })

  it('still releases the candidate when the 1st success failed to write it', async () => {
    opfsMocks.writeOutputCopy.mockRejectedValueOnce(new Error('disk full'))

    await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
      ]),
      multiImage: true,
      shareEligible: false,
    })

    const first = sink.submit(idA, bytes(1), 'jpeg')
    const second = sink.submit(idB, bytes(2), 'png')

    // The 1st submit reports its own failure; the 2nd must neither inherit it nor skip the delete.
    await expect(first).rejects.toThrow('disk full')
    await expect(second).resolves.toBeUndefined()
    expect(opfsMocks.deleteOutputCopy).toHaveBeenCalledWith(0)
  })

  it('appends a given report entry last, before the queue closes (T41)', async () => {
    const collected = await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
      ]),
      multiImage: true,
      shareEligible: false,
    })

    await sink.submit(idA, bytes(1), 'jpeg')
    await sink.submit(idB, bytes(2), 'png')
    await sink.finish({ path: 'image_compression_report.txt', bytes: bytes(9, 9) })

    expect(collected.map((e) => e.name)).toEqual(['a.jpg', 'b.png', 'image_compression_report.txt'])
    expect(collected.at(-1)?.bytes).toEqual(bytes(9, 9))
  })
})

describe('openRunArchiveSink — multi-image, Share-eligible', () => {
  it('writes every success its own indexed copy and never deletes the candidate', async () => {
    await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
      ]),
      multiImage: true,
      shareEligible: true,
      shareNamesByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
      ]),
    })

    await sink.submit(idA, bytes(1), 'jpeg')
    await sink.submit(idB, bytes(2), 'png')
    await sink.finish()

    expect(opfsMocks.writeOutputCopy).toHaveBeenNthCalledWith(1, 0, bytes(1), {
      name: 'a.jpg',
      mimeType: 'image/jpeg',
    })
    expect(opfsMocks.writeOutputCopy).toHaveBeenNthCalledWith(2, 1, bytes(2), {
      name: 'b.png',
      mimeType: 'image/png',
    })
    expect(opfsMocks.deleteOutputCopy).not.toHaveBeenCalled()
  })

  // R-X49: grid order, not completion order. `readOutputCopies()` sorts by write index, so the
  // index *is* the share payload's ordering — writing at `successCount - 1` would hand Share
  // whatever order the workers happened to finish in.
  it('writes each copy at its grid position, not its completion position', async () => {
    await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
        [idC, 'c.webp'],
      ]),
      multiImage: true,
      shareEligible: true,
      // Grid order: a, b, c.
      shareNamesByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
        [idC, 'c.webp'],
      ]),
    })

    // Completion order: c, a, b — nothing like grid order.
    await sink.submit(idC, bytes(3), 'webp')
    await sink.submit(idA, bytes(1), 'jpeg')
    await sink.submit(idB, bytes(2), 'png')
    await sink.finish()

    const indexByName = new Map(
      opfsMocks.writeOutputCopy.mock.calls.map(([index, , meta]) => [
        (meta as { name: string }).name,
        index,
      ]),
    )
    expect(indexByName.get('a.jpg')).toBe(0)
    expect(indexByName.get('b.png')).toBe(1)
    expect(indexByName.get('c.webp')).toBe(2)
  })

  // R-X53 against R-X22: the ZIP keeps the directory-scoped path, Share gets the flattened,
  // globally-deduplicated basename. The two must not be the same string for a folder run.
  it('names Share copies from the global Share names, not the ZIP basename', async () => {
    const collected = await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a/photo.jpg'],
        [idB, 'b/photo.jpg'],
      ]),
      multiImage: true,
      shareEligible: true,
      shareNamesByImage: new Map([
        [idA, 'photo.jpg'],
        [idB, 'photo-1.jpg'],
      ]),
    })

    await sink.submit(idA, bytes(1), 'jpeg')
    await sink.submit(idB, bytes(2), 'jpeg')
    await sink.finish()

    expect(opfsMocks.writeOutputCopy).toHaveBeenNthCalledWith(1, 0, bytes(1), {
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
    })
    // Not 'photo.jpg', which is what basename('b/photo.jpg') would have produced.
    expect(opfsMocks.writeOutputCopy).toHaveBeenNthCalledWith(2, 1, bytes(2), {
      name: 'photo-1.jpg',
      mimeType: 'image/jpeg',
    })
    // ZIP paths unchanged: different directories never collide there (R-X22).
    expect(collected.map((entry) => entry.name)).toEqual(['a/photo.jpg', 'b/photo.jpg'])
  })

  it('rejects a Share-eligible submit for an image with no Share name', async () => {
    await drainArchive()
    const sink = openRunArchiveSink({
      pathsByImage: new Map([
        [idA, 'a.jpg'],
        [idB, 'b.png'],
      ]),
      multiImage: true,
      shareEligible: true,
      shareNamesByImage: new Map([[idA, 'a.jpg']]),
    })

    await expect(sink.submit(idB, bytes(2), 'png')).rejects.toThrow()
  })
})

describe('openRunArchiveSink — cleanup', () => {
  it('abortAndCleanup deletes the whole artifact set and unsticks a pending archive drain', async () => {
    let settled = false
    opfsMocks.writeArchive.mockImplementationOnce(async (iterable: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- draining only, content unused.
      for await (const _entry of iterable as AsyncIterable<unknown>) {
        // never actually produced in this test
      }
      settled = true
    })

    const sink = openRunArchiveSink({
      pathsByImage: new Map([[idA, 'a.jpg']]),
      multiImage: true,
      shareEligible: false,
    })

    await sink.abortAndCleanup()

    expect(settled).toBe(true) // the drain loop above only completes once the queue is closed
    expect(opfsMocks.deleteRunArtifacts).toHaveBeenCalledOnce()
  })

  it('rejects an unresolved image id rather than writing silently', async () => {
    const sink = openRunArchiveSink({
      pathsByImage: new Map(),
      multiImage: false,
      shareEligible: false,
    })

    await expect(sink.submit(idA, bytes(1), 'jpeg')).rejects.toThrow()
  })
})

describe('preflightRunArchive', () => {
  it('skips quota checks entirely for a 1-image run', async () => {
    const entries: NamingEntry[] = [{ imageId: idA, path: 'a.jpg', sizeBytes: 1000 }]

    const result = await preflightRunArchive(entries, true)

    expect(opfsMocks.checkCombinedQuota).not.toHaveBeenCalled()
    expect(result).toEqual({
      archive: { ok: true, required: 0, available: Infinity },
      combined: { ok: true, required: 0, available: Infinity },
      shareEligible: false,
    })
  })

  it('predicts archive bytes and adds per-file overhead for the Share figure when eligible', async () => {
    const entries: NamingEntry[] = [
      { imageId: idA, path: 'a.jpg', sizeBytes: 1000 },
      { imageId: idB, path: 'b.png', sizeBytes: 2000 },
    ]

    await preflightRunArchive(entries, true)

    expect(zipMocks.predictLength).toHaveBeenCalledWith([
      { name: 'a.jpg', size: 1000 },
      { name: 'b.png', size: 2000 },
    ])
    const [archiveBytes, shareBytes] = opfsMocks.checkCombinedQuota.mock.calls[0] as [
      number,
      number,
    ]
    expect(archiveBytes).toBe(3000)
    expect(shareBytes).toBe(1000 + 2000 + 4096 * 2)
  })

  it('is never Share-eligible when the preliminary probe failed, even if quota is fine', async () => {
    const entries: NamingEntry[] = [
      { imageId: idA, path: 'a.jpg', sizeBytes: 1000 },
      { imageId: idB, path: 'b.png', sizeBytes: 2000 },
    ]

    const result = await preflightRunArchive(entries, false)

    expect(result.shareEligible).toBe(false)
    const [, shareBytes] = opfsMocks.checkCombinedQuota.mock.calls[0] as [number, number]
    expect(shareBytes).toBe(0) // no Share copies predicted when the probe already said no
  })

  it('is never Share-eligible above maximumShareFiles, even with a passing probe', async () => {
    const entries: NamingEntry[] = Array.from(
      { length: runtimeLimits.maximumShareFiles + 1 },
      (_, i) => ({ imageId: `image-${i}` as ImageId, path: `${i}.jpg`, sizeBytes: 100 }),
    )

    const result = await preflightRunArchive(entries, true)

    expect(result.shareEligible).toBe(false)
  })

  it('is not Share-eligible when the combined quota fails, but still reports the archive result', async () => {
    opfsMocks.checkCombinedQuota.mockResolvedValueOnce({
      archive: { ok: true, required: 3000, available: 10_000 },
      combined: { ok: false, required: 15_000, available: 10_000 },
    })
    const entries: NamingEntry[] = [
      { imageId: idA, path: 'a.jpg', sizeBytes: 1000 },
      { imageId: idB, path: 'b.png', sizeBytes: 2000 },
    ]

    const result = await preflightRunArchive(entries, true)

    expect(result.archive.ok).toBe(true)
    expect(result.combined.ok).toBe(false)
    expect(result.shareEligible).toBe(false)
  })

  it('reports archive failure as-is when the batch cannot even fit on its own', async () => {
    opfsMocks.checkCombinedQuota.mockResolvedValueOnce({
      archive: { ok: false, required: 50_000, available: 10_000 },
      combined: { ok: false, required: 50_000, available: 10_000 },
    })
    const entries: NamingEntry[] = [
      { imageId: idA, path: 'a.jpg', sizeBytes: 1000 },
      { imageId: idB, path: 'b.png', sizeBytes: 2000 },
    ]

    const result = await preflightRunArchive(entries, true)

    expect(result.archive.ok).toBe(false)
    expect(result.shareEligible).toBe(false)
  })
})
