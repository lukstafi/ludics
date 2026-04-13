# Extract frontmatterBounds helper and consolidate frontmatter mutation functions

## Goal

Three frontmatter mutation functions in `src/tasks/markdown.ts` (`updateFrontmatterField`, `removeFrontmatterField`, `updateDependencyArray`) each independently detect frontmatter `---` delimiters with slightly different loop structures. This duplication risks delimiter-confusion bugs (e.g., a body `---` line being mistaken for a frontmatter boundary). A shared `frontmatterBounds` helper eliminates the duplication and enforces a single, correct boundary-detection strategy.

Follow-up from task-3eb69fca retrospective.

## Acceptance Criteria

- A `frontmatterBounds(lines: string[])` function exists in `src/tasks/markdown.ts` that returns `{ openLine: number; closeLine: number } | null`.
- `updateFrontmatterField`, `removeFrontmatterField`, and `updateDependencyArray` all use `frontmatterBounds` instead of inline `inFrontmatter` tracking.
- `addFrontmatterField` continues to delegate to `updateFrontmatterField` (no change needed).
- Existing tests pass without modification (behavior is preserved).
- No new dependencies introduced.

## Context

**File:** `src/tasks/markdown.ts`

Current frontmatter boundary detection pattern (repeated 3 times with minor variations):
```ts
if (line === "---" && !inFrontmatter) { inFrontmatter = true; ... }
if (line === "---" && inFrontmatter)  { inFrontmatter = false; ... }
```

Functions and their extra state beyond `inFrontmatter`:

| Function | Extra state | Loop style |
|---|---|---|
| `updateFrontmatterField` (lines 104-139) | `closingDelimiterIdx` for upsert | `for...of` |
| `removeFrontmatterField` (lines 179-209) | none (index needed for continuation-line skip) | index `for` |
| `updateDependencyArray` (lines 215-263) | `inDeps`, `lastDepsLineIdx` | index `for` |

After extracting `frontmatterBounds`, each function can iterate only the `lines[openLine+1 .. closeLine-1]` range, removing all `inFrontmatter` bookkeeping.

**Related tasks (out of scope):**
- task-010fa0f1 proposes a `setFrontmatterKey` dashboard utility (different layer).
- task-e2c7cef8 targets read paths (`readFrontmatterField` regex migration), not mutation paths.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. Add `frontmatterBounds(lines: string[]): { openLine: number; closeLine: number } | null` that requires `lines[0] === "---"` (frontmatter must start at line 0), then scans for the next `---`.
2. Refactor each mutation function to call `frontmatterBounds` first, bail out if `null`, then iterate only within the bounded range. The per-function extra state (`closingDelimiterIdx`, `inDeps`, etc.) is retained but `inFrontmatter` tracking is removed.
3. Export the helper so downstream code (e.g., task-010fa0f1) can reuse it.

## Scope

**In scope:** `src/tasks/markdown.ts` only -- extract helper + refactor three mutation functions.

**Out of scope:**
- Refactoring `parseTaskFrontmatter` or `readFrontmatterField` (they use regex, not line-by-line parsing).
- Dashboard API changes (task-010fa0f1).
- Read-path regex migration (task-e2c7cef8).
