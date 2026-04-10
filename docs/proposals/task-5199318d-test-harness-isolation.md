# Test harness isolation: global LUDICS_HARNESS_DIR preload

## Goal

Ensure all Bun tests automatically run with `LUDICS_HARNESS_DIR` pointing to a temporary directory, preventing any test from accidentally reading or writing the real harness `mag/` directory. This eliminates EPERM flakes caused by filesystem permission mismatches in reviewer worktrees.

## Acceptance Criteria

- A `bunfig.toml` exists at the project root with `[test] preload` pointing to a test setup file
- A test preload file (e.g., `src/test-setup.ts`) sets `process.env.LUDICS_HARNESS_DIR` to a fresh temporary directory before any test module loads
- The temporary directory is created under the OS temp directory (e.g., via `mkdtempSync`)
- Tests that already set their own `LUDICS_HARNESS_DIR` in `beforeAll`/`beforeEach` continue to work (their per-test value overrides the preload default)
- Running `bun test` in any worktree (including reviewer worktrees with different ownership) never touches the real harness directory
- No changes to production code paths — only test infrastructure files added

## Context

`saveDeferredCleanups()` in `src/orchestration/deferred-cleanup.ts:43-48` calls `harnessDir()` which resolves to the real harness path when `LUDICS_HARNESS_DIR` is unset. It then calls `mkdirSync` and `writeFileSync` on `mag/cleanup-pending.json`. In reviewer worktrees owned by a different user, this fails with EPERM.

`harnessDir()` at `src/config.ts:288` already checks `process.env.LUDICS_HARNESS_DIR` first, so setting it globally in a preload is sufficient.

Currently ~8 test files manually save/restore `LUDICS_HARNESS_DIR` in beforeAll/afterAll blocks (deferred-cleanup.test.ts, runner.test.ts, skills.test.ts, mag.test.ts, cluster-http.test.ts, dashboard.test.ts, queue.test.ts). The preload provides a safety net so any test file that forgets this pattern still gets isolation. Existing per-test overrides naturally take precedence since they run after the preload.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. **Create `bunfig.toml`** at project root:
   ```toml
   [test]
   preload = ["./src/test-setup.ts"]
   ```

2. **Create `src/test-setup.ts`**:
   ```typescript
   import { mkdtempSync } from "fs";
   import { join } from "path";
   import { tmpdir } from "os";

   // Safety net: all tests get an isolated harness directory by default.
   // Individual test files can override this in their own beforeAll/beforeEach.
   if (!process.env.LUDICS_HARNESS_DIR) {
     process.env.LUDICS_HARNESS_DIR = mkdtempSync(join(tmpdir(), "ludics-test-"));
   }
   ```

3. **Verify** by running `bun test` and confirming no writes to the real harness directory occur.
