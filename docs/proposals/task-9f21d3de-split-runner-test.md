# Split `src/orchestration/runner.test.ts` into topic-coherent files

## Goal

`src/orchestration/runner.test.ts` has grown to 3868 lines, 35 top-level
`describe` blocks, and 184 `test()` cases. It covers turn/agent lifecycle,
hung-agent detection, PR-comment monitoring, auto-commit phase side effects,
verification gates, and phase-skipping plumbing — all in one file.

This size imposes concrete costs:

- **Localized failures**: a single-topic regression requires re-reading or
  re-running the whole file.
- **Compile / IDE responsiveness**: TypeScript compilation and editor
  navigation both scale with file size.
- **AI-agent context budget**: agents editing a narrow part of the runner
  must load 3868 lines into context to safely change any one section.

A mechanical split by topic — no test-behavior changes — resolves all three
without touching `src/orchestration/runner.ts` itself.

No GitHub issue. Follow-up suggested during retrospective of `task-d1932b8f`
(simplify upstream workflow).

## Acceptance Criteria

1. **Six cluster files** exist under `src/orchestration/`, each containing the
   describe blocks specified in the Approach section below:
   - `runner.lifecycle.test.ts`
   - `runner.hung-agents.test.ts`
   - `runner.pr-comments.test.ts`
   - `runner.auto-commit.test.ts`
   - `runner.verification.test.ts`
   - `runner.phase-skipping.test.ts`

2. **Shared helpers module** `src/orchestration/runner.test-helpers.ts`
   exists and exports the helpers used across clusters (`makeTmpDir`,
   `makeGitRepo`, `makeLifecycle`, `makeState`, `markAgentDone`,
   `makePeerSyncDir`, `makeSnapshot`, `makeMockTransport`, `noopTransport`).
   File name MUST NOT end in `.test.ts` (bun's test runner would pick it up
   as an empty test file).

3. **Original file removed**: `src/orchestration/runner.test.ts` no longer
   exists in the repository after the split. All 184 `test()` cases are
   preserved, redistributed across the cluster files.

4. **Test count preserved**: running `bun test src/orchestration/runner*.test.ts`
   before and after the split yields the same **184** passing tests. The
   reviewer-sanity invariant of the task.

5. **gh-ludics-199 "Testing pattern" banner centralised**: the
   `spyOn`/`mockRestore` banner comment currently at the top of
   `runner.test.ts` lives only in `runner.test-helpers.ts` after the split.
   Cluster files pick it up transitively via their helpers import rather
   than each duplicating the banner.

6. **Late helpers stay local**: `initGitRepo`, `gitLastCommitMsg`, and
   `gitCommitCount` (the three auto-commit-only helpers currently at
   `runner.test.ts:1759-1783`) remain inline at the top of
   `runner.auto-commit.test.ts`. They are not moved into the shared module.

7. **`docs/testing-patterns.md` updated**: the two references to
   `src/orchestration/runner.test.ts` (lines 52 and 73 as of 2026-04-23) are
   updated. Either point to `runner.lifecycle.test.ts` (largest cluster) or
   broaden to the `src/orchestration/runner.*.test.ts` pattern — implementer's
   choice.

8. **Typecheck and lint pass**: `bun run typecheck` and the existing
   `lint:no-mock-module` (and other `lint:*` scripts) continue to pass
   against the new file layout.

9. **`src/orchestration/runner.ts` is not modified** by this PR. The task
   is a test-file refactor only.

## Context

### File under split

`src/orchestration/runner.test.ts` — 3868 lines, 35 `describe` blocks, 184
`test()` cases. The task file's Tentative Design section enumerates all 35
describe blocks in file order; that inventory is the source of truth for
cluster membership.

### Shared helpers currently defined in `runner.test.ts`

Used across multiple clusters — extract to the new helpers module:

