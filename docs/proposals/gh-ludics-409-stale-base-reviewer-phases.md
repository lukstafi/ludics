# Stale-base warning extends to reviewer phases

## Goal

Extend the runner-side stale-base warning so it also fires on reviewer
phase entry — not only on coder phase entry. This closes the
forward-link from gh-ludics-374 (which shipped the per-commit-diff
template guidance for the planner side) and ensures reviewers also get
the dashboard/journal nudge when their worktree has drifted from
`origin/main`.

Source: <https://github.com/lukstafi/ludics/issues/409>.

Motivating incident (`task-91667552` retrospective, 2026-04-25): the
very task that built the stale-base warning surface tripped the same
phantom-deletion failure mode on the **reviewer** side. The reviewer's
worktree was stale, `git diff main..HEAD` showed phantom deletions for
files that had landed on main since fork, and the reviewer started
flagging them as scope violations. The runner warning never fired
because the phase guard only covers `plan` and `work` — reviewer
phases (`plan-review`, `review`) silently bypass it.

## Acceptance Criteria

1. **Runner phase guard widened.** The phase guard at runner
   phase-entry that calls `warnStaleBase()` covers
   `plan`, `work`, `plan-review`, and `review`. Phases
   `pr-comments`, `merge-vote`, `merge-debate`, and `update-docs`
   are deliberately *not* extended (deferred to a later issue if they
   become painful — see Scope).

2. **Dedup memo keyed on `(round, phase-category)`.** The dedup memo
   currently named `staleBaseLastWarnedRound` / `staleBaseLastWarnedCount`
   on `OrchestrationState` is generalized so the warning can fire once
   per round per phase-category. Phase-category is derived from the
   active phase: coder phases (`plan`, `work`) form one category;
   reviewer phases (`plan-review`, `review`) form the other. A warning
   that fired for the coder category in round N must not suppress a
   warning for the reviewer category in the same round.

3. **Existing dedup behaviours preserved.** Within a single category
   in a single round:
   - The "newly needing rebase" re-fire (count drops below previously-warned
     peak then rises back above threshold) still works — i.e., the
     mid-round rebase-then-drift workflow re-arms the warning as it
     does today.
   - The "count must strictly exceed last warned" gate still applies.
   - The round-change reset still applies (memo for both categories
     resets when `state.round` changes).

4. **Tests in `runner.plan-warnings.test.ts` cover the widening.** New
   test cases assert:
   - `warnStaleBase` fires on entry to `plan-review` when staleness
     meets threshold.
   - `warnStaleBase` fires on entry to `review` when staleness
     meets threshold.
   - The reviewer-category memo is independent of the coder-category
     memo within a single round (a coder warning at `plan` does not
     suppress a reviewer warning at `review` in the same round).
   - The reviewer-category memo still re-arms on count-decrease
     within the round.

5. **Salvage-on-rejection soft prompt.** The `## Salvage on rejection`
   block in `skills/orchestration/pair-coder-work.md` gains a
   pre-salvage verification suggestion: before invoking salvage on a
   reviewer's scope challenge, the coder is encouraged to run
   `git cat-file -e main:<path>` and `git cat-file -e HEAD:<path>` —
   if both succeed, the file is shared history and the rejection is
   likely a stale-base false positive, in which case push back instead
   of reverting. The wording matches the existing salvage-flow style
   (soft prompt, not a hard gate); no required step is added.

6. **Reviewer template post-hoc verification.** The per-commit-diff
   guidance paragraph in `skills/orchestration/pair-reviewer-review.md`
   gains a one-line post-hoc verification: if the reviewer has already
   typed `REQUEST_CHANGES` naming a deleted file, run
   `git cat-file -e main:<path>` first before sending — the file's
   continued presence on main reveals stale-base drift. Folded into
   the existing paragraph; no new section.

