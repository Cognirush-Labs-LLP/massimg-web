// The single runtime configuration module for operational limits (Technical Design §8.3).
//
// T46 owns the measured values and will grow this module to cover every limit in Functional Design
// §5.7. The one value here is the shipped default named by R-G3/R-G10, not a measured figure:
// services read it from here and accept an override, so changing a limit is one edit and needs no
// change to the service that enforces it.

export interface RuntimeLimits {
  /**
   * Ceiling on both source-read attempts and retained thumbnail Blobs, per batch (R-G3, R-G10).
   * An attempt is charged when a read starts and is never refunded or replenished.
   */
  maximumThumbnails: number
}

export const runtimeLimits: RuntimeLimits = {
  maximumThumbnails: 100,
}
