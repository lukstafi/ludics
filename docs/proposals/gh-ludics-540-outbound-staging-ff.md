# Outbound staging→upstream fast-forward pusher

## Goal

The harness already fast-forwards staging *from* upstream once per day via
`syncStagingMainWithUpstream` (in `src/staging-ff.ts`). The reverse direction —
forwarding upstream from staging when staging is strictly ahead — is currently
manual. The 2026-05-18 recovery had to `git push upstream master:master` from
`~/ocannl-staging` to fast-forward `ahrefs/ocannl` by 139 commits after a
19-day gap, and that gap was only visible as a passive note in briefing-lag,
not as an actionable nudge.

Add an outbound counterpart that mirrors the inbound flow, gated by a new
per-project opt-in and surfaced through the existing health-check / briefing-lag
channels.

Issue: https://github.com/lukstafi/ludics/issues/540

## Acceptance Criteria

1. A new entrypoint `syncUpstreamMainFromStaging` (sibling to
   `syncStagingMainWithUpstream` — either in `src/staging-ff.ts` or in a new
   `src/staging-ff-outbound.ts`) returns results from the outcome union
   `pushed | skipped-no-staging-commits | skipped-not-fast-forward |
   skipped-no-push-credentials | skipped-no-upstream-remote |
   skipped-local-staging-behind`. Extend the union only when a captured stderr
   shape demands it; do not pre-emptively invent outcomes.
2. The function mirrors the inbound shape: an options interface analogous to
   `FastForwardOptions`, a `withCheckout` wrapper, the dirty-tree guard via
   `worktreeClean`, and sentinel throttling at the same 24h cadence.
3. **Pull-before-push.** Before the ancestry pre-check and before the push,
   the function runs `git fetch origin <staging-default>` and fast-forwards
   the local `<staging-default>` to `origin/<staging-default>`. If the local
   checkout cannot fast-forward (worker pushed a non-ff to origin, dirty tree,
   detached HEAD that the wrapper cannot restore), the function emits
   `skipped-local-staging-behind` and skips the push **without touching the
   sentinel** so the stale-sentinel signal fires.
4. Ancestry pre-check: `git merge-base --is-ancestor upstream/<u>
   origin/<o>` decides fast-forward eligibility. On non-ancestor, the
   function emits `skipped-not-fast-forward` (with the divergence count in
   the event payload), skips the push, and does NOT touch the sentinel —
   divergence stays visible to the next tick and to briefing-lag.
5. The push refspec uses `detectDefaultBranches` so origin/upstream default-
   branch divergence is respected: `origin/<branches.origin>:<branches.upstream>`
   (not assumed parity). Push runs with `--ff-only` as a belt-and-suspenders
   client-side guard alongside server-side rejection of non-ff updates.
6. Sentinel file: `mag/last-outbound-fast-forward-<project>.epoch`. Touched
   on every successful tick (`pushed` outcome) AND on transient-network
   skip; NOT touched on `skipped-no-push-credentials` or
   `skipped-local-staging-behind` (so the health-check's stale-sentinel
   signal fires fast on those).
7. **Per-project opt-in.** Schema adds a new field
   `outbound_sync_enabled: boolean` on `ProjectConfig`, defaulting to
   `false`. The outbound tick short-circuits on any project where this is
   missing or false. OCANNL's entry in `config.yaml` is flipped to
   `outbound_sync_enabled: true` in the same PR.
8. **Federation controller gate.** A new keepalive entrypoint
   `runStagingOutboundPushTick` short-circuits when `clusterIsController()`
   returns `false`, just like the inbound `runStagingFastForwardTick`. The
   test harness asserts zero git invocations recorded when the controller
   gate is false.
9. **No user-facing notification on auth failure.**
   `skipped-no-push-credentials` is surfaced only through the health-check's
   `outbound-staging-ff-stale:<project>` finding (warning at 48h since the
   sentinel was last touched, critical at 72h). No `ludics notify outgoing`
   call from the push function or its caller.
10. Wiring: `src/mag.ts`'s keepalive body calls
    `runStagingOutboundPushTick()` next to the existing
    `runStagingFastForwardTick()` invocation, in the slot between
    `maybeResumeDeadOrchestrators` and `maybeFillEmptySlots`. Both are gated
    by the same `clusterIsController()` guard.
11. Briefing-lag: `src/briefing-lag.ts`'s `formatUpstreamLagSection` adds an
    "outbound sentinel stale > 48h" annotation analogous to
    `fetchFreshnessNote`. The annotation reads the same
    `mag/last-outbound-fast-forward-<project>.epoch` mtime that the
    health-check uses.
