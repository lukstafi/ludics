# Codex coordinator, CLI workers

A Codex coordinator launches and supervises CLI workers, Claude or Codex, with the same
`fleet-worker.sh` verbs as a Claude Code coordinator, so [cli-claude.md](cli-claude.md) holds for
it whole: the launch and its refusals, the brief, the workers' own blocking, supervising,
intervening and close-out. This file is the delta, and the delta is the wake (#159's decision).

## The wake

`cli-claude.md`'s supervision rests on a Claude Code coordinator's background task: `attach`, the
driver, the heartbeat and each loop run with Bash `run_in_background`, and a command's exit
re-invokes the coordinator. A Codex coordinator has no such notification. A command it leaves
running in the background wakes nobody when it exits, so each of those waits is held by the
coordinator's own turn instead:

- **A command the wave waits on runs in a managed foreground session**, observed until it exits,
  as [native-codex.md](native-codex.md#local-managed-command-sessions) says: `attach <box> <name>`
  for a worker you answer yourself, `fleet-worker.sh wave drive <wave.json>`, `wave heartbeat
  <wave.json>` and each `wave loop <wave.json> <name>` (coordinator-kit.md's steps 5, 6 and 9).
  Retain each session's ID across context compaction, and read its actual exit. A returned
  handle is launch evidence, never a verdict.
- **The heartbeat is the turn's pace.** `wave heartbeat` sleeps about ten minutes and returns
  early when the driver writes an attention line, so the coordinator's turn stays open on it,
  answers what it printed, and arms the next tick in the same turn. Where the runtime cannot keep
  a turn open that long, an authorized heartbeat (a scheduled re-invocation the user allowed)
  stands in for it, and every wake re-reads the board, the PRs and `logs/attention.jsonl` rather
  than acting on what the last turn knew.
- **One session per wait, not one per worker.** Under the driver no `attach` is needed for a
  CLI worker, Claude or Codex: the driver reads its turns. Hold an `attach` only for a worker
  whose turn is yours (a turn an attention line handed you, or every worker while no driver
  runs).

A run the coordinator itself starts (an integration `tip-run`, a `bg-run.sh` record) takes the
same managed foreground shape, with `bg-run.sh new` and `start` in place of `spawn`
([native-codex.md](native-codex.md#local-managed-command-sessions) says why: local `spawn`
records died under a Codex runtime in the 2026-10-04 wave).

## Paths

The scripts are the served checkout's, `~/ludics/issue-wave/scripts/fleet-worker.sh` and
`~/ludics/ship-pr/scripts/pr-review.sh`, which `~/.codex/skills/` links to once the README's Codex
loop has run on the box (`preflight` refuses a box without those links). A CLI worker's brief
names its own paths, whatever the coordinator's runtime.
