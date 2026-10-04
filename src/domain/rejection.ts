import type { UnhandledReason } from './classify'

// Selection-time rejections (Functional Design §5.1, §5.3, §10, R-I2, R-I3, R-F8). A file matching
// one of these never becomes an `ImageRecord` — it is reported once, in the dismissible list
// (R-E2), and never enters the batch, the Processing counter or the grid.
//
// Deliberately its own file rather than folded into `domain/types.ts`: T09's `ImageRecord`/
// `FailureReason` contract describes an image already in the batch, which a rejected file never
// is. This mirrors `domain/report.ts`'s own split from that file.
export type RejectionReason =
  | { kind: 'unhandled'; reason: UnhandledReason }
  | { kind: 'heic-decoder-unavailable' }
  | { kind: 'file-too-large'; actualBytes: number; capBytes: number }
  | { kind: 'batch-count-exceeded'; actual: number; cap: number }
  | { kind: 'folder-empty' }
  | { kind: 'folder-depth-exceeded'; actual: number; cap: number }
  | { kind: 'folder-file-count-exceeded'; actual: number; cap: number }

export interface RejectionEntry {
  id: string
  /** Null for a folder-/batch-wide message with no single associated file. */
  name: string | null
  relativePath: string | null
  reason: RejectionReason
}
