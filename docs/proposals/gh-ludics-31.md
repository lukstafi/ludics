# Proposal: Add programmatic status reconciliation step in tasks sync

**Task:** gh-ludics-31
**Date:** 2026-03-11
**Status:** draft

## Summary

Add a `tasksReconcileBlockedStatus()` function to `src/tasks/sync.ts` that enforces bidirectional consistency between a task's `blocked_by` array and its `status` field. The function runs inside `tasksSync()` after `tasksUpdate()` and before `tasksQueueElaborations()`, ensuring that blocked tasks are not queued for elaboration and that the on-disk `status` field matches reality.

## Motivation

Currently a task can have `status: ready` while `blocked_by` contains unresolved dependencies. The slot-assignment path (`maybeFillEmptySlots`) and flow views (`flowReady`, `flowBlocked`) independently filter on `blocked_by`, so they behave correctly -- but the `status` field on disk is wrong, and `tasksQueueElaborations()` only checks `status === "ready"`, causing blocked tasks to be unnecessarily queued for elaboration.

## Verified Code Locations

| Item | File | Line | Notes |
|------|------|------|-------|
| `tasksSync()` | `src/tasks/sync.ts` | 61 | Orchestrator; call site for new function |
| `tasksUpdate()` | `src/tasks/sync.ts` | 414 | Runs before reconciliation |
| `tasksQueueElaborations()` | `src/tasks/sync.ts` | 645 | Checks `status === "ready"` at line 666 |
| `setFrontmatterScalar()` | `src/tasks/sync.ts` | 204 | Existing helper for writing scalar fields |
| `parseTaskFrontmatter()` | `src/tasks/markdown.ts` | 18 | Parses `dependencies.blocked_by` as `string[]` |
| `emitEvent()` | `src/events.ts` | 29 | Already imported in `sync.ts` |
| `flowReady()` | `src/flow.ts` | 122 | Independently filters `blocked_by`; unaffected |
| `flowBlocked()` | `src/flow.ts` | 153 | Independently filters `blocked_by`; unaffected |

## Implementation

### Call site in `tasksSync()`

Insert the reconciliation call between `tasksUpdate()` and `tasksQueueElaborations()`:

```typescript
// In tasksSync(), after line 103 (await tasksUpdate()):
  // Reconcile blocked_by vs status consistency
  tasksReconcileBlockedStatus();

  // Queue elaboration for new ready tasks
  tasksQueueElaborations();
```

### New function: `tasksReconcileBlockedStatus()`

Add this function in `src/tasks/sync.ts` (e.g. after `tasksUpdate()`, before `tasksQueueElaborations()`):

```typescript
function tasksReconcileBlockedStatus(): void {
  const harness = harnessDir();
  const tasksDir = join(harness, "tasks");
  if (!existsSync(tasksDir)) return;

  const files = readdirSync(tasksDir).filter((f: string) => f.endsWith(".md"));
  let reconciled = 0;

  // Statuses that should never be flipped by reconciliation
  const skipStatuses = new Set([
    "done", "abandoned", "merged", "in-progress", "preempt-queued", "preempted",
  ]);

  for (const f of files) {
    const filePath = join(tasksDir, f);
    const content = readFileSync(filePath, "utf-8");
    let fm;
    try {
      fm = parseTaskFrontmatter(content);
    } catch {
      continue;
    }

    const status = fm.status ?? "ready";
    const blockedBy = fm.dependencies?.blocked_by ?? [];

    if (skipStatuses.has(status)) continue;

    if (blockedBy.length > 0 && status === "ready") {
      if (setFrontmatterScalar(filePath, "status", "blocked")) {
        emitEvent({
          event_type: "task_status_change",
          source: "sync",
          scope: "task",
          task: fm.id,
          status: "blocked",
          message: `blocked by: ${blockedBy.join(", ")}`,
        });
        reconciled++;
      }
    } else if (blockedBy.length === 0 && status === "blocked") {
      if (setFrontmatterScalar(filePath, "status", "ready")) {
        emitEvent({
          event_type: "task_status_change",
          source: "sync",
          scope: "task",
          task: fm.id,
          status: "ready",
          message: "all blockers resolved",
        });
        reconciled++;
      }
    }
  }

  if (reconciled > 0) {
    console.error(`ludics: reconciled status for ${reconciled} task(s)`);
  }
}
```

### Key design decisions

1. **`preempted` included in skip list.** The task elaboration noted this as an open question. Including it is safer -- a preempted task's status is managed by the preemption lifecycle, not dependency resolution.

2. **No-arg signature.** The function resolves `tasksDir` internally via `harnessDir()`, consistent with `tasksQueueElaborations()` and `tasksQueuePreemptions()` which also take no arguments.

3. **Reads fresh from disk.** Since `tasksUpdate()` writes to disk, the reconciliation picks up those changes automatically without needing in-memory state passing.

4. **Export not required.** The function is only called within `tasksSync()`, so it can remain module-private (no `export`). If needed for testing, it can be exported later.

## Test Plan

- [ ] **Manual: ready -> blocked.** Create a task file with `status: ready` and `blocked_by: [some-task]`. Run `ludics tasks sync`. Verify status changes to `blocked` and a `task_status_change` event is emitted.
- [ ] **Manual: blocked -> ready.** Create a task file with `status: blocked` and `blocked_by: []`. Run `ludics tasks sync`. Verify status changes to `ready`.
- [ ] **Terminal statuses preserved.** Verify tasks with `status: done`, `abandoned`, `merged`, `in-progress`, `preempt-queued`, `preempted` are not modified even if `blocked_by` is inconsistent.
- [ ] **Idempotency.** Run `ludics tasks sync` twice in a row. Second run should produce zero reconciliation changes.
- [ ] **Integration with elaboration queue.** After reconciliation, verify `tasksQueueElaborations()` does not queue tasks that were flipped to `blocked`.
- [ ] **Event log.** Check `journal/events.jsonl` for correct `task_status_change` entries with `source: "sync"`.

## Risk Assessment

**Low risk.**

- The change is additive -- a new function inserted between two existing pipeline stages.
- It uses only existing utilities (`setFrontmatterScalar`, `parseTaskFrontmatter`, `emitEvent`).
- Terminal/active statuses are explicitly skipped, so in-progress work is never disturbed.
- The reconciliation is idempotent and self-correcting on subsequent runs.
- No GitHub API calls are made; this is purely a local file consistency pass.
- Worst case: a task flips between `ready` and `blocked` on successive runs if `blocked_by` is being modified concurrently by another process. This is unlikely in practice and self-healing.
