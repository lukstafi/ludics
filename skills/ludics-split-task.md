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
   - Each concern should be finishable in a single agent session.
   - Concerns are independent when they touch different files/modules or can
     merge to main separately.
   - Examples:
     - "Refactor auth + add logging" → two tasks.
     - "Implement API endpoint + write docs + add tests" → likely one task;
       tests and docs are part of implementing the endpoint.
   - When in doubt, keep them together — over-splitting creates overhead.

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

5. **Reassign slot** (if the parent was in a slot):
   - Run `ludics slots` to see whether `<task_id>` is slotted.
   - If so, reassign that slot to the most actionable subtask (highest
     priority, or closest to the parent's original scope):
     ```bash
     ludics slot <N> assign <first-child-task-id> -a <same-adapter> -p <same-path>
     ```
     This avoids leaving a non-leaf parent task in the slot.

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

- CLI tools for task creation and file updates.
- Opus for judgment on how to decompose the task.

## Error Handling

- Task not found: write a result with `"status": "error"`.
- Task already has children (`leaf: false`): warn and skip.
- Single concern detected: skip the split and report back so the proposal
  skill can proceed.
