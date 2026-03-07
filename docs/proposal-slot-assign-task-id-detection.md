# slotAssign: Replace prefix regex with task-file existence check

## Motivation

`slotAssign()` in `src/slots/index.ts` (line 155) uses a hardcoded regex to
decide whether its `taskOrDesc` argument is a task ID or free-text description:

```typescript
if (/^task-\d+/.test(taskOrDesc) || /^gh-/.test(taskOrDesc) || /^readme-/.test(taskOrDesc)) {
```

The `watch-` prefix is missing from this list. When a `watch-` task is assigned
(either manually or via `maybeFillEmptySlots()` in `src/mag.ts`), the ID falls
through to the else branch, which sets `taskId = "null"` and treats the watch ID
as a process description string. Consequences:

- `slots.md` shows `Task: null` instead of the real task ID.
- The worker session has no task file context, so it may work on the wrong thing.
- The dashboard cannot link the slot to its task.

This caused the auto-fill loop and the streams cleanup mishap on 2026-03-06:
an agent-duo session received no task file context and worked on the wrong
codebase area.

GitHub issue: https://github.com/lukstafi/ludics/issues/35

## Current State

The detection logic at line 155 enumerates known prefixes via three regex tests.
The `taskFilePath()` helper (line 41) already constructs the path
`harnessDir()/tasks/{taskId}.md`, and `existsSync` checks on that path are
already used elsewhere in the same file (lines 46-47, 78, 90, 508).

The full set of task-ID prefixes currently in use is: `task-`, `gh-`, `readme-`,
and `watch-`. Future prefixes would require another regex addition under the
current approach.

## Proposed Change

Replace the prefix-matching regex with an `existsSync` check on the task file.
This is the single-point-of-truth approach -- if a task file exists for the
given string, it is a task ID; otherwise it is a free-text description.

```typescript
// Line 152-169 — replace with:
const tf = taskFilePath(taskOrDesc);
if (existsSync(tf)) {
  taskId = taskOrDesc;
  const content = readFileSync(tf, "utf-8");
  const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
  processDesc = titleMatch ? titleMatch[1]! : taskId;
} else {
  taskId = "null";
  processDesc = taskOrDesc;
}
```

This eliminates the regex entirely. `taskFilePath` and `existsSync` are already
imported and used in the same file, so no new dependencies are needed.

### Acceptance criteria

- `watch-` prefixed task IDs are correctly recognized (not treated as descriptions).
- `slots.md` shows `Task: watch-...` with the task title as the process description.
- No regressions for `task-`, `gh-`, and `readme-` prefixes.
- Future prefixes work automatically without code changes.

## Scope

**In scope:** The single conditional on line 155 of `src/slots/index.ts`.

**Out of scope:** No other files need changes. The `taskFilePath()` helper,
dashboard rendering, and `maybeFillEmptySlots()` logic are unaffected -- they
already handle any task ID correctly once `slotAssign` sets it properly.

**Edge case:** If someone passes a string that happens to match a filename in
`tasks/` but is not intended as a task ID, it would now be treated as one.
This is not a realistic concern -- task files are only created through ludics
commands and have structured names.
