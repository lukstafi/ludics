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

## Process

### 1. Read task file (for Mag's awareness)

```bash
cat "$LUDICS_STATE_PATH/tasks/$ARGUMENTS.md"
```

Extract: title, project, slot number. This gives Mag context about the task
being proposed without doing deep codebase exploration.

### 2. Resolve project path

Look up the task's `project` field in `$LUDICS_STATE_PATH/config.yaml`.
Each project entry has a `repo` field (e.g., `lukstafi/ocannl`); the local
checkout is typically `~/<repo-name>`. The `personal` project refers to the
state repository itself.

### 3. Delegate to worker

Invoke the isolated worker skill:

```
/ludics-draft-proposal-worker <task_id> <project_path>
```

The worker runs in a forked context — its codebase exploration, file reads,
and git operations do not enter Mag's conversation history. Only the worker's
final response returns here.

### 4. Interpret worker result

Parse the worker's response for STATUS, PROPOSAL_PATH, AMBIGUITIES, TITLE,
and SUMMARY fields.

- **STATUS: completed** → proceed to notifications
- **STATUS: stale** → write result JSON with `"status": "stale"`, stop
- **STATUS: split-needed** → queue the split skill and stop:
  ```bash
  ludics mag split-task <task_id>
  ```
  Write result JSON with `"status": "split-needed"`, stop.
- **STATUS: error** → write result JSON with `"status": "error"`, stop
- **STATUS: already-exists** → check if re-generation is wanted, or skip

### 5. Send notification with action buttons

Use the worker's `PROPOSAL_PATH` as the source of truth for the proposal location:

```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "<project_path>/<PROPOSAL_PATH>"
```

### 6. Send questions notification (if ambiguities found)

If the worker reported ambiguities (not "none"), send them as numbered questions:

```bash
ludics notify outgoing "<questions text>"
```

Use title: "Proposal questions — <task_id>: <title>"

### 7. Best-effort desktop

```bash
code "<project_path>/<PROPOSAL_PATH>" 2>/dev/null || true
```

### 8. Write result JSON

Use the worker's `PROPOSAL_PATH` in the result:

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "task_id": "<task_id>",
  "proposal_path": "<PROPOSAL_PATH>",
  "output": "Proposal written for <task_id>: <title>"
}
```

## Delegation Strategy

- **Worker subagent** (`/ludics-draft-proposal-worker`): All codebase exploration,
  proposal writing, git commit+push, task frontmatter update — runs in isolated context
- **Orchestrator** (this skill): Task file read, decision routing, notifications,
  result JSON — runs inline in Mag's context

## Error Handling

- Task not found: Write result with status "error"
- Worker returns error: Propagate to result JSON
- Notification fails: Log warning, continue
