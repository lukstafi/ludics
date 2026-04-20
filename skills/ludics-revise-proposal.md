---
name: ludics-revise-proposal
description: Revise existing proposal based on feedback, re-send notification
queue-action: revise-proposal
queue-args: [task, feedback]
---

# /ludics-revise-proposal - Revise Proposal & Re-notify (Orchestrator)

Thin orchestrator that reads the task and its existing proposal, checks for
user feedback, delegates revision to an isolated worker, then re-sends the
proposal notification so the user can review the update and launch or iterate
again.

## Trigger

This skill is invoked when:
- The user runs `ludics mag revise-proposal <task-id>`
- The user taps the "revise" button on a proposal notification (via ntfy)

## Arguments

- `$ARGUMENTS`: `<task_id> [<feedback>]` — Task identifier followed by optional
  user feedback text. When the user taps "revise" on a proposal notification and
  then sends a follow-up message, the feedback arrives here as a single string.

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **A** (Task Resolution): read task file, extract title/project/slot. Also
  check that the frontmatter has a `proposal:` field — if not, write an error
  result `"no proposal to revise"` and stop. `proposal: inline` is a valid
  legacy value; the worker revises the task body in-place.
- **B** (Project Path): resolve the project checkout from config.
- **C** (Context Brief): compose a 3-10 line brief from conversation history.
  Also parse user feedback from `$ARGUMENTS` (everything after the task ID)
  and include it verbatim — that's the primary input for revision. If no
  feedback was given, say so; the worker will use its own judgment.
- **D** (Worker Delegation): invoke the worker in forked context.
- **E** (Result JSON): write the result with the request ID.
- **F** (Error Handling): standard patterns, plus the "no proposal field" error.

Worker: `/ludics-revise-proposal-worker <task_id> <project_path> <context_brief>`

## Status routing

Extract the final ` ```json ` block from the worker. Fields:

| Field | Used for | Missing-field fallback |
|---|---|---|
| `status` | primary routing | error (malformed response) |
| `proposal_path` | re-notification, result JSON | expected absent when `proposal_mode = "inline"` |
| `proposal_mode` | mode branching | error when `status = "revised"` (do not default to `"file"`) |
| `changes_summary` | result JSON | empty string |
| `title` | notification title | fall back to task_id |
| `summary` | notification body | empty string |
| `task_id` | — | not consumed |

Routing by status:
- **revised** — re-notify (see below).
- **no-changes** — write result JSON with `"status": "no-changes"` and stop.
- **error** — write result JSON with `"status": "error"` and stop.

The `proposal_mode` shapes the steps below:
- `"file"` — worker revised a separate proposal file; `proposal_path` is present.
- `"inline"` — worker revised the task body in-place; `proposal_path` is absent.

## Re-send proposal notification

File-based:
```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "<project_path>/<proposal_path>"
```

Inline (the proposal content lives in the task file):
```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

Either way, this re-sends the proposal with launch/revise/abandon buttons and
closes the iteration loop.

## Best-effort desktop

File-based:
```bash
code "<project_path>/<proposal_path>" 2>/dev/null || true
```

Inline:
```bash
code "$LUDICS_STATE_PATH/tasks/<task_id>.md" 2>/dev/null || true
```

## Result fields

File-based:
```json
{
  "task_id": "<task_id>",
  "proposal_path": "<proposal_path>",
  "proposal_mode": "file",
  "changes_summary": "<what changed>"
}
```

Inline:
```json
{
  "task_id": "<task_id>",
  "proposal_path": null,
  "proposal_mode": "inline",
  "changes_summary": "<what changed>"
}
```

## Delegation strategy

- Worker (`/ludics-revise-proposal-worker`) runs in isolated context:
  codebase re-exploration, additive task file edits, destructive proposal
  edits, git commit+push.
- Orchestrator (this skill) runs inline in Mag: task read, feedback
  collection, decision routing, re-notification, result JSON.
