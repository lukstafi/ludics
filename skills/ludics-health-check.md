# /ludics-health-check - System Health Check

Detect approaching deadlines, check for semantically complete tasks, and flag
other issues requiring attention.

## Trigger

This skill is invoked when:
- The user runs `ludics mag health-check`
- Periodic automation (every 4h via launchd)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

## Process

1. **Check approaching deadlines**:
   - Find tasks with `deadline` field
   - Calculate days remaining
   - Flag if <= 7 days (warning) or <= 3 days (critical)

2. **Check slot health**:
   - Read `slots.md`
   - Identify slots that have been active > 24h without status update
   - Run `ludics sessions report` and check for orphaned/unclassified sessions
     (sessions with no slot match in `sessions.md`)

3. **Check queue health**:
   - Read `mag/queue.jsonl`
   - Flag if requests have been pending > 1h

4. **Detect deltas since previous health check**:
   - Prefer git diff in state repo for scope awareness:
     `git -C "$LUDICS_STATE_PATH" diff --name-only HEAD~1..HEAD -- tasks/ slots.md sessions.md mag/queue.jsonl journal/notifications.jsonl 2>/dev/null || true`
   - Build stable issue keys for all findings (examples:
     `deadline:<task-id>`, `slot-stale:<slot>`, `queue-stuck:<request-id>`)
   - Read previous snapshot from `$LUDICS_STATE_PATH/mag/health-last.json` if it exists
   - Mark each finding as `new`, `ongoing`, or `resolved`

5. **Report task elaboration status**:
   - Run `ludics tasks needs-elaboration` to count unprocessed tasks
   - Note: Elaboration queueing is handled automatically by `tasks_queue_elaborations()` in `tasks_sync()` -- no need to enqueue here

6. **Check for semantically complete in-progress tasks**:
   - Read `slots.md` to find slots with active in-progress tasks
   - For each slotted in-progress task (where `completed` is null):
     a. Read the task file from `$LUDICS_STATE_PATH/tasks/<task-id>.md`
     b. Extract the `## Acceptance Criteria` section from the task body
     c. If the task has a `proposal` field, resolve the project path from config
        (same logic as `/ludics-draft-proposal` — look up the project in
        `~/.config/ludics/config.yaml`, find the local checkout path) and read the
        full proposal document from `<project-path>/<proposal-value>`
     d. Examine the current project state for completion evidence:
        - Check git log in the project directory for recent commits mentioning the
          task ID or proposal name
        - Check if acceptance criteria checkboxes are marked complete (`- [x]`)
        - Look for test files, documentation, or other artifacts mentioned in
          acceptance criteria
        - Read relevant source files referenced in the proposal's "Proposed Change"
          section to verify the described changes exist
     e. Make a semantic judgment: do ALL acceptance criteria appear to be met?
        - **Yes (high confidence)**: Run `ludics slot <N> clear done` and send a
          notification:
          ```bash
          ludics notify outgoing "Auto-completed: <task-id> (<title>)" 3 "Health Check"
          ```
          Log the auto-completion in the health report.
        - **Uncertain**: Flag as "possibly complete" in the report at warning level.
          Do NOT auto-clear — leave for human review.
     f. Build stable issue keys: `completion:<task-id>` for delta tracking

7. **Generate report**:
   - Categorize issues by severity
   - Explicitly call out `new` and `resolved` findings since last check
   - Include actionable recommendations

8. **Send notifications** for critical issues:
   - Notify only on `new` critical issues or severity escalation (`warning` -> `critical`)
   ```bash
   ludics notify outgoing "Critical: task-042 deadline in 2 days" 5 "Health Check"
   ```

9. **Persist snapshot**:
   - Write current finding keys/severities/timestamp to
     `$LUDICS_STATE_PATH/mag/health-last.json`

## Output Format

### Health Report

```markdown
# Health Check - YYYY-MM-DD HH:MM

## Critical Issues
- **DEADLINE**: task-042 "POPL submission" due in 2 days

## Warnings
- **DEADLINE**: task-101 due in 6 days
- **SLOT**: Slot 3 has been active for 28 hours without update

## Info
- Active slots: 2/6
- Ready tasks: 8
- Blocked tasks: 3
- Queue pending: 0
- Tasks needing elaboration: 5

## Elaboration Status
- 2 tasks awaiting elaboration (queued automatically by mag keepalive)

## Completion Detection
- Slot 2 (task gh-ludics-42): All acceptance criteria appear met. Auto-cleared as done.
- Slot 3 (task gh-myapp-15): 2/3 criteria met; "API documentation" criterion unclear. Flagged for review.

## Recommendations
1. Prioritize task-042 - deadline is imminent
2. Slot 3 may need attention - check tmux session
```

### Result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "critical": 2,
  "warnings": 2,
  "output": "[health report content]"
}
```

## Notification Triggers

| Condition | Topic | Priority |
|-----------|-------|----------|
| Deadline <= 3 days | outgoing | 5 (critical) |
| Deadline <= 7 days | outgoing | 4 (high) |
| Queue stuck > 1h | agents | 4 (high) |
| Task semantically complete (auto-cleared) | outgoing | 3 (default) |

## Delegation Strategy

- **CLI tools**: Date calculations, file parsing
- **Opus**: Judgment on severity, recommendations
