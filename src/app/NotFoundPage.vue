<script setup lang="ts">
import { t } from '@/i18n/t'
</script>

<template>
  <article class="not-found-page">
    <h1>{{ t('notFound.heading') }}</h1>
    <p>{{ t('notFound.body') }}</p>
    <RouterLink :to="{ name: 'tool' }">{{ t('notFound.homeLink') }}</RouterLink>
  </article>
</template>

<style scoped>
.not-found-page {
  max-inline-size: 720px;
  padding-block: 32px 64px;
  padding-inline: 20px;
  margin-inline: auto;
  line-height: 1.6;
}

h1 {
  margin-block: 0 0.6em;
  font-size: 28px;
  font-weight: var(--font-weight-wordmark);
}

p {
  margin-block: 0 1em;
  color: var(--color-primary);
}

a {
  color: var(--color-primary);
  text-decoration: underline;
}
</style>
