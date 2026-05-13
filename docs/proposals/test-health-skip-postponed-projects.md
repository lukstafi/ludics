# test-health: skip postponed projects

## Goal

`runAllTestHealth` (and its single-project entry point `checkProjectTestHealth`)
currently iterate over every entry in `config.projects` without consulting
`postponedProjectSet()`. As a result, postponed projects whose worktrees are
still empty stubs get `dune runtest` (or equivalent) invoked against them,
which fails with "I cannot find the root of the current workspace/project."
and triggers `tasksCreate("Fix broken test suite: <name>", …)`. The
auto-filed task that prompted this proposal — task-20e5dfce, originally
targeted at `ocaml-hipjit` — is the visible symptom.

Postponed projects are already treated as "not active work" everywhere else
in the codebase (`src/flow.ts` filters them from the ready queue;
`src/mag.ts` skips them when evaluating task eligibility). Test-health is
the lone holdout. Aligning it with the existing convention removes a class
of spurious auto-filed tasks and stops polluting `mag/test-health.json`
with permanently-red entries for repos that nobody intends to test yet.

## Acceptance Criteria

1. **Per-project guard in `runAllTestHealth`** — when iterating projects,
   any project whose name is in `postponedProjectSet()` (case-insensitive,
   matching the existing `mag.ts:2156` and `mag.ts:2411` convention of
   `.has(name.toLowerCase())`) is skipped without invoking
   `checkProjectTestHealth`. The skip is logged to stderr in the same
   `[test-health] <name>: skipped (postponed)` style used for other skip
   reasons, so dashboard log scraping continues to work.

2. **Defence-in-depth guard in `checkProjectTestHealth`** — the same
   `postponedProjectSet()` check appears at the entry of
   `checkProjectTestHealth`, before the `existsSync(projectPath)` check.
   When the project is postponed, the function returns
   `{ skipped: true, reason: "postponed" }`. This protects the
   `--project <name> --force` CLI path, which calls
   `checkProjectTestHealth` directly without going through the batch loop.

3. **No state mutation on skip** — `mag/test-health.json` is not written
   when a postponed project is skipped. This matches the existing skip
   contract for `path-not-found`, `no-test-command`, and `rate-limited`
   (none of which call `saveTestHealthState`). The schema of
   `TestHealthState` remains unchanged — no new `skipped` / `reason` fields
   are persisted.

4. **No auto-filed follow-up task** — `tasksCreate("Fix broken test suite:
   <name>", …)` is not reachable from the postponed-skip path. The current
   call lives inside the `!passed` branch which is guarded by the
   `skipped: false` exit; the new early returns sit above it, so no
   additional change is required, but the behaviour must be preserved.

5. **Unit test coverage in `src/health.test.ts`** — at least one test
   exercises each of the two guards:
   - `runAllTestHealth` skips a postponed project with `test_command` set,
     and `checkProjectTestHealth` returns `{ skipped: true, reason:
     "postponed" }` for that project.
   - The test must use `_resetPostponedProjectsCache()` (already exported
     from `config.ts` for exactly this purpose) to avoid cross-test
     pollution of the singleton cache.
   - Verification: `bun test src/health.test.ts` from the project root
     passes; `grep -n '"postponed"' src/health.test.ts` returns the new
     assertion(s).

6. **No CLI / integration test added** — a single-condition guard does not
   warrant a separate `ludics test-health --force` integration test
   (per user-confirmed scope decision recorded in the task Notes section).

7. **Stale `mag/test-health.json` cleanup is handled out-of-band**
   (see Notes / Risks below). This PR does not modify any file under
   `~/self-improve/harness/` — it lives in the harness state repo, not in
   `~/ludics`. The Mag orchestrator runs the one-shot delete after the PR
   merges.

### AC verification reachability

All ACs verify against files inside the `~/ludics` git tree (`src/health.ts`,
`src/health.test.ts`) — no cache, generated-artefact, or
parent-symlinked path is involved. Standard `git -C <project>` + `bun
test` evidence is sufficient; the "find/grep over commit-SHA when the
path is outside project git context" rule does not apply here.

## Context

**Test-health entry points** (`src/health.ts`):
- `runAllTestHealth({ project?, force? })` — iterates `config.projects`,
  applies the optional `--project <name>` filter, and dispatches each
  project to `checkProjectTestHealth` inside a try/catch. This is the
  function the nightly launchd schedule calls.
