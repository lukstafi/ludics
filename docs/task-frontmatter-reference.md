# Task frontmatter reference

Reference documentation for the YAML frontmatter on `task-*.md` files. Each section describes a single field: how to choose a value, what the orchestrator does with it, and worked examples drawn from real triage decisions.

This doc grows over time. Today it covers `effort`, `leaf` (container marker), and the full `## Status` lifecycle (see § Status below). Future additions are expected for the priority ladder (`S` / `A` / `B` / `C` / `D`) and interaction flags like `skip_plan`, `uses_browser`, and `requirements`.

For the authoritative list of fields and their TypeScript types, see [`TaskFrontmatter` in `src/tasks/types.ts`](../src/tasks/types.ts). For the orchestration mapping, see `selectOrchestrationFlags` in [`src/adapters/t3code.ts`](../src/adapters/t3code.ts).

## Effort levels

The `effort` field is a four-level scale used to pick the orchestration shape for a task. The default at task creation is `medium`. The four levels — `tiny`, `small`, `medium`, `large` — are accepted by the dashboard task-create form and consumed by the t3code adapter to choose mode, model, and pre-work phases.

Pick the lowest level that honestly fits. The criterion is the *shape* of the work, not its perceived importance — a high-priority bug whose fix is a one-line change is still `tiny`. Calibration tends to drift across sessions; when in doubt, prefer the lower level for clearly mechanical work and the higher level when you can already see a design decision lurking.

### `tiny`

A mechanical edit whose diff can be sketched without reading the codebase. Typically up to ~4 files of predictable changes, no new abstractions, no new decision points. The implementation is essentially 1:1 with the proposal — there is nothing left to decide once the change is described.

Worked examples:

- Delete-only or rename-only cleanups at known call sites.
- Single-file helper extraction from a small, enumerated set of call sites.
- Targeted lint fix or doc-only change with a clean audit.
- Proposals that explicitly set `skip_plan: true` because the implementation reads as a translation of the proposal.

Orchestration behavior: solo mode (single coder, no reviewer), no pre-work phases, Sonnet model for `claude-code` coders. `tiny` bypasses the configured `default_mode` unconditionally — it is the one effort level that overrides orchestration defaults rather than reading them. `skip_plan` has no effect at this level (the plan phase is already skipped).

### `small`

Focused scope but requires some thinking. The shape of the change is clear, but a few non-obvious choices come up during implementation — which call sites are in scope, whether to extend an existing helper or add a new one, how to phrase a new pattern entry. Typically across a handful of files in one subsystem.

Worked examples:

- Cross-cutting refactor across a handful of files in one area.
- Single-feature extension to an existing component.
- Fix-or-retire decisions on a short, enumerated list of failures.
- Writing a few pattern entries with rationale.

Orchestration behavior: pair mode (coder + reviewer) using the configured `default_mode`, no pre-work phases, Sonnet model for `claude-code` coders. `skip_plan` is ignored — the plan phase is already skipped at this level.

### `medium`

Multi-component change, or a change that needs an explicit design pass before implementation. This is the default at task creation and the level at which the planning phase kicks in. Most non-trivial feature work, new modules, and coordinated multi-template edits land here.

Worked examples:

- New module with tests.
- Multi-template coordinated edit (e.g. updating both coder and reviewer phase templates together).
- Adapter extension that touches the adapter, its registry entry, and a couple of call sites.
- Workflow change that ripples through more than one phase template.

Orchestration behavior: pair mode using the configured `default_mode`, `--plan` enabled, Opus model for `claude-code` coders. `medium` is the only level where `skip_plan: true` in the task's frontmatter takes effect — it is the manual override for exhaustive proposals where the design work is already in the proposal and the plan phase would just rehash it.

### `large`

Multi-week or architectural. Needs phased planning, often deserves a dedicated proposal with milestones, and typically benefits from gathering exploratory context before the plan phase begins.

Worked examples:

- Phased architectural work that lands in several PRs over a sprint or longer.
- Module split or rename that ripples through most of the codebase.
- New subsystem (federation layer, orchestration phase set, adapter for a new agent kind).

Orchestration behavior: pair mode using the configured `default_mode`, `--plan --gather` enabled, Opus model for `claude-code` coders. `skip_plan` is ignored at this level — `large` always runs both pre-work phases.

