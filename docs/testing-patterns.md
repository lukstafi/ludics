# Testing Patterns

## Safe Mocking in Bun

### Why `mock.module()` is dangerous

Bun's test runner executes multiple test files in a single process by default. When you call `mock.module()`, it replaces the target module's exports **globally** for the entire runner process — not just for the current file. A mock set up in file A remains active when file B runs, even if file B never called `mock.module()`.

This caused a real incident (task-5d813109): tests for `refreshAgentStatuses` silently received mocked event journal implementations from an unrelated test file. The bug took two extra rounds to diagnose because the tests appeared to pass individually but failed when run together.

### The safe pattern

1. Import the module as a namespace object.
2. Use `spyOn()` to mock individual exports.
3. Restore the spy before the test or suite exits.

### Do not do this

```typescript
// UNSAFE — leaks globally across test files in multi-file runs
import { mock } from "bun:test";
mock.module("../events.ts", () => ({
  emitEvent: () => {},
}));
```

This replaces `../events.ts` for **every** test file in the runner. There is no automatic cleanup.

### Do this instead

**Suite-level spies** (repeated across tests in a `describe` block):

```typescript
import { describe, beforeEach, afterEach, spyOn } from "bun:test";
import * as events from "../events.ts";

describe("my feature", () => {
  let eventSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    eventSpy = spyOn(events, "emitEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    eventSpy.mockRestore();
  });

  // ... tests ...
});
```

This pattern is used throughout the `src/orchestration/runner.*.test.ts` cluster files.

**Per-test inline spies** (one-off mocks scoped to a single test):

```typescript
import { test, spyOn } from "bun:test";
import * as slots from "../slots/index.ts";

test("my test", () => {
  const slotClearSpy = spyOn(slots, "slotClear").mockImplementation(() => {});
  // ... test body ...
  slotClearSpy.mockRestore();
});
```

This pattern is used in `src/orchestration/transport-tmux.test.ts`.

Both styles are acceptable. The key invariant is: **every spy must be restored before the test or test group exits**.

### Reference examples

- `src/orchestration/runner.*.test.ts` (e.g. `runner.lifecycle.test.ts`) — suite-level `beforeEach`/`afterEach` pattern
- `src/orchestration/transport-tmux.test.ts` — per-test inline spy pattern

## Network-Binding Tests

Tests that bind real network sockets (e.g., `Bun.serve()`) must use the shared
probe-and-skip guard from `src/test-utils.ts` instead of open-coding a probe:

```typescript
import { canBindSocket } from "../test-utils.ts";

// Option A: guard a whole describe block
describe.if(canBindSocket)("my network tests", () => {
  // tests that need to bind sockets
});

// Option B: guard individual tests
const skipUnless = canBindSocket ? test : test.skip;
skipUnless("binds a server", () => { ... });
```

**Why**: Some environments (sandboxed CI, certain reviewer machines) fail loopback
socket allocation even on `port: 0`. When this happens, tests should skip cleanly
instead of failing with `EADDRINUSE`. Prefer defensive portability over arguing
from local pass results.

Test servers should bind to `hostname: "127.0.0.1"` to avoid IPv6-related
failures. Production servers that need to accept remote connections (e.g., the
dashboard server serving cluster traffic) should not restrict to loopback.

## Harness Isolation

Tests that call `harnessDir()` from `src/config.ts` — directly, or transitively
through helpers like `emitEvent`, `readSlotJson`, `queuePath`, etc. — must
isolate `LUDICS_HARNESS_DIR` so they never read or write the real harness
directory. A preload in `src/test-setup.ts` (configured via `bunfig.toml`) sets
`LUDICS_HARNESS_DIR` to a shared tmpdir if unset, but individual test files
should not silently depend on that preload: they must save, set, and restore
the env var themselves so later files in the same Bun process are not affected.

### The quick way: `withTestHarness()`

```typescript
import { beforeEach, afterEach, test, expect } from "bun:test";
import { withTestHarness } from "./test-utils.ts";

const getHarness = withTestHarness(beforeEach, afterEach);

test("writes a slot file under an isolated harness", () => {
  const harness = getHarness(); // fresh tmpdir, cleaned up after the test
  // ... test body ...
});
```

The helper saves the current `LUDICS_HARNESS_DIR`, swaps in a fresh tmpdir per
`beforeEach`, and in `afterEach` restores the original value (deleting if it
was unset) before removing the tmpdir.

### Manual pattern (when you also need HOME / LUDICS_CONFIG)

```typescript
const ORIGINAL_HARNESS = process.env.LUDICS_HARNESS_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG = process.env.LUDICS_CONFIG;
let TMP = "";

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ludics-my-test-"));
  process.env.HOME = TMP;
  process.env.LUDICS_CONFIG = writeConfigUnder(TMP);
  process.env.LUDICS_HARNESS_DIR = join(TMP, "harness");
  mkdirSync(join(TMP, "harness"), { recursive: true });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG === undefined) delete process.env.LUDICS_CONFIG;
  else process.env.LUDICS_CONFIG = ORIGINAL_CONFIG;
  if (ORIGINAL_HARNESS === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = ORIGINAL_HARNESS;
  rmSync(TMP, { recursive: true, force: true });
});
```

