// The Preview transform line (Functional Design §3.3, docs/ui-design.md §11):
//
//   abc.jpeg  1000×1000  →  abc.webp  500×500
//
// Pure, and driven by the *settings* rather than by the encode result, which is the point: it updates
// the instant the user moves a control, while the comparison figures beside it stay hidden until a
// real encode has measured them (R-P4). It is the one place in Preview that says what will happen
// rather than what did.
//
// Everything it reports is computed by the modules that already own that rule — `resolveSettings`
// (R-F1, R-F2, R-F6, R-C17), `singleImageDimensions` (R-D1, R-D4) and `resolveOutputNames` (R-X21,
// R-X43, R-X44). Nothing is recomputed here, so the line cannot disagree with the file the user
// downloads.

import type { PixelSize } from '@/domain/edit'
import { resolveSettings, singleImageDimensions, type BatchSettings } from '@/domain/job'
import { resolveOutputNames } from '@/domain/naming'
import type { EncodableFormat, ImageRecord } from '@/domain/types'

/**
 * Disclosures that belong on the line rather than in the report (P1).
 *
 * - `animation-substituted` is R-F6's own requirement: the substitution is stated on the tile, on
 *   *this line*, and in the report.
 * - `animation-flattened` is the same disclosure for an animated source the user chose to write as
 *   its first frame only.
 * - `alpha-flattened` is R-C17's: "where transparency will be flattened, the Preview transform line
 *   says so".
 */
export type TransformNote = 'animation-substituted' | 'animation-flattened' | 'alpha-flattened'

export type TransformLine =
  | {
      kind: 'described'
      sourceName: string
      /** `null` until the dimension probe has resolved this image (`imageMeta.ts`'s convention). */
      sourceSize: PixelSize | null
      outputName: string
      outputSize: PixelSize | null
      outputFormat: EncodableFormat
      notes: TransformNote[]
    }
  /** The batch format cannot be resolved for this image at all — today, only an animated AVIF input. */
  | { kind: 'unavailable' }

export function describeTransformLine(image: ImageRecord, batch: BatchSettings): TransformLine {
  const resolution = resolveSettings(image, batch)

  if (resolution.kind === 'rejected') {
    // R-F8 rejects animated AVIF at selection time (T39), so this is a defensive branch: there is no
    // output format to name, and naming the input twice would read as though nothing would change.
    return { kind: 'unavailable' }
  }

  const { settings } = resolution
  const notes: TransformNote[] = []

  if (resolution.caveats.some((caveat) => caveat.kind === 'animation-substituted')) {
    notes.push('animation-substituted')
  }

  if (resolution.caveats.some((caveat) => caveat.kind === 'animation-flattened')) {
    notes.push('animation-flattened')
  }

  // Three states, and they are not the same (D5): `hasTransparency` is `true` (measured, has alpha),
  // `false` (measured, opaque) or `null` (never tested — which is every image today, because nothing
  // probes it yet). Flattening is disclosed in the first and third, and the wording the component
  // renders is conditional ("transparent areas will be filled") precisely so that it is true in the
  // untested case as well. Only a measured `false` suppresses it.
  //
  // A JPEG source is a fourth case the type doesn't model: the format itself has no alpha channel, so
  // `hasTransparency` can never truthfully be anything but `false` for it, probe or no probe. Without
  // this, every JPEG-to-JPEG job would disclose flattening it structurally cannot be doing. The report's
  // own `transparency-flattened` caveat is the measured, past-tense claim, and the pipeline makes it
  // from real pixels — Preview never sees it, because `intent: 'preview'` returns no caveats.
  if (
    settings.alpha.kind === 'flatten' &&
    image.sourceFormat !== 'jpeg' &&
    image.hasTransparency !== false
  ) {
    notes.push('alpha-flattened')
  }

  const [outputName] = resolveOutputNames([
    {
      name: image.name,
      // Deliberately not the image's real relative path: the line names one file, and a folder
      // prefix would make it read as a path change. A ZIP-level collision suffix (R-X22) is scoped
      // to the whole batch and is not predicted here for the same reason.
      relativePath: null,
      sourceFormat: image.sourceFormat,
      formatSetting: batch.format,
      resolvedFormat: settings.format,
    },
  ])

  return {
    kind: 'described',
    sourceName: image.name,
    sourceSize:
      image.width === 0 || image.height === 0 ? null : { width: image.width, height: image.height },
    outputName: outputName ?? image.name,
    outputSize: singleImageDimensions(image, batch.dimension),
    outputFormat: settings.format,
    notes,
  }
}
