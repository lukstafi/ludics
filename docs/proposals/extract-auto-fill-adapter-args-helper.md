# Extract autoFillAdapterArgs helper from slotStart

## Goal

The four tests in the `slotStart — t3code empty-args auto-fill` describe block
(in `src/slots/index.test.ts`) drive the full `slotStart(1)` and tolerate the
failure of the ensuing `runAdapterAction("start", …)` with a
`try { … } catch {}` wrapper + per-test 15s timeout. In practice, the t3code
adapter's `ensureServer` call occasionally *hangs* rather than failing fast,
blowing the 15s budget and reporting a false regression. This pollutes the
"baseline test count" that pair-coding agents rely on and was explicitly
flagged by both the reviewer and the coder in the `gh-ludics-308` retrospective.

Extract the auto-fill branch of `slotStart` into a pure helper
`autoFillAdapterArgs(ctx)` that computes the orchestration flags and reports
what needs to be persisted, without calling `runAdapterAction` /
`ensureServer`. Migrate the four affected tests to call the helper directly.
The race vanishes from the test path by construction, without touching the
production race path.

Related: retrospective of `gh-ludics-308`.

## Acceptance Criteria

- A helper named `autoFillAdapterArgs` (exported from `src/slots/index.ts`)
  encapsulates the auto-fill branch of `slotStart`: the block guarded by
  `(ctx.mode === "t3code" || ctx.mode === "tmux") && !ctx.adapterArgs.trim()`,
  from the `ctx.adapterArgs.trim()` check through the `journalAppend(…)` line,
  and strictly *before* the orchestration-state guard.
- The helper does not call `runAdapterAction`, `t3code.start`, or `ensureServer`
  — directly or transitively. It is safe to invoke in a unit test that never
  spawns a subprocess.
- The helper returns the computed adapter-args string plus whatever the caller
  needs to complete the "persist back to slot JSON" step (e.g. the updated
  `SlotData` and/or an explicit payload for `writeSlotJson` /
  `clusterPostSlotUpdate`). The exact return shape is an implementation
  choice, but it must be testable without I/O mocks beyond the existing
  harness tmp-dir setup.
- `slotStart` is refactored to delegate to the helper; the existing
  behaviour of `slotStart` (what ends up in `ctx.adapterArgs`, what gets
  written to slot JSON, what gets journaled, and what errors propagate) is
  preserved. No behaviour change in production.
- The four tests in the `slotStart — t3code empty-args auto-fill` block that
  currently drive `slotStart(1)` are migrated to call the helper directly:
  - `auto-fills orchestration flags when t3code slot has empty adapterArgs`
  - `auto-fills orchestration flags when adapterArgs is whitespace-only`
  - `auto-fills medium task without skip_plan — includes --plan`
  - `auto-fills medium task with skip_plan: true — omits --plan`
- For each migrated test, assertions are split into two:
  - (a) **"computes correct args"** — asserts against the helper's return
    value (e.g. the returned args string contains `--pair`, `--coder`,
    `--reviewer`, and `--plan` / no `--plan` as appropriate). The existing
    single-test may become two tests per case, or two `expect`s within one
    test — either is acceptable as long as both facets are covered.
  - (b) **"persists them"** — asserts that slot JSON ends up with the
    auto-filled args, via either a `writeSlotJson` spy or a direct
    `readSlotJson` readback (readback is simpler and matches the existing
    `readAdapterArgsFromSlots` helper in the test file).
- The per-test `15_000` ms timeout parameter is removed from the four
  migrated tests, and the `try { await slotStart(1); } catch {}` wrappers
  are removed.
- The fifth test in the block —
  `throws when no task is assigned and adapterArgs is empty` — is left
  unchanged. It exercises the pre-spawn rejection path (never reaches
  `runAdapterAction`), is not flake-prone, and should continue to drive
  `slotStart` end-to-end to cover the thrown-error contract at that layer.
- `bun test src/slots/index.test.ts` passes. Running the four migrated tests
  repeatedly (e.g. via `bun test --rerun-each 5 src/slots/index.test.ts`)
  does not produce a single 15s-timeout failure, because no spawn is
  attempted.
