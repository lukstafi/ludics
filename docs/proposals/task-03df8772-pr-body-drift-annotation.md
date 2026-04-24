# Annotate PR when branch drifts from the commit count at PR-create time

## Goal

When the runner detects during `pr-comments` that an agent's PR branch has
gained (or lost) commits since the PR body was last written, post a short
notice comment to the PR so the human reviewer sees "body may be stale" at
a glance. The notice fires once per drift transition, not on every poll.

Source: retrospective on `gh-ludics-310` (item 5). PR #344 had a body written
against the pre-rebase branch (one commit, 1073 tests); after rebase +
force-push + test-coverage commit, the body silently desynced (two commits,
1145 tests). The coder ran `gh pr edit` manually to refresh. The goal here is
to make silent drift visible to the reviewer without requiring an operator to
read runner logs.

Related: sibling `task-91667552` adds runner-emitted warnings at plan-time
(stale base, missing `## Regression Tests` section) — same runner-side
early-warning layer, different phase. This proposal does not expand on that
scope.

## Acceptance Criteria

1. **Baseline capture at pr-create completion.** The first time an agent's
   `prUrl` becomes non-null (i.e., `.pr` file resolved to a URL in
   `validateAgentPrFiles()`), the runner records on that agent's runtime:
   - `prBodyBaselineCommits`: integer count of
     `git rev-list --count origin/<base>..HEAD` in the agent's worktree at
     that moment.
   - `prBodyBaselineAt`: ISO timestamp of capture.

   If the commit count cannot be obtained (git error, missing worktree), the
   baseline stays `undefined` and detection is skipped — fail-safe, no false
   positives.

2. **Detection during `pr-comments`.** On each `checkAndRedispatchPrComments`
   tick, for every agent in `agentsWithPr`, the runner compares the current
   `git rev-list --count origin/<base>..HEAD` against
   `prBodyBaselineCommits`. A mismatch is drift.

3. **PR comment annotation on drift transition.** When drift is detected and
   the agent is not already in the "drift-annotated" state for this baseline,
   the runner posts a PR issue comment via `gh pr comment <prUrl> --body "<msg>"`,
   where the body is a short notice including the baseline count, the current
   count, and a suggestion to run `gh pr edit` to refresh the body. Example
   body (exact wording not prescribed):

   > note: branch state has drifted since this body was written
   > (baseline: 1 commit at 2026-04-23T14:20:05Z, current: 2 commits).
   > consider `gh pr edit <prUrl>` to refresh.

   After the annotation is posted, the agent's runtime records that the
   current count is the "already-annotated" count so subsequent polls at the
   same count do not re-annotate.

4. **Debounce / edge-triggered.** The annotation fires once per baseline
   comparison point, not on every poll. Concretely: once an annotation is
   posted for `(baseline=B, current=C)`, no further annotations fire until
   either (a) the current count changes to a new value `C' != C`, or (b) the
   baseline is updated (see AC5). The debounce state is persisted on the
   agent runtime (e.g., `prBodyDriftAnnotatedAtCommits: number | null`) so
   crash/resume does not re-annotate the same drift.

5. **Baseline refresh path.** When the annotation is posted, the runner
   updates `prBodyBaselineCommits` to the *current* commit count and updates
   `prBodyBaselineAt` to now. Rationale: the reviewer has been told about
   this drift; treat it as the new sync point. Any further drift beyond this
   point will fire a new annotation.

6. **Skip conditions.**
   - Skip if `prBodyBaselineCommits` is undefined (no sync point captured).
   - Skip if `isPrMerged(prUrl)` returns true (body post-merge is archival).
   - Skip if the worktree `git rev-list --count` call fails (fail closed —
     treat as "cannot compare", not as drift).

7. **State shape.** `AgentRuntimeState` in `src/orchestration/state.ts` gains
   three optional fields:
   - `prBodyBaselineCommits?: number`
   - `prBodyBaselineAt?: string`
   - `prBodyDriftAnnotatedAtCommits?: number | null`

   `initAgentRuntimeState()` leaves them `undefined`. `persistState`
   round-trips them (JSON-native). Legacy state files with these fields
   absent migrate silently — missing baseline just skips detection until
   captured.

8. **Scope — detection phase.** Detection runs only during `pr-comments`.
   During `pr-create` the runner calls `validateAgentPrFiles()`; baseline
   capture happens there, but drift checking does not (by the time the PR
   URL is first written, commit count === baseline). Re-entry to `pr-create`
   from the merge-loop preserves the existing `prBodyBaselineCommits`.

