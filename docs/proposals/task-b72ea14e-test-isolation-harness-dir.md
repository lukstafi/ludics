# Proposal: Fix test isolation in slots/index.test.ts — add LUDICS_HARNESS_DIR to beforeEach/afterEach

**Task**: task-b72ea14e

## Goal

Fix ~15 tests in `src/slots/index.test.ts` that fail when run individually (e.g., `bun test -t "test name"`) because `LUDICS_HARNESS_DIR` is not set in the file-level `beforeEach`/`afterEach`. The tests pass in the full suite only due to ordering side effects. The env var must be saved, set, and restored alongside the existing `HOME` and `LUDICS_CONFIG` handling.

## Acceptance Criteria

1. **Env var lifecycle**: `LUDICS_HARNESS_DIR` is saved at module load, set in `beforeEach` to `join(TMP, "ludics-state", "harness")`, and restored (or deleted) in `afterEach`, matching the existing pattern for `HOME` and `LUDICS_CONFIG`.
2. **Individual test pass**: Tests in the `"slot assign — direct orchestration flags"` describe block pass when run individually via `bun test --test-name-pattern`.
3. **Full suite still passes**: `bun test src/slots/index.test.ts` continues to pass with no regressions.
4. **Redundant cleanup removed**: The manual `try/finally` save/restore of `LUDICS_HARNESS_DIR` in the `"--duo with --coder value does not leak value as stray positional"` test (lines 344-364) is removed since the file-level hooks now handle it.
5. **No directory creation in beforeEach**: The `beforeEach` only sets the env var; it does not create the directory. Individual tests remain responsible for creating their harness directories as needed.

## Context

- **File**: `src/slots/index.test.ts`
- **Root cause**: `harnessDir()` in `src/config.ts` reads `process.env.LUDICS_HARNESS_DIR` first; when unset, it derives the path from the config file, which resolves to a different location than where test data is written.
- **Existing pattern**: `cluster-http.test.ts` (lines 86-149) and `mag.test.ts` (`orchPidForSlotMode` describe block, lines 225-268) already follow this exact save/set/restore pattern for `LUDICS_HARNESS_DIR`.
- **Scope boundary**: The `slotAssign` describe block (lines 94-209) does NOT need this fix because it uses explicit-harness overloads exclusively and does not call `runSlot`.

## Approach

Three edits to `src/slots/index.test.ts`:

1. **Add save constant** (after line 16): Add `const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;` alongside the existing `ORIGINAL_HOME` and `ORIGINAL_CONFIG` constants.

2. **Set in beforeEach** (inside the `beforeEach` callback, after the `LUDICS_CONFIG` line): Add `process.env.LUDICS_HARNESS_DIR = join(TMP, "ludics-state", "harness");`.

3. **Restore in afterEach** (inside the `afterEach` callback, after the `LUDICS_CONFIG` restore block): Add the standard conditional restore:
   ```typescript
   if (ORIGINAL_HARNESS === undefined) {
     delete process.env.LUDICS_HARNESS_DIR;
   } else {
     process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
   }
   ```

4. **Remove redundant try/finally** in the `"--duo with --coder value does not leak value as stray positional"` test: Remove the `savedHarness` save, the `process.env.LUDICS_HARNESS_DIR = harness` assignment, and the `finally` block, since `beforeEach` now handles all of this.
