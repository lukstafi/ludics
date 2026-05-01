# Reject slotted-task abandon at /api/stale-abandon and /api/deferred-abandon

## Goal

Two dashboard abandon endpoints currently accept slotted tasks and silently
clear the slot. Abandoning a task that holds a slot is a corner case the user
considers a UX bug: the right behaviour is a 409 that forces the user to go
through slot operations (whose terminal transitions then handle displaced-task
recovery via task-4028c493's auto-restore).

This task adds a UI-boundary 409 defense at `/api/stale-abandon` and
`/api/deferred-abandon`. `tasksAbandon`'s own slot-aware path is preserved
intact for non-API callers (CLI `ludics tasks abandon <id>`), which rely on
task-4028c493 for displaced-task recovery — so the architecture becomes
layered: UI 409s; programmatic paths complete-and-recover.

## Acceptance Criteria

### `/api/stale-abandon`

- Add a 409 check at the top of the handler: if
  `findSlotForTask(taskParam) !== null`, return 409 with body
  `{"error":"task is in slot N; use slot operations to change state"}`
  BEFORE the `transitionStatus` call (no partial state — no `completed`
  timestamp, no `deferred_launch`/`approved` removal, no status flip).
- Delete the entire `if (slotNum !== null) { await slotClear(slotNum, "ready") }`
  block that currently runs after the frontmatter cleanup.
- Simplify the pre-handler block-comment: keep the paragraph explaining
  *why* we bypass `tasksAbandon` (point (a): `tasksAbandon`'s
  terminal-status guard rejects `status: stale`); drop the paragraph
  documenting the `"ready"` `expectedFrom` workaround for
  `taskUpdateForSlotClear` (it no longer applies once the slotClear is
  gone).
- Collapse the `task_abandon` event `message` field to the constant
  `"abandoned (stale → abandoned)"` — no slotted branch in the success
  path because the 409 has filtered slotted tasks out.

### `/api/deferred-abandon`

- Add a 409 check at the top of the handler: if
  `findSlotForTask(taskParam) !== null`, return 409 with the same body
  shape `{"error":"task is in slot N; use slot operations to change state"}`
  BEFORE delegating to `tasksAbandon`.
- No other handler changes — `tasksAbandon`'s slot-aware path stays
  intact for non-API callers.

### Tests (`src/dashboard.test.ts`)

Inside `describe("dashboard HTTP /api/stale-revive and /api/stale-abandon (AC 10)")`:

- **Invert** existing test
  `"POST /api/stale-abandon on a slotted stale task ends with status: abandoned (not silently left at ready)"`:
  the new assertion is that the response is 409, the response body's
  `error` includes the slot number, the task remains `stale` (no
  `completed` timestamp written), and the slot's `task` field is
  unchanged.
- **Regression**: existing
  `"POST /api/stale-abandon de-stales then abandons, ending in status: abandoned"`
  (non-slotted) continues to pass.

Add a parallel pair for `/api/deferred-abandon`:

- **New (slotted-deferred)**: deferred task with slot → endpoint returns
  409, task remains `deferred`, slot's `task` field unchanged.
- **New (regression, non-slotted-deferred)**: deferred task without slot
  → endpoint returns 200, task transitions to `abandoned`.

Reuse the existing `writeTask`, `writeSlotJson`, `emptySlotData`, and
`makeHandler` helpers.

### Out of scope

- `/api/task-dismiss` — its existing status guard restricts input to
  `needs-confirmation`, which is never slotted by construction
  (needs-confirmation tasks are auto-filed retrospective follow-ups). No
  defense needed.
- `tasksAbandon`'s own slot-aware path — preserved for the CLI
  `ludics tasks abandon <id>` caller. Displaced-task recovery on that
  path is task-4028c493's responsibility.

## Context

### Current code

`src/dashboard-server.ts`:

- `/api/task-dismiss` handler — already guarded against non-needs-confirmation
  statuses; out of scope.
- `/api/deferred-abandon` handler — short, delegates to `tasksAbandon`
  with `{ source: "dashboard", scope: "task" }`. Add 409 pre-check.
- `/api/stale-abandon` handler — preceded by a multi-paragraph block
  comment documenting the bypass. Calls `transitionStatus(stale →
  abandoned)`, frontmatter cleanup (`completed`, remove `deferred_launch`,
  remove `approved`), the slot-aware `findSlotForTask` + `slotClear(slotNum, "ready")`
  block, then `emitEvent({ event_type: "task_abandon", ... })` with a
  ternary on `slotNum` for the message.

`src/slots/index.ts`:

- `findSlotForTask(taskId)` — already imported at the top of
  `dashboard-server.ts`. Returns the slot number for the first slot
  whose `data.task` matches the task id, regardless of slot status. Any
  non-null result triggers the 409 (matches the user's "stale tasks
  shouldn't be slotted at all" reading; the same applies to slotted
  deferred tasks).

`src/dashboard.test.ts`:

- `describe("dashboard HTTP /api/stale-revive and /api/stale-abandon (AC 10)")`
  hosts the existing slotted-stale test. Test scaffold (`writeTask`,
  `writeSlotJson`, `emptySlotData`, `makeHandler`) is in scope.

### Why these endpoints share a pattern

Both `/api/stale-abandon` and `/api/deferred-abandon` cover dashboard
buttons that abandon a task without going through a slot-clear button.
In both cases the slot would currently be silently clobbered. The 409
check at the top of each handler (before any state mutation) is the
identical defense.

### Race notes

A task could in principle be slotted between `findSlotForTask` and the
ensuing `transitionStatus` / `tasksAbandon`. In practice no production
path slots a stale or deferred task post-check: the staleness sweeper
never targets `in-progress` (slot's typical status) and slot-assignment
paths reject non-`ready`/`deferred` statuses for stale tasks. The check
is best-effort but covers every realistic flow. The existing concurrent-
abandon race (two `/api/stale-abandon` calls in flight) is already
handled by the `transitionStatus` `if (!ok)` 409 downstream.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

For both handlers, hoist the slot pre-check above all other work:

```ts
const slotNum = findSlotForTask(taskParam);
if (slotNum !== null) {
  return new Response(
    JSON.stringify({ error: `task is in slot ${slotNum}; use slot operations to change state` }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );
}
```

For `/api/stale-abandon`, place this check after `resolveTaskFile` (so
404 still beats 409 when the task id doesn't resolve to a real file)
but before `transitionStatus`. Then delete the post-mutation
`if (slotNum !== null) await slotClear(slotNum, "ready")` block, drop
the now-redundant `slotNum` reference in the event message, and trim
the block-comment as specified in the AC.

For `/api/deferred-abandon`, place the check after `resolveTaskFile`
and before `tasksAbandon`. Nothing else changes.

For tests, the existing slotted-stale test's mutation block (lines
roughly 1024+ of `dashboard.test.ts`) becomes the new positive
assertion; the parallel deferred-slotted test follows the same shape
with a `deferred` initial status and the `/api/deferred-abandon` URL.

## Scope

In scope:
- `src/dashboard-server.ts` — `/api/stale-abandon` and `/api/deferred-abandon`
  handlers; pre-handler block-comment for `/api/stale-abandon`.
- `src/dashboard.test.ts` — invert one existing test, add two new tests
  inside the existing `describe` block (or a sibling block, at the
  agent's discretion).

Out of scope:
- `/api/task-dismiss` (status guard already excludes slotted tasks).
- `tasksAbandon`'s own slot-aware path (preserved for CLI callers).
- Displaced-task recovery — that's task-4028c493 (in-progress on slot 2,
  non-blocking and reinforcing).

Dependencies: none blocking. Reinforces task-4028c493 (the two land
independently; together they give layered defense at UI and CLI
boundaries).
