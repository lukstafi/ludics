# withSyntheticHarness test helper

**Task**: task-bad0f605

## Goal

Replace ~25 lines of repeated `beforeEach`/`afterEach` boilerplate that sets up
`LUDICS_HARNESS_DIR` + `LUDICS_CONFIG` + `LUDICS_CLUSTER_MACHINE_NAME` across
three integration tests with a single shared helper. Without this helper, any
future `resolveQueueRequestCommand` integration test re-discovers the trap that
motivated `task-4889872a` (PR #390): without a synthetic config,
`runAllTestHealth()` loads the real user config and runs the actual project
test suites for OCANNL + ppx_minidebug, which then hang. The reusable helper
is cheap insurance against that trap.

This is option (a) from the task elaboration — the drop-in env-var helper.
Option (b) (an injectable seam in `resolveQueueRequestCommand`) was considered
and deferred (see Scope below).

## Acceptance Criteria

- [ ] A new exported function `withSyntheticHarness` is added to
      `src/test-utils.ts`.
- [ ] Its signature mirrors the existing `withTestHarness`:
      `withSyntheticHarness(before, after, opts?)` and returns a
      `() => string` getter for the current synthetic state directory.
- [ ] `opts` is an optional object with a `projects?: ProjectConfig[]` field
      (defaulting to `[]`). When provided, it is serialized into the synthetic
      `config.yaml`.
- [ ] On each `before`, the helper:
  1. creates a fresh tmpdir under `os.tmpdir()`,
  2. writes a minimal valid `config.yaml` at `<tmpdir>/config.yaml`
     (`state_repo: test/state`, `state_path: harness`, plus `projects` from
     `opts` or `[]`),
  3. sets `process.env.LUDICS_HARNESS_DIR = <tmpdir>`,
  4. sets `process.env.LUDICS_CONFIG = <tmpdir>/config.yaml`,
  5. deletes `process.env.LUDICS_CLUSTER_MACHINE_NAME`.
- [ ] On each `after`, the helper restores all three env vars to their original
      values (deleting if originally unset, never assigning the literal string
      `"undefined"`) and removes the tmpdir recursively.
- [ ] Originals for all three env vars are captured at **registration time**
      (closure scope), not inside the `before` callback — matching the
      double-registration discipline of `withTestHarness`.
- [ ] `src/test-utils.test.ts` adds tests for `withSyntheticHarness` mirroring
      the existing `withTestHarness` test suite shape, including:
  - sets all three env vars correctly during a before/after cycle
  - restores captured sentinel values after teardown
  - restores undefined when originals were unset (not `"undefined"`)
  - tmpdir is removed after teardown
  - `config.yaml` is written with `projects: []` by default
  - `config.yaml` reflects an explicit `projects` override when provided
  - double registration: each helper restores the real original, not a
    sibling's tmpdir or config path
- [ ] `src/mag-health-gate.test.ts` is migrated to use `withSyntheticHarness`
      and continues to pass. The test-specific scaffolding (`journal/`,
      `mag/`, fixture files) remains in the test's own `beforeEach`, called
      after the helper has set up the tmpdir.
- [ ] `src/mag-auto-compact.test.ts` is migrated to use `withSyntheticHarness`
      and continues to pass.
- [ ] `src/mag-ready-candidates.test.ts` is migrated to use
      `withSyntheticHarness` and continues to pass.
- [ ] After migration, none of the three test files contains explicit
      `process.env.LUDICS_CONFIG` / `LUDICS_HARNESS_DIR` /
      `LUDICS_CLUSTER_MACHINE_NAME` save/restore boilerplate.
- [ ] `bun run typecheck && bun run lint && bun run build && bun test` all pass.

## Context

Existing helpers and call sites:

- **`src/test-utils.ts`** — currently exports `withTestHarness(before, after)`,
  which manages `LUDICS_HARNESS_DIR` + tmpdir only. Captures the original env
  value at registration (not inside `before`) to handle double registration.
  Returns a `() => string` getter. The new helper lives alongside it and follows
  the same idiom.
- **`src/test-utils.test.ts`** — reference shape for the new tests, including a
  `captureHooks()` helper that accumulates `before`/`after` callbacks for unit
  testing the registration helpers.
- **`src/mag-health-gate.test.ts`** — the canonical call site (see the
  `beforeEach` block at the top of the `describe` and the matching `afterEach`).
  The existing minimal config body is exactly:
  ```
  state_repo: test/state
  state_path: harness
  projects: []
  ```
- **`src/mag-auto-compact.test.ts`** and **`src/mag-ready-candidates.test.ts`** —
  same env-var trio dance at the top of the file (module-scoped `ORIGINAL_*`
  constants + `beforeEach`/`afterEach`). Both `delete process.env.LUDICS_CONFIG`
  rather than writing a synthetic config — for them, the helper is still
  appropriate because writing an empty-projects config is functionally
  equivalent to deleting `LUDICS_CONFIG` (both make `runAllTestHealth()` a
  no-op, the former more explicitly).
- **`src/mag.ts` — `resolveQueueRequestCommand`** — the function under test in
  these integration tests. Its `health-check` action branch dynamically imports
  `./health.ts` and calls `runAllTestHealth()`, which is the trap.
- **`src/health.ts` — `runAllTestHealth`** — calls `loadConfigSync()` and
  iterates `config.projects`. With `projects: []` it's a no-op.
- **`src/config.ts` — `ProjectConfig`** (interface, line 17) — the type for
  the optional `projects` argument. Import from `./config.ts`.

The test files all keep their per-test fixture setup (writing
`journal/events.jsonl`, `mag/health-last.json`, etc.) inside the test body or
`beforeEach`. The helper's tmpdir getter gives them the path they need.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Add `withSyntheticHarness` to `src/test-utils.ts`, structurally mirroring
   `withTestHarness`:

   ```ts
   import type { ProjectConfig } from "./config.ts";
   import { writeFileSync } from "fs";
   import { dump } from "js-yaml"; // or hand-roll the small YAML — see note

   export interface WithSyntheticHarnessOptions {
     projects?: ProjectConfig[];
   }

   export function withSyntheticHarness(
     before: (fn: () => void) => void,
     after: (fn: () => void) => void,
     opts?: WithSyntheticHarnessOptions,
   ): () => string {
     const savedHarness = process.env.LUDICS_HARNESS_DIR;
     const savedConfig = process.env.LUDICS_CONFIG;
     const savedCluster = process.env.LUDICS_CLUSTER_MACHINE_NAME;
     let dir = "";
     before(() => {
       dir = mkdtempSync(join(tmpdir(), "ludics-test-synthetic-"));
       const cfgPath = join(dir, "config.yaml");
       const projects = opts?.projects ?? [];
       // Minimal valid config; runAllTestHealth() is a no-op when projects=[].
       const cfgBody =
         "state_repo: test/state\n" +
         "state_path: harness\n" +
         (projects.length === 0
           ? "projects: []\n"
           : `projects:\n${dump(projects).replace(/^/gm, "  ").trimEnd()}\n`);
       writeFileSync(cfgPath, cfgBody);
       process.env.LUDICS_HARNESS_DIR = dir;
       process.env.LUDICS_CONFIG = cfgPath;
       delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
     });
     after(() => {
       if (savedHarness === undefined) delete process.env.LUDICS_HARNESS_DIR;
       else process.env.LUDICS_HARNESS_DIR = savedHarness;
       if (savedConfig === undefined) delete process.env.LUDICS_CONFIG;
       else process.env.LUDICS_CONFIG = savedConfig;
       if (savedCluster === undefined) delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
       else process.env.LUDICS_CLUSTER_MACHINE_NAME = savedCluster;
       rmSync(dir, { recursive: true, force: true });
     });
     return () => dir;
   }
   ```

   Note on YAML serialization: if `js-yaml` is already a project dependency
   (check `package.json`), use it. Otherwise the simplest implementation hand-
   rolls the empty-projects case (the only one currently used) and accepts a
   `projects` override only via stringified YAML, or pulls in whatever
   serializer `loadConfigSync()` already uses for symmetry. Pick the path that
   adds the least new dependency surface.

2. Add tests in `src/test-utils.test.ts` mirroring the `withTestHarness`
   `describe` block, plus tests for the `projects` override (config file is
   parsed back and contains the supplied entries).

3. Migrate the three call sites. For each: drop the `ORIGINAL_*` constants,
   the env-var lines in `beforeEach`, and the env-restore lines in `afterEach`
   (and `rmSync(stateDir, ...)` for `mag-health-gate.test.ts`). Replace with:

   ```ts
   const getStateDir = withSyntheticHarness(beforeEach, afterEach);
   ```

   Then refer to `getStateDir()` wherever the test previously used `stateDir`
   / `tmpDir`. Per-test fixture writes (`journal/events.jsonl`, etc.) stay
   in their existing `beforeEach` blocks but use `getStateDir()` for paths.

4. Run typecheck/lint/build/test and confirm all three migrated tests still
   pass.

## Scope

**In scope**:
- New `withSyntheticHarness` helper in `src/test-utils.ts` with the optional
  `projects` parameter.
- Unit tests in `src/test-utils.test.ts`.
- Migration of `mag-health-gate.test.ts`, `mag-auto-compact.test.ts`, and
  `mag-ready-candidates.test.ts` to use the helper.

**Out of scope**:
- Option (b) — injecting `runAllTestHealth` via a parameter or module-level
  seam in `resolveQueueRequestCommand`. The user chose option (a). Option (b)
  remains reversibly addable later.
- Other tests that touch only one or two of the three vars (e.g., tests using
  `LUDICS_CONFIG` + `LUDICS_HARNESS_DIR` without the cluster-name dance).
  Those don't share the same trap and are left alone for now.
- Other ambient `LUDICS_*` env vars (`LUDICS_FORCE_*`, `LUDICS_DRY_RUN`, etc.)
  not currently part of the documented trap. Add reactively when a future test
  reveals a new ambient leak.
- Composing `withSyntheticHarness` with `withTestHarness` in the same
  `describe` — they both manage `LUDICS_HARNESS_DIR` and would collide. Tests
  pick one or the other, never both.

**Dependencies**: none. Independent of `task-764e16b1` (CLI + negative-delta
fail-open from the same retrospective).
