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
   - Record the current *gate-eligible* line count of `journal/events.jsonl`
     so the next gate tick can compare against what this run actually saw.
     Exclude `health_check_skipped` events (emitted by the gate itself) so
     they cannot inflate the anchor:
     ```bash
     EVENTS_FILE="$LUDICS_STATE_PATH/journal/events.jsonl"
     if [ -s "$EVENTS_FILE" ]; then
       EVENTS_LINES=$(grep -vc '"event_type":"health_check_skipped"' "$EVENTS_FILE" 2>/dev/null || echo 0)
     else
       EVENTS_LINES=0
     fi
     EVENTS_LINES=${EVENTS_LINES// /}
     ```
   - Capture this at the *start* of the run, not the end — events this
     check itself emits must not inflate the anchor.
   - The value is persisted in step 10 as `eventsJsonlLines`. Keep the
     `health_check_skipped` exclusion consistent with the gate in
     `src/health-gate.ts` (`GATE_INTERNAL_EVENT_MARKERS`).

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
   - **t3code integration gate** (gh-ludics-539): before emitting any
     t3code-related finding, probe the feature flag:
     ```bash
     T3CODE_INTEGRATION_STATUS=$(ludics t3code integration-status 2>/dev/null || echo enabled)
     ```
     When `T3CODE_INTEGRATION_STATUS` is `paused`, the t3code integration is
     intentionally disabled — **do not** emit `t3code-server-down`, t3code
     discovery-server noise, or `test-health:t3code-ludics` findings as
     warnings or critical issues. You may note the paused state once as
     low-priority Info ("t3code integration paused — surfaces gated").
     All non-t3code checks continue normally.
   - For each active `Mode=t3code` slot, read orchestration state:
     `cat "$LUDICS_STATE_PATH/orchestration/slot-<N>.json" 2>/dev/null`
     - Check each agent's `turnLifecycle.settledNoSignalDetectedAt`
       (renamed from `stallDetectedAt` in task-a670cdbf — the layer
       detects settled-without-signal, not hung).
     - If non-null, report: slot number, agent name, phase, stall age, nudge count
     - Build stable issue key: `slot-stall:<slot>:<agent>`
     - Severity: warning if `settledNoSignalNudgeAttempts < 2`, critical if `>= 2`
   - Hung-agent layer (tmux-only, event-driven; task-a670cdbf): scan
     the post-baseline tail of `journal/events.jsonl` for
     `agent_hung_detected` and `agent_hung_force_settle` records.
     This is the only visibility for genuinely-hung tmux agents
     (spinner-only churn, read loop closed) — the lifecycle field
     `turnLifecycle.hungDetectedAt` is set but tmux slots have no
     `Mode=t3code` JSON to read.

     The baseline anchor is the previous run's persisted
     `eventsJsonlLines` (read from `mag/health-last.json` in step 5);
     `tail -n +<prev+1>` skips lines this run already counted last
     tick. When `health-last.json` is absent or unreadable, treat
     the anchor as `1` (scan whole file).
     ```bash
     PREV_EVENTS_LINES=$(jq -r '.eventsJsonlLines // 0' \
       "$LUDICS_STATE_PATH/mag/health-last.json" 2>/dev/null || echo 0)
     TAIL_FROM=$((PREV_EVENTS_LINES + 1))
     tail -n +"$TAIL_FROM" "$EVENTS_FILE" \
       | grep -F '"event_type":"agent_hung_detected"' || true
     tail -n +"$TAIL_FROM" "$EVENTS_FILE" \
       | grep -F '"event_type":"agent_hung_force_settle"' || true
     ```
     - For each detection, report: slot, agent, phase, stallSeconds,
       diffCharsAccumulated. Optionally cross-reference the
       per-detection JSON file under
       `mag/hung-incidents/<iso>-slot<N>-<agent>.json` for the
       full pane snapshot.
     - Build stable issue key: `slot-hung:<slot>:<agent>`
     - Severity: warning on `agent_hung_detected`, critical on
       `agent_hung_force_settle` (escalation already happened — the
       agent was force-settled).
   - Auto-resume cluster layer (gh-ludics-509; event-driven): scan the
     same post-baseline tail of `journal/events.jsonl` for
     `orchestration_auto_resume_failed` records. Sustained clusters
     for the same slot indicate a wedged auto-resume loop where every
     keepalive tick spawns a runner that immediately exits — the
     symptom of a stale sibling-PID lock. The runner's self-heal
     (gh-ludics-509) closes the original failure mode; this rule
     surfaces *future* regressions of the same shape within minutes
     instead of hours. Threshold: ≥3 events for the same slot within
     the last 30 minutes.
     ```bash
     NOW_EPOCH=$(date +%s)
     WINDOW_START=$((NOW_EPOCH - 1800))   # 30 minutes
     tail -n +"$TAIL_FROM" "$EVENTS_FILE" \
       | grep -F '"event_type":"orchestration_auto_resume_failed"' \
       | jq -c --argjson cutoff "$WINDOW_START" \
           'select(.epoch >= $cutoff) | {slot, ts, message}' \
       | jq -s 'group_by(.slot) | map(select(length >= 3))' || true
     ```
     - For each cluster, report: slot, count of events in the window,
       first/last timestamp, last `message`.
     - Build stable issue key: `auto-resume-stuck:<slot>`
     - Severity: warning (the runner self-heals; the cluster signals
       a pattern worth investigating, not an immediate emergency).

