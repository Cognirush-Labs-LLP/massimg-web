// T01 harness driver — see docs/tasks.md T01 and docs/task-notes/T01.md.
//
// For each of {chromium, firefox, webkit} x {1 GB, 3 GB}:
//   1. Write the target size into an OPFS file in 32 MB chunks (public/index.html).
//   2. Trigger a download of the finished file via createObjectURL + anchor click.
//   3. Sample the browser's full OS process-tree RSS every 200ms throughout each
//      phase and record the peak (memory-sampler.mjs).
//
// Output: prints a summary table and writes results.json next to this file.

import { chromium, firefox, webkit } from 'playwright';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from './server.mjs';
import { MemorySampler } from './memory-sampler.mjs';

const execFileP = promisify(execFile);

// Finds the OS pid of the browser process launchPersistentContext spawned, by
// matching the unique user-data-dir path against `ps` command lines among this
// Node process's direct children. See "Decisions made" in docs/task-notes/T01.md
// for why launchPersistentContext (not launch()/launchServer()+connect()) is
// used: WebKit's ephemeral/default context has no OPFS backing at all (fails
// with UnknownError on navigator.storage.getDirectory()) — a real, disk-backed
// profile is required, and that only comes from launchPersistentContext, which
// in turn doesn't expose Browser.process() the way launchServer() does.
async function findRootPid(userDataDir, nodePid) {
  const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,command=']);
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, cmd] = m;
    if (Number(ppid) === nodePid && cmd.includes(userDataDir)) return Number(pid);
  }
  return null;
}

// T01_QUICK=1 runs a small smoke pass (tens of MB) to validate the pipeline
// before committing to the full 1 GB / 3 GB run, which takes much longer.
const SIZES = process.env.T01_QUICK
  ? [
      { label: '64 MB', bytes: 64 * 1024 * 1024 },
      { label: '192 MB', bytes: 192 * 1024 * 1024 },
    ]
  : [
      { label: '1 GB', bytes: 1 * 1024 * 1024 * 1024 },
      { label: '3 GB', bytes: 3 * 1024 * 1024 * 1024 },
    ];

const ENGINES = { chromium, firefox, webkit };

const SAMPLE_INTERVAL_MS = 200;
// Generous but bounded — a slow CI-like machine writing/downloading 3 GB should
// still finish well inside this; if it doesn't, that itself is worth knowing.
const PHASE_TIMEOUT_MS = 5 * 60 * 1000;

