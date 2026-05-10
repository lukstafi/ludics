# Commit proposals on the project's default branch; preserve worktree directories on resume

## Goal

Make orchestration session start-up reliable by ensuring that, by the time the
runner forks per-agent worktrees, the proposal commit is already on the
project's default branch — and that on a later resume the orchestration
worktree directories are preserved (not torn down and re-checked-out) so any
agent scratch survives.

The originating symptom (PR #517 / `task-a1e55a19`) was a cold-start coder
failing to find `docs/proposals/task-a1e55a19-*.md` because the proposal
commit `b077953` had landed on `ludics/task-a1e55a19-s1/root` rather than on
`main`. In duo mode each agent's branch is forked from `mainBranch` at
`createWorktrees` time, so the coder/reviewer on `…/coder` and `…/reviewer`
never inherited the proposal — it only reached `main` when PR #517 merged.

The same shape of footgun bit Mag herself on 2026-05-10: committing
`docs/swe-textbook.md` to a leftover `task-a1e55a19/proposal` branch in the
shared `~/ludics` checkout and then having to cherry-pick onto a freshly
fast-forwarded `main`.

Related task: `task-7a5e2add` (this task).

## Acceptance Criteria

The criteria below correspond 1:1 to the user's three-part scope. Each is
verifiable.

### Scope (1) — Worker skills commit on the project's default branch

- `skills/ludics-draft-proposal-worker.md` step 8 ("Commit and push") instructs
  the worker to switch to the project's default branch and fast-forward it
  before staging — concretely: a `git checkout <default-branch> && git pull
  --ff-only` runs against `<project_path>` *before* `git add`. After the
  commit, the worker runs `git push origin <default-branch>` (push the named
  branch explicitly — do not rely on the working tree's prior HEAD).
- `skills/ludics-revise-proposal-worker.md` step 6, **file-based mode** has
  the same fix shape applied to its `cd <project_path>` block. (The
  harness-side `cd "$LUDICS_STATE_PATH"` block in step 6 is unchanged — the
  harness repo only has `main` and is not at risk.)
- The default-branch name is **resolved**, not hard-coded as the literal
  string `"main"`. The skill instructs the worker to use the same shape as
  `defaultMainBranch` in `src/orchestration/worktrees.ts`: shell out to
  `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` (strip the
  `origin/` prefix) and fall back to `main` if that fails. Projects on
  `master` / `trunk` are covered.
- **Fail-loud on operator-state corruption.** If `git checkout
  <default-branch>` cannot succeed (uncommitted changes on the prior
  branch, detached HEAD that can't be left, etc.), the worker stops and
  emits `status: "error"` with the diagnostic message from git. It must
  not commit on a different branch and it must not attempt to stash or
  reset the prior state.
- **Concurrent-push race is handled with a single retry, not fail-loud.**
  After a push that fails because the remote tip advanced (another slot
  pushed in the same window), the worker performs a single `git pull
  --rebase origin <default-branch> && git push origin <default-branch>`
  retry. A second failure is fail-loud (`status: "error"`).
- The two skill bodies are kept in lockstep (same control-flow shape, same
  default-branch resolution, same fail-loud / retry policy). If the
  implementing agent factors the recipe into a shared shell snippet or
  conventions-file fragment, both skills must reference it — drift between
  the two is the regression this task exists to prevent.

### Scope (2) — Worktrees fork from the default branch (invariant pinned, no behaviour change)

- No code change to `createWorktrees` in `src/orchestration/worktrees.ts`:
  the existing implementation already passes `mainBranch =
  defaultMainBranch(projectDir)` to each `addWorktree(..., branch,
  mainBranch)` call (root and per-agent in duo mode).
- The proposal lands a regression-style pin so the invariant is not lost
  to a future refactor. Either of the following is acceptable; the
  implementing agent picks one (or both):
  - A test in `src/orchestration/worktrees.test.ts` (or a sibling) that
    asserts, for duo mode, every per-agent branch and the root branch are
    created from `defaultMainBranch(projectDir)` (e.g., commits placed on
    `main` before `createWorktrees` are visible on every agent worktree's
    HEAD).
  - A short comment block at the `addWorktree(projectDir, rootWorktree,
    branches.root, mainBranch)` call site (and the per-agent equivalent)
    pinning the invariant in prose, with a one-line cross-reference to
    scope (1) in the worker skills.
- The pin must mention that this invariant is load-bearing **only when**
  scope (1) holds — i.e., the proposal commit reaches `main` before
  `createWorktrees` runs. The two scope items are paired and the comment
  / test docstring should say so.

### Scope (3a) — Cold-start agent CWD is the agent's worktree (regression test)

- A regression test pins, for **both** orchestration backends, that an
  agent launched at cold-start has its CWD set to
  `setup.agentWorktrees[agent.name]` (the path returned from
  `createWorktrees`).
- For the tmux backend the test exercises the path through
  `setupOrchestratedSlot` →
  `createTmuxAgentSession(slot, name, agent.worktreePath, taskId)` →
  `tmuxNewSession(name, cwd)`. It is acceptable to mock the tmux
  invocation and assert the `cwd` argument flowing into `tmuxNewSession`
  (or its lower-level spawn) equals `agent.worktreePath` for each agent
  in duo mode.
- For the t3code backend the test exercises the equivalent shape in
  `src/adapters/t3code.ts`: the agent's `DesiredThreadConfig` carries
  `worktreePath: agent.worktreePath`, and the dispatched `thread.create`
  payload pins that field per agent. Asserting at the
  `DesiredThreadConfig` boundary is sufficient — the t3code-server-side
  handling of `worktreePath` is out of scope for this task.
- The test does **not** need to assert subsequent-turn CWD: the
  `TmuxTransport.sendTurn` and `T3CodeTransport.sendTurn` paths inject
  prompts without `cd`, so the cold-start CWD is preserved by
  construction. A short comment in the test referencing this (so a
  future reader does not believe a per-turn assertion is missing) is
  sufficient.

### Scope (3b) — Resume short-circuit preserves worktree directory contents

- `addWorktree` (or a helper called from `createWorktrees`) gains a
  short-circuit: when **both** the worktree directory exists at `path`
  **and** the branch ref `refs/heads/<branch>` exists in `projectDir`,
  the function returns the existing setup (or its slot in
  `WorktreeSetup`) **without** running `removeIfRegistered`, without
  removing the directory, and without re-running `git worktree add`.
- The short-circuit is **conservative**: if the directory is registered
  with git but the registered path differs from `path`, or if the branch
  ref points to a different commit than the directory's HEAD believes,
  or if any other inconsistency is detected, the function falls back to
  the existing teardown-and-recreate path (i.e., the orphan-recovery
  branch in `addWorktree` is unaffected).
- A regression test exercises the resume path: create a worktree, write
  an uncommitted scratch file inside it, call `createWorktrees` again
  with the same `(taskId, agents, slot, mode)`, and assert the scratch
  file is still present afterwards. The same test asserts the branch
  ref still points to the same commit (the existing "branches are not
  reset" guarantee is preserved — `addWorktree` already never runs
  `git reset`, but the test pins this for the short-circuit path
  explicitly).
- The fall-through path (orphan recovery, missing branch, unrecognised
  directory contents) keeps its current behaviour. Existing tests in
  `src/orchestration/worktrees.test.ts` must continue to pass without
  modification.

## Context

### Worker skills (scope 1)

- `skills/ludics-draft-proposal-worker.md` — step 8 "Commit and push"
  currently does:

  ```bash
  cd <project_path>
  git add <proposals_path_relative>/<feature>.md
  git commit -m "proposal: <title>"
  git push
  ```

  with no branch discipline. `<project_path>` is a shared checkout in
  `~/<repo-name>` so its current HEAD is unspecified state.
- `skills/ludics-revise-proposal-worker.md` — step 6 "Commit and push",
  file-based mode, has the same shape against `<project_path>`. The
  harness-side block (`cd "$LUDICS_STATE_PATH"`) below it is not at
  risk and is unchanged.
- `defaultMainBranch(projectDir)` lives in
  `src/orchestration/worktrees.ts`; the skill instructions can mirror
  the one-liner directly without importing it (workers are markdown,
  not TS).

### Worktree creation (scope 2)

- `createWorktrees(projectDir, taskId, agents, mainBranch, slot, mode)`
  in `src/orchestration/worktrees.ts` already defaults `mainBranch =
  defaultMainBranch(projectDir)` and threads it to:
  - `addWorktree(projectDir, rootWorktree, branches.root, mainBranch)`
    for the root branch.
  - per-agent `addWorktree(projectDir, path, branch, mainBranch)` in
    the duo branch.
- `addWorktree` runs `git worktree add path branch` when the branch
  already exists (preserving existing commits) and `git worktree add
  -b branch path base` when not (forking from `mainBranch`). Either
  path inherits the proposal commit only when it is already on
  `mainBranch` at `createWorktrees` time.

### Agent spawn / CWD (scope 3a)

- tmux backend: `setupOrchestratedSlot` in
  `src/adapters/tmux-adapter.ts` calls `createWorktrees`, then for
  each agent `createTmuxAgentSession(ctx.slot, agent.name,
  agent.worktreePath, taskId)`; the inner call passes `cwd =
  agent.worktreePath` into `tmuxNewSession(name, cwd)`. The pane is
  born inside the agent's worktree.
  `TmuxTransport.sendTurn` in `src/orchestration/transport-tmux.ts`
  injects prompts without `cd`, so subsequent turns inherit the
  cold-start CWD.
- t3code backend: same shape in `src/adapters/t3code.ts`. Per agent,
  the runner builds a `DesiredThreadConfig` with `worktreePath:
  agent.worktreePath` and dispatches `thread.create`; the t3code
  server stores `worktreePath` on the thread, and
  `T3CodeTransport.sendTurn` dispatches `thread.turn.start` against
  that thread.
- Both backends are already correct on cold-start; the AC narrows
  scope (3a) to a regression test pinning the invariant for both.

### Resume / restart path (scope 3b)

- On reassign / resume, both `tmux-adapter.ts` and `t3code.ts` call
  `createWorktrees` unconditionally. `addWorktree` always begins with
  `removeIfRegistered(projectDir, path)` — which runs `git worktree
  remove --force path` — and then re-adds. Branch refs are preserved
  (no `git reset` on this path); the worktree directory is wiped, so
  any uncommitted scratch is lost.
- In practice `auto-commit-worktree` (in `src/orchestration/runner.ts`)
  commits agents' work each round, but the user's wording in scope (3)
  ("skips re-create … without resetting") asks for a stronger
  guarantee: when both the directory and the branch ref exist, do not
  touch git or the filesystem.

### Retired alternatives

The following framings were explored in earlier elaboration cycles
and are explicitly **retired** — they should not appear in
implementation plans or downstream proposals:

- "Orchestrator runner does `git merge --ff-only task-<id>/proposal`
  before forking worktrees" (option-a). This compensated for the
  symptom but left the worker still committing on whatever stale
  branch happened to be checked out, and it required orchestration to
  know about a sibling branch.
- "Worker-conventions checklist tells humans / agents to verify the
  branch before committing" (option-b). This is a process patch, not
  a code patch, and would not be enforceable by CI.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

A reasonable implementation order:

1. **Scope (1)** — edit `skills/ludics-draft-proposal-worker.md` step 8
   and `skills/ludics-revise-proposal-worker.md` step 6 (file-based
   mode). The recipe per skill, in shell terms:

   ```bash
   cd <project_path>
   default_branch=$(
     git symbolic-ref --quiet --short refs/remotes/origin/HEAD \
       | sed 's|^origin/||'
   )
   default_branch=${default_branch:-main}
   git checkout "$default_branch"      # fail-loud if this fails
   git pull --ff-only origin "$default_branch"
   git add <repo-relative-proposal>
   git commit -m "proposal: <title>"
   if ! git push origin "$default_branch"; then
     git pull --rebase origin "$default_branch"
     git push origin "$default_branch"   # one retry; fail-loud after
   fi
   ```

   Both skills should converge on the same shape; the implementing
   agent decides whether to inline it twice or factor it into a shared
   conventions-file fragment that both skills reference. Either is
   fine — drift between the two is what the AC forbids.

2. **Scope (3b)** — short-circuit in `addWorktree` (or extracted into a
   helper called from `createWorktrees`):

   ```ts
   // Before removeIfRegistered + the orphan-recovery dance:
   if (existsSync(path) && branchRefExists(projectDir, branch)) {
     // Conservative: only short-circuit if the registered worktree
     // path matches `path` (i.e., git agrees this directory is the
     // worktree for this branch). Otherwise fall through to the
     // existing teardown-and-recreate path.
     if (registeredWorktreeMatches(projectDir, path, branch)) return;
   }
   ```

   `registeredWorktreeMatches` parses `git worktree list --porcelain`
   for an entry whose path equals `path` and whose branch equals
   `refs/heads/<branch>`. If anything is off, fall through.

3. **Scope (2)** and **Scope (3a)** — the regression tests. These can
   share fixtures with existing `worktrees.test.ts` setup. For the
   t3code-side cold-start test, asserting at the `DesiredThreadConfig`
   boundary (the value the runner constructs and dispatches) avoids
   needing a live t3code server.

The two skill files (scope 1) and the runner change (scope 3b) are
independently testable; nothing forces a particular merge order
within the task. The regression tests for scopes (2) and (3a) are
read-only with respect to runtime behaviour and should land alongside
the change that makes their invariants load-bearing (scope 1 / scope
3b respectively).

## Scope

**In scope:**

- Edits to `skills/ludics-draft-proposal-worker.md` (step 8) and
  `skills/ludics-revise-proposal-worker.md` (step 6 file-based mode).
- A regression-style pin (test or comment) for `createWorktrees`
  forking from the default branch.
- Regression tests for cold-start agent CWD on both tmux and t3code
  backends.
- Short-circuit in `addWorktree` (or `createWorktrees`) preserving the
  worktree directory when both directory and branch ref exist, plus a
  regression test for it.

**Out of scope:**

- Any change to the orchestrator runner that "merges the proposal
  branch onto main" — explicitly retired.
- Any worker-conventions checklist as the *primary* fix — explicitly
  retired. (A conventions-file fragment is fine if it is the shared
  snippet that scope (1) skills reference; it is not a substitute for
  the skill edits.)
- Changes to t3code server-side handling of `worktreePath`.
- Changes to `auto-commit-worktree` round commit semantics.
- Behaviour of the orphan-recovery branch in `addWorktree` (it is
  preserved as-is and lives downstream of the new short-circuit).

**Dependencies:** none on other open tasks. Relates to
`task-a1e55a19` (the originating retrospective).
