// @ts-check
import eslint from '@eslint/js'
import compat from 'eslint-plugin-compat'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'
import noTranslatedStringConcat from './eslint-rules/no-translated-string-concat.js'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'docs/**',
      '3rd_party_licenses/**',
      'verification/**',
      'playwright-report/**',
      'test-results/**',
      'src/pipeline/codecs/oxipng-wasm.generated.*',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // .vue <script setup> blocks aren't linted with a type-aware `project` (only plain .ts
      // files are), so base ESLint's no-undef can't resolve ambient DOM lib types (HTMLElement,
      // MouseEvent, ...) used in type position and false-positives on them. vue-tsc already
      // covers this correctly and authoritatively as part of `pnpm check`, run before eslint.
      'no-undef': 'off',
      // T31 (docs/task-notes/T31.md): these are the stage-mode components' and shell chrome's
      // real, eventual names, each already scoped by its own directory
      // (src/ui/gallery/Gallery.vue, src/app/shell/Header.vue, ...) — no ambiguity in context,
      // so a "GalleryGallery"-style multi-word rename buys nothing.
      'vue/multi-word-component-names': [
        'error',
        { ignores: ['Header', 'Drawer', 'Gallery', 'Preview', 'Edit', 'Processing'] },
      ],
    },
  },
  {
    // Keep the root config files (vite.config.ts, vitest.config.ts) linted as
    // plain Node/ESM TypeScript rather than app code.
    files: ['*.config.ts'],
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
      },
    },
  },
  {
    // Standalone Node CLI scripts (e.g. scripts/check-licenses.mjs) run under
    // Node, not the browser — they need Node globals, not app-code globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // Browser-compat baseline (.browserslistrc: Chrome/Edge 108+, Firefox 114+,
    // Safari/iOS 16.4+). Flags a runtime Web API the declared floor doesn't have.
    // Scoped to shipped app source only — Node scripts and config files don't run
    // in a browser, and specs exercise mocked globals, so compat checks there
    // would just be noise.
    ...compat.configs['flat/recommended'],
    files: ['src/**/*.{ts,vue}'],
    ignores: ['**/*.spec.ts'],
  },
  {
    // T08 (i18n scaffold), R-L5: fail the lint gate on runtime concatenation
    // of translated t(...) fragments. Scoped to app source only — t() isn't
    // called from scripts/, config files or tests-that-aren't-app-code.
    // See eslint-rules/no-translated-string-concat.js for exactly what this
    // does and does not catch.
    files: ['src/**/*.{ts,vue}'],
    plugins: {
      local: {
        rules: {
          'no-translated-string-concat': noTranslatedStringConcat,
        },
      },
    },
    rules: {
      'local/no-translated-string-concat': 'error',
    },
  },
  // Must be last: disables stylistic rules that would fight Prettier.
  eslintConfigPrettier,
)
