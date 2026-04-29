# Container tasks: exclude from queues + auto-completion-check when all subtasks resolve

## Goal

Container tasks (`leaf: false` parents whose work has been split into
subtasks) are not actionable on their own — they complete only when all
children land or close. Today's harness has no awareness of `leaf: false`,
which causes two recurring problems:

1. **Auto-queue pollution.** Container tasks get pulled into the ready
   queue, ranked alongside leaf tasks, and queued for proposal/elaboration
   drafting. The user sees stale "draft proposal" launch buttons for
   tasks whose work has already been split. Today's concrete trigger:
   `gh-ocannl-293` was queued for proposal drafting via the
   auto-keepalive even though it was split on 2026-04-24/25; Mag had to
   mark it `status: blocked` manually.
2. **No completion signal.** When the last child of a container resolves
   (done/abandoned), nothing prompts the user to revisit the container.
   The parent can sit indefinitely.

This task adds first-class container awareness: a typed `leaf` field, a
single-chokepoint queue/preempt/slot-assign filter, and an
"all-children-resolved" sweep that fires a new
`/ludics-verify-container-completion` skill so the user gets a
ready-to-act decision on the parent.

## Acceptance Criteria

1. **Schema.** `TaskFrontmatter` in `src/tasks/types.ts` declares
   `leaf?: boolean`. `parseTaskFrontmatter` in `src/tasks/markdown.ts`
   reads it via `asBoolean`, and the line-fallback parser preserves it
   through the malformed-YAML path. Round-trip writers leave it intact.
2. **Queue exclusion (single chokepoint).** `getSortedReadyCandidates`
   in `src/mag.ts` skips entries with `fm.leaf === false`. This
   automatically suppresses container tasks from `maybeFillEmptySlots`,
   `maybeQueueProposals`, and the dashboard-generation consumer.
3. **Elaboration exclusion.** `tasksNeedsElaborationList` in
   `src/tasks/sync.ts` skips container tasks for symmetry with the
   ready/proposal path.
4. **Preempt exclusion.** `tasksQueuePreemptions` in `src/tasks/sync.ts`
   skips container tasks. (Flow views and dashboard surfaces are
   intentionally not filtered, to preserve user visibility for
   spotting orphaned containers.)
5. **Slot-assignment guard.** `slotAssign` in `src/slots/index.ts`
   throws an error when the resolved task file has `fm.leaf === false`,
   before mutating any slot state. The error message names the parent
   and suggests using a child instead. Free-form-description assignments
   (no task file resolves) bypass the guard, as today.
6. **All-children-resolved sweep.** A new sweep runs alongside
   `healBlockedByLinks` in `src/tasks/sync.ts` (i.e., from
   `tasksReconcileBlockedStatus`):
   - For every task with `fm.leaf === false` whose own status is **not**
     terminal/active (`done`, `abandoned`, `merged`,
     `needs-confirmation`, `in-progress`, `deferred`,
     `preempt-queued`, `preempted`),
   - find children via `subtask_of` from a single `taskMap` walk,
   - require at least one child (skip vacuous cases),
   - and if every child has terminal status (`done` or `abandoned`),
     enqueue a one-shot `verify-container-completion` request keyed by
     the parent ID.
7. **Idempotency / debounce.** A `mag/container-completion-checked/<parent-id>.epoch`
   sentinel mirrors the existing `auto-proposal-debounce/` pattern.
   Re-firing is suppressed while the sentinel is fresh. The sentinel is
   cleared (or its file is removed) when any tracked child transitions
   back out of terminal status, or when a new child appears whose
   `subtask_of` points at the parent. `queueHasPendingActionForTask`
   provides the secondary dedupe guard against double-enqueueing while
   the request is pending.
8. **New queue action.** `src/queue.ts` declares
   `verify-container-completion` in the discriminated union alongside
   the existing `verify-completion` action. `src/skill-queue-registry.ts`
   continues to be data-driven from skill frontmatter — no code change
   needed there beyond the new skill file.
9. **New skill.** `skills/ludics-verify-container-completion.md` exists
   with `queue-action: verify-container-completion` and
   `queue-required-args: [task]`. Behavior:
   - Read the parent task and every child found via `subtask_of`.
   - Summarize each child's outcome (status, completion summary if
     present in Notes).
   - Identify residual ambiguity — semantics of the parent that no child
     covered. For each ambiguity, file a concise follow-up subtask with
     `status: needs-confirmation` (see Decision below) and a pointer to
     the ambiguous semantic.
   - Send a `notifyOutgoing` summary so the user can decide:
     mark the container `done`, mark it `abandoned` with rationale, or
     adopt the residual follow-up tasks.
   - Exit without modifying parent status — status transition stays
     user-driven.
