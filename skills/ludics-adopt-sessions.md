---
name: ludics-adopt-sessions
description: Match discovered agent sessions to projects and assign to available slots
queue-action: adopt-sessions
---

# /ludics-adopt-sessions - Adopt Unclassified Sessions

Match discovered agent sessions to projects and assign them to available slots.

## Trigger

This skill is invoked when:
- Periodic trigger runs `ludics mag adopt-sessions` (every 5 min via launchd/systemd)
- Health-check detects orphaned sessions and queues this action

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Pre-computed context**: `$LUDICS_STATE_PATH/mag/adopt-sessions-context.md`
- **Request ID**: Read from `$LUDICS_STATE_PATH/mag/current-request-id`

## Process

1. **Read context**:
   ```bash
   cat "$LUDICS_STATE_PATH/mag/adopt-sessions-context.md"
   ```
   If the context says "(stale or missing session data)" or "(no unclassified sessions)",
   write a no-op result and exit.

2. **Read current slots** for confirmation:
   ```bash
   ludics slots
   ```

3. **For each matched, non-stale session** (from `## Session-Project Matches`):

   Adapter selection — use the `**Recommended adapter:**` from the context.
   Pre-computation picks a safe adapter based on what metadata exists in the
   worktree:
   - Orchestration detected (`.peer-sync/`) → the orchestration type
     (agent-duo, agent-pair-*, etc.).
   - `.agent-sessions/` present → `agent-claude` or `agent-codex` (matching
     the agent type).
   - Neither → `manual` (safe default — tracks the slot without requiring
     orchestration infrastructure that isn't there).

   Session identifier for the `-s` flag — use the tmux session name (from
   `**tmux session:**` in context) when available, otherwise the first
   session ID from `**Session IDs:**`.

   ### Case A: Project already has a slot
   The session belongs to a project that's already in a slot — this isn't a
   no-op; associate the session with that slot so tracking stays accurate:

   - If the session cwd matches the slot's path, update the slot's session
     reference when it's missing or different:
     ```bash
     ludics slot N assign <current-task-or-desc> -a <current-adapter> -s <session-id> -p <session-cwd>
     ```
     Re-assigning preserves the existing task and adapter while updating the
     session field.

   - If the session cwd differs from the slot's path (e.g., a worktree for a
     different branch or feature), it's likely parallel work. If an empty
     slot exists and the work looks distinct (different git branch, different
     orchestration feature), consider assigning a second slot — use judgment.

   - Note the association in the report either way.

   ### Case B: Project has ready tasks, no slot
   Pick an empty slot and assign the best ready task (listed in the context,
   sorted by elaboration status then priority):
   ```bash
   ludics slot N assign <task-id> -a <adapter> -s <session-id> -p <session-cwd>
   ```

   ### Case C: Project matched, no ready tasks
   The session is actively working on something but there's no ready task for it.
   Use available metadata to decide:

   - If the session has a **git branch** or **summary** that describes the work,
     create a task capturing that work:
     ```bash
     ludics tasks create "<inferred title from branch/summary>" <project> B
     ```
     Then assign the new task to the slot:
     ```bash
     ludics slot N assign <new-task-id> -a <adapter> -s <session-id> -p <session-cwd>
     ```

   - If metadata is insufficient to infer a task title, reserve an empty slot
     with a descriptive label:
     ```bash
     ludics slot N assign "<project> development" -a <adapter> -s <session-id> -p <session-cwd>
     ```

   ### Case D: No empty slots
   Note the orphaned session in the report. Preemption is a judgment call —
   consider:
   - Priority of the orphaned session's ready tasks vs. the lowest-priority
     occupied slot.
   - Whether any occupied slot has stale or inactive work.
   - Whether the orphaned session looks like important active work (recent
     activity, meaningful git branch or summary).

   If preemption seems justified:
   ```bash
   ludics slot N preempt <task-id> -a <adapter> -s <session-id> -p <session-cwd>
   ```

4. **Handle unmatched sessions**:
   Note them in the report. These may be scratch/experimental sessions or projects
   the user hasn't added to config yet. Do not attempt to assign them.

5. **Autonomy check**:
   ```bash
   yq eval '.mag.autonomy_level.assign_to_slots' "$LUDICS_STATE_PATH/config.yaml"
   ```
   - **auto**: Execute the `ludics slot` commands directly
   - **suggest**: Include ready-to-run commands in the report
   - **manual**: Include observations and recommendations only

6. **Queue draft-proposal** for each newly assigned task (so user gets launch buttons):
   ```bash
   ludics mag draft-proposal <task-id>
   ```
   Skip this for sessions assigned without a task (Case C).

7. **Write result JSON**:
   ```bash
   REQ_ID=$(cat "$LUDICS_STATE_PATH/mag/current-request-id" 2>/dev/null || echo "req-unknown")
   ```
   Write to `$LUDICS_RESULTS_DIR/$REQ_ID.json`:
   ```json
   {
     "id": "<REQ_ID>",
     "status": "completed",
     "timestamp": "<ISO-8601>",
     "adopted": 2,
     "skipped": 1,
     "output": "Adopted 2 sessions: ..."
   }
   ```

8. **Commit state**:
   ```bash
   ludics sync
   ```

## Output Format

Brief report:
```
Adopted 2 sessions:
- Slot 2: claude-code on ocannl → task-101 "Implement tensor concatenation" (agent-claude)
- Slot 5: codex on ludics → ludics development (agent-codex)
Skipped: 1 stale, 1 unmatched (scratch), 1 project already in slot 3
```

## Delegation Strategy

- Pre-computed data lives in `adopt-sessions-context.md` — no discovery or
  heavy computation here.
- CLI tools for slot operations (`ludics slot N assign`, `ludics slot N preempt`).
- Direct judgment for prioritization, preemption trade-offs, and ambiguous cases.
- Execute commands directly; don't spawn sub-agents.

## Error Handling

- Context file missing: Write result with `"status": "error"`, message: "No context file"
- Slot assignment fails: Log the error, continue with other sessions
- All slots occupied and no preemption warranted: Report only, no action
