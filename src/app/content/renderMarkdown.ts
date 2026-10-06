import MarkdownIt from 'markdown-it'

// `html: false`: content files are authored prose, not a place for arbitrary HTML — keeping
// the parser's HTML passthrough off means `renderMarkdown`'s output is safe to use with
// `v-html` without a separate sanitisation step.
const md = new MarkdownIt({ html: false })

/** Pure function wrapper so markdown rendering is unit-testable without mounting a component. */
export function renderMarkdown(raw: string): string {
  return md.render(raw)
}
