// T40 harness driver — assumption E1 (docs/assumptions.md), required by docs/task-notes/T40.md.
//
// For each of {chromium, firefox, webkit}:
//   1. Stream `ENTRY_COUNT` distinct synthetic entries of `ENTRY_SIZE` bytes each through
//      client-zip's makeZip(), piped straight into a real OPFS file (public/index.html).
//   2. Sample the browser's full OS process-tree RSS every 200ms throughout, and record the peak.
//
// Pass condition (E1's own "Method"): peak stays near the largest single entry, not anywhere close
// to the full archive total — across *many* entries, which is what distinguishes this from T01's B4
// measurement (one large contiguous write, not an incrementally-assembled ZIP of many entries).
//
// Output: prints a summary table and writes results.json next to this file.

import { chromium, firefox, webkit } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from './server.mjs';
import { MemorySampler } from './memory-sampler.mjs';

const execFileP = promisify(execFile);

// See t01-opfs-memory/run.mjs's identical function for why launchPersistentContext + a `ps`-based
// pid lookup, rather than launch()/launchServer(): WebKit's ephemeral/default context has no OPFS
// backing at all (T01), so a real, disk-backed profile is required for every engine here too.
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

// T40_QUICK=1 runs a small smoke pass to validate the pipeline before committing to the full,
// multi-gigabyte run, which takes much longer and needs real disk headroom.
const ENTRY_SIZE = 16 * 1024 * 1024; // 16 MB — well above a typical compressed photo, deliberately
const ENTRY_COUNT = process.env.T40_QUICK ? 8 : 200; // quick: 128 MB total; full: ~3.2 GB, many entries

const ENGINES = { chromium, firefox, webkit };
const SAMPLE_INTERVAL_MS = 200;
const PHASE_TIMEOUT_MS = 10 * 60 * 1000;

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
  const userDataDir = await mkdtemp(path.join(tmpdir(), `t40-udd-${engineName}-`));
  let context;
  try {
    context = await launcher.launchPersistentContext(userDataDir, { headless: true });
    const rootPid = await findRootPid(userDataDir, process.pid);
    if (!rootPid) throw new Error('could not locate browser process pid via ps');
    const page = context.pages()[0] || (await context.newPage());
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log(`  [${engineName} console error]`, msg.text());
    });
    page.on('pageerror', (err) => console.log(`  [${engineName} page error]`, err.message));

    await page.goto(baseUrl, { waitUntil: 'load' });

    const entry = {
      engine: engineName,
      entryCount: ENTRY_COUNT,
      entrySize: ENTRY_SIZE,
      totalBytes: ENTRY_COUNT * ENTRY_SIZE,
    };
    results.push(entry);

    const idleSampler = new MemorySampler(rootPid, SAMPLE_INTERVAL_MS);
    idleSampler.start();
    await new Promise((r) => setTimeout(r, 1000));
    const idle = idleSampler.stop();
    entry.idleBaselineBytes = idle.peakBytes;

    const writeSampler = new MemorySampler(rootPid, SAMPLE_INTERVAL_MS);
    writeSampler.start();
    let writeError = null;
    const writeStart = Date.now();
    try {
      await withTimeout(
        page.evaluate(
          ({ count, size }) => window.runZipWrite(count, size),
          { count: ENTRY_COUNT, size: ENTRY_SIZE },
        ),
        PHASE_TIMEOUT_MS,
        'zip write',
      );
    } catch (err) {
      writeError = String(err && err.message ? err.message : err);
    }
    const writeMs = Date.now() - writeStart;
    const writeMem = writeSampler.stop();
    entry.write = { ok: !writeError, error: writeError, durationMs: writeMs, peakBytes: writeMem.peakBytes };
    console.log(
      `  write: ${entry.write.ok ? 'ok' : 'FAILED: ' + writeError} in ${writeMs}ms, ` +
        `peak RSS ${fmtBytes(writeMem.peakBytes)}, idle baseline ${fmtBytes(idle.peakBytes)}`,
    );

    if (!writeError) {
      try {
        entry.confirmedFileSize = await page.evaluate(() => window.opfsFileSize());
      } catch {
        // non-fatal
      }
    }

    await page.evaluate(() => window.opfsCleanup()).catch(() => {});
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
  console.log(`${ENTRY_COUNT} entries x ${fmtBytes(ENTRY_SIZE)} = ${fmtBytes(ENTRY_COUNT * ENTRY_SIZE)} total`);
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
  console.log('engine'.padEnd(10) + 'total'.padEnd(10) + 'peak'.padEnd(12) + 'idle-baseline'.padEnd(16) + 'duration');
  for (const r of results) {
    if (r.fatalError) {
      console.log(`${r.engine.padEnd(10)}FATAL: ${r.fatalError}`);
      continue;
    }
    console.log(
      r.engine.padEnd(10) +
        fmtBytes(r.totalBytes).padEnd(10) +
        fmtBytes(r.write.peakBytes).padEnd(12) +
        fmtBytes(r.idleBaselineBytes).padEnd(16) +
        `${r.write.durationMs}ms` +
        (r.write.ok ? '' : `  FAILED: ${r.write.error}`),
    );
  }
  console.log('\nFull results written to results.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
