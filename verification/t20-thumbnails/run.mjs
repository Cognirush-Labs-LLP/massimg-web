// T20 — thumbnail generation cost and representation (docs/assumptions.md C5).
//
// For each engine, over 50 real photographs of mixed dimensions and formats:
//   - native bounded-resize decode + encode time per image, at two candidate long-edge bounds
//     (256 and 384) and in both candidate encoded formats (JPEG and WebP);
//   - retained Blob bytes for a full batch held at once, which is what R-G3's ceiling actually costs;
//   - peak process-tree RSS across each pass, against an idle baseline;
//   - a cancellation probe: a worker generating continuously is terminated mid-flight and memory is
//     sampled afterwards, to show growth stops rather than a late result merely being hidden.
//
// Separately, in Node: ImageMagick's thumbnail operation for the inputs no engine decodes natively.
//
// Run: pnpm test   (equivalently `node run.mjs`). T20_QUICK=1 does one engine and one configuration.

import { chromium, firefox, webkit } from 'playwright';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { selectFixtures, trimToPlan, TOTAL_FIXTURES } from './fixtures.mjs';
import { readDimensions, timeMagickThumbnail } from './magick.mjs';
import { MemorySampler } from './memory-sampler.mjs';
import { startServer } from './server.mjs';

const execFileP = promisify(execFile);
const MB = 1024 * 1024;
const QUICK = Boolean(process.env.T20_QUICK);

const CONFIGS = QUICK
  ? [{ maxEdge: 384, format: 'image/webp', quality: 0.75 }]
  : [
      { maxEdge: 256, format: 'image/jpeg', quality: 0.75 },
      { maxEdge: 256, format: 'image/webp', quality: 0.75 },
      { maxEdge: 384, format: 'image/jpeg', quality: 0.75 },
      { maxEdge: 384, format: 'image/webp', quality: 0.75 },
    ];

const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit };

// launchPersistentContext, not launch(): T01 found WebKit's ephemeral context behaves like a private
// session, and a persistent profile also gives us a process tree to find by its unique userDataDir.
async function findRootPid(userDataDir, nodePid) {
  const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,command=']);
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, cmd] = match;
    if (Number(ppid) === nodePid && cmd.includes(userDataDir)) return Number(pid);
  }
  return null;
}

function summarise(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

async function samplePeak(rootPid, ms) {
  const sampler = new MemorySampler(rootPid, 200);
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, ms));
  return sampler.stop().peakBytes;
}

