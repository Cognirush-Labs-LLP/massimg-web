// Minimal translation lookup + interpolation for the i18n scaffold (T08,
// docs/technical-design.md §11). The real locale list (src/config/site.ts) still ships only
// English; the 'pseudo' locale resolved here exists for testing only (T48, ./locale.ts).
//
// Interpolation syntax: single curly braces, e.g.
//   t('action.compressLabel', { count: 6 }) // -> "Compress (6)"
// for a message defined in messages.json as "Compress ({count})". Chosen as
// the simplest syntax that can't be visually confused with a JS
// template-literal `${...}` slot; it also happens to match vue-i18n's own
// named-interpolation syntax, which keeps a future migration to a real i18n
// runtime (T44) low-friction even though this module does not use vue-i18n.
//
// R-L5: a parameterised string is ONE template per sentence, authored whole
// in messages.json. Callers must never build a sentence by concatenating the
// output of two t() calls (or a t() call with other text) — that is enforced
// separately by the `local/no-translated-string-concat` ESLint rule, see
// eslint.config.js and eslint-rules/no-translated-string-concat.js.
import enMessages from './en/messages.json'
import pseudoMessages from './pseudo/messages'
import { currentLocale, type LocaleCode } from './locale'

type Messages = typeof enMessages

/** A valid message key, inferred from en/messages.json's actual keys (the canonical set). */
export type MessageKey = keyof Messages

export type InterpolationParams = Record<string, string | number>

// Widened to plain string-keyed records for runtime lookup; MessageKey (the literal union,
// derived from English) is still what callers of t() are constrained to.
const LOCALE_MESSAGES: Record<LocaleCode, Record<string, string>> = {
  en: enMessages,
  pseudo: pseudoMessages,
}

/**
 * Look up `key` in the current locale's messages.json and, if `params` is
 * given, interpolate `{name}` placeholders in the resulting string.
 *
 * Throws if the key doesn't exist, or if a placeholder in the template has
 * no matching entry in `params` — both are authoring bugs that should fail
 * loudly during development rather than render a broken string silently
 * (Functional Design P1, "silence is the failure").
 */
export function t(key: MessageKey, params?: InterpolationParams): string {
  const template = LOCALE_MESSAGES[currentLocale.value][key]
  if (template === undefined) {
    throw new Error(`i18n: no message for key "${key}"`)
  }
  if (!params) {
    return template
  }
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`i18n: missing interpolation param "${name}" for key "${key}"`)
    }
    return String(params[name])
  })
}
