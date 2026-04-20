# Atomic File Operations for Crash Recovery

## Goal

Replace direct `writeFileSync` calls at critical state persistence sites with an atomic write-to-temp-then-rename pattern, and fix the duplicate non-atomic queue dequeue path in `src/mag.ts`, so that a crash mid-write never leaves truncated or corrupt state files.

## Acceptance Criteria

- [ ] A shared `atomicWriteFileSync(path: string, content: string): void` helper exists in `src/json.ts` that writes to `${path}.tmp` then calls `renameSync`, with the same ENOENT retry logic as `writeJsonFile`
- [ ] `writeJsonFile` delegates to `atomicWriteFileSync` internally (no duplication of the tmp+rename logic)
- [ ] `dequeueQueueHead()` in `src/mag.ts` is refactored to use `queuePopOne()` from `src/queue.ts` instead of duplicating queue file manipulation with a direct `writeFileSync`
- [ ] `queuePop()` in `src/queue.ts` uses `writeQueueLines` (or the new atomic helper) instead of a direct `writeFileSync` to the queue file
- [ ] All `writeFileSync` calls in `src/tasks/markdown.ts` (`updateFrontmatterField`, `appendToSection`, `removeFrontmatterField`, `updateDependencyArray`, `writeTaskFile`) use `atomicWriteFileSync`
- [ ] `writeTmuxSlotState()` in `src/adapters/tmux-adapter.ts` uses the atomic helper (aligning with `writeSlotJson` in `src/slots/json.ts`)
- [ ] `saveSessionConclusionState()`, notification state writes, and notification payload writes in `src/notify.ts` use `writeJsonFile` or `atomicWriteFileSync`
- [ ] `writeStash()` in `src/slots/preempt.ts` uses `writeJsonFile` or `atomicWriteFileSync`
- [ ] `writeResult()` in `src/queue.ts` uses `writeJsonFile` or `atomicWriteFileSync`
- [ ] State writes in `src/health.ts` (`testHealthStatePath`), `src/retrospective.ts` (retrospective JSON), and `src/cluster-http.ts` (intent files, heartbeat, remote slot state) use the atomic helper
- [ ] Mag session state writes in `src/mag.ts` (`magStateFile()` at session start and stop) use the atomic helper
- [ ] Dashboard writes in `src/dashboard.ts` are left as-is (regenerated every tick, self-healing) -- no changes required
- [ ] Ephemeral/sentinel files (epoch timestamps, hashes, status markers) are left as-is -- no changes required
- [ ] Config/setup files (`src/triggers.ts`, `src/init.ts`) are left as-is -- written once at install time
- [ ] Existing tests pass (`bun test`), including tests for `writeJsonFile`, queue operations, task markdown manipulation, and slot state
- [ ] New unit test for `atomicWriteFileSync` verifies: (a) file content is correct after write, (b) no `.tmp` file remains after successful write, (c) the function is resilient to a missing parent directory (creates it)

## Context

### Existing atomic pattern

`writeJsonFile` in `src/json.ts` already implements the correct pattern: write to `${path}.tmp`, then `renameSync(tmp, path)` with one ENOENT retry. This same pattern is used in `writeQueueLines` (in `src/queue.ts`), `writeSlotJson` (in `src/slots/json.ts`), and several other modules (`src/adapters/base.ts`, `src/sessions/sweep-state.ts`, `src/sessions/report.ts`, `src/adapters/bookmark.ts`, `src/orchestration/deferred-cleanup.ts`). These are already crash-safe.

### Duplicate queue dequeue

`dequeueQueueHead()` in `src/mag.ts` reimplements queue pop logic with a direct `writeFileSync`, bypassing the atomic `writeQueueLines` helper in `src/queue.ts`. Similarly, the older `queuePop()` in `src/queue.ts` itself uses a direct `writeFileSync` while the newer `queuePopOne()` correctly uses the atomic `writeQueueLines`. The `queuePop()` function appears to be unused by any caller outside the module (only `queuePopOne` is used in practice), but should either be removed or fixed.

### Critical non-atomic write sites (priority order)

1. **`dequeueQueueHead` in `src/mag.ts`** -- Writes queue.jsonl directly. Should delegate to `queuePopOne` from `src/queue.ts`.
2. **`src/tasks/markdown.ts` (6 sites)** -- `updateFrontmatterField`, `appendToSection`, `removeFrontmatterField`, `updateDependencyArray`, `writeTaskFile`. Task files are the persistent source of truth; corruption breaks every subsystem.
3. **`writeTmuxSlotState` in `src/adapters/tmux-adapter.ts`** -- Non-atomic write to orchestration state; its sibling `writeSlotJson` in `src/slots/json.ts` already uses atomic write.
4. **`src/notify.ts` (3 sites)** -- `saveSessionConclusionState`, notification state, notification payload. Corruption causes duplicate or lost notifications.
5. **`writeStash` in `src/slots/preempt.ts`** -- Preempt stash corruption could lose task assignment during preemption.
6. **`writeResult` in `src/queue.ts`** -- Queue result files read by Mag for delivery confirmation.
7. **`src/health.ts`, `src/retrospective.ts`, `src/cluster-http.ts`** -- Various state files where corruption causes incorrect health reports, lost retrospectives, or stale federation state.
8. **`magStateFile()` writes in `src/mag.ts`** -- Session start/stop state.

