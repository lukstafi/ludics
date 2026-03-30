---
name: ludics-health-check
description: Detect approaching deadlines and flag issues requiring attention
queue-action: health-check
---

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
   - For each unclassified session, check if its cwd path matches a configured
     project (compare path components against project repo names from config:
     `yq eval '.projects[].repo' "$LUDICS_STATE_PATH/config.yaml"`)
   - If matched sessions exist with ready tasks and there are empty slots,
     queue session adoption:
     ```bash
     ludics mag adopt-sessions
     ```
     Note in health report: "Queued session adoption for N orphaned sessions matching projects"
     Add stable issue key: `session-orphaned:<cwd-basename>`
   - If matched sessions exist but no empty slots:
     flag as warning: "Active [agent] session on [project] has no slot (all slots occupied)"
   - If unmatched sessions exist:
     flag as info: "Unrecognized session at [cwd] — not matched to any configured project"
   - For each active `Mode=t3code` slot, read orchestration state:
     `cat "$LUDICS_STATE_PATH/orchestration/slot-<N>.json" 2>/dev/null`
     - Check each agent's `turnLifecycle.stallDetectedAt`
     - If non-null, report: slot number, agent name, phase, stall age, nudge count
     - Build stable issue key: `slot-stall:<slot>:<agent>`
     - Severity: warning if nudgeAttempts < 2, critical if >= 2

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

6. **Queue completion verification for potentially done tasks**:
   - Read `slots.md` to find slots with active in-progress tasks
   - For each slotted in-progress task (where `completed` is null):
     a. Quick-check for completion signals (lightweight, no deep codebase inspection):
        - Has the adapter session ended (Runtime section empty, no matching session)?
        - Are there recent commits mentioning the task ID?
        - Has the task been in-progress for longer than its estimated effort?
     b. If any completion signals are present, queue deep verification:
        ```bash
        ludics mag verify-completion <task-id>
        ```
        The `/ludics-verify-completion` skill will do the full semantic inspection,
        clear the slot if done, create follow-up tasks for loose ends, and notify
        the user for uncertain cases.
     c. Note queued verifications in the health report
     d. Build stable issue keys: `completion:<task-id>` for delta tracking

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

## Completion Verification
- Slot 2 (task gh-ludics-42): Session ended, recent commits found. Queued verify-completion.
- Slot 3 (task gh-myapp-15): Active for 5 days (est. medium). Queued verify-completion.

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
| Completion verification queued | (none — notification handled by verify-completion skill) | — |

## Delegation Strategy

- **CLI tools**: Date calculations, file parsing
- **Opus**: Judgment on severity, recommendations
