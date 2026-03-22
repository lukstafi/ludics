# Proposal: Auto-select orchestration flags based on task effort

## Summary

Automatically select orchestration pre-work phases and coder model based on task `effort` field. No priority-based logic — effort is the only signal.

## Selection logic

| Effort | Pre-work phases | Claude coder model |
|--------|----------------|-------------------|
| `small` | none | Sonnet |
| `medium` | plan | Opus |
| `large` | plan + gather | Opus |

Mode (pair/duo) and reviewer provider come from config defaults, not per-task selection.

## Changes

### 1. Add `selectOrchestrationFlags()` (`src/adapters/t3code.ts`)

```typescript
function selectOrchestrationFlags(effort: string, config: OrchConfig): string {
  const mode = config.default_mode ?? "pair";
  const coder = config.default_coder ?? "claude-code";
  const reviewer = config.default_reviewer ?? "codex";
  const coderModel = effort === "small" ? "claude-sonnet-4-6" : "claude-opus-4-6";

  let flags = `--${mode} --coder ${coder} --reviewer ${reviewer} --coder-model ${coderModel}`;
  if (effort === "medium" || effort === "large") flags += " --plan";
  if (effort === "large") flags += " --gather";
  return flags;
}
```

### 2. Wire into `maybeFillEmptySlots()` (`src/mag.ts`)

When auto-assigning without explicit adapter args, read the task's `effort` field and call `selectOrchestrationFlags()`.

### 3. Config defaults (`config.yaml`)

```yaml
mag:
  orchestration:
    default_mode: pair
    default_coder: claude-code
    default_reviewer: codex
```

### Files to modify

- `src/adapters/t3code.ts` — `selectOrchestrationFlags()`
- `src/mag.ts` — `maybeFillEmptySlots()` integration
- `src/config.ts` — config reading
- `templates/config.reference.yaml` — document settings
