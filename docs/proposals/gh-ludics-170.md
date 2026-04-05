# Proposal: Replace hand-rolled readFrontmatterField with proper YAML parsing

## Goal

Replace the regex-based `readFrontmatterField` and duplicated `normalizeYamlScalar` helpers with a single YAML-parsed implementation in `src/tasks/markdown.ts`, eliminating fragile hand-rolled scalar parsing and code duplication across three files.

## Acceptance Criteria

- A new `readFrontmatterField(content, field)` function in `src/tasks/markdown.ts` uses `YAML.parse()` to extract field values from frontmatter, returning `string | null` (same signature as the current function).
- The old `readFrontmatterField` and `normalizeYamlScalar` in `src/adapters/task-launch.ts` are deleted.
- The duplicated `normalizeYamlScalar` and `readTaskProject()` in `src/mag.ts` are refactored to use the new function.
- The duplicated `readTaskProjectName()` in `src/tasks/sync.ts` is refactored to use the new function.
- All existing call sites (4 in `skills.ts`, 1 in `task-launch.ts`, 2 in `sync.ts`, 1 in `mag.ts`) work without behavioral changes.
- Write-back functions (`updateFrontmatterField`, `addFrontmatterField`, `removeFrontmatterField`) remain line-based and are NOT modified.
- Values returned by the new function are coerced to `string` for backward compatibility (YAML.parse returns native types for booleans/numbers).

## Context

### Current state

**`readFrontmatterField` in `src/adapters/task-launch.ts` (line 15):**
Extracts frontmatter via `/^---\n([\s\S]*?)\n---/`, builds a per-field regex, and strips quotes via `normalizeYamlScalar()` (lines 4-13). Only handles single-line scalar values; cannot parse arrays, objects, or YAML escape sequences.

**`normalizeYamlScalar` in `src/mag.ts` (line 814):**
Exact duplicate of the one in task-launch.ts. Used by `readTaskProject()` (line 825) which also has a body-scope bug -- it matches `project:` anywhere in the file, not just in frontmatter.

**`readTaskProjectName` in `src/tasks/sync.ts` (line 250):**
Yet another hand-rolled regex reader (`/^project:\s*(.+)$/m`) scanning the entire file content. Same body-scope risk.

**Call sites for `readFrontmatterField` (4 total, all reading `proposal`):**
- `src/adapters/task-launch.ts:73`
- `src/orchestration/skills.ts:97, 118, 246`

**Call sites for `readTaskProject` / `readTaskProjectName`:**
- `src/mag.ts:835`
- `src/tasks/sync.ts:263, 274`

**Existing YAML infrastructure:**
`src/tasks/markdown.ts` already imports `YAML from "yaml"` (line 5) and uses `YAML.parse()` in `parseTaskFrontmatter()` (line 36). The new function shares the same parsing approach but returns a single field value rather than a typed structure.

### Approach

1. Add `readFrontmatterField(content: string, field: string): string | null` to `src/tasks/markdown.ts` -- extract frontmatter block, call `YAML.parse()`, look up field, coerce to string.
2. Update imports in `skills.ts` and `task-launch.ts` to use the new function from `markdown.ts`.
3. Refactor `readTaskProject()` in `mag.ts` and `readTaskProjectName()` in `sync.ts` to call the new function.
4. Delete `normalizeYamlScalar` from both `task-launch.ts` and `mag.ts`.

Write-back functions stay line-based to preserve formatting. The new function is intentionally simpler than `parseTaskFrontmatter` -- it avoids constructing a full typed object when callers only need one field.
