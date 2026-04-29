---
name: ludics-verify-container-completion
description: Surface a decision on a container task whose subtasks have all resolved
queue-action: verify-container-completion
queue-args: [task]
queue-required-args: [task]
---

# /ludics-verify-container-completion - Container Completion Review (Orchestrator)

A lightweight orchestrator that reads a `leaf: false` parent and its children,
summarizes outcomes, files `needs-confirmation` follow-ups for residual
ambiguity, and notifies the user. **Does not transition the parent's status —
that decision stays with the user.**

## Trigger

This skill is invoked when:
- The container-completion sweep in `tasksReconcileBlockedStatus` detects that
  every child of a `leaf: false` parent (via `subtask_of`) has reached a
  terminal status (`done` or `abandoned`), and queues
  `ludics mag verify-container-completion <parent-id>`.
- The user runs `ludics mag verify-container-completion <parent-id>` manually.

The sweep uses a fingerprint-aware sentinel under
`mag/container-completion-checked/<parent-id>.{epoch,children}` to debounce
repeated firings while the child set is unchanged, and to re-fire when a
child reopens or a new child appears.

## Arguments

- `$ARGUMENTS`: `<parent_id>` — Container task identifier.

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable).
- `$LUDICS_RESULTS_DIR`: Directory for writing result JSON (environment variable).
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`.

## Steps

This skill is materially lighter than `/ludics-verify-completion` — no
codebase inspection, no worker delegation. The orchestrator does all the work
inline.

1. **Read the parent task file** at `$LUDICS_STATE_PATH/tasks/<parent_id>.md`.
   - Confirm `leaf: false` is set. If not, write a result JSON with
     `"status": "error"` and `"reason": "not a container task"` and stop.
   - Confirm `status` is not in `done`/`abandoned`/`merged` already. If it is,
     write a result JSON with `"status": "skipped"` and stop.
   - Capture the parent's `title` and `project` for the notify summary.

2. **Enumerate children** by scanning every `*.md` file under
   `$LUDICS_STATE_PATH/tasks/` with the standard `Read` / `Glob` tools.
   Inspect each file's YAML frontmatter and keep the ones whose
   `dependencies.subtask_of` equals `<parent_id>`. For each match, record
   the `id`, `status`, and a one-line outcome summary taken from the
   child's `## Notes` section (trim to a single line; fall back to
   `(no notes)`). All work stays in this orchestrator turn — no worker.

3. **Identify residual ambiguity.** Read the parent's body (everything after
   the frontmatter `---` and the `# Title` heading). Compare its scoped
   semantic claims (the AC bullets in the proposal it points to via
   `proposal:` if present, or its own `## Acceptance Criteria` block) against
   the children's outcomes. For each unmet semantic — work the children did
   not cover — file a follow-up:

   ```bash
   ludics tasks create "<short residual description>" <project> C
   ```

   Then edit the new file's frontmatter to set `status: needs-confirmation`
   (the `ludics tasks create` CLI does not accept a status flag) and, under
   the existing `dependencies:` block, replace `relates_to: []` with
   `relates_to: [<parent_id>]`. Use `needs-confirmation`, **not** `deferred`
   — the dashboard's needs-confirmation surface (with confirm/dismiss API
   endpoints) is the correct UI routing for "user must take an action".

4. **Notify the user.** Send a single outgoing notification summarizing:
   - which children were `done`, which were `abandoned`,
   - any follow-ups created in step 3,
   - the three options the user has: mark the container `done`, mark it
     `abandoned` with rationale, or act on the follow-ups first.

   ```bash
   ludics notify outgoing "Container <parent_id> ready for review: <K> child(ren) resolved, <M> follow-up(s) filed. Decide: mark done / abandoned / process follow-ups." 3 "Container Completion"
   ```

5. **Write result JSON** at `$LUDICS_RESULTS_DIR/<request_id>.json` with:
   ```json
   {
     "status": "completed",
     "task_id": "<parent_id>",
     "children": [{"id": "...", "status": "...", "summary": "..."}],
     "followups_filed": <count>
   }
   ```

6. **Exit.** Do **not** transition the parent's status. The user decides.

## Bounded re-fire

When a `needs-confirmation` follow-up itself transitions to
`done` / `abandoned`, the all-children-resolved sweep re-fires this skill on
the parent — provided the debounce sentinel was cleared at the previous
resolution. Each iteration either resolves an ambiguity (closer to the user
deciding `done`) or files another concise follow-up. Bounded because each
resolution narrows the residual space.

## Errors

- Parent file missing → `"status": "error"`, `"reason": "task not found"`.
- Parent missing `leaf: false` → `"status": "error"`, see step 1.
- No children found via `subtask_of` → write `"status": "skipped"`,
  `"reason": "vacuous container"` (the sweep should not have queued this; if
  it did, dedupe via `queueHasPendingActionForTask` was bypassed manually).
