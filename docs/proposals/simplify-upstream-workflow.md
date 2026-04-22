# Simplify upstream workflow: complete at staging merge; surface upstream-vs-staging lag in briefing

## Goal

For projects declaring `upstream_repo` (currently: `ocannl` → `ahrefs/ocannl`), the
orchestration flow today diverges from the non-upstream flow after `pr-comments`:
it creates a staging-to-upstream PR (`forward-pr`), re-monitors the upstream PR,
and only calls `final-merge` after upstream merges. This complication has outgrown
its usefulness — forwarding and upstream-PR review are best handled manually by
the user.

This change collapses upstream projects onto the same post-`pr-comments` path as
non-upstream projects (merge on staging main = task done, followed by
`suggest-refactor` and retrospective). `upstream_repo` is retained for GitHub
issue tracking and for a new briefing section reporting staging-vs-upstream lag,
so the user can see at a glance when a manual catchup or forward-PR is due.

The change is scoped to a single-cutover; the five in-flight ocannl PRs are
handled manually by the user, with no in-code migration path.

## Acceptance Criteria

1. **Phase-graph removal.** `forward-pr` is no longer reachable in the phase
   graph or runner: `evaluateTransition` for `pr-comments` with `upstream_repo`
   set routes to `final-merge` on the same conditions as the no-upstream path
   (quiet period / coder-dispatched shortcut / timeout), and `final-merge` no
   longer branches on upstream-merged markers.
2. **Template deletion.** `skills/orchestration/forward-pr.md` and
   `skills/orchestration/upstream-final-merge.md` are deleted; no remaining
   template references `UPSTREAM_PR_FILE`, `UPSTREAM_MERGED_MARKER_FILE`, or
   `FORWARDED_MARKER_FILE`.
3. **Template-resolution signature.** `resolveTemplatePath`'s `hasUpstream`
   parameter is **retained** as a general override mechanism. If no production
   caller passes a truthy value after the cleanup, the parameter is marked
   intentionally unused at the call site (prefix `_` or JSDoc note). Tests
   exercise the override mechanism with a synthetic dummy template where
   needed.
4. **State-field cleanup.** `OrchestrationState.upstreamRepo` is **removed**
   from the state surface and from the two adapter constructors
   (`t3code.ts`, `tmux-adapter.ts`). `UPSTREAM_REPO` continues to be available
   to templates that still consume it (`pr-create.md`,
   `pair-coder-pr-create.md`) by being read directly from project config
   inside `buildSkillContext`.
5. **Runner post-merge detection.** The three-way `hasUpstream && forwarded` /
   `hasUpstream && !forwarded` / else split in
   `pollAndMaybeDispatchPrComments` collapses to the single branch that writes
   `<agent>.merged`, emits `pr_merged`, and notifies. The
   `upstream_pr_merged` event and the `.upstream-merged` marker are no longer
   written. `pushBeforePhases` no longer contains `"forward-pr"`.
6. **Briefing lag section.** `briefingPrecomputeContext()` writes a new
   **"Upstream vs Staging Lag"** section in `mag/briefing-context.md`, placed
   between `## Preempted Slots` and `## Sessions Report`. For each project
   with `upstream_repo` set, the section shows:
   - **"staging is N commits ahead of upstream"** (the primary signal,
     visually emphasised — this is the PRs-merged-on-staging-not-yet-forwarded
     count the user reviews),
   - "staging is M commits behind upstream" (secondary; normally 0 once the
     fast-forward job from AC 8 runs),
   - last-staging-merge and last-upstream-merge commit timestamps.

   The default branch is auto-detected (ocannl-staging uses `master`, not
   `main`) via `git symbolic-ref refs/remotes/{upstream,origin}/HEAD`. When the
   `upstream` remote is not configured on the project checkout, the block
   emits a one-line note and skips counts rather than failing.
7. **Briefing skill.** `skills/ludics-briefing.md` mentions the new
   "Upstream vs Staging Lag" section in its enumeration and includes it in
   the generated briefing output template. No computation logic lives in the
   skill — it relays the pre-computed context.
8. **Autonomous staging fast-forward.** The keepalive tick performs a
   once-per-day-per-project fast-forward of the staging fork's default branch
   from `upstream/<default>`. The job:
   - Runs only on the cluster controller (gated like other keepalive jobs).
   - Scoped to projects with `upstream_repo` set.
   - Fetches `upstream`, attempts a fast-forward-only pull on the project
     checkout's default branch; if the branch is not fast-forwardable
     (diverged) it logs / emits an event and takes no further action.
   - Never runs inside a slot worktree — only in the project's canonical
     checkout.
   - Respects a `last-fast-forward-<project>.epoch` sentinel so it runs at
     most once every 24 hours per project.
   - Forward-PR creation and pushing to upstream remain **manual**; this job
     does not create PRs and does not push.