- `bun test` (whole suite) passes with no new failures. `eslint` /
  typecheck as configured for the repo pass.

## Context

### Production path under test

In `src/slots/index.ts`, `slotStart(slotNum, …)` does the following, in order:

1. `ensureSlotsDir()`, range validation, load `SlotData` via `readSlot`.
2. `makeAdapterContext(slotNum, data)` → builds an `AdapterContext` from
   `src/adapters/index.ts`.
3. Remote-dispatch early-return when `ctx.machine` is a remote machine.
4. **Auto-fill branch** — the target of this extraction. Triggers when
   `(ctx.mode === "t3code" || ctx.mode === "tmux") && !ctx.adapterArgs.trim()`.
   The block:
   - Throws if `ctx.taskId` is empty (`"no task is assigned"` message — this
     is the case the fifth test covers).
   - Loads the task file content: on worker via `clusterGetTask` HTTP, on
     controller via `readFileSync(taskFilePath(taskId))`. Throws `"task file
     not found"` if it can't read.
   - Parses `effort:` from task frontmatter (defaulting to `"small"`).
   - Calls `selectOrchestrationFlagsForTask(content, effort)` (from
     `src/adapters/t3code.ts`) to get `args`.
   - Throws if `args` is empty.
   - Mutates `data.adapterArgs = autoArgs` and persists: on worker via
     `clusterPostSlotUpdate` HTTP (fire-and-forget); on controller via
     `writeSlotJson(slotNum, data)`.
   - Mutates `ctx.adapterArgs = autoArgs`.
   - Emits `console.error` + `journalAppend("slot", …)` describing the
     auto-fill.
5. Orchestration-state guard (post-extraction, this remains in `slotStart`).
6. `await runAdapterAction("start", { ...ctx, startTtyd })` — this is what
   transitively hits `ensureServer` (in `src/adapters/t3code.ts`, first line
   of `start`). This is the spawn/attach call that races in tests.

The auto-fill block is already a clean seam: it has no dependency on
post-extraction code, its sole in-place mutations (`data.adapterArgs` and
`ctx.adapterArgs`) can be represented as helper outputs, and its I/O
(persistence + journaling) are either factored out into HTTP/FS calls that
can be re-invoked by the caller, or can become the helper's responsibility.

### Test file layout

`src/slots/index.test.ts`:

- The `describe("slotStart — t3code empty-args auto-fill", …)` block starts
  with a local `readAdapterArgsFromSlots()` helper that reads slot 1's
  `adapterArgs` from the harness tmp dir.
- Each of the four flaky tests uses the same pattern: `writeTask(…)`,
  `slotAssign(1, …, "t3code")`, `try { await slotStart(1); } catch {}`,
  assert on `readAdapterArgsFromSlots()`. Each carries a `15_000` ms
  per-test timeout.
- The file-level `setDefaultTimeout(15_000)` remains relevant for other
  tests and is not in scope for this task.

### Related symbols

- `makeAdapterContext(slotNum, data)` — returns `AdapterContext`; unchanged.
- `selectOrchestrationFlagsForTask(content, effort)` from
  `src/adapters/t3code.ts` — the core flag-selection logic; already
  independently tested.
- `isWorkerContext()`, `clusterGetTask`, `clusterPostSlotUpdate`,
  `writeSlotJson`, `readSlotJson`, `taskFilePath`, `journalAppend` —
  existing primitives the helper will compose.

### Sibling work (orthogonal)

`task-1b44d17b` touches `src/mag.ts` / `src/mag.test.ts` — different files,
no merge risk.

## Approach (suggested)

*Suggested approach — agents may deviate if they find a better path.*

### Helper shape

Export from `src/slots/index.ts` a function of roughly this shape:

```ts
export async function autoFillAdapterArgs(
  ctx: AdapterContext,
  data: SlotData,
): Promise<{ args: string; effort: string; updatedData: SlotData } | null>
```

Semantics:

