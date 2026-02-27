---
name: ludics-sync-learnings
description: Consolidate learnings into structured memory files
---

# /ludics-sync-learnings - Knowledge Consolidation (Orchestrator)

Thin orchestrator that delegates knowledge consolidation to an isolated worker,
then handles result reporting.

## Trigger

This skill is invoked when:
- The user runs `ludics mag sync-learnings`
- Periodically (weekly) via automation
- When corrections.md grows beyond a threshold

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Process

### 1. Delegate to worker

```
/ludics-sync-learnings-worker
```

The worker runs in a forked context — its corrections reading, journal scanning,
memory file updates, and GitHub issue operations do not enter Mag's conversation
history. The worker handles all consolidation, archiving, issue filing, and
CLAUDE.md staging autonomously.

### 2. Interpret worker result

Parse the worker's response for STATUS and counts.

- **STATUS: completed** → write result JSON
- **STATUS: error** → write result JSON with `"status": "error"`

### 3. Write result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "processed": N,
  "updates": {
    "tools.md": N,
    "workflows.md": N,
    "projects/<project>.md": N
  },
  "archived": N,
  "issues_created": N,
  "issues_updated": N
}
```

## Delegation Strategy

- **Worker subagent** (`/ludics-sync-learnings-worker`): All corrections reading,
  journal scanning, theme grouping, memory file updates, archiving, GitHub issue
  filing, CLAUDE.md staging — runs in isolated context
- **Orchestrator** (this skill): Result JSON — runs inline in Mag's context

## Error Handling

- Worker returns error: Propagate to result JSON with `"status": "error"`
