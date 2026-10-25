# Terms of Service

**The short version:**

- **This is best-effort software, not a guarantee.** It can have bugs, and you should always look
  at the result before you rely on it or delete your originals.
- **We try to make files smaller, but we can't always do it.** Some images already can't be
  compressed further, and in those cases we keep your original rather than forcing a worse result.
  Operations you explicitly ask for — like changing dimensions or converting format — can sometimes
  make a file *larger* than it started.
- **Format and browser support has real limits.** What you can open and save depends on the
  compression libraries we bundle and on what your specific browser can run. We list below what's
  supported in principle; what you actually see in the app may be narrower.
- **Animation can get lost.** We try to keep animated images animated, and to tell you when we
  can't, but detection isn't perfect — check animated results before you rely on them.
- **Metadata (EXIF, GPS, etc.) isn't guaranteed either way.** We normally strip it; in some cases
  we leave a file untouched and whatever metadata it already had — including location data —
  stays in it. Check before you share.
- **Keep your originals.** Compression is a one-way trade between file size and the data that makes
  up the image; some of that data is gone for good afterwards. We never touch your only copy for
  you — but you should still keep a backup somewhere you control.
- **The name "Mass Image Compressor" and its logo belong to us; the code is open source.** You can
  read it, run it and redistribute it under its license, with a couple of conditions explained
  below.

*Last updated: 25 October 2026*

## 1. Scope and acceptance of these terms

These Terms of Service govern your use of this website and the Mass Image Compressor web
application served from it (together, the "App"), provided by {{legalName}} ("we", "us",
"our"). By opening and using the App you accept these terms. If you don't agree with them, please
don't use the App.

This page covers the web version specifically. If you also use our desktop versions of Mass Image
Compressor (macOS or Windows), those are governed by their own terms, published on their own
product pages.

## 2. License to use this application

We grant you a non-exclusive, non-transferable, revocable license to use the App for personal or
business purposes, subject to these terms. You may not use the App for any unlawful purpose, or
attempt to interfere with, disassemble, or circumvent how it runs in your browser.

Because the App runs entirely client-side, there is nothing to install and no account to maintain
— using it is simply opening the page. See our [Privacy Policy](/privacy) for what little data
that involves.

## 3. Supported file formats

The App can open and process:

- **JPEG**
- **PNG**, including animated PNG
- **WebP**, still and animated
- **GIF**, still and animated
- **AVIF**, still images only — animated AVIF files aren't accepted
- **HEIC / HEIF** (the format most phone cameras use)
- **BMP, TIFF, JPEG XL and JPEG 2000**

The App can save output as:

- **JPEG** (no transparency, no animation)
- **PNG**, still or animated
- **WebP**, still or animated
- **AVIF**, still images only
- **GIF**, suited to simple graphics and animation rather than photographs
- or **unchanged**, keeping the original file's format — except for the formats below, which we
  can't write back out at all

HEIC/HEIF, BMP, TIFF, JPEG XL and JPEG 2000 can be opened and compressed, but we can't write output
back into those formats. If you choose "unchanged" for one of these, the App saves the result as
JPEG instead, and the file name and on-screen details reflect that actual output format.

This support is not unconditional. It depends on the compression libraries we bundle into the App
and on what your browser is able to run them on. We aim to only offer a format in the App when the
browser you're using can actually handle it, but coverage varies across browsers, browser versions
and operating systems, and some features may not be available to you at all for that reason.
Libraries we rely on are also updated over time, which can change what's supported from one version
of the App to the next.

## 4. No warranty — the software may have bugs

The App is provided "as is" and "as available," without warranties of any kind, express or
implied, including as to merchantability, fitness for a particular purpose, or non-infringement.
Image processing software is inherently complex, and the App may contain bugs, may behave
unexpectedly on specific files, or may produce an incorrect result without any error being shown.

**You are responsible for checking the output before you use, publish or rely on it, and before
you discard the original.** We do not guarantee the App's output is correct, complete, or suitable
for your purpose.

## 5. Compression results and file size

The App tries to reduce file size while preserving the perceived quality of your images, but this
isn't always possible:

- Many images — especially ones that are already well-compressed — may not shrink any further no
  matter what we try. In that situation, we keep your original file rather than forcing a worse or
  larger result on you.
- Operations you deliberately choose, such as changing dimensions, rotating, cropping or converting
  to a different format, are honored even when the result ends up **larger** than the input. A
  format conversion you asked for is not a compression failure, even if the new file is bigger.
- Some encoding modes (for example, lossless AVIF) are frequently larger than the source file by
  their nature; choosing them does not guarantee a size reduction.

We make reasonable efforts to flag unusual outcomes — such as a file getting bigger, or a size
target that couldn't be met — in the App's own interface, but you should always check the actual
output before relying on it.

## 6. Animated images