<!-- section:check-queue -->
3. **Check queue health**:
   - Read `mag/queue.jsonl`
   - Flag if requests have been pending > 1h

<!-- section:check-outbound-staging-ff -->
3b. **Check outbound staging-ff sentinel staleness** (gh-ludics-540):
   - For each project in `config.yaml` with `outbound_sync_enabled: true`,
     read the mtime of
     `$LUDICS_STATE_PATH/mag/last-outbound-fast-forward-<project>.epoch`.
   - Compute age in seconds. Classify:
     - missing sentinel OR age >= 72h → **critical**
     - age >= 48h                     → **warning**
     - else                            → no finding
   - Build stable issue key: `outbound-staging-ff-stale:<project>`
     (delta-tracked against `mag/health-last.json` so the same staleness
     counts as `ongoing` after the first detection, not `new`).
   - **Annotate each finding** by iterating opted-in projects and invoking
     the diagnostic subcommand:
     ```bash
     for project in $(yq eval '.projects[] | select(.outbound_sync_enabled == true) | .name' "$LUDICS_STATE_PATH/config.yaml"); do
       annotation=$(ludics mag outbound-cause-remedy "$project" 2>/dev/null || echo '{"kind":"unknown"}')
       kind=$(echo "$annotation" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('kind','unknown'))")
       if [ "$kind" = "auth" ]; then
         cause=$(echo "$annotation" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cause',''))")
         remedy=$(echo "$annotation" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('remedy',''))")
         finding_text="$finding_text — cause: $cause; remedy: $remedy"
       elif [ "$kind" = "no-attempts" ]; then
         remedy=$(echo "$annotation" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('remedy',''))")
         finding_text="$finding_text — $remedy"
       elif [ "$kind" = "blocked-worktree" ]; then
         remedy=$(echo "$annotation" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('remedy',''))")
         finding_text="$finding_text — $remedy"
       fi
     done
     ```
     When `kind` is `unknown`, leave the finding text unchanged.
   - **No notification**: `git push` auth failure does NOT raise a
     `ludics notify outgoing` from the push function or from this
     check. This stable-key entry is the only surfacing path for
     outbound credential gaps; the briefing-lag section also shows the
     annotation alongside `upstream fetch data is ~Nh old`.

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
     `deadline:<task-id>`, `slot-stale:<slot>`, `queue-stuck:<request-id>`,
     `outbound-staging-ff-stale:<project>`)
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
- Test suites: ludics: passing, other-project: passing

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
