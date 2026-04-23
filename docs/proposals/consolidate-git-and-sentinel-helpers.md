# Consolidate git helpers + withCheckout + ls-remote default-branch + sentinel-file unification

## Goal

Consolidate four related code-shape suggestions surfaced in the retrospective of
task-d1932b8f (simplify upstream workflow) into a single multi-commit PR, plus a
function rename, plus folding gh-ludics-336's code extraction into the same PR.

The underlying motivation: `src/staging-ff.ts` and `src/briefing-lag.ts` grew
duplicated helpers and an ad-hoc sentinel pattern that already existed several
times in `src/mag.ts`. Those duplications can be canonicalised now at modest
cost; deferring will compound as more callers appear. The rename
(`maybeFastForwardStagingFromUpstream` → `syncStagingMainWithUpstream`) removes
a direction ambiguity that readers have flagged. gh-ludics-336 previously owned
the `RunGit` + `defaultRunGit` extraction; per user resolution of Q6, that code
extraction folds into this PR and gh-ludics-336 narrows to a docs-only entry
(testing-patterns.md).

Related: task-d1932b8f (source retrospective), gh-ludics-336 (superseded on
code; retains docs-only residual).

## Acceptance Criteria

All criteria below land in **one PR with multiple commits**. Merge commit
preserves per-retrospective-item provenance. Commit ordering is a plan-phase
decision; a natural sequence is: git-runner extraction → withCheckout →
ls-remote upgrade → sentinel.ts unification → rename. The PR must pass
`bun test` and `bun run build`.

### Item 1 — `src/git-runner.ts` extraction (subsumes gh-ludics-336 code work)

