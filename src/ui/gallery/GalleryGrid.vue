<script setup lang="ts">
// The virtualized Gallery grid body (T33-B, Technical Design §10.4, R-G10, R-G12). Renders only
// the rows in the current scroll window (plus one buffer row) regardless of batch size, so a
// 500-image batch costs the same DOM/thumbnail work as a 20-image one. Windowing math itself lives
// in gridWindow.ts, kept pure and DOM-free so it is unit-testable without a real layout.
//
// The ThumbnailService instance is NOT owned by this component (see thumbnail-service.ts) — it is
// a module-scope singleton that survives this component unmounting and remounting, because leaving
// Gallery for Preview/Edit and coming back must not rereads source files it already decoded.
// This component only starts/stops *generation* against that shared cache.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ImageId, ImageRecord } from '@/domain/types'
import { useBatchStore } from '@/stores/batch'
import { getSourceFile } from '@/platform/source-files'
import type { ThumbnailSource } from '@/platform/thumbnails'
import GalleryTile from './GalleryTile.vue'
import { computeGridLayout, computeGridWindow } from './gridWindow'
import { getThumbnailService, thumbnailTick } from './thumbnail-service'

// How long to wait after the last scroll/resize before asking the thumbnail service for the new
// window — the service's own setVisible() replaces rather than appends its queue, so this is not
// load-bearing for correctness, only for not recomputing the request window on every frame.
const REQUEST_SETTLE_MS = 120

const batchStore = useBatchStore()
const images = computed<ImageRecord[]>(() => batchStore.images)

const gridRoot = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const scrollTop = ref(0)
const viewportHeight = ref(0)

let scrollHost: HTMLElement | null = null
let resizeObserver: ResizeObserver | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null
let rafId: number | null = null

const layout = computed(() => computeGridLayout(containerWidth.value, images.value.length))
const windowInfo = computed(() =>
  computeGridWindow(layout.value, scrollTop.value, viewportHeight.value, images.value.length),
)

const renderedImages = computed<ImageRecord[]>(() =>
  images.value.slice(windowInfo.value.renderFirstIndex, windowInfo.value.renderLastIndex + 1),
)

const trackStyle = computed(() => ({
  gridTemplateColumns: `repeat(${layout.value.columns}, 1fr)`,
}))

function urlFor(id: ImageId): string | null {
  // Reads thumbnailTick so this function re-evaluates (and the template re-renders) whenever the
  // service reports a newly ready thumbnail — the underlying cache is a plain, non-reactive Map.
  void thumbnailTick.value
  return getThumbnailService().urlFor(id)
}

function updateScrollMetrics(): void {
  if (!gridRoot.value) {
    return
  }
  const host = scrollHost
  if (!host) {
    viewportHeight.value = gridRoot.value.clientHeight
    return
  }
  scrollTop.value = Math.max(0, host.scrollTop - gridRoot.value.offsetTop)
  viewportHeight.value = host.clientHeight
}

function onScroll(): void {
  if (rafId !== null) {
    return
  }
  rafId = requestAnimationFrame(() => {
    rafId = null
    updateScrollMetrics()
  })
}

function requestThumbnails(): void {
  settleTimer = null
  const window_ = windowInfo.value
  const sources: ThumbnailSource[] = []
  for (let index = window_.requestFirstIndex; index <= window_.requestLastIndex; index += 1) {
    const image = images.value[index]
    if (!image) {
      continue
    }
    const file = getSourceFile(image.id)
    if (!file) {
      continue
    }
    sources.push({
      id: image.id,
      blob: file,
      source: { width: image.width, height: image.height },
      edit: image.edit,
    })
  }
  getThumbnailService().setVisible(sources)
}

function scheduleThumbnailRequest(): void {
  if (settleTimer !== null) {
    clearTimeout(settleTimer)
  }
  settleTimer = setTimeout(requestThumbnails, REQUEST_SETTLE_MS)
}

// immediate: true so the very first window (before anything has changed) is requested too, not
// only subsequent ones — a bare `watch` only fires on a value change, and on first render nothing
// has changed yet.
watch(windowInfo, scheduleThumbnailRequest, { immediate: true })

onMounted(async () => {
  await nextTick()
  if (!gridRoot.value) {
    return
  }

  scrollHost = gridRoot.value.closest('.stage-body')
  scrollHost?.addEventListener('scroll', onScroll, { passive: true })

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (gridRoot.value) {
        containerWidth.value = gridRoot.value.clientWidth
      }
      updateScrollMetrics()
    })
    // Observe the scroll host, not gridRoot itself: gridRoot's own block-size changes as a direct
    // result of this callback (a width change reflows the row count), and observing the element
    // your own callback resizes is what trips "ResizeObserver loop completed with undelivered
    // notifications" (seen on WebKit). The scroll host's size is set by the surrounding shell
    // layout, not by anything this component renders, so it carries no such feedback loop.
    resizeObserver.observe(scrollHost ?? gridRoot.value)
  } else {
    containerWidth.value = gridRoot.value.clientWidth
  }

  updateScrollMetrics()
})

onUnmounted(() => {
  scrollHost?.removeEventListener('scroll', onScroll)
  resizeObserver?.disconnect()
  if (settleTimer !== null) {
    clearTimeout(settleTimer)
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
  }
  // Stops generation and drops the queue, keeping the cache so a later return to Gallery rereads
  // nothing (R-G12; the cache-survives exception lives in thumbnail-service.ts's own singleton).
  getThumbnailService().stop()
})
</script>

<template>
  <div ref="gridRoot" class="gallery-grid" data-testid="gallery-grid">
    <div class="grid-track" :style="trackStyle">
      <div
        class="spacer"
        :style="{ blockSize: `${windowInfo.topSpacerHeight}px`, gridColumn: '1 / -1' }"
      />
      <GalleryTile
        v-for="image in renderedImages"
        :key="image.id"
        :image="image"
        :thumbnail-url="urlFor(image.id)"
      />
      <div
        class="spacer"
        :style="{ blockSize: `${windowInfo.bottomSpacerHeight}px`, gridColumn: '1 / -1' }"
      />
    </div>
  </div>
</template>

<style scoped>
.grid-track {
  display: grid;
  gap: 10px;
}

.spacer {
  inline-size: 100%;
}
</style>
