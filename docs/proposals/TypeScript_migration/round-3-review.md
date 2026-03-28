# Code Review (Round 3)

## Summary
Round 2 blocking issues were addressed correctly:
- `tasks queue-elaborations` now calls the queueing implementation (`src/tasks/index.ts:346`).
- `slot <n> clear <status>` now validates allowed statuses (`src/slots/index.ts:377`).
- `tasks migrate-refs` was removed from help output (`src/index.ts:56`).

I also re-ran behavior checks in an isolated temp HOME:
- `tasks queue-elaborations` now creates `mayor/queue.jsonl`.
- `slot 1 clear invalid` now exits non-zero with a clear error.

## Issues Found
- [ ] Installation flow in README is now broken against current repo layout (severity: high)
  `README.md` still instructs `./bin/pai-lite init` as the primary install step (`README.md:20`, `README.md:23`).
  In this round, `bin/pai-lite` is deleted from tracked files (staged deletion), and the built binary is ignored (`.gitignore:3`). On a fresh checkout, `./bin/pai-lite` does not exist until after `bun run build`, and even then `init` is not migrated (`src/index.ts:134`), so the documented install path fails.

## Suggestions
- Update README installation section to match the current migration state:
  1. install Bun
  2. run `bun install && bun run build`
  3. use only currently migrated commands, and explicitly mark `init` as not yet migrated (or provide a temporary bootstrap path if you want install instructions to keep working).
- Keep MIGRATION/README synchronized whenever a command is intentionally unavailable during phased migration.

## Verdict
**REQUEST_CHANGES**

Please align the installation instructions with the current executable/command reality before approval.