- Returns `null` when auto-fill is not applicable
  (`!(ctx.mode === "t3code" || ctx.mode === "tmux")` or
  `ctx.adapterArgs.trim()` is non-empty). This keeps the "skip the block"
  branch symmetric with the existing code.
- Throws the same three errors as today (`no task is assigned`, `task file
  not found`, `selectOrchestrationFlagsForTask returned empty args`). The
  `throws when no task is assigned` test, which still uses the full
  `slotStart`, continues to rely on this behaviour.
- Does **not** persist. It returns `updatedData` so the caller decides
  whether to call `writeSlotJson` / `clusterPostSlotUpdate` and whether to
  mutate `ctx.adapterArgs`. This is what makes the helper pure and
  race-free.
- Does not emit `console.error` / `journalAppend` either — the caller
  (`slotStart`) handles those side effects. Alternatively, the helper can
  emit them; either is fine as long as unit tests don't end up asserting on
  journal output.

An equally valid shape is to return just `{ args, effort }` and have the
tests spy on `writeSlotJson` / round-trip through `readSlotJson` for the
"persists them" assertion. Pick the shape that keeps `slotStart` simplest.

### `slotStart` after extraction

```ts
const autoFill = await autoFillAdapterArgs(ctx, data);
if (autoFill) {
  data = autoFill.updatedData;            // or apply the returned args
  ctx.adapterArgs = autoFill.args;
  if (isWorkerContext()) {
    // fire-and-forget HTTP update
  } else {
    writeSlotJson(slotNum, data);
  }
  console.error(`ludics: slot ${slotNum}: auto-filled adapter args from task effort="${autoFill.effort}": ${autoFill.args}`);
  journalAppend("slot", `Slot ${slotNum} auto-filled adapter args: ${autoFill.args} (effort=${autoFill.effort})`);
}
```

### Test migration

For each of the four tests:

1. Build the `SlotData` / `AdapterContext` the same way the production path
   does (call `slotAssign(…)` + `readSlot(1)` + `makeAdapterContext(1, data)`,
   or just construct the context directly in-test — whichever is less
   code). The existing `slotAssign` + `readSlotJson` setup should be
   reusable.
2. `const result = await autoFillAdapterArgs(ctx, data)` — assert `result`
   is non-null and that `result.args` contains the expected flags (split (a)
   — "computes correct args").
3. If the chosen helper shape returns `updatedData`, write it with
   `writeSlotJson(1, result.updatedData, harness)`; then read back with
   `readSlotJson(1, harness)` and assert `adapterArgs` matches (split (b) —
   "persists them"). If the helper shape returns only `args`, assert the
   `writeSlotJson` spy was called with the expected args. Readback via
   `readSlotJson` is simpler and should be preferred.
4. Drop the `15_000` ms timeout arg and the `try { … } catch {}` wrapper.

The fifth test (`throws when no task is assigned and adapterArgs is empty`)
can be left alone — `slotStart` still calls the helper, and the helper
still throws the same `"no task is assigned"` error synchronously from
within `slotStart`, so the existing assertion
(`await expect(slotStart(1)).rejects.toThrow("no task is assigned")`)
continues to pass. (If the agent finds it cleaner to migrate this test too
to call the helper directly, that's acceptable — but it's not required, and
the task scope explicitly says leave it unchanged.)

## Scope

**In scope:**

- `src/slots/index.ts` — extract + export `autoFillAdapterArgs`, refactor
  `slotStart` to delegate.
- `src/slots/index.test.ts` — migrate the four tests in the
  `slotStart — t3code empty-args auto-fill` describe block as specified.

**Out of scope:**

- Investigating or fixing the `ensureServer` / `t3code.start` race itself.
  Per task Q3, defer that decision to post-extraction reassessment.
- Modifying `runAdapterAction`, `t3code.start`, or `ensureServer`.
- Other flaky tests outside this describe block.
- Changes to `src/mag.ts` / `src/mag.test.ts` (sibling task `task-1b44d17b`).

**Dependencies:** None. The extraction is a self-contained refactor inside
`src/slots/`.
