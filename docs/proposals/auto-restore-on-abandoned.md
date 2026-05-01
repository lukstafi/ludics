# Auto-restore preempted work on `abandoned`, not just `done`

## Goal

When a priority task that displaced an earlier session is removed for good
(`done` *or* `abandoned`), the displaced task should resume automatically.
Today, only the `done` path triggers `slotRestore`; the `abandoned` path
(Dismiss tile, Abandon-deferred tile, `tasksAbandon` for slotted tasks)
silently leaves the displaced task in `status: preempted` with an orphaned
stash file under `mag/preempted/slot-N.json`.

The `ready` (Postpone) path must remain unchanged — the preempting task is
coming back and would race for the slot.

Tracked in task `task-4028c493`. Related sibling: `task-ad39a394` removes
slot-aware handling from `/api/stale-abandon` so stale tasks can never be
slotted at the API boundary; this proposal is correct on its own and does
not depend on that sibling.

## Acceptance Criteria

- [ ] In `slotClear` (file `src/slots/index.ts`), the auto-restore guard is
      extended from `finalStatus === "done"` to
      `["done", "abandoned"].includes(finalStatus)` (or equivalent
      conditional). `"merged"` is **not** added — it is rejected by
      `VALID_CLEAR_STATUSES` and has no callsite, so adding it would be
      unreachable defense-in-depth.
- [ ] The `ready` (Postpone) path continues to skip auto-restore, so
      `slotClear(N, "ready")` with a stash present leaves the stash on disk
      and does not call `slotRestore`. This is also load-bearing for the
      stale→abandoned tile path in `/api/stale-abandon`, which intentionally
      passes `"ready"` after flipping the task status itself.
- [ ] Immediately before `await slotRestore(slotNum)` the call site emits a
      journal line and an event that mention the trigger. Concretely: a
      `journalAppend("slot", ...)` and an `emitEvent({...})` call at the
      `slotClear` callsite. `slotRestore`'s signature is unchanged.
    - Suggested journal text: `Slot ${slotNum} auto-restoring preempted work
      (trigger: ${finalStatus})`.
    - Suggested event: `{ event_type: "slot_auto_restore", source: "cli",
      scope: "slot", slot: slotNum, message: \`trigger: ${finalStatus}\` }`.
      Exact `event_type` and `message` formatting may follow whatever fits
      the existing `emitEvent` patterns in the file (see `slot_preempt`,
      `slot_restore`, `slot_clear`).
- [ ] Existing `console.error` log line is preserved (or upgraded) so the
      trigger is visible there too — e.g.
      `ludics: auto-restoring preempted work to slot ${slotNum} (trigger:
      ${finalStatus})`.
- [ ] Test added (Bun, integration-style following
      `src/slots/slot-clear-integration.test.ts`): a preempting task →
      `slotClear(N, "abandoned")` triggers `slotRestore(N)`, the displaced
      task transitions `preempted → in-progress`, the stash file
      `mag/preempted/slot-${N}.json` is removed, and the new
      `slot_auto_restore` event is emitted with `trigger=abandoned` (assert
      via `journal/events.jsonl` or a stub on `emitEvent`, following
      whichever style fits the existing test harness).
- [ ] Test added: a preempting task → `slotClear(N, "ready")` does **not**
      auto-restore. Stash file remains on disk; no `slot_auto_restore`
      event is emitted; the displaced task stays at `status: preempted`.
- [ ] (Optional, defensive) Regression test: `slotClear(N, "done")` with a
      stash still auto-restores and now logs `trigger=done`.
- [ ] `bun run build` and `bun test` pass.

## Context

### The auto-restore guard

In `src/slots/index.ts`, `slotClear` finishes by checking for a stash and
restoring it. The current guard:

```ts
// Auto-restore preempted work when priority task completes
if (finalStatus === "done" && hasStash(slotNum)) {
  console.error(`ludics: auto-restoring preempted work to slot ${slotNum}`);
  await slotRestore(slotNum);
}
```

This sits after `stateMarkDirty()` and before the t3code cleanup block.

### Why `abandoned` is safe to add

- `VALID_CLEAR_STATUSES = ["ready", "in-progress", "done", "abandoned"]`.
  Only `ready`, `done`, `abandoned` ever reach the auto-restore guard with
  a real stash — `in-progress` is not a terminal transition.
- `taskUpdateForSlotClear` already lists `preempted` in the `expectedFrom`
  set for both `done` and `abandoned`, so the displaced task's status
  transition during `slotRestore` (which calls `slotAssign` and bumps it
  back to `in-progress`) is unaffected.
