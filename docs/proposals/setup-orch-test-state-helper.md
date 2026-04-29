# Factor `setupOrchTestState` helper for orch-CLI tests

## Goal

The 6 behavior tests added to `src/orchestration/index.test.ts` in gh-ludics-374 (PR #393) duplicate
~25 lines of `LUDICS_HARNESS_DIR` + `stateFilePath(slot, harness)` scratch-state setup that any
future `runOrchestrationCli` subcommand test will repeat verbatim. The retrospective coder flagged
this for promotion when the next orch-CLI test lands. Anticipated work in gh-ludics-410 /
task-29bea074 will likely add such tests, so we proceed pre-emptively: factor a small helper into
`src/orchestration/runner.test-helpers.ts` (alongside `makeGitRepo`) and migrate `index.test.ts`
to use it. Save 15-20 lines per future orch-CLI test file, lock in correct env-restore semantics
(now lint-enforced by `lint-test-isolation` Rule 1), and consolidate the two divergent `makeState`
factories into one unified shape.

Source: gh-ludics-374 retrospective (coder's `suggestRefactorSummary` item 5 + durable learning L6).

## Acceptance Criteria

1. **`setupOrchTestState` exists** in `src/orchestration/runner.test-helpers.ts` and creates a
   fresh tmp harness, sets `LUDICS_HARNESS_DIR` to it, persists a minimal `OrchestrationState` JSON
   to `stateFilePath(opts.slot, harness)`, and returns `{ harness, tmpRoot, state, cleanup }`.
2. **`cleanup` restores env conditionally** — if `LUDICS_HARNESS_DIR` was unset at call time, the
   restore is `delete process.env.LUDICS_HARNESS_DIR`; if it was set, the restore reassigns the
   captured prior value. Unconditional `delete` is forbidden (would fail `lint-test-isolation`
   Rule 1). Cleanup also `rmSync`'s only its own `tmpRoot`.
3. **Env capture happens at call time** (inside the helper body), not at module load — each call
   gets its own snapshot, so multiple `setupOrchTestState` calls per test (or interleaved suites)
   never trample each other's restoration target.
4. **`tmpRoot` is returned distinct from `harness`** so callers can place worktree dirs at
   `join(tmpRoot, "wt-...")` (mirrors the existing `index.test.ts` pattern). `harness` lives at
   `join(tmpRoot, "harness")` and `orchestrationDir(harness)` is created inside the helper.
5. **State persistence uses `writeJsonFile`** from `src/json.ts` — not inline
   `writeFileSync(..., JSON.stringify(...))`.
6. **`makeState` in `runner.test-helpers.ts` is unified** to a single options-object form:
   `makeState({ slot?, agents?, phase?, taskId?, preparePeerSync?, overrides? })`. Defaults
   preserve current behavior of every existing call site (see Approach for the back-compat
   strategy). The pre-existing `index.test.ts:34-52` inline `makeState` is removed in favor of
   this unified factory.
7. **`setupOrchTestState` composes `makeState`** rather than duplicating the state literal:
   `setupOrchTestState(opts)` builds the state via `makeState({ ...opts, preparePeerSync: false })`
   (or with peer-sync prepared, depending on the caller's options) and writes it to
   `stateFilePath(state.slot, harness)`.
8. **All 6 tests in `src/orchestration/index.test.ts` are migrated** to call
   `setupOrchTestState({ slot, agents, ... })` inside each test (or in a shared `beforeEach`).
   The file's hand-rolled `beforeEach`, `afterEach`, `writeState` closure, and inline `makeState`
   all go away. Per-test boilerplate visibly shrinks (target: 15-20 lines saved per test, matching
   the retrospective estimate). Worktree dirs continue to live at `join(tmpRoot, "wt-...")`.
9. **All other existing `makeState` callers continue to compile and pass** (`runner.verification.test.ts`,
   `runner.auto-commit.test.ts`, `runner.escalation.test.ts`, `runner.hung-agents.test.ts`,
   `runner.lifecycle.test.ts`, `runner.phase-skipping.test.ts`, `runner.plan-warnings.test.ts`,
   `runner.pr-comments.test.ts`, `phases.test.ts`, `skills.test.ts`) — see the back-compat note in
   Approach.
10. **No `withTaskFile?` option** is added — we wait for a real test that reads `tasks/<taskId>.md`
    before pre-empting that need (resolved Q3).
11. **Verification passes**: `bun run typecheck && bun run lint && bun run build && bun test`.
    `lint-test-isolation` continues to pass.

## Context

**Helper destination** — `src/orchestration/runner.test-helpers.ts` already exports the sibling
`makeGitRepo` (real git-repo fixture) and `makeState` (state literal factory), plus
`makePeerSyncDir`, `makeSnapshot`, `makeMockTransport`, `noopTransport`, `markAgentDone`,
`makeLifecycle`, and `makeTmpDir`. Adding orch-state setup fits the file's existing scope.

**Migration target** — `src/orchestration/index.test.ts` (the entire 199-line file). The
boilerplate is concentrated in:

- `beforeEach`: `mkdtempSync` + `mkdirSync(orchestrationDir(harness))` + assigning
  `process.env.LUDICS_HARNESS_DIR`.
- `afterEach`: conditional env restore + `rmSync(tmpRoot)`.
- `writeState` closure: `writeFileSync(stateFilePath(state.slot, harness), JSON.stringify(state))`.
- Inline `makeState(slot, agents)` factory: per-test `OrchestrationState` literal (defaults
  `phase: "review"`, `taskId: "gh-ludics-374-test"`, `peerSyncDir: "/tmp/peer-sync"`).
- All 6 tests call `writeState(makeState(slot, [...agents]))` with only `slot` and `agents`
  varying.

**Resolution chain** — confirmed against current ludics HEAD:

- `harnessDir()` in `src/config.ts` reads `LUDICS_HARNESS_DIR` first, falls back to config.
  Setting the env var in the helper short-circuits config lookup.
- `stateFilePath(slot, harnessDir)` in `src/orchestration/state.ts` is a pure path join with
  `defaultHarnessDir()` fallback.
- `orchestrationDir(harnessDir)` in `src/orchestration/state.ts` is the sibling helper used to
  pre-create the parent directory before writing the JSON.
- `writeJsonFile` in `src/json.ts` is the project's standard JSON write primitive.

**Lint rules** — `scripts/lint-test-isolation.ts` enforces three rules. Most relevant here is
**Rule 1**: unconditional `delete process.env.LUDICS_HARNESS_DIR` is an error because it strips the
preload safety net (`src/test-setup.ts`) for every subsequent test in the same Bun process. The
helper's `cleanup` must respect this.

**`withTestHarness` does not compose** — it lives in `src/test-utils.ts` and is a
registration-time helper bound to `beforeEach`/`afterEach` callables. Its API ("register me, then
ask for the path each test") doesn't fit a per-call helper that varies `slot`/`agents` per
invocation. The two helpers operate at different call sites; duplication of ~6 lines
(`mkdtempSync` + env set + conditional restore) is cheaper than the API coupling. A future shared
primitive could unify them, but that's out of scope here.

**Pre-existing `makeState` shape** — current signature is positional:
`makeState(overrides: Partial<OrchestrationState> = {}, peerSyncDir?: string)`. It defaults to
`phase: "work"`, two-agent coder/reviewer set, `taskId: "feat"`, slot 1, and prepares peer-sync
sub-dirs (`plans/`, `reviews/`). The 6 callers in `index.test.ts` use a different inline
`makeState(slot, agents)` factory with `phase: "review"`, varying agents, and a fake
`peerSyncDir: "/tmp/peer-sync"` (no peer-sync prep). The two factories diverge in defaults; the
unified factory reconciles them via opts-object defaults.

**Existing positional callers** — `runner.verification.test.ts` alone has ~40+ call sites in the
forms `makeState()`, `makeState({ ... })`, `makeState({}, dir)`, and `makeState({ ... }, dir)`.
Other `runner.*.test.ts` files use similar positional shapes. Migrating all of them by hand is
busywork; the back-compat shim in Approach avoids it.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### 1. Helper signature

Add to `src/orchestration/runner.test-helpers.ts`:

```ts
export interface SetupOrchTestStateResult {
  harness: string;            // tmp harness dir (also assigned to LUDICS_HARNESS_DIR)
  tmpRoot: string;            // parent for ad-hoc fixtures (worktrees, etc.)
  state: OrchestrationState;  // the state that was persisted
  cleanup: () => void;        // restore env + rmSync(tmpRoot)
}

export function setupOrchTestState(opts: {
  slot: number;
  agents: AgentConfig[];
  taskId?: string;
  phase?: OrchestrationState["phase"];
  preparePeerSync?: boolean;
  overrides?: Partial<OrchestrationState>;
}): SetupOrchTestStateResult;
```

Body responsibilities:

1. Capture `prev = process.env.LUDICS_HARNESS_DIR` (may be `undefined`).
2. `tmpRoot = mkdtempSync(join(tmpdir(), "ludics-orch-test-"))`.
3. `harness = join(tmpRoot, "harness")`; `mkdirSync(orchestrationDir(harness), { recursive: true })`.
4. `process.env.LUDICS_HARNESS_DIR = harness`.
5. Build `state = makeState({ slot, agents, taskId, phase, preparePeerSync, overrides })`.
6. `writeJsonFile(stateFilePath(state.slot, harness), state)`.
7. Return `{ harness, tmpRoot, state, cleanup }`. `cleanup` does the conditional env restore (per
   `index.test.ts:71-74`'s existing pattern) and `rmSync(tmpRoot, { recursive: true, force: true })`.

### 2. Unified `makeState`

Change the signature to options-object:

```ts
export function makeState(opts: {
  slot?: number;
  agents?: AgentConfig[];
  phase?: OrchestrationState["phase"];
  taskId?: string;
  preparePeerSync?: boolean;
  peerSyncDir?: string;
  overrides?: Partial<OrchestrationState>;
} = {}): OrchestrationState;
```

Defaults preserve current behavior:

- `slot = 1`, `taskId = "feat"`, `phase = "work"`, `preparePeerSync = true`.
- `agents` defaults to the existing two-agent coder/reviewer pair.
- When `preparePeerSync` is true, `peerSyncDir` defaults to `makeTmpDir()` and `plans/` + `reviews/`
  sub-dirs are created (current behavior). When `false`, `peerSyncDir` defaults to
  `"/tmp/peer-sync"` (no creation) — matches the `index.test.ts` baseline. Callers may pass an
  explicit `peerSyncDir` to override.
- `overrides` is shallow-merged last, so explicit fields always win.

**Back-compat strategy** — to avoid migrating ~50 positional call sites in this PR, ship the
unified factory as the named export `makeState` AND keep a thin positional shim. Two viable
options:

- **Option A (preferred): rename + delegate.** Rename the new options-object factory to a single
  exported `makeState` and provide an overload signature for the legacy
  `(overrides, peerSyncDir)` form. The implementation distinguishes via `arguments.length` /
  `typeof opts.slot === "number"` heuristics, or — cleaner — by checking whether the first
  argument has any of the unified fields (`slot`, `agents`, `phase`, `taskId`,
  `preparePeerSync`, `overrides`) vs. plain `Partial<OrchestrationState>` fields. If neither is
  cleanly distinguishable (e.g., a caller passes `{ phase: "work" }` which is ambiguous: is it
  `overrides.phase` or `opts.phase`?), prefer Option B.

- **Option B (fallback): two named exports.** Keep the existing `makeState(overrides, peerSyncDir)`
  unchanged for current callers. Add `makeOrchState(opts)` as the new options-object factory.
  `setupOrchTestState` uses `makeOrchState`. The 6 `index.test.ts` callers also use
  `makeOrchState`. A future cleanup task migrates legacy callers to `makeOrchState` and removes
  the old `makeState`.

Implementer chooses A or B based on what reads cleaner; either satisfies the acceptance criteria.
Document the chosen back-compat strategy in a code comment near the export.

### 3. Migration of `index.test.ts`

Replace the file's `beforeEach`/`afterEach`/`writeState`/`makeState` machinery with a per-test or
shared `setupOrchTestState({ slot, agents })` call:

```ts
// before:
beforeEach(() => {
  tmpRoot = mkdtempSync(...);
  harness = join(tmpRoot, "harness");
  mkdirSync(orchestrationDir(harness), { recursive: true });
  process.env.LUDICS_HARNESS_DIR = harness;
  captured = [];
});
afterEach(() => {
  if (prevHarness === undefined) delete process.env.LUDICS_HARNESS_DIR;
  else process.env.LUDICS_HARNESS_DIR = prevHarness;
  rmSync(tmpRoot, { recursive: true, force: true });
});
function writeState(state: OrchestrationState): void { ... }
function makeState(slot: number, agents: AgentConfig[]): OrchestrationState { ... }

// after, per test:
test("happy path: ...", () => {
  if (!Bun.which("git")) return;
  const { tmpRoot, cleanup } = setupOrchTestState({
    slot: 7,
    agents: [{ name: "coder", ..., worktreePath: join(tmpRoot_placeholder, "wt-coder") }],
    phase: "review",
    taskId: "gh-ludics-374-test",
  });
  try {
    const repo = join(tmpRoot, "wt-coder");
    makeRepo(repo);
    addCommits(repo, 2);
    orchDiff(7, undefined, captureFn);
    // ... assertions ...
  } finally {
    cleanup();
  }
});
```

The `worktreePath` field needs `tmpRoot` available before the helper call. Two options:

- (a) Build worktree paths first using a stable `mkdtempSync` outside the helper, then pass them
  in (loses the helper's tmp-dir creation).
- (b) Use `setupOrchTestState` to get `tmpRoot`, then patch `state.agents[i].worktreePath` after
  via the returned `state` object (it's a reference). Slightly awkward but keeps the helper
  authoritative.
- (c) (preferred) Accept the small awkwardness: in tests, do a single `mkdtempSync` ahead of the
  helper if the test needs to reference `tmpRoot` in agent configs, OR use a path placeholder that
  the helper substitutes (e.g., agents specify worktree as `"wt-coder"` and the helper resolves
  relative paths against `tmpRoot`).

Recommended: (c) but kept simple — let the test do `const tmpRoot = makeTmpDir();` first, then pass
`{ ..., overrides: { ... }}` referencing `tmpRoot`. The helper accepts an optional `tmpRoot?:
string` to reuse an externally-created root, falling back to `mkdtempSync` when omitted. This
preserves the "single helper call per test" ergonomic for tests that don't need `tmpRoot` upfront,
and stays explicit for tests that do.

Final acceptance: each migrated test's body is shorter than the original, and the file's top-level
`beforeEach`/`afterEach`/closures shrink to either nothing or a single shared `cleanup` registration.

### 4. Edge cases

- **Multiple `setupOrchTestState` calls per test** — each must produce an independent tmp dir;
  cleanup of one must not affect the other. Calling `cleanup()` for each call site (or
  `cleanups.forEach(c => c())` in an `afterEach`) handles this.
- **Env restore correctness** — the helper captures `prev` per call. If `LUDICS_HARNESS_DIR` was
  unset at call time, `cleanup` does `delete`; if set, restores. This matches the existing
  `index.test.ts:71-74` pattern and passes Rule 1 of `lint-test-isolation`.
- **Concurrent test runners** — `mkdtempSync(tmpdir(), "...")` already prevents collisions; no
  mutex needed.
- **`backend` field on `OrchestrationState`** — currently optional. The helper does not force a
  value; tests that need `backend: "tmux"` set it via `overrides`.

## Scope

**In scope:**

- New `setupOrchTestState` helper in `src/orchestration/runner.test-helpers.ts`.
- Unified `makeState` (options-object form) in the same file, with back-compat for existing
  positional callers (Option A or B per Approach).
- Migration of all 6 tests in `src/orchestration/index.test.ts` to use the helper.
- Removal of the inline `makeState`, `writeState`, `beforeEach`, and `afterEach` machinery in
  `index.test.ts` that the helper subsumes.
- Continued passing of `bun run typecheck && bun run lint && bun run build && bun test`,
  including `lint-test-isolation`.

**Out of scope:**

- Migration of pre-existing positional `makeState` callers in
  `runner.verification.test.ts`, `runner.auto-commit.test.ts`, `runner.escalation.test.ts`,
  `runner.hung-agents.test.ts`, `runner.lifecycle.test.ts`, `runner.phase-skipping.test.ts`,
  `runner.plan-warnings.test.ts`, `runner.pr-comments.test.ts`, `phases.test.ts`,
  `skills.test.ts`. These continue to work via the back-compat shim or coexisting export. A
  follow-up task can migrate them once the unified factory has bedded in.
- Composition with `withTestHarness` (`src/test-utils.ts`) — explicitly stand-alone (Q3 in
  elaboration confirms; the two helpers cover different lifecycles).
- A `withTaskFile?: boolean` option to write a stub `tasks/<taskId>.md` — defer to a future test
  that actually reads task files (Q3 resolved as "skip pre-emptive").
- Moving or refactoring `makeGitRepo`, `addRealOrigin`, or other unrelated fixtures.

**Dependencies:** none. Targets current ludics HEAD. `lint-test-isolation` (PR #401) is already in
the test suite — the helper's env-restore pattern is designed to comply with Rule 1.
