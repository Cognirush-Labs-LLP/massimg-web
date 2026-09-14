import { expect, test, type Page } from '@playwright/test'

// T21 — pipeline/pool.ts, pipeline/worker.ts and the message protocol between them. Same
// DOM/dynamic-import constraint as capability.spec.ts, folder.spec.ts, opfs.spec.ts and
// thumbnails.spec.ts: tests/e2e/** is compiled with tsconfig.node.json, which has no DOM lib, so
// the modules under test are loaded inside the page via a dynamic import of their served paths and
// every browser-side result is mapped to a plain, serializable shape before it crosses back to Node.
//
// The pool's invariants are about timing and ordering, and `pipeline/worker.ts` has no stage to run
// until T23-T29 build them. So the cancellation, supersession, concurrency and termination tests
// inject a probe worker through the pool's `workerFactory` seam: the queue, the tokens, the
// `postMessage` boundary, `terminate()` and the respawn are all the real ones, and only the work
// inside the worker is substituted for a controllable delay. Two further tests drive the shipped
// `pipeline/worker.ts` itself, so the module that ships is proven to speak the protocol.
const POOL_MODULE_PATH = '/src/pipeline/pool.ts'
const LIMITS_MODULE_PATH = '/src/config/limits.ts'
const WORKER_MODULE_PATH = '/src/pipeline/worker.ts'

interface Stats {
  size: number
  queued: number
  active: number
  started: number
  completed: number
  discarded: number
  cancelled: boolean
  workersAlive: number
  terminations: number
}

// The browser APIs used inside page callbacks, declared minimally because tests/e2e has no DOM lib.
interface PageWorker {
  postMessage(message: unknown): void
  terminate(): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}
declare const Worker: new (url: string, options?: { type: 'module' }) => PageWorker

// Helpers installed into the page by the beforeEach below.
declare function makeProbeFactory(): () => PageWorker
declare function makeJob(imageId: string, delayMs?: number): unknown
declare function waitFor(check: () => boolean, timeoutMs?: number): Promise<boolean>
declare function cores(): number | undefined

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // A classic worker, built from a blob URL, speaking exactly the protocol in
    // src/pipeline/protocol.ts — including the worker half of the between-jobs flag. How long a job
    // takes is read out of the job's own source bytes, so one worker serves both a job long enough
    // to cancel or terminate inside and the quick job that has to run after it.
    const PROBE_SOURCE = `
      let cancelledThrough = 0
      self.addEventListener('message', (event) => {
        const message = event.data
        if (message.kind === 'cancel') {
          cancelledThrough = Math.max(cancelledThrough, message.through)
          return
        }
        const token = message.token
        const imageId = message.job.imageId
        if (token <= cancelledThrough) {
          self.postMessage({ kind: 'skipped', token, imageId })
          return
        }
        const source = message.job.source
        const delayMs = source[0] | (source[1] << 8)
        setTimeout(() => {
          const bytes = new Uint8Array([token & 255])
          self.postMessage(
            { kind: 'result', token, imageId, result: { bytes, format: 'jpeg', caveats: [] } },
            [bytes.buffer],
          )
        }, delayMs)
      })
    `

    const scope = globalThis as unknown as Record<string, unknown>

    scope.makeProbeFactory = () => {
      const url = URL.createObjectURL(new Blob([PROBE_SOURCE], { type: 'text/javascript' }))
      return () => new Worker(url)
    }

    scope.makeJob = (imageId: string, delayMs = 0) => ({
      imageId,
      // The probe's job duration, little-endian, in the bytes a real job would carry image data in.
      source: new Uint8Array([delayMs & 255, (delayMs >> 8) & 255]),
      edit: null,
      settings: {
        quality: { kind: 'quality', value: 80, lossless: false },
        dimension: { kind: 'original' },
        format: 'jpeg',
        isAnimated: false,
        alpha: { kind: 'preserve' },
      },
      intent: 'preview',
    })

    scope.waitFor = async (check: () => boolean, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (check()) {
          return true
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return check()
    }

    scope.cores = () =>
      (globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator
        ?.hardwareConcurrency
  })
})

