# /ludics-launch-session - Launch Agent Session for Task

Find the slot of or for a task (or an empty slot as fallback), assign the chosen adapter,
and start the session. Triggered when the user taps an action button on a proposal
notification.

## Trigger

This skill is invoked when:
- A button tap message like `"Launch agent-duo for task-042 in project ..."` arrives
  via the incoming ntfy subscriber
- The queue-pop handler detects the launch pattern and routes here

## Arguments

- `$1` — Task ID (e.g., `task-042`, `gh-myrepo-42`)
- `$2` — Adapter name (e.g., `agent-duo`, `agent-pair-codex`, `agent-pair-claude`)
- `$3+` — Optional adapter start args (pass through to `slot assign -A`, e.g. `--followup --followup-msg ...`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from `$LUDICS_STATE_PATH/mag/current-request-id`

## Process

1. **Read current slot state**:
   ```bash
   ludics slots
   ```
   Also read the slots file directly to get full block details:
   ```bash
   cat "$LUDICS_STATE_PATH/slots.md"
   ```

2. **Find the task's slot** (primary path — most proposals come from already-slotted tasks):
   - Scan each slot block for `**Task:** <task_id>`
   - If found, note the slot number N, current adapter (`**Mode:**`), and path (`**Path:**`)

3. **Decide action based on slot state**:

   ### Case A: Task is in slot N with the **same** adapter
   If adapter args were provided, re-assign with the same adapter to update args first.
   Otherwise just start:
   ```bash
   ludics slot N start
   ```

   ### Case B: Task is in slot N with a **different** adapter
   Re-assign with the user's chosen adapter, preserving the path. If adapter args are
   present, include `-A "<adapter_args>"`:
   ```bash
   ludics slot N assign <task_id> -a <adapter> -p <existing-path> [-A "<adapter_args>"]
   ludics slot N start
   ```

   ### Case C: Task not in any slot (fallback)
   Find an empty slot — look for `**Process:** (empty)`. If adapter args are present,
   include `-A "<adapter_args>"`:
   ```bash
   ludics slot N assign <task_id> -a <adapter> [-A "<adapter_args>"]
   ludics slot N start
   ```
   If the task file has a `project` field, resolve the project path from
   `~/.config/ludics/config.yaml` and pass it with `-p <path>`.

   ### Case D: Task not slotted and no empty slots
   Do not force a preemption. Notify the user:
   ```bash
   ludics notify outgoing "Cannot launch <task_id>: all slots occupied. Run: ludics slot N preempt <task_id> -a <adapter>"
   ```

4. **Verify launch** (best-effort):
   ```bash
   ludics slot N show
   ```
   Check that the Runtime section shows activity or the adapter responded.

5. **Write result JSON**:
   ```bash
   REQ_ID=$(cat "$LUDICS_STATE_PATH/mag/current-request-id" 2>/dev/null || echo "req-unknown")
   ```
   Write to `$LUDICS_RESULTS_DIR/$REQ_ID.json`:
   ```json
   {
     "id": "<REQ_ID>",
     "status": "completed",
     "timestamp": "<ISO-8601>",
     "task_id": "<task_id>",
     "adapter": "<adapter>",
     "slot": N,
     "action": "started | reassigned+started | assigned+started | no-slot",
     "output": "Launched <adapter> for <task_id> in slot N"
   }
   ```

## Output Format

Brief confirmation message summarizing what was done:
```
Launched agent-duo for task-042 in slot 3.
```
Or if no slot available:
```
All slots occupied. Sent notification to user with preemption instructions.
```

## Delegation Strategy

- **CLI tools only**: This skill is purely mechanical — slot lookup, assign, start
- **No exploration needed**: All information comes from slots.md and task frontmatter
- Execute commands directly, do not use sub-agents

## Error Handling

- Task file not found: Write result with `"status": "error"`, notify user
- Task metadata incomplete (`proposal:` missing/null or proposal file missing):
  fail launch and notify user. Do **not** continue with fallback behavior,
  because that can bind the session to the wrong spec.
- `ludics slot N start` fails: Capture stderr, include in result, notify user
- Adapter not recognized: Fall back to `agent-duo`, note in result
- Task already has an active session (Runtime shows activity): Skip start, report as already running