- `tasksAbandon` (in `src/tasks/index.ts`) calls `slotClear(slotNum,
  "abandoned")` for slotted tasks — used by dashboard `/api/task-abandon`
  and `/api/deferred-abandon`. These are exactly the tile actions that
  strand displaced work today.

### Why `merged` is dropped

`tasksMerge` only transitions tasks in `[ready, blocked,
needs-confirmation, deferred]` to `merged`; it never operates on slotted
tasks. `VALID_CLEAR_STATUSES` rejects `"merged"` at the CLI boundary. So
`slotClear(N, "merged")` is unreachable today — adding a `merged` branch
would be dead code. If a merge-via-slot path is ever introduced, the guard
should be revisited.

### Why `ready` must stay excluded

- `/api/slot-postpone` uses `slotClear(slotNum, CLEAR_STATUS_READY)`. The
  preempting task is coming back, so auto-restoring would race.
- `/api/stale-abandon` deliberately calls `slotClear(slotNum, "ready")`
  *after* flipping the task status to `abandoned` itself (see the long
  inline comment in `dashboard-server.ts`). Excluding `"ready"` from
  auto-restore preserves that intentional no-op contract.

The sibling task `task-ad39a394` will remove the slot-aware path from
`/api/stale-abandon` entirely, but until and after it lands, `"ready"`
must continue to skip auto-restore — so this proposal is correct
independently.

### `emitEvent` / `journalAppend` conventions

Existing precedents in `src/slots/index.ts`:

- `slot_preempt`: `emitEvent({ event_type: "slot_preempt", source: "cli",
  scope: "slot", slot, task, message })`.
- `slot_restore`: `emitEvent({ event_type: "slot_restore", source: "cli",
  scope: "slot", slot, task, message })`.
- `slot_clear`: `emitEvent({ event_type: "slot_clear", source: "cli",
  scope: "slot", slot, task, status })`.

The new emit should follow the same shape — `event_type:
"slot_auto_restore"` is the natural fit. Pair it with `journalAppend(
"slot", ...)` immediately above.

### Out of scope

- Changes to `/api/stale-abandon` — owned by sibling `task-ad39a394`.
- Changes to `slotRestore`'s signature — the trigger is surfaced at the
  callsite, not threaded into the helper.
- A recovery sweeper for already-orphaned stashes under `mag/preempted/`
  — separate follow-up; for now those need manual `ludics slot restore N`.
- Race hardening for concurrent `slotPreempt` between `stateMarkDirty()`
  and the guard — pre-existing pattern, not a regression introduced here.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The change is a roughly three-line edit at one site, plus tests:

```ts
// Auto-restore preempted work when priority task is gone for good
if (["done", "abandoned"].includes(finalStatus) && hasStash(slotNum)) {
  journalAppend(
    "slot",
    `Slot ${slotNum} auto-restoring preempted work (trigger: ${finalStatus})`,
  );
  emitEvent({
    event_type: "slot_auto_restore",
    source: "cli",
    scope: "slot",
    slot: slotNum,
    message: `trigger: ${finalStatus}`,
  });
  console.error(
    `ludics: auto-restoring preempted work to slot ${slotNum} (trigger: ${finalStatus})`,
  );
  await slotRestore(slotNum);
}
```

Tests live alongside the existing
`src/slots/slot-clear-integration.test.ts` — either as new test cases
inside that file or a sibling file `slot-auto-restore.test.ts` if the
setup diverges meaningfully. The fixture pattern (`writeConfig`,
`writeTask`, `writeSlotJson`, `mkdtempSync` per test) carries over
directly. Use `writeStash` from `./preempt.ts` (or actually drive a
`slotPreempt` flow) to seed the stash before the `slotClear` call, and
assert against `journal/events.jsonl` for the new event (or stub
`emitEvent` if the test harness already does so elsewhere).

## Scope

**In scope**

- Editing the auto-restore guard in `src/slots/index.ts`.
- Adding `journalAppend` + `emitEvent` at the call site, immediately
  before `await slotRestore(slotNum)`.
- Adding tests covering `abandoned`, `ready`, and (optionally) the `done`
  regression.

**Out of scope**

- `/api/stale-abandon` changes — owned by `task-ad39a394`.
- Modifying `slotRestore`'s signature.
- Sweeper / recovery for already-orphaned stashes.

**Dependencies**

- Soft sibling: `task-ad39a394` closes the last leak corner case
  (stale-while-slotted) but is not a hard dependency for this fix.
