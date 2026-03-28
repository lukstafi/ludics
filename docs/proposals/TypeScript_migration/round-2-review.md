# Code Review (Round 2)

## Summary
Round 1 feedback on Phase 0/1 was addressed: session CLI now includes `sessions refresh` and `sessions show`, JSON output exists (`--json` plus `sessions.json` artifact), and JSONL scanners now use bounded first-line reads (`src/sessions/read-lines.ts`).

Phase 2 introduced substantial TS replacements for slots/tasks/state/config and added adapter dispatch + journal/queue modules.

## Issues Found
- [ ] `tasks queue-elaborations` is a no-op regression (severity: high)
  In `src/tasks/index.ts`, the `queue-elaborations` case only calls `tasksNeedsElaboration()` (prints IDs) and does not queue requests (`src/tasks/index.ts:346`, `src/tasks/index.ts:349`).
  Repro: with a ready task needing elaboration, `pai-lite-ts tasks queue-elaborations` prints task IDs but does not create `mayor/queue.jsonl`.
- [ ] `slot <n> clear <status>` accepts invalid statuses (severity: medium)
  The new handler passes any third argument directly into `slotClear` without validation (`src/slots/index.ts:375`, `src/slots/index.ts:377`).
  Repro: `pai-lite-ts slot 1 clear invalid` exits 0 and clears the slot; previous behavior restricted to `ready|done|abandoned`.
- [ ] Help text advertises `tasks migrate-refs`, but command is removed (severity: low)
  Usage still lists `tasks migrate-refs` (`src/index.ts:56`), but `runTasks` has no `migrate-refs` case and throws unknown-subcommand (`src/tasks/index.ts:368`). If intentional per migration policy, usage text should be updated to avoid a dead command in help.

## Suggestions
- Wire `tasks queue-elaborations` to the actual queueing path used during sync (or factor queue logic into an exported function and call it from both places).
- Reintroduce explicit status validation for `slot clear` at CLI boundary (`ready|done|abandoned`).
- Keep help/usage synchronized with intentionally dropped commands (`migrate-refs`) and mention removals in `MIGRATION.md`.

## Verdict
**REQUEST_CHANGES**

Please fix the queue-elaboration regression and slot-clear validation before approval.
