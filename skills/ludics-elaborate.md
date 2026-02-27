---
name: ludics-elaborate
description: Elaborate a task into a detailed specification
---

# /ludics-elaborate - Task Elaboration (Orchestrator)

Thin orchestrator that reads the task, delegates context gathering and spec
writing to an isolated worker, then handles notifications and result reporting.

## Trigger

This skill is invoked:
- When the user runs `ludics mag elaborate <task_id>`
- Before assigning a task to a slot
- For freshly generated tasks from the `ludics tasks sync` automation

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

Extract: title, project, elaboration status. Gives Mag context about what's
being elaborated and whether it's already been done.

### 2. Resolve project path

Look up the task's `project` field in `$LUDICS_STATE_PATH/config.yaml`,
resolve to local checkout path (typically `~/<repo-name>`).

### 3. Compose context brief

Write a short free-form context brief (3-10 lines) distilling relevant
background from Mag's conversation history. Include any of:
- Related tasks that cover adjacent ground (overlap or dependency risks)
- User preferences for scope, approach, or priorities
- Recent decisions or discussions relevant to this task's domain
- Cross-task awareness (what other slots are working on)

If nothing relevant, pass an empty brief.

### 4. Delegate to worker

```
/ludics-elaborate-worker <task_id> <project_path> <context_brief>
```

The worker runs in a forked context — its codebase reads, dependency analysis,
and file writes do not enter Mag's conversation history.

### 5. Interpret worker result

Parse the worker's response for STATUS, QUESTIONS, and SUMMARY.

- **STATUS: completed** → proceed to notifications
- **STATUS: merged** → write result JSON noting the merge, stop
- **STATUS: already-elaborated** → ask if re-elaboration is wanted, or skip
- **STATUS: error** → write result JSON with `"status": "error"`, stop

### 6. Send questions notification (if gaps found)

If the worker reported questions (not "none"):

```bash
ludics notify outgoing "<questions text>"
```

Use title: "Elaboration questions — <task_id>: <title>"

Skip if no questions.

### 7. Write result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "output": "Elaborated <task_id> with implementation plan",
  "task_id": "<task_id>"
}
```

## Delegation Strategy

- **Worker subagent** (`/ludics-elaborate-worker`): Duplicate checking, context
  gathering, codebase exploration, spec writing, task file update — runs in
  isolated context
- **Orchestrator** (this skill): Task file read, decision routing, notifications,
  result JSON — runs inline in Mag's context

## Error Handling

- Task not found: Write result with status "error"
- Worker returns error: Propagate to result JSON
- Already elaborated: Ask if re-elaboration is wanted
