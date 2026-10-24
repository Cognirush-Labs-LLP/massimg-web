# Contributing

Thanks for working on Mass Image Compressor. This page covers what to run before you open a pull
request, and the one thing about this repository that is easy to get wrong: **not every test runs
on every operating system.**

## Where help is welcome

- **Translations.** The app is English only today.
- **More image formats**, input or output.
- **Bug fixes.**
- **Features from the desktop versions** of Mass Image Compressor.

For anything bigger than a fix, open an issue first so the idea can be agreed before you build it.

## The core principle: a simple mental model

Every feature, setting and option has to leave the user with a simple mental model of what the app
does. Before you propose one, ask whether you can explain it in a sentence, and whether it adds a
decision the user did not need to make. If it fails either test, it does not go in, however
useful it is to some people. The Functional Design's principles (`docs/functional-design.md`) are
the longer version.

## Using AI

This project is built with AI assistance, and you may use it too, to carry out a task that has
already been defined. It is engineered, not vibe-coded, and contributions that are vibe-coded are
not accepted.

You define the work. You review every line of the change. You must be able to explain and defend
it when a reviewer asks why it is the way it is, so a pull request you cannot talk through will
not be merged, whoever or whatever wrote it.

## Setting up

You need **Node 22.13 or newer** and **pnpm 11.13** (pinned in `package.json` as `packageManager`,
so `corepack` will pick the right one up for you).

```sh
pnpm install
pnpm exec playwright install --with-deps chromium firefox webkit
```

## What to run before opening a pull request

| Command                         | What it covers                                                                |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm check`                    | Types, lint, stylesheet lint, formatting                                      |
| `pnpm check:licenses`           | Every bundled component is credited (see `3rd_party_licenses/`)               |
| `pnpm test`                     | Unit tests (Vitest)                                                           |
| `pnpm test:e2e`                 | Browser tests, all three engines (Playwright)                                 |
| `pnpm build && pnpm verify:ssg` | Production build, plus the static-HTML and licence checks                     |
| `pnpm test:e2e:pwa`             | Offline/service-worker tests, against a real production build                 |
| `pnpm test:e2e:site`            | Public pages, `sitemap.xml` and `robots.txt`, against a real production build |

If you changed anything under `src/pipeline/` or `src/platform/`, run the browser tests. They are
the only thing that exercises real codecs, workers and storage.

## Platform coverage — please read this part

CI runs on **Linux**. Some of the browser tests cannot run there, and are skipped automatically:

- **Playwright's `webkit` project is not Safari.** On macOS it is built on the system WebKit and
  behaves closely enough to stand in for Safari. On Linux it is a different build on a platform
  Safari does not exist on.
- Two concrete differences break otherwise-sound tests on Linux: there is **no system share
  sheet** (`navigator.canShare({ files })` answers `false`), and **animated images render as
  blank pixels**, so per-frame content cannot be checked at all.

Twelve tests across `animation.spec.ts`, `gif.spec.ts` and `share.spec.ts` are therefore scoped to
macOS, via `skipWebKitOutsideMac()` in `tests/e2e/webkit-platform.ts`. Two more keep running
everywhere with a platform-aware expectation. None of this is a statement about the application —
it is a statement about where the test can observe the truth.

**What this means for you:** a green run on Linux or Windows has _not_ exercised the Safari-shaped
behaviour — animated WebP/PNG/GIF frame output, and the Web Share path. Those paths are only
really tested when someone runs the suite on a Mac.

So we need to know which you did. That is not a judgement on your machine; it tells a reviewer how
much the green tick is worth, and whether someone else needs to run it on a Mac before merging.

## A green test run is not the whole proof

Passing automated tests do not show that the application works. Several things are not covered
at all, or only on a Mac: the Web Share path on a real device, animated frame output in Safari,
Firefox's handling of "Download and leave", and anything on a real iPhone or a low-memory phone.
`docs/backlog.md` (BL-017 and the entries around it) lists what has not been checked.

If your change touches delivery, sharing, animation or storage, run it by hand in a real browser,
say what you did, and say what you could not check.

## Raising a pull request

Fill in the pull-request template. It asks, and **this is required**:

- which commands you ran, and
- **the operating system you ran them on.**

A pull request that does not say which OS the tests ran on will be asked for it before review. If
you could not run part of the suite — no Mac, no browsers installed, a flaky local machine — say
so plainly. An honest "ran unit tests on Linux only, could not run WebKit" is far more useful than
silence, and nobody will hold it against you; a reviewer with a Mac can cover the rest.

Keep commit messages in the form `docs/commit-guide.md` describes.

## If a test fails and you think it is wrong

It might be. This suite has had tests drift behind the application before. But check in this order:

1. Does it fail on `main` too? If so, it is not yours.
2. Does it fail only on one engine, or only on one OS? That is usually a platform difference like
   the ones above, not a bug in your change.
3. Does it fail only in a full parallel run, and pass when run alone? That is usually memory
   pressure on the machine, not a real failure.

Say which of these you checked in the pull request. Do not weaken or delete an assertion to get a
green tick without saying why in the description — if an assertion is genuinely stale, explain what
changed and when, so the reviewer can agree it is stale rather than take it on trust.

## Forking

You are welcome to run your own copy under the AGPL. To make it yours and not ours:

- **Contact points.** Edit the `operator` block in `src/config/site.ts`: legal name, support email,
  source URL and desktop download URL. The footer, the credits page and the FAQ, Privacy and
  Terms pages read it. Point the source URL at your own repository; if you modify the app and
  serve it over a network, the AGPL requires you to offer your users your source.
- **Legal text.** Rewrite `content/en/privacy.md` and `content/en/terms.md` for your deployment.
  Sections 10 and 11 of the Terms name Cognirush Labs LLP as the original author and are
  deliberately not substituted; adapt them and keep the credit `NOTICE.txt` asks for.
- **Branding.** The site name in `src/config/site.ts`, the title in `index.html`, the name in
  `public/manifest.json` and the icons in `public/icons/`. Our name, logo and branding are not
  licensed for your use (`NOTICE.txt`).
- **Deployment values.** `VITE_SITE_BASE_URL`; see `.env.example`.
- **Analytics.** The code carries none. We switch on Cloudflare Web Analytics for our domain in
  the Cloudflare dashboard, which injects the script at the edge. A fork gets no analytics unless
  you do the same, or add a script of your own. If you add one, update the analytics sentence in
  `content/en/privacy.md` and `gallery.emptyState.privacyAnalytics` in `src/i18n/en/messages.json`.
- **README.md** and the Cognirush links in it.
