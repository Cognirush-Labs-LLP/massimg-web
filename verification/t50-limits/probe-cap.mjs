// Which ImageMagick limit refuses an image exactly at the derived cap? Decodes the phone-ramp fixtures
// under the shipped mobile guard on desktop Chromium and prints the error text.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const MiB = 1048576;
const { server, url } = await startServer(8793);
const browser = await chromium.launch();
const variants = {
  'shipped (area 52428800, memory 800MiB)': { disk: 0, memory: 800 * MiB, maxMemoryRequest: 800 * MiB, area: 52_428_800 },
  'area = cap + 1': { disk: 0, memory: 800 * MiB, maxMemoryRequest: 800 * MiB, area: 52_428_801 },
  'area +1%': { disk: 0, memory: 800 * MiB, maxMemoryRequest: 800 * MiB, area: 52_428_800 * 1.01 },
  'memory 1200MiB': { disk: 0, memory: 1200 * MiB, maxMemoryRequest: 1200 * MiB, area: 52_428_800 },
  'maxMemoryRequest 2GiB': { disk: 0, memory: 800 * MiB, maxMemoryRequest: 2048 * MiB, area: 52_428_800 },
};
for (const [name, limits] of Object.entries(variants)) {
  for (const fixture of ['android/rgb-50mp.png', 'android/rgb-52mp.png']) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__ready);
    await page.evaluate(() => window.__ready);
    await page.evaluate((l) => window.__setLimits(Object.fromEntries(Object.entries(l).map(([k, v]) => [k, Math.floor(v)]))), limits);
    const o = await page.evaluate((f) => window.__decode(`fixtures/${f}`), fixture);
    console.log(name.padEnd(42), fixture.padEnd(22), o.ok ? `ok ${o.ms}ms` : `${o.errorName}: ${o.message}`);
    await page.close();
  }
}
await browser.close();
server.close();