12. Health-check finding key `outbound-staging-ff-stale:<project>` is added
    to the stable-key list in `skills/ludics-health-check.md`. Thresholds:
    warning at 48h since last-touched sentinel, critical at 72h. Delta-tracked
    against `mag/health-last.json` so the same staleness counts as
    `ongoing`, not new, after the first detection.
13. Test coverage in `src/staging-ff.test.ts` (or a sibling
    `.test.ts`) using the existing `recordingGit` + `defaultSymbolicRef`
    harness:
    - (a) happy push path: `pushed` outcome, sentinel touched, the
      recorded push call uses the correct
      `origin/<origin-default>:<upstream-default>` refspec with `--ff-only`.
    - (b) no-staging-commits skip: no `["push", ...]` entry recorded in
      `calls`.
    - (c) ancestry-check fails → `skipped-not-fast-forward` (no push
      recorded, sentinel NOT touched).
    - (d) credentials-missing → `skipped-no-push-credentials` (stderr
      classifier hits `Permission denied` / `could not read Username` /
      `Authentication failed`; sentinel NOT touched).
    - (e) no-upstream-remote → `skipped-no-upstream-remote`.
    - (f) **pull-before-push ordering**: in the happy path, the recorded
      `["fetch", "origin", "<staging-default>"]` call appears earlier in
      `calls` than the `["push", ...]` call.
    - (g) **local-behind classification**: when the local checkout cannot
      fast-forward to `origin/<staging-default>` →
      `skipped-local-staging-behind` (no push recorded, sentinel NOT
      touched).
14. Test coverage for the controller gate: when `clusterIsController()` is
    stubbed to return `false`, `runStagingOutboundPushTick` records zero
    git invocations.
15. Documentation: the OCANNL project entry in `config.yaml` carries
    `outbound_sync_enabled: true` and a short comment naming the new
    sentinel; the harness `CLAUDE.md` (or briefing-lag prose, whichever
    already names the inbound sentinel) gains a one-line mention of the
    outbound sentinel.

## Context

### Inbound flow (template to mirror)

`src/staging-ff.ts` exports `syncStagingMainWithUpstream(projects, opts)` and
defines the outcome union `FastForwardOutcome`. The function:

- iterates `projects` filtered by `upstream_repo`,
- short-circuits when `sentinelFresh(sentinel, now, 24h)`,
- resolves the checkout path via `expandHome(p.path)`,
- guards on `hasRemote(path, "upstream", runGit)`,
- fetches upstream and uses `detectDefaultBranches(..., { authoritativeIO: true })`
  to learn `branches.origin` and `branches.upstream`,
- bails on dirty worktree without touching the sentinel,
- wraps the merge in `withCheckout(path, branches.origin, runGit, () => …)` so
  detached-HEAD and branch-restore are handled,
- emits events through `opts.emitEvent` decoupled from `./events.ts`,
- touches the sentinel on success and on classified failures (so we don't spam
  each tick).

The inbound test file `src/staging-ff.test.ts` defines a `recordingGit`
helper that records every `git` argv into `calls`, with a `symbolicRef`
escape hatch for default-branch detection (`defaultSymbolicRef` maps
`refs/remotes/origin/HEAD` → `master`, `refs/remotes/upstream/HEAD` →
`master`). This is the canonical fixture for the new tests.

### Wiring template

`src/mag.ts` defines `runStagingFastForwardTick` (around line 1797) and the
keepalive body calls it at line 3167 — between `maybeResumeDeadOrchestrators`
and `maybeFillEmptySlots`. The wrapper:

- gates on `clusterIsController()`,
- gates on `cfg.mag?.enable_staging_fast_forward !== false`,
- short-circuits if no project has `upstream_repo`,
- creates the sentinel dir under `mag/`,
- calls `syncStagingMainWithUpstream` with `defaultRunGit` and an
  `emitEvent` adapter to the harness event bus,
- console-logs interesting outcomes.

The outbound wrapper should additionally filter on
`outbound_sync_enabled === true`.

### Briefing-lag