9. **Tests.**
   - `phases.test.ts`: the "pr-comments with upstream + no forwarding
     transitions to forward-pr on quiet period" test is rewritten to assert
     the transition is now `final-merge`. The obsolete forwarding/upstream
     tests (enumerated in the task elaboration) are removed. A new test
     covers "with `upstream_repo` set and quiet-period elapsed,
     `evaluateTransition` returns `final-merge`" (symmetry with no-upstream).
   - `skills.test.ts`: tests asserting the specific `upstream-final-merge.md`
     selection are deleted; tests for `UPSTREAM_PR_FILE` /
     `UPSTREAM_MERGED_MARKER_FILE` context variables are deleted.
   - Lag computation is factored into a pure helper testable with either
     synthetic git-output fixtures or a temporary git repo.
10. **Documentation.** `docs/ARCHITECTURE.md` phase-chain diagram drops
    `forward-pr`; the follow-up paragraph is removed; the file-tree listing
    no longer lists `forward-pr.md` or `upstream-final-merge.md`.
    `CHANGELOG.md` has a new entry describing the workflow simplification.

## Context

### Current flow (upstream-aware path)

- `src/orchestration/phases.ts`:
  - `Phase` union includes `"forward-pr"`.
  - `PHASE_CATEGORIES["forward-pr"] = "pr"`, `DONE_STATUSES` contains
    `"forward-pr-done"`, `agentParticipatesInPhase` has a `"forward-pr"`
    case, `DEFAULT_TIMEOUTS["forward-pr"] = 3600`.
  - `evaluateTransition` branches `pr-comments` on `hasUpstream` / `forwarded`
    to route to `forward-pr` and waits on `hasUpstreamMergedMarker(state)`
    before reaching `final-merge`. Helpers `hasForwardedPr(state)` and
    `hasUpstreamMergedMarker(state)` service this branch.

- `src/orchestration/runner.ts`:
  - `pollAndMaybeDispatchPrComments` has a three-way split around `isPrMerged`
    (upstream+forwarded / upstream+!forwarded / else) that writes
    `<agent>.upstream-merged` and emits `upstream_pr_merged` in the upstream
    paths.
  - The main transition loop includes `"forward-pr"` in the
    `pushBeforePhases` set.

- `src/orchestration/skills.ts`:
  - `composeSkillMessage` computes `const hasUpstream = !!state.upstreamRepo
    && state.duoPeerSlot == null;` and passes it to `resolveTemplatePath`.
  - `resolveTemplatePath(phase, mode, role, hasUpstream)` biases selection
    toward `upstream-<phase>.md` (and `pair-<role>-upstream-<phase>.md`).
    The only in-tree concrete override is `upstream-final-merge.md`.
  - `buildSkillContext` sets template vars `UPSTREAM_REPO`, `UPSTREAM_PR_FILE`,
    `UPSTREAM_MERGED_MARKER_FILE`, `FORWARDED_MARKER_FILE`. Of these,
    `UPSTREAM_REPO` is still referenced by `pr-create.md` and
    `pair-coder-pr-create.md` (non-forwarding notice in PR body); the three
    FILE variables are only referenced by the two templates being deleted.

- `src/orchestration/state.ts`: `OrchestrationState.upstreamRepo?: string`.
  Set in `src/adapters/t3code.ts` and `src/adapters/tmux-adapter.ts` from
  `findProjectConfig(projectDir, config)?.upstream_repo`.

- `skills/orchestration/forward-pr.md`,
  `skills/orchestration/upstream-final-merge.md`: the two templates driving
  the deprecated phase.

- `skills/orchestration/pr-create.md` and
  `skills/orchestration/pair-coder-pr-create.md` both contain
  `{{#IF UPSTREAM_REPO}}` conditional boilerplate referring to upstream in
  the PR body. These are preserved as-is; they render fine when
  `UPSTREAM_REPO` is sourced from config rather than state.

### Briefing generator

`src/mag.ts`:
- `briefingPrecomputeContext()` (≈line 1570) assembles `mag/briefing-context.md`
  from sections including `## Slots State`, `## Preempted Slots`,
  `## Sessions Report`, `## Flow: Ready Queue`, etc.
- Called from `resolveQueueRequestCommand` on the `briefing` action and from
  `magContext()` (the `ludics mag context` CLI).
- Insertion point for the new section is between the `## Preempted Slots` and
  `## Sessions Report` blocks in the template literal.

### Keepalive

`src/mag.ts` `magStart` is the keepalive tick entry point. It already gates
controller-only jobs via `clusterShouldRunMag()` / `clusterIsController()`
and hosts idempotent maintenance calls (`ensureT3codeIfEnabled`,
`maybeAutoStartSlots`, `maybeResumeDeadOrchestrators`, etc.). The
once-per-day fast-forward job fits the same pattern: a small helper called
after the existing maintenance block, guarded by a file sentinel
(precedent: `mag/startup-watchdog.epoch`, `mag/last-stop-hook.epoch`).

