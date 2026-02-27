# /ludics-verify-completion - Verify Task Completion & Create Follow-ups

Deep-inspect whether a slotted in-progress task is actually complete, clear the
slot if so, and split off follow-up tasks for any loose ends.

## Trigger

This skill is invoked when:
- The health check detects a potentially complete task and queues
  `ludics mag verify-completion <task-id>`
- The user runs `ludics mag verify-completion <task-id>` manually

## Arguments

- `<task_id>`: Task identifier (e.g., `task-042`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- `$LUDICS_RESULTS_DIR`: Directory for writing result JSON (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

## Process

1. **Read task file**:
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
   ```
   Extract: title, project, acceptance criteria, proposal path, slot number.

2. **Resolve project path**:
   - Same logic as `/ludics-draft-proposal`: look up the task's `project` field
     in `$LUDICS_STATE_PATH/config.yaml`, resolve to local checkout path
     (typically `~/<repo-name>`).

3. **Read proposal** (if available):
   - If the task has a `proposal:` field, read the full proposal document from
     `<project-path>/<proposal-value>`
   - Extract the Proposed Change and Scope sections for verification targets

4. **Inspect codebase for completion evidence**:
   - Check git log in the project directory for recent commits mentioning the
     task ID or proposal name:
     ```bash
     git -C <project-path> log --oneline --since="2 weeks ago" --grep="<task-id>" 2>/dev/null || true
     git -C <project-path> log --oneline --since="2 weeks ago" --grep="<proposal-name>" 2>/dev/null || true
     ```
   - Read relevant source files referenced in the proposal's Proposed Change
     section to verify the described changes exist
   - Check if acceptance criteria checkboxes are marked complete (`- [x]`)
   - Look for test files, documentation, or other artifacts mentioned in
     acceptance criteria
   - Search for TODO/FIXME comments in recently changed files:
     ```bash
     git -C <project-path> diff HEAD~10..HEAD --name-only 2>/dev/null | head -30
     ```
     Then grep those files for `TODO`, `FIXME`, `HACK`, `XXX`

5. **Make completion judgment**:

   ### Case A: Complete (high confidence)
   All acceptance criteria appear met, no critical loose ends.
   - Clear the slot:
     ```bash
     ludics slot <N> clear done
     ```
   - Send notification:
     ```bash
     ludics notify outgoing "Completed: <task-id> (<title>)" 3 "Task Complete"
     ```

   ### Case B: Complete with loose ends
   Core acceptance criteria met, but there are deferred items, TODO comments,
   or minor unchecked criteria that represent follow-up work.
   - Clear the slot:
     ```bash
     ludics slot <N> clear done
     ```
   - Create follow-up tasks for each distinct loose end:
     ```bash
     ludics tasks create "<follow-up title>" <project> <priority>
     ```
     Use the parent task's project. Typically B or C priority unless the loose
     end is a bug or regression.
   - Send notification listing what was completed and what follow-ups were created:
     ```bash
     ludics notify outgoing "<summary>" 3 "Task Complete + Follow-ups"
     ```

   ### Case C: Uncertain
   Some criteria appear met but others are unclear or cannot be verified from
   the codebase alone.
   - Do NOT clear the slot
   - Send notification with specific questions about the uncertain criteria:
     ```bash
     ludics notify outgoing "<questions>" 3 "Completion check — <task-id>"
     ```
     Format as numbered questions so the user can respond from their phone.

   ### Case D: Not complete
   Significant acceptance criteria are clearly unmet.
   - Do NOT clear the slot
   - Note findings in the result JSON but do not notify (health check already
     flagged this slot as active — no need for noise)

6. **Write result JSON**:
   ```json
   {
     "id": "req-...",
     "status": "completed",
     "timestamp": "...",
     "task_id": "<task-id>",
     "verdict": "complete | complete-with-followups | uncertain | incomplete",
     "followup_tasks": ["task-NNN", "..."],
     "output": "Verified <task-id>: <verdict summary>"
   }
   ```

## Delegation Strategy

- **Task tool**: Explore the project codebase (read source files, check tests) in parallel
- **CLI tools**: Git log, slot clear, task create, notify
- **Opus**: Semantic judgment on whether acceptance criteria are met, formulating follow-up task descriptions

## Error Handling

- Task not found: Write result with `"status": "error"`
- Task not in any slot: Write result with `"verdict": "not-slotted"`, skip slot operations
- Project path not found: Attempt verification from task file and git history only, note limitation
- No acceptance criteria: Flag as uncertain — cannot verify without criteria
