# Mass Image Compressor (Web)

This is source repository for online compressor hosted at https://massimg.com (MassImg.com)

A clean, safe image compressor that runs entirely in your browser. Your images are never uploaded,
there is no account, and the output is high quality.

It complements popular desktop based [Mass Image Compressor](https://mic.cognirush.com/download/) for Windows and macOS.
Use this web version when you are dealing with fewer images, and the desktop app for big jobs.

| Need                                        | Web (this project) | Desktop App |
| ------------------------------------------- | ------------------ | ----------- |
| Nothing to install                          | Yes                | No          |
| Reduce an image to a given output size      | Yes                | No          |
| Edit an image: rotate, crop                 | Yes                | No          |
| Share finished images to other apps         | Yes                | No          |
| Very large batches                          | No                 | Yes         |
| Very large files                            | No                 | Yes         |
| Extra input formats (camera formats mainly) | No                 | Yes         |
| Output file renaming                        | No                 | Yes         |
| Powerful file selection filters             | No                 | Yes         |
| Faster compression                          | No                 | Yes         |
| Replace the original files                  | No                 | Yes         |
| Watermark Images                            | No                 | Yes         |

## What this does

- Drag and drop many images, or an entire folder. The folder structure is kept in the download.
- Set one size target, one dimension rule and one output format for the whole batch.
- Compare before and after in a preview, and rotate or crop a single image.
- Keeps animated GIF, WebP and PNG animated.
- Download one file for one image, or a ZIP for many. Share finished images where your device
  supports it.
- Installable as a PWA, and works offline after the first visit.

## Formats

| Format                        | Input | Output | Notes                                                                                                                    |
| ----------------------------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| JPEG                          | Yes   | Yes    |                                                                                                                          |
| PNG                           | Yes   | Yes    | Animated PNG is kept animated and written as `.png`.                                                                     |
| WebP                          | Yes   | Yes    | Still and animated.                                                                                                      |
| AVIF                          | Yes   | Yes    | Still only. Animated AVIF is rejected, not flattened.                                                                    |
| GIF                           | Yes   | Yes    | Still and animated. In Safari, about 1 job in 80 comes out larger (a bug, that rarely makes a gif larger than expected). |
| BMP, TIFF, JPEG XL, JPEG 2000 | Yes   | No     | Written as JPEG when the format is "Don't change".                                                                       |
| HEIC / HEIF                   | Yes   | No     | Written as JPEG when the format is "Don't change".                                                                       |

Browser and platform notes:

- Tested on Chrome, Edge and Firefox on Windows, Chrome and Firefox on Linux, and Chrome, Firefox
  and Safari on a Mac, plus Chrome on one Android phone. iPhone and iPad are untested.
- Share needs your system to accept files from the browser. On Windows, pick an app from the list;
  the share window's Copy button does not copy the images.
- On Firefox, "Download and leave" can occasionally deliver nothing. Use the plain Download button.
- Firefox and Safari private windows have no on-device temporary storage, so the app keeps data in
  memory for the run instead.

## How it is built

AI tools were used to write this software. It is engineered, not vibe-coded: human define each
piece of work, review (almost) every change, and are accountable for it. Contributions that are
vibe-coded are not accepted. [CONTRIBUTING.md](CONTRIBUTING.md) explains what that means in
practice.

## Built on open source

This project stands on open source work: image codecs, the ImageMagick WebAssembly build, the
web framework and more. Every bundled component, with its license and a link to its source, is
listed on the [credits page](https://massimg.com/credits). The license texts are in
[`3rd_party_licenses/`](3rd_party_licenses).

## Run it, contribute, license

```sh
pnpm install
pnpm dev
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Licensed under the GNU
Affero General Public License v3.0; see [LICENSE](LICENSE) and [NOTICE.txt](NOTICE.txt).
