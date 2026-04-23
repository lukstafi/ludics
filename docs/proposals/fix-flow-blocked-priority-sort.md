# Fix flowBlocked priority sort to use numeric comparator

## Goal

`flowBlocked()` in `src/flow.ts` sorts blocked tasks via
`localeCompare` with a `"Z"` sentinel, which yields the lex order
`A < B < C < D < S` — so `S`-priority blocked tasks sort *after* `C`
and `D`, not before them. The intended order is the canonical numeric
priority ladder `S < A < B < C < D` (S is the highest priority,
sorts first).

The bug was spotted during the `task-9b8ff839` retrospective (the
PR #355 work that added `D` as the new priority floor). `D` being
added didn't make the bug worse — it was latent since `S` was
introduced — but now that `priorityValue()` covers the full
`S/A/B/C/D` ladder it is the ready-made canonical comparator and
`flowBlocked` should delegate to it.

## Acceptance Criteria

1. `ludics flow blocked` lists blocked tasks in the order
   `S, A, B, C, D, <unknown>` (matching the order produced by
   `priorityValue()` — lowest numeric value first).
2. `flowBlocked()` uses `priorityValue()` from `src/tasks/markdown.ts`
   as its comparator, matching the pattern already used in
   `src/dashboard.ts`.
3. Existing behavior for tasks with the same priority is preserved
   (stable sort, filesystem readdir tiebreaker).
4. A regression test covers the ordering so the bug can't silently
   return (either a unit test on a pure comparator, or a test that
   exercises `flowBlocked`'s sort output).

## Context

### The bug

`src/flow.ts`, in `flowBlocked()`:

```ts
const blocked = tasks
  .filter((t) => t.dependencies.blocked_by && t.dependencies.blocked_by.length > 0)
  .sort((a, b) => (a.priority ?? "Z").localeCompare(b.priority ?? "Z"));
```

`"S".localeCompare("C")` returns `> 0` (S > C in lex order), so
S-priority tasks sort last among the named priorities.

### The canonical comparator

`priorityValue()` in `src/tasks/markdown.ts` already exists and covers
the full ladder post-PR #355:

```ts
export function priorityValue(p: string): number {
  switch (p) {
    case "S": return 0;
    case "A": return 1;
    case "B": return 2;
    case "C": return 3;
    case "D": return 4;
    default: return 9;
  }
}
```

Verified against `main` at the time of writing: `case "D": return 4`
is present (the elaboration-phase snapshot that suggested D was
missing was stale).

### Prior art in the repo

`src/dashboard.ts` already uses `priorityValue` for its priority
sort — it imports `priorityValue` from `./tasks/markdown.ts` and
compares with `priorityValue(a.priority) - priorityValue(b.priority)`.
`flowBlocked` should follow the same pattern.

### The `?? "Z"` fallback is dead code

`collectTasks()` in `src/flow.ts` populates `priority: String(data.priority ?? "B")`,
so `TaskData.priority` is always a non-empty string. The fallback to
`"Z"` never fires in practice. `priorityValue`'s `default: 9` branch
gives equivalent end-of-list behavior if an unknown priority string
ever does appear.

### No external dependency on the old order

- Only caller of `flowBlocked` is the `flow` CLI dispatcher in the
  same file — console output only, no programmatic consumer.
- No test fixture asserts the old lex order.
- `flowBlocked` itself has no existing test.

### Why not `effectivePriorityValue`

`flow.ts` already imports `effectivePriorityValue` from `./config.ts`,
but that one takes a project and applies focus-project boost.
Blocked-task listing should be project-agnostic (show raw declared
priority), so `priorityValue` is the right choice.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. In `src/flow.ts`, add `priorityValue` to the existing import from
   `./tasks/markdown.ts` (or add a new import line — check current
   imports from that module).
2. Replace the comparator in `flowBlocked()`:
   ```ts
   .sort((a, b) => priorityValue(a.priority) - priorityValue(b.priority));
   ```
   The `?? "Z"` fallback goes away; `priorityValue` handles unknown
   strings via its `default: 9` branch.
3. Add a regression test. Two reasonable options:
   - Test against `flowBlocked`'s console output (capture stdout,
     verify S-before-C in a multi-priority blocked-task fixture).
   - Extract the comparator to a named exported helper (e.g.
     `compareByPriority`) and unit-test the ordering directly,
     mirroring the style of `src/tasks/priority-value.test.ts`.

Either is fine; the second is lighter and doesn't require a harness
directory fixture.

## Scope

**In scope:**
- Comparator swap in `flowBlocked()`.
- New import (or import augmentation) of `priorityValue`.
- One regression test.

**Out of scope:**
- Changing `priorityValue()` itself (it already has the `D` case as
  of PR #355; no edits needed there).
- Auditing other `localeCompare`-based priority sorts in the
  codebase. If any exist, file a follow-up task rather than expanding
  this one.
- Any change to `collectTasks`, `effectivePriority`, or dashboard
  sort behavior.

**Dependencies:** none. PR #355 (`task-9b8ff839`) is already merged,
so `priorityValue("D") === 4` is in place.
