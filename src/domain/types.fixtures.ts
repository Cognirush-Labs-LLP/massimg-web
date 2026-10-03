import type {
  Caveat,
  EditOp,
  EditRecord,
  FailureReason,
  Format,
  ImageId,
  ImageRecord,
  Job,
  ResolvedSettings,
} from './types'

export const imageIdFixture = 'image-1' as ImageId

export const formatFixture = 'png' satisfies Format

export const rotateOpFixture = {
  kind: 'rotate',
  quarterTurns: 1,
} satisfies EditOp

export const cropOpFixture = {
  kind: 'crop',
  rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
  zoom: 1.25,
  background: { r: 255, g: 255, b: 255, a: 1 },
} satisfies EditOp

export const editRecordFixture = {
  ops: [rotateOpFixture, cropOpFixture],
  version: 2,
} satisfies EditRecord

export const failureReasonFixture = {
  kind: 'decode-failed',
} satisfies FailureReason

export const imageRecordFixture = {
  id: imageIdFixture,
  name: 'portrait.PNG',
  relativePath: 'photos/portrait.PNG',
  sizeBytes: 1_048_576,
  width: 1600,
  height: 1200,
  sourceFormat: formatFixture,
  isAnimated: false,
  frameCount: null,
  hasTransparency: true,
  edit: editRecordFixture,
  status: 'ready',
  failure: null,
  skipReason: null,
} satisfies ImageRecord

export const resolvedSettingsFixture = {
  quality: { kind: 'quality', value: 70, lossless: false },
  dimension: { kind: 'fit-long-edge', pixels: 1920 },
  format: 'webp',
  sourceFormat: formatFixture,
  isAnimated: false,
  alpha: { kind: 'preserve' },
} satisfies ResolvedSettings

export const jobFixture = {
  imageId: imageIdFixture,
  source: new Uint8Array([0xff, 0xd8, 0xff]),
  edit: editRecordFixture,
  settings: resolvedSettingsFixture,
  intent: 'run',
} satisfies Job

export const caveatFixtures = [
  { kind: 'transparency-flattened', fill: { r: 255, g: 255, b: 255, a: 1 } },
  { kind: 'animation-substituted' },
  { kind: 'metadata-removed', gpsDataRemoved: true },
  { kind: 'original-kept', reason: 'encoded-not-smaller' },
  { kind: 'output-larger-than-input', inputBytes: 100, outputBytes: 120 },
  { kind: 'png-quantized' },
  { kind: 'colour-converted' },
  { kind: 'auxiliary-images-dropped' },
] satisfies Caveat[]