- `checkProjectTestHealth(project, { force? })` — does the actual work:
  resolves the project path, picks a test command (via `test_command`
  config or `detectTestCommand`), checks `shouldRunTestHealth` (unless
  forced), runs the test suite via `safeSyncOutput`, persists the result
  to `mag/test-health.json`, and files a "Fix broken test suite" task on
  failure. Reachable directly from the CLI's `ludics test-health
  --project <name> --force` path.

**The postponed-project filter convention** (`src/config.ts`):
- `postponedProjectSet(): ReadonlySet<string>` — cached singleton built
  from `postponedProjects()`. Lookup pattern is uniform:
  `postponedProjectSet().has(name.toLowerCase())`.
- `_resetPostponedProjectsCache(): void` — test-only hook to drop the
  cache between cases. Already used by other tests that mutate
  `config.yaml` fixtures.

**Existing skip-reason vocabulary** in `checkProjectTestHealth`:
`path-not-found`, `no-test-command`, `rate-limited`. The new value
`postponed` joins this set; no schema change because
`TestHealthResult.reason` is already typed as `string`.

**Existing skip log format** in `runAllTestHealth`:
`[test-health] ${p.name}: skipped (${result.reason})` — the new path
reuses this exact format, so dashboard log parsers (if any) continue to
work unchanged.

**Sibling implementations to mirror**:
- `src/mag.ts` (task-eligibility loop):
  `if (projectName && postponedProjectSet().has(projectName.toLowerCase())) continue;`
- `src/mag.ts` (project-iteration loop):
  `if (postponedProjectSet().has(project.toLowerCase())) continue;`
- `src/flow.ts` (ready-queue filter): uses
  `const postponed = postponedProjectSet();` followed by `.has(name.toLowerCase())`.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The mechanical change is ~10 lines:

1. In `runAllTestHealth`, immediately after the
   `if (options?.project && p.name !== options.project) continue;` line,
   add:
   ```ts
   if (postponedProjectSet().has(p.name.toLowerCase())) {
     console.error(`[test-health] ${p.name}: skipped (postponed)`);
     continue;
   }
   ```
2. In `checkProjectTestHealth`, before the `existsSync(projectPath)` line,
   add:
   ```ts
   if (postponedProjectSet().has(project.name.toLowerCase())) {
     return { skipped: true, reason: "postponed" };
   }
   ```
3. Add `postponedProjectSet` to the existing
   `import { … } from "./config.ts";` at the top of `health.ts`.
4. Extend `src/health.test.ts` with one `describe` block that:
   - writes a temporary `config.yaml` with one postponed project whose
     `test_command` is set to something that would clearly fail if run
     (e.g. `false`), points `LUDICS_STATE_PATH` at the temp dir,
   - calls `_resetPostponedProjectsCache()`,
   - asserts `checkProjectTestHealth` returns `{ skipped: true, reason:
     "postponed" }` and that `mag/test-health.json` does not gain an
     entry for the postponed project,
   - optionally calls `runAllTestHealth({ project: <name> })` and asserts
     the skip log is emitted (capture via the existing stderr-capture
     helper used elsewhere in the test suite, if convenient).

If the existing test scaffolding makes one of these assertions awkward,
prefer keeping the test minimal — the `checkProjectTestHealth` return
value is the load-bearing assertion; the stderr log is observational.

## Scope

**In scope:**
- `src/health.ts` — two new guard clauses, one import addition.
- `src/health.test.ts` — one new test (or describe block).

**Out of scope:**
- Any change to `TestHealthState` or `TestHealthEntry` schema.
- Any change to the dashboard's test-health view (it reads
  `mag/test-health.json` directly; once the stale `ocaml-hipjit` entry is
  removed it will go green on its own).
- Any cleanup of `mag/test-health.json` — that file lives in the harness
  state repo (`~/self-improve/harness/mag/`), not in `~/ludics`. The Mag
  orchestrator handles the one-shot delete after this PR merges (see
  Risks / Notes).
- CLI integration tests for `ludics test-health --force`.
- Re-evaluating which projects are marked `postponed: true` in
  `config.yaml` — that's an orthogonal user decision.

**Dependencies:** none. The task is independent of other in-flight work.

## Risks / Notes

- **Harness-side cleanup is split from this PR.** The auto-filed
  `ocaml-hipjit` entry in `~/self-improve/harness/mag/test-health.json`
  must be removed for the dashboard to reflect the fix. That delete
  happens in the harness state repo and is the Mag orchestrator's
  responsibility post-merge — it is not staged in this PR because the
  draft-proposal worker conventions restrict PR scope to the project
  repo. If the orchestrator forgets, the dashboard will continue to
  show ocaml-hipjit red until the next manual sweep; the auto-filed
  task however will not re-appear, because the fix prevents
  `runAllTestHealth` from re-writing the entry.
- **Cache pollution between tests.** `postponedProjectSet()` memoises a
  ReadonlySet keyed off the loaded config. Tests that mutate
  `config.yaml` fixtures must call `_resetPostponedProjectsCache()`
  before each assertion. This is the existing convention; the new test
  follows it.
- **Case sensitivity.** The existing convention is
  `.has(name.toLowerCase())`. The new code mirrors that exactly to avoid
  the bug where a config entry `Project: ocaml-hipjit` would slip past a
  literal `.has("ocaml-hipjit")` check.