### Observed lag (ocannl, verified against current checkout)

- Staging `origin/master` is 0 commits ahead of `upstream/master` and 59
  commits behind (this is the snapshot before cutover; once cutover happens
  and manual forward-PRs start landing on upstream, both counters will
  fluctuate).
- Upstream last merge: `0587b16b 2026-04-05 Merge pull request #446 …`.
- Staging last merge: `cdc14726 2026-04-17 Merge: Cross-statement CSE …`.
- `ocannl-staging` default branch is `master`, not `main` — the lag helper
  must detect this dynamically.

### Issue-import flow

`src/tasks/sync.ts` uses `project.upstream_repo || project.repo` for GitHub
issue operations. This is orthogonal and unchanged by this proposal.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The change is predominantly **deletion** in orchestration code, plus **one
new section** in the briefing context generator and **one new keepalive
job**. No algorithmic redesign is needed; the no-upstream path in
`phases.ts`/`runner.ts` already handles the common case correctly.

Suggested order of edits:

1. Delete `skills/orchestration/forward-pr.md` and
   `skills/orchestration/upstream-final-merge.md`.
2. Prune `forward-pr` from `phases.ts` (union, category, done-statuses,
   agent-participation, default-timeouts, `evaluateTransition` branches,
   unused helpers `hasForwardedPr` / `hasUpstreamMergedMarker`).
3. Prune the three-way split from `runner.ts`
   `pollAndMaybeDispatchPrComments`; drop `"forward-pr"` from
   `pushBeforePhases`; drop the `upstream_pr_merged` emission and the
   `.upstream-merged` marker.
4. In `skills.ts`: drop `UPSTREAM_PR_FILE`, `UPSTREAM_MERGED_MARKER_FILE`,
   `FORWARDED_MARKER_FILE` from `buildSkillContext`. Switch `UPSTREAM_REPO`
   to source from `_projectEntry?.upstream_repo` directly (no longer going
   through `state.upstreamRepo`). In `composeSkillMessage`, compute
   `hasUpstream` from the project config entry. Leave the
   `resolveTemplatePath` signature intact; mark its parameter `_hasUpstream`
   at the call site if no production code paths still light it up.
5. Remove `OrchestrationState.upstreamRepo` and the two adapter assignments.
6. Update tests per AC 9. Delete obsolete tests, rewrite transitions, add
   the new symmetry test.
7. Add the "Upstream vs Staging Lag" helper. Factor raw
   `git rev-list --left-right --count` parsing into a pure function. Invoke
   from `briefingPrecomputeContext()` and splice the rendered block into the
   context-file template literal between `## Preempted Slots` and
   `## Sessions Report`.
8. Update `skills/ludics-briefing.md` to name the new section.
9. Add the keepalive fast-forward helper. Guard with a
   `mag/last-fast-forward-<project>.epoch` sentinel (24h throttle) and
   controller-gated. Use fast-forward-only; emit an event if divergent and
   take no further action.
10. Update `docs/ARCHITECTURE.md` (diagram, file-tree listing) and
    `CHANGELOG.md`.

## Scope

### In scope

- **Delete**: `skills/orchestration/forward-pr.md`,
  `skills/orchestration/upstream-final-merge.md`.
- **Edit**: `src/orchestration/phases.ts`, `src/orchestration/runner.ts`,
  `src/orchestration/skills.ts`, `src/orchestration/state.ts`,
  `src/adapters/t3code.ts`, `src/adapters/tmux-adapter.ts`,
  `src/orchestration/phases.test.ts`, `src/orchestration/skills.test.ts`.
- **New surface**: upstream-vs-staging lag section in
  `briefingPrecomputeContext()` in `src/mag.ts`; autonomous once-per-day
  fast-forward job in the keepalive tick (`magStart` in `src/mag.ts`).
- **Doc / relay updates**: `skills/ludics-briefing.md`,
  `docs/ARCHITECTURE.md`, `CHANGELOG.md`.

### Out of scope

- **Any in-code migration for in-flight PRs.** The five open ocannl PRs
  (#450, #453, #454, #455, #456) are handled manually by the user — no
  feature flag, no marker-rewrite routine, no drain phase. Cutover is
  new-only.
- **Automation of upstream-PR creation or pushing to upstream.** Both remain
  manual user actions. The fast-forward job only pulls from `upstream` into
  the staging fork's default branch; it does not push.
- **Any change to the issue-import flow.** `github_repo: ahrefs/ocannl` and
  `src/tasks/sync.ts`'s use of `project.upstream_repo || project.repo` for
  GitHub issue operations are untouched.
- **Removing `upstream_repo` from `config.yaml`.** The field is still used
  for issue tracking and the lag section; it stays.

### Dependencies

None. `relates_to: []`; `task-da8b6dff` and `task-21b4c850` sequence after
this task but do not block it.
