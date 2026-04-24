# Audit: AdapterContext.harnessDir bypass in src/adapters and src/orchestration

**Task**: task-f60547cd
**Related**: gh-ludics-306 retrospective; sibling task-68fe7177 (CI lint, preventive)

## Goal

Make `ctx.harnessDir` (and the equivalent caller-supplied harness directory in
orchestration code paths) an *authoritative* boundary rather than an advisory
hint. Today, several functions that take an `AdapterContext` — or that operate
on `OrchestrationState` loaded from a caller-specified harness directory —
internally re-resolve paths through the global `harnessDir()` from
`src/config.ts`, silently defeating the parametrization.

This is a correctness issue, not just style: tests that pass
`{ harnessDir: tmpDir }` through `AdapterContext` appear isolated but
actually mutate global harness state when the production code reaches
`harnessDir()` transitively (this was exactly the bug that escalated
PR #349 from 5 to 7 files). In multi-harness scenarios (federation, cluster,
future deployments) these bypasses collapse silently to the single global.

The widened scope (Option B, resolved in elaboration Q&A 2026-04-24) covers:

- `src/adapters/manual.ts` — 3 call sites
- `src/orchestration/skills.ts` — 4 call sites
- `src/orchestration/runner.ts` — 3 call sites (plus 2 collateral `harnessDir()` calls in the self-guard block)
- `src/orchestration/deferred-cleanup.ts` — 4 call sites

Explicitly **deferred to the parameter-injection epic**:
`src/events.ts::emitEvent` (~40 fan-out callers; too large for this task).

## Acceptance Criteria

1. **`src/adapters/base.ts` signatures widened**:
   - `adapterStateDir(name: string, harnessDir: string = defaultHarnessDir()): string`
   - `ensureAdapterStateDir(name: string, harnessDir: string = defaultHarnessDir()): string`
   - Import convention matches `src/orchestration/state.ts` and
     `src/t3code/server.ts`: `import { harnessDir as defaultHarnessDir } from "../config.ts"`.
   - Default arg preserves backward compatibility for any caller that has no
     context; no existing call site outside `manual.ts` is affected.

2. **`src/adapters/manual.ts` threads `ctx.harnessDir`**:
   - `slotFile(ctx)` passes `ctx.harnessDir` to `adapterStateDir`.
   - `statusFile(ctx)` passes `ctx.harnessDir` to `adapterStateDir`.
   - `stop(ctx)` passes `ctx.harnessDir` to `adapterStateDir` when building
     `archiveDir`.
   - `start(ctx)` passes `ctx.harnessDir` to `ensureAdapterStateDir`.
   - No remaining unparametrised `adapterStateDir(...)` / `ensureAdapterStateDir(...)` calls in `manual.ts`.

3. **New task-file path helper** (for reuse across skills.ts / runner.ts):
   - A function `taskFilePath(taskId: string, harnessDir: string = defaultHarnessDir()): string`
     that returns `join(harnessDir, "tasks", \`${taskId}.md\`)`.
   - Location is an implementation choice (a new small utility module, or
     co-located in `src/orchestration/util.ts` or a new
     `src/orchestration/paths.ts`). Must NOT live inside skills.ts if that
     would create import cycles; the grep shows runner.ts already imports from
     skills.ts, so the helper should be upstream of both.

4. **`src/orchestration/skills.ts` uses the helper with threaded harnessDir**:
   - `taskSpecBriefText(state)` resolves the task-file path through the helper
     with the harness directory threaded from the orchestration context
     (see AC 5 for how state carries it).
   - `taskSpecText(state)` — same.
   - `extractAcceptanceCriteria(taskId, harnessDir)` — signature widened to
     accept the harness dir; pass-through from `buildSkillContext`.
   - `buildSkillContext(state, agent)` — the `_taskPath` computation uses the
     helper with the threaded harness dir.
   - No remaining `join(harnessDir(), "tasks", …)` literals in skills.ts.

5. **How harnessDir reaches skills.ts / runner.ts / deferred-cleanup.ts**:

   `OrchestrationState` does not currently carry a `harnessDir` field. The
   simplest path is to **add an optional** `harnessDir?: string` **field** to
   `OrchestrationState` (populated at orchestration init in `runOrchestration`
   /`runOrchestrationForSlot`), and have the affected helpers read
   `state.harnessDir ?? defaultHarnessDir()`. This is a small, surgical
   addition — it does NOT require touching the ~40 `emitEvent` call sites
   (those remain deferred) and it does NOT require threading an extra
   parameter through every intermediate helper.

   Alternative (acceptable if agents find it cleaner): pass `harnessDir` as an
   explicit parameter to the top-level entry points
   (`buildSkillContext`, `runOrchestration`, `surfaceManualIntervention`,
   `processDeferredCleanups`) and thread it down from there. Either works;
   whichever the agents pick must match the `defaultHarnessDir()` fallback
   convention so default-argument callers still compile.

