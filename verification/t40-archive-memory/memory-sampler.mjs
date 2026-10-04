import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Sums resident memory (RSS) across a browser's full process tree — the browser
// process itself plus every descendant (renderer/GPU/network/utility processes,
// however that engine splits them). Browsers are multi-process, and the tab we
// care about could be any one of several children, so summing the whole tree is
// the only engine-agnostic proxy that doesn't depend on knowing each engine's
// internal process layout. Implemented via `ps`, sampled on an interval — see
// docs/task-notes/T01.md "Decisions made" for why this approach was chosen over
// in-page APIs like performance.memory (Chrome-only) or the OS task manager
// (manual, not automatable).
async function readProcessTable() {
  // pid, ppid, rss(KB), no header — works on macOS/BSD and Linux ps alike.
  const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, rss] = parts;
    rows.push({ pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss) });
  }
  return rows;
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
  let totalKb = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row) totalKb += row.rssKb;
    for (const child of childrenByPpid.get(pid) || []) stack.push(child.pid);
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
