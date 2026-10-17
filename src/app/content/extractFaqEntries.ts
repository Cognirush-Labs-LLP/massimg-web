import MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'

export interface FaqEntry {
  question: string
  answer: string
}

// Same no-HTML parser renderMarkdown.ts uses — this module only walks the token stream, never
// renders HTML, so the two stay independent of each other's configuration.
const md = new MarkdownIt({ html: false })

function collectStrongText(children: Token[], start: number): { text: string; next: number } {
  let text = ''
  let i = start
  while (i < children.length && children[i]?.type !== 'strong_close') {
    text += children[i]?.content ?? ''
    i++
  }
  return { text, next: i + 1 } // +1 to step past strong_close
}

function collectAnswerText(children: Token[], start: number): string {
  let answer = ''
  for (let i = start; i < children.length; i++) {
    const child = children[i]
    if (!child) continue
    if (child.type === 'softbreak' || child.type === 'hardbreak') {
      answer += ' '
    } else if (child.type === 'text' || child.type === 'code_inline') {
      answer += child.content
    }
    // Other inline tokens (emphasis/link open/close etc.) are skipped; their own text/code_inline
    // children still contribute their content above, just without the original formatting.
  }
  return answer.trim()
}

/**
 * Extracts {question, answer} pairs from a FAQ markdown document for FAQPage JSON-LD (R-S7).
 *
 * content/en/faq.md's established authoring pattern is one paragraph per entry: a bold question
 * ending in "?", a soft line break, then the plain-text answer — never a separate heading per
 * question (the ## headings are category groupings, not individual Q&A). This walks the same
 * markdown-it token stream renderMarkdown.ts renders from, rather than hand-duplicating the FAQ
 * text into a second, driftable copy (AGENTS.md: content/en/faq.md is the one source of truth).
 * A paragraph that doesn't match the pattern (category intros, the closing bullet list) is
 * silently skipped rather than treated as an error — this is a best-effort structured-data
 * courtesy (R-S10's spirit), not a strict parser the FAQ's prose must conform to.
 */
export function extractFaqEntries(raw: string): FaqEntry[] {
  const tokens = md.parse(raw, {})
  const entries: FaqEntry[] = []

  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) {
      continue
    }
    const children = token.children
    // markdown-it emits a leading empty `text` token before the first real inline token — skip
    // past any such empty text so a paragraph that genuinely starts with bold still matches.
    let leadIndex = 0
    while (children[leadIndex]?.type === 'text' && children[leadIndex]?.content === '') {
      leadIndex++
    }
    const first = children[leadIndex]
    if (!first || first.type !== 'strong_open') {
      continue
    }

    const { text: question, next } = collectStrongText(children, leadIndex + 1)
    if (!question.trim().endsWith('?')) {
      continue
    }

    const answer = collectAnswerText(children, next)
    if (answer) {
      entries.push({ question: question.trim(), answer })
    }
  }

  return entries
}
