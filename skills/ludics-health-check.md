---
name: ludics-health-check
description: Detect approaching deadlines and flag issues requiring attention
queue-action: health-check
---

# /ludics-health-check - System Health Check

Detect approaching deadlines, check for semantically complete tasks, and flag
other issues requiring attention.

<!-- section:trigger -->
## Trigger

This skill is invoked when:
- The user runs `ludics mag health-check`
- Periodic automation (every 4h via launchd)

<!-- section:inputs -->
## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

<!-- section:process -->
## Process

<!-- section:capture-events-baseline -->
0. **Capture events baseline** (run before step 1):
   - Record the current line count of `journal/events.jsonl` so the next
     gate tick can compare against what this run actually saw:
     ```bash
     EVENTS_LINES=$(wc -l < "$LUDICS_STATE_PATH/journal/events.jsonl" 2>/dev/null || echo 0)
     EVENTS_LINES=${EVENTS_LINES// /}
     ```
   - Capture this at the *start* of the run, not the end — events this
     check itself emits must not inflate the anchor.
   - The value is persisted in step 10 as `eventsJsonlLines`.

<!-- section:check-deadlines -->
1. **Check approaching deadlines**:
   - Find tasks with `deadline` field
   - Calculate days remaining
   - Flag if <= 7 days (warning) or <= 3 days (critical)

<!-- section:check-slots -->
2. **Check slot health**:
   - Run `ludics slots status` to get current slot state
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

<!-- section:check-queue -->
3. **Check queue health**:
   - Read `mag/queue.jsonl`
   - Flag if requests have been pending > 1h

<!-- section:check-tests -->
4. **Check test suite health**:
   - Read `$LUDICS_STATE_PATH/mag/test-health.json` for the latest test run
     results (the pre-hook ran the tests before this skill was invoked).
   - For each project with an entry:
     - `passed: true` — note as "tests passing" in the Info section.
     - `passed: false` — Warning: `⚠ <project> tests FAILED — fix task
       auto-filed`, with a truncated `failures` excerpt.
   - Projects without an entry are silently omitted. If a project has
     `test_command` configured explicitly but no entry, mention it as
     low-priority Info "awaiting first test run".
   - Issue key format: `test-health:<project-name>` (for delta tracking
     against `health-last.json` — unchanged failures count as "ongoing",
     not "new").
   - Don't run tests yourself — the programmatic pre-hook already did.

<!-- section:detect-deltas -->
5. **Detect deltas since previous health check**:
   - Prefer git diff in state repo for scope awareness:
     `git -C "$LUDICS_STATE_PATH" diff --name-only HEAD~1..HEAD -- tasks/ sessions.md mag/queue.jsonl journal/notifications.jsonl 2>/dev/null || true`
   - Build stable issue keys for all findings (examples:
     `deadline:<task-id>`, `slot-stale:<slot>`, `queue-stuck:<request-id>`)
   - Read previous snapshot from `$LUDICS_STATE_PATH/mag/health-last.json` if it exists
   - Mark each finding as `new`, `ongoing`, or `resolved`

<!-- section:report-elaboration -->
6. **Report task elaboration status**:
   - Run `ludics tasks needs-elaboration` to count unprocessed tasks
   - Note: Elaboration queueing is handled automatically by `tasks_queue_elaborations()` in `tasks_sync()` -- no need to enqueue here

<!-- section:queue-verification -->
7. **Queue completion verification for potentially done tasks**:
   - Run `ludics slots status` to find slots with active in-progress tasks
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

<!-- section:generate-report -->
8. **Generate report**:
   - Categorize issues by severity
   - Explicitly call out `new` and `resolved` findings since last check
   - Include actionable recommendations

<!-- section:send-notifications -->
9. **Send notifications** for critical issues:
   - Notify only on `new` critical issues or severity escalation (`warning` -> `critical`)
   ```bash
   ludics notify outgoing "Critical: task-042 deadline in 2 days" 5 "Health Check"
   ```

<!-- section:persist-snapshot -->
10. **Persist snapshot**:
   - Write current finding keys/severities/timestamp to
     `$LUDICS_STATE_PATH/mag/health-last.json`
   - Also write `eventsJsonlLines` with the `$EVENTS_LINES` value captured
     at step 0. This is the gate anchor the next tick reads — skipping it
     or writing the end-of-run count would break activity-volume gating.
     Example payload:
     ```json
     {
       "timestamp": "2026-04-24T12:00:00Z",
       "eventsJsonlLines": 12345,
       "findings": [ ... ]
     }
     ```

<!-- section:output-format -->
## Output Format

<!-- section:health-report-output -->
### Health Report

```markdown
# Health Check - YYYY-MM-DD HH:MM

## Critical Issues
- **DEADLINE**: task-042 "POPL submission" due in 2 days

## Warnings
- **DEADLINE**: task-101 due in 6 days
- **SLOT**: Slot 3 has been active for 28 hours without update
- **TEST-HEALTH**: ⚠ my-project tests FAILED — fix task auto-filed

## Info
- Active slots: 2/6
- Ready tasks: 8
- Blocked tasks: 3
- Queue pending: 0
- Tasks needing elaboration: 5
- Test suites: ludics passing, other-project passing

## Elaboration Status
- 2 tasks awaiting elaboration (queued automatically by mag keepalive)

## Completion Verification
- Slot 2 (task gh-ludics-42): Session ended, recent commits found. Queued verify-completion.
- Slot 3 (task gh-myapp-15): Active for 5 days (est. medium). Queued verify-completion.

## Recommendations
1. Prioritize task-042 - deadline is imminent
2. Slot 3 may need attention - check tmux session
```

<!-- section:result-json-output -->
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

<!-- section:notification-triggers -->
## Notification Triggers

| Condition | Topic | Priority |
|-----------|-------|----------|
| Deadline <= 3 days | outgoing | 5 (critical) |
| Deadline <= 7 days | outgoing | 4 (high) |
| Queue stuck > 1h | agents | 4 (high) |
| Completion verification queued | (none — notification handled by verify-completion skill) | — |

<!-- section:delegation-strategy -->
## Delegation Strategy

- CLI tools for date calculations and file parsing.
- Opus for judgment on severity and recommendations.
