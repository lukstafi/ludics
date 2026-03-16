# Proposal: tasks merge undo via `tasks unmerge`

**Task:** gh-ludics-9
**Effort:** small (~55 new lines across 3 files)

## Changes

### 1. `src/tasks/markdown.ts` — new `removeFrontmatterField()` helper
~15 lines. Fully removes a frontmatter field (needed because `merged_into` should be deleted, not set to null).

### 2. `src/tasks/index.ts` — new `tasksUnmerge(sourceId)` function
~35 lines:
- Reads source task's `merged_into` field to find the target
- Resets source status to `ready`, removes `merged_into`
- Removes source ID from target's `merged_from` list (or removes field if list becomes empty)
- Warns if target task file is missing but still restores the source
- Emits `task_unmerged` event
- Wires up as `"unmerge"` case in `runTasks()` switch

### 3. `src/index.ts` — help string
Add `tasks unmerge <source>` to USAGE.

## Usage
```bash
ludics tasks unmerge gh-ludics-16
# Restores gh-ludics-16 from merged status back to ready
```