### `skip_plan` interaction summary

The `skip_plan: true` frontmatter flag is only consulted at `medium` effort:

- At `tiny` and `small`, the plan phase is already skipped, so the flag is a no-op.
- At `medium`, `skip_plan: true` suppresses `--plan`. This is the intended manual override for proposals whose implementation is exhaustive enough that planning would duplicate work.
- At `large`, the flag is ignored — the plan and gather phases always run.

### Notes on extension

The four levels above describe today's scale. Nothing in the model precludes a future `huge` or `epic` level if a class of work emerges that genuinely needs a different orchestration shape; the framing here is descriptive rather than normative. New levels would need corresponding entries in the dashboard validation allowlist, the `selectOrchestrationFlags` mapping, and this section.

## Status

The `status` field is a single string drawn from the central allowlist
`VALID_STATUSES` exported from `src/tasks/markdown.ts`. The runtime type
on `TaskFrontmatter.status` is free-form `string` for backwards
compatibility, but every code path that consumes status now flows
through the centralised constants (`VALID_STATUSES`, `TERMINAL_STATUSES`,
`READY_QUEUE_ELIGIBLE_STATUSES`, `BLOCKED_RECONCILE_SKIP_STATUSES`).

The CLI `ludics tasks status <task-id> <status>` setter validates input
against `VALID_STATUSES` and rejects unknown spellings.

The eleven recognised statuses below cover the lifecycle from intake to
terminal disposition. Each subsection documents the semantic of the
status, the actor that flips a task into it, and the path that exits.

### `ready`

Fresh / unblocked / awaiting slot assignment. Auto-queued by the
keepalive's `getSortedReadyCandidates()` ordering once the task is
elaborated and has a proposal.

Transitions: set by `tasks sync` for fresh GitHub-derived tasks, by the
elaborate worker on completion, by `/api/task-confirm` (revive from
`needs-confirmation`), by `/api/deferred-approve` (revive from
`deferred`), and by `/api/stale-revive` (revive from `stale`). Exits to
`in-progress` when assigned to a slot, or directly to `blocked` if
`dependencies.blocked_by` becomes non-empty.

### `in-progress`

Task is assigned to a slot and the orchestration runner is actively
working on it. The slot's `slot.json` records the assignment; the task's
`slot:` and `started:` frontmatter fields point at the active slot.

Transitions: set by `slotAssign()`. Exits to `done` (PR merged), `abandoned`
(user gives up), `merged` (work folded into another task), or
`needs-confirmation` (verify-completion produced ambiguity).

### `deferred`

A proposal has been generated but the user has not yet approved
auto-start. The dashboard's "Deferred Launch" panel surfaces these for
one-click approve / abandon.

Transitions: set by `/ludics-draft-proposal` when the worker confidence
is low or `start_sessions` autonomy is `manual` / `suggest`. Exits to
`ready` via `/api/deferred-approve` or terminal `abandoned` via
`/api/deferred-abandon`.

### `preempted`

The task was previously in-progress when a higher-priority task arrived
and preempted its slot. The original task's stash is recorded so it can
be resumed.

Transitions: set by the slot preempt path. Exits to `in-progress` when
resumed.

### `preempt-queued`

An earlier preempt attempt failed to clear the slot cleanly; the task is
queued for a second-chance preempt.

Transitions: set by the preempt retry logic. Exits to `preempted` once
the preempt completes, or back to `in-progress` if the preempt is
cancelled.

### `done`

Task is complete. The PR has merged (or the work was otherwise finished)
and the retrospective has been written.

Transitions: set by the orchestration runner when the PR-merged
verification passes. Terminal.

### `abandoned`

Explicitly closed without completion. Auto-closes the corresponding
GitHub issue (if any).

Transitions: set by `ludics tasks abandon`, by `/api/task-dismiss`
(needs-confirmation dismissal), by `/api/deferred-abandon`, or by
`/api/stale-abandon` (which composes a `stale → ready` flip then
`tasksAbandon`). Terminal.

### `merged`

Task content has been folded into another task via `merged_into`.
Duplicate-detection (`tasks duplicates` + `tasks merge`) is the typical
entry path.

Transitions: set by `ludics tasks merge`. Terminal. Reversible only via
`ludics tasks unmerge`.

