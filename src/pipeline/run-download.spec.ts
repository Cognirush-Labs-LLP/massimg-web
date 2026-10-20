import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ImageId } from '@/domain/types'
import { useRunStore } from '@/stores/run'

const opfsMocks = vi.hoisted(() => ({
  readArchive: vi.fn<() => Promise<Blob>>(async () => new Blob(['zip'])),
  readOutputCopies: vi.fn<() => Promise<File[]>>(async () => []),
  deleteRunArtifacts: vi.fn<() => Promise<void>>(async () => {}),
}))

vi.mock('@/platform/opfs', () => opfsMocks)

import { downloadFinishedRun } from './run-download'

const idA = 'image-a' as ImageId

/** Everything `triggerDownload` touches, captured so the delivered name and bytes are assertable. */
let downloads: { name: string; blob: Blob }[] = []
let revoked: string[] = []
let blobForUrl = new Map<string, Blob>()
let originalCreateObjectUrl: typeof URL.createObjectURL | undefined
let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined

function succeed(count: number, outputBytes = 100): void {
  const run = useRunStore()
  run.startRun(count)
  for (let index = 0; index < count; index += 1) {
    run.recordResult(`${String(idA)}-${index}` as ImageId, {
      kind: 'succeeded',
      inputBytes: 1000,
      outputBytes,
      caveats: [],
    })
  }
  run.finishRun()
}

