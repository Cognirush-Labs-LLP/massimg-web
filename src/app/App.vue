<script setup lang="ts">
// vite-ssg root component (T31). Wraps every route with the outer public-site header/footer
// (T43, SiteShell.vue) — nothing tool-specific lives here, that's ToolPage.vue's job, mounted
// through SiteShell's <router-view /> at the '/' route (Technical Design §12.3, R-S1).
import SiteShell from './site/SiteShell.vue'
import { useAnalyticsBeacon } from './seo/useAnalyticsBeacon'

// T46, Technical Design §12.6: mounted here rather than per-route (SiteShell.vue) since the
// beacon script is identical on every route.
useAnalyticsBeacon()
</script>

<template>
  <SiteShell />
</template>
