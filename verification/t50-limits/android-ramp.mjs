// T50 — stepped-size ramp through the real pipeline on a real Android phone.
//
// The app's dev server runs on this machine and is reached from the phone over `adb reverse`; the
// phone's own Chrome is driven over CDP (`adb forward ... chrome_devtools_remote`). Each step runs in
// a fresh tab so one step's WASM heap cannot leak into the next. While a job runs, a sampler reads
// the summed PSS/RSS of Chrome's sandboxed (renderer) processes and the device's MemAvailable via
// `dumpsys meminfo`; a tab that dies is reported rather than retried.
//
//   adb reverse tcp:5173 tcp:5173; adb reverse tcp:8790 tcp:8790
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   (pnpm vite --port 5173 --strictPort in the repo root)
//   node android-ramp.mjs [stepIdPrefix]
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { startServer } from './server.mjs';

const run = promisify(execFile);
const APP = 'http://localhost:5173/';
const FIXTURES = 'http://localhost:8790/fixtures/android/';
const STEP_TIMEOUT_MS = 300_000;
const WHITE = { r: 255, g: 255, b: 255, a: 255 };
const ROTATE = { ops: [{ kind: 'rotate', quarterTurns: 1 }], version: 1 };

const STEPS = [
  ...[12, 24, 36, 50, 52].map((n) => ({ id: `jpeg-${n}mp`, fixture: `rgb-${n}mp.png`, settings: { format: 'jpeg' } })),
  ...[36, 50, 52].map((n) => ({ id: `jpeg-rotate-${n}mp`, fixture: `rgb-${n}mp.png`, settings: { format: 'jpeg' }, edit: ROTATE })),
  { id: 'jpeg-rgba-50mp', fixture: 'rgba-50mp.png', settings: { format: 'jpeg', alpha: { kind: 'flatten', background: WHITE } } },
  { id: 'webp-24mp', fixture: 'rgb-24mp.png', settings: { format: 'webp' } },
  { id: 'webp-50mp', fixture: 'rgb-50mp.png', settings: { format: 'webp' } },
  { id: 'png-24mp', fixture: 'rgba-24mp.png', settings: { format: 'png' } },
  { id: 'png-50mp', fixture: 'rgba-50mp.png', settings: { format: 'png' } },
  { id: 'avif-12mp', fixture: 'rgb-12mp.png', settings: { format: 'avif' } },
  { id: 'avif-24mp', fixture: 'rgb-24mp.png', settings: { format: 'avif' } },
  { id: 'avif-50mp', fixture: 'rgb-50mp.png', settings: { format: 'avif' } },
  { id: 'anim-webp-35m', fixture: 'anim-590x100.gif', settings: { format: 'webp', isAnimated: true, sourceFormat: 'gif' } },
  { id: 'anim-gif-35m', fixture: 'anim-590x100.gif', settings: { format: 'gif', isAnimated: true, sourceFormat: 'gif' } },
  { id: 'over-cap-53mp', fixture: 'rgb-53mp.png', settings: { format: 'jpeg' }, expectFailure: true },
  { id: 'over-cap-anim-300m', fixture: 'anim-1000x300.gif', settings: { format: 'webp', isAnimated: true, sourceFormat: 'gif' }, expectFailure: true },
];

const SAMPLE = `for p in $(ps -A | grep sandboxed_process | while read u pid rest; do echo $pid; done); do echo "P $p $(dumpsys meminfo -s $p | grep 'TOTAL PSS')"; done; grep MemAvailable /proc/meminfo`;

async function sampleOnce() {
  const { stdout } = await run('adb', ['shell', SAMPLE]);
  let pss = 0, rss = 0, available = null;
  for (const line of stdout.split('\n')) {
    const m = line.match(/TOTAL PSS:\s*(\d+)\s+TOTAL RSS:\s*(\d+)/);
    if (m) { pss += Number(m[1]); rss += Number(m[2]); }
    const a = line.match(/MemAvailable:\s*(\d+)/);
    if (a) available = Number(a[1]);
  }
  return { pssMB: pss / 1024, rssMB: rss / 1024, availableMB: available === null ? null : available / 1024 };
}