The App supports animated input and can produce animated output for the formats listed in Section
3. However, animation can be lost or altered in certain circumstances:

- the output format you chose doesn't support multiple frames (for example, JPEG or still AVIF);
- the underlying compression library doesn't reliably support animation for that combination of
  input and output; or
- the App fails to recognize that a given file is animated in the first place.

Where we can detect one of these situations, we try to tell you — for example, by substituting an
animation-capable format automatically, or by showing a message in the interface. **This indication
is best-effort and can be missed**, particularly when the App fails to recognize an input file as
animated at all. Always check an animated result yourself before you rely on it or discard the
original.

## 7. Metadata and EXIF data

Photo files can carry metadata such as EXIF, IPTC or XMP data — including camera settings, and
potentially GPS location. By default, when the App re-encodes an image, it strips this metadata
from the output (we keep the embedded color profile separately, so colors still render correctly).

That said, **we make no guarantee about what metadata ends up in your output file, in either
direction.** In particular, if an image doesn't need to be re-encoded at all — for instance, it
already meets your size target and needs no other change — the App may keep the original file
essentially untouched, in which case whatever metadata the original carried, including private or
location data, is preserved along with it. You must verify a file's metadata yourself before
sharing it if that matters to you.

## 8. Data loss and backups

Lossy image compression works by discarding information from the original file; that is its
nature, not a defect. Our aim is to preserve how an image *looks* while reducing its size, not to
preserve every original byte. Once that information is gone, it generally cannot be recovered.

The App does not delete or modify your original files on its own, but **you are solely responsible
for keeping a safe copy of anything you can't afford to lose**, independent of the App, before you
process it.

The App temporarily stores selected-image copies and processing results in your browser on your
device. Its cleanup actions and automatic abandoned-session cleanup are best effort. Browser
behavior, errors, crashes, or interruptions may leave temporary data behind; we do not guarantee
immediate, complete, or secure deletion. You can clear this site's data using your browser settings,
but the App does not provide a secure-erasure service. See our [Privacy Policy](/privacy) for the
storage and cleanup behavior.

Wait until downloading or sharing has finished before clearing temporary data. The App cannot
confirm that a browser or receiving app has finished reading the files. Cleanup does not delete your
original files or copies already saved or received outside the App.

## 9. Changes to the software and these terms

We may update the App — including its features, supported formats and behavior — at any time, and
may revise these Terms of Service at any time, in either case without advance notice. Because the
App has no accounts and we don't collect contact details from using it, we have no way to notify
you individually. The date at the top of this page always reflects its latest revision; continued
use of the App after a change constitutes acceptance of the terms as revised.

## 10. Intellectual property

"Mass Image Compressor," its associated logo, and the App's design and branding are the
intellectual property of Cognirush Labs LLP. Nothing in these terms grants you rights to our name,
logo or branding beyond what's needed to refer to the App itself.

## 11. Open source license and redistribution

The App's [source code is public]({{sourceUrl}}), licensed
under the GNU Affero General Public License v3.0 (AGPL v3). You're welcome to read it, run your own
copy, and redistribute or modify it under that license's terms.

If you redistribute a modified copy of the App to the public, you must do at least one of the
following:

- not present it as, or distribute it alongside, Cognirush Labs LLP's own support contact
  (support@cognirush.com) or other official branding, since we can't provide support for a build we
  didn't ship; or
- clearly indicate that your copy has been modified and is distributed independently of Cognirush
  Labs LLP, so users aren't misled into thinking it's our official, unmodified build.

## 12. Feedback and support submissions

If you send us feedback, bug reports, feature ideas or sample files — whether by email or through
our public issue tracker — you do so knowing we may use, modify or implement that feedback freely,
without owing you credit, compensation, or any license back. You retain ownership of what you send
us, but you're not entitled to claim intellectual property rights, credit or payment for an idea or
suggestion we end up building, even if it closely resembles what you proposed.

Images or other files you send to {{supportEmail}} are handled as described in our
[Privacy Policy](/privacy). If you submit feedback or files through another platform instead — for
example, by opening an issue on GitHub — that platform's own privacy policy governs that
submission, not ours.

## 13. Limitation of liability

To the maximum extent permitted by law, {{legalName}} will not be liable for any indirect,
incidental, special, consequential or punitive damages, or any loss of data, images, profits or
goodwill, arising from or related to your use of, or inability to use, the App — even if we have
been advised of the possibility of such damages.

## 14. Governing law

These terms are governed by the laws of India, and any dispute arising under them is subject to the
exclusive jurisdiction of the courts of Bengaluru, Karnataka.

## 15. Contact us

Questions about these terms are welcome at:

**Email:** {{supportEmail}}

**Address:** F-402, MJR Pearl, Opp Whitefield Metro, Kadugodi, Bengaluru, Karnataka, India
