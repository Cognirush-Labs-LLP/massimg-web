// T03 — WASM memory reclamation in a browser.
//
// Drives a Chromium tab (via Playwright) that loads @imagemagick/magick-wasm
// and processes a sequence of synthetic images of increasing size, disposing
// between each. Records, after each image:
//   - the WASM linear memory size (WebAssembly.Memory.prototype.buffer.byteLength),
//     read from inside the page;
//   - a browser-engine-agnostic "tab memory" proxy: summed RSS across the
//     browser's OS process tree (parent + every child — browsers are
//     multi-process), sampled by shelling out to `ps` from the host, both at
//     its peak *during* the image's processing and once things settle after
//     disposal + a forced GC.
//
// See docs/task-notes/T03.md for the write-up and docs/assumptions.md C2 for
// the assumption this measures.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';

const MB = 1024 * 1024;

function readProcessTable() {
  // pid, ppid, rss(KB) for every process on the system. Cheap enough to call
  // on a poll interval of a couple hundred ms.
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const [pid, ppid, rss] = t.split(/\s+/).map(Number);
    if (Number.isFinite(pid)) rows.push({ pid, ppid, rss });
  }
  return rows;
}

function readProcessTableWithCommand() {
  // Same as above but with the full command line, for the one-time lookup of
  // which child of this Node process is the browser's root process. `-ww`
  // asks BSD/macOS ps for unlimited-width output (no truncation when piped).
  const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const rows = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

// Playwright's `Browser` object has no `.process()` accessor in this version
// (it did in older Playwright releases when the browser always ran as a
// direct child of the Node process; that guarantee is no longer part of the
// public API). So instead: launch with a persistent profile dir and find the
// one direct child of *this* Node process that is the browser. We can't match
// on `chromium.executablePath()` because Playwright launches a different
// binary (`chrome-headless-shell`) than that path reports when `headless:
// true` is used with a plain Chromium channel. Instead: it's the only direct
// child of our own pid that isn't a `ps` invocation we spawned ourselves.
// Everything under it in the OS process tree (renderer, GPU, network
// service, ...) is found by walking ppid links from there, in `treeRssKB`.
function findBrowserRootPid(nodePid) {
  const rows = readProcessTableWithCommand();
  const candidates = rows.filter((r) => r.ppid === nodePid && !r.command.startsWith('ps '));
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one non-"ps" child of node pid ${nodePid}, found ${candidates.length}: ` +
        JSON.stringify(candidates),
    );
  }
  return candidates[0].pid;
}

function treeRssKB(rootPid, rows) {
  const children = new Map();
  for (const r of rows) {
    if (!children.has(r.ppid)) children.set(r.ppid, []);
    children.get(r.ppid).push(r.pid);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r.rss]));
  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += byPid.get(pid) || 0;
    for (const c of children.get(pid) || []) stack.push(c);
  }
  return total;
}

async function withPeakRss(rootPid, work) {
  let peakKB = 0;
  let stop = false;
  const poller = (async () => {
    while (!stop) {
      try {
        const kb = treeRssKB(rootPid, readProcessTable());
        if (kb > peakKB) peakKB = kb;
      } catch {
        // process table read can race a process exiting; ignore and retry
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  })();
  const result = await work();
  stop = true;
  await poller;
  return { result, peakKB };
}

function fmtMB(bytes) {
  return (bytes / MB).toFixed(1);
}

async function main() {
  const { server, url } = await startServer();

  const userDataDir = mkdtempSync(join(tmpdir(), 'pw-t03-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    args: ['--js-flags=--expose-gc', '--expose-gc'],
  });
  // Give the OS a moment to finish forking the browser's child processes
  // (GPU/network/renderer) before we go looking for them.
  await new Promise((r) => setTimeout(r, 500));
  const rootPid = findBrowserRootPid(process.pid);

  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[page]', msg.text());
  });
  page.on('crash', () => console.error('[page] CRASHED'));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__harnessLoaded === true, null, { timeout: 30_000 });
  await page.evaluate(() => window.__ready);

  const baselineRssKB = treeRssKB(rootPid, readProcessTable());
  const baselineWasmBytes = await page.evaluate(() => window.__wasmBytes());
  console.log(`baseline: wasm heap ${fmtMB(baselineWasmBytes)} MB, tab RSS ${(baselineRssKB / 1024).toFixed(1)} MB`);

  const rampSizes = [
    [800, 600], // 0.48 MP warm-up
    [1600, 1200], // 1.92 MP — matches the Node measurement this test supersedes
    [3000, 2000], // 6 MP
    [4000, 3000], // 12 MP — typical phone photo (A1)
    [6000, 4000], // 24 MP
    [7000, 5000], // 35 MP
    [8000, 6000], // 48 MP — the >40 MP requirement
    [10000, 8000], // 80 MP — push past the requirement to see scaling
  ];

  const rows = [];
  let crashed = false;
  let crashedAt = null;

  async function runImage(width, height, label) {
    const megapixels = (width * height) / 1_000_000;
    let evalResult;
    let peakKB;
    try {
      ({ result: evalResult, peakKB } = await withPeakRss(rootPid, () =>
        page.evaluate(([w, h]) => window.__runOne(w, h), [width, height]),
      ));
    } catch (err) {
      crashed = true;
      crashedAt = { label, width, height, megapixels, error: String(err) };
      console.error(`FAILED at ${label} (${width}x${height}, ${megapixels.toFixed(1)} MP): ${err}`);
      return false;
    }
    const settledRssKB = treeRssKB(rootPid, readProcessTable());
    const row = {
      label,
      width,
      height,
      megapixels: Number(megapixels.toFixed(2)),
      wasmBeforeMB: Number(fmtMB(evalResult.before)),
      wasmPeakMB: Number(fmtMB(evalResult.peak)),
      wasmAfterDisposeMB: Number(fmtMB(evalResult.afterDispose)),
      wasmAfterGcMB: Number(fmtMB(evalResult.afterGc)),
      tabRssPeakMB: Number((peakKB / 1024).toFixed(1)),
      tabRssSettledMB: Number((settledRssKB / 1024).toFixed(1)),
    };
    rows.push(row);
    console.log(
      `${label.padEnd(28)} ${String(width).padStart(6)}x${String(height).padEnd(6)} ` +
        `${row.megapixels.toString().padStart(6)} MP | wasm before ${row.wasmBeforeMB.toFixed(0).padStart(5)} ` +
        `peak ${row.wasmPeakMB.toFixed(0).padStart(5)} afterDispose ${row.wasmAfterDisposeMB.toFixed(0).padStart(5)} ` +
        `afterGc ${row.wasmAfterGcMB.toFixed(0).padStart(5)} MB | tab RSS peak ${row.tabRssPeakMB.toFixed(0).padStart(6)} ` +
        `settled ${row.tabRssSettledMB.toFixed(0).padStart(6)} MB`,
    );
    return true;
  }

  console.log('\n=== Phase 1: increasing size ramp (single pass, disposing between each) ===');
  for (const [w, h] of rampSizes) {
    const ok = await runImage(w, h, `ramp ${w}x${h}`);
    if (!ok) break;
  }

  // Phase 2: repeat the largest >40MP size many times in the SAME page/tab.
  // This is the test that actually distinguishes "grew because a bigger
  // image needed more headroom" (expected, not a leak) from "keeps growing
  // every time even at a constant working-set size" (a real leak) — see
  // docs/task-notes/T03.md for the reasoning. Also the mechanism by which we
  // find a failure threshold if one exists.
  const STRESS_SIZE = [8000, 6000]; // 48 MP
  const STRESS_REPEATS = 25;
  let stressCompleted = 0;
  if (!crashed) {
    console.log(`\n=== Phase 2: repeat ${STRESS_SIZE[0]}x${STRESS_SIZE[1]} (48 MP) x${STRESS_REPEATS} in one tab ===`);
    for (let i = 1; i <= STRESS_REPEATS; i++) {
      const ok = await runImage(STRESS_SIZE[0], STRESS_SIZE[1], `stress #${i}`);
      if (!ok) break;
      stressCompleted = i;
    }
  }

  const finalWasmBytes = crashed ? null : await page.evaluate(() => window.__wasmBytes()).catch(() => null);
  const finalRssKB = (() => {
    try {
      return treeRssKB(rootPid, readProcessTable());
    } catch {
      return null;
    }
  })();

  await context.close().catch(() => {});
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });

  const output = {
    baselineWasmMB: Number(fmtMB(baselineWasmBytes)),
    baselineRssMB: Number((baselineRssKB / 1024).toFixed(1)),
    rows,
    crashed,
    crashedAt,
    stressRepeatsRequested: STRESS_REPEATS,
    stressRepeatsCompleted: stressCompleted,
    finalWasmMB: finalWasmBytes != null ? Number(fmtMB(finalWasmBytes)) : null,
    finalRssMB: finalRssKB != null ? Number((finalRssKB / 1024).toFixed(1)) : null,
  };
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(output, null, 2));
  console.log('\nResults written to results.json');
  console.log(crashed ? `\nCRASHED at ${JSON.stringify(crashedAt)}` : '\nCompleted without crash.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