`src/briefing-lag.ts`'s `formatUpstreamLagSection` renders the "staging
AHEAD / staging behind" block per project. `fetchFreshnessNote(cwd, now,
6h)` annotates when `.git/FETCH_HEAD` is stale. The outbound annotation
mirrors this pattern: read the mtime of
`<sentinelDir>/last-outbound-fast-forward-<project>.epoch` and append a
line when it exceeds 48h.

### Health-check skill

`skills/ludics-health-check.md` maintains a stable-key list for delta
tracking against `mag/health-last.json` (examples already named:
`deadline:<task-id>`, `slot-stale:<slot>`, `queue-stuck:<request-id>`,
`test-health:<project-name>`). Add `outbound-staging-ff-stale:<project>`.

### Sentinel primitives

`src/sentinel.ts` exposes `sentinelFresh(file, now, throttleSec)` and
`touchSentinel(file, now)`. Naming the outbound sentinel
`last-outbound-fast-forward-<project>.epoch` keeps inbound/outbound
independent so a single tick failing one direction does not throttle the
other.

### Config schema

`config.yaml`'s OCANNL entry already has:

```yaml
upstream_repo: ahrefs/ocannl
repo: lukstafi/ocannl-staging
path: ~/ocannl-staging
```

The PR adds `outbound_sync_enabled: true` here. `ProjectConfig` in
`src/config.ts` gains the new optional boolean field.

### Outcome classification details

- **`skipped-no-staging-commits`**: derived from the ancestry pre-check
  showing zero divergence in the staging-ahead direction (i.e.
  `origin/<o>` is the same commit as `upstream/<u>`). No push needed.
- **`skipped-not-fast-forward`**: `merge-base --is-ancestor upstream/<u>
  origin/<o>` returns non-zero — upstream has commits not in staging, so
  forwarding upstream would be a non-ff update. Skip without touching the
  sentinel; briefing-lag already surfaces the divergence count.
- **`skipped-no-push-credentials`**: `git push` exited non-zero AND its
  stderr matched `Permission denied` / `could not read Username` /
  `Authentication failed` (case-insensitive). Sentinel NOT touched.
- **`skipped-local-staging-behind`**: the fetch-then-fast-forward of the
  local default branch to `origin/<staging-default>` failed (non-ff or
  refused). Sentinel NOT touched.
- Transient network failures on the fetch (not matching the credentials
  classifier) classify as a generic `error` AND touch the sentinel — same
  policy as the inbound flow's fetch-failure branch.

## Approach (optional)

*Suggested approach — agents may deviate if they find a better path.*

The outbound function is structurally the inbound function with three
substantive deltas:

1. The merge is replaced by a `push --ff-only origin
   <origin-default>:<upstream-default>` invocation, preceded by an
   ancestry pre-check in the *opposite* direction
   (`is-ancestor upstream/<u> origin/<o>` instead of `origin/<o>
   upstream/<u>`).
2. A pull-before-push step (`git fetch origin <staging-default>` plus a
   fast-forward of the local default branch) runs inside the
   `withCheckout` block, before the ancestry pre-check. If the local
   fast-forward fails, classify `skipped-local-staging-behind` and
   return.
3. A push-stderr classifier separates credentials failure from transient
   network failure, controlling whether the sentinel is touched.

Placement: putting the new function alongside the inbound one in
`src/staging-ff.ts` keeps the shared helpers (`worktreeClean`,
`commitCount`, `sentinelFile`) co-located. If the file grows uncomfortably,
splitting into `src/staging-ff-outbound.ts` is a clean follow-up — the
proposal does not mandate a choice.

The keepalive wiring is a one-line addition. The
`outbound_sync_enabled` filter happens inside the new wrapper before
calling the core function, so the core function does not need to know
about the new config field.

## Scope

**In scope:**
- New outbound function with the outcome union and behaviour above.
- New keepalive wrapper `runStagingOutboundPushTick` and its call site.
- Briefing-lag annotation for outbound sentinel staleness.
- Health-check stable-key entry.
- `ProjectConfig` schema extension for `outbound_sync_enabled`.
- OCANNL config flip to `outbound_sync_enabled: true`.
- Test coverage as enumerated in AC 13–14.
- Short doc mention of the new sentinel name.

**Out of scope:**
- Force-push or `--force-with-lease` flows — outbound is strictly fast-forward.
- Multi-project parallelism beyond what the existing inbound tick already does.
- Refactoring `syncStagingMainWithUpstream` to share more code with the
  outbound function — duplication is acceptable for this PR; a follow-up
  may extract a shared helper.
- Changes to the federation controller logic itself; reuse `clusterIsController()`.
- Notification fatigue mitigation beyond "don't notify on auth failure" —
  any future granular notifier is a separate task.

**Dependencies:** None on other tasks. Uses existing helpers
(`withCheckout`, `detectDefaultBranches`, `hasRemote`, `expandHome`,
`sentinelFresh`, `touchSentinel`, `clusterIsController`, `defaultRunGit`,
`emitEvent`) without modification.