6. **`src/orchestration/runner.ts` sites fixed**:
   - `surfaceManualIntervention(taskId, questionLine, harnessDir?)` — signature
     widened; taskFile resolution uses the helper.
   - `ensureTtydAlive(state)` — the inner `const dir = harnessDir();` and the
     subsequent `readTmuxSlotState(state.slot, dir)` use the harness dir from
     `state` (via AC 5).
   - `runOrchestration` — the end-of-completion block's `taskFile` construction
     uses the helper with the harness dir from `state`.
   - Collateral, inside the self-guard block (lines ~1620-1622):
     `readSlotState(state.slot, harnessDir())` and
     `readTmuxSlotState(state.slot, harnessDir())` likewise thread the harness
     dir from `state`. These are the same class of bypass and are in scope.

7. **`src/orchestration/deferred-cleanup.ts` sites fixed**:
   - `cleanupPendingPath(harnessDir: string = defaultHarnessDir()): string`
   - `saveDeferredCleanups(entries, harnessDir: string = defaultHarnessDir()): void`
     — also uses the arg for the `join(harnessDir, "mag")` mkdir line.
   - `loadDeferredCleanups(harnessDir: string = defaultHarnessDir()): CleanupEntry[]`
   - `processDeferredCleanups(thresholdHours?, harnessDir: string = defaultHarnessDir()): Promise<void>`
     — uses the arg for both `loadDeferredCleanups` / `saveDeferredCleanups`
     calls AND for `serverStatus({ harnessDir })`.
   - `cancelDeferredCleanup(taskId, slot, harnessDir: string = defaultHarnessDir()): void`
   - `recordDeferredCleanup(entry, harnessDir: string = defaultHarnessDir()): void`
   - Callers in `src/adapters/t3code.ts`, `src/adapters/tmux-adapter.ts`,
     `src/slots/index.ts`, `src/mag.ts` are updated to pass the appropriate
     harness dir (from `ctx.harnessDir` at adapter sites; mag.ts keeps the
     default since it operates on the global harness).

8. **Tests pass, including without env-var belt-and-suspenders**:
   - `bun test` passes with no regressions.
   - `src/adapters/manual.test.ts` passes with or without the
     `LUDICS_HARNESS_DIR` env wiring — the explicit wiring becomes optional.
     (Whether to simplify the test is a judgment call for the coder; not
     required by this task.)
   - Existing explicit-harness test patterns (e.g., in
     `deferred-cleanup.test.ts`, `skills.test.ts`) either continue to work
     under the new default-arg convention or are updated minimally.

9. **No (b)-style inline bypass-documentation** introduced — per the
   resolved Q&A, every site gets the (a)-style fix.

10. **Out of scope, explicitly**:
    - `src/events.ts::emitEvent` — the ~40-site fan-out belongs to the
      parameter-injection epic. Leave as-is.
    - `src/config.ts::harnessDir()` itself — not touched.
    - Any broader "thread `harnessDir` through every helper in src/" —
      this task is surgical, scoped to the offenders enumerated above.

## Context

### The two bypass shapes

**Shape A — adapter-side bypass** (`src/adapters/manual.ts`):
a function takes `AdapterContext` but calls
`adapterStateDir(ADAPTER_NAME)` (from `src/adapters/base.ts`), which
internally calls `harnessDir()` and ignores `ctx.harnessDir`. Only
`manual.ts` exhibits this; other adapters (`t3code.ts`, `tmux-adapter.ts`,
`bookmark.ts`, `agent-session.ts`, `task-launch.ts`) already thread
`ctx.harnessDir` throughout.

**Shape B — orchestration-side bypass** (`src/orchestration/*.ts`):
a function operates on `OrchestrationState` loaded from a caller-specified
harness dir, but then internally calls `harnessDir()` for subsequent path
resolutions. Unlike the adapter side, `OrchestrationState` does not
currently carry a `harnessDir` field — hence AC 5's recommendation to
add one (or pass it explicitly through the entry points).

### Established convention (in-repo)

Already in use at `src/orchestration/state.ts` (lines 230-320) and
`src/t3code/server.ts` (lines 65-108):

```ts
import { harnessDir as defaultHarnessDir } from "../config.ts";

export function orchestrationDir(harnessDir: string = defaultHarnessDir()): string {
  return join(harnessDir, "orchestration");
}

export function stateFilePath(slot: number, harnessDir: string = defaultHarnessDir()): string {
  return join(orchestrationDir(harnessDir), `slot-${slot}.json`);
}

export function readOrchestrationState(
  slot: number,
  harnessDir: string = defaultHarnessDir(),
): OrchestrationState | null { … }
```