function startSampler() {
  let stop = false;
  const samples = [];
  const loop = (async () => {
    while (!stop) {
      try { samples.push(await sampleOnce()); } catch { /* a process may exit between listing and reading */ }
    }
  })();
  return async () => { stop = true; await loop; return samples; };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function settle() {
  await new Promise((r) => setTimeout(r, 3000));
  const s = [];
  for (let i = 0; i < 3; i++) s.push(await sampleOnce());
  return { pssMB: median(s.map((x) => x.pssMB)), rssMB: median(s.map((x) => x.rssMB)), availableMB: median(s.map((x) => x.availableMB)) };
}

async function runStep(context, step) {
  const page = await context.newPage();
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  const record = { id: step.id, fixture: step.fixture };
  try {
    await page.goto(APP, { waitUntil: 'load' });
    record.device = await page.evaluate(async () => {
      const { detectMobile } = await import('/src/platform/device.ts');
      const { resolveCodecLimits } = await import('/src/config/limits.ts');
      const mobile = detectMobile();
      return { mobile, cacheMiB: resolveCodecLimits(mobile).cacheBytes / 1048576, maximumImagePixels: resolveCodecLimits(mobile).maximumImagePixels };
    });
    record.before = await settle();
    const stopSampler = startSampler();
    const started = Date.now();
    const outcome = await Promise.race([
      page.evaluate(async ({ url, settings, edit }) => {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const { createWorkerPool } = await import('/src/pipeline/pool.ts');
        const pool = createWorkerPool({ size: 1 });
        const t0 = performance.now();
        const done = await pool.run({
          imageId: 'ramp',
          source: bytes,
          edit: edit ?? null,
          settings: { quality: { kind: 'quality', value: 80, lossless: false }, dimension: { kind: 'original' }, format: 'jpeg', isAnimated: false, sourceFormat: 'png', alpha: { kind: 'preserve' }, ...settings },
          intent: 'run',
        }).done;
        const ms = Math.round(performance.now() - t0);
        pool.destroy();
        return { outcome: done.outcome, reason: done.reason && done.reason.kind, outputBytes: done.result && done.result.bytes ? done.result.bytes.byteLength : null, ms };
      }, { url: FIXTURES + step.fixture, settings: step.settings, edit: step.edit }),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), STEP_TIMEOUT_MS)),
    ]).catch((err) => ({ pageError: String(err.message || err).slice(0, 160) }));
    const samples = await stopSampler();
    record.wallMs = Date.now() - started;
    record.result = crashed ? { crashed: true, ...outcome } : outcome;
    record.peak = samples.length ? {
      pssMB: Math.max(...samples.map((s) => s.pssMB)),
      rssMB: Math.max(...samples.map((s) => s.rssMB)),
      minAvailableMB: Math.min(...samples.map((s) => s.availableMB ?? Infinity)),
      samples: samples.length,
    } : null;
    if (record.peak) record.peak.growthPssMB = record.peak.pssMB - record.before.pssMB;
  } catch (err) {
    record.result = { harnessError: String(err.message || err).slice(0, 200), crashed };
  }
  await page.close().catch(() => {});
  record.after = await settle().catch(() => null);
  return record;
}

const only = process.argv[2];
const stayOn = await run('adb', ['shell', 'svc', 'power', 'stayon', 'usb']).catch(() => null);
const { server } = await startServer(8790);
const browser = await chromium.connectOverCDP('http://localhost:9222');
const context = browser.contexts()[0];
const outPath = new URL('./android-results.json', import.meta.url);
const results = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : [];

for (const step of STEPS.filter((s) => !only || s.id.startsWith(only))) {
  const r = await runStep(context, step);
  const i = results.findIndex((x) => x.id === r.id);
  if (i >= 0) results.splice(i, 1, r); else results.push(r);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  const o = r.result || {};
  const verdict = o.crashed ? 'TAB CRASHED' : o.timeout ? 'TIMEOUT' : o.harnessError ? `harness: ${o.harnessError}` : o.pageError ? `page: ${o.pageError}` : `${o.outcome}${o.reason ? ' (' + o.reason + ')' : ''} ${o.ms}ms out=${o.outputBytes ?? '-'}B`;
  console.log(`${step.id.padEnd(22)} ${verdict.padEnd(46)} peakPSS=${r.peak ? r.peak.pssMB.toFixed(0) : '-'}MB (+${r.peak ? r.peak.growthPssMB.toFixed(0) : '-'}) minAvail=${r.peak ? r.peak.minAvailableMB.toFixed(0) : '-'}MB`);
}
await browser.close().catch(() => {});
server.close();
void stayOn;