/** Collects uncaught page errors and console errors — cancelling must raise neither. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console: ${message.text()}`)
    }
  })
  return errors
}

test('pool size comes from the runtime limits module, not from a literal in the pool', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath, limitsPath }) => {
      const pool = await import(/* @vite-ignore */ poolPath)
      const limits = await import(/* @vite-ignore */ limitsPath)

      const hardwareConcurrency = cores()
      const measure = (options: unknown) => {
        const instance = pool.createWorkerPool(options)
        const size = instance.size as number
        instance.destroy()
        return size
      }

      return {
        hardwareConcurrency,
        expectedDesktop: limits.resolveWorkerPoolSize(
          { hardwareConcurrency, mobile: false },
          limits.runtimeLimits,
        ) as number,
        desktop: measure({ mobile: false }),
        mobile: measure({ mobile: true }),
        injected: measure({ size: 2 }),
        // A different limits object, same pool module: if the cap or the reserved core were baked
        // into pool.ts this would not move.
        widened: measure({
          mobile: false,
          limits: { ...limits.runtimeLimits, maximumWorkers: 8, reservedCores: 0 },
        }),
        shipped: {
          maximumWorkers: limits.runtimeLimits.maximumWorkers as number,
          mobileWorkers: limits.runtimeLimits.mobileWorkers as number,
        },
      }
    },
    { poolPath: POOL_MODULE_PATH, limitsPath: LIMITS_MODULE_PATH },
  )

  // Technical Design §5.1: min(hardwareConcurrency - 1, 3) on desktop, 1 on mobile.
  expect(result.desktop).toBe(result.expectedDesktop)
  expect(result.desktop).toBeLessThanOrEqual(result.shipped.maximumWorkers)
  expect(result.desktop).toBeGreaterThanOrEqual(1)
  expect(result.mobile).toBe(result.shipped.mobileWorkers)
  expect(result.mobile).toBe(1)
  expect(result.injected).toBe(2)
  expect(result.widened).toBe(Math.min(result.hardwareConcurrency ?? 1, 8))
  expect(result.widened).toBeGreaterThan(result.shipped.maximumWorkers)
})

test('concurrency is bounded by the pool size (R-X8)', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 3, workerFactory: makeProbeFactory() })

      const handles = Array.from({ length: 9 }, (_, index) =>
        instance.run(makeJob(`img-${index}`, 40)),
      )

      // run() dispatches synchronously, so the ceiling is observable the instant the jobs are in.
      const onSubmit = instance.stats() as Stats

      let peakActive = onSubmit.active
      const sampler = setInterval(() => {
        peakActive = Math.max(peakActive, (instance.stats() as Stats).active)
      }, 5)

      const outcomes = await Promise.all(
        handles.map((handle: { done: Promise<{ outcome: string }> }) =>
          handle.done.then((value) => value.outcome),
        ),
      )
      clearInterval(sampler)

      const settled = instance.stats() as Stats
      instance.destroy()
      return { onSubmit, peakActive, outcomes, settled }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(result.onSubmit.active).toBe(3)
  expect(result.onSubmit.queued).toBe(6)
  expect(result.onSubmit.started).toBe(3)
  // Nine images, never more than three decodes in flight: the bound §8.1 costs peak memory on.
  expect(result.peakActive).toBeLessThanOrEqual(3)
  expect(result.peakActive).toBe(3)
  expect(result.outcomes).toEqual(Array.from({ length: 9 }, () => 'completed'))
  expect(result.settled.completed).toBe(9)
  expect(result.settled.started).toBe(9)
  expect(result.settled.active).toBe(0)
  expect(result.settled.workersAlive).toBe(3)
})

