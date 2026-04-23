# Refresh gh-ludics-329 docs to reflect the two-tier exclusion contract

## Goal

After task-89b31783 (PR [#356](https://github.com/lukstafi/ludics/pull/356))
narrowed the orchestration worktree exclusion logic, the documentation
shipped with gh-ludics-329 is stale. That section in
`docs/testing-patterns.md` still asserts a one-mechanism rule
("`ensureGitExcludes()` the sole exclusion source"), while the actual
runtime contract is now two-tier:

- **Tier 1 — Narrow proactive untrack**: `ensureGitExcludes()` runs
  `git rm --cached` and a dedicated `chore: untrack orchestration-internal
  files` commit for the `UNTRACK_PATHS` subset (`.peer-sync`,
  `.ludics-orchestration.json`, `.agent-sessions`) — paths orchestrators
  write that users never commit.
- **Tier 2 — Defensive reset**: `autoCommitWorktree()` uses
  `ORCHESTRATION_RESET_PATHS` with `git reset HEAD --` to unstage the
  remaining `GIT_EXCLUDE_ENTRIES` (`.claude`, `.agents`, `node_modules`,
  `_build_review*`) at commit time only — so projects that legitimately
  commit `.claude/settings.json` or `.agents/` aren't untracked.

The current wording would mislead future readers (and agents) who land on
the section. Refresh it to describe the two-tier contract and record the
durable criterion for adding paths to `UNTRACK_PATHS`.

## Acceptance Criteria

- `docs/testing-patterns.md` § "Orchestration Worktree Exclusions" no
  longer claims `ensureGitExcludes()` / `GIT_EXCLUDE_ENTRIES` is the
  **sole** exclusion source. It describes both tiers (narrow proactive
  untrack + defensive reset) and names the paths handled by each.
- The section states the **UNTRACK_PATHS criterion** as durable guidance:
  a path belongs in `UNTRACK_PATHS` only if it is orchestrator-written
  and users never commit it. Paths that projects may legitimately track
  (`.claude`, `.agents`, `node_modules`, `_build_review*`) stay out of
  `UNTRACK_PATHS` and rely on Tier 2.
- Existing correct material is preserved: the mirror rule for tests
  (call `ensureGitExcludes(repo)` directly), the pathspec-magic rule
  (never combine `.git/info/exclude` entries with `:(exclude)pattern` on
  the same `git add`; never use the short form `:!pattern`), and the
  `ORCHESTRATION_RESET_PATHS` inclusion/exclusion clarification.
- The precedent paragraph cites PR #356 (task-89b31783) as the follow-up
  that split the single-source rule into the two-tier contract, while
  retaining PR #320 / issue #329 as the original precedent.
- `docs/proposals/gh-ludics-329-git-exclude-worktree-rule.md` carries a
  single-line "Superseded by task-89b31783 / PR #356 — see
  `docs/testing-patterns.md` § Orchestration Worktree Exclusions" note
  near the top, so future readers who grep into the historical proposal
  aren't misled. Historical text below is left untouched.
- No other files are modified. In particular, `src/orchestration/worktrees.ts`
  JSDoc is **not** re-edited — it was already refreshed in task-89b31783's
  PR and is accurate.

## Context

Files involved:

- `docs/testing-patterns.md` — section "Orchestration Worktree Exclusions"
  (the stale block; ~30–40 lines). Stale phrases today:
  - "`GIT_EXCLUDE_ENTRIES` … as the **sole** source of truth"
  - "Pick one mechanism — for orchestration, that is always
    `ensureGitExcludes()`."
  - "making `ensureGitExcludes()` the sole exclusion source"
- `docs/proposals/gh-ludics-329-git-exclude-worktree-rule.md` — historical
  proposal; first line is the `# Document the one-exclusion-source rule
  for orchestration worktrees` heading.
- `src/orchestration/worktrees.ts` — already up-to-date post-89b31783.
  JSDoc blocks on `GIT_EXCLUDE_ENTRIES`, `UNTRACK_PATHS`,
  `ensureGitExcludes`, `untrackOrchestrationInternal`,
  `ORCHESTRATION_RESET_PATHS`, and `autoCommitWorktree` already describe
  the narrowed contract. No edits needed here — re-editing risks churn
  or regressions.

Survey results (from task elaboration):

- `ARCHITECTURE.md` does not exist at repo root.
- `README.md`, `CLAUDE.md`, and files under `skills/` contain no mentions
  of the one-mechanism rule, `ensureGitExcludes`, `GIT_EXCLUDE_ENTRIES`,
  or the sole/only-mechanism phrasing. Nothing else requires a refresh.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Single PR, documentation-only, two file edits:

1. **Rewrite `docs/testing-patterns.md` § "Orchestration Worktree Exclusions"**
   to describe the two tiers explicitly:
   - Intro paragraph: orchestration worktrees use a two-tier exclusion
     contract, both halves centralized in
     `src/orchestration/worktrees.ts`.
   - Tier 1 bullet: `ensureGitExcludes()` writes `GIT_EXCLUDE_ENTRIES` to
     `.git/info/exclude`, and for `UNTRACK_PATHS` (`.peer-sync`,
     `.ludics-orchestration.json`, `.agent-sessions`) additionally runs
     `git rm --cached` with a dedicated `chore: untrack
     orchestration-internal files` commit.
   - Tier 2 bullet: `autoCommitWorktree()` invokes `git reset HEAD --`
     with `ORCHESTRATION_RESET_PATHS` (`.claude`, `.agents`,
     `node_modules`, `_build_review*`) to defensively unstage them
     without untracking — preserving any that a project legitimately
     commits.
   - `UNTRACK_PATHS` criterion paragraph (new, durable): orchestrator-
     written only, users never commit these paths; everything else stays
     in Tier 2.
   - Retain the testing mirror rule, the pathspec-magic rule
     (`:(exclude)pattern` vs `:!pattern`), and the
     `ORCHESTRATION_RESET_PATHS` inclusion/exclusion clarification as-is.
   - Precedent paragraph: keep PR #320 / issue #329; append PR #356
     (task-89b31783) as the follow-up that narrowed the single-source
     rule into the two-tier contract.
2. **Prepend a single-line supersession note** to
   `docs/proposals/gh-ludics-329-git-exclude-worktree-rule.md`, directly
   under the existing `#` heading:
   `> **Superseded by task-89b31783 / PR #356** — the contract is now
   two-tier (narrow proactive untrack + defensive reset). See
   `docs/testing-patterns.md` § Orchestration Worktree Exclusions.`
   Leave all other historical text untouched.

No code, no tests, no other files.

## Scope

**In scope:**
- Edits to `docs/testing-patterns.md` § "Orchestration Worktree Exclusions"
  to describe the two-tier contract and add the `UNTRACK_PATHS` criterion.
- One-line supersession note at the top of
  `docs/proposals/gh-ludics-329-git-exclude-worktree-rule.md`.

**Out of scope:**
- Any edit to `src/orchestration/worktrees.ts` (JSDoc already refreshed
  by task-89b31783).
- Code changes to the exclusion logic itself.
- Further narrowing/widening of the `UNTRACK_PATHS` list.
- New tests (pure documentation change).
- Edits to `README.md`, `CLAUDE.md`, or skill templates (survey found
  no stale mentions).

**Dependencies:**
- Relies on task-89b31783 / PR #356 having merged (it has).
- Relates to gh-ludics-329 (status `done`; its doc additions are the
  staleness being corrected).
