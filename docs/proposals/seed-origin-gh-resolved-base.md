# Pre-create defense: seed `origin.gh-resolved=base` on orchestration worktrees

## Goal

Prevent orchestration coder agents from creating PRs against the wrong
repository (the fork *parent* instead of the fork itself) when they run
`gh pr create` without an explicit `--repo`.

This is **layer 2** of the gh-staging-fork hardening, companion to the
already-merged **layer 1** (PR #554, `findProjectConfig` worktree-path
recognition, which resurrects the post-hoc wrong-base-repo gate).

Triggered by `ahrefs/ocannl#458`: a coder agent in
`~/ocannl-staging-task-71e28eb1-s1` ran `gh pr create` without `--repo`; `gh`
defaulted to the fork parent (`ahrefs/ocannl`) instead of the staging fork
(`lukstafi/ocannl-staging`). The PR was merged on the upstream repo before
anyone noticed. Layer 1 makes that scenario *detectable* after the fact
(verify-failure → agent told to close and recreate), but cleanup is manual and
upstream provenance noise persists. Layer 2 stops the bad PR from being created
at all.

The load-bearing rationale (see Context) is subtle: the existing
`clearGhResolvedMarkers` defense, which *clears* gh-resolved markers, is the
right hygiene for non-fork repos but actively *enables* the #458 bug on forks —
after the clear, `gh` falls back to its fork-of-upstream default of targeting
the parent. The fix is to *clear then re-seed* a known-good
`origin.gh-resolved=base` marker (meaning "origin IS the base repo"), so
`gh pr create` resolves the PR base to origin.

## Acceptance Criteria

- After orchestration worktree creation (`createWorktrees`),
  `remote.origin.gh-resolved=base` is set on the parent repo's `.git/config`
  (and therefore inherited by every worktree, which shares that config), so a
  no-`--repo` `gh pr create` targets origin rather than the fork parent.
- `remote.upstream.gh-resolved` is never left set after `createWorktrees`: it
  is cleared and never re-seeded — only `origin` carries the pin.
- Clear-then-set ordering holds. Any pre-existing `origin.gh-resolved` value
  (a stale `base`, a wrong `head`, or a multi-valued key) is replaced by a
  single `base` value: no multi-valued key, no preserved stale value.
- The existing `clearGhResolvedMarkers` behavior is preserved — it still
  `--unset-all`s both `origin` and `upstream` first. The new seed is
  *additive* (runs after the clear), not a replacement for it.
- For projects whose config carries `upstream_repo`, an `upstream` remote is
  provisioned in the parent repo (idempotent: a no-op if it already exists, a
  `git remote add upstream <url>` if absent), so coders can pull from upstream
  during the work phase without manual setup. Non-fork projects (no
  `upstream_repo`) get no fabricated `upstream` remote.
- The base-for-all-projects assumption is stated explicitly in a code comment
  next to the seed: *no currently configured project wants orchestration PRs
  to land on the upstream parent it forked from*; if such a project ever
  appears it must opt out deliberately (a per-project setting), and the
  comment documents that this seed would otherwise silently retarget its PRs
  to staging.
