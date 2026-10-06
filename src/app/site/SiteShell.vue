<script setup lang="ts">
// Outer site shell (R-S2, Technical Design §12.3, T43): wraps every route with a footer, and a
// header on every route except the tool route. The tool route mounts its own existing
// header/stage/panel shell (T31) unchanged inside this, via <router-view/>.
//
// Chosen purely by route, not viewport width: the tool route gets no outer header at all (its
// own inner header already provides chrome) and a compact footer carrying every site-level
// link in place of one; every other route gets the regular header and footer. This keeps the
// tool viewport-scroll-free without a separate mobile/desktop chrome split.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SiteHeader from './SiteHeader.vue'
import SiteFooter from './SiteFooter.vue'

const route = useRoute()

const isAppRoute = computed(() => route.meta.isApp === true)
</script>

<template>
  <div class="site-shell" :class="{ 'site-shell--app': isAppRoute }">
    <SiteHeader v-if="!isAppRoute" />
    <main class="site-main">
      <router-view />
    </main>
    <SiteFooter :compact="isAppRoute" />
  </div>
</template>

<style scoped>
.site-shell {
  display: flex;
  flex-direction: column;
  min-block-size: 100dvh;
}

.site-shell--app {
  block-size: 100dvh;
  min-block-size: 100dvh;
  overflow: hidden;
}

.site-main {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.site-shell--app .site-main {
  min-block-size: 0;
  overflow: hidden;
}
</style>
