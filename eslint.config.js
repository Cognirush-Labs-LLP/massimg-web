// @ts-check
import eslint from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

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
  // Must be last: disables stylistic rules that would fight Prettier.
  eslintConfigPrettier,
)