test('a cancelled run stops after at most one further job (R-X26)', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      // One worker, so "the image currently in flight" is exactly one image and the Done-when's
      // "at most one further job" is a literal count rather than a per-worker one.
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1, workerFactory: makeProbeFactory() })

      const handles = Array.from({ length: 5 }, (_, index) =>
        instance.run(makeJob(`img-${index}`, 150)),
      )
      await waitFor(() => (instance.stats() as Stats).active === 1)
      const beforeCancel = instance.stats() as Stats

      instance.cancel()
      const onCancel = instance.stats() as Stats

      const outcomes = await Promise.all(
        handles.map((handle: { done: Promise<{ outcome: string }> }) =>
          handle.done.then((value) => value.outcome),
        ),
      )

      // Ample time for any further dispatch to have happened if the flag were not honoured.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const settled = instance.stats() as Stats
      instance.destroy()

      return { beforeCancel, onCancel, outcomes, settled }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(result.beforeCancel.started).toBe(1)
  expect(result.beforeCancel.completed).toBe(0)

  // The queue is abandoned at once; the in-flight image is not interrupted.
  expect(result.onCancel.cancelled).toBe(true)
  expect(result.onCancel.queued).toBe(0)
  expect(result.onCancel.active).toBe(1)
  expect(result.onCancel.started).toBe(1)

  // The heart of R-X26: not one job started after cancel, and exactly one further job finished —
  // the one already in flight. The wait was bounded by one image, not by the four that remained.
  expect(result.settled.started).toBe(result.beforeCancel.started)
  expect(result.settled.completed - result.beforeCancel.completed).toBe(1)
  expect(result.settled.completed).toBeLessThanOrEqual(1)
  expect(result.outcomes).toEqual(['completed', 'cancelled', 'cancelled', 'cancelled', 'cancelled'])
  expect(errors).toEqual([])
})

test('cancelling a full pool starts no further job and finishes only what was in flight', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 3, workerFactory: makeProbeFactory() })

      const handles = Array.from({ length: 9 }, (_, index) =>
        instance.run(makeJob(`img-${index}`, 150)),
      )
      await waitFor(() => (instance.stats() as Stats).active === 3)
      const beforeCancel = instance.stats() as Stats

      instance.cancel()
      const outcomes = await Promise.all(
        handles.map((handle: { done: Promise<{ outcome: string }> }) =>
          handle.done.then((value) => value.outcome),
        ),
      )

      await new Promise((resolve) => setTimeout(resolve, 500))
      const settled = instance.stats() as Stats
      instance.destroy()
      return { beforeCancel, outcomes, settled }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  // The general invariant behind the Done-when: at any pool width, cancel starts nothing new, so
  // the wait is bounded by the images already in flight rather than by the rest of the batch.
  expect(result.beforeCancel.started).toBe(3)
  expect(result.settled.started).toBe(3)
  expect(result.settled.completed).toBe(3)
  expect(result.outcomes.filter((outcome) => outcome === 'completed')).toHaveLength(3)
  expect(result.outcomes.filter((outcome) => outcome === 'cancelled')).toHaveLength(6)
  expect(result.outcomes.slice(0, 3)).toEqual(['completed', 'completed', 'completed'])
  expect(errors).toEqual([])
})

test('a superseded preview result is discarded on arrival, not rendered (R-X28)', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1, workerFactory: makeProbeFactory() })

      // Everything a Preview would put on screen goes through here, and only a completed outcome
      // ever reaches it. A discarded result that was rendered anyway would show up as an extra entry.
      const rendered: { token: number; byte: number }[] = []
      const render = (handle: {
        token: number
        done: Promise<{ outcome: string; result?: { bytes: Uint8Array } }>
      }) =>
        handle.done.then((outcome) => {
          if (outcome.outcome === 'completed' && outcome.result) {
            rendered.push({ token: handle.token, byte: outcome.result.bytes[0] as number })
          }
          return outcome.outcome
        })

      const imageId = 'img-preview'

      const first = instance.run(makeJob(imageId, 150))
      const firstOutcome = render(first)
      await waitFor(() => (instance.stats() as Stats).active === 1)

      // The settings change: a second encode of the same image while the first is mid-flight.
      const second = instance.run(makeJob(imageId, 150))
      const secondOutcome = render(second)
      const onSupersede = instance.stats() as Stats

      const outcomes = [await firstOutcome, await secondOutcome]
      await new Promise((resolve) => setTimeout(resolve, 300))
      const settled = instance.stats() as Stats
      instance.destroy()

      return {
        outcomes,
        rendered,
        onSupersede,
        settled,
        tokens: { first: first.token as number, second: second.token as number },
      }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(result.tokens.second).toBeGreaterThan(result.tokens.first)
  expect(result.outcomes).toEqual(['superseded', 'completed'])

  // The first encode was not interrupted — no worker was killed and it kept its slot — and its
  // result was thrown away when it arrived, which is precisely R-X28's "discarded on arrival".
  expect(result.onSupersede.active).toBe(1)
  expect(result.onSupersede.terminations).toBe(0)
  expect(result.settled.terminations).toBe(0)
  expect(result.settled.discarded).toBe(1)
  expect(result.settled.started).toBe(2)

  // Rendered exactly once, with the newer encode's bytes. The superseded one never reached the UI.
  expect(result.rendered).toHaveLength(1)
  expect(result.rendered[0]?.token).toBe(result.tokens.second)
  expect(result.rendered[0]?.byte).toBe(result.tokens.second % 256)
  expect(errors).toEqual([])
})

