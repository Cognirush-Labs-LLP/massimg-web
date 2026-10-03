import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { PixelSize } from '@/domain/edit'
import type { ImageRecord } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'
import { useEditDraftStore } from '@/stores/edit-draft'
import { useUiStore } from '@/stores/ui'
import EditToolbar from './EditToolbar.vue'

const SOURCE: PixelSize = { width: 800, height: 400 }
const FRAME: PixelSize = { width: 400, height: 400 }

function seedAndInit(overrides: Partial<ImageRecord> = {}): ImageRecord {
  const image: ImageRecord = {
    ...imageRecordFixture,
    width: SOURCE.width,
    height: SOURCE.height,
    edit: null,
    ...overrides,
  }
  useBatchStore().addImages([image])
  useUiStore().openEdit(image.id)
  useEditDraftStore().initFor(image, FRAME)
  return image
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('EditToolbar', () => {
  it('shows the live output width and height', () => {
    seedAndInit()
    const wrapper = mount(EditToolbar)

    expect(
      (wrapper.get('[data-testid="edit-width-field"]').element as HTMLInputElement).value,
    ).toBe('800')
    expect(
      (wrapper.get('[data-testid="edit-height-field"]').element as HTMLInputElement).value,
    ).toBe('400')
  })

  it('the zoom slider reads and drives the draft store zoom (R-C7)', async () => {
    seedAndInit()
    const wrapper = mount(EditToolbar)
    const slider = wrapper.get('[data-testid="edit-zoom-slider"]')

    expect((slider.element as HTMLInputElement).value).toBe('1')
    expect(wrapper.get('[data-testid="edit-zoom-readout"]').text()).toBe('100%')

    await slider.setValue('2')

    expect(useEditDraftStore().zoom).toBe(2)
    expect(wrapper.get('[data-testid="edit-zoom-readout"]').text()).toBe('200%')
  })

  it('rotate left/right call the draft store with the right quarter turns', async () => {
    seedAndInit()
    const wrapper = mount(EditToolbar)
    const draft = useEditDraftStore()

    await wrapper.get('[data-testid="edit-rotate-right"]').trigger('click')
    expect(draft.quarterTurns).toBe(1)

    await wrapper.get('[data-testid="edit-rotate-left"]').trigger('click')
    expect(draft.quarterTurns).toBe(0)
  })

  it('typing a width updates the draft rect so the output width matches', async () => {
    seedAndInit()
    const wrapper = mount(EditToolbar)
    const field = wrapper.get('[data-testid="edit-width-field"]')

    await field.setValue('200')

    expect(useEditDraftStore().geometry).toMatchObject({ output: { size: { width: 200 } } })
  })

  it('hides Remove edit when the image has no stored edit, shows it when it does', () => {
    seedAndInit({ edit: null })
    expect(mount(EditToolbar).find('[data-testid="edit-remove"]').exists()).toBe(false)
  })

  it('shows Remove edit for an image with a stored edit, and it clears the edit', async () => {
    const image = seedAndInit({
      edit: { ops: [{ kind: 'rotate', quarterTurns: 1 }], version: 1 },
    })
    const wrapper = mount(EditToolbar)

    expect(wrapper.find('[data-testid="edit-remove"]').exists()).toBe(true)

    await wrapper.get('[data-testid="edit-remove"]').trigger('click')

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit).toBeNull()
    expect(useUiStore().stageMode).toBe('preview')
  })

  it('Cancel returns to Preview without storing anything', async () => {
    seedAndInit()
    const wrapper = mount(EditToolbar)
    useEditDraftStore().rotate(1)

    await wrapper.get('[data-testid="edit-cancel"]').trigger('click')

    expect(useUiStore().stageMode).toBe('preview')
  })

  it('Apply stores the current rotation and returns to Preview', async () => {
    const image = seedAndInit()
    const wrapper = mount(EditToolbar)
    useEditDraftStore().rotate(1)

    await wrapper.get('[data-testid="edit-apply"]').trigger('click')

    const stored = useBatchStore().images.find((candidate) => candidate.id === image.id)
    expect(stored?.edit?.ops).toEqual([{ kind: 'rotate', quarterTurns: 1 }])
    expect(useUiStore().stageMode).toBe('preview')
  })
})
