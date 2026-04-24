# Fix `proposalFreshnessWarning` to count commits on `origin/main`

## Goal

`proposalFreshnessWarning` in `src/orchestration/skills.ts` currently runs
`git rev-list --count <hash>..HEAD` to estimate "commits since the proposal
was authored." In orchestration worktrees `HEAD` is a feature branch like
`ludics/gh-ludics-NNN-sN/root`, not `main`, so the count conflates two
unrelated quantities:

- feature-branch churn since the branch point (what the current command
  dominantly reports), and
- upstream drift on the default branch since the proposal was written (what
  the Goal phrasing in the JSDoc actually promises).

This mismatch was documented in the gh-ludics-311 retrospective and a
regression test currently locks in the branch-neutral wording
(`expect(warning).not.toContain("main")`). This proposal flips that: align
the git command with the user-facing intent, refresh the test semantics, and
import the default-branch helper consolidated by task-b0d4f45b.

Tracking task: `task-41752614`. Related retrospective: `gh-ludics-311`.

## Acceptance Criteria

1. `proposalFreshnessWarning(projectDir, proposalPath)` counts commits on the
   remote default branch using `git rev-list --count <hash>..origin/<default>`,
   where `<default>` is resolved via `detectDefaultBranches` imported from
   `src/git-runner.ts`. The function retains its "return `""` on any failure"
   contract.
2. When the `origin` remote has no detectable default branch
   (`detectDefaultBranches(...).origin === null`), the helper returns `""`
   (no warning). Orchestration must not be blocked on exotic repo
   configurations.
3. When the proposal commit is not an ancestor of `origin/<default>` (i.e.,
   the proposal file's last-modifying commit hasn't landed on the default
   branch yet), the helper returns `""`. Implemented via
   `git merge-base --is-ancestor <hash> origin/<default>`. This is the
   conservative choice: we can't meaningfully quantify "drift on main since a
   commit that isn't on main yet," so we stay silent rather than emit a
   potentially misleading count.
4. The fixture `initGitRepoWithProposal` in `src/orchestration/skills.test.ts`
   creates `refs/remotes/origin/<default>` pointing at a commit that includes
   the proposal commit plus the requested number of trailing empty commits.
   Use `git update-ref refs/remotes/origin/main HEAD` (or `master` when that
   branch is exercised) after the final commit. Existing stale / fresh /
   boundary tests must pass against the new counting semantics.
5. The `expect(warning).not.toContain("main")` assertion in the "warns when
   proposal is 15 commits stale" test is replaced with a semantic assertion
   over the count produced by the new command (the existing
   `toContain("15 commits")` assertion already covers this; the
   `not.toContain("main")` line is removed along with its explanatory
   comment). The warning text is permitted — but not required — to mention
   the default branch.
6. A new test exercises the feature-branch divergence case: a worktree on a
   feature branch with `F` additional feature commits past
   `refs/remotes/origin/main`, where `origin/main` has `M` commits after the
   proposal's commit. The test asserts that the reported count is `M`, not
   `M + F`. Use `M = 12` and `F = 7` (both above the threshold so the test
   is insensitive to fencepost errors on the threshold itself).
7. A new test exercises the `origin`-null case: repository has no `origin`
   remote and no `refs/remotes/origin/*` refs. The helper returns `""` and
   `PROPOSAL_FRESHNESS_WARNING` is the empty string.
8. A new test exercises the unreachable-proposal case: the proposal commit
   exists in the worktree but is not an ancestor of
   `refs/remotes/origin/main` (e.g., proposal committed on a side branch,
   `origin/main` pointed at a commit preceding the proposal). The helper
   returns `""`.
9. No changes outside the helper, its fixtures, and its tests. In
   particular: `PROPOSAL_FRESHNESS_THRESHOLD` stays at `10`; the warning
   template wording is unchanged except for any minor phrasing adjustment
   required to honour the semantic change (none is anticipated — the
   template already says "commits have landed in this repo", which remains
   accurate and need not be touched); `buildSkillContext` is unchanged.
10. `bun test src/orchestration/skills.test.ts` passes. Full `bun test` and
    `bun run build` remain green. No new lint warnings.

## Context

### Files and symbols