test('a superseded job that never started is dropped before it reaches a worker', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1, workerFactory: makeProbeFactory() })

      const blocker = instance.run(makeJob('img-other', 120))
      await waitFor(() => (instance.stats() as Stats).active === 1)

      // Two encodes of the same image queued behind the blocker: debouncing (R-P3) is what usually
      // keeps a superseded preview in this cheaper branch rather than the discard-on-arrival one.
      const first = instance.run(makeJob('img-preview', 20))
      const second = instance.run(makeJob('img-preview', 20))

      const outcomes = await Promise.all(
        [blocker, first, second].map((handle: { done: Promise<{ outcome: string }> }) =>
          handle.done.then((value) => value.outcome),
        ),
      )
      const settled = instance.stats() as Stats
      instance.destroy()
      return { outcomes, settled }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(result.outcomes).toEqual(['completed', 'superseded', 'completed'])
  // Two jobs reached a worker, not three: the superseded one never started, so nothing was discarded.
  expect(result.settled.started).toBe(2)
  expect(result.settled.discarded).toBe(0)
})

test('terminate and respawn interrupts a job and the pool keeps working (R-X29)', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      // Long enough that the job could not possibly finish on its own.
      const instance = mod.createWorkerPool({ size: 1, workerFactory: makeProbeFactory() })

      const stuck = instance.run(makeJob('img-stuck', 60000))
      await waitFor(() => (instance.stats() as Stats).active === 1)

      const killed = instance.terminateJob(stuck.token) as boolean
      const outcome = (await stuck.done) as { outcome: string; cause?: string }
      const afterKill = instance.stats() as Stats

      // Nothing about the escape hatch may leave the pool unusable.
      const next = instance.run(makeJob('img-next', 20))
      const nextOutcome = (await next.done) as { outcome: string }
      const settled = instance.stats() as Stats

      const missing = instance.terminateJob(stuck.token) as boolean
      instance.destroy()

      return { killed, outcome, afterKill, nextOutcome, settled, missing }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(result.killed).toBe(true)
  expect(result.outcome.outcome).toBe('terminated')
  expect(result.outcome.cause).toBe('requested')
  expect(result.afterKill.active).toBe(0)
  expect(result.afterKill.terminations).toBe(1)
  // The worker really is gone, not merely detached from the job.
  expect(result.afterKill.workersAlive).toBe(0)

  // A replacement spawned for the next job — the "recreate" half of R-X29.
  expect(result.nextOutcome.outcome).toBe('completed')
  expect(result.settled.workersAlive).toBe(1)
  expect(result.settled.completed).toBe(1)
  expect(result.missing).toBe(false)
})

test('the job timeout terminates a job that outruns its threshold (R-X29)', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({
        size: 1,
        workerFactory: makeProbeFactory(),
        jobTimeoutMs: 100,
      })

      const stuck = instance.run(makeJob('img-stuck', 60000))
      const outcome = (await stuck.done) as { outcome: string; cause?: string }
      const settled = instance.stats() as Stats
      instance.destroy()
      return { outcome, settled }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(result.outcome.outcome).toBe('terminated')
  expect(result.outcome.cause).toBe('timeout')
  expect(result.settled.terminations).toBe(1)
})

