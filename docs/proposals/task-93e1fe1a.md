---
task_id: task-93e1fe1a
project: ludics
created: 2026-04-25
---

# Proposal: Drop unnecessary try/catch wrappers around parseTaskFrontmatter in sync.ts

## Goal

Remove the four now-defensive `try { fm = parseTaskFrontmatter(...) } catch { continue; }` wrappers in `src/tasks/sync.ts` and replace each with a direct `const fm = parseTaskFrontmatter(content)` call. After task-d68d485a (PR #396), `parseTaskFrontmatter` is non-throwing — on unparseable YAML it returns either `{}` or a partial object via the line-regex salvage path in `parseTaskFrontmatterLineFallback`. The catch arms are therefore unreachable dead code, and reading them suggests defensive behaviour that no longer exists. Removing them tightens the loops, lets surface bugs propagate (rather than silently skipping files), and brings the four call sites into a single uniform shape.

## Acceptance Criteria

- [ ] All four `try/catch` wrappers around `parseTaskFrontmatter` in `src/tasks/sync.ts` are removed:
  - `tasksUpdate` (around line 429)
  - `healBlockedByLinks` (around line 678, single-line shape)
  - `tasksReconcileBlockedStatus` (around line 736)
  - `tasksMilestoneWarnings` (around line 783)
- [ ] Each replacement uses `const fm = parseTaskFrontmatter(content);` (no `let fm; … fm = …`).
- [ ] Existing per-site guards that protect against empty/partial frontmatter remain in place:
  - `tasksUpdate`: `if (!fm.id) continue;` is preserved (line-regex salvage populates `id` for any tasks with a recoverable id field; truly empty FM correctly falls through this guard).
  - `healBlockedByLinks`: `if (!fm.id) continue;` and `if (!fm.dependencies) continue;` are preserved (the latter added in commit `5253e2f`).
  - `tasksReconcileBlockedStatus`: `if (!fm.dependencies) continue;` is preserved, along with its explanatory comment block (added in commit `5253e2f`).
  - `tasksMilestoneWarnings`: keep the existing flow — `status ?? "ready"`, `milestonesProjects.has(fm.project ?? "")`, and the trailing `fm.id` truthy check before pushing — these already handle the empty-FM case correctly.
- [ ] No changes to `parseTaskFrontmatter`'s contract — it stays non-throwing.
- [ ] The other unrelated `try {` blocks in `sync.ts` (around lines 54, 232, 322 — wrapping `JSON.parse` / `new URL`) are untouched.
- [ ] The existing regression test at `src/tasks/sync.test.ts:259-291` (`malformed YAML with status: blocked is not silently rewritten to ready`) continues to pass after the cleanup, confirming that `tasksReconcileBlockedStatus` does not regress on malformed-YAML tasks.
- [ ] Full verification passes: `bun run typecheck && bun run lint && bun run build && bun test` (1479+ tests green).

## Context

### Why parseTaskFrontmatter is non-throwing now

In task-d68d485a (commit `19bc5f3`, merged via PR #396), `parseTaskFrontmatter` was added with explicitly non-throwing semantics. `src/tasks/markdown.ts:83-148` (`parseTaskFrontmatterUncached`) has two failure paths and neither throws:

- No `---\n…\n---` block at all → `return {};`
- `YAML.parse` throws or returns a non-object → `return parseTaskFrontmatterLineFallback(fmBlock);`

`parseTaskFrontmatterLineFallback` (`markdown.ts:164-198`) salvages top-level scalars (`id`, `title`, `project`, `status`, `priority`, `effort`, `context`, `created`, `source`, `proposal`, `deferred_launch`, `url`, `slot`, `adapter`, `milestone`, `elaborated`, `merged_into`, `skip_plan`, `uses_browser`, `started`, `completed`, `modified`, `deadline`). Nested fields (`dependencies`, `requirements`, `merged_from`, `t3code_threads`, `github_*`) are *not* populated by the salvage path.

### Round-1 / round-2 history

- Round 1 of task-d68d485a merged the migration (`c6dd955`) but kept the legacy try/catch wrappers in place at the call sites — flagged as out-of-scope simplification by the reviewer.
- **Round 2 (commit `5253e2f`)** added explicit `if (!fm.dependencies) continue;` guards in `healBlockedByLinks` and `tasksReconcileBlockedStatus` after a codex P1 review caught a behaviour-change bug: `tasksReconcileBlockedStatus` had been silently treating malformed-YAML tasks as having no blockers, rewriting `status: blocked` → `status: ready`. The `!fm.dependencies` guard fixed that. A regression test was added at `sync.test.ts:259-291`.
- This task drops the now-pointless `try/catch` wrappers across all four sites, relying on the explicit empty/partial-FM guards already present (sites 2/3) or on guards that already correctly handle the salvage case (sites 1/4).

### Four sites, not three (correction to original suggestion)

The retrospective note from task-d68d485a flagged three sites (`healBlockedByLinks`, `tasksReconcileBlockedStatus`, `tasksMilestoneWarnings`). During elaboration a fourth site was found: `tasksUpdate` at `src/tasks/sync.ts:427-432`. All four are in scope.

### Sweep verification

- `grep -rnP "try\s*\{[^}]*parseTaskFrontmatter" src/` only catches the single-line shape (site #2). The three multi-line shapes need a multi-line scan; they are accounted for above.
- All `try {` lines in `sync.ts` enumerated: lines 54, 232, 322 wrap `JSON.parse`/`new URL` (unrelated, leave alone); lines 429, 678, 736, 783 are the cleanup targets.
- All other `parseTaskFrontmatter` call sites repo-wide (in `mag.ts`, `dashboard-server.ts`, `notify.ts`, `slots/index.ts`, `markdown.ts`, and tests) do not use try/catch around the parser.

### Edge case worth flagging (not in scope, but informs review)

`slots/index.ts:814` uses a separate `readRawEffortField` helper to avoid `parseTaskFrontmatter`'s default-drift on missing `effort:` (parser normalizes to `"medium"`). None of the four cleanup sites have an analogous "must distinguish missing vs. defaulted" requirement — the `?? "ready"` in `tasksMilestoneWarnings` even matches the parser's own default for `status`.

## Approach

Per-site removal, in the order they appear in the file:

1. **`tasksUpdate` (~line 427-432)** — replace the `let fm; try { fm = parseTaskFrontmatter(content); } catch { continue; }` block with `const fm = parseTaskFrontmatter(content);`. The next line `if (!fm.id) continue;` is preserved verbatim. Salvage populates `id` for any recoverable file; truly missing FM yields `{}` and the `!fm.id` guard correctly skips it. Optionally add a one-line comment for symmetry with sites #2/#3 noting the guard handles the empty-FM case (low priority — keep change minimal).

2. **`healBlockedByLinks` (~line 678)** — replace the single-line `let fm; try { fm = parseTaskFrontmatter(content); } catch { continue; }` with `const fm = parseTaskFrontmatter(content);`. Both subsequent guards (`!fm.id` and `!fm.dependencies`) are preserved.

3. **`tasksReconcileBlockedStatus` (~line 736)** — replace the multi-line try/catch with `const fm = parseTaskFrontmatter(content);`. Preserve the comment block at lines 739-744 explaining the `!fm.dependencies` guard, and the guard itself.

4. **`tasksMilestoneWarnings` (~line 783)** — replace the multi-line try/catch with `const fm = parseTaskFrontmatter(content);`. The downstream code already handles empty-FM correctly: `status ?? "ready"` matches the parser default; `milestonesProjects.has(fm.project ?? "")` returns false for empty `project`; the final `fm.id` truthy check prevents pushing an empty id.

Then run the full verification gauntlet: `bun run typecheck && bun run lint && bun run build && bun test`. Particular care that `sync.test.ts:259-291` still passes (it is the direct regression test for site #3).

No new tests required — the existing regression test already covers the most subtle invariant (malformed YAML doesn't get `status: blocked` silently rewritten). Adding tests for the other three sites would test the parser's contract more than the call sites' behaviour, which is out of scope.
