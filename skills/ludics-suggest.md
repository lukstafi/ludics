---
name: ludics-suggest
description: Provide intelligent task suggestions
queue-action: suggest
---

# /ludics-suggest - Task Suggestions

Provide intelligent task suggestions based on current flow state.

## Trigger

This skill is invoked when:
- The user runs `ludics mag suggest`
- The user asks "what should I work on?"

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id` — use as `LUDICS_REQUEST_ID` in result JSON

## Process

1. **Analyze flow state**:
   ```bash
   ludics flow ready      # Get ready tasks
   ludics flow critical   # Get urgent items
   ludics flow context    # Get context distribution
   ```

2. **Consider factors**:
   - **Priority**: A-priority tasks first
   - **Deadlines**: Items with hard deadlines
   - **Impact**: Tasks that unblock the most downstream work
   - **Context**: Minimize context switching if already focused
   - **Effort**: Balance small wins with large projects

3. **Generate suggestions**:
   - Top 3 recommended tasks with reasoning
   - Alternative if primary is blocked

## Output Format

```markdown
## Suggested Tasks

### Top Recommendation
**task-NNN**: [title]

*Why*: [reasoning based on priority, impact, context, deadlines]

### Alternatives
1. **task-NNN**: [title]
   - [why this is a good alternative]

2. **task-NNN**: [title]
   - [different tradeoff - e.g., smaller scope, approaching deadline]

### Consider Later
- [Any problematic tasks that need decision]
```

## Result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "suggestions": [
    {"task": "task-NNN", "priority": 1, "reason": "..."},
    {"task": "task-NNN", "priority": 2, "reason": "..."}
  ]
}
```

## Delegation Strategy

- **CLI tools** for flow analysis
- **Opus** for reasoning about suggestions
