---
name: ludics-preempt
description: Decide which slot to preempt for a priority project task
queue-action: preempt
queue-args: [task, autonomy]
queue-args-defaults:
  autonomy: suggest
---

# /ludics-preempt - Priority Project Preemption

Decide which slot to preempt for a priority project task.

## Trigger

This skill is invoked when:
- A priority project task is detected during `ludics tasks sync`
- All slots are occupied and a priority task needs immediate attention

## Arguments

- `$1` — Task ID (e.g., `gh-myrepo-42`)
- `$2` — Autonomy level: `auto` or `suggest`

## Process

1. **Read task details**:
   ```bash
   ludics tasks show $1
   ```

2. **Read all slot states**:
   ```bash
   ludics slots
   ```

3. **Check for existing preemptions**:
   Look in `harness/mag/preempted/` for existing stash files.
   Never preempt a slot that already has a stash (no double preemption for that slot).
   Treat the effective cap as **one active preemption per project**, not one globally.
   A priority task from project A must not block preempting a slot for project B.

4. **Evaluate each slot** with these criteria:
   - One active preemption per project is the cap — if the incoming task's
     project already has a queued or stashed preemption, stop and reset the
     task to `ready`.
   - Avoid preempting another priority task from the same project — check
     whether the slot's current task belongs to the incoming task's project.
   - A different priority project isn't a global blocker — if project A
     already has a preempted slot, project B can still preempt one of its own.
   - Prefer lower-priority tasks (C over B over A).
   - Prefer tasks with less time invested — recently-started tasks are
     cheaper to pause.
   - Prefer preempting tasks in unrelated contexts.
   - Prefer manual/idle adapters for less disruption.

5. **Select the best slot** to preempt based on the above criteria.

6. **Act based on autonomy level**:

   ### `auto` mode
   Execute the preemption directly:
   ```bash
   ludics slot N preempt $TASK_ID -a claude-code
   ```

   ### `suggest` mode
   Send a notification with the recommendation:
   ```bash
   ludics notify outgoing "Priority task $TASK_ID ready. Recommend preempting slot N (currently: <description>). Run: ludics slot N preempt $TASK_ID"
   ```

   ### On failure / no suitable slot
   If no slot can be preempted (every candidate would create a second preemption for the same project, or every slot already has a stash), reset the task so it can be reconsidered later: the queueing logic set `status: preempt-queued`, so flip the task file's `status:` field back to `ready`.

## Output Format

```markdown
## Preemption Decision

**Task**: $TASK_ID — [title]
**Selected Slot**: N
**Reason**: [why this slot was chosen]
**Action**: [executed / suggested]

### Slot Analysis
| Slot | Task | Priority | Age | Preemptable | Score |
|------|------|----------|-----|-------------|-------|
| 1    | ...  | B        | 2d  | yes         | 0.8   |
| 2    | ...  | A        | 5d  | no (priority)| -    |
| ...  | ...  | ...      | ... | ...         | ...   |
```

## Result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "action": "preempt",
  "task": "...",
  "selectedSlot": N,
  "autonomy": "auto|suggest",
  "executed": true
}
```

## Delegation Strategy

- **CLI tools** for slot/task state
- **Opus** for reasoning about which slot to preempt