- `makeTmpDir`, `makeGitRepo` — filesystem/git fixture setup
- `makeLifecycle`, `makeState` — `AgentTurnLifecycle` / `OrchestrationState`
  fixtures
- `markAgentDone` — peer-sync "done" fixture
- `makePeerSyncDir` — peer-sync directory fixture used by `orchOnStop` tests
- `makeSnapshot`, `makeMockTransport`, `noopTransport` — transport / snapshot
  fakes

Approximately 280 lines total. They close over no shared state; extraction is
a straight move + `export`.

### Late helpers (stay local)

`initGitRepo`, `gitLastCommitMsg`, `gitCommitCount` at
`runner.test.ts:1759-1783` — only exercised by `autoCommitAgent` and
`autoCommitAllAgents`. Keep inline at the top of `runner.auto-commit.test.ts`.

### External files that reference the runner test

- `docs/testing-patterns.md` — two mentions (currently lines 52, 73). Update
  as part of this PR (Acceptance Criterion 7).
- `docs/proposals/auto-commit-round-prefix.md` — references
  `runner.test.ts:1664-1821`. Already stale line numbers; not in scope to fix.
- `docs/proposals/gh-ludics-199.md` — documents the "Testing pattern" banner
  step. Historical; not in scope to fix.
- `docs/proposals/task-5199318d-test-harness-isolation.md` — enumerates files
  that manually save/restore `LUDICS_HARNESS_DIR`. The three affected describe
  blocks (`orchOnStop handler`, `snapshot reconciliation for stuck dispatched`,
  `post-nudge outcome classification`) migrate to their cluster files with
  the save/restore pattern intact; this proposal file itself is a historical
  pointer and is not in scope to rewrite.

### Build / CI touchpoints

- `bun test` discovers by glob (`**/*.{test,spec}.{ts,tsx,js,jsx}`). New
  `runner.*.test.ts` files are picked up automatically.
- `src/test-setup.ts` is preloaded and provides `LUDICS_HARNESS_DIR`
  isolation for all tests regardless of file name. No change needed.
- `.github/workflows/ci.yml` does **not** invoke `bun test`. CI runs
  `typecheck`, `build`, and three lint scripts. No workflow change needed.
- `bun test --bail` behaviour is unaffected: `--bail=N` stops on the Nth
  failing test across the whole run, irrespective of file names.

### Invariants preserved by the split

- `spyOn` + `mockRestore` discipline (enforced by `lint:no-mock-module` and
  by the testing-patterns.md banner) is intrinsic to each describe block —
  moving blocks between files does not change it.
- No cross-test coupling observed: each test creates fresh tmp/git dirs via
  `makeTmpDir()` + `makeGitRepo()`. Safe to split.
- Test ordering within a file is deterministic (Bun preserves within-file
  order); cross-file ordering is not guaranteed, but no test depends on
  cross-file ordering today.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

### Cluster membership (source of truth for Acceptance Criterion 1)

**`runner.lifecycle.test.ts`** (~700–800 lines) — turn/agent lifecycle primitives
- `updateTurnLifecycle` (state machine)
- `stop-hook fast-complete path`
- `orchOnStop handler`
- `refreshAgentStatuses`
- `orchOnStop env-var fallback`
- `AgentTurnLifecycle state machine via isAgentDone`
- `snapshot reconciliation for stuck dispatched`
- `agent marker files`
- `crash-recovery dispatch dedup`

**`runner.hung-agents.test.ts`** (~280 lines) — stall detection / nudging
- `detectAndNudgeHungAgents`
- `post-nudge outcome classification`

**`runner.pr-comments.test.ts`** (~650 lines) — PR comment monitoring + review plumbing
- `checkAndRedispatchPrComments deferred review fallback`
- `checkAndRedispatchPrComments conflict detection`
- `checkAndRedispatchPrComments merge detection`
- `resetPrCommentsState`
- `maybePostCodexReviewRequests`
- `pairReviewVerdict`