function fmtBytes(b) {
  if (b == null) return 'n/a';
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runEngine(engineName, launcher, baseUrl, results) {
  console.log(`\n=== ${engineName} ===`);
  const userDataDir = await mkdtemp(path.join(tmpdir(), `t01-udd-${engineName}-`));
  let context;
  try {
    context = await launcher.launchPersistentContext(userDataDir, {
      headless: true,
      acceptDownloads: true,
    });
    const rootPid = await findRootPid(userDataDir, process.pid);
    if (!rootPid) throw new Error('could not locate browser process pid via ps');
    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`  [${engineName} console error]`, msg.text());
    });
    page.on('pageerror', (err) => console.log(`  [${engineName} page error]`, err.message));

    await page.goto(baseUrl, { waitUntil: 'load' });

    for (const size of SIZES) {
      const entry = { engine: engineName, size: size.label, sizeBytes: size.bytes };
      results.push(entry);
      console.log(`-- ${size.label} --`);

      // Idle baseline immediately before the write phase, so peaks below can be
      // read as "peak" and "peak above idle" both.
      const idleSampler = new MemorySampler(rootPid, SAMPLE_INTERVAL_MS);
      idleSampler.start();
      await new Promise((r) => setTimeout(r, 1000));
      const idle = idleSampler.stop();
      entry.idleBaselineBytes = idle.peakBytes;

      // Phase 1: write
      const writeSampler = new MemorySampler(rootPid, SAMPLE_INTERVAL_MS);
      writeSampler.start();
      let writeResult;
      let writeError = null;
      const writeStart = Date.now();
      try {
        writeResult = await withTimeout(
          page.evaluate((n) => window.opfsWrite(n), size.bytes),
          PHASE_TIMEOUT_MS,
          'opfs write',
        );
      } catch (err) {
        writeError = String(err && err.message ? err.message : err);
      }
      const writeMs = Date.now() - writeStart;
      const writeMem = writeSampler.stop();
      entry.write = {
        ok: !writeError,
        error: writeError,
        durationMs: writeMs,
        peakBytes: writeMem.peakBytes,
        path: writeResult && writeResult.path,
      };
      console.log(
        `  write: ${entry.write.ok ? 'ok' : 'FAILED: ' + writeError} in ${writeMs}ms, peak RSS ${fmtBytes(writeMem.peakBytes)}, path=${entry.write.path}`,
      );

      if (!writeError) {
        try {
          const fileSize = await page.evaluate(() => window.opfsFileSize());
          entry.write.confirmedFileSize = fileSize;
        } catch {
          // non-fatal
        }
      }

      // Phase 2: download
      let downloadError = null;
      let downloadedBytes = null;
      let downloadMs = null;
      const downloadSampler = new MemorySampler(rootPid, SAMPLE_INTERVAL_MS);
      if (!writeError) {
        downloadSampler.start();
        const downloadStart = Date.now();
        try {
          const [download] = await withTimeout(
            Promise.all([page.waitForEvent('download'), page.evaluate(() => window.opfsDownload())]),
            PHASE_TIMEOUT_MS,
            'trigger+wait download event',
          );
          const savedPath = await withTimeout(download.path(), PHASE_TIMEOUT_MS, 'download.path()');
          downloadMs = Date.now() - downloadStart;
          if (savedPath) {
            const st = await stat(savedPath);
            downloadedBytes = st.size;
            await rm(savedPath, { force: true });
          }
        } catch (err) {
          downloadError = String(err && err.message ? err.message : err);
          downloadMs = Date.now() - downloadStart;
        }
      } else {
        downloadError = 'skipped: write phase failed';
      }
      const downloadMem = downloadSampler.stop();
      entry.download = {
        ok: !downloadError,
        error: downloadError,
        durationMs: downloadMs,
        peakBytes: downloadMem.peakBytes,
        confirmedBytes: downloadedBytes,
      };
      console.log(
        `  download: ${entry.download.ok ? 'ok' : 'FAILED: ' + downloadError} in ${downloadMs}ms, peak RSS ${fmtBytes(downloadMem.peakBytes)}, bytes=${fmtBytes(downloadedBytes)}`,
      );

      // Cleanup OPFS file before next size, so quota/disk doesn't accumulate and
      // the next phase starts from a clean slate.
      try {
        await page.evaluate(() => window.opfsCleanup());
      } catch {
        // non-fatal
      }
    }

    await context.close();
  } catch (err) {
    console.log(`  ${engineName} ERRORED entirely:`, err.message);
    results.push({ engine: engineName, fatalError: String(err.message || err) });
  } finally {
    if (context) await context.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const { server: httpServer, url } = await startServer();
  console.log(`serving harness at ${url}`);
  const results = [];
  try {
    for (const [name, launcher] of Object.entries(ENGINES)) {
      await runEngine(name, launcher, url, results);
    }
  } finally {
    httpServer.close();
  }

  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));

  console.log('\n\n=== Summary: peak RSS across full browser process tree ===');
  console.log(
    'engine'.padEnd(10) +
      'size'.padEnd(8) +
      'phase'.padEnd(10) +
      'peak'.padEnd(12) +
      'idle-baseline'.padEnd(16) +
      'duration',
  );
  for (const entry of results) {
    if (entry.fatalError) {
      console.log(`${entry.engine.padEnd(10)}FATAL: ${entry.fatalError}`);
      continue;
    }
    for (const phase of ['write', 'download']) {
      const p = entry[phase];
      if (!p) continue;
      console.log(
        entry.engine.padEnd(10) +
          entry.size.padEnd(8) +
          phase.padEnd(10) +
          fmtBytes(p.peakBytes).padEnd(12) +
          fmtBytes(entry.idleBaselineBytes).padEnd(16) +
          `${p.durationMs}ms` +
          (p.ok ? '' : `  FAILED: ${p.error}`),
      );
    }
  }
  console.log('\nFull results written to results.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
