// T50 — does ImageMagick's ResourceLimits turn a decompression bomb into a catchable error?
//
// For each engine, each limits variant and each fixture, a fresh page initialises the shipped x86
// build, applies the variant, decodes the fixture and reports whether it (a) decoded, (b) threw a
// catchable error, or (c) took the page down (crash / timeout). A fresh page per case keeps one
// case's heap growth from contaminating the next.
import { chromium, firefox, webkit } from 'playwright';
import { writeFileSync } from 'node:fs';
import { startServer } from './server.mjs';

const MB = 1024 * 1024;
const VARIANTS = {
  'defaults': {},
  'disk-0': { disk: 0 },
  'area+disk-0': { area: 100_000_000, disk: 0 },
  'memory+disk-0': { memory: 1024 * MB, maxMemoryRequest: 512 * MB, disk: 0 },
  // The candidate guard: a 768 MiB pixel-cache budget (~96 MP of RGBA at 8 B/px), no disk spill.
  'guard': { disk: 0, memory: 768 * MB, maxMemoryRequest: 768 * MB, area: 100_000_000, width: 20_000, height: 20_000, listLength: 256 },
  'dims-only': { width: 20_000, height: 20_000 },
  'area-only': { area: 100_000_000 },
  'memory-only': { memory: 1024 * MB, maxMemoryRequest: 512 * MB },
  'list-only': { listLength: 256 },
  'capped': { listLength: 256,  area: 100_000_000, width: 20_000, height: 20_000, memory: 1024 * MB, maxMemoryRequest: 512 * MB },
};
const FIXTURES = ['legit-48mp.png', 'rgba-48mp.png', 'legit-frames.gif', 'bomb-data-1.6gp.png', 'bomb-18k-area.png', 'bomb-frames.gif', 'bomb-webp-16k.webp', 'synthetic-jpeg-60000x60000', 'synthetic-jpeg-16000x16000'];
const ENGINES = { chromium, firefox, webkit };
const CASE_TIMEOUT_MS = 90_000;

const { server, url } = await startServer(8790);
const results = [];
const FIXTURE_ADDITIONS = null;

const only = process.argv[2];
for (const [engineName, engine] of Object.entries(ENGINES)) {
  if (only && only !== engineName) continue;
  const browser = await engine.launch();
  for (const [variant, limits] of Object.entries(VARIANTS)) {
    if (process.argv[3] && !process.argv[3].split(',').includes(variant)) continue;
    for (const fixture of FIXTURES) {
      const page = await browser.newPage();
      let crashed = false;
      page.on('crash', () => { crashed = true; });
      const record = { engine: engineName, variant, fixture };
      try {
        await page.goto(url);
        await page.waitForFunction(() => window.__ready);
        await page.evaluate(() => window.__ready);
        record.defaults = await page.evaluate(() => window.__defaults());
        if (Object.keys(limits).length) {
          record.applied = await page.evaluate((l) => window.__setLimits(l), limits);
        }
        const outcome = await Promise.race([
          page.evaluate((f) => window.__decode(`fixtures/${f}`), fixture),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), CASE_TIMEOUT_MS)),
        ]);
        record.outcome = crashed ? { crashed: true } : outcome;
        if (!crashed && outcome && outcome.ok === false) {
          record.afterError = await page.evaluate(() => window.__decode('fixtures/legit-48mp.png'));
        }
        if (!crashed) record.alive = await page.evaluate(() => 1 + 1).then((v) => v === 2).catch(() => false);
      } catch (err) {
        record.outcome = { harnessError: String(err.message || err).slice(0, 300), crashed };
      }
      results.push(record);
      const o = record.outcome;
      const text = o.ok ? `decoded ${o.size.width}x${o.size.height}${o.size.frames ? ' x' + o.size.frames + ' frames' : ''} in ${o.ms}ms`
        : o.crashed ? 'PAGE CRASHED'
        : o.timeout ? 'TIMEOUT'
        : o.harnessError ? `harness error: ${o.harnessError}`
        : `caught ${o.errorName}: ${o.message} (${o.ms}ms)`;
      const after = record.afterError ? (record.afterError.ok ? ' | instance reusable' : ' | INSTANCE BROKEN: ' + record.afterError.message) : '';
      console.log(`${engineName.padEnd(9)} ${variant.padEnd(13)} ${fixture.padEnd(22)} ${text}${after}`);
      await page.close().catch(() => {});
    }
  }
  await browser.close();
}
server.close();
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
