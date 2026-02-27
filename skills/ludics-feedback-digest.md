---
name: ludics-feedback-digest
description: Summarize workflow feedback, file GitHub issues
---

# /ludics-feedback-digest - Workflow Feedback Digest (Orchestrator)

Thin orchestrator that delegates feedback processing to an isolated worker,
then handles result reporting.

## Trigger

This skill is invoked when:
- The user runs `ludics mag feedback-digest <repo>`
- Auto-triggered by agent-duo on session completion (if `auto_digest=true`)

## Arguments

- `$ARGUMENTS`: `<repo>` — GitHub repo (e.g., `owner/repo`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- `$LUDICS_RESULTS_DIR`: Directory for result JSON (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Process

### 1. Delegate to worker

```
/ludics-feedback-digest-worker <repo>
```

The worker runs in a forked context — its feedback file reads, theme clustering,
and GitHub issue operations do not enter Mag's conversation history. The worker
handles reading, clustering, deduplication, issue filing, and file cleanup
autonomously.

### 2. Interpret worker result

Parse the worker's response for STATUS and counts.

- **STATUS: completed** → write result JSON
- **STATUS: empty** → write result JSON indicating nothing to process
- **STATUS: error** → write result JSON with `"status": "error"`

### 3. Write result JSON

Read request ID and write to `$LUDICS_RESULTS_DIR/$REQ_ID.json`:

```json
{
  "id": "<request-id>",
  "status": "completed",
  "timestamp": "<ISO-8601>",
  "issues_created": N,
  "issues_updated": N,
  "issues_skipped": N,
  "files_processed": N,
  "output": "Created N issues, updated N, skipped N (N files processed)"
}
```

## Delegation Strategy

- **Worker subagent** (`/ludics-feedback-digest-worker`): All feedback reading,
  theme extraction, issue dedup/filing, file cleanup — runs in isolated context
- **Orchestrator** (this skill): Result JSON — runs inline in Mag's context

## Error Handling

- Worker returns error: Propagate to result JSON with `"status": "error"`
- Repo not specified: Write result with status "error"
