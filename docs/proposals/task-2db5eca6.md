# Proposal: Clear TTL-based debounce on task requests when priority is increased

**Task:** task-2db5eca6
**Project:** ludics
**Effort:** small

## Goal

Treat user-driven priority *increases* as an explicit "act on this now" signal that invalidates the auto-proposal debounce sentinel (`mag/auto-proposal-debounce/<task>.epoch`), so the next keepalive cycle re-evaluates the task instead of silently waiting out the 1800s TTL. Cover both priority-mutation surfaces (dashboard `/api/task-promote` and a new `ludics tasks priority` CLI subcommand) plus the queue-reorder surface (`/api/queue-promote`) for UX coherence. Priority *decreases* keep the debounce intact (asymmetric by design).

## Acceptance Criteria

Falsifier-style — each AC must fail if the corresponding code path is removed or its condition is flipped.

### Helper-level

- **AC1 (clear when present)** — Given a fresh debounce sentinel at `autoProposalDebounceFile("task-X")`, calling `clearAutoProposalDebounce("task-X")` removes the file. Asserted by `existsSync(...)` returning `false` afterward.
- **AC2 (idempotent when absent)** — Calling `clearAutoProposalDebounce("task-X")` when the file does not exist is a no-op (no throw).

### Dashboard `/api/task-promote`

- **AC3 (increase clears sentinel)** — Task at priority `B` with a fresh debounce sentinel: POST `/api/task-promote?task=task-X` returns `{ priority: "A" }`, frontmatter `priority` is now `A`, and the sentinel file is gone.
- **AC4 (no-op preserves sentinel)** — Task at priority `S` (clamp) with a fresh sentinel: POST returns `{ priority: "S" }`, sentinel **remains**. Mutation falsifier: gating the clear on `newPriority !== currentPriority` is required for this to pass.

### Dashboard `/api/slot-postpone` (asymmetry)

- **AC5 (decrease leaves sentinel intact)** — Slot N holds task at priority `A` with a fresh sentinel; POST `/api/slot-postpone?slot=N` decreases priority to `B` and clears the slot, but the sentinel **remains**. Mutation falsifier: removing the symmetric clear on the postpone path is required (this AC encodes that decision in code).

### Dashboard `/api/queue-promote`

- **AC6 (queue promote with task field clears sentinel)** — Queue contains items `[idA, idB, idC]` where `idC` carries `{ action: "draft-proposal", task: "task-X" }`; a fresh debounce sentinel exists for `task-X`. POST `/api/queue-promote?id=idC` returns `{ status: "promoted" }`, queue order becomes `[idC, idA, idB]`, and the sentinel for `task-X` is gone.
- **AC7 (queue promote without task field is harmless)** — A queue item like `{ action: "briefing" }` (no `task` field) promoted via the same endpoint returns `{ status: "promoted" }` and triggers no debounce clearing (no error, no spurious filesystem reads on unrelated tasks).

### CLI `ludics tasks priority`

- **AC8 (increase via CLI clears sentinel)** — `ludics tasks priority task-X A` (current `B`) updates frontmatter `priority` to `A` and removes the debounce sentinel for `task-X`.
- **AC9 (no-change via CLI preserves sentinel)** — `ludics tasks priority task-X B` (current `B`) is a no-op; sentinel **remains**.
- **AC10 (decrease via CLI preserves sentinel)** — `ludics tasks priority task-X C` (current `B`, an explicit decrease) updates the priority but does **not** clear the sentinel — same asymmetry as `/api/slot-postpone`. Mutation falsifier: removing the increase-only gate breaks this AC.
- **AC11 (validation)** — `ludics tasks priority task-X Z` (invalid level) exits non-zero with a usage error; `ludics tasks priority` (no args) exits non-zero.

### Cross-cutting

- **AC12 (single source of truth)** — All four call sites (dashboard `/api/task-promote`, `/api/queue-promote`, `/api/slot-postpone`, `ludics tasks priority`) reach `autoProposalDebounceFile` only via the shared exported helper — no duplicated `rmSync` on the debounce path elsewhere. Verified by grep in the test or by code review.

## Context

Surfaced 2026-04-30 while debugging why a priority-A elaborated task (`task-219f7b16`) was repeatedly skipped by the keepalive auto-fill: the auto-proposal debounce file is shared between the elaborate and draft-proposal phases (`src/mag.ts:2474–2511`, with the comment `reuse debounce to avoid re-queuing`), so once elaboration is queued, draft-proposal is silenced for the full 30-minute TTL. The user's "act on this now" gestures (priority bump in the dashboard, or via a CLI lever) need to invalidate that debounce so the next keepalive cycle re-evaluates eligibility.

