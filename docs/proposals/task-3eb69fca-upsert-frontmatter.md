# Proposal: Make updateFrontmatterField upsert when field is missing

**Task:** task-3eb69fca
**Date:** 2026-04-13

## Goal

When `updateFrontmatterField()` doesn't find the target field in frontmatter, insert it before the closing `---` instead of silently writing the file unchanged. This makes `addFrontmatterField()` redundant — convert it to a thin wrapper.

## Acceptance Criteria

1. `updateFrontmatterField(file, "completed", "2026-04-13")` on a file without a `completed:` field inserts the field into the frontmatter block.
2. `updateFrontmatterField` still updates existing fields as before.
3. `addFrontmatterField` continues to work (delegates to `updateFrontmatterField`).
4. All existing tests pass; `bun run build` succeeds.

## Context

`updateFrontmatterField()` (markdown.ts:104-132) loops over lines looking for `{field}:` — if not found, `done` stays false and the file is written back unchanged. 15 call sites assume the field will be written. `addFrontmatterField()` (markdown.ts:134-161) already handles the "field missing" case by inserting before the closing `---`, but callers must know to use the right function.

## Approach

In `updateFrontmatterField()`, after the loop, if `!done`: find the closing `---` in the output array and insert `{field}: {value}` before it.

```typescript
if (!done) {
  // Insert before closing --- (second occurrence)
  for (let i = output.length - 1; i >= 0; i--) {
    if (output[i] === "---") {
      output.splice(i, 0, `${field}: ${value}`);
      break;
    }
  }
}
```

Simplify `addFrontmatterField()` to just call `updateFrontmatterField()` — the upsert behavior now handles both cases.

### Files to modify

- `src/tasks/markdown.ts` — `updateFrontmatterField()` (add upsert fallback), `addFrontmatterField()` (simplify to wrapper)
