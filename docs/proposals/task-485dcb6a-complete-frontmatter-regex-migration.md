# Proposal: Complete regex-to-readFrontmatterField migration (sweep 2)

**Task**: task-485dcb6a
**Project**: ludics
**Effort**: small

## Goal

Eliminate the remaining 24 raw-regex frontmatter reads across 7 source files so that all task-file field reads go through YAML-parsed, frontmatter-scoped helpers (`readFrontmatterField` / `parseTaskFrontmatter` in `src/tasks/markdown.ts`).

Follow-up to task-808ee2c7 (which migrated `notify.ts` + `mag.ts`) and task-e2c7cef8 (which migrated `project:` reads in `slots/index.ts`). Both predecessors addressed the same body-scope confusion vulnerability: patterns like `content.match(/^status:\s*(.+)$/m)` anchor on any start-of-line, so a fenced code block or retro note in the markdown body containing `status: foo` will silently shadow the real frontmatter. This sweep closes the remaining surface.

## Acceptance Criteria

1. **All 24 regex reads replaced**: every call site listed in Context uses `readFrontmatterField` (or `parseTaskFrontmatter` / the already-parsed YAML `data` object where applicable) instead of a raw regex match against task-file content.
2. **No new regex frontmatter reads introduced**: no new `/^(status|title|effort|priority|id|t3code_threads|deferred_launch):\s*(.+)$/m`-style patterns appear in the 7 in-scope files.
3. **New imports added where needed**: `dashboard-server.ts`, `t3code/index.ts`, and `tasks/index.ts` import `readFrontmatterField` from `./tasks/markdown.ts` / `./markdown.ts`. `retrospective.ts` does NOT need the import (see Approach).
4. **No collision in `dashboard-server.ts`**: the file's existing local function `parseTaskFrontmatter(taskFilePath)` (file-path-based, returns `{project, proposal}`) is preserved as-is. Only import `readFrontmatterField` — do NOT import the helper `parseTaskFrontmatter` from `markdown.ts` here.
5. **Default-value parity**: call sites that currently fall back to `""` via `match ? match[1]!.trim() : ""` continue to observe that behavior by using `?? ""`. Call sites that currently fall back to a domain-specific default (e.g. `"ready"`, `"small"`, `"B"`, `"unknown"`, `taskId`) preserve that default.
6. **Out-of-scope sites untouched**: the `tasks.yaml` legacy-list line-by-line parsing in `src/tasks/sync.ts` and `src/tasks/index.ts`, the existing correct `fmMatch + YAML.parse` usage in `src/mag.ts`, and the correct `parseTaskFrontmatter` usage in `slots/index.ts` `pruneBlockedBy()` are left alone.
7. **Regression tests added**: at least one test in `src/tasks/markdown.test.ts` (or similar) asserts that `readFrontmatterField` returns the frontmatter value (e.g. `"ready"`) when the markdown body contains a conflicting line (e.g. a code block with `status: wrong`). Demonstrates the specific vulnerability the sweep closes.
8. **Build passes**: `bun run build` succeeds with no type errors.
9. **Existing tests pass**: `bun test` shows no regressions.

## Context

### Helper API recap (`src/tasks/markdown.ts`)

- `readFrontmatterField(content: string, field: string): string | null` — parses frontmatter YAML scoped to the `^---\n...\n---` block, returns `String(value)` or `null` for missing / literal-null / empty values.
- `parseTaskFrontmatter(content: string): Partial<TaskFrontmatter> & { id, title }` — single YAML parse returning a typed object with arrays (`t3code_threads`, `merged_from`, `dependencies.*`) preserved. Throws if frontmatter is absent.

### Call sites to migrate (24 across 7 files)

Sites are identified by enclosing function/symbol — not line numbers, which drift as other PRs merge.

#### `src/tasks/markdown.ts` — 1 site (sibling-file, no import change)

- `transitionStatus()` — reads status via `content.match(/^status:\s*(.+)$/m)` before delegating to `updateFrontmatterField`. Replace with `readFrontmatterField(content, "status") ?? "ready"`.

#### `src/slots/index.ts` — 8 sites (imports already present)

Current imports at line 14 already include both `readFrontmatterField` and `parseTaskFrontmatter`. Sites:

