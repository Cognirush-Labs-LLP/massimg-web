# AGENTS.md

Instructions for any agent (or human) working in this repository.

## What this is

A client-side, local-processing web app for batch image compression, resizing, format conversion and
single-image cropping. No server, no accounts — everything happens in the browser. See
`docs/functional-design.md` for the full product spec.

## Read these first, in order

1. `docs/functional-design.md` — requirements (`R-xx` IDs), UI behaviour, principles.
2. `docs/technical-design.md` — architecture, stack, module structure, the sections tasks point at.
3. `docs/assumptions.md` — the Assumptions Register (`A1`, `B4`, `D7`, ...). Anything below 75%
   confidence has a fallback documented against it.
4. `docs/tasks.md` — the sequential build plan. **Start here for "what do I do next."**

## Working through `docs/tasks.md`

Tasks run in order; a task's dependencies are always earlier in the list. Before starting a task:

1. Read `docs/functional-design.md` for every requirement ID the task names.
2. Read the `docs/technical-design.md` section(s) the task names.
3. Read the handover notes (`docs/task-notes/T<nn>.md`) of the two or three most recently completed
   tasks — not all of them.

A task is finished only when its **Done when** conditions all hold *and* its handover note
(`docs/task-notes/T<nn>.md`) is written, using the template in `docs/tasks.md`.

### Rules (from `docs/tasks.md` — do not weaken these)

- **The UI mockup is a reference, not a spec.** `docs/sample_design/` (see its README) is a click-through
  prototype made early, with simulated compression, that predates and does not fully track
  `docs/functional-design.md` / `docs/technical-design.md`. Use it for layout, colour, type, spacing and
  interaction behaviour where the design docs are silent, but where it conflicts with them — including
  changes made to the design docs after the mockup was created — the design docs win.
- **Do not invent requirements.** If the design documents don't answer a question, that's not yours to
  decide silently. Small implementation choices go in the handover note under "Decisions made." Anything
  that changes user-visible behaviour is a blocker: stop, write the note with status `blocked`, and state
  the question.
- **When measurement contradicts the Assumptions Register, update it.** It's a living document — change
  the entry in place, record new confidence and evidence, note it under "Surprises." If a failed
  assumption invalidates a Technical Design decision, say so rather than quietly working around it.
- **Principles outrank requirements** (Functional Design §1.4). A requirement that conflicts with a
  principle is wrong — flag it, don't implement it.
- **Tests are part of the task, not a later task.** A task that adds a pure function adds its unit tests.
  There is no cleanup phase at the end of the list.

## Repository layout

```
docs/
  functional-design.md
  technical-design.md
  assumptions.md
  tasks.md
  task-notes/          T01.md, T02.md, ... — one handover note per completed task
  sample_design/        imported Claude Design prototype — visual/interaction reference only, see its README
3rd_party_licenses/    one directory per bundled component (populated by T06)
src/                   application code — see docs/technical-design.md §2 for the module structure
verification/          Phase 0 throwaway harnesses (T01, T02, T03), each its own package.json
tests/                 permanent browser/e2e test suite, added from T05 onward
LICENSE                AGPL v3 (added by T06)
```

`src/` is currently just the skeleton from `docs/technical-design.md` §2 (empty directories). The actual
Vite/Vue/TypeScript/Pinia/Vitest scaffold is task **T04** — nothing is installed yet, and
`npm run check` / `npm test` intentionally fail until then.

## Stack (once T04 is done)

TypeScript (`strict`, `noUncheckedIndexedAccess`), Vue 3 (`<script setup>`), Vite, Pinia, Vitest,
Playwright (Chromium/Firefox/WebKit), Prettier, ESLint, `vue-tsc`. Full rationale in
`docs/technical-design.md` §1.

**Package manager: pnpm.** Not specified by the design docs (they only name npm-style script names like
`npm run check` as the Done-when check, which any package manager satisfies) — this is a project
convention, not a requirement. Use `pnpm` for the root project and for each `verification/*` throwaway
project alike; keep script names generic (`check`, `test`) so the literal command works under either
`pnpm <script>` or `npm run <script>`.

Two rules specific to Vue, load-bearing throughout the codebase (technical-design.md §1.1):
- Binary data (`File`, `Blob`, `ArrayBuffer`, `ImageBitmap`) never enters a reactive Pinia store — keep
  it in a plain module-scope `Map`, or wrap with `markRaw`.
- Component boundaries follow the stage modes (Gallery/Preview/Edit/Processing); they're mounted
  exclusively so leaving a mode unmounts its state.

## Licensing

AGPL v3. Every bundled/statically-linked third-party component needs its own directory under
`3rd_party_licenses/` with real upstream licence text (T06). Don't add a dependency that can't be
licensed this way without flagging it first.

## Test/verification photo fixtures

Real photographs used for verification and testing (e.g. T02's twenty real photographs, other tasks'
fixture sets) live **outside the repo**, on disk at a path given by the user. The path is read from a
`.env` file at the repo root (gitignored, never committed) — see `.env.example` for the variable name.

- **Never modify, move, rename or delete anything in that directory.** Treat it as strictly read-only
  source material. Copy files out of it if a task needs to place a fixture somewhere in-repo; never
  write into it or run tools against it in place with `--fix`/in-place-edit flags.
  If a fixture set is being assembled into the repo (e.g. under a `verification/t02-.../fixtures/`
  copy), copy from that directory rather than referencing it directly, so the verification project
  doesn't depend on a path that only exists on one machine.
- **Never commit the directory itself, its path, or its contents.** The `.env` file that holds the path
  is gitignored. Don't hardcode the absolute path in committed source, scripts, or handover notes.

## Version control — do not commit

Agents working in this repo **do not run `git commit`, `git add`/`git stage` (or `git push`)**, even
at the end of a completed task. Leave changes as working-tree edits and tell the user what's ready;
the user stages and commits manually. This holds regardless of general instructions elsewhere that
assume staging/committing is fine once approved — in this repo it isn't, unless the user explicitly
says so for that specific action in the moment.

Instead, once a task's changes are ready for review, propose a short commit message (don't commit)
following `docs/commit-guide.md`, so the user can verify the implementation and commit it themselves
if it looks good. Keep it to the one-line `type: Short description` form unless the change genuinely
needs the longer body format.

## English variant to use in documentation and code
Use US English in code and documentation.

## CLAUDE.md

`CLAUDE.md` just points here — this file is the single source of truth for agent instructions.
