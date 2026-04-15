# Proposal: Migrate remaining frontmatter regex reads to readFrontmatterField

**Task**: task-808ee2c7
**Project**: ludics
**Effort**: small

## Goal

Eliminate 12 remaining raw-regex frontmatter reads in `src/notify.ts` (1 site) and `src/mag.ts` (11 sites). These regexes use `/^field:\s*(.+)$/m` which can match lines anywhere in the markdown body, not just within the `---` frontmatter block. This is the same body-scope confusion vulnerability fixed in task-e2c7cef8 for `project:` reads in `slots/index.ts`. The replacement, `readFrontmatterField` (from `src/tasks/markdown.ts`), uses proper YAML parsing scoped to frontmatter bounds.

## Acceptance Criteria

1. **All 12 regex reads replaced**: Every site listed in the Context section below uses `readFrontmatterField` instead of a raw regex match.
2. **No new regex frontmatter reads introduced**: No new `/^field:\s*(.+)$/m` patterns appear in `notify.ts` or `mag.ts`.
3. **Import added in notify.ts**: `readFrontmatterField` is imported from `./tasks/markdown.ts`.
4. **Existing behavior preserved**: All callers handle the `null` return (via `?? ""` or equivalent) consistently with the previous `match ? match[1]!.trim() : ""` pattern.
5. **t3code_threads handled correctly**: The `t3code_threads` array field produces a comma-separated string via `String([a,b])` -> `"a,b"`, which the existing `.split(",").map(s => s.trim())` logic consumes correctly.
6. **Build passes**: `bun run build` succeeds with no type errors.
7. **Existing tests pass**: `bun test` shows no regressions.

## Context

### readFrontmatterField signature

`src/tasks/markdown.ts:88`:
```ts
export function readFrontmatterField(content: string, field: string): string | null
```
Parses frontmatter YAML, returns `String(value)` or `null` for missing/null fields.

### Sites to migrate

#### notify.ts (1 site)

| Line | Function | Current pattern | Replacement |
|------|----------|----------------|-------------|
| 156 | `taskProject()` | `content.match(/^project:\s*(.+)$/m)` | `readFrontmatterField(content, "project") ?? ""` |

Import to add: `import { readFrontmatterField } from "./tasks/markdown.ts";`

#### mag.ts (11 sites)

| Line | Field | Function | Replacement |
|------|-------|----------|-------------|
| 801 | `status` | `isTaskDeferred()` | `readFrontmatterField(content, "status")` |
| 804 | `deferred_launch` | `isTaskDeferred()` | `readFrontmatterField(content, "deferred_launch") === "true"` |
| 1301 | `status` | `processQueue()` approve handler | `readFrontmatterField(tfContent, "status")` |
| 1460 | `status` | `cleanCompletedThreads()` | `readFrontmatterField(content, "status")` |
| 1463 | `t3code_threads` | `cleanCompletedThreads()` | `readFrontmatterField(content, "t3code_threads")` with `.split(",")` |
| 1479 | `status` | `cleanCompletedThreads()` retro fallback | `readFrontmatterField(content, "status")` |
| 1876 | `id` | `collectReadyForAutoStart()` | `readFrontmatterField(content, "id")` |
| 1881 | `status` | `collectReadyForAutoStart()` | `readFrontmatterField(content, "status")` |
| 2677 | `status` | `keepaliveOnce()` | `readFrontmatterField(content, "status")` |
| 3454 | `status` | `mainCLI()` auto-start-evaluate | `readFrontmatterField(evalContent, "status")` |
| 3480 | `status` | `mainCLI()` revise-proposal | `readFrontmatterField(revContent, "status")` |

`readFrontmatterField` is already imported in `mag.ts` (line 27).

## Approach

1. **notify.ts**: Add `readFrontmatterField` to imports. Replace the single regex in `taskProject()`.

2. **mag.ts**: Replace each of the 11 regex sites mechanically:
   - `content.match(/^status:\s*(.+)$/m)?.[1]?.trim()` becomes `readFrontmatterField(content, "status")`
   - `statusMatch ? statusMatch[1]!.trim() : ""` becomes `readFrontmatterField(content, "status") ?? ""`
   - For `deferred_launch`: replace `.test()` with `=== "true"` comparison
   - For `t3code_threads`: replace bracket-matching regex with `readFrontmatterField(content, "t3code_threads")?.split(",").map(s => s.trim()).filter(Boolean)` (leverages `String([a,b])` -> `"a,b"` coercion)
   - For `id`: replace `idMatch[1]!.trim()` with `readFrontmatterField(content, "id")`

3. **Verify**: `bun run build` and `bun test`.

Each replacement is a local, single-line change. No control flow modifications needed.