- `taskUpdateForSlotAssign()` — fallback status read after `transitionStatus` failure → `readFrontmatterField(content, "status") ?? "unknown"`.
- `slotClear()` — fallback status read after `transitionStatus` failure → same pattern.
- `slotStart` / process-desc title resolver — `content.match(/^title:\s*"?(.+?)"?\s*$/m)` → `readFrontmatterField(content, "title") ?? taskId`. YAML.parse already strips surrounding quotes, so no manual strip needed.
- `slotAssign()` old-task cleanup — `oldContent.match(/^status:\s*(.+)$/m)?.[1]?.trim()` → `readFrontmatterField(oldContent, "status")`.
- Setup-failure handler — regex status read used to reset in-progress / deferred → ready → `readFrontmatterField`.
- `taskCompleteDirectly()` — fallback status read → `readFrontmatterField`.
- Preempt path — fallback status read → `readFrontmatterField`.
- Orchestration-flag auto-fill — `content.match(/^effort:\s*(.+)/m)` → `readFrontmatterField(content, "effort") ?? "small"`.

#### `src/dashboard-server.ts` — 5 sites (needs new `readFrontmatterField` import)

Current imports from `./tasks/markdown.ts`: `updateFrontmatterField`, `addFrontmatterField`, `TASK_ID_RE`, `PRIORITY_INCREASE`, `PRIORITY_DECREASE`. Add `readFrontmatterField` to that list.

Do NOT import `parseTaskFrontmatter` — the file has a local function of the same name at line 46 that takes a file path (not content) and returns `{project, proposal}`. Preserve it unchanged.

Sites:

- `/api/slot-clear` handler — priority demotion regex → `readFrontmatterField(content, "priority") ?? "B"`.
- `/api/task-promote` handler — priority regex → same replacement.
- `/api/task-confirm` handler — status regex gated on `"needs-confirmation"` → `readFrontmatterField(content, "status") ?? ""`.
- `/api/task-dismiss` handler — status regex → same replacement.
- `/api/deferred-approve` handler — `approveContent.match(/^status:\s*(.+)$/m)?.[1]?.trim()` → `readFrontmatterField(approveContent, "status")`.

#### `src/tasks/sync.ts` — 6 sites (imports already present)

Current imports at line 8 already include `readFrontmatterField`. Sites:

- `collectProjectsWithQueuedPreemption()` — status filter for `"preempt-queued"`.
- `tasksQueueElaborations()` — status filter for `"ready"`.
- `tasksNeedsElaborationList()` — 2 reads (`id`, `status`).
- `tasksQueuePreemptions()` — 2 reads (`id`, `status`).

Each becomes `readFrontmatterField(content, "<field>")` with `?? ""` where existing code falls back to empty string.

#### `src/tasks/index.ts` — 2 sites (needs new `readFrontmatterField` import)

Current imports at line 6 from `./markdown.ts`: `parseTaskFrontmatter`, `updateFrontmatterField`, `addFrontmatterField`, `removeFrontmatterField`, `transitionStatus`. Add `readFrontmatterField`.

Sites:

- `tasksMerge()` — fallback status read after `transitionStatus` failure.
- `tasksUnmerge()` — fallback status read after `transitionStatus` failure.

#### `src/t3code/index.ts` — 1 site (needs new import)

- `readTaskStatus()` helper — replace the regex body with `return readFrontmatterField(content, "status");`. Keep the wrapper function for call-site brevity; don't delete and inline.

#### `src/retrospective.ts` — 1 site (NO new import)

`readTaskFrontmatter()` in this file already performs its own `fmMatch + YAML.parse` and exposes the parsed `data` object. A secondary regex pass then extracts `t3code_threads: [a, b]`. Replace that regex with:

```ts
Array.isArray(data.t3code_threads) ? (data.t3code_threads as string[]) : []
```

No import from `markdown.ts` is needed — the local YAML parse is sufficient. This is the cleanest option for this file and avoids double-parsing.

### Explicitly out of scope

The following look superficially similar but parse a different format or are already correct — leave alone:

- `src/tasks/sync.ts` lines ~161, 174, 177, 180, 187, 190, 193 — parsing `tasks.yaml` (legacy GitHub-import list format), line-by-line, not task-file frontmatter.
- `src/tasks/index.ts` (~line 55) — same `tasks.yaml` parse.
- `src/mag.ts` — all frontmatter reads use `fmMatch + YAML.parse` correctly (post task-808ee2c7).
- `src/slots/index.ts` `pruneBlockedBy()` — already uses `parseTaskFrontmatter`.
- `src/tasks/sync.ts` (~line 289) `merged_from` regex — builds a string for re-write via string concat. Coder's choice: either leave as-is OR migrate to `parseTaskFrontmatter(...).merged_from: string[]` and rejoin. Not required for this sweep.

