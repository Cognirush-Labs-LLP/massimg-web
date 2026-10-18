# Frequently Asked Questions

This tool compresses and converts your images — one at a time or in large batches — entirely inside your browser. There's nothing to install and nothing to sign up for; you open the page, add your images, and download the result.

This FAQ describes how the app behaves right now, while it's still being built. A few answers below say a feature or a fine detail isn't finished yet — that's intentional honesty, not an oversight.

## 1. What is this app?

**What does this tool do?**
It shrinks the file size of your images — and can convert them to a different format, resize them, rotate them or crop them — without uploading anything anywhere.

**Do I need to install anything or create an account?**
No. It runs in your browser, and there's no sign-up, no login and no history saved between visits.

**Is there a desktop version too?**
Yes, a separate [desktop application](/desktop) exists for people who need to process very large batches or very large files without any browser limits. This web tool is meant to be independently useful on its own for quick, everyday compression.

## 2. Privacy

**Do my images ever leave my device?**
Not unless you send them somewhere yourself. Every image is decoded, edited and compressed locally in your browser, and nothing is ever uploaded to a server. The only way a result leaves your device is if you press Share on a finished batch and pick an app or destination to hand the images to — that choice is yours, and the tool itself still sends nothing anywhere. See our [Privacy Policy](/privacy) for the full details.

**What does Share do, and where do my images go?**
Share hands your finished images to a system share sheet or app picker, so you can choose where they go — a messaging app, email, cloud storage, whatever your device offers. The app itself doesn't send them anywhere: it passes the files to your operating system in one call and then waits to be told whether that handoff succeeded or you cancelled it. We can't see, and don't control, which app or destination you pick.

**Does the app track me or send analytics about my images?**
No. No image bytes, file names, dimensions or sizes are sent to us or to any analytics service.

**Is it safe to use this in a private/incognito window?**
Yes, but with a small difference: some browsers (Firefox and Safari, in their private modes) don't allow the on-device temporary storage the app normally uses, so it automatically switches to keeping data in memory for the run instead. It still works, but it may handle somewhat smaller batches in that mode. The exact reduced limit for private browsing hasn't been finalized yet.

## 3. Files, formats & folders

**Which image formats can I upload?**
JPEG, PNG (including animated PNG), WebP (still and animated), AVIF (still images only), GIF (still and animated), and iPhone/iPad HEIC or HEIF photos. A few older or specialist formats — BMP, TIFF, JPEG XL, JPEG 2000 — can also be opened, though the app can't save back to those formats. Animated AVIF files are the one exception that gets turned away with an explanation, rather than being quietly flattened to a single frame.

**Which formats can I save to?**
JPEG, PNG, WebP, AVIF (still images only) and GIF.

**Can I upload iPhone photos (HEIC)?**
Yes, HEIC and HEIF files are read like any other photo. Since the app can't write HEIC files back out, they're automatically saved as JPEG unless you pick a different format.

**What happens if I leave the format set to "Don't change" but the app can't save that original format?**
It's saved as JPEG instead, and the app clearly shows you the actual output format so there are no surprises.

**Can I upload a whole folder instead of picking files one by one?**
Yes — the folder is scanned automatically, and the folder structure is kept intact in your downloaded result. This has been confirmed working on desktop Chrome, Firefox and Safari. It hasn't been specifically verified on an iPhone or iPad yet.

**What happens to files the app can't read, like Photoshop files or camera RAW files?**
They're listed as skipped, with a reason, so you know they weren't silently ignored. Ordinary non-image files (documents, videos, spreadsheets) are simply left out without any message, since there's nothing to explain. Camera RAW files are a mixed case: Canon and Panasonic RAW files are recognized and turned away up front, while Nikon, Sony and Adobe DNG files look enough like ordinary TIFF files to be accepted, and are only reported as failed if they turn out not to be readable.

**Is there a limit on how many images or how large a batch I can process?**
Not a fixed one yet. The app is designed to warn you and refuse a batch it can't handle safely rather than crash your browser tab, but the exact numbers (files per batch, maximum file size, and so on) are still being measured and tuned, so they aren't final yet.

## 4. Compression & quality