### Do not do this

**Never** `delete process.env.LUDICS_HARNESS_DIR` unconditionally in
`afterEach` — this destroys the preload safety net for every subsequent test
file in the same Bun process. Always save the original value and restore it.

**Never** use `process.env.X = original ?? undefined` to restore an env var —
assigning `undefined` via `process.env` sets the variable to the literal string
`"undefined"` (in Node.js; Bun's behaviour is similar). Use the conditional
delete-or-assign pattern shown above.

### Reference examples

- `src/queue.test.ts` — manual save/restore via a small `restoreHarnessDir` helper.
- `src/test-utils.test.ts` — contract tests for `withTestHarness()`.

## Orchestration Worktree Exclusions

Orchestration worktrees use a **two-tier exclusion contract**, both
halves centralized in
[`src/orchestration/worktrees.ts`](../src/orchestration/worktrees.ts):

- **Tier 1 — Proactive untrack** via `ensureGitExcludes()`. Appends
  `GIT_EXCLUDE_ENTRIES` (`.peer-sync`, `.ludics-orchestration.json`,
  `.claude`, `.agents`, `.agent-sessions`, `node_modules`,
  `_build_review*`) to `.git/info/exclude` so untracked instances cannot
  be staged. For the narrow `UNTRACK_PATHS` subset (`.peer-sync`,
  `.ludics-orchestration.json`, `.agent-sessions`) it additionally runs
  `git rm --cached -r` on anything already tracked and records the
  staged deletions in a dedicated `chore: untrack
  orchestration-internal files` commit.
- **Tier 2 — Defensive reset** via `ORCHESTRATION_RESET_PATHS` inside
  `autoCommitWorktree()`. For the remainder of `GIT_EXCLUDE_ENTRIES`
  (`.claude`, `.agents`, `node_modules`, `_build_review*`), runs
  `git reset HEAD --` after `git add -A` to unstage them at commit time
  without untracking — so projects that legitimately commit
  `.claude/settings.json` or `.agents/` keep those files tracked
  between orchestration rounds.

Tests that exercise the auto-commit path must mirror Tier 1: call
`ensureGitExcludes(repo)` directly on the worktree, rather than passing
pathspec excludes to `git add`.

**`UNTRACK_PATHS` criterion** (durable guidance for future additions):
a path belongs in `UNTRACK_PATHS` only if it is orchestrator-written
and users never commit it. Paths that projects may legitimately track
(`.claude`, `.agents`, `node_modules`, `_build_review*`) stay out of
`UNTRACK_PATHS` and rely on Tier 2's defensive reset instead — moving
them into Tier 1 would silently `git rm --cached` real project state.

**Rule**: do not combine `.git/info/exclude` entries with
`:(exclude)pattern` pathspecs on the same `git add` invocation. When the
excluded directory physically exists, git exits 1 even though the partial
add succeeds, which surfaces as a `runGit` throw inside
`autoCommitWorktree()`. Pick one mechanism — for orchestration, that is
`ensureGitExcludes()` plus the Tier 2 `git reset HEAD --` step, never
`:(exclude)` pathspecs on `git add`.

**Fallback**: if a one-off command elsewhere in the codebase genuinely
needs a pathspec exclude (no current call site does — see audit below),
use the long form `:(exclude)pattern`. Never use the short form
`:!pattern`: git's pathspec-magic parser fails when `pattern` contains
`*` with `fatal: Unimplemented pathspec magic '_' in ':!_build_review*'`.

Note that `ORCHESTRATION_RESET_PATHS`, passed to `git reset HEAD --`
inside `autoCommitWorktree()`, is a pathspec *inclusion* for unstaging —
not a pathspec exclude on `git add`. It does not trigger this failure
mode and is unrelated to the rule above.

**Precedent**: PR [#320](https://github.com/lukstafi/ludics/pull/320)
removed the `ORCHESTRATION_EXCLUDES` constant that was being passed as
`:(exclude)…` pathspecs inside `autoCommitWorktree()`, consolidating on
`ensureGitExcludes()` / `.git/info/exclude`; five tests were updated to
call `ensureGitExcludes(repo)` explicitly rather than rely on the
removed pathspec behavior. Background: issue
[#329](https://github.com/lukstafi/ludics/issues/329). A repo-wide grep
for `:(exclude)` and `:!` pathspec magic across `src/`, `tests/`,
`scripts/`, `bin/` returns zero matches. Follow-up PR
[#356](https://github.com/lukstafi/ludics/pull/356) (task-89b31783) then
split that single-source rule into the current two-tier contract,
adding the narrow proactive `git rm --cached` + chore commit for
`UNTRACK_PATHS` while keeping the defensive reset in
`autoCommitWorktree()` for entries projects may legitimately track.