- [ ] New file `src/git-runner.ts` exports:
  - `RunGitResult` interface, `RunGit` type (moved verbatim from briefing-lag.ts).
  - `defaultRunGit: RunGit` (moved from briefing-lag.ts) **and routed through
    `safeSyncOutput` from `src/spawn.ts`** — i.e. `defaultRunGit` no longer
    calls `Bun.spawnSync` directly. The adapter preserves the current
    `RunGitResult` shape (`{ stdout, exitCode }`) while satisfying the
    spawn.ts policy ("all production Bun.spawnSync calls must go through
    safeSyncOutput").
  - `expandHome(path: string): string` (moved from briefing-lag.ts; duplicate
    in staging-ff.ts removed).
  - `hasRemote(cwd, name, runGit)` (moved from briefing-lag.ts; duplicate in
    staging-ff.ts removed).
  - `detectDefaultBranches(cwd, runGit)` (moved from briefing-lag.ts; local-only
    behaviour unchanged — symbolic-ref then main/master probe, no network).
  - `detectDefaultBranchesAuthoritative(cwd, runGit)` — see Item 3.
  - `withCheckout<T>(...)` — see Item 2.
- [ ] `src/briefing-lag.ts` imports the moved symbols from `./git-runner.ts`
  and no longer defines them. Briefing-specific symbols stay
  (`FormatLagOptions`, `DetectedBranches` (or re-exported), `parseLeftRightCount`,
  `lastMergeLine`, `fetchFreshnessNote`, `formatUpstreamLagSection`).
- [ ] `src/staging-ff.ts` deletes its duplicate `expandHome` and `hasRemote`,
  imports from `./git-runner.ts`. Imports of `detectDefaultBranches` +
  `RunGit` switch from `./briefing-lag.ts` to `./git-runner.ts`.
- [ ] `src/mag.ts` import of `defaultRunGit` + `RunGit` moves from
  `./briefing-lag.ts` to `./git-runner.ts`. `formatUpstreamLagSection` stays
  imported from `./briefing-lag.ts`.
- [ ] New `src/git-runner.test.ts` houses unit coverage for the moved symbols
  (cases relocated from `briefing-lag.test.ts` for `detectDefaultBranches`
  and for `defaultRunGit` if any).

### Item 2 — `withCheckout<T>` abstraction

- [ ] `src/git-runner.ts` exports
  `withCheckout<T>(cwd: string, targetBranch: string, runGit: RunGit, fn: () => T): T`.
- [ ] Behaviour:
  1. Read current branch (`rev-parse --abbrev-ref HEAD`). If detached, capture
     HEAD SHA via `rev-parse HEAD`.
  2. If the current branch already equals `targetBranch`, skip checkout and
     skip restore; invoke `fn()` and return.
  3. Otherwise checkout `targetBranch`. On checkout failure, throw.
  4. `try { return fn(); } finally { restore — checkout priorBranch if named,
     otherwise checkout --detach priorHeadSha }`.
- [ ] JSDoc notes the implicit contract: callback must leave the worktree in
  a state where checkout-back will succeed (e.g. --ff-only merges never dirty
  the tree).
- [ ] `maybeFastForwardStagingFromUpstream` (renamed to
  `syncStagingMainWithUpstream` in Item 5) replaces its priorBranch /
  priorHeadSha / needCheckout / try-finally block with a single
  `withCheckout(path, branches.origin, opts.runGit, () => { … merge + classify
  outcome … })` call. The callback returns the outcome (plus advancedBy). The
  caller catches checkout-failure exceptions, records an `error` outcome,
  touches the sentinel, and continues — matching current error semantics.
- [ ] `src/git-runner.test.ts` covers: named-branch restore, detached-HEAD
  restore, skip-when-already-on-target, exception in callback still triggers
  restore, checkout failure propagates.

### Item 3 — `ls-remote --symref` authoritative default-branch (fast-forward path)

- [ ] `src/git-runner.ts` exports
  `detectDefaultBranchesAuthoritative(cwd, runGit)` that runs
  `git ls-remote --symref <remote> HEAD` per remote. Parses
  `ref: refs/heads/(.+?)\s+HEAD` from stdout. Returns
  `{ origin: string | null, upstream: string | null }`.
- [ ] Tier ordering inside `detectDefaultBranchesAuthoritative`:
  `symbolic-ref` (local) → `ls-remote --symref` (network) → `main`/`master`
  probe (local) → `null`. Each tier short-circuits on success.
- [ ] Fast-forward path in `src/staging-ff.ts` (now `syncStagingMainWithUpstream`)
  switches from `detectDefaultBranches` to `detectDefaultBranchesAuthoritative`,
  called after `git fetch upstream --quiet` (so credentials are warm).
- [ ] Briefing path in `src/briefing-lag.ts` stays on `detectDefaultBranches`
  (local-only; no network).
- [ ] Tests cover: ls-remote success returns remote's declared default;
  ls-remote failure (non-zero exit) falls through to main/master probe;
  missing `ref: refs/heads/...` line falls through.

### Item 4 — `src/sentinel.ts` unification

- [ ] New file `src/sentinel.ts` exports:
  - `sentinelFresh(path: string, now: Date, windowSec: number): boolean`.
  - `touchSentinel(path: string, now?: Date): void` — creates parent dir
    recursively, writes epoch string, sets mtime. Failures swallowed (sentinel
    writes are best-effort; a missed write just means the next tick may run).
  - `readSentinelEpoch(path: string): number | null` — reads file, parses as
    integer seconds-since-epoch, rejects non-positive values as `null`. This
    is the unified policy across all migration sites.
  - `clearSentinel(path: string): void` — unlinks if present, swallows errors.
  - `sentinelExists(path: string): boolean` — for boolean sentinels like
    `mag/settled`.
- [ ] Migration sites (all switch to `src/sentinel.ts`):
  - `src/staging-ff.ts`: delete inline `sentinelFresh` + `touchSentinel`,
    import from `./sentinel.ts`. Keep the path-construction helper
    `sentinelFile(dir, project)` local.
  - `src/mag.ts` → `readEpochFile` → `readSentinelEpoch`. Update call-sites
    (pane-change read, stall-nudge read, startup-watchdog read, stop-hook
    read).
  - `src/mag.ts` → `markMagSettled` / `clearMagSettled` / `isMagSettled` →
    `touchSentinel(settledSentinelFile())` / `clearSentinel(settledSentinelFile())` /
    `sentinelExists(settledSentinelFile())`. Path-construction helper
    `settledSentinelFile()` stays. **Semantic preservation**: `mag/settled`
    stays a boolean sentinel — do NOT migrate its read to `sentinelFresh`.
  - `src/mag.ts` → `writePaneChangeEpoch` → `touchSentinel(paneChangeEpochFile())`.
  - `src/mag.ts` → `writeStallNudgeEpoch` → `touchSentinel(stallNudgeEpochFile())`.
  - `src/mag.ts` → startup-watchdog write — switch the inline `writeFileSync`
    to `touchSentinel(startupWatchdogEpochFile())`.
  - `src/mag.ts` → stop-hook write — switch the inline `writeFileSync` to
    `touchSentinel(stopHookTimestampFile())`.
  - `src/mag.ts` → `autoProposalDebounced(taskId)` → uses `sentinelFresh`.
    `markAutoProposalQueued(taskId)` → uses `touchSentinel`. Path-construction
    (the `auto-proposal-debounce/<taskId>.epoch` filename) stays local.
- [ ] Unified policy applied: non-positive epoch reads become `null` everywhere
  (matches existing `readEpochFile`; this is a subtle behaviour change for
  `autoProposalDebounced` but the observable effect is the same — malformed
  files fail-open to "proceed").
- [ ] New `src/sentinel.test.ts` covers: fresh (within window), stale (past
  window), missing file, parent-dir-missing-still-writes, non-positive epoch
  reads as null, boolean sentinel exists/clear.

### Item 5 — Rename `maybeFastForwardStagingFromUpstream` → `syncStagingMainWithUpstream`

- [ ] Export in `src/staging-ff.ts` renamed.
- [ ] All call-sites updated: `src/mag.ts` (import at line 7 and call inside
  the wrapper), `src/staging-ff.test.ts` (import + all in-file references +
  the `describe` block name).
- [ ] JSDoc references updated in `src/staging-ff.ts` (own docstring) and
  `src/mag.ts` (the wrapper's docstring that names the function). The wrapper
  function `runStagingFastForwardTick` keeps its name (the inner tick-runner
  isn't ambiguous).
- [ ] `docs/` and `retrospectives/` grepped for any prose references to the
  old name; update references that exist (historical retrospective entries
  may be left with a parenthetical aside noting the rename, at the plan's
  discretion).
- [ ] Commit message for this rename mentions both old and new names so
  `git log --grep=maybeFastForwardStagingFromUpstream` still finds the
  change.

### Item 6 — gh-ludics-336 narrowing (noted here for coordination, not implemented in this PR)

- [ ] PR description explicitly notes that gh-ludics-336's code-extraction
  residual (moving `RunGit` + `defaultRunGit` + `safeSyncOutput` routing)
  has folded into this PR; gh-ludics-336 narrows to docs-only (a
  `docs/testing-patterns.md` entry citing `src/git-runner.ts` as the worked
  example for the "Injectable Subprocess Runners" pattern). Closing / updating
  gh-ludics-336's task file is out of scope for this PR — that is the mag /
  orchestrator's follow-up.

## Context

### Code anatomy at HEAD

**`src/briefing-lag.ts`** defines and exports: `RunGitResult`, `RunGit`,
`FormatLagOptions`, `detectDefaultBranches`, `parseLeftRightCount`,
`formatUpstreamLagSection`, `defaultRunGit`. Local (non-exported) helpers:
`expandHome`, `hasRemote`, `lastMergeLine`, `fetchFreshnessNote`, and the
internal `DetectedBranches` interface.

**`src/staging-ff.ts`** imports `detectDefaultBranches` + `RunGit` from
briefing-lag. Re-defines locally: `expandHome` (literal duplicate),
`hasRemote` (literal duplicate), `sentinelFile`, `sentinelFresh`,
`touchSentinel`, `worktreeClean`, `currentBranch`, `commitCount`. Exports
`maybeFastForwardStagingFromUpstream` (~130-line function implementing all
the stages listed in task elaboration).

**`src/mag.ts`** imports `defaultRunGit` + `RunGit` from briefing-lag
(line 6) and `maybeFastForwardStagingFromUpstream` from staging-ff
(line 7). The wrapper `runStagingFastForwardTick` at ~line 1565 is the sole
production caller. Sentinel/epoch helpers live in mag.ts across several
blocks: `stopHookTimestampFile` / `startupWatchdogEpochFile` /
`readEpochFile` / `settledSentinelFile` family / pane-change + stall-nudge
family / auto-proposal-debounce family.

**`src/spawn.ts`** defines `safeSyncOutput` and the file-level policy:
"All production Bun.spawnSync calls must go through safeSyncOutput. Exception:
inherited-stdio terminal-attach in mag.ts." The current `defaultRunGit`
bypasses this policy (calls `Bun.spawnSync` directly at briefing-lag.ts's
end). Routing it through `safeSyncOutput` is small: wrap the result into
`RunGitResult`, preserving the `{ stdout, exitCode }` shape.

### Sentinel-file site inventory

Seven migration sites across `staging-ff.ts` and `mag.ts`:

| Sentinel | Write site | Read site | Semantic |
|----------|------------|-----------|----------|
| `mag/last-fast-forward-<project>.epoch` | `staging-ff.ts:touchSentinel` | `staging-ff.ts:sentinelFresh` | freshness-windowed |
| `mag/startup-watchdog.epoch` | `mag.ts` (inline writeFileSync) | `mag.ts:readEpochFile` | freshness-windowed |
| `mag/last-stop-hook.epoch` | `mag.ts` (inline writeFileSync) | `mag.ts:readEpochFile` | freshness-windowed |
| `mag/settled` | `mag.ts:markMagSettled` | `mag.ts:isMagSettled` (existsSync) | **boolean** |
| `mag/last-pane-change.epoch` | `mag.ts:writePaneChangeEpoch` | `mag.ts:readEpochFile` | freshness-windowed |
| `mag/last-stall-nudge.epoch` | `mag.ts:writeStallNudgeEpoch` | `mag.ts:readEpochFile` | freshness-windowed |
| `mag/auto-proposal-debounce/<taskId>.epoch` | `mag.ts:markAutoProposalQueued` | `mag.ts:autoProposalDebounced` (inline readFileSync) | freshness-windowed |

The `last-pane.hash` file (content is a hash, not an epoch) is orthogonal and
NOT part of this unification.

### Scope boundaries from elaboration (preserved verbatim)

**In scope**: the five items above (1–5) + folding gh-ludics-336's code
extraction + docs follow-up note.

**Out of scope**:
- `resolveTemplatePath(..., hasUpstream)` parameter decision (task-d1932b8f Q1
  resolution: keep as-is, revisit in 3–6 months).
- `briefingPrecomputeContext` → `BriefingDeps` refactor (premature).
- Anything in `src/orchestration/runner.ts`.
- Closing / updating gh-ludics-336's task file — orchestrator follow-up.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Natural commit ordering inside the PR:

1. **Extract `src/git-runner.ts`** (moves: `RunGitResult`, `RunGit`,
   `defaultRunGit` routed through `safeSyncOutput`, `expandHome`, `hasRemote`,
   `detectDefaultBranches`). Update imports in briefing-lag.ts, staging-ff.ts,
   mag.ts. Delete duplicates in staging-ff.ts. Relocate tests.
2. **Add `withCheckout<T>`** to `src/git-runner.ts`. Refactor staging-ff.ts's
   inline checkout/restore dance to call it. Add tests.
3. **Add `detectDefaultBranchesAuthoritative`** to `src/git-runner.ts`. Switch
   the fast-forward path to use it. Leave briefing-lag on local-only
   `detectDefaultBranches`. Add tests.
4. **Extract `src/sentinel.ts`** with the five-function API. Migrate all seven
   sites. Add tests.
5. **Rename** `maybeFastForwardStagingFromUpstream` →
   `syncStagingMainWithUpstream`. Update callers, JSDoc, test
   `describe` block, any docs/retrospectives references.

Each commit should independently pass `bun test` and `bun run build`. The plan
phase may resolve that items 2 and 3 combine naturally with item 1, or that
item 4 splits further. The user's Q3 resolution locks the outer shape (one PR,
multiple commits); inner commit boundaries are a plan-phase decision.

## Scope

**In scope**: `src/git-runner.ts` (new), `src/sentinel.ts` (new), updates to
`src/briefing-lag.ts`, `src/staging-ff.ts`, `src/mag.ts`, test reorganisation
across `src/briefing-lag.test.ts` / `src/staging-ff.test.ts` / new
`src/git-runner.test.ts` + `src/sentinel.test.ts`. Grep pass across
`docs/` and `retrospectives/` for the rename.

**Out of scope**: everything listed under "Scope boundaries" above. Not
touching `src/orchestration/runner.ts`. Not touching the `last-pane.hash`
file. Not writing the `docs/testing-patterns.md` entry (that's gh-ludics-336's
residual).

**Dependencies**: Relates to task-d1932b8f (source retrospective — already
merged). Supersedes the code extraction residual of gh-ludics-336 per Q6;
gh-ludics-336 will land its docs-only follow-up after this PR merges. No
hard `blocks:` relationship.
