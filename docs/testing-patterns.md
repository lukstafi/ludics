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

This pattern is used throughout `src/orchestration/runner.test.ts`.

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

- `src/orchestration/runner.test.ts` — suite-level `beforeEach`/`afterEach` pattern
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