**How do I control the output file size — quality or an exact size?**
Both are offered. You can either pick a quality level (a simple slider) or set a maximum file size for each image. The size is a ceiling, not an exact byte count: the app searches for the highest quality it can produce without going over it.

**Does the quality slider mean the same thing for every format?**
Not quite. For JPEG, WebP and AVIF, it works as you'd expect — a straightforward visual-quality dial. For PNG, since PNG is expected to be lossless, the slider mostly decides *whether* the image is compressed with some quality loss at all, staying conservative at the low end so you never see visible banding. At the top of the range, several formats switch to a perfect, pixel-for-pixel lossless copy instead of a lossy one: PNG does so from 85 upward, and the others above 95.

**If I ask for an exact file size, will it always hit that exact number?**
No. The number is a maximum, so a result may be smaller but will never be delivered above it. If the app cannot get under the limit, that image is skipped instead of giving you an oversized file. For one still image, Preview may offer a tested JPEG or smaller-dimension alternative that fits. Dimension suggestions are sized to fit at 30 or higher on the quality scale, and a second familiar size from 240 px through 4K may be offered to preserve still more quality; every choice is checked again after you select it. When a PNG is already under your limit, the app still tries lossless PNG optimization and keeps whichever file is smaller; other formats are left unchanged when they already fit.

**Can I target a specific file size for any format, or only some?**
Right now, every output format supports size targeting.

**Will the app ever hand me back a bigger file than the one I uploaded?**
It can when you explicitly request a change such as different dimensions, a rotation, a crop or a different format. A size limit is different: every delivered size-targeted image stays at or below that limit, and an image that cannot fit is skipped. When the format and visible image would stay unchanged, the app compares the real result with the source and keeps the original if re-encoding is no smaller. This also applies when a dimension setting, such as “Fit within,” does not actually resize that image.

**Is AVIF's highest-quality ("lossless") setting really lossless?**
Not quite, at the moment. It currently produces a very high-quality result rather than a truly pixel-perfect one, because a working lossless AVIF encoder isn't available yet in this build. PNG and WebP's lossless modes are genuinely lossless.

## 5. Resizing, rotating & cropping

**What resizing options are there?**
Keep the original size, fit within a maximum long edge, or set a fixed width or fixed height (the other dimension adjusts automatically to keep proportions).

**Will resizing ever make my image bigger than it started?**
Only if you explicitly ask a fixed width or fixed height to enlarge a smaller image. "Fit within" a maximum size never enlarges — it only ever shrinks images that are too big. Cropping can also produce a larger image than the original if you zoom out past the image edges, which is why a background fill color exists.

**What's the smallest area I can crop?**
A crop can't be smaller than 16 pixels in either direction.

**If I rotate an image, does my existing crop stay?**
No — rotating currently resets any crop back to cover the whole (newly rotated) image, and resets zoom back to normal. If you had a locked aspect ratio selected, it stays selected and re-fits to the rotated image.

**If I crop an image, does the batch resize setting still apply to it?**
No. An explicit crop always takes priority over the batch resize setting for that image, since the crop already states an exact output size.

**If I only rotate an image without cropping it, does the batch resize setting still apply?**
Yes — rotating alone doesn't override your resize setting. Only an explicit crop does that.

**What fills the empty corners if I crop or zoom out past the edges of my image?**
A color you choose, or transparency if your chosen output format supports it. JPEG has no transparency, so cropped images heading to JPEG always get a solid fill color instead.

## 6. Animated images (GIF, animated WebP, animated PNG)

**Will my animated GIF/WebP/PNG still animate after compressing?**
Yes — frame timing and loop count are preserved. If you choose a format that can't animate (JPEG or AVIF), your animation isn't flattened to a single frame: it's saved as an animated WebP instead, so nothing is lost.

**Does the quality slider affect animated PNG?**
No. Animated PNG is always saved at full, lossless quality no matter where the slider is set. This avoids a quality-control issue in the underlying tool that could otherwise introduce visible banding in animated PNGs.

**Are any frames ever dropped to hit a smaller file size?**
No, frame count is never reduced.

