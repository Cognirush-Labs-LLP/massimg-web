// Playwright's `webkit` project is not Safari, and how far it is from Safari depends on the
// operating system it runs on.
//
// On macOS it is built on the system's own WebKit and is close enough that a handful of tests
// can assert real Safari behaviour against it. On Linux — which is what CI runs — the same
// project is a different build on a platform Safari does not exist on. Two differences break
// tests that are otherwise sound:
//
//   - **No system share sheet.** `navigator.canShare({ files })` answers `false`, where macOS
//     answers `true` (T39-A's finding for real desktop Safari).
//   - **Animated images render blank.** Frames decode, but every pixel reads back as
//     `0,0,0,0` instead of the written colour, so per-frame content cannot be checked at all.
//
// Neither is a fact about this application, so tests that depend on them are scoped to macOS
// rather than deleted or weakened — they still run, and still catch regressions, wherever a
// contributor runs the suite on a Mac. AGENTS.md's pull-request checklist asks contributors to
// say which platform they ran on, because a Linux-only run genuinely does not exercise them.
//
// This file deliberately does not end in `.spec.ts`, so Playwright does not collect it as a test.

import { test } from '@playwright/test'

/**
 * True only where Playwright's WebKit stands in for Safari: the `webkit` project, on macOS.
 *
 * Use this for an *expectation* that differs by platform, where the rest of the test is still
 * worth running on Linux.
 */
export function isSafariLikeWebKit(projectName: string): boolean {
  return projectName === 'webkit' && process.platform === 'darwin'
}

/**
 * Skips the current test when it is running under WebKit anywhere but macOS.
 *
 * Use this where the test cannot run at all off a Mac, rather than merely expecting something
 * different. Call it inside a test body, with a reason naming the platform difference.
 */
export function skipWebKitOutsideMac(projectName: string, reason: string): void {
  test.skip(
    projectName === 'webkit' && process.platform !== 'darwin',
    `${reason} (Playwright's WebKit is only Safari-like on macOS; see tests/e2e/webkit-platform.ts)`,
  )
}
