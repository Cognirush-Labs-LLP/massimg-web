import { chromium } from 'playwright';

function framesGif(side, frames) {
  const u16 = (n) => [n & 0xff, n >> 8];
  const head = [...Array.from('GIF89a', (c) => c.charCodeAt(0)), ...u16(side), ...u16(side), 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  const body = [];
  for (let i = 0; i < frames; i++) {
    // Each frame paints a different single pixel, so successive frames differ.
    body.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x2c, ...u16(i % side), ...u16((i * 7) % side), 1, 0, 1, 0, 0, 0x02, 0x02, i % 2 ? 0x4c : 0x44, 0x01, 0x00);
  }
  return [...head, ...body, 0x3b];
}
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5173/');
for (const [side, frames] of [[64, 6], [64, 100], [200, 20], [400, 20], [590, 2], [590, 10], [590, 100]]) {
  const r = await page.evaluate(async ({ bytes }) => {
    const { createWorkerPool } = await import('/src/pipeline/pool.ts');
    const pool = createWorkerPool({ size: 1, mobile: false });
    const done = await pool.run({
      imageId: 'a', source: new Uint8Array(bytes), edit: null,
      settings: { quality: { kind: 'quality', value: 80, lossless: false }, dimension: { kind: 'original' }, format: 'webp', isAnimated: true, sourceFormat: 'gif', alpha: { kind: 'preserve' } },
      intent: 'run',
    }).done;
    pool.destroy();
    return done.outcome + (done.reason ? ' ' + done.reason.kind : '') + (done.result && done.result.bytes ? ' ' + done.result.bytes.byteLength + 'B' : '');
  }, { bytes: framesGif(side, frames) });
  console.log(`${side}px x ${String(frames).padStart(3)} frames -> animated webp: ${r}`);
}
await browser.close();
