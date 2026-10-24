# Deploying to Hostinger

> **This is the massimg.com deployment, not a general guide.** It records how Cognirush hosts the
> site: Hostinger shared hosting (LiteSpeed), a Cloudflare proxy in front, and the
> `https://massimg.com` canonical URL. A fork should not follow it as written. What carries over is
> `public/.htaccess` and `scripts/verify-deploy.mjs`, which suit any Apache-compatible host that
> allows `.htaccess`. Set `VITE_SITE_BASE_URL` to your own URL, and drop or replace the Hostinger
> and Cloudflare steps in section 3 with your host's equivalents.

The site is static files. There is no server process, no PHP and no database. `public/.htaccess`
is copied into `dist/` by the build and carries every server rule (Technical Design §12).

## 1. Build

```sh
VITE_SITE_BASE_URL=https://massimg.com pnpm build
pnpm verify:ssg
```

`VITE_SITE_BASE_URL` has to be in the shell environment, not only in `.env`: the sitemap and
`robots.txt` script reads `process.env` alone (BL-015). Without it the canonical tags, sitemap and
`robots.txt` carry the `.invalid` placeholder. After the build, `grep -c massimg.com
dist/sitemap.xml dist/robots.txt` must be non-zero.

## 2. Upload

Upload the **contents** of `dist/` into the site's `public_html/`, so `index.html` and `.htaccess`
sit directly in it. Skip `dist/.vite/` (build bookkeeping, never needed).

- **`.htaccess` is a hidden file.** Turn on "show hidden files" in the FTP client or it is skipped
  without a message, and the site then serves with none of the rules below.
- Delete Hostinger's placeholder `public_html/default.php`, if present.
- Replace the old release as a whole: hashed filenames mean old `assets/` files are unreferenced
  after an upload, and the new `index.html` must arrive together with the new `assets/`. Upload
  `assets/` first and `*.html`, `sw.js` and `registerSW.js` last.

## 3. Hostinger and Cloudflare settings

- hPanel, Websites, Security (or SSL): SSL installed and **Force HTTPS** on. The redirect lives
  there rather than in `.htaccess` because a rewrite-based redirect behind Cloudflare's proxy can
  loop.
- Cloudflare, SSL/TLS: mode **Full (strict)**. "Flexible" talks plain HTTP to Hostinger and loops
  against Force HTTPS.
- Cloudflare, Web Analytics: Real User Measurements set to Enable for the hostname (T51-A).

## 4. Verify

```sh
pnpm verify:deploy https://massimg.com
```

Run it from the checkout that produced the uploaded build, since it picks hashed file names from
the local `dist/assets/`. It fetches the live headers and fails if any rule was ignored: ETag and
304 revalidation, no-cache on HTML and `sw.js`, one-year immutable caching on hashed assets,
`application/wasm`, compression, `text/plain` licence texts, `.php` refused, dotfiles refused,
an unknown address answering 404 with the not-found page, `/faq/` redirecting to `/faq`,
`http://` redirecting to `https://`.

## What the rules do

| Rule                                   | Why                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `.php`, `.phtml`, `.phar` answer 403   | Nothing here is PHP. A rewrite refuses it on any PHP setup; `php_flag engine off` would 500 outside mod_php.           |
| `/faq.html` and `/faq/` redirect to `/faq`        | vite-ssg writes `faq.html`; the sitemap and canonical tags use the extensionless URL.                                   |
| `ErrorDocument 404 /404.html`          | The app builds `404.html` (`NotFoundPage.vue`); an unknown address gets it with a real 404 status.                      |
| `FileETag MTime Size`                  | Apache's default ETag includes the inode, which changes on re-upload and would invalidate every visitor's cache.        |
| `RequestHeader edit If-None-Match`     | mod_deflate suffixes ETags with `-gzip` and then fails to match them; without this a compressed file is never a 304.    |
| `Cache-Control: no-cache`              | Everything revalidates by ETag (a 304 costs bytes of header, not the file), so a release shows up on the next load.     |
| `max-age=31536000, immutable`          | For `<name>-<8 hash chars>.js/css/wasm` only. The 14 MB ImageMagick WASM is fetched once per release.                  |
| `application/wasm`                     | Required for streaming WebAssembly compilation.                                                                         |
| `3rd_party_licenses/` as `text/plain`  | Extensionless licence files would otherwise download instead of display.                                                |
| No `no-transform`                      | Cloudflare does not inject its analytics script into responses that carry it (§12.6).                                   |

## COOP and COEP are not set

T52 asks to verify cross-origin isolation. No shipped code can use it: oxipng is bundled
single-threaded only (B6), and `crossOriginIsolated` is read but never acted on. Setting
`Cross-Origin-Embedder-Policy: require-corp` would add risk for no gain, because it blocks any
cross-origin subresource that does not opt in, and Cloudflare's injected analytics script is one.
If a threaded codec is ever reintroduced, add both headers, and re-test the analytics script.
