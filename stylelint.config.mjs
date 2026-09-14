// Stylelint config (T07). Two jobs:
//   1. `stylelint-config-recommended` — baseline correctness rules (no
//      stylistic/formatting rules, so this doesn't fight Prettier, which
//      already formats .css files and .vue <style> blocks).
//   2. `stylelint-use-logical-spec` — fails the build on physical-direction
//      properties (`left`, `right`, `margin-left`, `padding-right`, `top`,
//      `bottom`, physical `border-*-*-radius`, ...) anywhere they appear as
//      layout, per Technical Design §11 / R-L4 ("logical properties
//      throughout... the side panel and drawer are on the inline-end side,
//      not the right").
//
// See docs/task-notes/T07.md for why this plugin (over hand-rolled
// `declaration-property-value-disallowed-list` rules) and why stylelint is
// pinned to the 16.x line.
export default {
  extends: ['stylelint-config-recommended'],
  plugins: ['stylelint-use-logical-spec'],
  overrides: [
    {
      files: ['**/*.vue'],
      customSyntax: 'postcss-html',
    },
  ],
  rules: {
    'liberty/use-logical-spec': 'always',
  },
  ignoreFiles: [
    'dist/**',
    'coverage/**',
    'docs/**',
    '3rd_party_licenses/**',
    'verification/**',
    'playwright-report/**',
    'test-results/**',
    'node_modules/**',
  ],
}