All new and widened signatures in this task must match this convention:
parameter name `harnessDir`, default value `defaultHarnessDir()`, import
aliased from `../config.ts`.

### Code pointers (by symbol; line numbers drift)

- `src/adapters/base.ts::adapterStateDir` / `ensureAdapterStateDir` — AC 1.
- `src/adapters/manual.ts::slotFile` / `statusFile` / `start` / `stop` — AC 2.
- `src/orchestration/skills.ts::taskSpecBriefText` / `taskSpecText` /
  `extractAcceptanceCriteria` / `buildSkillContext` — AC 4.
- `src/orchestration/runner.ts::surfaceManualIntervention` / `ensureTtydAlive`
  / `runOrchestration` completion block / self-guard block — AC 6.
- `src/orchestration/deferred-cleanup.ts` (whole file) — AC 7.
- `src/orchestration/state.ts` — reference convention + candidate home
  for the optional `harnessDir` field on `OrchestrationState` (AC 5).

### Why no (b) bypasses

The adapter-side AdapterContext callers have `ctx.harnessDir` already in
scope; threading it is cost-free.  The orchestration-side functions have
the harness dir *implicitly* in scope via the running process's
`LUDICS_HARNESS_DIR` env var (set by `startOrchestrationProcess`), which
is why the bypasses don't currently break anything — the global agrees with
the caller's intent. But the moment a different code path loads
`OrchestrationState` with a non-default harness dir, the bypass would
silently misroute. Threading the dir makes the boundary real rather than
relying on env-var alignment.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The design Q&A is resolved, so this is the recommended ordering:

1. **Widen `base.ts` signatures** (2 functions, backward-compatible via
   defaults). Import `harnessDir as defaultHarnessDir` from `../config.ts`.
2. **Fix `manual.ts`** (4 call sites: `slotFile`, `statusFile`, `stop`
   archive dir, `start` ensure). No new function signatures needed;
   callers already have `ctx.harnessDir`.
3. **Introduce `taskFilePath` helper** in a shared utility module
   (a new `src/orchestration/paths.ts` file is a reasonable home; or reuse
   `src/orchestration/util.ts` if import cycles allow — verify by trial).
4. **Add optional `harnessDir?: string` to `OrchestrationState`** in
   `src/orchestration/state.ts`, and populate it at orchestration init
   in `runOrchestration` / `runOrchestrationForSlot`. This is the one
   non-signature change; it's small and migration-safe because
   `migrateState` already tolerates missing optional fields.
5. **Fix `skills.ts`** (4 sites): replace `join(harnessDir(), "tasks", ...)`
   with `taskFilePath(id, state.harnessDir ?? defaultHarnessDir())`.
   Widen `extractAcceptanceCriteria`'s signature to accept an explicit
   harnessDir (or a state), threading from `buildSkillContext`.
6. **Fix `runner.ts`** (3 enumerated sites + 2 collateral self-guard sites):
   same pattern. Widen `surfaceManualIntervention`'s signature;
   `ensureTtydAlive` and `runOrchestration` already have `state` in scope.
7. **Widen `deferred-cleanup.ts`** — all 6 exported functions, mechanical.
   Update the 4 call sites in `t3code.ts`, `tmux-adapter.ts`,
   `slots/index.ts`, `mag.ts` to pass `ctx.harnessDir` (adapter sites) or
   rely on the default (mag.ts, which operates globally).
8. **Run `bun test`**; fix any test that relied on the silent bypass.
   If `manual.test.ts` no longer needs the `LUDICS_HARNESS_DIR` env
   wiring, the coder may simplify it — but that cleanup is optional and
   can be deferred if it enlarges the diff.
9. **Verify** that the `deferred-cleanup.test.ts` tests still pass —
   they use `LUDICS_HARNESS_DIR` to set up a tmp harness, and the default
   arg will still pick that up.

Each step is independently reviewable and backward-compatible. The task
is mostly mechanical signature threading; the one judgment call is
AC 5 (how to thread the harness dir into `OrchestrationState` consumers).

## Scope

**In scope:**
- Everything enumerated in AC 1-7 above.
- Test-side updates needed to keep `bun test` green.

**Out of scope:**
- `src/events.ts::emitEvent` (~40 fan-out sites) — deferred to the
  parameter-injection epic.
- `src/config.ts::harnessDir()` — not touched.
- Any test-isolation lint work — sibling task-68fe7177 handles that
  preventively; this task is corrective.
- Broader "thread harnessDir through every helper" refactor.

**Dependencies:**
- None blocking. Can proceed immediately.
- Sibling task-68fe7177 (CI lint) is complementary; ordering-wise, landing
  this task first makes that lint's allowlist note more meaningful, but
  the two don't block each other.
