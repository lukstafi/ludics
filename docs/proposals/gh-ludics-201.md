# Proposal: Harden guard/dedup functions against shape mismatches

**Task**: gh-ludics-201
**Project**: ludics

## Goal

Prevent guard and dedup functions from silently becoming no-ops due to data shape mismatches. The root incident (`queueHasPendingFeedbackDigest` silently returning `false` due to missing `repo` field) is already fixed. The remaining work adds a missing round-trip test for `queueHasPendingAction` and replaces brittle string-scan dedup guards in `src/tasks/sync.ts` with proper JSON field parsing.

## Acceptance Criteria

1. `src/queue.test.ts` contains round-trip tests for `queueHasPendingAction` that verify:
   - Returns `true` when a matching action is in the queue.
   - Returns `false` when the queue is empty.
   - Returns `false` when the queue contains a different action.
   - Returns `false` after the matching item is popped.
2. The elaborate dedup guard in `tasksQueueElaborations()` (`sync.ts` line 803) uses JSON parse + field check instead of `.includes('"action":"elaborate"')` string matching.
3. The task-specific dedup check in `tasksQueueElaborations()` (line 819) uses JSON parse + field check instead of `.includes('"task":"${taskId}"')` string matching.
4. The preempt dedup check in `tasksQueuePreemptions()` (lines 903–906) uses JSON parse + field check instead of combined `.includes('"task":...')` + `.includes('"action":"preempt"')` string matching.
5. All existing tests continue to pass (`bun test`).
6. No behavioral change — the dedup logic semantics are identical; only the implementation is hardened.

## Context

The root incident: `queueHasPendingFeedbackDigest("ludics")` checked for a `repo` field that was not included in the corresponding `queueRequest` call. The guard silently returned `false`, allowing duplicate feedback-digest requests to queue. The fix (typed `QueueAction` discriminated union in `src/queue.ts` + tests) is already applied.

Two categories of remaining risk:

**Missing test**: `queueHasPendingAction(action)` (`src/queue.ts` line 115) has no round-trip test. It is called in `mag.ts` line 3426 to guard `adopt-sessions` queuing. The implementation looks correct (parses JSON, checks `request.action === action`), but without a test a future refactor could silently break it.

**String-scan guards in `sync.ts`**: Three guard sites use raw substring matching on the queue file content:

- `tasksQueueElaborations()` line 803: pre-filters queue to elaborate-action lines using `.includes('"action":"elaborate"')`.
- `tasksQueueElaborations()` line 819: per-task dedup using `.includes('"task":"${taskId}"')`.
- `tasksQueuePreemptions()` lines 903–906: per-task/action dedup using `.some((line) => line.includes(...) && line.includes(...))`.

These rely on specific JSON key serialization order (`"action"` before other keys, `"task"` appearing in a particular position). `JSON.stringify` does not guarantee key order across runtimes, and a future restructuring of `queueRequest` (e.g., adding an `id` field first, or changing field order) could silently break the guards. `collectProjectsWithQueuedPreemption()` (line 259) already demonstrates the correct pattern: it filters on `'"action":"preempt"'` as a fast pre-filter, then parses JSON and reads `req.task` directly. The fix is to apply that same pattern uniformly.

## Approach

### 1. Tests for `queueHasPendingAction` (`src/queue.test.ts`)

Add a `describe("queueHasPendingAction", ...)` block alongside the existing `queueHasPendingFeedbackDigest` tests:

```typescript
describe("queueHasPendingAction", () => {
  test("returns false on empty queue", async () => {
    const { queueHasPendingAction } = await loadQueue();
    expect(queueHasPendingAction("adopt-sessions")).toBe(false);
  });

  test("matches queued action", async () => {
    const { queueRequest, queueHasPendingAction } = await loadQueue();
    queueRequest({ action: "adopt-sessions" });
    expect(queueHasPendingAction("adopt-sessions")).toBe(true);
  });

  test("does not match different action", async () => {
    const { queueRequest, queueHasPendingAction } = await loadQueue();
    queueRequest({ action: "briefing" });
    expect(queueHasPendingAction("adopt-sessions")).toBe(false);
  });

  test("returns false after action is popped", async () => {
    const { queueRequest, queuePopOne, queueHasPendingAction } = await loadQueue();
    queueRequest({ action: "adopt-sessions" });
    queuePopOne();
    expect(queueHasPendingAction("adopt-sessions")).toBe(false);
  });
});
```

### 2. Harden `tasksQueueElaborations()` (`src/tasks/sync.ts`)

Replace the string-scan pre-filter and per-task check with a parsed set:

**Before** (lines 799–819):
```typescript
let alreadyQueued = "";
if (existsSync(queueFile)) {
  const content = readFileSync(queueFile, "utf-8");
  alreadyQueued = content.split("\n").filter((l) => l.includes('"action":"elaborate"')).join("\n");
}
// ...
if (alreadyQueued.includes(`"task":"${taskId}"`)) continue;
```

**After**:
```typescript
const alreadyQueuedElaborateTasks = new Set<string>();
if (existsSync(queueFile)) {
  for (const line of readFileSync(queueFile, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const req = JSON.parse(line) as Record<string, unknown>;
      if (req.action === "elaborate" && typeof req.task === "string") {
        alreadyQueuedElaborateTasks.add(req.task);
      }
    } catch { /* skip malformed lines */ }
  }
}
// ...
if (alreadyQueuedElaborateTasks.has(taskId)) continue;
```

### 3. Harden `tasksQueuePreemptions()` (`src/tasks/sync.ts`)

Replace the per-task string-scan check (lines 902–906) with a parsed set. The queue content is already read into `alreadyQueued` (line 876), but the check uses raw string matching:

**Before**:
```typescript
const alreadyQueuedForTask = alreadyQueued.split("\n").some(
  (line) => line.includes(`"task":"${id}"`) && line.includes('"action":"preempt"'),
);
if (alreadyQueuedForTask) continue;
```

**After**: Build a `Set<string>` of task IDs with queued preempt actions once, before the file loop (similar to how `collectProjectsWithQueuedPreemption` already parses `queueContent`):

```typescript
const alreadyQueuedPreemptTasks = new Set<string>();
for (const line of alreadyQueued.split("\n")) {
  if (!line) continue;
  try {
    const req = JSON.parse(line) as Record<string, unknown>;
    if (req.action === "preempt" && typeof req.task === "string") {
      alreadyQueuedPreemptTasks.add(req.task);
    }
  } catch { /* skip */ }
}
// ... in the per-file loop:
if (alreadyQueuedPreemptTasks.has(id)) continue;
```

This also replaces `updateFrontmatterField(..., "status", "preempt-queued")` correctly — the status update immediately after queuing (`line 913`) serves as the authoritative dedup guard for subsequent sync passes, so this Set only needs to cover the current queue contents, not the current loop iteration (which is already handled by `projectsInFlight`).

### Consistency note

`collectProjectsWithQueuedPreemption()` (line 259) already uses JSON parse + field read for the preempt-action check. The approach in this proposal aligns `tasksQueueElaborations` and `tasksQueuePreemptions` with that already-correct pattern.
