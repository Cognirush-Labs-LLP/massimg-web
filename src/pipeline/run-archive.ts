// Streaming ZIP assembly and Share-copy teeing for a Processing run (Technical Design §9.1,
// Functional Design R-X30, R-X38 to R-X40, R-X42, R-X47, R-X48, R-X51, R-X52).
//
// `client-zip` has no compression of any kind in any released version (docs/assumptions.md E3,
// refuted in this task) — every entry it writes is stored, so there is no per-entry store/deflate
// choice to make here, unlike what an earlier draft of Technical Design §9.1 assumed.
//
// This module owns two things: a pre-run quota/eligibility decision (`preflightRunArchive`), and
// the per-result sink useProcessingRun.ts feeds every successful output through as the run
// proceeds (`openRunArchiveSink`). Naming is precomputed by the caller (`domain/naming.ts`'s
// `resolveOutputNames` for the ZIP and, for a Share-eligible run, `resolveShareNames` for the
// flattened Share copies), called once in batch order before any job dispatches, because collision
// resolution must not depend on which worker happens to finish first. The two scopes are both
// live at once for a Share-eligible folder run: the ZIP keeps `a/photo.jpg` and `b/photo.jpg`
// distinct (R-X22) while Share flattens them to `photo.jpg` and `photo-1.jpg` (R-X53).

import { makeZip, predictLength } from 'client-zip'
import type { EncodableFormat, ImageId } from '@/domain/types'
import { mimeForFormat } from '@/domain/format'
import { runtimeLimits } from '@/config/limits'
import {
  checkCombinedQuota,
  deleteOutputCopy,
  deleteRunArtifacts,
  writeArchive,
  writeOutputCopy,
  type QuotaCheck,
} from '@/platform/opfs'

/** One image this run expects to attempt, with its precomputed archive-relative path. */
export interface NamingEntry {
  imageId: ImageId
  path: string
  /** The source file's byte size, used as a conservative worst-case stand-in for the not-yet-known
   * output size (R-X45 same-format outputs can legitimately be larger, but that is the rare,
   * already-warned case, not a basis for a hard quota reservation). */
  sizeBytes: number
}

export interface RunArchivePreflight {
  /** Whether the ordinary Download artifact (archive, or the lone output for a 1-image run) fits. */
  archive: QuotaCheck
  /** Whether the archive plus every individual Share copy fits. */
  combined: QuotaCheck
  /** Whether this run should open the Share sink: preliminarily probed, within the file-count
   * ceiling, and the combined figure fits. False whenever `archive` alone already fails — that
   * case rejects the whole run rather than merely dropping Share (R-X40). */
  shareEligible: boolean
}

/**
 * R-X40/R-X52's two-threshold preflight. `entries` must be every image this run is about to
 * attempt (excluding only images whose settings resolution itself rejected them, which can never
 * produce an entry) — not the eventual successes, which are unknown until the run finishes.
 *
 * A 1-image run needs no archive at all (R-X16's direct output only), so it is not preflighted
 * here; existing per-file selection-time caps already bound that single file.
 */
export async function preflightRunArchive(
  entries: readonly NamingEntry[],
  preliminaryShareProbe: boolean,
): Promise<RunArchivePreflight> {
  if (entries.length <= 1) {
    const trivial: QuotaCheck = { ok: true, required: 0, available: Infinity }
    return { archive: trivial, combined: trivial, shareEligible: false }
  }

  const archiveBytes = Number(
    predictLength(entries.map((entry) => ({ name: entry.path, size: entry.sizeBytes }))),
  )

  const countEligible = preliminaryShareProbe && entries.length <= runtimeLimits.maximumShareFiles
  const shareBytes = countEligible
    ? entries.reduce(
        (sum, entry) => sum + entry.sizeBytes + runtimeLimits.shareCopyOverheadBytes,
        0,
      )
    : 0

  const { archive, combined } = await checkCombinedQuota(archiveBytes, shareBytes)

  return { archive, combined, shareEligible: countEligible && combined.ok }
}

interface QueueEntry {
  path: string
  bytes: Uint8Array
}

/**
 * Bridges push-based submission (results arrive as workers finish, in no particular order) to
 * `client-zip`'s pull-based async-iterable input. Holds at most one entry at a time: `makeZip`'s
 * stream won't pull a second one until the first has been consumed downstream, which is what keeps
 * the whole pipeline at "one entry in memory" (R-X38).
 */
class EntryQueue implements AsyncIterable<QueueEntry> {
  private pending: QueueEntry[] = []
  private waiting: ((result: IteratorResult<QueueEntry>) => void) | null = null
  private closed = false

  push(entry: QueueEntry): void {
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: entry, done: false })
      return
    }
    this.pending.push(entry)
  }

  close(): void {
    this.closed = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined, done: true })
    }
  }

  private next(): Promise<IteratorResult<QueueEntry>> {
    const next = this.pending.shift()
    if (next) {
      return Promise.resolve({ value: next, done: false })
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true })
    }
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<QueueEntry> {
    return { next: () => this.next() }
  }
}

/** Adapts the queue's plain `{path, bytes}` entries into client-zip's expected input shape. */
async function* toZipEntries(queue: EntryQueue) {
  for await (const entry of queue) {
    yield {
      name: entry.path,
      input: entry.bytes,
      size: entry.bytes.byteLength,
      lastModified: new Date(),
    }
  }
}