- `src/orchestration/skills.ts`
  - Module-level constant `PROPOSAL_FRESHNESS_THRESHOLD = 10` — unchanged.
  - Local `gitOutput(cwd, args)` thin wrapper over `safeSyncOutput` — returns
    trimmed stdout or `null`. Reused by the new command.
  - `proposalFreshnessWarning(projectDir, proposalPath)` — the target.
    Current body:

    ```
    const hash = gitOutput(projectDir, ["log", "-1", "--format=%H", "--", proposalPath]);
    if (!hash) return "";
    const countStr = gitOutput(projectDir, ["rev-list", "--count", `${hash}..HEAD`]);
    ```

  - JSDoc line ending `… regardless of branch.` — needs updating to reflect
    the new `origin/<default>` semantics.
  - Caller `buildSkillContext(state, agent)` — invokes the helper and
    interpolates the result into `PROPOSAL_INSTRUCTION` and
    `PROPOSAL_FRESHNESS_WARNING` keys. No changes needed.
- `src/git-runner.ts`
  - `detectDefaultBranches(cwd, runGit): { origin: string | null; upstream: string | null }`
    — local-only (no network). Primary: `git symbolic-ref
    refs/remotes/<remote>/HEAD`; fallback: `git rev-parse --verify --quiet
    refs/remotes/<remote>/{main,master}`; returns `null` when neither
    resolves.
  - `defaultRunGit: RunGit` — production runner that shells via
    `safeSyncOutput`. Use this to satisfy `detectDefaultBranches`'
    `RunGit`-shaped signature without refactoring `proposalFreshnessWarning`
    to thread an injected runner.
- `src/orchestration/skills.test.ts`
  - Fixture `initGitRepoWithProposal(projectDir, proposalRelPath,
    proposalBody, extraCommits)` — needs the trailing `git update-ref`
    addition.
  - Test block `// PROPOSAL_FRESHNESS_WARNING tests (gh-ludics-311)` (around
    line 587) — site for the new test cases and the `not.toContain("main")`
    removal.

### Existing integration patterns to copy

- `src/staging-ff.ts` imports `detectDefaultBranches` from `./git-runner.ts`
  and calls it with an injected `RunGit` (via `opts.runGit`). The
  orchestration-skills path doesn't currently carry a `RunGit` seam and the
  task brief keeps this task narrow, so call
  `detectDefaultBranches(projectDir, defaultRunGit)` directly instead of
  refactoring for injection.

### Why the conservative unreachable-proposal gate

Option space documented during elaboration:

- **Gate with `merge-base --is-ancestor`, return `""` on non-ancestor**:
  silences the warning when we can't quantify "drift on main since a commit
  that hasn't reached main yet." Loses a genuine signal in the rare case
  where a proposal is authored in the worktree before its PR merges, but
  preserves the "never misleading" contract.
- **Emit anyway** (`hash..origin/main` against a non-ancestor returns the
  count of all commits on `origin/main` after the proposal's branch point —
  typically a huge, alarming number): risks noisy warnings on proposals that
  are perfectly current just not yet merged.

The conservative option wins because (a) the helper's contract is
"failure-tolerant by design" — it already returns `""` in many non-error
states, (b) proposals typically land on main before the implementing task's
first orchestrated round (per the PR-343 timeline documented in the task's
elaboration), so non-ancestor should be uncommon at steady state, and (c) a
false-positive here would undermine trust in the warning more than a silent
false-negative.

### Freshness of `refs/remotes/origin/main`

Inside an orchestration worktree, `refs/remotes/origin/main` is only as
fresh as the last `git fetch origin` in that checkout. This task does **not**
add a per-call fetch inside `proposalFreshnessWarning` — the helper runs on
every skill-context build and the per-call latency would compound. Freshness
is delegated to task-91667552's planned plan-entry / work-entry
`git fetch origin main` (a linear, non-conflicting fetch appropriate for
GitHub-hosted main branches). Before 91667552 lands, this task still
improves on the status quo — the count is bounded by the ref's staleness
rather than by arbitrary feature-branch divergence — but may under-report
when the local `origin/main` is old.

### Sequencing

Unblocked: task-b0d4f45b completed on 2026-04-23, so `detectDefaultBranches`
is available in `src/git-runner.ts` today. No other dependency is blocking
this task's implementation. The proposal-commit freshness guarantee improves
further once task-91667552 lands, but this task should not wait for it.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Sketch of the new helper body:

