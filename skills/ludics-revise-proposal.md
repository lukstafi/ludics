---
name: ludics-revise-proposal
description: Revise existing proposal based on feedback, re-send notification
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

## Process

### 1. Read task file (for Mag's awareness)

```bash
cat "$LUDICS_STATE_PATH/tasks/$ARGUMENTS.md"
```

Extract: title, project, slot number, proposal path. Verify that a `proposal:`
field exists — if the task has no proposal yet, write a result JSON with
`"status": "error"` and message "no proposal to revise", then stop.
`proposal: inline` is a valid legacy value and proceeds normally; the worker treats the task
body as the proposal source and revises it in-place.

### 2. Resolve project path

Look up the task's `project` field in `$LUDICS_STATE_PATH/config.yaml`.
Each project entry has a `repo` field; the local checkout is typically
`~/<repo-name>`. The `personal` project refers to the state repository itself.

### 3. Compose context brief

Parse user feedback from `$ARGUMENTS` (everything after the task ID). This is
the primary input for revision — include it verbatim in the context brief.

Write a short free-form context brief (3-10 lines) distilling relevant
background from Mag's conversation history. Include any of:
- User feedback from `$ARGUMENTS` (quote it directly for the worker)
- Related tasks in progress (overlap risks, dependency changes)
- Mag's own observations about what's wrong with the current proposal
- Known staleness signals or priority shifts since the original draft

If no feedback was provided, say so — the worker will use its own judgment
from re-reading the codebase.

### 4. Delegate to worker

```
/ludics-revise-proposal-worker <task_id> <project_path> <context_brief>
```

The worker runs in a forked context — its codebase exploration, file edits,
and git operations do not enter Mag's conversation history.

### 5. Interpret worker result

Parse the worker's response for STATUS, PROPOSAL_PATH, PROPOSAL_MODE, CHANGES_SUMMARY,
TITLE, and SUMMARY fields.

- **STATUS: revised** → proceed to re-notification
- **STATUS: no-changes** → write result JSON with `"status": "no-changes"`, stop
- **STATUS: error** → write result JSON with `"status": "error"`, stop

Note `PROPOSAL_MODE` for the steps below:
- `PROPOSAL_MODE: file` — worker revised a separate proposal file; `PROPOSAL_PATH` is present.
- `PROPOSAL_MODE: inline` — worker revised the task body in-place; `PROPOSAL_PATH` is absent.

### 6. Re-send proposal notification

**File-based mode** (`PROPOSAL_MODE: file`):
```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "<project_path>/<PROPOSAL_PATH>"
```

**Inline mode** (`PROPOSAL_MODE: inline`): the proposal content lives in the task file itself.
Use the task file as the attachment:
```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "$LUDICS_STATE_PATH/tasks/<task_id>.md"
```

This re-sends the proposal with launch/revise/abandon buttons, completing the iteration loop.

### 7. Best-effort desktop

**File-based mode**:
```bash
code "<project_path>/<PROPOSAL_PATH>" 2>/dev/null || true
```

**Inline mode**:
```bash
code "$LUDICS_STATE_PATH/tasks/<task_id>.md" 2>/dev/null || true
```

### 8. Write result JSON

**File-based mode**:
```json
{
  "id": "req-...",
  "status": "revised",
  "timestamp": "...",
  "task_id": "<task_id>",
  "proposal_path": "<PROPOSAL_PATH>",
  "proposal_mode": "file",
  "changes_summary": "<what changed>",
  "output": "Revised proposal for <task_id>: <title>"
}
```

**Inline mode**:
```json
{
  "id": "req-...",
  "status": "revised",
  "timestamp": "...",
  "task_id": "<task_id>",
  "proposal_path": null,
  "proposal_mode": "inline",
  "changes_summary": "<what changed>",
  "output": "Revised proposal for <task_id>: <title>"
}
```

## Delegation Strategy

- **Worker subagent** (`/ludics-revise-proposal-worker`): Codebase re-exploration,
  task file additive edits, proposal file destructive edits, git commit+push —
  runs in isolated context
- **Orchestrator** (this skill): Task file read, feedback collection, decision
  routing, re-notification, result JSON — runs inline in Mag's context

## Error Handling

- Task not found: Write result with status "error"
- No proposal field on task: Write result with status "error"
- Worker returns error: Propagate to result JSON
- Notification fails: Log warning, continue
