# Extract shared task status constants for dashboard-server endpoints

## Goal

Hardcoded status string literals (`"ready"`, `"needs-confirmation"`, `"deferred"`, `"abandoned"`) are scattered across four dashboard-server API endpoints (`/api/task-confirm`, `/api/task-dismiss`, `/api/deferred-approve`, `/api/deferred-abandon`). Each endpoint manually reads the status via inline regex, checks it against a literal, then calls `updateFrontmatterField` or `tasksAbandon` directly. This duplicates the same pattern that `transitionStatus` in `src/tasks/markdown.ts` already encapsulates, and the same literal-string drift that `VALID_CLEAR_STATUSES` (from gh-ludics-257) addressed for slot operations. Centralizing these constants and using the existing `transitionStatus` helper makes the endpoints more concise and resistant to future status-name drift.

## Acceptance Criteria

1. **Status constants exported from `src/tasks/markdown.ts`**: `TASK_STATUS_READY`, `TASK_STATUS_NEEDS_CONFIRMATION`, `TASK_STATUS_DEFERRED`, `TASK_STATUS_ABANDONED` are exported as `const`-asserted string literals. An `ALL_TASK_STATUSES` array containing all valid task statuses (matching the comment on `TaskFrontmatter.status`) and a `TaskStatus` type derived from it are also exported.
2. **`/api/task-confirm` uses `transitionStatus`**: The inline regex + guard + `updateFrontmatterField` pattern is replaced with a single `transitionStatus(taskFile, "needs-confirmation", TASK_STATUS_READY)` call. A `false` return produces the existing 409 error response.
3. **`/api/task-dismiss` uses `transitionStatus`**: The inline regex + guard is replaced with `transitionStatus(taskFile, "needs-confirmation", ...)` to validate the precondition (though the actual status write is delegated to `tasksAbandon`, so the transition call uses a temporary check -- see Approach). Alternatively, just use the constant for the guard string comparison.
4. **`/api/deferred-approve` uses `transitionStatus`**: The inline regex + guard + `updateFrontmatterField` is replaced with `transitionStatus(taskFile, TASK_STATUS_DEFERRED, TASK_STATUS_READY)`.
5. **`/api/deferred-abandon` unchanged**: This endpoint has no status guard and delegates directly to `tasksAbandon`, so no constant substitution is needed beyond the response literal.
6. **Response body status strings use constants**: `{ status: "ready" }`, `{ status: "abandoned" }`, `{ status: "approved" }` in response payloads use the named constants where applicable.
7. **`TaskFrontmatter.status` type narrowed**: The `status` field in `src/tasks/types.ts` is typed as `TaskStatus` (imported from `markdown.ts`) instead of bare `string`, preserving the comment as the canonical list.
8. **All existing tests pass**: No behavioral change -- the refactor is purely structural. The `transitionStatus` default of `"ready"` for missing status fields is acceptable (the dashboard endpoints previously defaulted to `""` which would also fail the guard).
9. **No new files created**: Constants live in the existing `src/tasks/markdown.ts`; type update goes in `src/tasks/types.ts`.

## Context

### Affected endpoints in `src/dashboard-server.ts`

| Endpoint | Lines | Current pattern | Hardcoded strings |
|---|---|---|---|
| `/api/task-confirm` | 308-333 | regex read + `!== "needs-confirmation"` guard + `updateFrontmatterField(..., "ready")` | `"needs-confirmation"`, `"ready"` |
| `/api/task-dismiss` | 336-361 | regex read + `!== "needs-confirmation"` guard + `tasksAbandon(...)` | `"needs-confirmation"`, `"abandoned"` |
| `/api/deferred-approve` | 363-389 | regex read + `!== "deferred"` guard + `updateFrontmatterField(..., "ready")` | `"deferred"`, `"ready"`, `"approved"` |
| `/api/deferred-abandon` | 391-408 | no guard, delegates to `tasksAbandon(...)` | `"abandoned"` (response only) |

### Existing precedent

- `src/slots/index.ts` exports `VALID_CLEAR_STATUSES`, `CLEAR_STATUS_READY`, `CLEAR_STATUS_DONE` -- used by `/api/slot-clear` in dashboard-server.ts (line 176).
- `src/tasks/markdown.ts` exports `transitionStatus(filePath, expectedFrom, to)` -- already used by `slots/index.ts` (4 call sites) and `tasks/index.ts` (2 call sites: merge/unmerge).

