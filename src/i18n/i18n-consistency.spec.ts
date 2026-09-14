// The CI check required by docs/technical-design.md §11: "A CI check fails
// when a key exists in messages.json without an entry in context.json"
// (R-L2). Implemented as a Vitest test rather than a standalone script (the
// precedent set by T06's scripts/check-licenses.mjs is for a different kind
// of thing — repo/licence-completeness auditing — whereas this is a fast,
// pure check over two JSON files, which fits Vitest's existing `pnpm test`
// gate directly and runs in CI's "unit" job with no new wiring needed).
//
// Enforced in both directions:
//   - every messages.json key has a context.json entry (the direction the
//     task brief names explicitly, R-L2's actual requirement).
//   - every context.json entry has a matching messages.json key (the
//     reverse). Not required by R-L2 in so many words, but cheap to check
//     and catches a real failure mode: a key renamed or removed from
//     messages.json whose stale context.json entry is left behind, silently
//     describing a string that no longer exists.
//
// Hardcoded to the "en" locale directory, deliberately mirroring t.ts's own
// "only English exists right now" scope decision (see t.ts) rather than
// scanning src/i18n/ for locale directories at runtime — that would need
// either Node's fs (unavailable: tsconfig.app.json, which covers this file,
// has no "node" types/lib, only "vite/client", since it's the browser-app
// project) or import.meta.glob path-parsing gymnastics, for a payoff (a
// second locale) that doesn't exist yet. When a real second locale is added,
// generalise this file and t.ts's locale plumbing together rather than
// solving multi-locale discovery here first.
import { describe, expect, it } from 'vitest'
import messages from './en/messages.json'
import context from './en/context.json'

describe('i18n locale "en"', () => {
  it('has a context.json entry for every messages.json key (R-L2)', () => {
    const missing = Object.keys(messages).filter((key) => !(key in context))
    expect(missing, `messages.json keys with no context.json entry: ${missing.join(', ')}`).toEqual(
      [],
    )
  })

  it('has no orphaned context.json entry without a matching messages.json key', () => {
    const orphaned = Object.keys(context).filter((key) => !(key in messages))
    expect(
      orphaned,
      `context.json keys with no matching messages.json entry: ${orphaned.join(', ')}`,
    ).toEqual([])
  })
})
