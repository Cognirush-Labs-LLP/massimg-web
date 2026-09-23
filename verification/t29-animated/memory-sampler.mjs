// Adapted from verification/t20-thumbnails/memory-sampler.mjs (T20) — same technique, same
// engine-agnostic proxy for peak WASM memory (docs/task-notes/T01.md "Decisions made": `ps`, sampled
// on an interval, over in-page APIs like performance.memory (Chrome-only) or a manual OS task
// manager). One real fix on top of T20's version, found while building this harness: **WebKit's own
// XPC services (WebContent, GPU, Networking — the processes that actually run page JS and hold the
// WASM heap) are reparented to PID 1 on macOS**, not left as children of the launched browser
// process, so a pure ppid-tree walk from `rootPid` silently sees none of them and reports a peak
// indistinguishable from the idle baseline. Confirmed directly: `ps -A -o pid=,ppid=,command=`
// during a live WebKit launch shows `com.apple.WebKit.WebContent.xpc` (100+ MB RSS) with `ppid=1`,
// while only the `Playwright`/`pw_run.sh` wrapper processes carry the real parent chain. The fix
// below unions the ppid-tree walk with every *orphaned* (ppid=1) process whose executable path sits
// under the same browser-install directory as `rootPid` — safe for Chromium/Firefox too, since their
// own children are already reachable via ppid and this only ever adds processes, never double-counts
// (a `Set` of matched pids dedupes). T20's C5 numbers were produced with the un-fixed version and
// were not re-measured here — this is worth revisiting if a future task leans on C5's WebKit figures.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';

const execFileP = promisify(execFile);

async function readProcessTable() {
  // pid, ppid, rss(KB), command — works on macOS/BSD and Linux ps alike. `command=` must be last:
  // it can contain spaces and ps does not quote it.
  const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,rss=,command=']);
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, pid, ppid, rss, command] = match;
    rows.push({ pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss), command });
  }
  return rows;
}

// Playwright's browser cache is always laid out as `<cache>/ms-playwright/<engine>-<build>/...`
// (confirmed live: `~/Library/Caches/ms-playwright/webkit-2359/Playwright.app/Contents/MacOS/
// Playwright` for the root process and `~/Library/Caches/ms-playwright/webkit-2359/
// com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development` for the
// orphaned WebContent process) — so this is the one directory both are guaranteed to share,
// regardless of how deep either executable sits inside an `.app` bundle, which a fixed number of
// `dirname()` calls is not (that was the first, wrong version of this fix: two `dirname()` calls
// from WebKit's 5-segment-deep bundle path landed on `.../Playwright.app/Contents`, never matching
// the sibling `.../com.apple.WebKit.WebContent.xpc/...` path at all).
const PLAYWRIGHT_INSTALL_DIR = /^(.*\/ms-playwright\/[^/]+\/)/;

function installDirOf(command) {
  const tokens = command.trim().split(/\s+/);
  let exe = tokens[0];
  // `rootPid` here is frequently Playwright's own `pw_run.sh` launcher, invoked as `bash
  // <script-path> <args>` rather than run directly — its first token is just "bash", which carries
  // no install-directory information at all. The script path is the second token in that case.
  if (exe && /(^|\/)(bash|sh|zsh)$/.test(exe) && tokens[1]) {
    exe = tokens[1];
  }
  if (!exe) return null;
  const match = PLAYWRIGHT_INSTALL_DIR.exec(exe);
  // Falls back to one directory up, which at least keeps same-directory siblings grouped when the
  // browser isn't installed under Playwright's own cache (e.g. a system browser in CI).
  return match ? match[1] : dirname(exe);
}

function sumTreeRssBytes(rows, rootPid) {
  const childrenByPpid = new Map();
  for (const row of rows) {
    if (!childrenByPpid.has(row.ppid)) childrenByPpid.set(row.ppid, []);
    childrenByPpid.get(row.ppid).push(row);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const root = byPid.get(rootPid);
  if (!root) return 0;

  const matched = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (matched.has(pid)) continue;
    matched.add(pid);
    for (const child of childrenByPpid.get(pid) || []) stack.push(child.pid);
  }

  // The WebKit fix: orphaned (ppid=1) processes whose executable sits under the same
  // `ms-playwright/<engine>-<build>/` install directory as the root.
  const rootInstallDir = installDirOf(root.command);
  if (rootInstallDir) {
    for (const row of rows) {
      if (row.ppid !== 1 || matched.has(row.pid)) continue;
      if (installDirOf(row.command) === rootInstallDir) {
        matched.add(row.pid);
      }
    }
  }

  let totalKb = 0;
  for (const pid of matched) {
    const row = byPid.get(pid);
    if (row) totalKb += row.rssKb;
  }
  return totalKb * 1024;
}

export class MemorySampler {
  constructor(rootPid, intervalMs = 200) {
    this.rootPid = rootPid;
    this.intervalMs = intervalMs;
    this.samples = [];
    this.peakBytes = 0;
    this._running = false;
    this._timer = null;
  }

  start() {
    this._running = true;
    this._startedAt = Date.now();
    const tick = async () => {
      if (!this._running) return;
      try {
        const rows = await readProcessTable();
        const bytes = sumTreeRssBytes(rows, this.rootPid);
        const t = Date.now() - this._startedAt;
        this.samples.push({ t, bytes });
        if (bytes > this.peakBytes) this.peakBytes = bytes;
      } catch {
        // A transient ps failure shouldn't kill the run; just skip this sample.
      }
      if (this._running) this._timer = setTimeout(tick, this.intervalMs);
    };
    tick();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    return { peakBytes: this.peakBytes, sampleCount: this.samples.length, samples: this.samples };
  }
}
