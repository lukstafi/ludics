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

### 3. Compose context brief

Write a short free-form context brief (3-10 lines) distilling relevant
background from Mag's conversation history. Include any of:
- User preferences affecting scope or approach for this task
- Related tasks in progress (what slots are doing, overlap risks)
- Recent decisions or conversations relevant to this task
- Known staleness signals or priority shifts

If nothing relevant, pass an empty brief.

### 4. Delegate to worker

Invoke the isolated worker skill:

```
/ludics-draft-proposal-worker <task_id> <project_path> <context_brief>
```

The worker runs in a forked context — its codebase exploration, file reads,
and git operations do not enter Mag's conversation history. Only the worker's
final response returns here.

### 5. Interpret worker result

Parse the worker's response for STATUS, PROPOSAL_PATH, AMBIGUITIES,
START_CONFIDENCE, START_RATIONALE, TITLE, and SUMMARY fields.

- **STATUS: completed** → proceed to auto-start evaluation (Step 5.5)
- **STATUS: stale** → write result JSON with `"status": "stale"`, stop
- **STATUS: split-needed** → queue the split skill and stop:
  ```bash
  ludics mag split-task <task_id>
  ```
  Write result JSON with `"status": "split-needed"`, stop.
- **STATUS: error** → write result JSON with `"status": "error"`, stop
- **STATUS: already-exists** → check if re-generation is wanted, or skip

### 5.5. Evaluate auto-start decision

After STATUS: completed, evaluate whether to auto-start the slot or defer
to the user:

```bash
ludics mag auto-start-evaluate <task_id> <START_CONFIDENCE>
```

Parse the JSON output for the `decision` field:
- `"auto-start"` → proceed to Step 6a (auto-start)
- `"defer-to-user"` → proceed to Step 6b (notification with launch buttons)

The decision respects the `start_sessions` autonomy level:
- `manual` or `suggest` → always defers to the user
- `auto` → auto-starts when worker reports `high` confidence and a slot is assigned;
  defers otherwise

### 6a. Auto-start slot (if decision = "auto-start")

Start the assigned slot directly:

```bash
ludics slot <N> start
```

Send a lighter notification (priority 2):

```bash
ludics notify outgoing "Started slot <N> for <task_id>: <title>"
```

Skip the launch-button notification — proceed to Step 7 (questions) and
Step 9 (result JSON).

### 6b. Send notification with action buttons (if decision = "defer-to-user")

Use the worker's `PROPOSAL_PATH` as the source of truth for the proposal location:

```bash
ludics notify proposal "<task_id>" "<title>" "<summary>" "<project_path>/<PROPOSAL_PATH>"
```

### 7. Send questions notification (if ambiguities found)

If the worker reported ambiguities (not "none"), send them as numbered questions:

```bash
ludics notify outgoing "<questions text>"
```

Use title: "Proposal questions — <task_id>: <title>"

### 8. Best-effort desktop

```bash
code "<project_path>/<PROPOSAL_PATH>" 2>/dev/null || true
```

### 9. Write result JSON

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