async function main() {
  console.log('Selecting fixtures...');
  const selected = selectFixtures();
  console.log(`  ${selected.length} candidates for ${TOTAL_FIXTURES} slots`);

  console.log('Reading intrinsic dimensions via ImageMagick...');
  const fixtures = trimToPlan(await readDimensions(selected));
  console.log(`  ${fixtures.length} fixtures`);
  const byFormat = {};
  for (const fixture of fixtures) {
    byFormat[fixture.format] = (byFormat[fixture.format] || 0) + 1;
  }
  console.log('  format mix:', byFormat);
  console.log(
    `  pixel range: ${Math.min(...fixtures.map((f) => f.width * f.height)) / 1e6} MP to ` +
      `${(Math.max(...fixtures.map((f) => f.width * f.height)) / 1e6).toFixed(1)} MP`,
  );

  const { server, url } = await startServer(fixtures);
  const results = { fixtures: fixtures.map(({ path, ...rest }) => rest), engines: [], magick: [] };

  try {
    for (const [engineName, engine] of Object.entries(ENGINES)) {
      console.log(`\n=== ${engineName} ===`);
      const userDataDir = mkdtempSync(join(tmpdir(), 't20-udd-'));
      const context = await engine.launchPersistentContext(userDataDir, { headless: true });

      try {
        const rootPid = await findRootPid(userDataDir, process.pid);
        if (!rootPid) throw new Error('could not locate browser process pid via ps');

        const page = context.pages()[0] || (await context.newPage());
        page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`));
        await page.goto(url, { waitUntil: 'load' });
        await page.evaluate(() => window.t20Manifest());

        const baselineBytes = await samplePeak(rootPid, 1000);
        console.log(`  idle baseline: ${(baselineBytes / MB).toFixed(0)} MB`);

        const engineResult = { engine: engineName, baselineBytes, passes: [], cancellation: null };

        for (const config of CONFIGS) {
          const sampler = new MemorySampler(rootPid, 200);
          sampler.start();
          const started = Date.now();
          const pass = await page.evaluate((options) => window.t20Run(options), config);
          const wallMs = Date.now() - started;
          const { peakBytes } = sampler.stop();
          await page.evaluate(() => window.t20Release());

          const ok = pass.results.filter((result) => result.ok);
          const failed = pass.results.filter((result) => !result.ok);
          const entry = {
            ...config,
            wallMs,
            peakBytes,
            overBaselineBytes: peakBytes - baselineBytes,
            generated: ok.length,
            unsupported: failed.filter((r) => r.reason === 'unsupported').map((r) => r.index),
            failed: failed.filter((r) => r.reason !== 'unsupported').map((r) => r.index),
            retainedBytes: pass.retainedBytes,
            retainedCount: pass.retainedCount,
            decodeMs: summarise(ok.map((r) => r.decodeMs)),
            encodeMs: summarise(ok.map((r) => r.encodeMs)),
            totalMs: summarise(ok.map((r) => r.totalMs)),
            thumbBytes: summarise(ok.map((r) => r.thumbBytes)),
            perImage: ok.map((r) => ({
              index: r.index,
              decodeMs: r.decodeMs,
              encodeMs: r.encodeMs,
              thumbBytes: r.thumbBytes,
              width: r.width,
              height: r.height,
            })),
          };
          engineResult.passes.push(entry);

          console.log(
            `  ${config.maxEdge}px ${config.format}: ${entry.generated} generated, ` +
              `${entry.unsupported.length} unsupported, ` +
              `median ${entry.totalMs?.median.toFixed(1)} ms, ` +
              `median ${(entry.thumbBytes?.median / 1024).toFixed(1)} KB, ` +
              `retained ${(entry.retainedBytes / MB).toFixed(2)} MB, ` +
              `peak ${(peakBytes / MB).toFixed(0)} MB (+${((peakBytes - baselineBytes) / MB).toFixed(0)})`,
          );
        }

        // Cancellation probe (R-G12, and C5's "verify that cancelling stops CPU and memory growth").
        const probeConfig = { maxEdge: 384, format: 'image/webp', quality: 0.75 };
        await page.evaluate((options) => window.t20StartLoop(options), probeConfig);
        const duringPeak = await samplePeak(rootPid, 4000);
        const ticksBeforeStop = await page.evaluate(() => window.t20Ticks());
        await page.evaluate(() => window.t20Terminate());
        const afterPeak = await samplePeak(rootPid, 4000);
        const ticksAfterStop = await page.evaluate(() => window.t20Ticks());

        engineResult.cancellation = {
          duringPeakBytes: duringPeak,
          afterPeakBytes: afterPeak,
          ticksBeforeStop,
          ticksAfterStop,
        };
        console.log(
          `  cancellation: ${ticksBeforeStop} thumbnails before terminate, ` +
            `${ticksAfterStop - ticksBeforeStop} after; ` +
            `peak during ${(duringPeak / MB).toFixed(0)} MB, after ${(afterPeak / MB).toFixed(0)} MB`,
        );

        results.engines.push(engineResult);
      } finally {
        await context.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }

    // The ImageMagick fallback path, for whatever no engine decoded natively.
    const unsupportedIndexes = new Set();
    for (const engine of results.engines) {
      for (const pass of engine.passes) {
        for (const index of pass.unsupported) unsupportedIndexes.add(index);
      }
    }
    console.log(`\n=== ImageMagick fallback (${unsupportedIndexes.size} fixtures) ===`);
    for (const index of [...unsupportedIndexes].sort((a, b) => a - b)) {
      const measured = await timeMagickThumbnail(fixtures[index], 384, 'image/webp', 0.75);
      results.magick.push(measured);
      console.log(
        `  #${index} (${measured.format}): ${measured.totalMs.toFixed(0)} ms, ` +
          `${(measured.thumbBytes / 1024).toFixed(1)} KB, ${measured.width}x${measured.height}`,
      );
    }
  } finally {
    server.close();
  }

  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
  console.log('\nWrote results.json');
}

await main();
