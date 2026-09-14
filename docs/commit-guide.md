# Git Commit Message Guide

Use short, clear commit messages that describe what the commit does.

## Format

```text
type: Short description
```

Examples:

```text
feat: Add AVIF output support
fix: Fix crash when processing large PNG files
docs: Update installation instructions
refactor: Simplify image processing pipeline
test: Add tests for WebP conversion
chore: Update dependencies
```

## Commit Types

| Type       | Use for                                                     |
| ---------- | ----------------------------------------------------------- |
| `feat`     | New feature or functionality                                |
| `fix`      | Bug fix                                                     |
| `docs`     | Documentation-only changes                                  |
| `refactor` | Code changes that do not add features or fix bugs           |
| `test`     | Adding or updating tests                                    |
| `chore`    | Housekeeping, dependencies, tooling, cleanup, build changes |

## Guidelines

- Write the description in **imperative form**: `Add`, `Fix`, `Remove`, `Update`, `Improve`.
- Keep the first line short and descriptive, preferably under 72 characters.
- Do not end the subject line with a period.
- Keep each commit focused on one logical change.
- Explain **what changed**, not what you personally did.
- Add a longer description after a blank line when the reason for the change is not obvious.
- Reference an issue when useful, for example `Fixes #123`.

## Example With Details

```text
fix: Limit image processing to four workers

Running more workers significantly increases browser memory usage without
providing enough improvement in throughput.

Fixes #123
```
