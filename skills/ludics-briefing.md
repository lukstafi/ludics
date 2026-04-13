---
name: ludics-briefing
description: Generate a comprehensive strategic briefing
queue-action: briefing
---

# /ludics-briefing - Strategic Morning Briefing

Generate a comprehensive strategic briefing for the user.

## Trigger

This skill is invoked by the ludics automation when:
- The user runs `ludics briefing` or `ludics mag briefing`
- A morning trigger fires (e.g., 08:00 via launchd)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- `$LUDICS_RESULTS_DIR`: Directory for writing result JSON (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

## Pre-computed Context

All data gathering (slots refresh, session discovery, flow computations, recent incoming,
journal, same-day check) has been done by bash before this skill runs.

Read the context file:
```
cat $LUDICS_STATE_PATH/mag/briefing-context.md
```

If the file is missing, run `ludics mag context` to generate it.
If that also fails, escalate to the user.

The context file contains these sections:
- **Same-Day Status**: `new` (full briefing) or `amend` (light-touch update)
- **Recent Incoming**: Recent incoming notifications (from notifications.jsonl)
- **Slots State**: Current slot assignments after adapter refresh
- **Sessions Report**: All discovered agent sessions with classification
- **Session-Project Matches**: Pre-computed matching of unclassified sessions to projects, with ready tasks per project and slot availability
- **Active Unconcluded Agent-Duo Slots**: Case-A slots precomputed from `sessions.json` + task completion state
- **Flow: Ready Queue**: Priority-sorted ready tasks
- **Flow: Critical Items**: Deadlines, high-priority ready
- **Tasks Needing Elaboration**: Task IDs that lack elaboration
- **Recent Journal**: Last 20 journal entries

Also read `$LUDICS_STATE_PATH/tasks/*.md` for full task details.

## Process

1. **Read context**: Read `$LUDICS_STATE_PATH/mag/briefing-context.md`

2. **Check same-day status**: Look at the `## Same-Day Status` section.
   - If `Status: amend`: do a light-touch update only:
     - Compute what actually changed since the last briefing before writing:
       - Prefer git diff in state repo:
         `git -C "$LUDICS_STATE_PATH" diff --name-only HEAD~1..HEAD -- tasks/ sessions.md mag/queue.jsonl journal/notifications.jsonl 2>/dev/null || true`
       - If git diff is unavailable/noisy, fall back to context deltas:
         compare `briefing-context.md` sections against existing `briefing.md`
     - Update only sections touched by those deltas
     - Update affected sections of `$LUDICS_STATE_PATH/briefing.md` only
     - Run a lightweight slot reassignment (only newly-empty slots
       or newly-ready high-priority tasks)
     - Do not re-elaborate tasks or redo the full analysis
     - Still run step 7 (Nudge stalled slotted tasks)
     - Then skip to step 9 (Write result)
   - If `Status: new`: proceed with the full process below

3. **Elaborate unprocessed tasks**:
   - Check the `## Tasks Needing Elaboration` section
   - For tasks that appear in the ready queue or are high-priority:
     - Use the Task tool to invoke `/ludics-elaborate <task-id>` (parallel)

4. **Scan for needs-confirmation tasks**:
   - Check task files for `status: needs-confirmation`
   - For each, note the task ID, title, priority, and `relates_to` source task
   - These will be included in a dedicated "Needs Confirmation" section

5. **Analyze, merge, and split work**:
   - Identify high-priority ready tasks, approaching deadlines (7 days),
     slot utilization
   - Factor in recent incoming messages as high-priority context
   - Check for duplicate/overlapping tasks: merge any confirmed duplicates with `ludics tasks merge <target> <source...>`
     - `ludics tasks duplicates` can help but it only checks exact title match
   - Check whether tasks or projects should be split into finer-grained units:
     - Multiple git worktrees under the same repo → separate sub-projects
       (exception: worktrees from the same agent-duo feature are one unit)
     - Large tasks with independent acceptance criteria → sub-tasks
   - Mechanical outcomes:
     - Sub-projects: `ludics slot N assign "<project>" -a <adapter> -p <path>`
     - Sub-tasks: `ludics tasks create "<title>" <project> <priority>` or
       `/ludics-elaborate <task-id>` to break into children

6. **(Re)Assign slots**:

   Slot states: **Empty** (available), **Project-reserved** (path+mode, no task),
   **Task-assigned** (active work).

   **Check queue hold state first:**
   - Run: `test -f "$LUDICS_STATE_PATH/mag/queue-hold" && echo held || echo running`
   - If **held**: skip auto-assignment of empty slots (respect user's hold). You may
     still clear completed/abandoned slots and note the hold in the briefing.
     Include: "Queue held — auto-assignment suppressed. Use `ludics slot N assign …` to assign manually."
   - If **running**: proceed with normal slot assignment below.

   **Identify opportunities:**
   - Empty slots (candidates for filling)
   - Completed slots (candidates for clearing)
   - Cross-reference with ready queue and unclassified sessions
   - Check `## Session-Project Matches` section for pre-computed session-to-project
     matching with ready tasks per project

   **Build assignment plan:**
   - For empty slots: pick highest-priority ready task, prefer context affinity
   - If an unclassified session is running on a project path, reserve the slot
     (use `**Recommended adapter:**` from the Session-Project Matches section —
     it checks for `.peer-sync/` and `.agent-sessions/` to pick a safe adapter)
   - When all slots occupied: weigh eviction cost vs. new task priority
   - Commands:
     - Project reservation: `ludics slot N assign "<project> development" -a <adapter> -p <path>`
     - Task assignment: `ludics slot N assign <task-id> -a <adapter> -p <path>`

   **Execute or suggest (autonomy-dependent):**
   - Check: `yq eval '.mag.autonomy_level.assign_to_slots' "$LUDICS_STATE_PATH/config.yaml"`
   - **auto**: execute via Bash (`ludics slot N clear ready`, `ludics slot N assign ...`)
   - **suggest**: include ready-to-run commands in the briefing
   - **manual**: include observations only

7. **Nudge stalled slotted tasks**:
   - Read the `## Active Unconcluded Agent-Duo Slots` section first.
     - Treat listed slots as **Case A** (active, unconcluded): do **not** re-send
       launch buttons for those slots.
   - For each slot that has a task assigned with a proposal (`proposal:` field in
     the task file) but no active session (no matching entry in the Sessions Report,
     or Runtime section is empty):
     - Re-read the task file to get title and proposal path
     - Re-send the proposal notification:
       ```bash
       ludics notify proposal "<task-id>" "<title>" "<one-line summary>" "<proposal-path>"
       ```
     - Note the nudge in the briefing under Slot Assignments (e.g.,
       "Slot 3: re-sent launch buttons for task-101 (no active session)")
   - Skip tasks whose slot was just assigned in step 6 (fresh assignments will
     get their own proposal via the normal draft-proposal flow)
   - Skip if `start_sessions` autonomy is `manual`

8. **Surface ambiguities**:
   - Review the full briefing for information gaps that would change your next
     autonomous actions (conflicting priorities, unclear task scope, suspiciously elaborated tasks,
     dependency tangles, missing context from the user)
   - Formulate 1-5 specific questions (see Questions Guidelines in the output format)
   - If no genuine ambiguities exist, note "No blocking ambiguities."

9. **Write result**:
   - Write briefing to `$LUDICS_STATE_PATH/briefing.md`
   - Read request ID: `REQ_ID=$(cat "$LUDICS_STATE_PATH/mag/current-request-id")`
   - Write result JSON to `$LUDICS_RESULTS_DIR/$REQ_ID.json`

10. **Send questions notification**:
   - Extract the `## Questions` section from the briefing you just wrote
   - If there are questions (not just "No blocking ambiguities"), send them:
     ```bash
     ludics notify outgoing "<questions text>"
     ```
     Use the briefing date as the title, e.g., "Briefing questions — 2026-02-27"
   - Keep the message concise: just the numbered questions, no preamble

11. **Commit and push state**:
    - Run `ludics sync` to commit and push to remote

## Output Format

### briefing.md

```markdown
# Briefing - YYYY-MM-DD

## Current State
- Slot 1: [task] (agent-duo, phase)
- Slot 2: empty
- ...

## Slot Assignments
- Slot 2: <- task-101 "Implement tensor concatenation" (A-priority, unblocks 2 tasks)
- Slot 4: <- ocannl project (unclassified claude-code session on ~/repos/ocannl/)
- Slot 5: cleared task-089 <- task-067 "Update CHANGES.md" (release blocker)
- [If autonomy=suggest, include ready-to-run commands:]
  `ludics slot 2 assign task-101 -a agent-duo -p ~/repos/ocannl`

## Ready to Start (Priority Order)
1. **task-101** (A): [title] - [reason this is high priority]
2. **task-067** (A): [title]
3. **task-128** (B): [title]

## Needs Confirmation
- **task-abc123** (C): "Refactor tensor allocation path" -- from task-xyz789 retrospective
- **task-def456** (C): "Add missing edge-case tests for parser" -- from task-xyz789 retrospective

_(Confirm or dismiss these in the dashboard)_

[Omit this section if no needs-confirmation tasks exist]

## Urgent Attention
- **Deadline**: task-042 due in 3 days (POPL submission)
## Today's Suggestion
Start with task-101 because [reasoning]. If blocked, switch to task-067.

Current context focus: [einsum/ocannl] - switching to [other] would incur context cost.

## Notes
- [Any other strategic observations]

## Questions
1. [Question about a real ambiguity that blocks autonomous decision-making]
2. [...]
```

### Questions Guidelines

End every briefing with 1-5 questions. Questions should surface information
that you **cannot resolve yourself** by reading code, task files, or other
available resources. If you can answer a question by researching, do the
research instead of asking.

**Avoid asking for confirmation to proceed.** Starting jobs that look like a good
idea is the right default — worst case the user discards the results.

When the answers arrive, update relevant files or perform relevant actions so the answers become discoverable.

### Result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "2026-02-01T08:00:00Z",
  "output": "[briefing content]"
}
```

## Delegation Strategy

- **Pre-computed data** in `briefing-context.md` (no CLI commands needed for data gathering)
- **Git diff** (`tasks/`, `sessions.md`, queue/notifications) for precise amend-mode change detection
- **Task tool** to invoke `/ludics-elaborate` for unprocessed tasks (parallel)
- **CLI tools** for slot operations (`ludics slot N assign`, `ludics slot N clear`) and nudge notifications (`ludics notify proposal`)
- **Direct analysis** for strategic reasoning, slot assignment trade-offs, suggestions

## Error Handling

If state files are missing or malformed:
- Write partial briefing with warnings
- Include "run ludics tasks sync" suggestion
- Still write result JSON with status "partial"