```
function proposalFreshnessWarning(projectDir: string, proposalPath: string): string {
  if (!proposalPath || proposalPath === "inline") return "";
  try {
    assertRepoRelativeProposalPath(proposalPath);
  } catch {
    return "";
  }
  const hash = gitOutput(projectDir, ["log", "-1", "--format=%H", "--", proposalPath]);
  if (!hash) return "";
  const { origin } = detectDefaultBranches(projectDir, defaultRunGit);
  if (!origin) return "";
  const ref = `refs/remotes/origin/${origin}`;
  // Gate: proposal commit must be reachable from origin/<default>.
  const isAncestor = safeSyncOutput(
    ["git", "merge-base", "--is-ancestor", hash, ref],
    { cwd: projectDir },
  );
  if (!isAncestor.ok || isAncestor.exitCode !== 0) return "";
  const countStr = gitOutput(projectDir, ["rev-list", "--count", `${hash}..${ref}`]);
  if (!countStr) return "";
  const count = Number.parseInt(countStr, 10);
  if (Number.isNaN(count)) return "";
  if (count <= PROPOSAL_FRESHNESS_THRESHOLD) return "";
  return `\n\n> **Freshness warning**: ${count} commits have landed in this repo since the proposal file was last updated. ...`;
}
```

Notes on the sketch:

- `merge-base --is-ancestor` exits 0 when `hash` is an ancestor of `ref`
  and 1 when it is not. Other exit codes are errors (e.g., ref missing).
  All non-zero outcomes should be treated identically to "cannot
  determine" → return `""`. The existing `gitOutput` helper only returns
  stdout, so the `is-ancestor` check needs a dedicated call that inspects
  the exit code; use `safeSyncOutput` directly for that one line, or add a
  tiny `gitExitCode` helper alongside `gitOutput` if the reviewer prefers.
- The JSDoc `Warning copy stays branch-neutral because \`hash..HEAD\`
  counts commits reachable from the current HEAD in \`projectDir\`,
  regardless of branch.` line should be rewritten to describe the new
  `origin/<default>` semantics and the is-ancestor gate.
- Fixture update:

  ```
  // after the loop that adds extraCommits:
  runGit(projectDir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  ```

  This puts `origin/main` at HEAD so `hash..origin/main` returns
  `extraCommits`. The existing stale/fresh/boundary tests then translate
  1:1 to the new command without changing their counts.
- Feature-branch test construction: use `initGitRepoWithProposal` to seed
  12 main-side commits, then `git checkout -b feature` and add 7 empty
  commits. Do NOT move `refs/remotes/origin/main` after the feature
  branch — it must continue pointing at main's tip. Assert the warning
  contains `"12 commits"` and does not contain `"19 commits"`.
- Unreachable-proposal test: init the repo and commit the proposal, then
  create an empty commit and point `refs/remotes/origin/main` at that
  commit (the proposal commit is parent of origin/main — ancestor, not the
  unreachable case). To construct the unreachable case: init; make 11
  empty commits; mark `refs/remotes/origin/main` at the last one; then
  `git checkout -b side` at the first commit and add the proposal commit.
  Now the proposal is not an ancestor of `origin/main`. Assert the warning
  is `""`.
- `origin`-null test: `initGitRepoWithProposal` with 15 extra commits but
  skip the `update-ref` call (either pass a flag or factor a helper).
  Assert the warning is `""`.

Keep the diff small: the helper grows ~10 lines, the fixture grows 1 line
(plus a variant for the no-origin test), and the test file grows by three
new `test(...)` blocks.

## Scope

**In scope**:

- `proposalFreshnessWarning` in `src/orchestration/skills.ts` — git
  command, default-branch resolution, is-ancestor gate, JSDoc refresh.
- `src/orchestration/skills.test.ts` — fixture update, removal of the
  `not.toContain("main")` assertion, three new test cases (feature-branch
  divergence, `origin`-null, unreachable proposal).
- Import of `detectDefaultBranches` (and `defaultRunGit`) from
  `src/git-runner.ts`.

**Out of scope**:

- Moving `PROPOSAL_FRESHNESS_THRESHOLD` into project config (item #3 in the
  gh-ludics-311 `suggestRefactorSummary`, deferred separately).
- Memoising the git calls (item #2, explicitly deferred in the task).
- Warning template wording changes beyond the minimum required by the
  semantic change — the existing template remains accurate.
- Adding a per-call `git fetch origin main` inside the helper (delegated to
  task-91667552's plan-entry / work-entry fetch).
- Refactoring `proposalFreshnessWarning` to accept an injected `RunGit`
  (would widen the diff; the current `defaultRunGit`-direct call is
  acceptable because tests exercise real git via the fixture).

**Dependencies**:

- task-b0d4f45b (done 2026-04-23) — provides `detectDefaultBranches` in
  `src/git-runner.ts`. No remaining blocker.
- task-91667552 (upcoming) — complements this task by refreshing
  `refs/remotes/origin/main` via plan/work-entry fetches. This task lands
  independently and benefits from 91667552 automatically once 91667552
  ships.