This task does **not** split the elaborate↔draft-proposal shared debounce — that would be a separate change. This task is the user-driven invalidation lever: explicit priority increase ⇒ explicit signal ⇒ clear the sentinel.

### Resolved questions (verified during elaboration)

- **Q1 (CLI subcommand):** Add `ludics tasks priority <task-id> <level>` as part of this task. Dashboard and CLI are *independent* surfaces — `dashboard-server.ts:13` imports `addFrontmatterField` directly and the handler at line 297 calls it in-process; the CLI does not delegate to the dashboard. Therefore the design is a shared helper that both surfaces invoke.
- **Q2 (`/api/queue-promote`):** Also clear the debounce. Queue items are not the bounced/debounced requests, so this isn't load-bearing for the primary failure mode — but a queue promote is also an "act on this now" gesture, so clearing keeps UX coherent.
- **Q3 (priority decrease asymmetry):** Decreases (`/api/slot-postpone`, decrease via CLI) do **not** clear the debounce. A decrease is a de-prioritize signal; the debounce should stay set.

### Verified seams

- `src/mag.ts:2002–2014` — `AUTO_PROPOSAL_DEBOUNCE_SECONDS = 1800`, `autoProposalDebounceFile`, `autoProposalDebounced`, `markAutoProposalQueued`. `autoProposalDebounceFile` is currently `function` (not exported).
- `src/dashboard-server.ts:13` — imports `PRIORITY_INCREASE`, `PRIORITY_DECREASE`, `addFrontmatterField`, `updateFrontmatterField`, `parseTaskFrontmatter`, `TASK_ID_RE` from `./tasks/markdown.ts`.
- `src/dashboard-server.ts:284–306` — `/api/task-promote` handler; gates the `addFrontmatterField` call on `newPriority !== currentPriority`. Reuse the same gate for the clear.
- `src/dashboard-server.ts:241–281` — `/api/slot-postpone` handler; uses `PRIORITY_DECREASE`. Leave alone (asymmetry).
- `src/dashboard-server.ts:463–477` — `/api/queue-promote` handler; calls `queuePromoteToTop(id)` from `src/queue.ts`. The handler currently has no awareness of the underlying task. We will introduce that awareness via a queue-side helper that returns the promoted record (or its `task` field) so the handler can call `clearAutoProposalDebounce` when applicable.
- `src/queue.ts:132–139` — `QueueAction` discriminated union; the `task: string` field is present on all action variants that bind to a specific task (elaborate, draft-proposal, split-task, verify-completion, etc.).
- `src/queue.ts:215–229` — `queuePromoteToTop` currently returns just `"promoted" | "already-head" | "not-found"`. It already parses the line internally; extending it to return the request record on `"promoted"` is a one-line change.
- `src/tasks/markdown.ts:12–13` — `PRIORITY_INCREASE` / `PRIORITY_DECREASE` exported maps.
- `src/tasks/index.ts:647–870` (`runTasks` `switch (sub)`) — confirmed: no `priority` case today. Add one between `update` and `create`, or alongside `abandon`/`migrate-deferred`. Tests for similar subcommands live in `src/tasks/index.test.ts` (or are exercised via end-to-end CLI tests).
- `src/dashboard.test.ts:586–710` — `buildHandlers({ dashboardDir, ttlSeconds })` is the test-server harness for the dashboard handler tests. The `/api/queue-promote` block establishes the pattern (queue items via `queueRequest`, fire `Request`, assert via `queueList()`).
- No `dashboard-server.test.ts` exists — new dashboard handler tests go in `src/dashboard.test.ts` next to the existing `/api/queue-promote` describe block, reusing `makeHandler()`.

## Approach

### 1. Helper in `src/mag.ts`

Export a clear helper next to the existing debounce trio:

```ts
export function clearAutoProposalDebounce(taskId: string): void {
  rmSync(autoProposalDebounceFile(taskId), { force: true });
}
```

Keep `autoProposalDebounceFile` non-exported — only the helper crosses the module boundary. (Alternative: export `autoProposalDebounceFile` directly. Helper is preferred because it pins the operation in one place and matches the existing `markAutoProposalQueued` shape.)

### 2. Dashboard `/api/task-promote` — clear on increase

Add the clear inside the existing `newPriority !== currentPriority` branch, after the priority write:

```ts
if (newPriority !== currentPriority) {
  addFrontmatterField(taskFile, "priority", newPriority);
  clearAutoProposalDebounce(taskParam);
}
```

Falsifier coverage: AC3 + AC4. The gate ensures AC4 (no-op clamp) holds.

### 3. Dashboard `/api/queue-promote` — clear when item carries a task

