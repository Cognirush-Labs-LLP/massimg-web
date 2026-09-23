// @ts-check
import eslint from '@eslint/js'
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
        process: 'readonly',
      },
    },
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
