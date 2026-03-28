---
name: ludics-split-task
description: Split a multi-concern task into independent subtasks
queue-action: split-task
queue-args: [task]
---

# /ludics-split-task - Split Multi-Concern Task

Split a task that covers multiple independent concerns into subtasks.

## Trigger

This skill is invoked when:
- The `/ludics-draft-proposal` skill determines a task is too broad for a single agent session
- The user runs `ludics mag split-task <task-id>`

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
   Understand the full scope: title, project, priority, elaboration, code pointers.

2. **Identify independent concerns**:
   - Each concern should be completable by a single agent session
   - Concerns are independent if they touch different files/modules or can be
     merged to main separately
   - Examples of splits:
     - "Refactor auth + add logging" → two tasks
     - "Implement API endpoint + write docs + add tests" → likely one task
       (tests and docs are part of implementing the endpoint)
   - When in doubt, keep together — splitting too aggressively creates overhead

3. **Create subtask files**:
   For each concern:
   ```bash
   ludics tasks create "<subtask-title>" <project> <priority>
   ```
   Then update the child task file:
   - Add `subtask_of: <parent_task_id>` to the dependencies section
   - Copy relevant context from the parent task

4. **Update parent task**:
   - Add `leaf: false` to frontmatter (signals this is a container, not actionable)
   - Update status if needed — the parent is done when all children are done

5. **Reassign slot** (if parent was in a slot):
   - Run `ludics slots` to check if `<task_id>` is assigned to a slot
   - If yes, reassign that slot to the most actionable subtask (highest priority,
     or the one closest to the parent's original scope):
     ```bash
     ludics slot <N> assign <first-child-task-id> -a <same-adapter> -p <same-path>
     ```
   - This ensures the slot isn't left holding a non-leaf parent task

6. **Queue elaboration** for each child:
   ```bash
   ludics mag elaborate <child-task-id>
   ```

7. **Write result JSON**:
   ```json
   {
     "id": "req-...",
     "status": "completed",
     "timestamp": "...",
     "task_id": "<parent-task-id>",
     "children": ["<child-1>", "<child-2>"],
     "output": "Split <task-id> into N subtasks"
   }
   ```

## Delegation Strategy

- **CLI tools**: Task creation, file updates
- **Opus**: Judgment on how to decompose the task

## Error Handling

- Task not found: Write result with status "error"
- Task already has children (`leaf: false`): Warn and skip
- Single concern detected: Skip split, report back (let proposal skill proceed)
