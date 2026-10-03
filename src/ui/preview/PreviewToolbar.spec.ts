import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { ImageId, ImageRecord } from '@/domain/types'
import { imageRecordFixture } from '@/domain/types.fixtures'
import { useBatchStore } from '@/stores/batch'
import { useUiStore } from '@/stores/ui'

const addViaFilePicker = vi.fn()
vi.mock('@/ui/gallery/ingest', () => ({ addViaFilePicker }))

const PreviewToolbar = (await import('./PreviewToolbar.vue')).default

function image(id: string, overrides: Partial<ImageRecord> = {}): ImageRecord {
  // The shared fixture carries an edit and is deliberately overridden here: these cases are about
  // the toolbar's own labels, and "has an edit" is one of the things under test.
  return {
    ...imageRecordFixture,
    id: id as ImageId,
    name: `${id}.png`,
    edit: null,
    isAnimated: false,
    ...overrides,
  }
}

function seed(ids: string[], current = ids[0]): void {
  useBatchStore().addImages(ids.map((id) => image(id)))
  useUiStore().openPreview(current as ImageId)
}

beforeEach(() => {
  setActivePinia(createPinia())
  addViaFilePicker.mockReset()
})

describe('PreviewToolbar', () => {
  it('offers Back to images, Add more images and Edit', () => {
    seed(['a'])
    const wrapper = mount(PreviewToolbar)

    expect(wrapper.get('[data-testid="preview-back"]').text()).toBe('‹ All Images')
    expect(wrapper.get('[data-testid="preview-add-more"]').text()).toBe('Add Images')
    expect(wrapper.get('[data-testid="preview-edit"]').text()).toBe('Edit')
  })

  it('keeps "Add Images" as an accessible label even though it collapses to its icon on mobile', () => {
    seed(['a'])
    const wrapper = mount(PreviewToolbar)
    const addMore = wrapper.get('[data-testid="preview-add-more"]')

    // ToolbarButton.vue's `icon-only-mobile`: the label stays in the DOM (and in `.text()`) for
    // screen readers — only its on-screen box collapses below the breakpoint, via CSS this jsdom
    // test can't evaluate directly, so the markup contract is what's checked here.
    expect(addMore.classes()).toContain('icon-only-mobile')
    expect(addMore.text()).toBe('Add Images')
  })

  it('returns to the Gallery on Back', async () => {
    seed(['a', 'b'])
    const wrapper = mount(PreviewToolbar)

    await wrapper.get('[data-testid="preview-back"]').trigger('click')

    expect(useUiStore().stageMode).toBe('gallery')
  })

  it('opens the file picker from Preview (R-M3)', async () => {
    seed(['a'])
    const wrapper = mount(PreviewToolbar)

    await wrapper.get('[data-testid="preview-add-more"]').trigger('click')

    expect(addViaFilePicker).toHaveBeenCalledOnce()
  })

  it('hides the stepper for a single-image batch', () => {
    seed(['a'])

    expect(mount(PreviewToolbar).find('[data-testid="preview-stepper"]').exists()).toBe(false)
  })

  it('shows the position in the batch, one-based', () => {
    seed(['a', 'b', 'c'], 'b')

    expect(mount(PreviewToolbar).get('[data-testid="preview-stepper-position"]').text()).toBe(
      '2 / 3',
    )
  })

  it('wraps at both ends (R-P7)', async () => {
    seed(['a', 'b', 'c'])
    const wrapper = mount(PreviewToolbar)
    const uiStore = useUiStore()

    await wrapper.get('[data-testid="preview-step-previous"]').trigger('click')
    expect(uiStore.currentImageId).toBe('c')

    await wrapper.get('[data-testid="preview-step-next"]').trigger('click')
    expect(uiStore.currentImageId).toBe('a')

    await wrapper.get('[data-testid="preview-step-next"]').trigger('click')
    expect(uiStore.currentImageId).toBe('b')
  })

  it('preserves the comparison tab across a step (R-P7)', async () => {
    seed(['a', 'b'])
    const uiStore = useUiStore()
    uiStore.setComparisonTab('original')
    const wrapper = mount(PreviewToolbar)

    await wrapper.get('[data-testid="preview-step-next"]').trigger('click')

    expect(uiStore.currentImageId).toBe('b')
    expect(uiStore.comparisonTab).toBe('original')
  })

  it('names the action Edit changes once an edit is stored', () => {
    useBatchStore().addImages([
      image('a', { edit: { ops: [{ kind: 'rotate', quarterTurns: 1 }], version: 1 } }),
    ])
    useUiStore().openPreview('a' as ImageId)

    expect(mount(PreviewToolbar).get('[data-testid="preview-edit"]').text()).toBe('Edit changes')
  })

  it('opens Edit for the image on screen', async () => {
    seed(['a', 'b'], 'b')
    const wrapper = mount(PreviewToolbar)

    await wrapper.get('[data-testid="preview-edit"]').trigger('click')

    const uiStore = useUiStore()
    expect(uiStore.stageMode).toBe('edit')
    expect(uiStore.currentImageId).toBe('b')
  })

  it('does not offer editing for an animated source, and says why (R-C16)', async () => {
    useBatchStore().addImages([image('a', { isAnimated: true })])
    useUiStore().openPreview('a' as ImageId)
    const wrapper = mount(PreviewToolbar)
    await nextTick()

    const edit = wrapper.get('[data-testid="preview-edit"]')

    expect(edit.attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="preview-edit-animated-note"]').text()).toContain('animated')

    await edit.trigger('click')

    expect(useUiStore().stageMode).toBe('preview')
  })

  it('gives both stepper controls an accessible name (R-K10)', () => {
    seed(['a', 'b'])
    const wrapper = mount(PreviewToolbar)

    expect(wrapper.get('[data-testid="preview-step-previous"]').attributes('aria-label')).toBe(
      'Previous image',
    )
    expect(wrapper.get('[data-testid="preview-step-next"]').attributes('aria-label')).toBe(
      'Next image',
    )
  })
})
