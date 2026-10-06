import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './renderMarkdown'

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, lists and links as HTML', () => {
    const html = renderMarkdown(
      '# Title\n\nA paragraph with a [link](https://example.com).\n\n- one\n- two',
    )

    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<a href="https://example.com">link</a>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<li>two</li>')
  })

  it('does not pass raw HTML through, so v-html stays safe for authored content', () => {
    const html = renderMarkdown('<script>alert(1)</script>')

    expect(html).not.toContain('<script>')
  })
})
