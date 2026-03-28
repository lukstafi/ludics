---
name: ludics-learn
description: Update Mag memory from user corrections and feedback
queue-action: learn
---

# /ludics-learn - Institutional Learning

Update Mag's memory from user corrections and feedback.

## Trigger

This skill is invoked when:
- The user provides a correction and says `/ludics-learn`
- Example: "Don't use yq -s on single files, it expects multiple" then `/ludics-learn`

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- Previous message context (the correction)

## Process

1. **Identify the correction**:
   - Parse the user's previous message
   - Understand what was wrong and what's correct

2. **Categorize the learning**:
   - **Tool gotcha**: CLI tool behavior, flags, quirks
   - **Workflow pattern**: Process or procedure improvement
   - **Project-specific**: Knowledge about a specific codebase
   - **Preference**: User's preferred style or approach

3. **Write to corrections log**:
   Append to `$LUDICS_STATE_PATH/mag/memory/corrections.md`

4. **Update structured memory** (if pattern is clear):
   - Tools: `mag/memory/tools.md`
   - Workflows: `mag/memory/workflows.md`
   - Project: `mag/memory/projects/<project>.md`

5. **Acknowledge the learning**

## Output Format

### Corrections Entry

Append to `mag/memory/corrections.md`:

```markdown
## 2026-02-01: yq usage

**Context**: Using yq for YAML parsing

**Correction**: `yq -s` (slurp) expects multiple files as input. For single file operations, use `yq eval` or `yq e` instead.

**Before** (wrong):
```bash
yq -s '.' single-file.yaml
```

**After** (correct):
```bash
yq eval '.' single-file.yaml
```

**Source**: User feedback

---
```

### Tools Memory Update

If this is a tool-related learning, also update `mag/memory/tools.md`:

```markdown
## yq

### Gotchas
- `yq -s` (slurp) expects multiple files; use `yq eval` for single files
- [other gotchas...]
```

### Acknowledgment

```
Learned: yq -s expects multiple files, use yq eval for single files.
Added to: corrections.md, tools.md
```

## Result JSON

```json
{
  "id": "req-...",
  "status": "completed",
  "timestamp": "...",
  "category": "tool",
  "summary": "yq -s expects multiple files",
  "files_updated": ["corrections.md", "tools.md"]
}
```

## Memory Structure

```
mag/
├── context.md           # Current understanding, project focus
└── memory/
    ├── corrections.md   # Raw correction log (append-only)
    ├── tools.md         # CLI tool knowledge
    ├── workflows.md     # Process patterns
    └── projects/
        ├── ocannl.md
        └── ppx-minidebug.md
```

## Delegation Strategy

- **Opus only**: Requires understanding context and making judgment calls about categorization