test('resume lets the same pool run again without replacing its workers (R-X17)', async ({
  page,
}) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1, workerFactory: makeProbeFactory() })

      const first = Array.from({ length: 3 }, (_, index) => instance.run(makeJob(`a-${index}`, 60)))
      await waitFor(() => (instance.stats() as Stats).active === 1)
      instance.cancel()
      const firstOutcomes = await Promise.all(
        first.map((handle: { done: Promise<{ outcome: string }> }) =>
          handle.done.then((value) => value.outcome),
        ),
      )

      // A job submitted while cancelled is refused rather than queued for a run that is over.
      const whileCancelled = (await instance.run(makeJob('a-late', 60)).done) as { outcome: string }

      instance.resume()
      const afterResume = instance.stats() as Stats
      const second = (await instance.run(makeJob('b-0', 60)).done) as { outcome: string }
      const settled = instance.stats() as Stats
      instance.destroy()

      return { firstOutcomes, whileCancelled, afterResume, second, settled }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  expect(result.firstOutcomes).toEqual(['completed', 'cancelled', 'cancelled'])
  expect(result.whileCancelled.outcome).toBe('cancelled')
  expect(result.afterResume.cancelled).toBe(false)
  expect(result.second.outcome).toBe('completed')
  // The same worker served both runs: cancelling costs no codec re-initialisation.
  expect(result.settled.terminations).toBe(0)
  expect(result.settled.workersAlive).toBe(1)
})

test('the shipped pipeline worker speaks the protocol', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ poolPath }) => {
      // The default factory — the real module worker, no probe.
      const mod = await import(/* @vite-ignore */ poolPath)
      const instance = mod.createWorkerPool({ size: 1 })

      const handle = instance.run(makeJob('img-real'))
      const outcome = (await handle.done) as {
        outcome: string
        token: number
        imageId: string
        reason?: { kind: string; detail?: string }
      }
      const settled = instance.stats() as Stats
      instance.destroy()

      return { token: handle.token as number, outcome, settled }
    },
    { poolPath: POOL_MODULE_PATH },
  )

  // The module worker constructs, receives a Job and answers on the token it was given. The reason
  // is `unimplemented` because T23-T29 have not built the stages yet — when they do, this becomes a
  // completed outcome and nothing else about the protocol changes.
  expect(result.outcome.token).toBe(result.token)
  expect(result.outcome.imageId).toBe('img-real')
  expect(result.outcome.outcome).toBe('failed')
  expect(result.outcome.reason?.kind).toBe('unimplemented')
  expect(result.settled.workersAlive).toBe(1)
  expect(result.settled.completed).toBe(1)
})

test('the shipped worker checks the between-jobs flag before starting a job', async ({ page }) => {
  await page.goto('/')

  const result = await page.evaluate(
    async ({ workerPath }) => {
      // Driven by hand rather than through the pool: the pool stops dispatching the moment it is
      // cancelled, so the worker's own half of the flag (Technical Design §5.3) can only be
      // observed by posting a `run` that the worker must refuse.
      const worker = new Worker(workerPath, { type: 'module' })
      const received: unknown[] = []
      worker.addEventListener('message', (event) => received.push(event.data))

      worker.postMessage({ kind: 'cancel', through: 500 })
      worker.postMessage({ kind: 'run', token: 400, job: makeJob('img-refused') })
      // A token issued after the cancel is still accepted, so cancelling does not poison the worker.
      worker.postMessage({ kind: 'run', token: 600, job: makeJob('img-accepted') })

      await waitFor(() => received.length >= 2)
      worker.terminate()

      return received as { kind: string; token: number; imageId: string }[]
    },
    { workerPath: WORKER_MODULE_PATH },
  )

  expect(result).toHaveLength(2)
  expect(result[0]?.kind).toBe('skipped')
  expect(result[0]?.token).toBe(400)
  expect(result[0]?.imageId).toBe('img-refused')
  // The later token was not refused: it reached executeJob and came back as an error, not a skip.
  expect(result[1]?.kind).toBe('error')
  expect(result[1]?.token).toBe(600)
})
