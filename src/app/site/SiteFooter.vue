<script setup lang="ts">
// Outer site footer (R-S2, T43). Carries the source-code link R-V4 requires, plus every
// site-level link (For Desktops, Privacy, Terms, Credits, FAQ) — on the tool route the footer is
// the *only* outer-shell chrome (no header there at all, see SiteHeader.vue), so it has to carry
// everything a header would otherwise. Two density variants, chosen by SiteShell.vue purely by
// route: compact (tool route, any viewport — tight padding and an icon-only GitHub link, so the
// tool still fits the viewport with no page scroll) and regular (every other route — GitHub link
// carries a visible label too, roomier padding).
import { operator } from '@/config/site'
import { t } from '@/i18n/t'

defineProps<{ compact: boolean }>()
</script>

<template>
  <footer class="site-footer" :class="{ 'site-footer--compact': compact }">
    <a
      class="github-link"
      :href="operator.sourceUrl"
      target="_blank"
      rel="noopener"
      :aria-label="compact ? t('site.footer.githubAriaLabel') : undefined"
    >
      <svg
        class="github-icon"
        viewBox="0 0 16 16"
        width="18"
        height="18"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
             0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
             -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
             .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
             -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82
             .44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48
             0 1.07-.02 1.93-.02 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
        />
      </svg>
      <span v-if="!compact" class="github-label">{{ t('site.footer.githubLabel') }}</span>
    </a>
    <!-- Just 'Privacy', in both variants. A longer privacy line was tried here (R-V1's
         persistent half) and removed: at tool width below ~600px it wrapped the footer onto a
         second row, costing 30px of stage height — measured, and visible as a shorter Preview
         frame. R-V1's reachability is carried by this link; the claim itself is stated in full in
         the Gallery empty state. -->
    <RouterLink :to="{ name: 'privacy' }">{{ t('site.nav.privacy') }}</RouterLink>
    <a class="for-desktops-link" :href="operator.desktopDownloadUrl" target="_blank" rel="noopener">
      {{ t('site.nav.desktop') }}
    </a>
    <RouterLink :to="{ name: 'terms' }">{{ t('site.nav.terms') }}</RouterLink>
    <RouterLink :to="{ name: 'credits' }">{{ t('site.nav.credits') }}</RouterLink>
    <RouterLink :to="{ name: 'faq' }">{{ t('site.nav.faq') }}</RouterLink>
  </footer>
</template>

<style scoped>
.site-footer {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
  padding-block: 18px;
  padding-inline: 20px;
  border-block-start: 1px solid var(--color-border-group);
  color: var(--color-primary);
}

.site-footer--compact {
  gap: 14px;
  padding-block: 6px;
  padding-inline: 14px;
}

.site-footer a {
  color: var(--color-primary);
  font-size: 13px;
  text-decoration: none;
}

.site-footer a:hover {
  color: var(--color-tint);
}

.github-link {
  display: flex;
  align-items: center;
  gap: 8px;
}

.github-icon {
  display: block;
  flex: none;
}

.github-label {
  font-size: 13px;
}
</style>
