# Replace deferred_launch/approved fields with status: deferred

## Goal

Remove the `deferred_launch: true` and `approved: true` frontmatter fields from
task files and replace them with a first-class task status value `deferred`. A
task in `status: deferred` has a written proposal but is awaiting explicit user
approval before auto-start. Approving transitions it to `status: ready` (or
directly to `in-progress` if a slot is available), abandoning transitions it to
`status: abandoned`. This eliminates the fragile dual-field pattern where a task
can simultaneously carry `status: in-progress` and `deferred_launch: true`.

## Acceptance Criteria

1. A new status value `deferred` is recognised throughout the codebase: it is
   documented in `src/tasks/types.ts`, handled in all status enumeration sites,
   and never treated as ready, in-progress, terminal, or blocked.

2. `auto-start-evaluate` CLI case (`src/mag.ts` ~line 3303): when the decision
   is `defer-to-user`, set `status: deferred` (via `updateFrontmatterField`)
   instead of `addFrontmatterField(…, "deferred_launch", "true")`. When the
   decision is not `defer-to-user`, set `status: ready` (if currently
   `deferred`) instead of `removeFrontmatterField(…, "deferred_launch")`.

3. `readTaskDeferralFlags()` in `src/mag.ts` is replaced by a simpler
   `isTaskDeferred(taskId)` that checks `status === "deferred"` in the task
   frontmatter. Legacy `deferred_launch: true` is treated identically (backward
   compat shim) and is migrated automatically to `status: deferred` when
   encountered (opportunistic in-place migration).

4. `maybeFillEmptySlots()` candidate loop (`src/mag.ts` ~line 2247): replace
   `!!fm.deferred_launch && !fm.approved` with `status === "deferred"` (already
   using status check at line 2245 `status !== "ready"`; after migration this
   becomes the only gate needed, since deferred tasks will have `status:
   deferred` not `status: ready`).

5. `maybeAutoStartSlots()` keepalive (`src/mag.ts` ~line 1956): replace
   `readTaskDeferralFlags()` call + skip logic with `isTaskDeferred()` check.
   Remove the `removeFrontmatterField(taskFile, "deferred_launch")` call after
   start (no longer needed).

6. Notification "Approve task" handler (`src/mag.ts` ~line 1160): replace
   `removeFrontmatterField(tf, "deferred_launch"); addFrontmatterField(tf,
   "approved", "true")` with `updateFrontmatterField(tf, "status", "ready")`.

7. `revise-proposal` CLI case (`src/mag.ts` ~line 3334): replace
   `removeFrontmatterField(reviseTaskFile, "approved")` with
   `updateFrontmatterField(reviseTaskFile, "status", "deferred")` (so that a
   revised proposal is back in deferred state pending re-evaluation).

8. Abandon handlers (`abandonTaskFromNotification()`, `src/mag.ts` ~lines
   679, 707): remove the two `removeFrontmatterField(taskFile, "deferred_launch")`
   and `removeFrontmatterField(taskFile, "approved")` calls; the `status:
   abandoned` update already covers the state change.

9. Done handlers (`completeTaskFromNotification()`, `src/mag.ts` ~lines 740,
   768): remove `removeFrontmatterField(doneTaskFile, "deferred_launch")`; done
   status is terminal and these fields are irrelevant post-migration.

10. Launch handler (`launchSessionFromNotification()`, `src/mag.ts` ~line 1005):
    remove `removeFrontmatterField(launchTaskFile, "deferred_launch")`.

11. `src/dashboard.ts`:
    - Remove `deferredLaunch: boolean` from the `DashboardTask` interface.
    - Remove `deferredLaunch: !!data.deferred_launch` from `readDashboardTasks()`.
    - Update `deferredLaunchConfig.filter` from `task.deferredLaunch && !task.isCompleted && task.status !== "abandoned"` to `task.status === "deferred"`.

12. `src/dashboard-server.ts`:
    - `/api/deferred-approve` (~line 403): replace `removeFrontmatterField(taskFile, "deferred_launch"); addFrontmatterField(taskFile, "approved", "true")` with `updateFrontmatterField(taskFile, "status", "ready")`.
    - `/api/deferred-abandon` (~line 439): remove the two `removeFrontmatterField` calls for `deferred_launch` and `approved` (the `status: abandoned` update is already present for the no-slot path; the `ludics slot clear abandoned` path handles the rest).

13. Status enumeration sites — full reviewer audit required (see Context):
    - `src/tasks/sync.ts` line 740 skip list: add `"deferred"` alongside
      `"in-progress"` so the blocked/ready reconciler never overwrites a
      deferred task's status.
    - `src/slots/index.ts` line 274 (slot overwrite): add `|| oldStatus ===
      "deferred"` so that overwriting a deferred-but-slotted task resets it to
      `ready` (not left as `deferred` with no slot).
    - `src/slots/index.ts` line 420 (setup failure): add `|| status ===
      "deferred"` so a setup-failed deferred task resets to `ready`.
    - `src/mag.ts` line 2103 (hung slot scan): add `"deferred"` to accepted
      statuses alongside `"in-progress"`.
    - `src/mag.ts` line 3166 (`draft-proposal` queue scan): consider whether
      `deferred` tasks should also be scanned for proposal signals.
    - `src/flow.ts` line 160: `deferred` tasks must NOT appear in the ready
      queue (the existing `status === "ready"` filter already excludes them, but
      confirm no other path adds them).
    - `src/tasks/index.ts` line 351 skip list for `tasks sync-yaml`: confirm
      `deferred` is NOT skipped (it should remain editable).

