import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The generic `Capabilities.fileShare` flag is a separate, cached once-per-session probe
// (platform/capability.ts) and is itself covered by tests/e2e/capability.spec.ts on real engines.
// Mocked here so these tests isolate exactly one thing: how this module interprets what
// `navigator.canShare`/`navigator.share` do. `probeFileShareForRun` on real engines is covered by
// tests/e2e/share.spec.ts, which this file complements rather than replaces.
const capabilityMocks = vi.hoisted(() => ({ fileShare: true }))

vi.mock('./capability', () => ({
  getCapabilities: async () => ({
    opfs: false,
    folderPicker: false,
    crossOriginIsolated: false,
    heicDecode: true,
    fileShare: capabilityMocks.fileShare,
  }),
}))

import { canShareExactFiles, probeFileShareForRun, shareFiles } from './share'

/** Only ever called with `{ files }` by this module — that is itself part of what R-V5 asserts. */
interface ShareData {
  files?: File[]
}

type CanShare = (data: ShareData) => boolean
type Share = (data: ShareData) => Promise<void>

interface ShareApi {
  canShare?: CanShare
  share?: Share
}

/** The `{ files }` the mock was handed, typed for assertions. */
function firstCallData(mock: { mock: { calls: ShareData[][] } }): { files: File[] } {
  const [data] = mock.mock.calls[0] as [{ files: File[] }]
  return data
}

/**
 * jsdom's `navigator` has neither method, so each test installs exactly the shape it means to
 * describe. Three states are deliberately distinguished throughout this file: the method is
 * **absent**, the method is **present and says no**, and the method is **present and says yes**.
 */
function installShareApi(api: ShareApi): void {
  const target = navigator as unknown as Record<string, unknown>
  for (const key of ['canShare', 'share'] as const) {
    if (api[key] === undefined) {
      delete target[key]
    } else {
      target[key] = api[key]
    }
  }
}

function imageFile(name = 'photo.jpg'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' })
}

beforeEach(() => {
  capabilityMocks.fileShare = true
  installShareApi({})
})

afterEach(() => {
  installShareApi({})
})

describe('probeFileShareForRun (the preliminary, write-gating probe)', () => {
  it('is false with no resolved formats at all', async () => {
    installShareApi({ canShare: () => true })

    await expect(probeFileShareForRun([])).resolves.toBe(false)
  })

  it('is false when the generic capability flag is false, without asking canShare', async () => {
    capabilityMocks.fileShare = false
    const canShare = vi.fn<CanShare>(() => true)
    installShareApi({ canShare })

    await expect(probeFileShareForRun(['jpeg'])).resolves.toBe(false)
    expect(canShare).not.toHaveBeenCalled()
  })

  it('probes one representative file per distinct format, deduplicated', async () => {
    const canShare = vi.fn<CanShare>(() => true)
    installShareApi({ canShare })

    await expect(probeFileShareForRun(['jpeg', 'png', 'jpeg'])).resolves.toBe(true)
    expect(firstCallData(canShare).files.map((file) => file.type)).toEqual([
      'image/jpeg',
      'image/png',
    ])
  })

  it('is false when canShare throws rather than returning', async () => {
    installShareApi({
      canShare: () => {
        throw new TypeError('illegal invocation')
      },
    })

    await expect(probeFileShareForRun(['jpeg'])).resolves.toBe(false)
  })
})

describe('canShareExactFiles (R-X48, the authority for showing Share)', () => {
  it('is false when canShare is absent entirely', async () => {
    installShareApi({ share: async () => {} })

    await expect(canShareExactFiles([imageFile()])).resolves.toBe(false)
  })

  it('is false when the generic capability flag is false', async () => {
    capabilityMocks.fileShare = false
    installShareApi({ canShare: () => true })

    await expect(canShareExactFiles([imageFile()])).resolves.toBe(false)
  })

  it('is false for an empty payload, without asking the browser', async () => {
    const canShare = vi.fn<CanShare>(() => true)
    installShareApi({ canShare })

    await expect(canShareExactFiles([])).resolves.toBe(false)
    expect(canShare).not.toHaveBeenCalled()
  })

  it('passes the exact array through and returns the browser’s verdict', async () => {
    const files = [imageFile('a.jpg'), imageFile('b.jpg')]
    const canShare = vi.fn<CanShare>(() => true)
    installShareApi({ canShare })

    await expect(canShareExactFiles(files)).resolves.toBe(true)
    const data = firstCallData(canShare)
    expect(data.files.map((file) => file.name)).toEqual(['a.jpg', 'b.jpg'])
    // Only `files` — no title, text or URL (R-V5, §9.1).
    expect(Object.keys(data)).toEqual(['files'])
  })

  it('is false when the browser rejects this exact payload', async () => {
    installShareApi({ canShare: () => false })

    await expect(canShareExactFiles([imageFile()])).resolves.toBe(false)
  })

  it('is false when canShare throws', async () => {
    installShareApi({
      canShare: () => {
        throw new TypeError('illegal invocation')
      },
    })

    await expect(canShareExactFiles([imageFile()])).resolves.toBe(false)
  })
})

describe('shareFiles (R-X50)', () => {
  it('resolves to "shared" and passes only files', async () => {
    const share = vi.fn<Share>(async () => {})
    installShareApi({ share })

    await expect(shareFiles([imageFile('a.jpg')])).resolves.toBe('shared')
    const data = firstCallData(share)
    expect(data.files.map((file) => file.name)).toEqual(['a.jpg'])
    expect(Object.keys(data)).toEqual(['files'])
  })

  it('reads AbortError as cancellation, not failure', async () => {
    installShareApi({
      share: async () => {
        throw new DOMException('Share canceled', 'AbortError')
      },
    })

    await expect(shareFiles([imageFile()])).resolves.toBe('cancelled')
  })

  it('reads an AbortError-named plain Error as cancellation too', async () => {
    // Duck-typed on `name` rather than `instanceof DOMException`: the one outcome that must never
    // be misclassified as an error is cancellation, and the engines are not guaranteed to throw
    // the same class (T39-A saw NotAllowedError/InvalidStateError DOMExceptions for real
    // failures, but nothing guarantees the cancellation class).
    installShareApi({
      share: async () => {
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      },
    })

    await expect(shareFiles([imageFile()])).resolves.toBe('cancelled')
  })

  it.each([
    // The two real failure classes T39-A measured: the byte-size ceiling and an overlapping call.
    new DOMException('Permission denied', 'NotAllowedError'),
    new DOMException('A share is already in progress', 'InvalidStateError'),
    new TypeError('bad payload'),
  ])('reads %s as a retryable failure', async (error) => {
    installShareApi({
      share: async () => {
        throw error
      },
    })

    await expect(shareFiles([imageFile()])).resolves.toBe('failed')
  })

  it('is "failed", not a throw, when navigator.share is absent', async () => {
    installShareApi({ canShare: () => true })

    await expect(shareFiles([imageFile()])).resolves.toBe('failed')
  })
})