7. **`docs/orchestration-patterns.md` polish.** The existing
   "Scope declaration and salvage" entry's `**Procedure (diff
   commands).**` sub-bullet (around the forward-link to
   `task-91667552`) gains two small upgrades: (a) the runner-side
   warning is noted as now firing for reviewer phases as well as
   coder phases (closing the forward-link from gh-ludics-374), and
   (b) `git cat-file -e main:<path>` is named as the canonical
   per-file verification step for reviewer/coder use when an
   individual file claim is in dispute.

## Context

### Runner-side state

- `warnStaleBase()` lives in `src/orchestration/runner.ts`. It refreshes
  `origin/<main>`, computes commits since merge-base, dedups via a memo
  on `OrchestrationState`, and emits an `orchestration_warning` event
  with a "consider git rebase" message.
- The current phase guard is a two-disjunct check on `state.phase` —
  `plan` and `work`. The call site is the only invocation of
  `warnStaleBase` in the runner.
- `warnStaleBase` keys its worktree lookup off
  `state.agents.find(a => a.role === "coder")?.worktreePath`. Reviewer
  in a pair shares the coder's worktree (verified — peer-sync places
  both agents in the same checkout), so the existing lookup remains
  correct without modification when the guard widens to reviewer
  phases.
- The dedup memo fields `staleBaseLastWarnedRound` and
  `staleBaseLastWarnedCount` are declared on `OrchestrationState` in
  `src/orchestration/state.ts`. Adopting `(round, phase-category)`
  means either renaming/restructuring these two fields into a small
  per-category map, or splitting them into coder-category and
  reviewer-category pairs. Either shape works; the read-boundary
  backfill pattern (per `docs/orchestration-patterns.md` —
  read-boundary backfill on persisted state) means existing on-disk
  state files without the new fields will just initialize to "no
  prior warning" and behave correctly.

### Phase enum

- `Phase` is defined in `src/orchestration/phases.ts`. The reviewer
  phases relevant to this change are `plan-review` and `review`. The
  `PHASE_CATEGORIES` map in the same file uses orthogonal categories
  (`planning`, `main-loop`, …); the new phase-category split for the
  dedup memo is *internal to the warning subsystem* — it does not need
  to extend or reuse `PHASE_CATEGORIES`. A small local helper (e.g.
  `staleBaseCategoryOf(phase)`) returning `"coder" | "reviewer" | null`
  keeps the warning logic self-contained.

### Skill template surfaces

- `skills/orchestration/pair-coder-work.md` — the `## Salvage on
  rejection` block. The existing flow is "capture diff → create
  follow-up → revert worktree." The new soft prompt is a verification
  suggestion to run *before* deciding to invoke that flow.
- `skills/orchestration/pair-reviewer-review.md` — the per-commit-diff
  paragraph that already shipped via gh-ludics-374. The new post-hoc
  verification line folds in alongside, not as a separate section.
- `docs/orchestration-patterns.md` — the `**Procedure (diff
  commands).**` sub-bullet under "Scope declaration and salvage." The
  forward-link comment (`runner warning, when it lands`) is now
  outdated and should be updated.

### Edge cases (worth flagging)

- **Worktree absence.** `warnStaleBase` already silently skips when
  `worktreePath` is undefined or doesn't exist on disk — extending the
  phase guard introduces no new failure mode here.
- **Solo-work mode** (no reviewer agent). `pair-reviewer-review.md` is
  not dispatched in solo mode, so the runner warning's reviewer-phase
  expansion is inert in solo mode. This is fine — solo mode never
  enters `review` or `plan-review` in the first place.
- **Phases deliberately out of scope.** `pr-comments`, `merge-vote`,
  `merge-debate` are deferred per Q1; long review threads can become
  stale, but the failure mode is rarer there and the cost of a noisy
  warning higher. Out of scope.

### Sibling status (Q4 — bundling vs solo)

Worker checked sibling tasks at proposal time (2026-04-29):
gh-ludics-404 shipped (commit `a63afc8`); gh-ludics-405 was rewritten
as a code-audit retrofit (currently `deferred`); gh-ludics-408 was
abandoned; gh-ludics-410 shipped; gh-ludics-411 was rewritten as a
code-audit retrofit (currently `deferred`). No doc-only sibling
remains in flight, so this task ships as a solo PR.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The runner change is mechanical: widen the disjunction in the phase
guard from `(plan | work)` to `(plan | work | plan-review | review)`,
introduce a small `staleBaseCategoryOf(phase): "coder" | "reviewer" | null`
helper, and key the dedup memo on `(round, category)`. The cleanest
state-shape change is to replace the two scalar memo fields with a
small per-category record (e.g.
`staleBaseLastWarned?: { coder?: { round, count }, reviewer?: { round, count } }`),
or to keep two scalar pairs (`staleBaseLastWarnedCoderRound/Count`,
`staleBaseLastWarnedReviewerRound/Count`). Either is fine; the record
shape generalizes more cleanly if a third category is ever added, the
pair-of-pairs is closer to the existing data shape.

The skill-template tweaks are single-line additions to existing
paragraphs. The patterns-doc tweak is two small edits to one
sub-bullet.

Tests follow the existing pattern in `runner.plan-warnings.test.ts` —
the file already exercises `warnStaleBase` directly with hand-built
state objects.

## Scope

**In scope:**

- Runner phase guard at the `warnStaleBase` call site.
- `OrchestrationState` memo fields and the warning's internal dedup
  logic (per-category keying).
- Tests in `src/orchestration/runner.plan-warnings.test.ts`.
- Soft-prompt additions in `pair-coder-work.md` and
  `pair-reviewer-review.md`.
- Two-edit polish on `docs/orchestration-patterns.md`.

**Out of scope:**

- Extending the warning to `pr-comments`, `merge-vote`,
  `merge-debate`, `update-docs`, or any merge-stage phase. Defer to a
  follow-up if those become painful.
- Rewriting the salvage protocol (gh-ludics-305) — only adding a
  precondition prompt.
- Re-implementing or restructuring `warnStaleBase` itself.
- Changing the cumulative-vs-per-commit template guidance shipped by
  gh-ludics-374.

**Dependencies.** None blocking — gh-ludics-374 is shipped. No PR
bundling: ships solo (sibling-status check above).