### Relationship to gh-ludics-227

Proposal `gh-ludics-227` (JSON shape validation) covers runtime validation of parsed JSON. This proposal is complementary: it prevents corruption at write time, while gh-ludics-227 detects corruption at read time. No overlap in code changes.

### Relationship to task-9a5d2344

Task `task-9a5d2344` covers file locking (mkdir-based) for queue mutation races. This proposal does not add file locking -- it makes individual writes atomic. The two are complementary: atomic writes prevent corruption from crashes; file locking prevents corruption from concurrent access.

## Approach

### Phase 1: Create the shared helper

Add `atomicWriteFileSync(path: string, content: string): void` to `src/json.ts`. Extract the existing tmp+rename+retry logic from `writeJsonFile` into this new function, then have `writeJsonFile` call it internally:

```ts
export function atomicWriteFileSync(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, content);
    try {
      renameSync(tmp, path);
      return;
    } catch (err: unknown) {
      if (attempt === 0 && err instanceof Error && "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  atomicWriteFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
```

### Phase 2: Fix duplicate queue dequeue

Refactor `dequeueQueueHead` in `src/mag.ts` to delegate to queue functions from `src/queue.ts`. The `expectedLine` parameter (used for compare-and-swap semantics) can be replicated by peeking with `readQueueLines` then calling `queuePopOne` -- or better, export a `queuePopExpected(expectedLine)` variant from `src/queue.ts`. Also remove or fix the legacy `queuePop()` function.

### Phase 3: Replace critical writeFileSync calls

Work through the priority list, replacing `writeFileSync(path, content)` with `atomicWriteFileSync(path, content)` at each site. For JSON state files (`notify.ts`, `preempt.ts`, `health.ts`, `retrospective.ts`, `cluster-http.ts`), prefer `writeJsonFile` where the content is JSON. For non-JSON content (`tasks/markdown.ts`, `mag.ts` session state), use `atomicWriteFileSync` directly.

Import changes per file:
- `src/tasks/markdown.ts`: add import of `atomicWriteFileSync` from `../json.ts`, replace all 6 `writeFileSync` calls
- `src/adapters/tmux-adapter.ts`: add import of `atomicWriteFileSync`, replace `writeFileSync` in `writeTmuxSlotState`
- `src/notify.ts`: add import of `writeJsonFile` from `./json.ts`, replace 3 `writeFileSync` calls (lines ~369, ~655, ~685)
- `src/slots/preempt.ts`: add import of `writeJsonFile` from `../json.ts`, replace `writeFileSync` in `writeStash`
- `src/queue.ts`: replace `writeFileSync` in `writeResult` with `atomicWriteFileSync`
- `src/health.ts`: add import, replace `writeFileSync` at test health state write
- `src/retrospective.ts`: add import, replace `writeFileSync` at retrospective JSON write
- `src/cluster-http.ts`: add import, replace 3 `writeFileSync` calls (intent, heartbeat, remote slot state)
- `src/mag.ts`: add import, replace `writeFileSync` calls for `magStateFile()` at session start/stop; separately refactor `dequeueQueueHead`

### Phase 4: Tests

- Add a dedicated test for `atomicWriteFileSync` in a new `src/json.test.ts` (or colocated test file): verify correct content, no leftover `.tmp`, parent directory auto-creation
- Verify existing tests pass without modification (the behavioral contract of all changed functions is identical -- only the write mechanism changes)
- The `dequeueQueueHead` refactor should be covered by existing mag queue tests; add a test case if none exists for the expected-line compare-and-swap behavior

### What NOT to change

- **Dashboard data files** (`src/dashboard.ts`): 15+ `writeFileSync` calls, but these are regenerated every keepalive tick. Corruption self-heals within seconds.
- **Ephemeral sentinels** (`src/mag.ts` epoch timestamps, hashes, status markers): ~12 sites. These are single small values where corruption causes at most a missed tick, not data loss.
- **Config/setup files** (`src/triggers.ts`, `src/init.ts`): written once at install time, not vulnerable to concurrent access or crash races.
- **Multi-step persistence sequences**: the elaboration identified slot assignment as a multi-step sequence (writeSlotJson -> taskUpdateForSlotAssign -> persistState). Making each individual write atomic does not solve the cross-step consistency problem, but it eliminates the most likely failure mode (corrupt individual files). True transactional multi-step persistence is out of scope.
