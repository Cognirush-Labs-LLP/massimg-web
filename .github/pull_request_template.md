## What this changes

<!-- One or two sentences. Link the task or issue if there is one. -->

## How it was tested

<!-- Tick what you ran. Leave unticked what you did not — that is useful information, not a gap to hide. -->

- [ ] `pnpm check`
- [ ] `pnpm test` (unit)
- [ ] `pnpm test:e2e` (browser — Chromium / Firefox / WebKit)
- [ ] `pnpm build && pnpm verify:ssg`
- [ ] `pnpm test:e2e:pwa`

**Operating system the tests ran on:** <!-- REQUIRED: macOS / Linux / Windows, and the version -->

> Why this is required: CI runs on Linux, where Playwright's WebKit is not Safari. Twelve browser
> tests covering animated-image frame output and the Web Share path are skipped there, so a green
> Linux run has not exercised them. A reviewer needs to know whether anyone ran this on a Mac.
> See [CONTRIBUTING.md](../CONTRIBUTING.md#platform-coverage--please-read-this-part).

<!-- If you could not run something — no Mac, browsers not installed, flaky machine — say so here.
     That is expected and fine; it just tells a reviewer what still needs covering. -->

## Anything a reviewer should look at closely

<!-- Known gaps, judgement calls, assertions you changed and why. -->