9. **Template change.** None. The `pr-create` / `pair-coder-pr-create`
   skills are not modified. No machine-readable stanza. The runner's source
   of truth for drift is purely the state-tracked commit count.

10. **Regression tests.** New tests cover:
    - Baseline capture on first `prUrl` transition in `validateAgentPrFiles`
      (test by stubbing `git rev-list` output).
    - `checkAndRedispatchPrComments` posts a PR annotation when the current
      commit count differs from the baseline (mock `gh pr comment` via a
      spy on the github.ts helper).
    - Debounce: a second poll at the same current count does not re-post.
    - A third poll at a *different* current count does re-post.
    - Skip when `isPrMerged` returns true.
    - Skip when baseline is undefined.
    - Skip when `git rev-list` returns a non-zero exit status.

   Tests live in `src/orchestration/runner.pr-comments.test.ts` alongside
   the existing `checkAndRedispatchPrComments` tests. `runner.test-helpers.ts`
   already provides a `makeState` with the necessary scaffolding.

## Context

### Where the PR body is generated today

The runner does **not** compose PR bodies — the coder agent does, via
`gh pr create ... --body "<description>"` in the `pr-create` skill. The
runner only participates via `validateAgentPrFiles()` in
`src/orchestration/runner.ts`, which — for the repair case where the coder
wrote markdown (not a URL) to the `.pr` sentinel — calls
`validateAndFixPrFile()` in `src/orchestration/github.ts` to run
`gh pr create` on the agent's behalf. Either way, once `runtime.prUrl` gets
set, the body-composition step is over. This is the natural baseline-capture
point.

### Where detection fits in the main loop

`orchestrationLoop` in `src/orchestration/runner.ts` has a `while (true)`
block (near `refreshAgentStatuses`) with phase-specific hooks:

- `if (state.phase === "pr-create") { validateAgentPrFiles(state); }` —
  where baseline capture will be added.
- `if (state.phase === "pr-comments") { await checkAndRedispatchPrComments(state, transport); ... }` —
  where drift detection and annotation will run.

### Prior art

- `isWorktreeNoOp(worktreePath, projectDir)` and the auto-bail-out path in
  `runner.ts` already shell out to `git rev-list --count origin/<base>..HEAD`
  against an agent worktree; reuse the same idiom (or extract a small helper
  `countCommitsAhead(worktreePath, projectDir): number | null`).
- `postCodexReviewComment(prUrl, prompt)` in `github.ts` wraps
  `gh pr comment <prUrl> --body <body>` with `safeSyncOutput` and
  best-effort semantics (returns `boolean`). The new helper
  `postPrDriftComment(prUrl, baseline, current, baselineAt)` in `github.ts`
  mirrors this shape.
- `prMergeableStates: Record<string, string | null>` on `OrchestrationState`
  is the existing precedent for "per-agent edge-triggered PR state, reset on
  fresh phase entry only." The new fields live on `AgentRuntimeState`
  instead (one field per agent, simpler) because the baseline is
  conceptually per-agent PR, not a global orchestration flag.

### Code pointers

- `src/orchestration/state.ts` — `AgentRuntimeState` interface (add fields);
  `initAgentRuntimeState()` (no change needed).
- `src/orchestration/runner.ts`:
  - `validateAgentPrFiles()` — baseline capture on `runtime.prUrl` transition
    from null to a URL (both the eager-repair branch and the settled-mode
    branch must capture).
  - `checkAndRedispatchPrComments()` — drift check added near the start,
    alongside the existing merge/conflict/codex-review logic.
- `src/orchestration/github.ts` — new `postPrDriftComment()` helper wrapping
  `gh pr comment`; sibling to `postCodexReviewComment`.
- `src/orchestration/worktrees.ts` — `defaultMainBranch(projectDir)` for
  base-branch resolution (already used by `isWorktreeNoOp`).
- `src/orchestration/runner.pr-comments.test.ts` — test host.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Add state fields** on `AgentRuntimeState` in `state.ts`:
   `prBodyBaselineCommits?: number`, `prBodyBaselineAt?: string`,
   `prBodyDriftAnnotatedAtCommits?: number | null`.

2. **Extract helper** in `runner.ts` (or keep inline if tiny):

   ```ts
   function countCommitsAhead(worktreePath: string, projectDir: string): number | null {
     try {
       const base = defaultMainBranch(projectDir);
       const r = Bun.spawnSync(
         ["git", "rev-list", "--count", `origin/${base}..HEAD`],
         { cwd: worktreePath },
       );
       if (r.exitCode !== 0) return null;
       const n = parseInt(String(r.stdout).trim(), 10);
       return Number.isFinite(n) ? n : null;
     } catch {
       return null;
     }
   }
   ```

