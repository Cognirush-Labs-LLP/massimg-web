# CLAUDE.md

See [AGENTS.md](AGENTS.md) for all instructions on working in this repository.

## Claude-specific: sub-agent usage

This section is specific to Claude Code's sub-agent/Task tooling — other coding agents working in
this repo have no equivalent mechanism, so it stays out of `AGENTS.md`.

Default to doing work directly, in the current session, rather than delegating it. Before spawning a
sub-agent, all of the following must hold:

- **Its output is a self-contained verdict** you can act on directly — pass/fail, a location list, a
  measurement, review findings — not raw material you'll still need to read yourself to do precise,
  coupled work afterward. If you'd end up re-reading the same files during implementation anyway,
  skip the agent and read them directly from the start.
- **The work is genuinely decoupled** from anything else currently in flight. A data shape or type
  threaded through multiple files you're also touching is coupled, even if each piece looks like
  independent "research" in isolation — don't split that across agents.

Splitting a task into a separate follow-up task/session is not automatic just because a chunk is
independent — it's worth doing when a chunk is *also* large/significant enough that a checkpoint
helps. That's a call to put to the user, not one to make unilaterally. Small independent sub-pieces
are still just done serially, in the same session.

When a mode or skill's built-in workflow (e.g. plan mode's default use of Explore/Plan agents)
conflicts with an explicit instruction the user has given about sub-agent use, flag the conflict and
ask — do not resolve it yourself in the tool's favor.
