# /ludics-draft-proposal - Draft Proposal & Notify

Write a concise proposal document (Why/What, not How) for a task assigned to a slot,
then send a notification with action buttons so the user can launch or manage the session
from their phone.

## Trigger

This skill is invoked when:
- The user runs `ludics mag draft-proposal <task-id>`
- Auto-queued during keepalive for tasks assigned to slots that are missing proposals
  (when `start_sessions` autonomy is not `manual`)

## Arguments

- `<task_id>`: Task identifier (e.g., `task-042`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

## Process

1. **Read task file**:
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/<task_id>.md"
   ```
   Extract: title, project, dependencies, context, any linked GitHub issue.

2. **Resolve project path**:
   - The task's `project` field names a project from the `projects` list in the
     ludics config (located at
     `$LUDICS_STATE_PATH/config.yaml`). Each project entry has a `repo` field
     (e.g., `lukstafi/ocannl`); the local checkout is typically `~/<repo-name>`.
   - The `personal` project refers to the state repository itself.

3. **Explore project codebase**:
   - Read relevant source files mentioned in the task elaboration
   - Understand existing patterns, architecture, related code
   - Check for existing docs, README, ARCHITECTURE files

4. **Surface task-statement ambiguities**:
   - Cross-check the task description and elaboration against the codebase and other sources of user clarifications. Watch out for staleness, unjustified assumptions, missing context.
   - If issues are found, note them prominently in the proposal's Motivation or
     Current State section so the user sees them before launching an agent.
   - If the task is clearly stale (the work is already done or the goal no longer
     applies), skip the proposal. Write result JSON with `"status": "stale"` and
     a short explanation, then stop.

5. **Bail out if multi-concern**:
   - If the task covers multiple independent concerns (different modules, separable
     features, could be merged to main independently), do NOT write a proposal.
   - Instead, queue the split skill and stop:
     ```bash
     ludics mag split-task <task_id>
     ```
   - Report the bail-out in the result JSON with `"status": "split-needed"`.
   - The split skill will create subtasks, queue elaboration for each, and they
     will eventually get their own proposals when assigned to slots.

6. **Determine docs directory**:
   - Check if `docs/`, `doc/`, or project root has existing documentation
   - Use `docs/` by default; create if needed

7. **Write proposal** to `<project-root>/docs/<feature-name>.md`:

   ```markdown
   # <Title>

   ## Motivation
   Why this change is needed. Link to issue if applicable.

   ## Current State
   How things work now. Key files and code pointers.

   ## Proposed Change
   What should change. Acceptance criteria. Edge cases to consider.

   ## Scope
   What's in/out of scope. Dependencies on other tasks.
   ```

   **Key:** No implementation plan, no effort estimates, no micro-managed steps.
   The Why/What focus. Coding agents handle the How via their own plan/clarify phases.

8. **Commit and push**:
   ```bash
   cd <project-root>
   git add docs/<feature>.md
   git commit -m "proposal: <title>"
   git push
   ```

9. **Update task frontmatter**: Set `proposal: docs/<feature>.md` in the task file.
   Use the `addFrontmatterField` pattern — add before closing `---`.

10. **Send notification with action buttons**:
   ```bash
   ludics notify proposal "<task-id>" "<title>" "<one-line summary>" "<project-root>/docs/<feature>.md"
   ```
   This sends the proposal file as an attachment and includes action buttons
   (agent-duo, pair-claude, pair-codex) that POST to the incoming
   topic. The user taps a button on their phone, the message arrives via the
   incoming subscriber as a direct queue injection, and Mag interprets it as
   a user turn to execute the launch.

11. **Send questions notification** (if ambiguities were found in step 4):
    - If the proposal's Motivation or Current State sections note ambiguities,
      extract them as concise numbered questions
    - Send via:
      ```bash
      ludics notify outgoing "<questions text>"
      ```
      Use title: "Proposal questions — <task-id>: <title>"
    - Skip if no ambiguities were found

12. **Best-effort desktop**: Try `code <path>` to open the proposal in VS Code.
    Fail silently if unavailable.

13. **Write result JSON**:
    ```json
    {
      "id": "req-...",
      "status": "completed",
      "timestamp": "...",
      "task_id": "<task-id>",
      "proposal_path": "docs/<feature>.md",
      "output": "Proposal written for <task-id>: <title>"
    }
    ```

## Output Format

The proposal document follows the template in step 7. Keep it concise — typically 1-2 pages.
The goal is to give the user enough context to decide whether to launch an agent session,
and which adapter to use.

## Delegation Strategy

- **CLI tools**: File navigation, code search, git operations
- **Opus**: Write the proposal with judgment about scope, motivation, current state
- **Task tool**: Explore the project codebase in parallel if needed

## Error Handling

- Task not found: Write result with status "error"
- Project path not found: Note in result, write proposal to state repo instead
- Already has proposal: Check if re-generation is wanted, or skip
- Git push fails: Log warning, continue (proposal is still written locally)