**Can I rotate or crop an animated image?**
Not in this version — editing (rotate and crop) is only available for still images.

**Will the timing between frames be perfectly preserved?**
Very close, but not always exact. GIF can only store frame timing in hundredths of a second, so unusually short or precise frame delays get rounded slightly when saving to GIF. This rounding currently isn't called out to you when it happens.

## 7. Metadata & color

**Does the app preserve EXIF metadata, like camera info or GPS location?**
By default, no — EXIF, IPTC and XMP metadata, including GPS location, is stripped from images that are re-encoded, both for privacy and to save space. There is one current exception: when the app keeps the original because it already meets a size target or because a same-format re-encode is no smaller, the source metadata can remain. A PNG may be losslessly optimized on that path, but it can retain the same metadata, including GPS location. This inconsistency is a known issue the project intends to resolve. Until then, treat any result marked “Original kept” or “Original optimized losslessly” as potentially retaining its metadata.

**Does rotating an image add a rotation tag, like phone cameras do, or does it actually turn the pixels?**
The rotation is applied directly to the pixels, not stored as a tag. This means the output looks correctly rotated in every viewer, including ones that don't read rotation tags.

**Will colors look right after compressing?**
Yes — an embedded color profile in your original image is carried over to the output whenever the output format supports one. If your image had no color profile to begin with, it's treated as standard sRGB, which is correct for the vast majority of photos.

**What about the newer wide-color formats used by recent iPhones and AVIF photos (like Display P3)?**
These are read and handled correctly when you're converting to AVIF, and their colors are preserved. Right now, though, converting one of these wide-color HEIC or AVIF photos to JPEG, PNG, WebP or GIF fails instead of converting the color correctly — a known gap. Ordinary photos without this kind of color signalling aren't affected.

**Does GIF support transparency the same way PNG or WebP does?**
Only partly. GIF can only make a pixel fully transparent or fully opaque — it has no in-between. If your source image has soft, partially transparent edges (like a drop shadow), converting it to GIF currently turns those soft edges into fully solid or fully invisible pixels, without a warning that this happened.

**If I compress a Live Photo or a portrait-mode photo from an iPhone, what happens to the extra depth or motion data?**
Only the main image is processed. The auxiliary depth or motion data that comes with Live Photos and portrait shots is not carried through to the output.

## 8. Browser & device support

**Which browsers does this work in?**
Chrome, Firefox and Safari on desktop have all been tested and are supported. One Safari-specific quirk is worth knowing: very occasionally (roughly one job in eighty), GIF compression in Safari falls back to a less efficient method, so that GIF comes out noticeably larger than it would elsewhere. Your image is still correct — just bigger than expected.

**Does it work on an iPhone or iPad?**
It should run, but its specific memory behavior on mobile Safari hasn't been verified yet, so treat that as untested for now.

**Will processing a large batch crash my browser tab?**
The app is designed to stream results to your device's storage instead of holding everything in memory at once, and this has been confirmed to keep memory flat even with several gigabytes of output on desktop browsers. Exact safe batch sizes for phones are still being measured.

**Do I need a powerful computer or a graphics card?**
No. Everything runs on your device's regular processor inside the browser — no special hardware is required.

## 9. Open source & licensing

**Is this app open source?**
Yes, it's licensed under the GNU AGPL v3.

**Can I see the source code?**
Yes, the [project's source](https://github.com/Cognirush-Labs-LLP/massimg-web) is public, also linked from the footer on every page. A credits page listing every bundled library isn't built yet, but nothing about the project is private.

**What other software does this rely on?**
A handful of established open-source image libraries handle the actual decoding, compressing and animating under the hood. Each one will be named and credited on the app's credits page once it's built.

## 10. What's still being finished

The core compression engine — formats, quality, resizing, rotation, cropping, animation, color handling — is built and working as described above, and so are the on-screen gallery, preview and rotate/crop editing screens, the compression run itself, and downloading or sharing the finished result. Some parts of the app are still not finished, including:

- Finalized limits on batch size, file size and image dimensions
- Full keyboard and screen-reader accessibility
- Translations into languages other than English

These are all planned and underway — this FAQ will be updated as they land.
