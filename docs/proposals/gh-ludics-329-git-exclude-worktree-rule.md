# Document the one-exclusion-source rule for orchestration worktrees

> **Superseded by task-89b31783 / PR [#356](https://github.com/lukstafi/ludics/pull/356)** — the contract is now two-tier (narrow proactive untrack + defensive reset). See `docs/testing-patterns.md` § "Orchestration Worktree Exclusions".

## Goal

Prevent future recurrence of the "duplicated exclusion mechanisms" pitfall
documented in [issue #329](https://github.com/lukstafi/ludics/issues/329) and
fixed at runtime in PR #320. Two recent retrospectives (task-537987ee and
task-52fd8f03) independently hit the same trap: combining `.git/info/exclude`
entries with `:(exclude)pattern` pathspecs on `git add -A` causes git to exit
1 whenever the excluded directory physically exists, even though the partial
add succeeded — which then surfaces as a `runGit` throw inside
`autoCommitWorktree()`. A secondary trap is that the short-form pathspec
magic `:!pattern` fails parsing whenever `pattern` contains `*`
(`fatal: Unimplemented pathspec magic '_' in ':!_build_review*'`), so the
long form `:(exclude)pattern` is the only safe spelling.

The runtime bug is already fixed. Scope of this task is purely preventive
documentation so the trap does not recur the next time someone reaches for a
pathspec exclude.

## Acceptance Criteria

- `docs/testing-patterns.md` gains a new orchestration/worktree-framed
  section (sibling to the existing "Safe Mocking in Bun" and
  "Network-Binding Tests" sections) that:
  - Names `ensureGitExcludes()` / `.git/info/exclude` as the sole source of
    truth for orchestration worktree exclusions.
  - States the rule: do not combine `.git/info/exclude` entries with
    `:(exclude)pattern` pathspecs on `git add` (causes spurious exit 1 when
    the excluded directory exists).
  - States the fallback rule: if pathspec excludes are ever genuinely
    required elsewhere, use long-form `:(exclude)pattern`, never short-form
    `:!pattern` (short form fails parsing when the pattern contains `*`).
  - References PR #320 as precedent.
- `src/orchestration/worktrees.ts` gains a short JSDoc cross-reference
  pointing at the new doc section, on `autoCommitWorktree` and/or
  `ensureGitExcludes` — discoverable at the call site where a future author
  might be tempted to add a pathspec exclude.
- The audit step from issue #329 item 3 is recorded as complete: no call
  site in `src/`, `tests/`, `scripts/`, `bin/` still combines `:(exclude)`
  pathspecs with `.git/info/exclude` content. (Already confirmed during
  elaboration — `grep ":(exclude)" src/ tests/ scripts/ bin/` returns zero
  matches.)
- No code behavior change. `ORCHESTRATION_RESET_PATHS` stays as-is — it is
  a pathspec *inclusion* for `git reset HEAD --`, not a pathspec exclude on
  `git add`, and does not trigger the failure mode.

## Context

**Documentation target** — `docs/testing-patterns.md`. Existing siblings:

- `## Safe Mocking in Bun`
- `## Network-Binding Tests`

The new section should follow the same style (short intro, bulleted rule,
"why" paragraph, small code-ish example if helpful, reference to
precedent). Title it as an orchestration/worktree rule (per resolved Q2),
not a generic "Git Exclude Source-of-Truth" heading — e.g. something like
"Orchestration Worktree Exclusions" or "Worktree Auto-Commit Exclusions".

**Code target** — `src/orchestration/worktrees.ts`. Relevant symbols:

- `GIT_EXCLUDE_ENTRIES` — the canonical list
  (`.peer-sync`, `.ludics-orchestration.json`, `.claude`, `.agents`,
  `.agent-sessions`, `node_modules`, `_build_review*`).
- `ensureGitExcludes(repoPath)` — appends missing entries to
  `.git/info/exclude` via `--git-common-dir`. Single source of truth.
  Called once in `createWorktrees()` for the project dir and each worktree.
- `autoCommitWorktree(worktreePath, commitMessage)` — auto-commits agent
  changes. Runs `git add -A` (no pathspec excludes) and a separate
  defensive `git reset HEAD -- <ORCHESTRATION_RESET_PATHS>` step to unstage
  already-tracked orchestration paths.
- `ORCHESTRATION_RESET_PATHS` — derived from `GIT_EXCLUDE_ENTRIES`
  (expanding glob entries as `[foo*, **/foo*]`). Used only for the `reset`
  step, not for `add`. **Do not touch.**
- Existing JSDoc on `autoCommitWorktree` (currently starts "Relies on
  `ensureGitExcludes` having been called to set up `.git/info/exclude`") is
  the natural anchor for the cross-reference.

**Rule phrasing** — the user-blessed version (combining follow-ups 1 and 2
from the issue):

> Orchestration worktrees use `ensureGitExcludes()` (which writes to
> `.git/info/exclude`) as the **sole** source of truth for paths that must
> never be committed. Do not combine `.git/info/exclude` entries with
> `:(exclude)pattern` pathspecs on `git add` — when the excluded directory
> physically exists, git exits 1 even though the partial add succeeds,
> causing `runGit` to throw. If a future one-off command genuinely needs
> pathspec excludes, use the long form `:(exclude)pattern` (never the
> short form `:!pattern`, which fails parsing when the pattern contains
> `*`). Reference precedent: PR #320.

Feel free to tighten or adjust phrasing in the actual doc; the bullets
above are the essential content.

**Audit evidence** — from elaboration, repeated during proposal drafting:

```
cd lukstafi/ludics
grep -rn ":(exclude)" src/ tests/ scripts/ bin/    # zero matches
grep -rn ":!"         src/ tests/ scripts/ bin/    # zero matches (for pathspec magic)
```

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Append a new section to `docs/testing-patterns.md` after
   "Network-Binding Tests". Title suggestion:
   `## Orchestration Worktree Exclusions`. Include: the rule, the rationale
   paragraph, a short note on long-form vs short-form pathspec magic, and
   a link to PR #320.
2. Extend the JSDoc on `autoCommitWorktree` (and optionally
   `ensureGitExcludes`) in `src/orchestration/worktrees.ts` with a
   one-line cross-reference: e.g. "See
   `docs/testing-patterns.md` § Orchestration Worktree Exclusions for the
   one-exclusion-source rule." Do not duplicate the full rule text at the
   code site — a pointer is enough.
3. No test changes required (documentation-only), no code-behavior
   changes.

## Scope

**In scope**:
- New orchestration-framed section in `docs/testing-patterns.md`.
- JSDoc cross-reference in `src/orchestration/worktrees.ts`.

**Out of scope**:
- Any code behavior change (runtime bug is already fixed via PR #320).
- Modifying `ORCHESTRATION_RESET_PATHS` or the `reset HEAD --` step (not
  a pathspec exclude; not affected by the failure mode).
- Extending the rule to non-orchestration call sites (the docs target is
  explicitly the orchestration worktree workflow per resolved Q2).
- Project-level `.gitignore` files (outside orchestration's control).

**Dependencies**: none. PR #320 is already merged; the immediate runtime
bug is fixed.
