<script setup lang="ts">
// Outer site header (R-S2, T43). Shown only on non-app routes (/faq, /privacy, /terms,
// /desktop) — SiteShell.vue never renders this on the tool route at all, at any viewport
// width, since the tool's own inner header (ToolPage.vue's Header.vue) already provides its
// chrome and the footer carries every site-level link there instead (per the user's explicit
// simplification over the shell's original compact/regular split).
import { t } from '@/i18n/t'
</script>

<template>
  <header class="site-header">
    <RouterLink class="home-link" :to="{ name: 'tool' }">
      <!-- mic192.png, not mic32.png: displayed at 32px but sourced at 6x that size so it stays
           sharp on 2x/3x-density screens rather than upscaling an already-32px source. -->
      <img class="site-icon" src="/icons/mic192.png" alt="" width="32" height="32" />
      <span class="home-text">{{ t('site.nav.home') }}</span>
    </RouterLink>
    <nav class="site-nav" :aria-label="t('site.nav.home')">
      <RouterLink :to="{ name: 'faq' }">{{ t('site.nav.faq') }}</RouterLink>
      <RouterLink :to="{ name: 'desktop' }">{{ t('site.nav.desktop') }}</RouterLink>
    </nav>
  </header>
</template>

<style scoped>
.site-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 16px;
  padding-block: 14px;
  padding-inline: 20px;
  border-block-end: 1px solid var(--color-border-group);
}

.site-icon {
  display: block;
  flex: none;
  inline-size: 32px;
  block-size: 32px;
  border-radius: var(--radius-sm);
}

.home-link {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--color-primary);
  text-decoration: none;
}

.home-text {
  font-weight: var(--font-weight-wordmark);
  font-size: 14.5px;
}

.site-nav {
  display: flex;
  flex: 1;
  justify-content: flex-end;
  gap: 20px;
}

.site-nav a {
  color: var(--color-primary);
  font-size: 13.5px;
  text-decoration: none;
}

.site-nav a:hover {
  color: var(--color-tint);
}
</style>
