<script setup lang="ts">
// T07 design-token demo. Renders every token from src/styles/tokens.css so
// they can be eyeballed in a real browser. Not real product UI — see
// docs/task-notes/T07.md for where this lives and what should happen to it
// (T31 replaces App.vue's shell; this component can be dropped or moved to a
// dev-only route at that point).

interface Swatch {
  label: string
  token: string
  varName: string
}

const colourSwatches: Swatch[] = [
  { label: 'Tint', token: '--color-tint', varName: '#cf0000' },
  { label: 'Primary', token: '--color-primary', varName: '#ffffff' },
  { label: 'Background', token: '--color-background', varName: '#000000' },
  { label: 'Surface / panel', token: '--color-surface-panel', varName: '#060606' },
  { label: 'Surface / control', token: '--color-surface-control', varName: '#0e0e0e' },
  { label: 'Surface / tile', token: '--color-surface-tile', varName: '#121212' },
  { label: 'Border / group', token: '--color-border-group', varName: '#242424' },
  { label: 'Border / control', token: '--color-border-control', varName: '#2c2c2c' },
  { label: 'Muted text', token: '--color-text-muted', varName: '#a2a2a2' },
  { label: 'Muted text / quiet', token: '--color-text-muted-quiet', varName: '#6e6e6e' },
]

const radiusSwatches = [
  { label: 'Radius / sm (chips, small fields)', token: '--radius-sm' },
  { label: 'Radius / md (controls, rows)', token: '--radius-md' },
  { label: 'Radius / lg (primary button, stage frame)', token: '--radius-lg' },
]
</script>

<template>
  <section class="tokens-demo" aria-label="Design token demo">
    <header class="tokens-demo__intro">
      <p class="tokens-demo__marker">
        T07 design-token demo — temporary, see docs/task-notes/T07.md
      </p>
      <h1 class="tokens-demo__wordmark">Design tokens</h1>
    </header>

    <section class="tokens-demo__group">
      <h2 class="tokens-demo__heading">Colour</h2>
      <ul class="tokens-demo__swatches">
        <li v-for="swatch in colourSwatches" :key="swatch.token" class="swatch">
          <div class="swatch__chip" :style="{ backgroundColor: `var(${swatch.token})` }"></div>
          <p class="swatch__label">{{ swatch.label }}</p>
          <p class="swatch__value">{{ swatch.token }} · {{ swatch.varName }}</p>
        </li>
      </ul>
    </section>

    <section class="tokens-demo__group">
      <h2 class="tokens-demo__heading">Typography</h2>

      <p class="type-sample type-sample--wordmark">Wordmark / primary action (700)</p>
      <p class="type-sample type-sample--heading">
        Section heading (600, uppercase, wide tracking)
      </p>
      <p class="type-sample type-sample--control">Controls and chips (600)</p>
      <p class="type-sample type-sample--micro-label">
        FUNCTIONAL MICRO-LABEL (600, 11.5px, muted)
      </p>
      <p class="type-sample type-sample--metadata">Passive metadata, quiet small mono grey</p>
      <p class="type-sample type-sample--mono">
        System mono data text — 128 KB · 1920 × 1080 · 3 / 12
      </p>
      <p class="type-sample type-sample--mono-strong">−62% (emphasised mono, tint)</p>
    </section>

    <section class="tokens-demo__group">
      <h2 class="tokens-demo__heading">Radii</h2>
      <ul class="tokens-demo__radii">
        <li v-for="radius in radiusSwatches" :key="radius.token" class="radius-sample">
          <div class="radius-sample__box" :style="{ borderRadius: `var(${radius.token})` }"></div>
          <p class="swatch__label">{{ radius.label }}</p>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.tokens-demo {
  padding-block: 2rem;
  padding-inline: 2rem;
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
}

.tokens-demo__marker {
  font-family: var(--font-family-mono);
  font-size: 11px;
  color: var(--color-text-muted-quiet);
  margin-block-end: 0.5rem;
}

.tokens-demo__wordmark {
  font-family: var(--font-family-display);
  font-weight: var(--font-weight-wordmark);
  font-size: 28px;
  margin-block: 0;
  color: var(--color-primary);
}

.tokens-demo__heading {
  font-family: var(--font-family-display);
  font-weight: var(--font-weight-heading);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing-heading);
  font-size: 14px;
  color: var(--color-primary);
  margin-block-end: 1rem;
}

.tokens-demo__swatches,
.tokens-demo__radii {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
  gap: 1rem;
}

.swatch {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.swatch__chip {
  block-size: 4rem;
  inline-size: 100%;
  border: 1px solid var(--color-border-group);
  border-radius: var(--radius-md);
}

.swatch__label {
  font-family: var(--font-family-display);
  font-weight: var(--font-weight-control);
  font-size: 12.5px;
  color: var(--color-primary);
  margin: 0;
}

.swatch__value {
  font-family: var(--font-family-mono);
  font-size: 10.5px;
  color: var(--color-text-muted-quiet);
  margin: 0;
}

.type-sample {
  margin-block: 0.35rem;
}

.type-sample--wordmark {
  font-family: var(--font-family-display);
  font-weight: var(--font-weight-wordmark);
  font-size: 20px;
  color: var(--color-primary);
}

.type-sample--heading {
  font-family: var(--font-family-display);
  font-weight: var(--font-weight-heading);
  text-transform: uppercase;
  letter-spacing: var(--letter-spacing-heading);
  font-size: 14px;
  color: var(--color-primary);
}

.type-sample--control {
  font-family: var(--font-family-display);
  font-weight: var(--font-weight-control);
  font-size: 14px;
  color: var(--color-primary);
}

.type-sample--micro-label {
  font-family: var(--font-family-display);
  font-weight: var(--font-weight-heading);
  font-size: var(--font-size-micro-label);
  letter-spacing: var(--letter-spacing-micro-label);
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.type-sample--metadata {
  font-family: var(--font-family-mono);
  font-size: 11px;
  color: var(--color-text-muted-quiet);
}

.type-sample--mono {
  font-family: var(--font-family-mono);
  font-weight: 400;
  font-size: 13px;
  color: var(--color-primary);
}

.type-sample--mono-strong {
  font-family: var(--font-family-mono);
  font-weight: 700;
  font-size: 13px;
  color: var(--color-tint);
}

.radius-sample {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.radius-sample__box {
  block-size: 4rem;
  inline-size: 100%;
  background-color: var(--color-surface-control);
  border: 1px solid var(--color-border-control);
}
</style>
