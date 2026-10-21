// Why did the 100-frame 590x590 GIF fail to encode as animated WebP on the phone? Runs the same job
// through the real pool on desktop Chromium, at a few frame counts and budgets.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const gif = (name) => Array.from(readFileSync(new URL(`./public/fixtures/android/${name}`, import.meta.url)));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173/');
for (const [label, mobile, fixture, format] of [
  ['small 200px x100 -> webp', false, 'anim-200x100.gif', 'webp'],
  ['desktop budget, 100f 590px -> webp', false, 'anim-590x100.gif', 'webp'],
  ['mobile budget,  100f 590px -> webp', true, 'anim-590x100.gif', 'webp'],
  ['mobile budget,  100f 590px -> gif ', true, 'anim-590x100.gif', 'gif'],
]) {
  const r = await page.evaluate(async ({ bytes, mobile, format }) => {
    const { createWorkerPool } = await import('/src/pipeline/pool.ts');
    const pool = createWorkerPool({ size: 1, mobile });
    const done = await pool.run({
      imageId: 'a', source: new Uint8Array(bytes), edit: null,
      settings: { quality: { kind: 'quality', value: 80, lossless: false }, dimension: { kind: 'original' }, format, isAnimated: true, sourceFormat: 'gif', alpha: { kind: 'preserve' } },
      intent: 'run',
    }).done;
    pool.destroy();
    return { outcome: done.outcome, reason: done.reason, bytes: done.result && done.result.bytes && done.result.bytes.byteLength };
  }, { bytes: gif(fixture), mobile, format });
  console.log(label, JSON.stringify(r));
}
await browser.close();
