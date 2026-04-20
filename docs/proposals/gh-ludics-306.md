# Test isolation: consistent LUDICS_HARNESS_DIR across all test blocks

## Goal

Eliminate inconsistent `LUDICS_HARNESS_DIR` handling across the test suite so that (a) no test can break the preload safety net for subsequent test files, (b) files that call `harnessDir()` are explicitly isolated rather than silently depending on preload ordering, and (c) a shared helper and documentation prevent regressions when new tests are added.

Issue: https://github.com/lukstafi/ludics/issues/306

## Acceptance Criteria

1. **Bug fix -- `src/queue.test.ts`**: The `afterEach` handler restores `LUDICS_HARNESS_DIR` to its saved pre-test value instead of unconditionally deleting it. Uses the standard `if (orig === undefined) delete ... else ... = orig` pattern.

2. **Bug fix -- `src/events.test.ts`**: The `afterEach` handler restores `LUDICS_HARNESS_DIR`, `LUDICS_CONFIG`, and `HOME` using the conditional delete-or-assign pattern instead of `process.env.X = ORIGINAL ?? undefined` (which sets the string `"undefined"` in Node.js).

3. **Bug fix -- `src/orchestration/phases.test.ts`**: The file saves and restores `LUDICS_HARNESS_DIR` in its existing `beforeEach`/`afterEach`, pointing it at a tmpdir-based harness path, so it does not rely solely on the preload.

4. **Shared helper -- `src/test-utils.ts`**: A new exported function `withTestHarness(beforeEach, afterEach)` (or equivalent) encapsulates the save/set-tmpdir/restore pattern for `LUDICS_HARNESS_DIR`. Callers pass in Bun's `beforeEach` and `afterEach` and receive a function that returns the current tmpdir path. The helper uses the correct conditional restore pattern.

5. **Documentation -- `docs/testing-patterns.md`**: A new "Harness Isolation" section documents:
   - When `LUDICS_HARNESS_DIR` isolation is required (any test that calls `harnessDir()` directly or transitively)
   - The `withTestHarness()` helper with a usage example
   - The correct manual save/restore pattern for tests that need additional env vars (`HOME`, `LUDICS_CONFIG`)
   - An explicit prohibition against `delete process.env.LUDICS_HARNESS_DIR` in afterEach (must restore, not delete)

6. **No regressions**: `bun test` passes. Existing tests that already use correct manual save/restore patterns are not required to migrate to the helper (migration is optional and can happen incrementally).

## Context

### The preload safety net

`src/test-setup.ts` (configured via `bunfig.toml` `[test] preload`) sets `LUDICS_HARNESS_DIR` to a temp dir if unset. This was added by task-5199318d. It provides a safety net for the ~34 pure-unit test files that never touch the filesystem through `harnessDir()`.

### How `harnessDir()` resolves

`src/config.ts:304` -- `harnessDir()` checks `process.env.LUDICS_HARNESS_DIR` first. If unset, it falls back to config.yaml resolution, which in a real environment resolves to the actual harness directory. In tests, this fallback means reading/writing production state.

### Current isolation patterns (12 files)

Files like `src/slots/index.test.ts`, `src/dashboard.test.ts`, and `src/mag.test.ts` follow the correct pattern:
```typescript
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
beforeEach(() => { process.env.LUDICS_HARNESS_DIR = tmpDir; });
afterEach(() => {
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
});
```

This boilerplate is repeated 12+ times with slight variations, some of which contain bugs.

### Specific bugs

1. **`src/queue.test.ts:16`** -- `delete process.env.LUDICS_HARNESS_DIR` in afterEach instead of restoring the preload value. If Bun runs another test file in the same process after this one, the preload's safety net is gone.

2. **`src/events.test.ts:49-51`** -- `process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR ?? undefined` assigns the string `"undefined"` when the original was unset (in Node.js; Bun behavior may differ but the code is still incorrect).

3. **`src/orchestration/phases.test.ts:16-33`** -- Comment says "Isolate tests from real harness state" but only sets `HOME` and `LUDICS_CONFIG`, not `LUDICS_HARNESS_DIR`. Relies entirely on preload, which bug 1 above can break.

### Fragile files (not bugs, but risk)

- **`src/orchestration/runner.test.ts`** -- Only 3 of 32 describe blocks set `LUDICS_HARNESS_DIR`. The other 29 are safe because they mock `harnessDir()` callers, but the file is fragile: a new describe block that calls `harnessDir()` without isolation would silently hit the real harness.
- **`src/orchestration/skills.test.ts`** -- Uses per-test try/finally (8 tests). Correct but verbose; good candidate for eventual helper migration.

### Related completed work

