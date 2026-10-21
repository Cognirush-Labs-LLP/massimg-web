// How many bytes of the `memory` limit does ImageMagick charge per decoded pixel? Sweeps the limit
// (with disk = 0 so the cache cannot spill) against 48 MP images of three channel layouts.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const MB = 1024 * 1024;
const { server, url } = await startServer(8791);
const browser = await chromium.launch();
for (const fixture of ['legit-48mp.png', 'rgb-48mp.png', 'rgba-48mp.png']) {
  const row = [];
  for (const mem of [128, 192, 256, 384, 512, 768, 1024, 1536, 2048]) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__ready);
    await page.evaluate(() => window.__ready);
    await page.evaluate((m) => window.__setLimits({ disk: 0, memory: m, maxMemoryRequest: m }), mem * MB);
    const o = await page.evaluate((f) => window.__decode(`fixtures/${f}`), fixture);
    row.push(`${mem}:${o.ok ? 'ok' : 'no'}`);
    await page.close();
  }
  console.log(fixture.padEnd(18), row.join('  '));
}
await browser.close();
server.close();
