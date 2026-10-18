// Current-interface-locale state (T48, docs/technical-design.md §11). A module-scope reactive
// singleton rather than a per-call parameter: t() is called bare (`t('key')`) from every component
// with no locale threaded through, so this is the same shape vue-i18n/react-intl use themselves.
// Because t() reads `currentLocale.value` during a component's render, Vue's own reactivity
// tracks it automatically — no store, no manual re-render wiring needed.
//
// 'pseudo' exists for testing only (R-L4's RTL layout-leak test) and is never added to
// src/config/site.ts's supportedLocales — that list drives real routing/hreflang/sitemap
// generation, and a pseudo-locale must never become a routed, indexed locale.
import { ref } from 'vue'

export type LocaleCode = 'en' | 'pseudo'

const RTL_LOCALES: ReadonlySet<LocaleCode> = new Set(['pseudo'])

export const currentLocale = ref<LocaleCode>('en')

export function setLocale(code: LocaleCode): void {
  currentLocale.value = code
}

export function getLocale(): LocaleCode {
  return currentLocale.value
}

export function isRtl(code: LocaleCode = currentLocale.value): boolean {
  return RTL_LOCALES.has(code)
}
