// T22 — lazy codec loading (docs/assumptions.md C8, Technical Design §5.2).
//
// For each engine:
//   - idle baseline peak RSS;
//   - "eager": all six codec modules loaded concurrently, as if §5.2's lazy strategy were not
//     applied at all — peak RSS, wall time, bytes transferred (C8's "all three [modules] initialised"
//     comparison point, extended to all six since the real table names six modules, not three);
//   - "lazy": the shipped per-format strategy, exercised as a GIF job, then a still-PNG job, then an
//     animated-PNG job would exercise it in sequence — peak RSS, per-module load time (this doubles
//     as T21's requested re-initialisation cost figure) and bytes transferred, plus proof that the
//     total is less than "eager"'s.
//
// Bundle sizes (the other half of C8's "measured bundle... figures") come from a real production
// `vite build`, not from this browser harness — see build-sizes.mjs.
//
// Run: pnpm test (equivalently `node run.mjs`). T22_QUICK=1 does Chromium only.

import { chromium, firefox, webkit } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { MemorySampler } from './memory-sampler.mjs';
import { measureBundleSizes } from './build-sizes.mjs';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
const QUICK = Boolean(process.env.T22_QUICK);
const PORT = 5180;

const ENGINES = QUICK ? { chromium } : { chromium, firefox, webkit };

// Same technique as t20-thumbnails/run.mjs: launchPersistentContext (a real, disk-backed profile,
// not the ephemeral default WebKit context — T01) gives a process tree findable by its unique
// userDataDir.
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

// A short interval: codec init here is tens to a couple hundred milliseconds, not the multi-second
// passes t20-thumbnails/memory-sampler.mjs (200ms interval) was built for — 100ms sampling on a
// ~100ms operation captures one or two points at best and can miss the real peak entirely. A 400ms
// settle window after `fn()` resolves also catches memory committed by work that finishes just after
// the awaited promise does (observed here: the process-tree RSS figure keeps climbing for a beat
// after `initializeImageMagick()`'s own promise settles).
async function samplePeak(rootPid, fn, settleMs = 400) {
  const sampler = new MemorySampler(rootPid, 15);
  sampler.start();
  const result = await fn();
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const { peakBytes } = sampler.stop();
  return { result, peakBytes };
}

function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(url)
        .then(() => resolve())
        .catch((err) => {
          if (Date.now() > deadline) reject(err);
          else setTimeout(attempt, 150);
        });
    };
    attempt();
  });
}

