# T40 — streaming archive memory (E1)

Settles assumption **E1** (`docs/assumptions.md`): does streaming many entries through
`client-zip`'s `makeZip()` into an OPFS file (Technical Design §9.1's exact mechanism) hold memory
near one entry, or does the ZIP writer itself buffer entries, retain previously-written entries'
bytes, or grow a central directory in memory?

T01 already showed that writing one large contiguous blob into OPFS holds bounded memory — this
harness is the distinct test E1's own entry says is still needed: a ZIP assembled incrementally
from **many separate entries**, which says nothing about whether entries themselves pile up.

## Running it

```sh
cd verification/t40-archive-memory
npm install
npm run install-browsers
npm test            # full run: 200 x 16 MB = ~3.2 GB
T40_QUICK=1 npm test # smoke run: 8 x 16 MB = 128 MB
```

Prints a summary table and writes `results.json` next to this file.

## What it measures

`public/index.html` builds `ENTRY_COUNT` distinct `Uint8Array`s (deliberately not one buffer reused
— see its own comment on why that would hide the exact bug being tested for), feeds them through a
real `client-zip` `makeZip()` call via an async generator (so only one entry is ever in flight, the
same shape the real pipeline hands results to `pipeline/run-archive.ts`'s sink), and pipes the
resulting stream into a real OPFS file via `createWritable`. `run.mjs` samples the browser's full
OS process-tree RSS throughout (`memory-sampler.mjs`, identical to T01's) and records the peak
against the idle baseline immediately before.

Pass condition, per E1's own "Method": peak stays near the largest single entry (16 MB here), not
anywhere close to the ~3.2 GB total.