### `transitionStatus` behavior note

`transitionStatus` defaults a missing/unparseable status to `"ready"` (line 162 of markdown.ts). The dashboard endpoints currently default to `""`. This is a minor behavioral difference that only matters for malformed files. The `transitionStatus` default is more correct (tasks without an explicit status field are implicitly "ready"), so adopting it is an improvement.

## Approach

### 1. Add constants and type to `src/tasks/markdown.ts`

```ts
// Task status constants — canonical values matching TaskFrontmatter.status
export const TASK_STATUS_READY = "ready" as const;
export const TASK_STATUS_IN_PROGRESS = "in-progress" as const;
export const TASK_STATUS_DEFERRED = "deferred" as const;
export const TASK_STATUS_PREEMPTED = "preempted" as const;
export const TASK_STATUS_DONE = "done" as const;
export const TASK_STATUS_ABANDONED = "abandoned" as const;
export const TASK_STATUS_MERGED = "merged" as const;
export const TASK_STATUS_NEEDS_CONFIRMATION = "needs-confirmation" as const;

export const ALL_TASK_STATUSES = [
  TASK_STATUS_READY, TASK_STATUS_IN_PROGRESS, TASK_STATUS_DEFERRED,
  TASK_STATUS_PREEMPTED, TASK_STATUS_DONE, TASK_STATUS_ABANDONED,
  TASK_STATUS_MERGED, TASK_STATUS_NEEDS_CONFIRMATION,
] as const;

export type TaskStatus = typeof ALL_TASK_STATUSES[number];
```

### 2. Narrow `TaskFrontmatter.status` in `src/tasks/types.ts`

Import `TaskStatus` from `./markdown.ts` and change:
```ts
status: TaskStatus; // was: string
```

### 3. Refactor dashboard-server.ts endpoints

**`/api/task-confirm`** -- replace the 8-line regex+guard+write block:
```ts
import { transitionStatus, TASK_STATUS_READY, TASK_STATUS_NEEDS_CONFIRMATION } from "./tasks/markdown.ts";

// In the handler:
const transitioned = transitionStatus(taskFile, TASK_STATUS_NEEDS_CONFIRMATION, TASK_STATUS_READY);
if (!transitioned) {
  return new Response(JSON.stringify({ error: "task is not needs-confirmation" }),
    { status: 409, headers: { "Content-Type": "application/json" } });
}
```

**`/api/task-dismiss`** -- the guard uses `transitionStatus` to verify "needs-confirmation" but does NOT write the status (that is done by `tasksAbandon`). Use a read-only check:
```ts
const content = readFileSync(taskFile, "utf-8");
const statusMatch = content.match(/^status:\s*(.+)$/m);
const currentStatus = statusMatch ? statusMatch[1]!.trim() : TASK_STATUS_READY;
if (currentStatus !== TASK_STATUS_NEEDS_CONFIRMATION) {
  return new Response(...);
}
tasksAbandon(taskParam, { source: "dashboard", scope: "task" });
```
Here we only replace the hardcoded string literals with constants. We keep the inline regex because `transitionStatus` would also write the status, conflicting with `tasksAbandon`'s own write.

**`/api/deferred-approve`** -- same pattern as task-confirm:
```ts
const transitioned = transitionStatus(taskFile, TASK_STATUS_DEFERRED, TASK_STATUS_READY);
if (!transitioned) {
  return new Response(JSON.stringify({ error: `task is not deferred` }),
    { status: 409, headers: { "Content-Type": "application/json" } });
}
```

**`/api/deferred-abandon`** -- no status guard to refactor. Only replace `"abandoned"` in the response literal with `TASK_STATUS_ABANDONED`.

### 4. Update other hardcoded status literals opportunistically

Replace hardcoded `"abandoned"` in `tasksAbandon` (src/tasks/index.ts line 604, 631) and related locations within the same files being touched, if the import is already present. This is optional stretch scope -- the core deliverable is dashboard-server.ts.

### 5. Verify

Run `bun test` to confirm all existing tests pass. No new test files are needed since this is a purely structural refactoring with no behavioral change.
