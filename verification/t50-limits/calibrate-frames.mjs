// How does `listLength` relate to an animation's frame count once the pipeline has called
// readCollection + coalesce? Finds the smallest listLength (powers-of-two-ish ladder) that lets each
// tiny N-frame GIF through.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const { server, url } = await startServer(8792);
const browser = await chromium.launch();
const ladder = [64, 128, 200, 256, 400, 512, 640, 800, 1024, 1300, 1600, 2048, 2600, 3200];
for (const n of [100, 300, 600, 1200]) {
  let smallest = null;
  for (const L of ladder) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__ready);
    await page.evaluate(() => window.__ready);
    await page.evaluate((l) => window.__setLimits({ listLength: l }), L);
    const o = await page.evaluate((f) => window.__decode(`fixtures/${f}`), `frames-${n}.gif`);
    await page.close();
    if (o.ok) { smallest = L; break; }
  }
  console.log(`${String(n).padStart(5)} frames -> smallest passing listLength on ladder: ${smallest}`);
}
await browser.close();
server.close();