10. **Manual-invocation no-op-with-note.** `/ludics-elaborate` and
    `/ludics-draft-proposal` orchestrator skills detect `leaf: false`
    on the resolved task, append a single-line Notes entry
    ("Skipped: container task — work split into children"), and exit
    without invoking the worker. The queue-pop layer drops these
    requests rather than re-queueing.
11. **Tests.** New unit tests cover, at minimum:
    - `parseTaskFrontmatter` round-trips `leaf: false`.
    - `getSortedReadyCandidates` excludes a container fixture.
    - `tasksQueuePreemptions` excludes a container fixture.
    - `slotAssign` throws on a container task ID and leaves slot state
      unchanged.
    - The all-children-resolved sweep enqueues
      `verify-container-completion` exactly once per parent (debounce
      sentinel honored), skips vacuous parents (no children), skips
      parents already in terminal status, and re-fires after sentinel
      reset when a child reopens.
12. **Documentation note.** A short stanza in
    `docs/task-frontmatter-reference.md` describes the `leaf` field
    semantics and the auto-completion-check trigger.

## Context

### Verified codebase surfaces (HEAD as of proposal time)

- `src/tasks/types.ts` `TaskFrontmatter` — no `leaf` field declared
  today. The pattern to mirror is `skip_plan?: boolean`.
- `src/tasks/markdown.ts` — `parseTaskFrontmatter` populates `skip_plan`
  via `asBoolean(d.skip_plan)`; the line-fallback path
  (`parseTaskFrontmatterLineFallback`) does the same. `leaf` should
  follow this pattern verbatim.
- `src/mag.ts` `getSortedReadyCandidates` — single chokepoint feeding
  `maybeFillEmptySlots`, `maybeQueueProposals`, the preempt path, and
  dashboard generation. The candidate-collection loop reads `fm` per
  task file but never inspects `fm.leaf`. The correct insertion point
  is the early-continue block alongside the existing
  `tasksInSlots.has(id)`, status, `blocked_by`, and postponed-project
  guards.
- `src/tasks/sync.ts` `healBlockedByLinks` — already builds a
  task-map of `(id → {status, filePath, fm})` with
  `parseTaskFrontmatter`. The new sweep can run immediately after this,
  inside `tasksReconcileBlockedStatus`, sharing the iteration cost.
- `src/tasks/sync.ts` `tasksReconcileBlockedStatus` — the canonical
  per-sync entry point already invoked from the sync pipeline.
- `src/tasks/sync.ts` `tasksNeedsElaborationList` and
  `tasksQueuePreemptions` — both iterate `*.md` files and parse
  frontmatter; both need a `leaf === false` skip alongside their
  existing status filters.
- `src/slots/index.ts` `slotAssign` — after the
  `existsSync(tf)` / `parseTaskFrontmatter(content)` block (where the
  function reads the task title to populate `processDesc`), throw if
  `fm.leaf === false`. This precedes any `SlotData` mutation or call to
  `taskUpdateForSlotAssign`.
- `src/queue.ts` — the discriminated-union for queue requests sits
  next to the `verify-completion` action; extend the union literal to
  include `verify-container-completion`. Both `queueRequest` and
  `queueHasPendingActionForTask` use the action string as plain data,
  no other call sites need changes.
- `src/skill-queue-registry.ts` — registry is **data-driven from skill
  frontmatter**. Adding a skill file with `queue-action:
  verify-container-completion` is sufficient registration.
- `src/notify.ts` `notifyOutgoing` — exported helper used to post the
  completion-check summary to the outgoing notification log.
- `skills/ludics-verify-completion.md` — closest existing template for
  the new skill. The container variant is materially lighter:
  description-style read of parent + children + ambiguity scan, no
  deep code inspection.
- Dashboard already surfaces both `status: needs-confirmation`
  (`needsConfirmationConfig` in `src/dashboard.ts`, with
  confirm/dismiss API endpoints in `src/dashboard-server.ts`) and
  `status: deferred` (`deferredLaunchConfig`) as separate panels.
- `mag/auto-proposal-debounce/` directory pattern — file-per-task
  sentinel with `sentinelFresh` / `touchSentinel` helpers in `src/mag.ts`.

### Behavioral observations

- The user-facing semantic question "did the children fully cover the
  parent's intent?" is genuinely user-driven. Avoid auto-marking the
  parent `done`. Instead, surface the decision and let any residual
  ambiguity become its own follow-up task.
- The split-task skill (`skills/ludics-split-task.md`) already
  instructs agents to set `leaf: false` on the parent. Today nothing
  reads it — this proposal turns that field into the load-bearing
  signal it was always meant to be.
- The audit "which existing tasks should be `leaf: false`" is out of
  scope. Only `gh-ocannl-293` is currently flagged; others with
  `subtask_of` siblings happen to have `subtask_of: null` parents, so
  blast radius is small. After the fix lands, `gh-ocannl-293`'s manual
  `status: blocked` override can revert to `ready` (the new filter does
  the actual exclusion).

### Decision: residual-ambiguity follow-ups use `status: needs-confirmation`