### Edge cases

- **Default-value drift**: existing regex sites use `statusMatch ? statusMatch[1]!.trim() : ""`. `readFrontmatterField` returns `null`, not `""`. For strict-equality checks against non-empty strings (`=== "ready"`, `!== "done"`), `null` behaves equivalently. For callers that log the result in error messages (`"unknown"` fallback) or pass it through `.trim()`, add `?? ""` or `?? "<domain-default>"` to preserve behavior.
- **Literal `"null"` string**: `readFrontmatterField` treats YAML `null` AND the literal string `"null"` as missing. None of the in-scope sites care about the literal-null case.
- **Quoted titles**: `YAML.parse` strips surrounding quotes automatically — no regression from removing the manual `?\"(.+?)\"?` strip in `slotStart`.
- **Performance**: each `readFrontmatterField` call re-parses the YAML. Hot multi-read loops (`tasksNeedsElaborationList`, `tasksQueuePreemptions`) do 2 parses per task-file. Acceptable at current task counts; if profiling shows it, batch via `parseTaskFrontmatter` as a follow-up (task-277f8670 pattern).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Mechanical 1:1 replacements in order of least → most new-import overhead:**
   - `src/tasks/markdown.ts` `transitionStatus()` (no import change).
   - `src/slots/index.ts` (8 sites, imports already present).
   - `src/tasks/sync.ts` (6 sites, imports already present).
   - `src/tasks/index.ts` (2 sites — add `readFrontmatterField` to existing import list).
   - `src/dashboard-server.ts` (5 sites — add `readFrontmatterField` to existing `./tasks/markdown.ts` import list; DO NOT touch the local `parseTaskFrontmatter(taskFilePath)` function).
   - `src/t3code/index.ts` (1 site — add new import, migrate `readTaskStatus()` body).
   - `src/retrospective.ts` (1 site — swap secondary regex for `Array.isArray(data.t3code_threads) ? ... : []`; no new import).

2. **At each site**: replace `content.match(/^<field>:\s*(.+)$/m)?.[1]?.trim()` with `readFrontmatterField(content, "<field>")`, appending `?? "<existing default>"` if the original had a non-null fallback. For `slotStart` title regex, drop the manual quote-strip (YAML handles it).

3. **Add regression test(s)** in `src/tasks/markdown.test.ts` demonstrating body-scope confusion:
   - Task content with frontmatter `status: ready` and a markdown body containing a fenced code block with `status: wrong` (or a retro quote).
   - Assert `readFrontmatterField(content, "status") === "ready"`.
   - Optionally also show that a naive `content.match(/^status:\s*(.+)$/m)?.[1]` returns `"wrong"` to document what the migration fixes.

4. **Verify**: `bun run build` and `bun test`. Focus regression check on dashboard API handlers, `transitionStatus` callers, `slotStart` title resolution, and sync loops (all can be exercised by existing tests).

5. **Do not bundle with task-277f8670**. That task's `parseTaskFrontmatter` batching optimization operates on `src/mag.ts` (disjoint files — no merge conflict) and is orthogonal. Keep this sweep strictly 1:1 mechanical; follow-up batching for the multi-read sites in `tasks/sync.ts` can be filed as a separate task if wanted.

## Scope

- **In scope**: the 24 call sites across the 7 files listed in Context, plus 1–2 regression tests demonstrating the body-scope fix.
- **Out of scope**: the `tasks.yaml` legacy list parser, the `merged_from` string-rewrite regex, `parseTaskFrontmatter` batching optimizations, any helper-API changes.
- **Dependencies**:
  - Relates to task-277f8670 (`parseTaskFrontmatter` batching in `mag.ts`) — disjoint files, can run in parallel or either order. Recommended sequencing: this task first.
  - Follow-up to task-808ee2c7 (migrated `notify.ts` + `mag.ts`, confirmed complete).
  - Follow-up to task-e2c7cef8 (migrated `project:` reads in `slots/index.ts`, confirmed complete).
