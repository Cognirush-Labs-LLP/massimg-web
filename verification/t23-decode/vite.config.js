import { defineConfig } from 'vite'

// No plugins and no aliases: this harness has its own copies of the codec packages and no app
// source tree, the same shape as verification/t22-codecs. The one piece of *shipped* code it uses —
// pipeline/stages/colour.ts — is loaded by run.mjs through a separate Vite server rooted at the
// repository, so that A13's finding is checked against the module that ships rather than a copy.
export default defineConfig({})
