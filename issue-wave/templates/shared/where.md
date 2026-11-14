- Repository: `@@REPO@@` (GitHub; PRs and branches), main branch `@@MAIN@@`. Issues live in
  `@@ISSUE_REPO@@`. Pass `--repo` to every `gh` command.
- Your worktree (absolute, already created, yours alone to write): `@@WT@@`
- Your branch: `@@BR@@`, created from base `@@BASE@@` (@@BASE_ORIGIN@@).
- Never edit `@@CHECKOUT@@` (the project's main checkout: other sessions read it; it is read,
  never moved: never run checkout/switch/reset/stash/rebase/merge there) or any sibling worktree
  under `@@CHECKOUT@@-worktrees/`.
- Run every shell command with an explicit cwd: `cd "@@WT@@" && ...`, or `git -C "@@WT@@"`. Every edit
  uses an absolute path under `@@WT@@`. An inherited cwd does not isolate you.
- Scratch files go in your own directory `@@SCR@@/` (create it; every worker of this wave shares
  the parent). Never put scratch inside the worktree. Re-read a body file immediately before the
  `gh` command that consumes it.
- **Never use `git stash`**: the stash is shared by every worktree of the repository, and a
  sibling's `stash pop` can apply yours. Make WIP commits; squash onto the merge base
  (`git reset --soft "$(git merge-base HEAD origin/@@MAIN@@)"`), never `git reset --soft
  origin/@@MAIN@@` once the main branch has moved.
- Credentials: never borrow, copy or export a credential from another box, file or account to get
  past an authentication failure. A `gh`, push or login that fails on authentication or
  authorization (a 401 or 403, `Permission denied (publickey)`, `could not read Username`, an
  expired token) is a gate: report it and stop. Any other failed push is not that gate. A
  transient one (`remote rejected ... (failed)`, a 5xx, a dropped connection) is retried after a
  short wait, with no credential change, and reported only when it persists; a non-fast-forward
  is yours to resolve.
