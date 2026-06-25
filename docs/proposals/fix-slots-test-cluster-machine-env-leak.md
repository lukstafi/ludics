# Fix broken test suite: neutralize ambient `LUDICS_CLUSTER_MACHINE_NAME` in tests

## Goal

Two tests in `src/slots/index.test.ts` fail when the suite is run from the
mac-studio controller shell, but pass in CI:

- `slotAssign machine default in federated setup > defaults machine to current
  node name when cluster config self-matches`
- `remote slot dispatch via HTTP > remote slotStop (non-force) writes a stop
  intent and returns early`

The failures are **not** a product regression. They are caused by the ambient
environment variable `LUDICS_CLUSTER_MACHINE_NAME=mac-studio`, which the
federation deployment exports into the controller's interactive shell (per
`MEMORY.md`) and which leaks into the Bun test process. Both tests rely on the
*hostname*-based self-match path of `clusterCurrentMachine()`; the ambient
override short-circuits that path with a name (`mac-studio`) absent from the
tests' synthetic cluster config, so `clusterCurrentMachine()` returns
`undefined` and the assertions fail.

The fix makes the test suite deterministic regardless of the launching shell's
environment.

## Acceptance Criteria

1. `bun test src/slots/index.test.ts` passes (0 failures) when run from a shell
   that exports `LUDICS_CLUSTER_MACHINE_NAME=mac-studio` (the controller shell).
   Verify by running `LUDICS_CLUSTER_MACHINE_NAME=mac-studio bun test
   src/slots/index.test.ts` and observing the two named tests pass.
2. The same file still passes when the variable is absent (CI-equivalent):
   `env -u LUDICS_CLUSTER_MACHINE_NAME bun test src/slots/index.test.ts` → 0
   failures.
3. The full repo suite (`bun test`) passes both with and without an ambient
   `LUDICS_CLUSTER_MACHINE_NAME` set in the launching shell. No existing test
   that *sets* `LUDICS_CLUSTER_MACHINE_NAME` inside its own body (e.g. the
   explicit-override tests in `src/cluster.test.ts`, `src/notify.test.ts`,
   `src/retrospective.test.ts`, `src/mag-doctor-cluster.test.ts`, and the
   guarded blocks within `src/slots/index.test.ts`) regresses.
4. The `clusterCurrentMachine()` override branch in `src/cluster.ts` is left
   unchanged — its fail-closed behavior (returning `undefined` for an
   override name not present in `cluster.machines`) is intentional product
   logic and must not be altered.

## Context

How it works now:

- `clusterCurrentMachine()` in `src/cluster.ts` resolves the current machine.
  Its first branch reads `process.env.LUDICS_CLUSTER_MACHINE_NAME`; if set, it
  returns `machines.find((m) => m.name === override)` and short-circuits the
  hostname-matching fallback. When the override names a machine absent from the
  config, this returns `undefined` (intended fail-closed escape hatch).
- The two failing tests in `src/slots/index.test.ts` build synthetic cluster
  configs (machines named `self-match-node` / `worker-a` / `self`, with `host`
  set to `os.hostname()`) and depend on the *hostname* self-match path. They do
  not guard against an inherited `LUDICS_CLUSTER_MACHINE_NAME`.
- Existing precedent for neutralizing ambient env state lives in
  `src/test-setup.ts`, a global preload registered via `bunfig.toml`
  (`preload = ["./src/test-setup.ts"]`). It already provides a safety net for
  `LUDICS_HARNESS_DIR` so every test file starts isolated. This is the natural,
  process-wide place to neutralize the cluster-machine override too.
- Other test files that exercise the override already save/clear/restore it in
  their own `beforeEach`/`afterEach` (`src/cluster.test.ts`,
  `src/notify.test.ts`, `src/retrospective.test.ts`,
  `src/mag-doctor-cluster.test.ts`, and several guarded blocks inside
  `src/slots/index.test.ts` itself). Those tests set the value *after* the
  preload/`beforeEach` runs, so clearing it up-front is compatible with them.

Key code pointers (by symbol, not line):

- `src/test-setup.ts` — the global preload safety net.
- `src/cluster.ts` — `clusterCurrentMachine()` (override branch) and
  `clusterCurrentMachineName()`; no change.
- `src/slots/index.test.ts` — file-level `beforeEach`, the two affected
  `describe` blocks.

Reproduction (confirmed): with `LUDICS_CLUSTER_MACHINE_NAME=mac-studio` set,
the file reports `120 pass / 2 fail`; with `env -u
LUDICS_CLUSTER_MACHINE_NAME`, it reports `122 pass / 0 fail`. The ambient value
is the sole cause.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Delete the ambient `LUDICS_CLUSTER_MACHINE_NAME` in the global test preload so
every test file starts from a clean cluster-identity slate, mirroring the
existing `LUDICS_HARNESS_DIR` safety net:

```ts
// src/test-setup.ts
// Tests that exercise the override set it explicitly in their own bodies;
// an ambient value leaked from a federation controller shell must not bleed in.
delete process.env.LUDICS_CLUSTER_MACHINE_NAME;
```

This is the most robust option: it makes the entire suite deterministic
regardless of the launching shell, not just the two currently-failing tests,
and it requires no change to `src/slots/index.test.ts`. The override-exercising
tests set the variable themselves after the preload runs and restore it in
their own `afterEach`/`finally`, so they are unaffected.

A more localized alternative — guarding only the two hostname-based tests in
`src/slots/index.test.ts` with the existing
`SAVED_MACHINE`/`ORIGINAL_MACHINE` save/clear/restore pattern — also works but
leaves the file fragile to the next hostname-dependent test that forgets the
guard. The preload fix is preferred.

Do **not** alter `clusterCurrentMachine()` to ignore a non-matching override:
that fail-closed behavior is intentional product logic (AC 4).

## Scope

In scope: making the test suite green and deterministic regardless of the
launching shell's `LUDICS_CLUSTER_MACHINE_NAME`. Subtask of the broken-test-suite
container task (`task-6f65bba0`).

Out of scope: any change to product behavior of `clusterCurrentMachine()` /
`clusterCurrentMachineName()`; extending `lint-test-isolation.ts` to detect
ambient-env leaks (a possible follow-up, not required here).
