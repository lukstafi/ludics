---
name: ludics-draft-proposal
description: Write proposal document, send launch buttons
---

# /ludics-draft-proposal - Draft Proposal & Notify (Orchestrator)

Thin orchestrator that reads the task, delegates codebase exploration to an
isolated worker, then handles notifications and result reporting.

## Trigger

This skill is invoked when:
- The user runs `ludics mag draft-proposal <task-id>`
- Auto-queued during keepalive for tasks assigned to slots that are missing proposals
  (when `start_sessions` autonomy is not `manual`)

## Arguments

- `$ARGUMENTS`: `<task_id>` — Task identifier (e.g., `task-042`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **A** (Task Resolution): read task file, extract title/project/slot
- **B** (Project Path): resolve project checkout path from config.
  **Additionally**: resolve the proposals path (see below).
- **C** (Context Brief): compose 3-10 line brief from conversation history
- **D** (Worker Delegation): invoke worker in forked context
- **E** (Result JSON): write result with request ID
- **F** (Error Handling): standard error patterns

### Proposals Path Resolution (extends Section B)

After resolving the project path, check the project's `proposals_path` field
in the same config entry. Then compute the absolute proposals directory:

- If `proposals_path` is set: `<project_path>/<proposals_path>`
- Otherwise probe in order:
  1. `<project_path>/docs/` exists -> use `<project_path>/docs/proposals/`
  2. `<project_path>/doc/` exists -> use `<project_path>/doc/proposals/`
  3. `<project_path>/.docs/` exists -> use `<project_path>/.docs/proposals/`
  4. Fallback: `<project_path>/docs/proposals/`

The worker will create the directory; this step only resolves the path.

Worker: `/ludics-draft-proposal-worker <task_id> <project_path> <proposals_path> <context_brief>`

## Skill-Specific: Status Routing

Extract the JSON block from the worker's response (the last fenced ` ```json ` block).
Parse the JSON for `status`, `proposal_path`, `ambiguities`, `start_confidence`,
`start_rationale`, `title`, and `summary`.

If no JSON block is found, fall back to line-based parsing: look for `STATUS: <value>`,
`PROPOSAL_PATH: <value>`, `AMBIGUITIES: <value>`, `START_CONFIDENCE: <value>`,
`START_RATIONALE: <value>`, `TITLE: <value>`, and `SUMMARY: <value>` lines. On the
legacy path, treat `AMBIGUITIES:` content as a pre-formatted string and send as-is
in the questions notification step.

- **status: completed** — proceed to auto-start evaluation (next section)
- **status: stale** — write result JSON with `"status": "stale"`, stop
- **status: split-needed** — queue the split skill and stop:
  ```bash
  ludics mag split-task <task_id>
  ```
  Write result JSON with `"status": "split-needed"`, stop.
- **status: error** — write result JSON with `"status": "error"`, stop
- **status: already-exists** — check if re-generation is wanted, or skip

## Skill-Specific: Auto-start Evaluation

After status: `"completed"`, evaluate whether to auto-start the slot or defer
to the user:

```bash
ludics mag auto-start-evaluate <task_id> <start_confidence> "<start_rationale>"
```

Parse the JSON output for the `decision` field:
- `"auto-start"` — proceed to auto-start (next section)
- `"defer-to-user"` — proceed to notification with launch buttons

The decision respects the `start_sessions` autonomy level:
- `manual` or `suggest` — always defers to the user
- `auto` — auto-starts when worker reports `high` confidence and a slot is assigned;
  defers otherwise

**Decision criteria details:**
- **Confidence is the primary signal** — the worker's `start_confidence` drives the
  decision. The worker has full codebase context and is the authority on scope clarity.
- **Rationale is a safety net** — the rationale text is scanned for ambiguity keywords
  ("ambiguous", "unclear", "speculative", "open question", "uncertain scope") that
  contradict a `high` confidence signal. If found, the decision overrides to `defer-to-user`.
- **Vague acceptance criteria do NOT block auto-start** — improvements can be refined
  in follow-up work.
- Tasks with no assigned slot always defer to the user.

## Skill-Specific: Auto-start Slot

If decision = "auto-start", start the assigned slot directly:

```bash
ludics slot <N> start
```

Send a lighter notification (priority 2):

```bash
ludics notify outgoing "Started slot <N> for <task_id>: <title>"
```

Skip the launch-button notification — proceed to questions and result JSON.

## Skill-Specific: Proposal Notification (defer-to-user)

If decision = "defer-to-user", use the worker's `proposal_path` as the source
of truth for the proposal location:

```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "<project_path>/<proposal_path>"
```

## Skill-Specific: Questions Notification

If `ambiguities` is not `"none"` and is non-empty, send as notification text:
- JSON array path: format each element as a numbered list
- Legacy pre-formatted string (fallback path): send as-is

```bash
ludics notify outgoing "<formatted ambiguities>"
```

Use title: "Proposal questions — <task_id>: <title>"

Skip if `ambiguities` is `"none"` or an empty array/string.

## Skill-Specific: Best-effort Desktop

```bash
code "<project_path>/<proposal_path>" 2>/dev/null || true
```

## Skill-Specific Result Fields

```json
{
  "task_id": "<task_id>",
  "proposal_path": "<proposal_path>"
}
```

Output format: `"Proposal written for <task_id>: <title>"`

## Delegation Strategy

- **Worker** (`/ludics-draft-proposal-worker`): All codebase exploration,
  proposal writing, git commit+push, task frontmatter update — runs in isolated context
- **Orchestrator** (this skill): Task file read, decision routing, notifications,
  result JSON — runs inline in Mag's context
