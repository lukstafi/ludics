# Batch readFrontmatterField calls in mag.ts hot loops

## Goal

Two loops in `src/mag.ts` call `readFrontmatterField` multiple times per iteration, re-parsing the YAML frontmatter from scratch for every field. One of those loops also uses the fragile `String([a, b])` coercion path to read the `t3code_threads` array, then splits the resulting comma-joined string. A third related loop (the retrospective fallback inside `cleanupDoneTaskThreads`) re-reads every task file a second time only to check `status` again.

Collapse each site to a single `parseTaskFrontmatter(content)` call and use the properly-typed fields it returns. This removes duplicate YAML parses, eliminates the `String(array)` fragility, and reads cleaner.

Follow-up to task-808ee2c7 (frontmatter regex migration).

## Acceptance Criteria

- `cleanupDoneTaskThreads()` in `src/mag.ts` reads each task file once and calls `parseTaskFrontmatter` once per file. It uses `fm.status` and `fm.t3code_threads` (already `string[]`) directly — no `.split(",").map(trim).filter(Boolean)` on a coerced string.
- The retrospective-fallback loop inside `cleanupDoneTaskThreads` (the second `readdirSync(tasksDir)` pass) is merged into the main loop so each task file is opened and parsed at most once per invocation.
- The adopt-sessions task scanner (the loop around the `const id = readFrontmatterField(content, "id")` site inside `mainCLI`) replaces its five `readFrontmatterField` calls (`id`, `status`, `project`, `title`, `priority`) **and** the inline `content.match(/^---\n([\s\S]*?)\n---/) + YAML.parse` for `dependencies.blocked_by` with a single `parseTaskFrontmatter` call. It uses `fm.dependencies.blocked_by` directly (already `string[]`).
- Silent-skip behavior is preserved at both sites: a task file whose frontmatter is missing or malformed does not throw out of the loop. Since `parseTaskFrontmatter` throws in those cases, each iteration must be wrapped in `try/catch` (or equivalent) that simply skips to the next file.
- Default-value drift is audited at each migrated call site. Specifically: `parseTaskFrontmatter` defaults `status` to `"ready"`, `priority` to `"B"`, and `project` to `""`, whereas `readFrontmatterField` returns `null`. Call-site `??`-coalesces are dropped where they duplicate the helper's defaults, and retained where they provide a different default.
- The skip condition for an empty/absent `t3code_threads` list becomes `if (!fm.t3code_threads || fm.t3code_threads.length === 0) continue` (was `if (!threadsStr) continue`).
- `isTaskDeferred`, `processQueue`, `maybeAutoStartSlots`, `mainCLI` single-field subcommands, and other single-read sites are **not** modified by this task.
- `bun run typecheck`, `bun run lint`, `bun run build`, and `bun run test` all pass. No new tests are required unless collapsing the two `cleanupDoneTaskThreads` passes introduces observable behavior changes that warrant one.

## Context

### Helpers (`src/tasks/markdown.ts`)

- `parseTaskFrontmatter(content)` does one regex match + one `YAML.parse` and returns a fully-typed `Partial<TaskFrontmatter> & { id; title }`. It **throws** if the `---\n…\n---` frontmatter block is missing. Arrays are already returned as real arrays — `t3code_threads: string[] | undefined`, `dependencies.blocked_by: string[]`.
- `readFrontmatterField(content, field)` runs the same regex + `YAML.parse` per call and `String()`-coerces the value. For an array like `[a, b]` it returns the literal string `"a,b"`. Returns `null` on missing frontmatter, YAML error, `null`/`"null"` values, or the empty string.

### Call sites

All in `src/mag.ts`. Anchor them by surrounding function and a distinctive line rather than line numbers (which drift).

1. **`cleanupDoneTaskThreads()` — main loop.** The body starts with `if (status !== "done" && status !== "abandoned") continue;` and then reads `t3code_threads` as a string, splits, and pushes the IDs into `threadIdsToDelete`.

