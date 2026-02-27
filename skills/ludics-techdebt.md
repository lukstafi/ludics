---
name: ludics-techdebt
description: Technical debt review — scan codebases, file issues
---

# /ludics-techdebt - Technical Debt Review (Orchestrator)

Thin orchestrator that delegates codebase scanning to an isolated worker,
then handles notifications and result reporting.

## Trigger

This skill is invoked when:
- The user runs `ludics mag techdebt`
- Weekly automation (e.g., Friday 17:00)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Process

### 1. Delegate to worker

```
/ludics-techdebt-worker
```

The worker runs in a forked context — its commit scanning, codebase reads,
grep operations, and GitHub issue filing do not enter Mag's conversation history.
The worker handles project discovery, scanning, and issue filing autonomously.

### 2. Interpret worker result

Parse the worker's response for STATUS, counts, and REPORT.

- **STATUS: completed** → proceed to notifications
- **STATUS: error** → write result JSON with `"status": "error"`, stop

### 3. Send notifications

If high-priority items found:
```bash
ludics notify outgoing "Tech debt review: <HIGH> high-priority items found" 3 "Weekly Review"
```

If issues were filed:
```bash
ludics notify outgoing "Filed <ISSUES_CREATED> techdebt issues" 3 "Tech Debt"
```

### 4. Write result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "high": N,
  "medium": N,
  "low": N,
  "tasks_created": [...],
  "issues_created": N,
  "issues_updated": N,
  "issues_skipped": N
}
```

## Delegation Strategy

- **Worker subagent** (`/ludics-techdebt-worker`): All codebase scanning,
  commit analysis, code smell detection, GitHub issue filing/dedup — runs in
  isolated context
- **Orchestrator** (this skill): Notifications, result JSON — runs inline
  in Mag's context
