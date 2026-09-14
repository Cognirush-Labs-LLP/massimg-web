import { fileURLToPath } from 'node:url'

import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config.ts'

// Vitest merges into the real Vite config rather than redeclaring resolution,
// so module resolution (the "@" alias, in particular) is identical to what
// `vite build` uses. See docs/task-notes/T04.md.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      exclude: [...configDefaults.exclude, 'verification/**', 'tests/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
    },
  }),
)
