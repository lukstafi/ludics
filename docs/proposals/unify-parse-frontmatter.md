# Unify readFrontmatterField into parseTaskFrontmatter with internal per-process cache

## Goal

Collapse the two overlapping frontmatter parsing helpers in `src/tasks/markdown.ts` (`parseTaskFrontmatter` and `readFrontmatterField`) into a single cached `parseTaskFrontmatter` API. The two helpers re-parse the same `^---\n...\n---` block, and several hot loops (`tasks/sync.ts`, `mag.ts` adopt-sessions / cleanupDoneTaskThreads) call `readFrontmatterField` 2–6 times per task file in a single pass. Unifying the API:

- Eliminates redundant YAML parses (one parse per `content` string instead of N).
- Collapses field-missing and file-malformed into the same "field is undefined" path, so callers handle both uniformly with `?? default`.
- Removes a fragile `String([a,b])` coercion at one call site (`cleanupDoneTaskThreads`'s `t3code_threads` split-on-comma) by exposing the typed array directly via `fm.t3code_threads`.
- Eliminates an inline `YAML.parse` in `mag.ts`'s adopt-sessions scanner that re-reads `dependencies.blocked_by` after `readFrontmatterField` already parsed the block.
- Closes a typing gap: `proposal` and `deferred_launch` are read from frontmatter at several call sites today but are not declared in `TaskFrontmatter`.

Source: retrospective of task-485dcb6a (`suggestRefactorSummary` item 3) and absorbed scope from task-277f8670 (call-site batching in `mag.ts` hot loops).

## Acceptance Criteria

- [ ] `parseTaskFrontmatter(content)` in `src/tasks/markdown.ts` is the only public frontmatter-reading helper; `readFrontmatterField` is removed (both the export and the internal `readFrontmatterFieldLineFallback`).
- [ ] `parseTaskFrontmatter` is internally cached (per-process Map keyed by the `content` string). The cache is bounded — when its size reaches 512 entries, the oldest (insertion-order first) entry is evicted before insertion. The cache is an implementation detail; no `clearCache` / `invalidate` API is exported.
- [ ] On unparseable frontmatter (no `^---\n...\n---` block, malformed YAML, or non-object YAML root), `parseTaskFrontmatter` returns an empty-ish object whose fields evaluate to `undefined` / defaults, instead of throwing. Callers that rely on `?? default` or optional chaining behave the same way they did under `readFrontmatterField`'s null-tolerant fallback.
- [ ] `parseTaskFrontmatter` preserves the line-regex fallback for the malformed-YAML edge case introduced in task-485dcb6a round 2 — when YAML parse fails, individual fields are still readable via the per-field line regex (so adopt-sessions and cleanup loops continue to silently skip / read what they can from partially-malformed task files).
- [ ] `TaskFrontmatter` (in `src/tasks/types.ts`) is extended with optional `deferred_launch?: string` and `proposal?: string` fields. `parseTaskFrontmatter` populates both when present.
- [ ] All call sites of `readFrontmatterField` across the codebase are migrated to `parseTaskFrontmatter(content).<field>` (with `?? "<default>"` retained where the helper does not normalize that field). No reference to `readFrontmatterField` survives the PR (`grep -rn readFrontmatterField src/` returns zero hits in non-historical files; tests are also migrated).
- [ ] In `src/dashboard-server.ts`, the local function also named `parseTaskFrontmatter` (around lines 46 / 97) is renamed to `readDashboardTaskInfo` (or another unambiguous name) so it no longer shadows the imported helper. The exported helper from `markdown.ts` is not used by this local function — the rename is for clarity, not for replacement.
- [ ] In `src/mag.ts` `cleanupDoneTaskThreads`, the two passes over the tasks directory are merged into a single loop. The split-on-comma coercion `threadsStr.split(",").map(s => s.trim()).filter(Boolean)` is replaced by direct access to `fm.t3code_threads` (already typed `string[] | undefined`). The skip condition becomes `if (!fm.t3code_threads || fm.t3code_threads.length === 0) continue;`.
- [ ] In `src/mag.ts` adopt-sessions scanner (the loop currently spanning roughly the lines that read `id`, `status`, project, blocked_by via inline `YAML.parse`, project, title, priority — within `magAdoptSessions` / equivalent), the inline `YAML.parse` for `dependencies.blocked_by` is removed; the typed `fm.dependencies.blocked_by` array is read directly. All five field reads collapse to one `parseTaskFrontmatter(content)` call plus field accesses.
- [ ] `src/mag.ts` `isTaskDeferred` reads `fm.status` and `fm.deferred_launch` from a single `parseTaskFrontmatter(content)` call (the legacy-shim migration write-path is unchanged: it still calls `updateFrontmatterField` / `removeFrontmatterField`).
- [ ] In `src/adapters/t3code.ts` `selectOrchestrationFlagsForTask`, the `skip_plan` check changes from `readFrontmatterField(taskContent, "skip_plan") === "true"` to `parseTaskFrontmatter(taskContent).skip_plan === true` (note: `parseTaskFrontmatter` already coerces via `asBoolean`, so the comparison value flips from string `"true"` to boolean `true`). Behavior is equivalent for all current frontmatter values.
- [ ] Existing tests in `src/tasks/markdown.test.ts` — both `readFrontmatterField` test suites and the round-trip test — are updated (or replaced) to exercise `parseTaskFrontmatter` directly. Coverage of the malformed-YAML line-regex fallback, the YAML quirks (duplicate keys, quoted titles, missing fields, "null" literal handling), and the `effort: tiny` round-trip is preserved.
- [ ] New test coverage for the cache: (a) two consecutive calls with the same `content` string return the *same* parsed object reference (or, if the result is frozen, deep-equal contents with no re-parse — verify via spy on `YAML.parse` if practical); (b) the LRU eviction kicks in correctly past 512 entries; (c) mutation of a returned parsed object does not contaminate subsequent calls (recommend `Object.freeze` on insertion).
- [ ] `bun run build` succeeds; `bun test` passes; `ludics init --no-triggers` runs cleanly (no schema/typing errors at startup).

## Context

**Helper location**: `src/tasks/markdown.ts`. The current `parseTaskFrontmatter` (a) requires a frontmatter block and **throws** if absent, (b) normalizes defaults (`status` → `"ready"`, `priority` → `"B"`, `effort` → `"medium"`, `context` → `""`, `uses_browser` via `asBoolean`, arrays defaulted to `[]`), and (c) does NOT include `proposal` or `deferred_launch` fields. The current `readFrontmatterField` (a) returns `null` on missing frontmatter, missing field, literal `"null"`, or YAML parse failure, (b) falls back to a per-field line-regex when YAML fails (task-485dcb6a round 2), and (c) coerces all values to `string | null`.

**TaskFrontmatter type**: `src/tasks/types.ts`. Extension required: add `deferred_launch?: string` and `proposal?: string`. Both are read by existing call sites today but not declared, so they currently flow through `readFrontmatterField` only as untyped strings.

**Dashboard-server shadow**: `src/dashboard-server.ts` defines a local function also named `parseTaskFrontmatter` inside `createDashboardServer` (or equivalent factory). It takes a *file path* (not a content string) and returns a small `{ project, proposal }` shape used only by `resolveProposalFile`. It does not call the helper from `markdown.ts`. The file imports `readFrontmatterField` separately for other call sites in the same module. Rename the local one (suggested `readDashboardTaskInfo`); leave the imported helper alone.

**Hot-loop call sites** (the ones that benefit most from unification — verified by grep at proposal time, exact line numbers will drift):

- `src/tasks/sync.ts`: `collectProjectsWithQueuedPreemption` (`status` + `project` per-task), `tasksNeedsElaborationList` (`id` + `status`), `tasksQueuePreemptions` (`id` + `status` + `project`).
- `src/mag.ts` `cleanupDoneTaskThreads`: two passes over `tasks/`, currently with separate `readFrontmatterField` reads of `status` and `t3code_threads`. Merge into one pass.
- `src/mag.ts` adopt-sessions scanner: 5 field reads (`id`, `status`, `project`, `title`, `priority`) plus an inline `YAML.parse` for `dependencies.blocked_by`. Collapses to one `parseTaskFrontmatter`.
- `src/mag.ts` `isTaskDeferred`: 2 reads (`status`, `deferred_launch`).

**Single-field call sites** (≈50): mostly read `status`, `project`, `priority`, `title`, `effort`, or `proposal` once per call. Migration is uniformity-only — no perf or fragility win — but mandatory to remove `readFrontmatterField`.

**Behavior change to audit**: callers that previously assumed `parseTaskFrontmatter` throws (the only such site is the explicit `try { fm = parseTaskFrontmatter(content); } catch { continue; }` pattern in `src/tasks/sync.ts` `healBlockedByLinks`). Under the unified semantics, the parse never throws; instead, it returns an object with empty/default fields. Call sites guarded by `try/catch` should be reviewed: the `catch` arm is now unreachable for parse failures but may still be defensive against I/O errors on prior `readFileSync`. Either keep the `try/catch` (harmless) or check the result is non-empty before use.

**Default-value drift to audit**: at every migrated site of the form `readFrontmatterField(content, X) ?? "default"`, either (a) drop the `?? default` if the helper already supplies it (e.g. `status` defaults to `"ready"` in the helper), or (b) keep it where the default differs from the helper's normalized value. The migration table in the task file enumerates each site; the coder should verify each one against the helper's normalization rules at the time of the change (line numbers will drift; field semantics will not).

**Cache invalidation**: not required. `writeTaskFile` / `updateFrontmatterField` / `removeFrontmatterField` produce a fresh content string on the next read; the new string is a cache miss by construction. There is no in-place mutation of cached content strings anywhere in the codebase (string immutability in JS).

**Scope of the migration sweep**: `src/dashboard-server.ts`, `src/mag.ts`, `src/notify.ts`, `src/t3code/index.ts`, `src/adapters/task-launch.ts`, `src/adapters/t3code.ts`, `src/orchestration/skills.ts`, `src/slots/index.ts`, `src/tasks/index.ts`, `src/tasks/markdown.ts` (the helper's own `transitionStatus`), `src/tasks/sync.ts`, plus tests in `src/tasks/markdown.test.ts`. No CLI entrypoints or external consumers — the helpers are internal-only.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The design is settled (user-validated 2026-04-24). Recommended implementation order:

1. **Extend `TaskFrontmatter`** in `src/tasks/types.ts` first: add `deferred_launch?: string` and `proposal?: string`. Update the helper's return shape so `parseTaskFrontmatter` reads both. This unblocks the type-checker for downstream call-site changes.

2. **Refactor `parseTaskFrontmatter`** in `src/tasks/markdown.ts`:
   - Rename the existing body to `parseTaskFrontmatterUncached`.
   - Adjust its parse-failure paths to return an empty object (`{}`) cast to `Partial<TaskFrontmatter>`, instead of throwing. Two failure modes: (a) no frontmatter delimiters → return `{}`; (b) YAML parse fails OR returns non-object → fall back to a per-field line regex over the frontmatter block (port the logic from `readFrontmatterFieldLineFallback`), populating only the fields the regex finds; remaining fields stay undefined.
   - The defaults that the current helper supplies (e.g. `status ?? "ready"`, `priority ?? "B"`) only apply on the *YAML-success* path. On the line-regex fallback path, only fields literally present in the malformed block are populated; missing fields are left undefined so callers' `?? default` clauses fire normally.
   - Define the cache as a module-level `const PARSE_CACHE = new Map<string, Parsed>()` with `PARSE_CACHE_MAX = 512`. The new exported `parseTaskFrontmatter` checks the cache, calls `parseTaskFrontmatterUncached` on miss, evicts the oldest entry if at capacity (use `PARSE_CACHE.keys().next().value` for FIFO/LRU-on-insert eviction), and `Object.freeze`s the parsed object before insertion to prevent caller mutation from contaminating future calls.

3. **Migrate call sites** file-by-file. The migration is mechanical at most sites — replace `readFrontmatterField(c, "X") ?? d` with `parseTaskFrontmatter(c).X ?? d` (drop `?? d` if the helper normalizes that field). Hot-loop sites get a per-iteration `const fm = parseTaskFrontmatter(content);` plus N field accesses. Pay attention to:
   - `src/adapters/t3code.ts:selectOrchestrationFlagsForTask` — `=== "true"` becomes `=== true`.
   - `src/mag.ts:cleanupDoneTaskThreads` — merge the two task-directory passes; replace the split-on-comma coercion with direct array access.
   - `src/mag.ts` adopt-sessions — drop the inline `YAML.parse` for `blocked_by`.
   - `src/tasks/sync.ts:healBlockedByLinks` — remove or repurpose the `try/catch` around `parseTaskFrontmatter` (it's defensive but no longer catches parse failures).

4. **Rename the dashboard-server shadow** before migrating its call sites, so the migrated `readFrontmatterField → parseTaskFrontmatter` substitutions don't accidentally collide with the local symbol.

5. **Update tests**. The two large `describe` blocks in `src/tasks/markdown.test.ts` (round-trip and `readFrontmatterField` quirks) should be retargeted to `parseTaskFrontmatter`. The `effort: tiny` round-trip and the YAML-quirk tests should each have a `parseTaskFrontmatter` equivalent. Add new tests for the cache (identity-on-repeat-call, LRU eviction past 512 entries, freeze prevents mutation contamination, line-regex fallback still reads individual fields from malformed YAML).

6. **Remove `readFrontmatterField` and `readFrontmatterFieldLineFallback`** as the final step (after `grep -rn readFrontmatterField src/` is empty in non-test code). Strip them from all `import { ... }` lines.

7. **Smoke-test**: `bun run build && bun test && ludics init --no-triggers`. Spot-check the dashboard server still resolves proposal paths (the renamed local function), and that a deferred task is still recognized by `isTaskDeferred`.

## Scope

**In scope**: everything in the migration table in the task file (`tasks/task-d68d485a.md`). Helper unification, type extension, ~70 call-site migrations across 11 files, dashboard-server shadow rename, test migration, cache implementation.

**Out of scope**: cache-warming or pre-population (the cache fills naturally on first read). Public cache APIs (`clearCache`, `invalidate`). Migration of historical retrospective JSON data (none touches frontmatter parsing). Any refactor of `updateFrontmatterField` / `addFrontmatterField` / `removeFrontmatterField` (they stay write-only). Performance benchmarking — the motivation is correctness + single-API consolidation, not raw speed.

**Dependencies**: builds on the malformed-YAML line-regex fallback from task-485dcb6a (round 2) — already merged. Related to task-808ee2c7 (adapter-context harnessdir audit) only via `relates_to`; no shared code.
