<script setup lang="ts">
// vite-ssg root component (T31). Deliberately thin: T43 wraps this with the outer public-site
// header and footer later, so nothing tool-specific lives here — that's ToolPage.vue's job,
// mounted through <router-view /> at the '/' route (Technical Design §12.3, R-S1).
</script>

<template>
  <router-view />
</template>