- Layer 1 (PR #554, the post-hoc wrong-base-repo verify gate) is left intact —
  this task neither removes nor weakens it. The seed is a *prevention* layer in
  front of that *detection* catch-net.

## Context

### How it works now

`src/orchestration/worktrees.ts`:

- `createWorktrees(projectDir, taskId, agents, mainBranch, slot, mode)` builds
  the root (and, in duo mode, per-agent) worktrees. As its final step it calls
  `clearGhResolvedMarkers(resolve(projectDir))`.
- `clearGhResolvedMarkers(projectDir)` runs
  `git config --unset-all remote.<name>.gh-resolved` for `name ∈ {origin, upstream}`,
  via `safeSyncOutput` (never throws; absent-key non-zero exit is ignored).
  `--unset-all` (not `--unset`) is deliberate: it removes every value of a
  multi-valued key, where `--unset` would fail (exit 5) and the failure would
  be swallowed, leaving poisoning in place. Its doc comment frames it as
  generic defense-in-depth against "gh-resolved poisoning."
- Worktrees inherit the parent repo's `.git/config`, so a single config write
  on the parent covers all worktrees — confirmed by the existing test
  "createWorktrees clears gh-resolved markers" which asserts on the parent
  repo path.

`gh-resolved` semantics (confirmed against `gh`): `remote.<name>.gh-resolved=base`
means "this remote *is* the base repo." So `origin.gh-resolved=base` tells
`gh pr create` to resolve the PR's base repo to **origin**, overriding gh's
default of targeting the fork parent. Conversely `upstream.gh-resolved=base`
would say "upstream is the base" → PRs to upstream — the exact #458 bug. Hence:
seed *only* origin, never upstream.

Why clearing alone is wrong for a fork (the #458 root cause): after
`clearGhResolvedMarkers`, `gh` has no stored resolution and falls back to its
fork-of-upstream default — target the **parent** (`ahrefs/ocannl`). For
`ocannl-staging` (a fork of `ahrefs/ocannl`) that default *is* the wrong-repo
bug. `origin.gh-resolved=base` pins resolution to origin (staging), fixing it.
For non-fork projects (`ludics`, `ppx_minidebug`) origin is already canonical,
so `=base` is exactly what `gh` does anyway — redundant and harmless. (PR #554
deliberately did *not* address this; it resurrected the post-hoc gate. This
task is the prevention half.)

Config plumbing:

- `ProjectConfig` (`src/config.ts`) has `repo: string` (e.g.
  `lukstafi/ocannl-staging`) and optional `upstream_repo?: string` (e.g.
  `ahrefs/ocannl`).
- `findProjectConfig(projectDir, config?)` resolves the `ProjectConfig` for a
  directory. Since PR #554 it recognizes orchestration worktree paths and the
  parent project path alike — so calling it from inside `createWorktrees` with
  the parent `projectDir` resolves the right entry.
- `staging-ff.ts` already *uses* an `upstream` remote (`fetch upstream`,
  `merge --ff-only upstream/<default>`) but does **not** create it — its
  `skipped-no-upstream-remote` outcome fires when the remote is absent.
  Provisioning the `upstream` remote here removes that manual setup step for
  the work phase.

Test surface: `src/orchestration/worktrees.test.ts` constructs ad-hoc
`git init` repos and calls `createWorktrees(repo, ...)` directly, *without*
mocking config. In that path `findProjectConfig(repo)` returns `null` (the
ad-hoc repo matches no configured project). The origin-pin seed is therefore
config-independent — it writes `origin.gh-resolved=base` unconditionally
(origin existence is irrelevant; the marker lives under `remote.origin.*` in
config regardless of whether a real origin URL is set, exactly as the existing
"poisoned state" test relies on). Only the upstream-remote provisioning is
config-gated (requires a resolved `upstream_repo`).

Note on existing test labels: `worktrees.test.ts` calls `origin.gh-resolved=base`
a "poisoned state." That label is loose ("some leftover marker of unknown
provenance"). Semantically `origin=base` is the *good* value; the bad one is
`upstream.gh-resolved=base`. The existing clear-only test will need updating to
reflect that origin is now re-seeded to `base` after the clear (asserting
present-and-equal-to-`base` for origin, still-absent for upstream).

## Approach

*Suggested approach — agents may deviate if they find a better path.*

In `src/orchestration/worktrees.ts`:

1. Add `seedGhResolvedToOrigin(projectDir: string)` that runs
   `git config remote.origin.gh-resolved base` (plain set, which replaces any
   single existing value). To guarantee no multi-valued key survives, either
   rely on the preceding `clearGhResolvedMarkers` `--unset-all` (which already
   removed every value, so the subsequent plain set yields exactly one) or use
   `--replace-all` defensively. Use `safeSyncOutput` (never throws), matching
   the surrounding helpers. Document the base-for-all-projects assumption in a
   comment here.

2. In `createWorktrees`, **after** the existing
   `clearGhResolvedMarkers(resolve(projectDir))` call, add
   `seedGhResolvedToOrigin(resolve(projectDir))`. Order is load-bearing:
   clear (`--unset-all` both remotes) *then* seed (`origin=base` only). The
   clear still wipes any `upstream.gh-resolved`; the seed re-installs only the
   origin marker.

3. Add `ensureUpstreamRemote(projectDir, upstreamRepo)` (or inline) that, when
   the resolved config has `upstream_repo`, runs `git remote add upstream <url>`
   if no `upstream` remote exists (idempotent — check via
   `git remote get-url upstream` / `git config --get remote.upstream.url`).
   Derive `<url>` from `upstream_repo` in the same SSH form origin was cloned
   in (`git@github.com:<owner>/<repo>.git`), mirroring how the codebase already
   constructs `owner/repo` ↔ tail elsewhere. Resolve the config via
   `findProjectConfig(projectDir)` inside `createWorktrees`; guard the whole
   step on a non-null config with a non-empty `upstream_repo`. (Decide whether
   to derive the SSH-vs-HTTPS protocol from the existing
   `remote.origin.url` to stay consistent, or fix on SSH — a small judgment
   call for the implementer; SSH matches current OCANNL setup.)

Tests in `src/orchestration/worktrees.test.ts` (real `git`, ad-hoc repos):

- After `createWorktrees`, `git config --get remote.origin.gh-resolved`
  returns `base`.
- `remote.upstream.gh-resolved` is absent after `createWorktrees`.
- Clear-then-set: pre-seed a wrong/stale `origin.gh-resolved` (`ahrefs/ocannl`,
  `head`, or a multi-valued key via `--add`); after `createWorktrees`,
  `--get-all remote.origin.gh-resolved` returns exactly one line, `base`.
- Update the existing "clears gh-resolved markers" test: origin is now
  re-seeded to `base` (present), upstream still cleared (absent).
- Upstream provisioning: for a repo whose resolved config carries
  `upstream_repo`, an `upstream` remote exists after `createWorktrees` (and is
  idempotent on re-run); for a repo without `upstream_repo`, no `upstream`
  remote is fabricated. This test needs the config path exercised — either
  inject/stub `findProjectConfig` or point a fixture config at the temp repo
  per the existing config-test conventions (`config.test.ts`,
  `briefing-lag.test.ts` build `ProjectConfig` fixtures with `upstream_repo`).

After code changes, build and re-init per the project convention
(`bun run build`).

## Scope

In scope:
- `seedGhResolvedToOrigin` + its call in `createWorktrees` (after the clear).
- Idempotent `upstream` remote provisioning for `upstream_repo` projects.
- Tests above; updating the existing clear-only test's origin assertion.
- The base-for-all-projects assumption comment.

Out of scope:
- Option A (rewriting `remote.origin.url`): rejected — needless blast radius on
  fetch/push; `gh-resolved=base` achieves the same PR-targeting with zero
  perturbation of fetch/push.
- Option C (coder skill-template `gh pr create` guards): left as belt-and-braces
  for a follow-up if the config-level defense proves insufficient.
- Changing existing `gh pr create` invocations in tests/docs — the config-level
  defense is transparent to call sites.
- Recovery flow for the already-merged `ahrefs/ocannl#458` — manual user
  cleanup, not a framework concern.
- A per-project "PR-to-upstream" opt-out — not needed today (no configured
  project wants it); only the assumption comment is required so a future such
  project surfaces as a deliberate opt-out rather than a silent breakage.

Relates to: task-71e28eb1 (the originating workflow-feedback task). Builds on
the merged layer 1 (PR #554); the layer-1 post-hoc gate remains the catch-net.
