# Proposal: Extract shared parseQueueLines JSONL helper

**Task:** task-cc411bbb
**Date:** 2026-04-09

## Goal

Deduplicate 5 call sites across `src/queue.ts` and `src/tasks/sync.ts` that all inline the same split-lines / try-JSON.parse / skip-malformed pattern for reading JSONL queue content. Extract a single exported `parseQueueLines` helper that reuses the existing private `parseJsonRecord` function.

## Acceptance Criteria

- [ ] A new exported function `parseQueueLines(content: string): Record<string, unknown>[]` exists in `src/queue.ts`
- [ ] `parseQueueLines` reuses the existing `parseJsonRecord` helper internally
- [ ] All 5 call sites are refactored to use `parseQueueLines`:
  - `queueHasPendingAction` in `src/queue.ts`
  - `queueHasPendingFeedbackDigest` in `src/queue.ts`
  - `collectProjectsWithQueuedPreemption` in `src/tasks/sync.ts`
  - `tasksQueueElaborations` in `src/tasks/sync.ts`
  - `tasksQueuePreemptions` in `src/tasks/sync.ts`
- [ ] No behavior changes: empty lines are still skipped, malformed JSON is still silently dropped, all predicates produce the same results as before
- [ ] Existing tests pass without modification (the helper is a pure extraction, no logic change)

## Context

The JSONL queue file (`mag/queue.jsonl`) is read and parsed in 5 places using an identical inline pattern:

```typescript
for (const line of content.split("\n")) {
  if (!line) continue;
  try {
    const req = JSON.parse(line) as Record<string, unknown>;
    // ... filter ...
  } catch { /* skip */ }
}
```

`queue.ts` already has a private `parseJsonRecord(text)` helper (line 18) that handles the try/catch and type-checks for object results, but it is not used by any of the 5 call sites. This refactoring connects the dots.

The two `queue.ts` call sites (`queueHasPendingAction`, `queueHasPendingFeedbackDigest`) also duplicate their own file-read logic instead of using `readQueueLines()`. Since they only need parsed records (not raw lines for rewriting), they can use `parseQueueLines` on the raw file content directly.

## Approach

1. Add exported `parseQueueLines` to `src/queue.ts` immediately after `parseJsonRecord`:

```typescript
export function parseQueueLines(content: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    const parsed = parseJsonRecord(line);
    if (parsed) result.push(parsed);
  }
  return result;
}
```

2. Refactor `queueHasPendingAction` and `queueHasPendingFeedbackDigest` to use `parseQueueLines` on their file content.

3. In `src/tasks/sync.ts`, import `parseQueueLines` from `../queue.ts` and refactor the 3 call sites:
   - `collectProjectsWithQueuedPreemption`: replace the `queueContent.split("\n")` loop
   - `tasksQueueElaborations`: replace inline file-read + split loop
   - `tasksQueuePreemptions`: replace the `alreadyQueued.split("\n")` loop (keep `alreadyQueued` as a raw string since it is also passed to `collectProjectsWithQueuedPreemption`)

No changes to calling conventions or public API signatures. The `collectProjectsWithQueuedPreemption` function still receives `queueContent: string` from its caller.
