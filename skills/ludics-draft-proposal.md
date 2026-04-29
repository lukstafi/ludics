---
name: ludics-draft-proposal
description: Write proposal document, send launch buttons
queue-action: draft-proposal
queue-args: [task]
---

# /ludics-draft-proposal - Draft Proposal & Notify (Orchestrator)

Thin orchestrator that reads the task, delegates codebase exploration to an
isolated worker, then handles notifications and result reporting.

<!-- section:trigger -->
## Trigger

This skill is invoked when:
- The user runs `ludics mag draft-proposal <task-id>`
- Auto-queued during keepalive for top ready queue tasks that are elaborated,
  have no unanswered questions (`has_questions` not set), and have no proposal yet

<!-- section:arguments -->
## Arguments

- `$ARGUMENTS`: `<task_id>` — Task identifier (e.g., `task-042`)

<!-- section:inputs -->
## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

<!-- section:common-steps -->
## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **A** (Task Resolution): read task file, extract title/project/slot.
- **B** (Project Path): resolve the project checkout from config, and the
  proposals path (see below).
- **C** (Context Brief): compose a 3-10 line brief from conversation history.
- **D** (Worker Delegation): invoke the worker in forked context.
- **E** (Result JSON): write the result with the request ID.
- **F** (Error Handling): standard patterns.

<!-- section:proposals-path-resolution -->
### Proposals Path Resolution (extends Section B)

After resolving the project path, check the project's `proposals_path` in
the same config entry and compute the absolute proposals directory:

- If `proposals_path` is set: `<project_path>/<proposals_path>`.
- Otherwise probe, in order:
  1. `<project_path>/docs/` → `<project_path>/docs/proposals/`
  2. `<project_path>/doc/` → `<project_path>/doc/proposals/`
  3. `<project_path>/.docs/` → `<project_path>/.docs/proposals/`
  4. Fallback: `<project_path>/docs/proposals/`.

The worker creates the directory; this step just resolves the path.

Worker: `/ludics-draft-proposal-worker <task_id> <project_path> <proposals_path> <context_brief>`

<!-- section:precondition-check -->
## Precondition check

If the task frontmatter has `has_questions: true`, there are unanswered
questions from elaboration — skip the proposal:
- Write result JSON with `"status": "blocked"` and `"unanswered questions"`.
- Don't delegate to the worker; Mag's nag loop reminds the user to answer.

### Container short-circuit

If the task's frontmatter has `leaf: false`, the work has already been split
into subtasks and drafting a proposal for the parent is a no-op. Before any
worker delegation:

1. Use the `Edit` tool to append a single line to the task's `## Notes`
   section: `Skipped: container task — work split into children`. The shared
   `appendToSection` helper dedupes — repeated stale queue items do not stack.
2. Write a result JSON with `"status": "skipped-container"` and the parent's
   id, then exit. **Do not invoke the worker, and do not write a proposal
   file.**
3. The queue-pop layer drops this request rather than re-queueing.

<!-- section:status-routing -->
## Status routing

Extract the final ` ```json ` block from the worker's response. Fields:

| Field | Used for | Missing-field fallback |
|---|---|---|
| `status` | primary routing | error (malformed response) |
| `proposal_path` | notification, result JSON | expected absent for stale/split-needed/error |
| `ambiguities` | questions notification | treat as `"none"`, skip |
| `start_confidence` | auto-start eval | default `"low"` (defer to user) |
| `start_rationale` | auto-start eval | empty string |
| `title` | notification title | fall back to task_id |
| `summary` | notification body, result JSON | empty string |
| `skip_plan` | task frontmatter | default `false`, remove stale frontmatter value |
| `task_id` | — | not consumed |

Routing by status:
- **completed** — write `proposal: <proposal_path>` into the task frontmatter
  (the orchestrator does this so the worker's isolated context doesn't race
  with git sync). If the worker returned `"skip_plan": true`, write
  `skip_plan: true` as well; otherwise remove any stale `skip_plan` from a
  prior run. `skip_plan: true` causes medium-effort tasks to skip the plan
  phase in orchestration. Then go to auto-start evaluation.
- **stale** — write result JSON with `"status": "stale"` and stop.
- **split-needed** — queue the split skill and stop:
  ```bash
  ludics mag split-task <task_id>
  ```
  Write result JSON with `"status": "split-needed"`.
- **error** — write result JSON with `"status": "error"` and stop.
- **already-exists** — check whether re-generation is wanted, or skip.

<!-- section:auto-start-evaluation -->
## Auto-start evaluation

After `status: "completed"`, decide whether to auto-start the slot or defer:

```bash
ludics mag auto-start-evaluate <task_id> <start_confidence> "<start_rationale>"
```

Parse the JSON for `decision`:
- `"auto-start"` — go to auto-start below.
- `"defer-to-user"` — go to the launch-button notification.

The decision follows the `start_sessions` autonomy level:
- `manual` or `suggest` — always defers.
- `auto` — auto-starts when the worker reports `high` confidence and a slot is
  assigned; defers otherwise.

How the decision is made:
- Confidence is the main signal — the worker has the codebase context, so its
  `start_confidence` leads.
- Rationale is a safety net — we scan for ambiguity keywords ("ambiguous",
  "unclear", "speculative", "open question", "uncertain scope") that contradict
  a `high` signal. Any hit flips the decision to `defer-to-user`.
- Vague acceptance criteria alone don't block auto-start; follow-up work can
  refine them.
- A task with no assigned slot always defers.

The `skip_plan` frontmatter field (if the worker sets it) is consumed later by
`selectOrchestrationFlagsForTask()` — at slot start time, medium-effort tasks
with `skip_plan: true` skip the plan phase. It isn't used by
`auto-start-evaluate`.

<!-- section:auto-start-slot -->
## Auto-start slot

For `decision = "auto-start"`, start the slot directly and send a lighter
notification (priority 2):

```bash
ludics slot <N> start
ludics notify outgoing "Started slot <N> for <task_id>: <title>"
```

Skip the launch-button notification; move on to questions and result JSON.

<!-- section:proposal-notification -->
## Proposal notification (defer-to-user)

For `decision = "defer-to-user"`, use the worker's `proposal_path`:

```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "<project_path>/<proposal_path>"
```

<!-- section:questions-notification -->
## Questions notification

If `ambiguities` is non-empty (and not `"none"`), send them as a numbered
list:

```bash
ludics notify outgoing "<formatted ambiguities>"
```

Use title: `"Proposal questions — <task_id>: <title>"`. Skip when
`ambiguities` is `"none"` or empty.

<!-- section:best-effort-desktop -->
## Best-effort desktop

```bash
code "<project_path>/<proposal_path>" 2>/dev/null || true
```

<!-- section:result-fields -->
## Result fields

```json
{
  "task_id": "<task_id>",
  "proposal_path": "<proposal_path>"
}
```

Output: `"Proposal written for <task_id>: <title>"`.

<!-- section:delegation-strategy -->
## Delegation strategy

- Worker (`/ludics-draft-proposal-worker`) runs in isolated context: codebase
  exploration, proposal writing, git commit+push, task frontmatter update.
- Orchestrator (this skill) runs inline in Mag: task read, decision routing,
  notifications, result JSON.
