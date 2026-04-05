# Regression test: review-only retrospective auto-queue path

## Goal

Add a unit test verifying that `writeRetrospective()` calls `queueRequest("process-suggestions", ...)` when the retrospective contains only `request_changes` reviews (no `suggestRefactorSummary`, empty `workflowFeedback`).

## Acceptance Criteria

- A new test case in `src/retrospective.test.ts` constructs a `RetrospectiveData` object with:
  - `suggestRefactorSummary: null`
  - `workflowFeedback: {}`
  - `reviews` containing at least one entry with `verdict: "request_changes"`
- The test verifies that `queueRequest` is called with `"process-suggestions"` as the first argument
- The test does not require a running t3code server or real harness directory (use mocks/stubs for `harnessDir`, file I/O, and `queueRequest`)
- Existing tests continue to pass

## Context

The auto-queue condition in `writeRetrospective()` at `src/retrospective.ts:484-485`:

```typescript
const hasRequestChanges = data.reviews?.some(r => r.verdict === "request_changes") ?? false;
if (data.suggestRefactorSummary || Object.keys(data.workflowFeedback).length > 0 || hasRequestChanges) {
  queueRequest("process-suggestions", `"task":"${data.taskId}"`);
}
```

This covers three trigger paths. The `suggestRefactorSummary` and `workflowFeedback` paths may already have implicit coverage, but the `hasRequestChanges`-only path (added in task-c4ba2592) has none.

`writeRetrospective` is a module-private function (not exported). The test will need to either:
- Mock the module's dependencies (`harnessDir`, `mkdirSync`, `writeFileSync`, `emitEvent`, `queueRequest`) and call a code path that invokes `writeRetrospective`, or
- Export `writeRetrospective` for direct testing (simpler, acceptable for a test-only concern)

Key files:
- `src/retrospective.ts` -- `writeRetrospective()` (line 469)
- `src/retrospective.test.ts` -- existing test file (currently tests only `extractReviews`)
- `src/queue.ts` -- `queueRequest()` function
- `src/events.ts` -- `emitEvent()` function
- `src/config.ts` -- `harnessDir()` function

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Export `writeRetrospective` from `src/retrospective.ts` (add `export` keyword)
2. In `src/retrospective.test.ts`, add a new `describe("writeRetrospective")` block:
   - Use `bun:test` mock utilities (`mock.module` or `spyOn`) to stub `queueRequest`, `emitEvent`, `harnessDir` (return a temp dir), and filesystem calls
   - Build a minimal `RetrospectiveData` with `suggestRefactorSummary: null`, `workflowFeedback: {}`, and one review with `verdict: "request_changes"`
   - Call `writeRetrospective(data)`
   - Assert `queueRequest` was called with `("process-suggestions", ...)`
3. Clean up mocks in `afterEach`
