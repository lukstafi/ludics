# Add `resolveBaseRef` helper, JSDoc-harden `detectDefaultBranches`, and fold `detectDefaultBranchesAuthoritative` into a single options-bag API

## Goal

`detectDefaultBranches(cwd, runGit)` returns branch *names* (`"main"`,
`"master"`, …), not git refs. Callers must remember to prefix with the remote
(`origin/${name}`) before using the value as a comparison base — otherwise
`git log main..HEAD` compares against the *local* `main`, which in worktrees
already contains the branch's commits and silently prints zero output. This
footgun was caught by the gh-ludics-374 happy-path test, and the late Codex
catch on master-based repos showed the full problem surface: callers must hand-
build a cascade (`origin/<name>` → `upstream/<name>` → local `main`/`master` →
last-resort) at every site that wants a "compare against default" base.

This proposal adds a `resolveBaseRef(cwd, runGit)` helper that returns a
ready-to-use git ref, hardens `detectDefaultBranches` with JSDoc that points
callers at the new helper, and migrates the two sites in the codebase that
benefit. As a piggy-backed cleanup it also folds
`detectDefaultBranchesAuthoritative` into `detectDefaultBranches` via an
options bag, removing the duplicate function.

Source: gh-ludics-374 retrospective (coder's `suggestRefactorSummary` item 6
+ durable learning L1, 2026-04-24). Related PR #393 merged.

## Acceptance Criteria

- [ ] **`resolveBaseRef`** is exported from `src/git-runner.ts` with the
  signature `(cwd: string, runGit: RunGit) => string | null`. JSDoc explains
  the cascade and the contrast with `detectDefaultBranches`. Cascade:
  1. If `detectDefaultBranches(cwd, runGit).origin` is non-null, return
     `origin/<that-name>`.
  2. Else if `detectDefaultBranches(cwd, runGit).upstream` is non-null,
     return `upstream/<that-name>`.
  3. Else, for each candidate in `["main", "master"]`, probe
     `git rev-parse --verify --quiet refs/heads/<candidate>`; on the first
     non-empty success return the bare name (`"main"` or `"master"`).
  4. Return `null` if every probe fails.
- [ ] **JSDoc on `detectDefaultBranches`** gains an explicit one-liner:
  the return values are branch names, not refs; for a ready-to-use comparison
  base prefer `resolveBaseRef`. Include a usage example contrasting
  `git log main..HEAD` (wrong — compares against local `main`) with
  `git log origin/main..HEAD` / `resolveBaseRef`.
- [ ] **`detectDefaultBranchesAuthoritative` is folded into
  `detectDefaultBranches`** via an options-bag third argument:
  `detectDefaultBranches(cwd: string, runGit: RunGit, opts?: { authoritative?: boolean }): DetectedBranches`.
  When `opts.authoritative === true`, the function adds the `ls-remote
  --symref` network tier between symbolic-ref and the main/master probe (the
  exact behaviour of the current `detectDefaultBranchesAuthoritative`).
  Default behaviour (no opts, or `authoritative: false`) is unchanged from
  today's `detectDefaultBranches`. The named export
  `detectDefaultBranchesAuthoritative` is removed; its sole caller
  (`src/staging-ff.ts`) is migrated to
  `detectDefaultBranches(path, opts.runGit, { authoritative: true })`.
