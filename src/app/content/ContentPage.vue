<script setup lang="ts">
// Renders one of the four public content pages (FAQ, Privacy, Terms, Desktop) from markdown
// (Technical Design §12.4, R-S4, R-S5). Locale is hardcoded to the default for now, matching
// src/i18n/t.ts's own "no real switcher yet" state — wiring the active locale through is T48's
// job, once more than one locale exists.
import { computed } from 'vue'
import { defaultLocale } from '@/config/site'
import { loadRawContent, type ContentPageId } from './content'
import { renderMarkdown } from './renderMarkdown'

const props = defineProps<{ page: ContentPageId }>()

const html = computed(() => renderMarkdown(loadRawContent(defaultLocale, props.page)))
</script>

<template>
  <article :class="['content-page', `content-page--${page}`]" v-html="html" />
</template>

<style>
/* Not `scoped`: this article's body is injected via v-html, so it never carries the
   component's scope attribute — every rule below is hand-scoped under .content-page
   instead, which is the only way to style injected markup without Vue's scoped CSS. */
.content-page {
  max-inline-size: 720px;
  padding-block: 32px 64px;
  padding-inline: 20px;
  margin-inline: auto;
  line-height: 1.6;
}

.content-page h1 {
  margin-block: 0 0.6em;
  font-size: 28px;
  font-weight: var(--font-weight-wordmark);
}

.content-page h2 {
  margin-block: 1.6em 0.6em;
  font-size: 19px;
  font-weight: var(--font-weight-wordmark);
  border-block-end: 1px solid var(--color-border-group);
  padding-block-end: 0.4em;
}

.content-page p {
  margin-block: 0 1em;
  color: var(--color-primary);
}

.content-page ul,
.content-page ol {
  margin-block: 0 1em;
  padding-inline-start: 1.4em;
}

.content-page li {
  margin-block-end: 0.4em;
}

.content-page a {
  color: var(--color-tint);
  text-decoration: underline;
}

.content-page strong {
  font-weight: var(--font-weight-wordmark);
}

/* Each FAQ entry is one <p> (bold question, soft line break, plain answer) rather than two
   paragraphs — extractFaqEntries.ts's token walk requires that shape to pull question/answer
   pairs out for JSON-LD. `display: block` on the leading <strong> gives the question its own
   line without splitting the paragraph. */
.content-page--faq p {
  color: var(--color-text-muted);
}

.content-page--faq p > strong:first-child {
  display: block;
  margin-block: 1.4em 0.35em;
  color: var(--color-primary);
  font-weight: var(--font-weight-heading);
}
</style>