**`runner.auto-commit.test.ts`** (~200 lines) — auto-commit phase side effects
- `autoCommitAgent`
- `autoCommitAllAgents`
- Local helpers: `initGitRepo`, `gitLastCommitMsg`, `gitCommitCount` (inline at top).

**`runner.verification.test.ts`** (~900 lines) — verify / validate phase gates
- `phase-specific artifact validation`
- `handleVerifyFailure`
- `handleVerifyFailure — has_questions`
- `checkZeroCommitsAutoBailOut`
- `isWorktreeNoOp`
- `early work-phase no-op detection`
- `getFirstPrUrl`
- `verifyPhaseOutcome (PR_CREATE_GATE)`
- `verifyPhaseOutcome (FINAL_MERGE_GATE)`
- `validatePreviousPhaseArtifacts`
- `validateAgentPrFiles (eager repair)`
- `validateAndFixPrFile --repo argument`

**`runner.phase-skipping.test.ts`** (~450 lines) — phase transition plumbing
- `preparePhaseRedispatch`
- `skipToPhase`
- `phase-entry status reset`
- `previousPhaseCtx persistence`

### Execution outline

1. Create `src/orchestration/runner.test-helpers.ts` with the nine shared
   helpers (`export`-ed) and the gh-ludics-199 "Testing pattern" banner
   comment at the top.
2. Create the six cluster files. Each imports its required helpers from
   `./runner.test-helpers.ts` and its production deps from the same modules
   that `runner.test.ts` imports today (`./runner.ts`, `./phases.ts`,
   `./transport-t3code.ts`, `./index.ts`, `./peer-sync.ts`, `./state.ts`,
   `../events.ts`, `../config.ts`, `../notify.ts`, `../spawn.ts`, plus the
   type-only imports from `../t3code/types.ts` and `./transport.ts`, trimmed
   per cluster).
3. Inline `initGitRepo`, `gitLastCommitMsg`, `gitCommitCount` at the top of
   `runner.auto-commit.test.ts` only.
4. Delete `src/orchestration/runner.test.ts`.
5. Update `docs/testing-patterns.md` lines 52 and 73 to point at the new
   layout.
6. Verify: `bun test src/orchestration/runner*.test.ts` reports **184** tests,
   all passing. `bun run typecheck` passes. `bun run lint:no-mock-module`
   passes.

### Safe-move checklist (per cluster file)

- Preserve each describe block's `beforeAll` / `afterAll` / `beforeEach` /
  `afterEach` hooks intact.
- The three blocks that mutate `process.env.LUDICS_HARNESS_DIR`
  (`orchOnStop handler`, `snapshot reconciliation for stuck dispatched`,
  `post-nudge outcome classification`) already pair save/restore — move
  them verbatim.
- Imports: start from the union of imports in `runner.test.ts`, then trim
  per file to only what that cluster references. Leaving a small number of
  unused-but-harmless imports is acceptable; `lint:*` does not currently
  fail on unused imports.

## Scope

**In scope**
- Create `runner.test-helpers.ts`.
- Create six `runner.*.test.ts` cluster files with the membership specified
  above.
- Delete the original `runner.test.ts`.
- Move the gh-ludics-199 "Testing pattern" banner into
  `runner.test-helpers.ts`.
- Update `docs/testing-patterns.md` to reflect the new layout.

**Out of scope**
- Any change to `src/orchestration/runner.ts`.
- Test-helper deduplication beyond moving the nine helpers listed above
  (e.g. do not try to unify with `phases.test.ts`'s own `makeState`).
- Rewriting flaky tests — fix those in a dedicated task.
- Fixing stale line-number references in other proposal/retrospective
  documents (e.g. `docs/proposals/auto-commit-round-prefix.md`). Those
  are historical.
- CI workflow changes — none are needed.

**Dependencies**
- Related: `task-d1932b8f` (simplify upstream workflow) — completed; this
  task is its retrospective follow-up.
- No blocking dependencies.
