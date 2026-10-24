<script setup lang="ts">
// The credits page (R-V4, Technical Design §7.2): every third-party component bundled into this
// build, with its licence, a link to its source and a link to the licence text itself.
//
// Generated from 3rd_party_licenses/components.json, not authored prose — which is why it is not
// one of T44's four markdown content pages and needs no locale fallback: component names,
// licence names, URLs and filenames are data. Only the page's own chrome goes through the
// message catalogue (§11).
//
// Imported directly by the router with no thin wrapper component, unlike PrivacyPage.vue and its
// siblings: those exist only to supply ContentPage.vue's `page` prop, and this takes none.
//
// A list of label/value rows rather than a table. A table of these four columns cannot fit a
// phone — the source URLs alone are wider than the viewport — so it always needed a horizontal
// scroller, on every screen size, even where there was room. This layout wraps instead, so no
// width ever produces a horizontal scrollbar.
import { operator } from '@/config/site'
import { t } from '@/i18n/t'
import {
  creditedComponents,
  licenseTextUrl,
  sourceLinkText,
  type CreditedComponent,
} from './componentsManifest'

/**
 * The licence name, with the SPDX identifier appended only when it adds something. For most
 * components the two are the same string ("MIT"), and "MIT (MIT)" is noise; the identifier
 * earns its place only where the readable name differs from it.
 */
function licenseLabel(component: CreditedComponent): string {
  const { license, licenseId } = component
  if (licenseId === null || license.includes(licenseId)) {
    return license
  }
  return `${license} (${licenseId})`
}
</script>

<template>
  <article class="credits-page">
    <h1>{{ t('credits.heading') }}</h1>
    <p class="app-license">
      <a :href="operator.sourceUrl" target="_blank" rel="noopener">{{ t('credits.appLicense') }}</a>
    </p>
    <p>{{ t('credits.intro') }}</p>

    <ul class="components">
      <li v-for="component in creditedComponents" :key="component.name" class="component">
        <h2>{{ component.name }}</h2>
        <dl>
          <dt>{{ t('credits.labelLicense') }}</dt>
          <dd>{{ licenseLabel(component) }}</dd>

          <dt>{{ t('credits.labelSource') }}</dt>
          <dd>
            <!-- The URL itself is the link text: sixteen identically-labelled "Source" links on
                 one page give a screen reader no way to tell them apart, and a URL is data that
                 needs no catalogue entry. -->
            <a :href="component.sourceUrl" target="_blank" rel="noopener">{{
              sourceLinkText(component.sourceUrl)
            }}</a>
          </dd>

          <dt>{{ t('credits.labelLicenseText') }}</dt>
          <dd class="license-files">
            <a
              v-for="file in component.files"
              :key="file"
              class="license-file"
              :href="licenseTextUrl(component, file)"
              target="_blank"
              rel="noopener"
              >{{ file }}</a
            >
          </dd>
        </dl>
      </li>
    </ul>
  </article>
</template>

<style scoped>
/* Deliberately not reusing ContentPage.vue's unscoped `.content-page` rules: those are global
   only because that component's body arrives through v-html, and borrowing them here would make
   this page's typography depend on which chunk Rollup happens to put that SFC in. */
.credits-page {
  /* SiteShell's .site-main is a column flex container and `margin-inline: auto` below opts this
     item out of cross-axis stretching, so without an explicit size it is sized by its widest
     content instead of the viewport. */
  inline-size: 100%;
  min-inline-size: 0;
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
  /* Long repository URLs must break mid-token rather than widen the page. */
  overflow-wrap: anywhere;
}

.app-license {
  font-weight: var(--font-weight-wordmark);
}

.components {
  margin: 0;
  padding: 0;
  list-style: none;
}

.component {
  padding-block: 14px;
  border-block-start: 1px solid var(--color-border-group);
}

.component h2 {
  margin-block: 0 6px;
  font-size: 15px;
  font-weight: var(--font-weight-wordmark);
}

dl {
  display: grid;
  /* The label column sizes to its own text and the value column takes the rest, so a narrow
     viewport shrinks the values (which wrap) rather than overflowing. */
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 2px 14px;
  margin: 0;
  font-size: 13px;
}

dt {
  color: var(--color-text-muted-quiet);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

dd {
  margin: 0;
  min-inline-size: 0;
  color: var(--color-primary);
}

.license-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}

.license-file {
  font-family: var(--font-family-mono);
  font-size: 12px;
}
</style>
