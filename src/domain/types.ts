declare const imageIdBrand: unique symbol

/** Stable identity for an image while it belongs to the batch. */
export type ImageId = string & { readonly [imageIdBrand]: true }

export type Format =
  'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'bmp' | 'tiff' | 'jxl' | 'jp2' | 'heic' | 'heif'

export type EncodableFormat = Extract<Format, 'jpeg' | 'png' | 'webp' | 'avif' | 'gif'>

export interface NormalisedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export type EditOp =
  | { kind: 'rotate'; quarterTurns: 0 | 1 | 2 | 3 }
  | { kind: 'crop'; rect: NormalisedRect; zoom: number; background: Rgba }
  /** A verified, uniform post-crop downscale suggested after a size target was unreachable. */
  | { kind: 'resize'; width: number; height: number }

export interface EditRecord {
  /** Operations are applied in array order. */
  ops: EditOp[]
  /** Incremented whenever the edit changes so stale previews can be discarded. */
  version: number
}

export type FailureReason =
  { kind: 'decode-failed' } | { kind: 'encode-failed' } | { kind: 'out-of-memory' }

export interface SizeTargetSkipReason {
  kind: 'size-target-unreachable'
  targetBytes: number
  achievedBytes: number
  format: EncodableFormat
  width: number
  height: number
}

export interface ImageRecord {
  id: ImageId
  name: string
  relativePath: string | null
  sizeBytes: number
  width: number
  height: number
  sourceFormat: Format
  isAnimated: boolean
  frameCount: number | null
  hasTransparency: boolean | null
  edit: EditRecord | null
  /** Store mutations keep `failure` and `skipReason` mutually exclusive for this status. */
  status: 'ready' | 'failed' | 'skipped'
  failure: FailureReason | null
  skipReason: SizeTargetSkipReason | null
}

export type ResolvedQuality =
  { kind: 'quality'; value: number; lossless: boolean } | { kind: 'size'; targetBytes: number }

export type BatchDimension =
  | { kind: 'original' }
  | { kind: 'fit-long-edge'; pixels: number }
  | { kind: 'fixed-width'; pixels: number }
  | { kind: 'fixed-height'; pixels: number }

export type ResolvedDimension =
  | BatchDimension
  /** Internal post-edit size. It is never a side-panel setting. */
  | { kind: 'exact'; width: number; height: number }

export type AlphaHandling = { kind: 'preserve' } | { kind: 'flatten'; background: Rgba }

export interface ResolvedSettings {
  quality: ResolvedQuality
  dimension: ResolvedDimension
  format: EncodableFormat
  /**
   * The source's own format, carried through because two pipeline decisions depend on it rather
   * than on the output format: which codec modules a job needs (an animated PNG *source* needs
   * UPNG whatever it is written as — see `pipeline/codecs/routing.ts`), and which decoder
   * `stages/animation.ts` uses.
   */
  sourceFormat: Format
  isAnimated: boolean
  alpha: AlphaHandling
}

export interface Job {
  /** Omitted by existing callers; omission is the ordinary encode operation. */
  kind?: 'encode'
  imageId: ImageId
  /** Raw source bytes are transferable to a worker without adding browser APIs to the domain layer. */
  source: Uint8Array
  edit: EditRecord | null
  settings: ResolvedSettings
  intent: 'preview' | 'run'
  /**
   * Caveats already decided before the job was built — `resolveFormat`'s `animation-substituted`
   * is the one today. Optional because most jobs have none and most tests build one directly rather
   * than through `resolveSettings`; `executeJob` merges whatever is here ahead of what its own
   * stages produce, so this is the one place a resolution-time caveat can still reach the report.
   */
  caveats?: Caveat[]
}

export interface JpegRecoveryJob {
  kind: 'jpeg-recovery'
  imageId: ImageId
  source: Uint8Array
  edit: EditRecord | null
  /** Already resolved as JPEG, including its alpha-fill decision. */
  settings: ResolvedSettings
}

export interface DimensionRecoveryJob {
  kind: 'dimension-recovery'
  imageId: ImageId
  source: Uint8Array
  edit: EditRecord | null
  settings: ResolvedSettings
  targetBytes: number
  /** The ordinary size search's initial miss, used to seed the first smaller-dimension estimate. */
  achievedBytes: number
  width: number
  height: number
}

export type PipelineJob = Job | JpegRecoveryJob | DimensionRecoveryJob

export type OriginalKeptReason = 'already-within-size-target' | 'encoded-not-smaller'

export type Caveat =
  | { kind: 'transparency-flattened'; fill: Rgba }
  | { kind: 'animation-substituted' }
  | { kind: 'metadata-removed'; gpsDataRemoved: boolean }
  | { kind: 'original-kept'; reason: OriginalKeptReason }
  | { kind: 'output-larger-than-input'; inputBytes: number; outputBytes: number }
  | { kind: 'png-quantized' }
  | { kind: 'colour-converted' }
  | { kind: 'auxiliary-images-dropped' }
