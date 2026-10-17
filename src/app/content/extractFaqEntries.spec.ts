import { describe, expect, it } from 'vitest'
import { extractFaqEntries } from './extractFaqEntries'
import { loadRawContent } from './content'

describe('extractFaqEntries', () => {
  it('extracts a bold-question/plain-text-answer pair from one paragraph', () => {
    const entries = extractFaqEntries('**What does this tool do?**\nIt shrinks your images.')

    expect(entries).toEqual([{ question: 'What does this tool do?', answer: 'It shrinks your images.' }])
  })

  it('extracts multiple entries across separate paragraphs and category headings', () => {
    const markdown = [
      '## 1. Category',
      '',
      'Intro prose that is not a question.',
      '',
      '**First question?**',
      'First answer.',
      '',
      '**Second question?**',
      'Second answer.',
    ].join('\n')

    expect(extractFaqEntries(markdown)).toEqual([
      { question: 'First question?', answer: 'First answer.' },
      { question: 'Second question?', answer: 'Second answer.' },
    ])
  })

  it('skips a bold paragraph that is not phrased as a question', () => {
    const entries = extractFaqEntries('**Not a question.**\nSome text.')

    expect(entries).toEqual([])
  })

  it('skips a plain paragraph with no leading bold run', () => {
    const entries = extractFaqEntries('Just a sentence, no bold lead-in.')

    expect(entries).toEqual([])
  })

  it('still finds the text answer when the answer itself contains inline formatting', () => {
    const entries = extractFaqEntries('**Formatted?**\nSee the *desktop* app for more.')

    expect(entries).toEqual([{ question: 'Formatted?', answer: 'See the desktop app for more.' }])
  })

  it('extracts a large, non-empty, well-formed set from the real FAQ content (drift guard)', () => {
    const entries = extractFaqEntries(loadRawContent('en', 'faq'))

    expect(entries.length).toBeGreaterThan(20)
    for (const entry of entries) {
      expect(entry.question.endsWith('?')).toBe(true)
      expect(entry.answer.length).toBeGreaterThan(0)
    }
    expect(entries[0]).toEqual({
      question: 'What does this tool do?',
      answer:
        'It shrinks the file size of your images — and can convert them to a different format, resize them, rotate them or crop them — without uploading anything anywhere.',
    })
  })
})