### `needs-confirmation`

The verify-completion sweep produced ambiguity that the harness cannot
auto-resolve. The dashboard's "Needs Confirmation" panel surfaces these
for user disposition.

Transitions: set by `/ludics-verify-container-completion` and the
verify-failure path in the orchestration runner. Exits to `ready` via
`/api/task-confirm` or `abandoned` via `/api/task-dismiss`.

### `blocked`

`dependencies.blocked_by` is non-empty. The blocked-status reconciler
(`tasksReconcileBlockedStatus()`) maintains this in lockstep with the
`blocked_by` field.

Transitions: set automatically by the reconciler when a task gains a
blocker; flipped back to `ready` when the last blocker resolves. The
reconciler skips this transition for tasks already in
`BLOCKED_RECONCILE_SKIP_STATUSES` (terminal + active states).

### `stale`

Task work has been superseded; the originally-proposed design has
already shipped or the premise has been invalidated. Resolve by
abandoning (auto-closes GH issue) or reviving via the dashboard
(transitions back to `ready`).

`stale` is in `TERMINAL_STATUSES` — the keepalive's auto-proposal
queue, the unstick path, the duplicate filter, the abandon-path guard,
the milestone warnings, the needs-elaboration sweep, the deadline
warnings, and the t3code thread cleanup all treat stale tasks as
terminal-for-active-work. The `containerCompletionSweep` also treats
`stale` parents as terminal so children completing after the parent
goes stale don't trigger a verify-container-completion request.

Transitions: auto-set by `/ludics-draft-proposal` when the worker
returns `status: stale` (the routing flips frontmatter via
`transitionStatus(taskFile, "ready", "stale")` and appends rationale to
`## Notes`). Auto-blocked-by-precondition: a subsequent
`/ludics-draft-proposal` invocation for an already-stale task returns
`status: blocked-stale` without delegating to the worker. Exits via the
dashboard's "Stale" panel — Revive (`/api/stale-revive`, flip to
`ready`) or Abandon (`/api/stale-abandon`, terminal disposition).

## `leaf` (container marker)

Type: `boolean | undefined`. Default: `undefined` (treated as a leaf task).

Set to `false` by `/ludics-split-task` when a task is decomposed into children via `subtask_of`. Indicates the task is a **container** — its work has been split and the parent itself has no actionable deliverable.

**Effect on automation**:

- `getSortedReadyCandidates` in `src/mag.ts` skips `leaf: false` entries, which automatically suppresses container tasks from `maybeFillEmptySlots`, `maybeQueueProposals`, and dashboard-generation consumers.
- `tasksNeedsElaborationList` and `tasksQueuePreemptions` in `src/tasks/sync.ts` apply symmetric filters, so containers are never auto-queued for elaboration or preemption.
- `slotAssign` in `src/slots/index.ts` throws before any slot mutation when the resolved task has `leaf: false` — assign a child instead.
- `/ludics-elaborate` and `/ludics-draft-proposal` short-circuit on `leaf: false`: append a single deduped Notes line `Skipped: container task — work split into children` and exit without worker delegation.
- Flow views and dashboard surfaces are intentionally **not** filtered, so containers remain visible for orphan-detection.

**Container completion trigger**: the sweep in `tasksReconcileBlockedStatus` watches every `leaf: false` parent. When all children (via `subtask_of`) reach `done`/`abandoned`, it enqueues `/ludics-verify-container-completion <parent-id>`. Debounce details:

- A 6-hour freshness sentinel under `mag/container-completion-checked/<parent-id>.epoch` suppresses re-fire while the child set is unchanged.
- A `.children` sidecar records the sorted child-id+status fingerprint at last enqueue. The sweep clears the sentinel whenever the current fingerprint differs — covering both child reopen and newly-added child cases (including newly-added but already-terminal children).
- `queueHasPendingActionForTask("verify-container-completion", parentId)` is the secondary dedupe while a request is unprocessed.

The verify skill summarizes children, files `needs-confirmation` follow-ups for residual ambiguity (the dashboard's existing surface picks them up via `/api/tasks/<id>/confirm` and `/dismiss`), and notifies the user via `ludics notify outgoing`. **The parent's status transition stays user-driven** — the harness never auto-closes a container.
