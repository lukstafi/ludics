# Proposal: Dashboard API cleanup — extract shared helpers

## Summary

Extract duplicated logic from dashboard-server.ts API endpoints into shared helpers: a task ID regex constant, a task-file resolution helper, and reuse of the existing `updateFrontmatterField` from `tasks/markdown.ts` instead of hand-rolled frontmatter rewriting. Also unify the two copies of `priorityValue()` (in `dashboard.ts` and `flow.ts`) into a single export.

## Current state

### 1. Duplicated frontmatter rewriting

Both `/api/slot-postpone` (lines 244-258) and `/api/task-promote` (lines 305-325) contain a hand-rolled frontmatter rewriting loop that walks lines, tracks `inFrontmatter` state, and replaces a `priority:` line. This is functionally identical to the existing `updateFrontmatterField(filePath, field, value)` in `src/tasks/markdown.ts`, which already handles the same pattern.

The promote endpoint additionally handles the "insert before closing fence" case, which is covered by the existing `addFrontmatterField()` in the same module.

### 2. Duplicated task ID validation

Four endpoints use the same inline regex `/^[A-Za-z0-9._-]+$/` for task ID validation:

| Endpoint | Pattern |
|----------|---------|
| `/api/task-promote` | `/^[A-Za-z0-9._-]+$/` |
| `/api/task-confirm` | `/^[A-Za-z0-9._-]+$/` |
| `/api/task-dismiss` | `/^[A-Za-z0-9._-]+$/` |
| `/task-files/` | `/^([A-Za-z0-9._-]+)\.md$/` |

### 3. Duplicated task file resolution + safety check

Three endpoints (promote, confirm, dismiss) repeat the same 5-line sequence:
```ts
const hDir = harnessDir();
const taskFile = resolve(hDir, "tasks", `${taskParam}.md`);
const safeTasksRoot = resolve(hDir, "tasks") + "/";
if (!taskFile.startsWith(safeTasksRoot)) return 403;
if (!existsSync(taskFile) || statSync(taskFile).isDirectory()) return 404;
```

### 4. Duplicated `priorityValue()`

Two independent copies exist:
- `src/dashboard.ts:322` — handles S, A, B, C (returns 0, 1, 2, 3; default 9)
- `src/flow.ts:73` — handles only A, B, C (returns 1, 2, 3; default 9) — missing `S`

The `flow.ts` version is buggy: S-priority tasks sort after C.

## Plan

### 1. Export `TASK_ID_RE` from `src/tasks/markdown.ts`

```ts
export const TASK_ID_RE = /^[A-Za-z0-9._-]+$/;
```

Use this constant in all four locations in `dashboard-server.ts`.

### 2. Extract `resolveTaskFile(taskId)` helper in `dashboard-server.ts`

A local helper inside `startDashboardServer` that encapsulates the resolve + safety-check + existence-check pattern, returning `{ path: string } | { error: Response }`:

```ts
function resolveTaskFile(taskId: string): { path: string } | { error: Response } {
  const hDir = harnessDir();
  const taskFile = resolve(hDir, "tasks", `${taskId}.md`);
  const safeTasksRoot = resolve(hDir, "tasks") + "/";
  if (!taskFile.startsWith(safeTasksRoot)) {
    return { error: new Response("Forbidden", { status: 403 }) };
  }
  if (!existsSync(taskFile) || statSync(taskFile).isDirectory()) {
    return { error: new Response("Not Found", { status: 404 }) };
  }
  return { path: taskFile };
}
```

### 3. Replace hand-rolled priority rewriting with `updateFrontmatterField`

Both postpone and promote endpoints currently do ~15 lines of manual line-by-line frontmatter rewriting. Replace with:

```ts
updateFrontmatterField(taskFile, "priority", newPriority);
```

The promote endpoint's "insert if missing" case uses `addFrontmatterField` (already exported from `tasks/markdown.ts`).

For postpone, the deferred-write pattern (write only after slot-clear succeeds) is preserved by reading the current priority first, then calling `updateFrontmatterField` in the deferred closure.

### 4. Unify `priorityValue()` into a shared export

Move to `src/tasks/markdown.ts` (or a new `src/tasks/priority.ts` if preferred) and export:

```ts
export function priorityValue(p: string): number {
  switch (p) {
    case "S": return 0;
    case "A": return 1;
    case "B": return 2;
    case "C": return 3;
    default: return 9;
  }
}
```

Update `dashboard.ts` and `flow.ts` to import instead of defining locally.

### 5. Add unit test for `priorityValue()` sorting

```ts
// test/priority.test.ts
import { priorityValue } from "../src/tasks/markdown.ts";

test("priorityValue orders S < A < B < C", () => {
  expect(priorityValue("S")).toBeLessThan(priorityValue("A"));
  expect(priorityValue("A")).toBeLessThan(priorityValue("B"));
  expect(priorityValue("B")).toBeLessThan(priorityValue("C"));
});

test("unknown priority sorts last", () => {
  expect(priorityValue("X")).toBeGreaterThan(priorityValue("C"));
});
```

## Files to modify

- `src/tasks/markdown.ts` — add `TASK_ID_RE` export, add `priorityValue()` export
- `src/dashboard-server.ts` — import helpers, replace duplicated patterns (~60 lines removed)
- `src/dashboard.ts` — remove local `priorityValue()`, import shared version
- `src/flow.ts` — remove local `priorityValue()`, import shared version (fixes missing S)
- **New**: `test/priority.test.ts` — unit tests for `priorityValue()` (~15 lines)

## Coordination note

Slot 2 is running task-ce15fb2a (dashboard PR #71 followups) which also touches `dashboard-server.ts`. This task should merge after that PR lands, or rebase on top of it. The changes are structurally independent (this task extracts helpers; that task adds/fixes endpoints) so conflicts should be minimal — limited to import lines at the top of `dashboard-server.ts`.

## Risk

Low. All changes are mechanical refactors with existing test coverage for the affected endpoints. The only behavioral change is fixing `flow.ts`'s missing S-priority handling.
