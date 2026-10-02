<script setup lang="ts">
// Shared visible progress treatment for Preview's two potentially long waits. The surrounding
// component owns the live-region semantics; the dots are decorative and hidden from assistive
// technology so the translated status is announced only once.
defineProps<{ message: string }>()
</script>

<template>
  <p class="loading-status">
    <span>{{ message }}</span>
    <span class="loading-status__dots" aria-hidden="true" data-testid="loading-indicator">
      <span></span>
      <span></span>
      <span></span>
    </span>
  </p>
</template>

<style scoped>
.loading-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
  text-align: center;
}

.loading-status__dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-inline-size: 24px;
}

.loading-status__dots > span {
  inline-size: 5px;
  block-size: 5px;
  border-radius: 50%;
  background: var(--color-tint);
  animation: loading-status-pulse 1s ease-in-out infinite;
}

.loading-status__dots > span:nth-child(2) {
  animation-delay: 120ms;
}

.loading-status__dots > span:nth-child(3) {
  animation-delay: 240ms;
}

@keyframes loading-status-pulse {
  0%,
  60%,
  100% {
    opacity: 0.35;
    transform: translateY(0) scale(0.8);
  }

  30% {
    opacity: 1;
    transform: translateY(-3px) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .loading-status__dots > span {
    animation: none;
    opacity: 0.7;
    transform: none;
  }
}
</style>