3. **Capture baseline** in `validateAgentPrFiles()`. In both branches where
   `runtime.prUrl` is assigned from `fixedUrl`, immediately also set:

   ```ts
   if (runtime.prBodyBaselineCommits === undefined) {
     const n = countCommitsAhead(agent.worktreePath, state.projectDir);
     if (n !== null) {
       runtime.prBodyBaselineCommits = n;
       runtime.prBodyBaselineAt = isoNow();
       runtime.prBodyDriftAnnotatedAtCommits = null;
     }
   }
   ```

   Guard on `=== undefined` so re-entry to `pr-create` from merge-loop
   preserves the existing baseline.

4. **Add `postPrDriftComment`** in `github.ts`:

   ```ts
   export function postPrDriftComment(
     prUrl: string,
     baseline: number,
     current: number,
     baselineAt: string,
   ): boolean {
     const body = `note: branch state has drifted since this body was written (baseline: ${baseline} commit${baseline === 1 ? "" : "s"} at ${baselineAt}, current: ${current}). consider \`gh pr edit ${prUrl}\` to refresh.`;
     return safeSyncOutput(["gh", "pr", "comment", prUrl, "--body", body]).ok;
   }
   ```

5. **Detect drift** at the top of `checkAndRedispatchPrComments` (after the
   `agentsWithPr.length === 0` early return, before merge/conflict logic):

   ```ts
   for (const agent of agentsWithPr) {
     const runtime = state.agentStates[agent.name]!;
     const prUrl = runtime.prUrl!;
     const baseline = runtime.prBodyBaselineCommits;
     if (baseline === undefined) continue;
     if (isPrMerged(prUrl)) continue;
     const current = countCommitsAhead(agent.worktreePath, state.projectDir);
     if (current === null) continue;
     if (current === baseline) continue;
     if (runtime.prBodyDriftAnnotatedAtCommits === current) continue;

     const posted = postPrDriftComment(prUrl, baseline, current, runtime.prBodyBaselineAt ?? "");
     if (posted) {
       runtime.prBodyDriftAnnotatedAtCommits = current;
       runtime.prBodyBaselineCommits = current;
       runtime.prBodyBaselineAt = isoNow();
       emitEvent({
         event_type: "pr_body_drift_annotated",
         source: "orchestration",
         scope: "slot",
         slot: state.slot,
         task: state.taskId,
         message: `PR body drift annotation posted on ${prUrl} (${baseline} -> ${current} commits)`,
       });
     }
   }
   ```

   Placement note: early in the function is fine — the drift check does not
   gate `allDone` / conflict / codex logic, and `safeSyncOutput` errors are
   swallowed by `postPrDriftComment` returning `false`.

6. **Tests** in `runner.pr-comments.test.ts`:
   - Stub `postPrDriftComment` and `countCommitsAhead` via `spyOn` (or
     module-level injection if spyOn is awkward for the helper — keep it
     simple; factoring is fine if needed for tests).
   - Case grid described in AC10.

7. **Build + test**: `bun run build` and `bun test`.

8. **No changes** to `skills/orchestration/pr-create.md`,
   `pair-coder-pr-create.md`, or any other skill template.

## Scope

**In scope**

- State fields on `AgentRuntimeState`.
- Baseline capture in `validateAgentPrFiles()`.
- Drift check + annotation posting in `checkAndRedispatchPrComments()`.
- Helper `postPrDriftComment` in `github.ts`.
- `emitEvent` call for observability.
- Unit tests in `runner.pr-comments.test.ts`.

**Out of scope**

- Any change to skill templates (pr-create, pr-conflict-resolve, etc.).
- Auto-regenerating / rewriting the PR body from the runner. The annotation
  is a *comment*; the body itself is not touched. Manual `gh pr edit` by the
  coder (or human) remains the refresh mechanism, now triggered by the
  comment the reviewer sees.
- Re-dispatching the coder to edit the body. Out-of-scope — would disrupt
  pr-comments polling and require a new dispatch path.
- Metrics beyond commit count (test count, diff-stat). State-field approach
  extends trivially if they're reinstated later.
- Parsing free-form PR body text. The baseline lives in state; no parsing.
- Drift detection during other phases (`merge-review`, `final-merge`).
  `pr-comments` is the only phase where drift matters for the reviewer's
  reading path.
- Changes to `fetchNewPrCommentCount` / `getPrVerification` / other GitHub
  query helpers.

**Dependencies**

- Relates to `gh-ludics-310` (source retrospective) — not blocking.
- Sibling `task-91667552` (plan-time warnings) is independent; neither
  blocks the other.
