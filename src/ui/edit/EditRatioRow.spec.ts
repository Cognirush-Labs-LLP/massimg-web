import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { PixelSize } from '@/domain/edit'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'
import { useEditDraftStore } from '@/stores/edit-draft'
import { useUiStore } from '@/stores/ui'
import EditRatioRow from './EditRatioRow.vue'

const FRAME: PixelSize = { width: 400, height: 400 }

beforeEach(() => {
  setActivePinia(createPinia())
  const image = { ...imageRecordFixture, edit: null }
  useBatchStore().addImages([image])
  useUiStore().openEdit(image.id)
  useEditDraftStore().initFor(image, FRAME)
})

describe('EditRatioRow', () => {
  it('renders the five ratio chips in order, Free active by default', () => {
    const wrapper = mount(EditRatioRow)

    const ids = ['free', '1:1', '4:5', '16:9', '9:16']
    for (const id of ids) {
      expect(wrapper.find(`[data-testid="edit-ratio-${id}"]`).exists()).toBe(true)
    }
    expect(wrapper.get('[data-testid="edit-ratio-free"]').classes()).toContain('active')
  })

  it('selecting a ratio updates the draft store and the active chip', async () => {
    const wrapper = mount(EditRatioRow)

    await wrapper.get('[data-testid="edit-ratio-1:1"]').trigger('click')

    expect(useEditDraftStore().ratioId).toBe('1:1')
    expect(wrapper.get('[data-testid="edit-ratio-1:1"]').classes()).toContain('active')
    expect(wrapper.get('[data-testid="edit-ratio-free"]').classes()).not.toContain('active')
  })
})
