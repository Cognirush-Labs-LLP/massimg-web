import { ref } from 'vue'

// The four stage modes (Functional Design §3.1, docs/ui-design.md §3). Exactly one is mounted
// at a time by ToolPage.vue, via `<component :is>` — never a `v-if` toggle inside one persistent
// tree — so leaving a mode unmounts its component instance (Technical Design §1.1, R-M4).
export type StageMode = 'gallery' | 'preview' | 'edit' | 'processing'

// T31-temporary: a module-scope ref, not a Pinia store. T32 builds `useUiStore`
// (Technical Design §3), which takes over this exact field — this ref gets replaced by a
// store-backed one then, not incrementally refactored. T31 runs before T32 in task order, and
// nothing here is reachable through real user interaction yet (Gallery has no images to click
// into Preview/Edit), so there is no user-visible behaviour this ordering could get wrong.
const stageMode = ref<StageMode>('gallery')

export function useStageMode(): { stageMode: typeof stageMode } {
  return { stageMode }
}
