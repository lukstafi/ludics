# Proposal: Add transitionStatus helper to guard task status transitions

**Task:** task-bb103300
**Date:** 2026-04-09

## Goal

Introduce a `transitionStatus(filePath, expectedFrom, to)` helper in `src/tasks/markdown.ts` that verifies the current status matches an expected set before writing. Replace ~8 unguarded status-write call sites in `src/slots/index.ts` and `src/tasks/index.ts` to prevent resurrection of terminal tasks (done/abandoned to in-progress) and other invalid transitions.

## Acceptance Criteria

- [ ] `transitionStatus(filePath, expectedFrom, to)` exported from `src/tasks/markdown.ts`; returns `true` on success, `false` when current status does not match `expectedFrom`; throws on missing file
- [ ] All unguarded status-write sites in `slots/index.ts` (`taskUpdateForSlotAssign` line 158, `taskUpdateForSlotClear` line 170, `taskCompleteDirectly` line 447, `slotPreempt` line 539, `slotRestore` line 573) use `transitionStatus` with the correct `expectedFrom` set per the transition map below
- [ ] All unguarded status-write sites in `tasks/index.ts` (`tasksMerge` line 266, `tasksUnmerge` line 309) use `transitionStatus` with the correct `expectedFrom` set
- [ ] When `transitionStatus` returns `false`, callers log a warning (not throw) with the task ID, expected statuses, and actual status
- [ ] `taskUpdateForSlotClear` skips the `completed` timestamp write when `transitionStatus` returns `false`
- [ ] Unit tests cover: allowed transition succeeds, blocked transition returns false, file-not-found throws
- [ ] Integration-level test: `slotClear("done")` on a task already `abandoned` does not overwrite status
- [ ] Existing tests pass; `bun run build` succeeds

## Context

Identified from the retrospective of task-addb2357 (Codex review). The approve handler could resurrect terminal tasks because status writes are unguarded. The task file's tentative design contains a detailed transition map and analysis of all call sites.

**Key source files:**
- `src/tasks/markdown.ts` — `updateFrontmatterField` (line 104), `readFrontmatterField` (line 85); new helper goes here
- `src/slots/index.ts` — `taskUpdateFrontmatter` (local duplicate, line 110), `taskUpdateForSlotAssign` (line 152), `taskUpdateForSlotClear` (line 164), `taskCompleteDirectly` (line 440), `slotPreempt` (line 539), `slotRestore` (line 573)
- `src/tasks/index.ts` — `tasksMerge` (line 252), `tasksUnmerge` (line 291)

**Already-guarded sites (do NOT change):** dashboard-server.ts endpoints, mag.ts notification/auto-start handlers, tasks/sync.ts reconciliation, slot overwrite path (line 273), markSlotSetupFailed (line 420) — all read status before writing.

## Approach

### 1. Add `transitionStatus` to `src/tasks/markdown.ts`

```typescript
export function transitionStatus(
  filePath: string,
  expectedFrom: string | string[],
  to: string,
): boolean {
  if (!existsSync(filePath)) throw new Error(`task file not found: ${filePath}`);
  const content = readFileSync(filePath, "utf-8");
  const statusMatch = content.match(/^status:\s*(.+)$/m);
  const current = statusMatch ? statusMatch[1]!.trim() : "ready";
  const allowed = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
  if (!allowed.includes(current)) {
    return false;
  }
  updateFrontmatterField(filePath, "status", to);
  return true;
}
```

### 2. Transition map (expectedFrom per call site)

| Call site | expectedFrom | to |
|---|---|---|
| `taskUpdateForSlotAssign` | `["ready", "deferred", "blocked", "needs-confirmation"]` | `in-progress` |
| `taskUpdateForSlotClear` (done) | `["in-progress", "preempted"]` | `done` |
| `taskUpdateForSlotClear` (abandoned) | `["in-progress", "deferred", "preempted"]` | `abandoned` |
| `taskUpdateForSlotClear` (ready/reset) | `["in-progress", "deferred"]` | `ready` |
| `taskCompleteDirectly` | `["in-progress", "deferred"]` | `done` |
| `slotPreempt` | `["in-progress"]` | `preempted` |
| `slotRestore` | `["preempted"]` | `in-progress` |
| `tasksMerge` | `["ready", "blocked", "needs-confirmation", "deferred"]` | `merged` |
| `tasksUnmerge` | `["merged"]` | `ready` |

### 3. Replace unguarded writes

At each call site, replace the blind `taskUpdateFrontmatter(taskId, "status", ...)` / `updateFrontmatterField(..., "status", ...)` with `transitionStatus(taskFilePath(taskId), expectedFrom, to)`. When the return is `false`, log a warning via `console.error` and skip downstream writes (e.g., completed timestamp in `taskUpdateForSlotClear`).

In `slots/index.ts`, the callers will need to import `transitionStatus` from `../tasks/markdown.ts` (already imported for `updateFrontmatterField` indirectly via `taskUpdateFrontmatter` local helper).

### 4. Tests

Add `src/tasks/__tests__/transitionStatus.test.ts`:
- Create a temp task file, verify allowed transition writes new status and returns true
- Verify blocked transition returns false and leaves file unchanged
- Verify missing file throws

Add integration test in `src/slots/__tests__/slotClear.test.ts` (or extend existing):
- Set up a task file with status `abandoned`, call `taskUpdateForSlotClear(taskId, "done")`, verify status remains `abandoned`
