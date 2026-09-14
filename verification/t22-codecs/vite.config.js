import { defineConfig } from 'vite'

// No plugins, no aliases: this harness has no app source tree of its own (see src/harness.js's
// header comment) — just the six codec packages, resolved from this project's own node_modules.
export default defineConfig({})