14. A one-time migration command `ludics tasks migrate-deferred` (or equivalent
    keepalive pass) converts all existing task files carrying `deferred_launch:
    true` to `status: deferred` and removes both legacy fields. After migration,
    no task file should contain `deferred_launch` or `approved` in frontmatter.

15. A backward-compatibility shim remains in the `isTaskDeferred()` read path for
    one release cycle: if `deferred_launch: true` is found and `status` is not
    already `deferred`, treat the task as deferred and opportunistically rewrite
    the file in-place.

16. All references to `deferred_launch` and `approved` in skill files, templates,
    and documentation are updated to reflect the new `status: deferred` model.

## Context

### Primary logic — `src/mag.ts`

- **`readTaskDeferralFlags(taskId)`** (line 661): reads both fields via regex.
  Becomes `isTaskDeferred(taskId)` checking `status === "deferred"`.
- **`abandonTaskFromNotification()`** (lines 679, 707): removes both legacy
  fields; safe to drop after migration.
- **`completeTaskFromNotification()`** (lines 740, 768): removes
  `deferred_launch`; safe to drop.
- **`launchSessionFromNotification()`** (line 1005): removes `deferred_launch`
  after launch; safe to drop.
- **`processQueueRequest()` "Approve task …"** (lines 1160–1161): removes
  `deferred_launch`, adds `approved: true`. Replace with status transition.
- **`maybeFillEmptySlots()` candidate loop** (line 2247): `!!fm.deferred_launch
  && !fm.approved` guard. After migration this is subsumed by `status !==
  "ready"` at line 2245.
- **`maybeAutoStartSlots()` keepalive** (line 1956): calls
  `readTaskDeferralFlags()`, skips deferred+not-approved, removes field after
  start.
- **`auto-start-evaluate` CLI case** (lines 3303–3314): writes
  `deferred_launch: true` or clears it. Core write site to replace.
- **`revise-proposal` CLI case** (line 3334): removes `approved`. Replace with
  status reset.

### Dashboard — `src/dashboard.ts`

- `DashboardTask.deferredLaunch: boolean` (line 378).
- `deferredLaunch: !!data.deferred_launch` in `readDashboardTasks()` (line 466).
- `deferredLaunchConfig.filter` (line 550): `task.deferredLaunch && …`.

### Dashboard server — `src/dashboard-server.ts`

- `/api/deferred-approve` (lines 403–404): dual-field manipulation.
- `/api/deferred-abandon` (lines 439–440): removes both fields.

### Status enumeration sites (reviewer audit)

- `src/tasks/types.ts:7` — status comment (documentation only).
- `src/tasks/sync.ts:740` — blocked/ready reconciliation skip list.
- `src/tasks/affinity.ts:51` — `isCompletedTask` check (no change needed).
- `src/slots/index.ts:274` — reset `in-progress` → `ready` on slot overwrite.
- `src/slots/index.ts:420` — reset `in-progress` → `ready` on setup failure.
- `src/mag.ts:2103` — hung slot scan status filter.
- `src/mag.ts:3166` — `draft-proposal` queue scan status filter.
- `src/flow.ts:160` — ready queue filter (deferred must be excluded).
- `src/tasks/index.ts:351` — `sync-yaml` skip list (deferred must NOT be skipped).

### Backward compatibility

~34 live task files in the harness carry `deferred_launch: true`. A migration
pass (one-time CLI command or keepalive-driven opportunistic rewrite) handles
these before the old read paths are removed.

## Approach

*Suggested approach — agents may deviate if a better path is found.*

### Phase 1 — Add new status, keep legacy read path

1. Add `"deferred"` to `src/tasks/types.ts` status comment.
2. Implement `isTaskDeferred(taskId)`: checks `status === "deferred"` first,
   falls back to `deferred_launch: true` (legacy shim), and opportunistically
   rewrites the file to `status: deferred` on legacy hit.
3. Update `auto-start-evaluate` case to write `status: deferred` (not
   `deferred_launch: true`), and to set `status: ready` when clearing deferral.
4. Update `maybeFillEmptySlots()` and `maybeAutoStartSlots()` to call
   `isTaskDeferred()`.
5. Update `processQueueRequest()` approval branch to `status: ready`.
6. Update `revise-proposal` case to `status: deferred`.
7. Update all abandon/done/launch handlers to drop legacy field removals.

### Phase 2 — Migrate existing task files

8. Implement `ludics tasks migrate-deferred` CLI subcommand: scan all task
   files, rewrite `deferred_launch: true` → `status: deferred` + remove both
   legacy fields.
9. Run migration against the live harness.

### Phase 3 — Remove legacy shim + dashboard cleanup

10. Remove the `deferred_launch`/`approved` fallback from `isTaskDeferred()`.
11. Update `src/dashboard.ts`: remove `deferredLaunch` field, update filter.
12. Update `src/dashboard-server.ts`: replace endpoint logic.
13. Audit all status enumeration sites (see Context) and apply fixes.

### Phase 4 — Documentation and templates

14. Update skill files, templates, and documentation referencing
    `deferred_launch` / `approved` to describe `status: deferred`.