async function main() {
  console.log('Measuring production bundle sizes (vite build)...');
  const bundleSizes = await measureBundleSizes();
  for (const [name, bytes] of Object.entries(bundleSizes)) {
    console.log(`  ${name}: ${(bytes / 1024).toFixed(1)} KB`);
  }

  console.log(`\nStarting harness dev server on :${PORT}...`);
  const vite = spawn(
    join(__dirname, 'node_modules', '.bin', 'vite'),
    ['--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: __dirname, stdio: 'pipe' },
  );
  const url = `http://127.0.0.1:${PORT}/`;

  const results = { bundleSizes, engines: [] };

  try {
    await waitForServer(url);

    // Each scenario gets its own fresh, disk-backed profile (its own userDataDir) rather than
    // sharing one context across "eager" and "lazy": Vite dev server serves cacheable responses
    // (ETag/304), and running "lazy" second in a context "eager" already warmed made its loads look
    // free the first time this harness ran — a real finding about this harness, not about C8. Two
    // profiles costs two browser launches per engine but keeps the comparison honest.
    async function withFreshContext(engineName, engine, fn) {
      const userDataDir = mkdtempSync(join(tmpdir(), 't22-udd-'));
      const context = await engine.launchPersistentContext(userDataDir, { headless: true });
      try {
        const rootPid = await findRootPid(userDataDir, process.pid);
        if (!rootPid) throw new Error(`${engineName}: could not locate browser process pid via ps`);
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(url, { waitUntil: 'load' });
        const { peakBytes: baselineBytes } = await samplePeak(rootPid, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        });
        return await fn({ context, page, rootPid, baselineBytes });
      } finally {
        await context.close();
        rmSync(userDataDir, { recursive: true, force: true });
      }
    }

    for (const [engineName, engine] of Object.entries(ENGINES)) {
      console.log(`\n=== ${engineName} ===`);

      const eagerResult = await withFreshContext(engineName, engine, async ({ page, rootPid, baselineBytes }) => {
        console.log(`  idle baseline: ${(baselineBytes / MB).toFixed(0)} MB`);

        // Eager: all six modules loaded concurrently, immediately.
        const { result: eagerLoad, peakBytes: eagerPeak } = await samplePeak(rootPid, () =>
          page.evaluate(() => window.t22LoadAll()),
        );
        const eagerBytes = await page.evaluate(() => window.t22ResourceBytes());
        console.log(
          `  eager: ${eagerLoad.totalMs.toFixed(0)} ms wall, peak ${(eagerPeak / MB).toFixed(0)} MB ` +
            `(+${((eagerPeak - baselineBytes) / MB).toFixed(0)}), ` +
            `${(Object.values(eagerBytes).reduce((a, b) => a + b, 0) / MB).toFixed(1)} MB transferred`,
        );

        return {
          baselineBytes,
          wallMs: eagerLoad.totalMs,
          perModuleMs: eagerLoad.perModule,
          peakBytes: eagerPeak,
          overBaselineBytes: eagerPeak - baselineBytes,
          transferredBytes: eagerBytes,
        };
      });

      const lazyResult = await withFreshContext(engineName, engine, async ({ page, rootPid, baselineBytes }) => {
        // Lazy: the shipped per-format strategy, exercised as a GIF job, a still-PNG job and an
        // animated-PNG job would exercise it in sequence. Each step's own time is a
        // re-initialisation cost measurement (T21's note: "whoever measures codec re-init cost...
        // sets it" — config/limits.ts's jobTimeoutMs).
        const steps = [];
        const { peakBytes: lazyPeak } = await samplePeak(rootPid, async () => {
          // "First image added, or idle after first paint" — this harness stands in for either.
          steps.push({ module: 'imagemagick', ms: await page.evaluate(() => window.t22Load('imagemagick')) });
          // A GIF job.
          steps.push({ module: 'gifsicle', ms: await page.evaluate(() => window.t22Load('gifsicle')) });
          // A still-PNG job.
          steps.push({ module: 'oxipng', ms: await page.evaluate(() => window.t22Load('oxipng')) });
          steps.push({ module: 'quantizer', ms: await page.evaluate(() => window.t22Load('quantizer')) });
          // An animated-PNG job.
          steps.push({ module: 'upng', ms: await page.evaluate(() => window.t22Load('upng')) });
          steps.push({
            module: 'apngOptimizer',
            ms: await page.evaluate(() => window.t22Load('apngOptimizer')),
          });
        });
        const lazyBytes = await page.evaluate(() => window.t22ResourceBytes());
        const lazyTotalMs = steps.reduce((sum, s) => sum + s.ms, 0);
        console.log(
          `  lazy (sequential): ${lazyTotalMs.toFixed(0)} ms total, peak ${(lazyPeak / MB).toFixed(0)} MB ` +
            `(+${((lazyPeak - baselineBytes) / MB).toFixed(0)}), ` +
            `${(Object.values(lazyBytes).reduce((a, b) => a + b, 0) / MB).toFixed(1)} MB transferred`,
        );
        for (const step of steps) {
          console.log(`    ${step.module}: ${step.ms.toFixed(0)} ms`);
        }

        return {
          baselineBytes,
          steps,
          totalMs: lazyTotalMs,
          peakBytes: lazyPeak,
          overBaselineBytes: lazyPeak - baselineBytes,
          transferredBytes: lazyBytes,
        };
      });

      // jpegOnly: the common case (§5.2 is contingent on C8 precisely because most sessions never
      // touch gifsicle/oxipng/quantizer/UPNG/apng-optimizer at all). "lazy" above deliberately
      // exercises every module in one session, which is the right test for "does loading them one at
      // a time cost more peak memory than loading them together" (answer below: no, they converge,
      // because by the end of that sequence every module is loaded either way) — but it cannot show
      // the actual saving lazy loading buys a JPEG-only user, which is what this scenario measures.
      const jpegOnlyResult = await withFreshContext(engineName, engine, async ({ page, rootPid, baselineBytes }) => {
        const { result: ms, peakBytes } = await samplePeak(rootPid, () =>
          page.evaluate(() => window.t22Load('imagemagick')),
        );
        const bytes = await page.evaluate(() => window.t22ResourceBytes());
        console.log(
          `  jpeg-only (ImageMagick alone): ${ms.toFixed(0)} ms, peak ${(peakBytes / MB).toFixed(0)} MB ` +
            `(+${((peakBytes - baselineBytes) / MB).toFixed(0)}), ` +
            `${(bytes.imagemagick / MB).toFixed(1)} MB transferred`,
        );
        return {
          baselineBytes,
          ms,
          peakBytes,
          overBaselineBytes: peakBytes - baselineBytes,
          transferredBytes: bytes,
        };
      });

      results.engines.push({
        engine: engineName,
        eager: eagerResult,
        lazy: lazyResult,
        jpegOnly: jpegOnlyResult,
      });
    }
  } finally {
    vite.kill();
  }

  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
  console.log('\nWrote results.json');
}

await main();
