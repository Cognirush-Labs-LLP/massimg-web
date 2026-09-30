import { describe, expect, it } from 'vitest'

import {
  resolveAutomaticGalleryView,
  resolveWorkerPoolSize,
  runtimeLimits,
  type RuntimeLimits,
} from './limits'

describe('resolveWorkerPoolSize', () => {
  it('leaves one core for the UI thread', () => {
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 4, mobile: false })).toBe(3)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 3, mobile: false })).toBe(2)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 2, mobile: false })).toBe(1)
  })

  it('caps a many-core desktop, because concurrency multiplies peak memory', () => {
    // §5.1's cap exists for R-X8/R-B2: memory is the binding constraint, not CPU.
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 8, mobile: false })).toBe(3)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 64, mobile: false })).toBe(3)
  })

  it('never returns fewer than one worker on a single-core desktop', () => {
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 1, mobile: false })).toBe(1)
  })

  it('falls back to one worker when the core count is unknown or nonsensical', () => {
    // navigator.hardwareConcurrency is allowed to be absent. Guessing high on an unknown device is
    // the failure mode §8.1 is trying to avoid, so the conservative answer is the fallback.
    expect(resolveWorkerPoolSize({ mobile: false })).toBe(1)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 0, mobile: false })).toBe(1)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: -4, mobile: false })).toBe(1)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: Number.NaN, mobile: false })).toBe(1)
    expect(
      resolveWorkerPoolSize({ hardwareConcurrency: Number.POSITIVE_INFINITY, mobile: false }),
    ).toBe(1)
  })

  it('uses one worker on mobile however many cores it reports', () => {
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 8, mobile: true })).toBe(1)
    expect(resolveWorkerPoolSize({ mobile: true })).toBe(1)
  })

  it('reads every number from the limits it is given, hard-coding none of them', () => {
    // The point of §8.3: changing a limit is one edit in the configuration module. If any of these
    // three numbers were baked into the formula, this case would still return the shipped answers.
    const measured: RuntimeLimits = {
      ...runtimeLimits,
      maximumWorkers: 6,
      mobileWorkers: 2,
      reservedCores: 2,
    }

    expect(resolveWorkerPoolSize({ hardwareConcurrency: 16, mobile: false }, measured)).toBe(6)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 5, mobile: false }, measured)).toBe(3)
    expect(resolveWorkerPoolSize({ hardwareConcurrency: 8, mobile: true }, measured)).toBe(2)
  })

  it('ships the sizes Technical Design §5.1 names', () => {
    expect(runtimeLimits.maximumWorkers).toBe(3)
    expect(runtimeLimits.mobileWorkers).toBe(1)
    expect(runtimeLimits.reservedCores).toBe(1)
  })
})

describe('resolveAutomaticGalleryView', () => {
  it('is list, regardless of count, for folder-sourced input (R-G8)', () => {
    expect(resolveAutomaticGalleryView(1, true)).toBe('list')
    expect(resolveAutomaticGalleryView(0, true)).toBe('list')
  })

  it('is grid below the maximumThumbnails threshold for loose files', () => {
    expect(resolveAutomaticGalleryView(1, false)).toBe('grid')
    expect(resolveAutomaticGalleryView(99, false)).toBe('grid')
  })

  it('is list at or above the maximumThumbnails threshold for loose files', () => {
    expect(resolveAutomaticGalleryView(100, false)).toBe('list')
    expect(resolveAutomaticGalleryView(150, false)).toBe('list')
  })

  it('reads the threshold from the limits it is given, hard-coding none of it', () => {
    const measured: RuntimeLimits = { ...runtimeLimits, maximumThumbnails: 3 }

    expect(resolveAutomaticGalleryView(2, false, measured)).toBe('grid')
    expect(resolveAutomaticGalleryView(3, false, measured)).toBe('list')
  })
})

describe('runtimeLimits.jobTimeoutMs', () => {
  it('is null until a re-init cost has actually been measured (R-X29)', () => {
    // §5.3: the threshold "is set from measured re-init cost, not guessed". It lives here rather
    // than in the pool's options so that T46's sweep of this module finds it and asks for evidence;
    // a guessed default would terminate healthy jobs on slow devices.
    expect(runtimeLimits.jobTimeoutMs).toBeNull()
  })
})