export interface RunArchiveSink {
  /**
   * Submits one successful job's output. Consumed once: the same `bytes` are hashed into the ZIP
   * queue and, when this run retains individual copies, written to OPFS directly — no second
   * encode, no retained copy beyond the two write calls this makes.
   */
  submit(imageId: ImageId, bytes: Uint8Array, format: EncodableFormat): Promise<void>
  /**
   * Call once every expected result (success, failure or skip alike) has arrived. `report`, when
   * given, is appended as one final ZIP entry before the queue closes (T41) — never written for a
   * single-image run, which has no `queue` to append to. Resolves once the archive, if this run
   * has one, has been fully flushed to storage — only then is it safe to read back or mark the run
   * finished.
   */
  finish(report?: { path: string; bytes: Uint8Array }): Promise<void>
  /** Cancellation or storage-failure path: stop accepting entries and delete everything written
   * so far. Idempotent with `finish()` not having been called, and safe to call more than once. */
  abortAndCleanup(): Promise<void>
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}

/**
 * Opens the sink for one run. `multiImage` and `shareEligible` are decided once, at run start, and
 * are fixed for the sink's whole lifetime (R-X47: eligibility does not change if later failures
 * leave fewer successes than the file-count ceiling).
 *
 * `shareNamesByImage` is only passed for a `shareEligible` run and must be in grid order — it is
 * both the flattened, globally-deduplicated Share name per image (R-X53, `resolveShareNames`) and,
 * through its own insertion order, the grid position each copy is written at (R-X49). The ZIP's
 * own `pathsByImage` stays directory-scoped and is unaffected by either.
 */
export function openRunArchiveSink(options: {
  pathsByImage: ReadonlyMap<ImageId, string>
  multiImage: boolean
  shareEligible: boolean
  shareNamesByImage?: ReadonlyMap<ImageId, string>
}): RunArchiveSink {
  const { pathsByImage, multiImage, shareEligible, shareNamesByImage } = options

  // Grid position per image, derived once from the Share name map's insertion order: a `Map`
  // iterates in insertion order, so the Nth entry's position *is* the Nth accepted image's grid
  // position. Writing at that index rather than at completion order is what makes
  // `readOutputCopies()`'s ascending-index sort hand Share its payload in grid order (R-X49),
  // whichever worker happens to finish first.
  const shareIndexByImage = new Map<ImageId, number>()
  if (shareNamesByImage) {
    let gridIndex = 0
    for (const imageId of shareNamesByImage.keys()) {
      shareIndexByImage.set(imageId, gridIndex)
      gridIndex += 1
    }
  }

  let successCount = 0
  let queue: EntryQueue | null = null
  let archiveDone: Promise<void> = Promise.resolve()
  let candidateWrite: Promise<void> | undefined

  if (multiImage) {
    queue = new EntryQueue()
    archiveDone = writeArchive(makeZip(toZipEntries(queue)))
  }

  async function submit(
    imageId: ImageId,
    bytes: Uint8Array,
    format: EncodableFormat,
  ): Promise<void> {
    const path = pathsByImage.get(imageId)
    if (path === undefined) {
      // Every image this sink will ever be asked about was named up front from the same list this
      // run started with; a miss here means the caller fed it an image outside that set.
      throw new Error(`openRunArchiveSink: no resolved path for image ${String(imageId)}`)
    }

    successCount += 1
    const mimeType = mimeForFormat(format)
    const meta = { name: basename(path), mimeType }

    if (!multiImage) {
      // R-X16: the only output a 1-image run can ever have, no ZIP involved. A lone file cannot
      // collide under either naming scope, so the ZIP basename is already its Share name too —
      // no separate naming pass, and no second write (R-X51, R-X49's "same direct output").
      await writeOutputCopy(0, bytes, meta)
      return
    }

    queue?.push({ path, bytes })

    if (shareEligible) {
      const shareName = shareNamesByImage?.get(imageId)
      const shareIndex = shareIndexByImage.get(imageId)
      if (shareName === undefined || shareIndex === undefined) {
        // Same contract as `path` above: a Share-eligible sink is given the whole accepted set.
        throw new Error(`openRunArchiveSink: no Share name for image ${String(imageId)}`)
      }

      // Every success keeps its own copy — this is also what gives the R-X16 candidate role to
      // the single remaining copy for free, with no separate bookkeeping (§9.2's "one physical
      // file may serve both candidate and Share roles").
      await writeOutputCopy(shareIndex, bytes, { name: shareName, mimeType })
      return
    }

    if (successCount === 1) {
      candidateWrite = writeOutputCopy(0, bytes, meta) // the R-X16 candidate, until/unless a 2nd success lands
      await candidateWrite
    } else if (successCount === 2) {
      // Submits from different workers overlap, so the 2nd success can arrive while the 1st
      // success is still writing. Deleting the entry between the writer's `getFileHandle` and
      // `createWritable` makes the write fail with NoModificationAllowedError and halts the whole
      // run as a storage failure. The 1st submit reports its own write failure; only ordering matters here.
      await candidateWrite?.catch(() => {})
      await deleteOutputCopy(0) // ZIP delivery is now certain; the candidate is no longer needed
    }
  }

  async function finish(report?: { path: string; bytes: Uint8Array }): Promise<void> {
    if (report && queue) {
      queue.push({ path: report.path, bytes: report.bytes })
    }
    queue?.close()
    await archiveDone
  }

  async function abortAndCleanup(): Promise<void> {
    queue?.close()
    // Closing the queue only ends production; the archive writer may still be flushing bytes.
    // Deleting before it settles can recreate the fallback archive or race the OPFS writer.
    await archiveDone.catch(() => {})
    await deleteRunArtifacts()
  }

  return { submit, finish, abortAndCleanup }
}