The verify skill files residual-ambiguity follow-ups at
**`status: needs-confirmation`**, not `status: deferred`. Rationale:

- `needs-confirmation` semantics are precisely "user must take an
  action / decision on this task" — exactly what an unresolved
  ambiguity represents.
- The dashboard already surfaces `needs-confirmation` with confirm and
  dismiss API endpoints (`/api/tasks/<id>/confirm` and `/dismiss` in
  `dashboard-server.ts`). The user gets one-click resolution.
- `deferred` semantics are "task awaits launch approval" — tied to
  the auto-start path. Surfacing ambiguity follow-ups there would
  conflate two distinct user intents.
- No UI work needed; existing surface fits.

This pins the answer to elaboration question Q3's UI refinement.

### Bounded re-fire of the verify skill

When a `needs-confirmation` follow-up itself transitions to
`done` / `abandoned`, the all-children-resolved sweep treats the
follow-up as a (newly terminal) child of the parent and re-fires the
verify skill on the parent — provided the debounce sentinel was
cleared at the previous resolution. Each iteration either resolves an
ambiguity (closer to done) or files another follow-up (still bounded
since each resolution narrows the residual space).

## Approach (suggested — agents may deviate)

*Suggested approach — agents may deviate if they find a better path.*

1. **Schema field first.** Add `leaf?: boolean` to `TaskFrontmatter`,
   wire `parseTaskFrontmatter` and the line-fallback parser, add a
   round-trip test. This is the foundation for everything else.
2. **Filter at the chokepoint.** Add the `if (fm.leaf === false) continue;`
   guard in `getSortedReadyCandidates` (between the `tasksInSlots`
   check and the `status !== "ready"` check is fine — the order doesn't
   matter for correctness but keeps the leaf-check conceptually grouped
   with the "is this task assignable" guards).
3. **Symmetric filters.** Add `leaf === false` skips to
   `tasksNeedsElaborationList` and `tasksQueuePreemptions`.
4. **Slot-assign guard.** Add the throw in `slotAssign`. Test that the
   slot file is not modified when the throw fires.
5. **Queue action union.** Extend the discriminated union in
   `src/queue.ts` to include `verify-container-completion`.
6. **Sweep + debounce.** Implement `containerCompletionSweep(taskMap)`
   as a new function in `src/tasks/sync.ts`, called from
   `tasksReconcileBlockedStatus` after `healBlockedByLinks` runs.
   Reuse `taskMap` from the heal pass (refactor `healBlockedByLinks` to
   return the map, or build it once at the top of
   `tasksReconcileBlockedStatus` and pass to both). Add the
   `mag/container-completion-checked/` sentinel directory mirroring
   `mag/auto-proposal-debounce/`. Hooks for sentinel reset:
   - When a child task transitions out of terminal status (covered by
     `transitionStatus` in `markdown.ts` or its callers — emit a hook
     that clears the parent's sentinel).
   - When a new task with `subtask_of: <parent-id>` appears (covered by
     a check in `healBlockedByLinks` or the sweep itself: if the set of
     children differs from what the sentinel was computed against,
     reset).

   **Simplification option:** if tracking child-set deltas adds too
   much complexity, an alternative is to clear the sentinel only on
   sentinel-age-expiry (e.g., 6h) and rely on the
   `queueHasPendingActionForTask` dedupe to prevent double-fires within
   the freshness window. Worker's choice.
7. **Skill file.** Create `skills/ludics-verify-container-completion.md`
   modeled on `ludics-verify-completion.md`'s frontmatter (queue-action,
   queue-args, queue-required-args). Body describes the lightweight
   parent-and-children read, ambiguity scan, follow-up filing, and
   `notifyOutgoing` summary.
8. **Manual-invocation guards in orchestrator skills.** Edit
   `skills/ludics-elaborate.md` and `skills/ludics-draft-proposal.md`
   to detect `leaf: false` early and short-circuit with a Notes line.
9. **Tests** — covered in acceptance criterion 11.
10. **Doc stanza** — covered in acceptance criterion 12.

## Scope

**In scope:**
- All twelve acceptance criteria above.
- Concrete reversion of `gh-ocannl-293`'s manual `status: blocked`
  workaround back to `ready` (or whatever the natural status is) in
  the same PR, since this fix supersedes it.

**Out of scope:**
- Auto-marking the container `done` — explicit non-goal; user always
  decides.
- Auditing which existing tasks should be `leaf: false`.
- Generalized parent/child dependency UI in the dashboard (separate
  concern).
- Filtering containers from flow views — they remain visible, by
  design, for orphan-detection.
- Extending the sweep to honor `merged_from` containment — only
  `subtask_of` is treated as authoritative.

**Dependencies:** None. Independent fix; can land standalone.

**Related:** `gh-ocannl-293` (the trigger), `ludics-split-task` skill
(producer of `leaf: false` containers).
