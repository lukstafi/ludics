# Centralize orchestration-file exclusion by extending `ensureGitExcludes` to untrack a narrow internal subset

## Goal

Move the "orchestration files never enter commits" contract as close to one
place as is safe. Today it lives in two mechanisms: `ensureGitExcludes()` writes
`.git/info/exclude` (suppresses *untracked* additions), and a defensive
`git reset HEAD -- <ORCHESTRATION_RESET_PATHS>` step inside
`autoCommitWorktree()` handles the *already-tracked* case. This task extends
`ensureGitExcludes()` to also `git rm --cached` a **narrow subset** of paths
that are unambiguously orchestration-internal, so that once
`ensureGitExcludes()` has run, those paths are neither tracked nor
stageable-as-untracked — and the defensive reset step is no longer needed for
*them*. For the rest of `GIT_EXCLUDE_ENTRIES` (paths that projects legitimately
commit, like `.claude` and `.agents`), both mechanisms are preserved so the
current tolerance for deliberately-tracked files is retained.

Follow-up to **task-52fd8f03** (PR #320), which dropped `:(exclude)` pathspecs
from `git add -A`. Related to **gh-ludics-329** (docs-only), which will need a
refresh once this task narrows the contract.

## Acceptance Criteria

1. `ensureGitExcludes(repoPath)` in `src/orchestration/worktrees.ts`:
   - Still writes missing `GIT_EXCLUDE_ENTRIES` to `.git/info/exclude`
     (existing behaviour).
   - Additionally, for a **narrow `UNTRACK_PATHS` subset** —
     `.peer-sync` (i.e. `PEER_SYNC_DIRNAME`), `.ludics-orchestration.json`,
     `.agent-sessions` — runs `git rm --cached -r --ignore-unmatch <path>` for
     any path currently in the index, and commits the resulting staged
     deletion(s) in a dedicated `chore: untrack orchestration-internal files`
     commit on the current branch.
   - If no untrack-worthy path is tracked, no commit is made (idempotent
     no-op, same return value).
   - Remains idempotent overall: repeated calls produce neither duplicate
     exclude entries nor additional chore commits.
   - Still throws on unexpected git failure (setup call, not best-effort).
2. `ORCHESTRATION_RESET_PATHS` is **kept**, but its contents are narrowed
   to *exclude* the paths now handled by `UNTRACK_PATHS`. Concretely, it
   continues to expand the remaining `GIT_EXCLUDE_ENTRIES` entries
   (`.claude`, `.agents`, `node_modules`, `_build_review*`) using the
   existing `[pattern, **/pattern]` rule.
3. `autoCommitWorktree()` keeps its defensive
   `maybeGit(... ["reset", "HEAD", "--", ...ORCHESTRATION_RESET_PATHS])` call
   — the partial centralization leaves this step in place for the paths that
   projects might legitimately track.
4. JSDoc on `ensureGitExcludes` is expanded to state the narrow-untrack
   contract explicitly (which paths are untracked, which are not, and that a
   chore commit may be produced). JSDoc on `autoCommitWorktree` remains
   truthful — "additionally unstages … via `ORCHESTRATION_RESET_PATHS`" stays,
   since the step still runs.
5. Tests in `src/orchestration/worktrees.test.ts` cover:
   - (a) **Idempotent no-op** — `ensureGitExcludes` on a repo where none of
     the `UNTRACK_PATHS` are tracked produces no new commits (beyond the
     initial repo state) and the `HEAD` SHA is unchanged.
   - (b) **Previously-tracked `.peer-sync` is untracked with a chore commit on
     main** — seed a repo with a committed `.peer-sync/file`, call
     `ensureGitExcludes`, assert the file is no longer tracked
     (`git ls-files` no longer lists it), the working-tree copy is still
     present, and exactly one new commit with message
     `chore: untrack orchestration-internal files` exists on the current
     branch.
   - (c) **`.claude/` in the index is NOT untracked** — seed a repo with a
     committed `.claude/settings.json`, call `ensureGitExcludes`, assert the
     file is still tracked (`git ls-files` still lists it) and no chore
     commit was created. This guarantees the preservation contract for
     user-tracked paths.
   - (d) **Round-commit flow still correct** — an integration-shape test
     asserting that `autoCommitWorktree` on a worktree (after
     `ensureGitExcludes` has run) still commits genuine source changes and
     does not commit orchestration-internal changes, mirroring the existing
     `"excludes already-tracked orchestration files from commits"` and
     `"excludes _build_review* dirs while committing real changes"` tests.
     The existing `"excludes already-tracked orchestration files from
     commits"` test uses `.agents` — because `.agents` is *not* in the narrow
     `UNTRACK_PATHS`, that test should continue to pass unchanged (it
     exercises the `ORCHESTRATION_RESET_PATHS` reset path, which remains).
6. No regression in existing `worktrees.test.ts` tests.
7. Existing single `runner.ts` caller of `autoCommitWorktree` (around the
   `[round N]` commit helper) behaves identically for a worktree whose
   narrow-list orchestration files were never in the index — the common case.
   Where those files *were* tracked before orchestration, the untrack chore
   commit lands on the root branch once (via `ensureGitExcludes` at worktree
   creation), after which round commits proceed normally.

## Context

All affected code lives in
[`src/orchestration/worktrees.ts`](../../src/orchestration/worktrees.ts) in
`lukstafi/ludics`.

### Current state (by symbol)

- `GIT_EXCLUDE_ENTRIES` — the canonical list of paths orchestration never
  commits:
  - `PEER_SYNC_DIRNAME` (value: `.peer-sync`)
  - `.ludics-orchestration.json`
  - `.claude`
  - `.agents`
  - `.agent-sessions`
  - `node_modules`
  - `_build_review*`
- `ensureGitExcludes(repoPath)` — resolves `--git-common-dir`, reads the
  shared `<common>/info/exclude`, appends any canonical entries not already
  present. Idempotent. Throws on failure. Called in `createWorktrees()` once
  for the project dir and once per worktree.
- `ORCHESTRATION_RESET_PATHS` — glob-expanded from `GIT_EXCLUDE_ENTRIES`:
  ```ts
  GIT_EXCLUDE_ENTRIES.flatMap((e) =>
    /[*?[]/.test(e) ? [e, `**/${e}`] : [e],
  );
  ```
  Passed to `git reset HEAD -- …` inside `autoCommitWorktree` so that
  already-tracked orchestration paths do not sneak into the staged commit.
- `autoCommitWorktree(worktreePath, commitMessage)` —
  `status --porcelain` → `add -A` → **defensive reset** → re-check staged
  diff → commit or return `dirty:false`. Only production caller is
  `autoCommitAgent` in `src/orchestration/runner.ts`, which wraps a round
  commit message and emits an event.
- `runGit` / `maybeGit` helpers — `runGit` throws on non-zero exit, `maybeGit`
  swallows stderr and returns whatever stdout produced.

### Helpers needed

- A small new helper (private to the module), e.g.
  `untrackOrchestrationInternal(repoPath: string): void` that:
  1. For each path in `UNTRACK_PATHS`, checks whether it is tracked —
     safest spelling is `git ls-files --error-unmatch -- <path>`
     (non-zero exit ⇒ not tracked; safe to skip via `safeSyncOutput`
     + `!ok`). Or: run one `git ls-files -- <…UNTRACK_PATHS>` and
     filter the output.
  2. For each tracked path found, run
     `git rm --cached -r --ignore-unmatch -- <path>`. `--ignore-unmatch`
     keeps the call tolerant of the race where the path got untracked
     between the check and the removal.
  3. If any removals succeeded (staged deletion present in
     `git diff --cached --name-only`), run
     `git commit -m "chore: untrack orchestration-internal files"`.
     Use `maybeGit` for the commit, or `runGit` inside a try/catch that
     emits a warning but does not throw — a failed chore commit must not
     block worktree setup.
  4. No-op when nothing to untrack.
- The helper is called at the end of `ensureGitExcludes` (or just after
  it, inside the same public function) so the contract is one call.
- `UNTRACK_PATHS` should be a `readonly` subset constant at module scope,
  adjacent to `GIT_EXCLUDE_ENTRIES`, to keep the relationship visible:
  ```ts
  /** Subset of GIT_EXCLUDE_ENTRIES that is unambiguously
   *  orchestration-internal — safe to proactively `git rm --cached`. */
  const UNTRACK_PATHS = [PEER_SYNC_DIRNAME, ".ludics-orchestration.json", ".agent-sessions"] as const;
  ```
  `ORCHESTRATION_RESET_PATHS` should then be computed from the *remainder*:
  ```ts
  const ORCHESTRATION_RESET_PATHS = GIT_EXCLUDE_ENTRIES
    .filter((e) => !(UNTRACK_PATHS as readonly string[]).includes(e))
    .flatMap((e) => /[*?[]/.test(e) ? [e, `**/${e}`] : [e]);
  ```

### Tests — file and shape

- Test file: `src/orchestration/worktrees.test.ts`. New tests belong in the
  existing `describe("ensureGitExcludes", …)` block (or a sibling
  `describe("ensureGitExcludes untrack", …)` for clarity).
- Test helpers already in the file: `run(cmd, cwd)` (throws on failure),
  `readExcludeFile(repoPath)`, `TMP` / `initRepo` patterns from the
  `autoCommitWorktree` tests (replicate that style — `git init -b main`,
  configure user.email / user.name, initial commit).
- For (b): the seed sequence is roughly
  `initRepo; mkdirSync(join(repo, ".peer-sync")); writeFileSync(join(repo, ".peer-sync", "x"), "…"); run(["git", "add", "-A"], repo); run(["git", "commit", "-m", "track peer-sync"], repo); ensureGitExcludes(repo);`
  then assert via `git ls-files` that `.peer-sync/x` is absent from the
  index, via `git log --format=%s -n 1` that `HEAD`'s subject line equals
  `chore: untrack orchestration-internal files`, and the working tree still
  contains `.peer-sync/x`.
- For (c): identical seed shape but with `.claude/settings.json`, asserting
  the opposite — `.claude/settings.json` is still in `git ls-files`, and
  `git log` shows no chore commit.

### Related docs / sibling work

- `docs/proposals/gh-ludics-329-git-exclude-worktree-rule.md` — the ready
  documentation-only proposal that currently describes the two-mechanism
  design as the canonical rule. After this task lands, the rule narrows:
  `.git/info/exclude` is the sole mechanism for untracked files **plus** a
  narrow-list of orchestration-internal untrack commits, while the
  defensive `reset HEAD --` step persists for paths projects may
  legitimately commit. Issue #329 and the doc proposal should be updated
  to reflect that.
- **Out of scope for this task**: updating #329 and the docs proposal.
  Flag the update in the task notes / retrospective so whoever picks up
  #329 next sees the revised contract before writing the documentation.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Introduce `UNTRACK_PATHS` adjacent to `GIT_EXCLUDE_ENTRIES` in
   `src/orchestration/worktrees.ts`, as a `readonly` subset of three entries
   (`PEER_SYNC_DIRNAME`, `.ludics-orchestration.json`, `.agent-sessions`).
2. Re-express `ORCHESTRATION_RESET_PATHS` as "entries in
   `GIT_EXCLUDE_ENTRIES` not in `UNTRACK_PATHS`, glob-expanded" — keep the
   existing `[pattern, **/pattern]` expansion rule.
3. Add a private helper `untrackOrchestrationInternal(repoPath)` that:
   - Uses `git ls-files -- <UNTRACK_PATHS>` (single call) to find tracked
     entries.
   - Runs `git rm --cached -r --ignore-unmatch -- <each path>` for each
     `UNTRACK_PATHS` entry that matched.
   - If staged deletions exist, commits with message
     `chore: untrack orchestration-internal files`. Use `maybeGit` for the
     commit so a missing `user.email` / `user.name` config does not crash
     setup — log a warning via `console.error` in that case.
4. Call `untrackOrchestrationInternal(repoPath)` at the end of
   `ensureGitExcludes(repoPath)`, after the exclude-file write.
5. Update JSDoc on `ensureGitExcludes` to describe the narrow-untrack
   contract and note that it may produce a `chore: untrack
   orchestration-internal files` commit on the current branch. Do NOT
   weaken the `autoCommitWorktree` JSDoc — the reset step stays.
6. Add the four tests listed in Acceptance Criteria #5 to
   `worktrees.test.ts`.
7. Run `bun run build && bun test src/orchestration/worktrees.test.ts`
   until green.
8. Note in the task retrospective that `gh-ludics-329` and issue #329
   should be refreshed to reflect the narrowed contract (sibling, not part
   of this task).

## Scope

**In scope**:
- `src/orchestration/worktrees.ts`: new `UNTRACK_PATHS`, new helper,
  extended `ensureGitExcludes`, narrowed `ORCHESTRATION_RESET_PATHS`,
  updated JSDoc.
- `src/orchestration/worktrees.test.ts`: four new tests (idempotent no-op,
  `.peer-sync` untrack with chore commit, `.claude/` preserved, round-commit
  flow integrity).

**Out of scope**:
- Any change to `autoCommitWorktree`'s reset step — it stays.
- Untracking `.claude`, `.agents`, `node_modules`, or `_build_review*` —
  these are explicitly preserved in `ORCHESTRATION_RESET_PATHS` per the
  resolved narrow-list contract.
- Updating `gh-ludics-329` or its proposal doc — sibling work, flagged in
  the retrospective.
- Changes to `runner.ts` or other callers — behaviour is preserved.

**Dependencies**: none. The related task-52fd8f03 / PR #320 is already
merged.
