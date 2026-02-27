# /ludics-read-inbox - Process Inbox Messages

Read and act on asynchronous messages from the user.

## Trigger

This skill is invoked when:
- A `message` action is queued (user ran `ludics mag message "..."` or a message arrived via ntfy subscription)
- No other skill was already queued to handle the inbox

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- `$LUDICS_RESULTS_DIR`: Directory for writing result JSON (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

## Process

1. **Read inbox**: Run `ludics mag inbox --consume` to consume pending messages.
   The command prints messages, archives them to `mag/past-messages.md`, and clears the inbox.

2. **Act on messages**: For each message, determine the appropriate action:
   - **Information updates** (deadline changes, priority shifts): Update the relevant task files or context
   - **Requests** (elaborate task): Queue the appropriate action or handle inline
   - **Context notes** (reminders, preferences): Note in `mag/context.md` if persistent
   - **Ambiguous messages**: Journal the message and note it for the next briefing

3. **Journal**: Record consumed messages and actions taken:
   ```bash
   ludics journal  # Append to today's journal
   ```

4. **Write result**:
   - Read request ID: `REQ_ID=$(cat "$LUDICS_STATE_PATH/mag/current-request-id")`
   - Write result JSON to `$LUDICS_RESULTS_DIR/$REQ_ID.json`

## Output Format

### Result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "messages_processed": N,
  "actions_taken": ["updated task-042 deadline", "noted priority change"]
}
```

## Delegation Strategy

- **CLI tools**: `ludics mag inbox --consume` for message consumption
- **Opus**: Interpret messages, decide actions, update files