2. **`cleanupDoneTaskThreads()` — retrospective fallback.** The block opens with `const retroDir = join(harness, "retrospectives");` and does a second `readdirSync(tasksDir)` pass, re-opening every task file and re-reading `status` only to decide whether to call `collectRetrospectiveFallback(taskId)`.

3. **Adopt-sessions task scanner.** Inside `mainCLI`, in the loop `for (const f of taskFiles) { const content = readFileSync(...); const id = readFrontmatterField(content, "id"); … }`. This is the heaviest site: five `readFrontmatterField` calls plus an inline `content.match + YAML.parse` block that reads `dependencies.blocked_by`.

### Why this is safe

- `parseTaskFrontmatter` already returns `t3code_threads` via `Array.isArray(data.t3code_threads) ? (data.t3code_threads as string[]) : undefined`, so the `String([a, b])` -> `"a,b"` -> `.split(",")` round-trip in `cleanupDoneTaskThreads` is strictly lossier than using `fm.t3code_threads` directly.
- `parseTaskFrontmatter` returns `dependencies.blocked_by: string[]` (empty when missing), matching the shape the adopt-sessions scanner already reconstructs by hand.
- Both migrated sites currently swallow YAML parse errors (first via `readFrontmatterField`'s internal `try/catch`, second via the outer `try { … } catch { return; }` around the whole `readdirSync` block). Wrapping each iteration in `try/catch` preserves that behavior with a narrower scope (don't abort the whole loop on one bad file).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

For `cleanupDoneTaskThreads()`: fold the retrospective fallback into the main `for (const f of files)` loop. Per iteration: read the file once, wrap `parseTaskFrontmatter` in `try/catch` (skip on throw), early-continue unless `fm.status` is `"done"` or `"abandoned"`, push from `fm.t3code_threads ?? []`, then in the same iteration check `retroFile`/`collectRetrospectiveFallback`. Drop the second `readdirSync` block entirely.

For the adopt-sessions scanner: replace the whole preamble (five `readFrontmatterField` calls + the inline regex/YAML block) with:

```ts
let fm;
try { fm = parseTaskFrontmatter(content); } catch { continue; }
const { id, status, project, title, priority } = fm;
if (!id || tasksInSlots.has(id)) continue;
if (status !== "ready") continue;
if ((fm.dependencies?.blocked_by ?? []).length > 0) continue;
if (!project) continue;
// title already defaulted to "" by helper — use `title || id` where the old code wrote `readFrontmatterField(...) ?? id`
// priority already defaulted to "B" by the helper
```

Audit each coalesce: the old code uses `?? ""` for `project` and `title`, `?? "B"` for `priority`, `?? ""` for `status` — all of which the helper now handles (`project: ""`, `priority: "B"`, `status: "ready"`, `title: ""`). The `title ?? id` fallback is the only one that's semantically different from the helper's default and must be preserved at the call site as `title || id`.

No changes to `parseTaskFrontmatter`, `readFrontmatterField`, or any other helper.

## Scope

**In scope:**
- `cleanupDoneTaskThreads()` (main loop + retrospective fallback collapse) in `src/mag.ts`.
- Adopt-sessions task scanner inside `mainCLI` in `src/mag.ts`.

**Out of scope:**
- `isTaskDeferred` — only two reads, and the legacy `deferred_launch` field isn't in the `TaskFrontmatter` shape; leaving it alone avoids widening the helper's type surface for a one-time migration shim.
- Single-read sites: `processQueue` approve handler, `mainCLI` subcommand handlers (`auto-start-evaluate`, `revise-proposal`, etc.), `maybeAutoStartSlots`, `maybeUnstickAssignedSlots`, auto-clear-done-slots, any site in `src/tasks/sync.ts`, `src/slots/index.ts`, `src/notify.ts`, `src/adapters/*`, `src/orchestration/skills.ts`. These read one field per call site and gain nothing from batching.
- Helper signature changes. `parseTaskFrontmatter` already does the right thing for `t3code_threads` and `dependencies.blocked_by`.

**Dependencies:** none. Follow-up to task-808ee2c7 but does not block on it.

**Verification:** `bun run typecheck && bun run lint && bun run build && bun run test`.