function outputCopy(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  opfsMocks.readArchive.mockImplementation(async () => new Blob(['zip']))
  opfsMocks.readOutputCopies.mockImplementation(async () => [])
  downloads = []
  revoked = []
  blobForUrl = new Map()

  originalCreateObjectUrl = URL.createObjectURL
  originalRevokeObjectUrl = URL.revokeObjectURL
  let next = 0
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:run-download-${(next += 1)}`
    blobForUrl.set(url, blob)
    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url)
  })

  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobForUrl.get(this.href)
    if (!blob) {
      throw new Error('anchor clicked with a href that was never created')
    }
    downloads.push({ name: this.download, blob })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalCreateObjectUrl) {
    URL.createObjectURL = originalCreateObjectUrl
  }
  if (originalRevokeObjectUrl) {
    URL.revokeObjectURL = originalRevokeObjectUrl
  }
})

describe('downloadFinishedRun — zero successes', () => {
  it('delivers nothing and touches neither storage nor the delivery state', async () => {
    const run = useRunStore()
    run.startRun(1)
    run.recordResult(idA, { kind: 'failed', reason: { kind: 'decode-failed' } })
    run.finishRun()

    await expect(downloadFinishedRun()).resolves.toBe('downloaded')

    expect(downloads).toEqual([])
    expect(opfsMocks.readArchive).not.toHaveBeenCalled()
    expect(opfsMocks.readOutputCopies).not.toHaveBeenCalled()
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
    expect(run.delivery).toBe('pending')
  })
})

describe('downloadFinishedRun — one success (R-X16)', () => {
  it('downloads the single output copy directly, under its own name, with no ZIP', async () => {
    succeed(1)
    opfsMocks.readOutputCopies.mockResolvedValueOnce([outputCopy('photo.JPG')])

    await expect(downloadFinishedRun()).resolves.toBe('downloaded')

    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.name).toBe('photo.JPG')
    expect(opfsMocks.readArchive).not.toHaveBeenCalled()
  })

  it('uses the direct path even when the run started with several images', async () => {
    const run = useRunStore()
    run.startRun(3)
    run.recordResult(idA, { kind: 'succeeded', inputBytes: 1000, outputBytes: 100, caveats: [] })
    run.recordResult('b' as ImageId, { kind: 'failed', reason: { kind: 'encode-failed' } })
    run.recordResult('c' as ImageId, { kind: 'failed', reason: { kind: 'decode-failed' } })
    run.finishRun()
    opfsMocks.readOutputCopies.mockResolvedValueOnce([outputCopy('survivor.webp')])

    await expect(downloadFinishedRun()).resolves.toBe('downloaded')

    expect(downloads[0]?.name).toBe('survivor.webp')
    expect(opfsMocks.readArchive).not.toHaveBeenCalled()
  })

  it('is an assembly failure, not a silent no-op, when the copy has gone missing', async () => {
    succeed(1)
    opfsMocks.readOutputCopies.mockResolvedValueOnce([])

    await expect(downloadFinishedRun()).resolves.toBe('assembly-failed')

    const run = useRunStore()
    expect(run.deliveryError).toBe('download-assembly')
    expect(run.delivery).toBe('pending')
    expect(downloads).toEqual([])
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })
})

describe('downloadFinishedRun — two or more successes (R-X30)', () => {
  it('downloads the archive under the ZIP name', async () => {
    succeed(2)
    opfsMocks.readArchive.mockResolvedValueOnce(new Blob(['zip bytes']))

    await expect(downloadFinishedRun()).resolves.toBe('downloaded')

    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.name).toMatch(/\.zip$/)
    await expect(downloads[0]?.blob.text()).resolves.toBe('zip bytes')
    expect(opfsMocks.readOutputCopies).not.toHaveBeenCalled()
  })
})

describe('downloadFinishedRun — the first successful delivery (R-X42, R-X54)', () => {
  it('marks delivery downloaded but keeps every artifact', async () => {
    succeed(2)

    await downloadFinishedRun()

    expect(useRunStore().delivery).toBe('downloaded')
    // The whole point: handing a file to the browser is not a confirmation it was saved, so the
    // run's only copy must survive the attempt. Cleanup happens when the user leaves Processing
    // (useProcessingRun's scope disposal), not on an unverifiable signal.
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })

  it('keeps the artifacts for a single-image direct download too', async () => {
    succeed(1)
    opfsMocks.readOutputCopies.mockResolvedValueOnce([
      new File(['one'], 'one.png', { type: 'image/png' }),
    ])

    await expect(downloadFinishedRun()).resolves.toBe('downloaded')

    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })

  it('can be pressed again, delivering the same payload a second time', async () => {
    succeed(2)
    opfsMocks.readArchive.mockResolvedValue(new Blob(['zip bytes']))

    await downloadFinishedRun()
    await downloadFinishedRun()

    // Two real handovers, nothing consumed or destroyed in between — the recovery path for a
    // download the browser silently declined.
    expect(downloads).toHaveLength(2)
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
    expect(useRunStore().delivery).toBe('downloaded')
  })

  it('revokes the object URL it created', async () => {
    succeed(2)

    await downloadFinishedRun()

    expect(revoked).toHaveLength(1)
  })
})

// §10 has these as two separate rows with two separate messages: one is "the payload could not be
// produced", the other is "the payload was fine and the browser refused it".
describe('downloadFinishedRun — §10 "ZIP assembly failure"', () => {
  it('reports assembly-failed, keeps the artifacts and leaves delivery pending', async () => {
    succeed(3)
    opfsMocks.readArchive.mockRejectedValueOnce(new Error('archive handle gone'))

    await expect(downloadFinishedRun()).resolves.toBe('assembly-failed')

    const run = useRunStore()
    expect(run.deliveryError).toBe('download-assembly')
    expect(run.delivery).toBe('pending')
    expect(downloads).toEqual([])
    // R-X50's pattern: the results and both delivery actions must survive a failed attempt.
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })

  it('never delivers a partial file', async () => {
    succeed(3)
    opfsMocks.readArchive.mockRejectedValueOnce(new Error('archive handle gone'))

    await downloadFinishedRun()

    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

describe('downloadFinishedRun — §10 "Download blocked by browser"', () => {
  it('reports blocked when the click itself throws, keeping the artifacts', async () => {
    succeed(2)
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new DOMException('Blocked by the user agent', 'SecurityError')
    })

    await expect(downloadFinishedRun()).resolves.toBe('blocked')

    const run = useRunStore()
    expect(run.deliveryError).toBe('download-blocked')
    expect(run.delivery).toBe('pending')
    expect(opfsMocks.deleteRunArtifacts).not.toHaveBeenCalled()
  })

  it('reports blocked when the object URL cannot be created', async () => {
    succeed(2)
    vi.mocked(URL.createObjectURL).mockImplementationOnce(() => {
      throw new DOMException('Not allowed', 'SecurityError')
    })

    await expect(downloadFinishedRun()).resolves.toBe('blocked')

    expect(useRunStore().deliveryError).toBe('download-blocked')
  })

  it('still revokes the object URL when the click throws', async () => {
    succeed(2)
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new DOMException('Blocked by the user agent', 'SecurityError')
    })

    await downloadFinishedRun()

    expect(revoked).toHaveLength(1)
  })

  it('a retry after a blocked attempt can still succeed', async () => {
    succeed(2)
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new DOMException('Blocked by the user agent', 'SecurityError')
    })

    expect(await downloadFinishedRun()).toBe('blocked')
    expect(await downloadFinishedRun()).toBe('downloaded')

    const run = useRunStore()
    expect(run.delivery).toBe('downloaded')
    expect(run.deliveryError).toBeNull()
    expect(downloads).toHaveLength(1)
  })
})