- [ ] **`src/orchestration/index.ts` is migrated**: the private
  `resolveDiffBase` function (currently hand-rolling the cascade with a
  literal `"main"` last-resort) is replaced by
  `resolveBaseRef(wt, runGit) ?? "main"` at the call site inside `orchDiff`.
  The behaviour of falling back to the literal string `"main"` when nothing
  else exists is preserved, but the `?? "main"` lives in the caller (per the
  task body's contract that the helper itself returns `null`).
  `resolveDiffBase` is deleted.
- [ ] **`src/orchestration/skills.ts` `proposalFreshnessWarning` is
  migrated**: the current `detectDefaultBranches(...).origin` + manual
  `refs/remotes/origin/${origin}` construction is replaced by a
  `resolveBaseRef(...)` call. When the helper returns `null`, the warning
  no-ops as before. When the helper returns `upstream/<n>` or local
  `main`/`master`, the freshness check runs against that ref — the user
  has confirmed this semantics change is acceptable.
- [ ] **No migration** of `src/briefing-lag.ts`: that caller needs the two
  branch *names* separately (`upstream/${branches.upstream}...origin/${branches.origin}`),
  not a single comparison base. It continues to call
  `detectDefaultBranches` (post-fold: same call, no opts).
- [ ] **Regression tests** in `src/git-runner.test.ts` cover `resolveBaseRef`
  against fixtures shaped via the existing `fakeGit` helper:
  - origin-symref present → returns `origin/<name>`.
  - origin-symref empty + upstream-symref present → returns `upstream/<name>`.
  - both remote symrefs empty + `refs/heads/main` exists → returns `"main"`.
  - both remote symrefs empty + `refs/heads/master` only → returns `"master"`.
  - all probes fail → returns `null`.
- [ ] **Existing tests for `detectDefaultBranches`,
  `detectDefaultBranchesAuthoritative`** are updated to the unified API:
  authoritative cases now pass `{ authoritative: true }`. No coverage is
  lost. The 9 tests added in gh-ludics-374 continue to pass.
- [ ] **No new caching, memoization, or cross-repo handling**. Each call
  performs at most a small handful of `git` invocations; that's intentional
  per the task body.
- [ ] **Verification**: `bun run typecheck && bun run lint && bun run build && bun test` all pass.

## Context

All targets live in a small, focused subset of the codebase.

### `src/git-runner.ts` — where the new helper lives

- `detectDefaultBranches(cwd, runGit): DetectedBranches` is the existing
  no-network helper. Its `read(remote)` closure does
  `symbolic-ref refs/remotes/<r>/HEAD` → `rev-parse --verify --quiet
  refs/remotes/<r>/{main,master}` → `null`.
- `detectDefaultBranchesAuthoritative(cwd, runGit): DetectedBranches` is the
  network-tier sibling. Same shape; adds `ls-remote --symref <remote> HEAD`
  between the two local tiers, parsing `^ref:\s+refs/heads/(.+?)\s+HEAD\b`
  out of stdout. Used only by `staging-ff.ts` after a `git fetch` already
  warmed network.
- `RunGit` type and `defaultRunGit` runner are also defined here.

The `read(remote)` closures of the two existing functions differ only in
the `ls-remote --symref` block. Folding them is mechanical: parameterise
the closure on a boolean and skip the `ls-remote` block when false.

### `src/orchestration/index.ts` — primary migration target

- `resolveDiffBase(wt, runGit): string` (private) inside the `orchDiff`
  module is the canonical implementation of the cascade
  this proposal lifts. It hand-rolls `origin/<n>` → `upstream/<n>` →
  `refs/heads/main` / `refs/heads/master` probes → literal `"main"`
  last-resort. After migration this function is deleted; its single
  call site inside `orchDiff` becomes
  `const base = resolveBaseRef(wt, runGit) ?? "main";`.

### `src/orchestration/skills.ts` — secondary migration target

- `proposalFreshnessWarning(projectDir, proposalPath)` calls
  `detectDefaultBranches(projectDir, defaultRunGit)`, takes only `origin`,
  builds `const ref = \`refs/remotes/origin/${origin}\``, and uses that ref
  for `git merge-base --is-ancestor` and `git rev-list --count`. After
  migration:
  ```ts
  const ref = resolveBaseRef(projectDir, defaultRunGit);
  if (!ref) return "";
  ```
  The downstream `merge-base --is-ancestor` and `rev-list --count` calls
  use `ref` directly. The `null` return on all-probes-fail keeps the same
  silent no-op semantics the function already has on `!origin`.

### `src/briefing-lag.ts` — left alone

- Calls `detectDefaultBranches(path, opts.runGit)` and requires *both*
  `branches.origin` and `branches.upstream` as separate names to construct
  `upstream/${branches.upstream}...origin/${branches.origin}`. This caller's
  needs don't fit `resolveBaseRef`'s single-ref contract. Continues to use
  `detectDefaultBranches` with no opts.

### `src/staging-ff.ts` — migrated to options bag

- The single caller of `detectDefaultBranchesAuthoritative`. After folding,
  the call becomes
  `detectDefaultBranches(path, opts.runGit, { authoritative: true })`.
  Behaviour unchanged.

### `src/git-runner.test.ts` — fixture style to follow

- Uses a `fakeGit(rules)` helper that dispatches on argv-prefix matching;
  the first matching rule wins. Existing tests for both
  `detectDefaultBranches` and `detectDefaultBranchesAuthoritative` are
  written this way and serve as the template for the new
  `resolveBaseRef` tests and the unified-API updates. Test for
  "no `ls-remote` calls when `authoritative` is false / unset" is worth
  keeping as a guard against accidental regression of the no-network
  contract for the briefing-lag path.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **Fold first.** Refactor `detectDefaultBranches` to accept an optional
   `{ authoritative?: boolean }` third argument. The two `read(remote)`
   closures collapse to one parameterised helper. Delete
   `detectDefaultBranchesAuthoritative`. Migrate the single caller in
   `staging-ff.ts`. Update `git-runner.test.ts`: rename the
   `detectDefaultBranchesAuthoritative` describe block, change the calls to
   pass `{ authoritative: true }`, and verify the no-`ls-remote`-on-default
   guard remains.

2. **Add `resolveBaseRef`.** Implement using the (now-unified)
   `detectDefaultBranches` for the symref/probe tier and an inline
   `rev-parse --verify --quiet refs/heads/<n>` loop for the local-branch
   tier. Add JSDoc per the acceptance criterion. Add the 5 fixture-driven
   regression tests.

3. **JSDoc-harden `detectDefaultBranches`.** Add the one-liner pointing
   callers at `resolveBaseRef`, plus a short worked example
   (`git log main..HEAD` wrong; `git log origin/main..HEAD` /
   `resolveBaseRef` right).

4. **Migrate callers.** `orchDiff` in `src/orchestration/index.ts`:
   replace `resolveDiffBase` with `resolveBaseRef(wt, runGit) ?? "main"`
   at the call site, delete `resolveDiffBase`.
   `proposalFreshnessWarning` in `src/orchestration/skills.ts`: replace
   the manual `refs/remotes/origin/${origin}` construction with the
   `resolveBaseRef` return value (no string-building).

5. **Verify.** `bun run typecheck && bun run lint && bun run build && bun test`.
   Manually skim `src/` for any remaining `detectDefaultBranchesAuthoritative`
   import (none should exist) and any remaining hand-rolled cascade
   (none should exist).

The fold (step 1) and the helper add (step 2) are independent and could be
sequenced either way; doing the fold first lets `resolveBaseRef`'s
implementation reuse the unified `detectDefaultBranches` cleanly.

## Scope

**In scope:**

- New helper `resolveBaseRef` in `src/git-runner.ts`.
- JSDoc updates on `detectDefaultBranches`.
- API consolidation: fold `detectDefaultBranchesAuthoritative` into
  `detectDefaultBranches` via options bag; delete the now-redundant
  function.
- Migrate `src/orchestration/index.ts` `orchDiff` (delete
  `resolveDiffBase`).
- Migrate `src/orchestration/skills.ts` `proposalFreshnessWarning`.
- Migrate `src/staging-ff.ts` to the options-bag API.
- Tests in `src/git-runner.test.ts`: 5 new for `resolveBaseRef`, plus
  fold-driven updates to existing authoritative cases.

**Out of scope:**

- Renaming `detectDefaultBranches` itself.
- Caching / memoizing the cascade.
- Cross-repo / federation concerns.
- A separate `resolveBaseRefAuthoritative` variant (no caller wants one;
  YAGNI).
- Migrating `src/briefing-lag.ts` (semantics differ — needs both names
  separately).

**Dependencies:** none.

**Related:** gh-ludics-374 (PR #393 merged) — built `orch diff` and
exposed the footgun via the late Codex catch on master-based repos.