- **task-5199318d**: Added global preload (`src/test-setup.ts` + `bunfig.toml`)
- **task-b72ea14e**: Fixed `src/slots/index.test.ts` save/restore pattern

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

### 1. Add `withTestHarness()` helper to `src/test-utils.ts`

Add to the existing file (which currently only exports `canBindSocket`):

```typescript
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Register beforeEach/afterEach hooks that isolate LUDICS_HARNESS_DIR
 * to a fresh temp directory. Returns a function that retrieves the
 * current temp harness path (valid inside a test).
 */
export function withTestHarness(
  before: (fn: () => void) => void,
  after: (fn: () => void) => void,
): () => string {
  let saved: string | undefined;
  let dir = "";
  before(() => {
    saved = process.env.LUDICS_HARNESS_DIR;
    dir = mkdtempSync(join(tmpdir(), "ludics-test-harness-"));
    process.env.LUDICS_HARNESS_DIR = dir;
  });
  after(() => {
    if (saved === undefined) delete process.env.LUDICS_HARNESS_DIR;
    else process.env.LUDICS_HARNESS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  return () => dir;
}
```

The helper creates the tmpdir, sets the env var, and cleans up both the env var and the tmpdir. Test files that also need `HOME` and `LUDICS_CONFIG` isolation can continue to manage those manually alongside the helper.

### 2. Fix `src/queue.test.ts`

Replace `delete process.env.LUDICS_HARNESS_DIR` with the standard save/restore pattern. Optionally migrate to `withTestHarness()`.

Before:
```typescript
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LUDICS_HARNESS_DIR;
});
```

After (option A -- manual fix):
```typescript
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
// ...
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
});
```

### 3. Fix `src/events.test.ts`

Replace the three `?? undefined` assignments in afterEach with conditional delete-or-assign:

Before:
```typescript
process.env.HOME = ORIGINAL_HOME ?? undefined;
process.env.LUDICS_CONFIG = ORIGINAL_CONFIG ?? undefined;
process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR ?? undefined;
```

After:
```typescript
if (ORIGINAL_HOME === undefined) delete process.env.HOME;
else process.env.HOME = ORIGINAL_HOME;
if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
if (ORIGINAL_HARNESS_DIR === undefined) delete process.env.LUDICS_HARNESS_DIR;
else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS_DIR;
```

### 4. Fix `src/orchestration/phases.test.ts`

Add `LUDICS_HARNESS_DIR` save/set/restore to the existing `beforeEach`/`afterEach`. The harness path should point into the existing `TEST_TMP`:

```typescript
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
// ... in beforeEach:
process.env.LUDICS_HARNESS_DIR = join(TEST_TMP, "harness");
// ... in afterEach:
if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
```

### 5. Update `docs/testing-patterns.md`

Add a "Harness Isolation" section after the existing "Network-Binding Tests" section:

```markdown
## Harness Isolation

Tests that call `harnessDir()` (directly or transitively through functions like
`emitEvent`, `readSlotJson`, `queuePath`, etc.) must isolate
`LUDICS_HARNESS_DIR` so they never read or write the real harness directory.

### The quick way: `withTestHarness()`

```typescript
import { withTestHarness } from "../test-utils.ts";

const getHarness = withTestHarness(beforeEach, afterEach);

test("my test", () => {
  const harness = getHarness(); // fresh temp dir, cleaned up automatically
  // ... test body ...
});
```

### Manual pattern (when you also need HOME / LUDICS_CONFIG)

```typescript
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
let TMP = "";

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-my-test-"));
  process.env.LUDICS_HARNESS_DIR = TMP;
});

afterEach(() => {
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});
```

**Never** use `delete process.env.LUDICS_HARNESS_DIR` unconditionally in
`afterEach` — this destroys the preload safety net for all subsequent test files
in the same Bun process. Always save and restore.

**Never** use `process.env.X = original ?? undefined` — this sets the env var to
the literal string `"undefined"`. Use the conditional delete-or-assign pattern.
```

## Scope

**In scope:**
- `src/test-utils.ts` -- add `withTestHarness()` helper
- `src/queue.test.ts` -- fix unconditional delete bug
- `src/events.test.ts` -- fix `?? undefined` restore bug
- `src/orchestration/phases.test.ts` -- add missing `LUDICS_HARNESS_DIR` isolation
- `docs/testing-patterns.md` -- add Harness Isolation section

**Out of scope:**
- Migrating all 12 existing correct-pattern files to use `withTestHarness()` (optional, incremental)
- Adding a CI lint rule to detect missing isolation (aspirational, separate task)
- Running each test file in isolation as a CI step (separate concern)
- Changes to `src/test-setup.ts` or `bunfig.toml` (the preload is fine as-is)
- Changes to production code in `src/config.ts`