Two-step:

a. Extend `queuePromoteToTop(id)` in `src/queue.ts` to return `{ status: "promoted"; record: Record<string, unknown> } | { status: "already-head" } | { status: "not-found" }`. The function already parses lines internally; thread the parsed record out on the success path.

b. In the dashboard handler, after `result.status === "promoted"`, inspect `result.record.task`; if it is a non-empty string, call `clearAutoProposalDebounce(task)`. The response body shape stays `{ status }` for API stability — just the internal type widens. (Alternative if we want to keep `queuePromoteToTop`'s signature stable: add a second exported helper `queuePromoteToTopWithRecord` or `queueLookup(id)` and have the handler call both. Direct signature widen is simpler and the call site count is small.)

Falsifier coverage: AC6 + AC7.

### 4. New CLI subcommand `ludics tasks priority`

In `src/tasks/index.ts`, add a new `priority` case to `runTasks`'s `switch (sub)`:

```ts
case "priority": {
  const id = args[1];
  const level = args[2];
  if (!id) throw new Error("task ID required");
  if (!level || !/^[SABCD]$/.test(level)) throw new Error("level required (S, A, B, C, or D)");
  await tasksSetPriority(id, level);
  break;
}
```

Implementation `tasksSetPriority(id, newPriority)`:
1. Resolve task file (reuse the existing resolver pattern from `tasksAbandon`).
2. Read current priority via `parseTaskFrontmatter`.
3. If `newPriority === currentPriority`, log a no-op message and return (AC9).
4. Otherwise, `addFrontmatterField(taskFile, "priority", newPriority)`.
5. Determine `isIncrease` by comparing rank in the `["D","C","B","A","S"]` scale (or by checking whether `PRIORITY_INCREASE[currentPriority] === newPriority` chained — simpler: a small `priorityRank` helper, or compare indices in the canonical array).
6. If `isIncrease`, call `clearAutoProposalDebounce(id)`. (AC8 / AC10.)
7. Print a one-line summary: `priority: B → A (debounce cleared)` or `priority: B → C (debounce kept)`.

Help text update: add the new subcommand to the existing usage string (search for the help-string emitter in `runTasks`).

Falsifier coverage: AC8 + AC9 + AC10 + AC11.

### 5. Tests

- **`src/mag.test.ts`** — add a `describe("clearAutoProposalDebounce")` block with AC1 + AC2. Use the existing tmpdir / harness setup pattern. Verify by `existsSync(autoProposalDebounceFile(...))` — since the helper is exported but the path function is not, expose the path via a test-only re-export or assert via `readdirSync(magStateDir() + "/auto-proposal-debounce")` for emptiness. (Simplest: re-export `autoProposalDebounceFile` *as well*. We already export `clearAutoProposalDebounce`; exporting the path getter with an `_` prefix or under a test-only namespace keeps the public surface narrow. Decision deferred to implementer; both choices satisfy the AC.)

- **`src/dashboard.test.ts`** — add a new `describe("dashboard HTTP /api/task-promote and /api/slot-postpone debounce semantics")` block next to the existing queue-promote describe. Reuse `makeHandler()`. Tests cover AC3, AC4, AC5, AC6, AC7. For AC5/AC6, manufacture a slot/queue state via `writeSlotJson` / `queueRequest`, write a sentinel via `markAutoProposalQueued` (or directly via `writeFileSync` if the helper isn't exported in tests), POST, then assert sentinel presence/absence.

- **`src/tasks/index.test.ts`** (or whichever file currently exercises the CLI subcommands — check for `tasksAbandon` tests) — add CLI-level tests for AC8, AC9, AC10. Drive `tasksSetPriority(...)` directly (faster than spawning the CLI) plus one end-to-end smoke for AC11.

### 6. Migration / docs

- Update `ludics help` / `ludics tasks --help` if there's a generated help string listing subcommands.
- No data migration; no config schema change; no template changes.

### Open implementation choices (intentionally deferred to implementer)

- Whether to export `autoProposalDebounceFile` for test access, or expose only `clearAutoProposalDebounce` and assert via directory listing. Either satisfies the ACs.
- Whether to widen `queuePromoteToTop`'s return type or add a parallel `queueLookup(id)` helper. Widening is simpler; the parallel helper is more conservative. Recommend widening (one consumer at the time of writing).
- Whether `tasksSetPriority` becomes the canonical mutation helper that `/api/task-promote` and `/api/slot-postpone` delegate to. Out of scope for this task — the dashboard handlers stay as-is; only the *clear* is shared via `clearAutoProposalDebounce`. A future refactor can consolidate the priority-write seams if desired.
