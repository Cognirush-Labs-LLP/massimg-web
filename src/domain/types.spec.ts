import { describe, expect, it } from 'vitest'
import {
  caveatFixtures,
  cropOpFixture,
  editRecordFixture,
  failureReasonFixture,
  formatFixture,
  imageIdFixture,
  imageRecordFixture,
  jobFixture,
  resolvedSettingsFixture,
  rotateOpFixture,
} from './types.fixtures'

describe('core type fixtures', () => {
  it('provides one reusable fixture for each core shape', () => {
    expect(imageIdFixture).toBe('image-1')
    expect(formatFixture).toBe('png')
    expect(failureReasonFixture.kind).toBe('decode-failed')
    expect(imageRecordFixture.id).toBe(imageIdFixture)
    expect(resolvedSettingsFixture.format).toBe('webp')
    expect(jobFixture.settings).toBe(resolvedSettingsFixture)
    expect(caveatFixtures).toHaveLength(9)
  })

  it('keeps edit operations as an ordered discriminated union', () => {
    expect(editRecordFixture.ops).toEqual([rotateOpFixture, cropOpFixture])
    expect(editRecordFixture.ops.map((op) => op.kind)).toEqual(['rotate', 'crop'])
  })
})
