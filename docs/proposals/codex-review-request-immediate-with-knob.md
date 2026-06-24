# Proposal: Fire the explicit Codex review request immediately at pr-comments entry (point-in-time check + configurable delay, default 0)

Task: gh-ludics-604
Source issue: https://github.com/lukstafi/ludics/issues/604

## Goal

Cut the ~10-minute dead latency that currently precedes the explicit `@codex review`
request. Today, on the initial transition into `pr-comments`, the orchestrator *arms a
~10-minute deferral* (`Math.min(600, prCommentsTimeout/2)` seconds) and only posts the
explicit request when that timer expires and no Codex review has arrived. Replace that
arm-and-wait with a **single point-in-time check at the pr-comments transition**: if a
Codex review is already present, skip the explicit request (Codex auto-reviewed — don't
double-spend); if none is present right then, post `@codex review` **immediately**. The
delay before that request becomes a **new config knob defaulting to 0** (immediate),
decoupled from `prCommentsTimeout` so the human-comment window and the reviewer-nag delay
are no longer the same number. A non-zero grace (e.g. 60–120 s) can be dialed in later
without a code change if redundant remote reviews are observed.

## Acceptance Criteria

- At the initial `pr-comments` transition, when no Codex review is yet present, the
  explicit `@codex review` request is posted without the prior ~10-minute wait (with the
  default config, immediately).
- When a Codex review is already present at that transition, no explicit request is posted
  (no double-spend of the remote review).
- The request delay is governed by a **new orchestration config field defaulting to 0**,
  decoupled from `prCommentsTimeout`: changing the human-comment window no longer changes
  the reviewer-nag delay, and changing the reviewer-nag delay no longer changes the
  human-comment window.
- Setting the new delay to a positive value honors a grace period before the explicit
  request is posted (the request is not sent until at least that many seconds after the
  pr-comments transition).
- Merge-loop re-entry (`merge-review → pr-comments`) does not re-arm or duplicate the
  request; the existing "initial pr-comments entry only" guard is preserved.
- Multi-PR / duo flows still partition per PR: an explicit request is posted only for PRs
  that lack a Codex review at the check point, never for PRs that already have one.
- Tests cover: no-review-at-entry → request posted (immediately at default); review-present
  -at-entry → no request; delay knob > 0 → grace honored before the request; merge-loop
  re-entry → no duplicate request; multi-PR partitioning preserved.

## Context

> Diagnosed live this session from PR #603 (gh-ludics-600). The explicit `@codex review`
> request fired ~16 min after the PR was created (~28 min after the commits first
> appeared). The 10-min deferral itself ran correctly; it's anchored late and bracketed by
> pipeline. Authoritative timeline (orchestration events): PR created 10:59:10 →
> `pr-comments` entered 11:04:09 (clock starts) → `@codex review` requested 11:15:17 →
> Codex review 11:20:00 → advance 11:21:35. So PR→request ≈ 16 min = ~5 min (PR→pr-comments
> entry) + ~11 min (10-min deferral + poll slop).
>
> — https://github.com/lukstafi/ludics/issues/604

### Current behavior (grounded in code)

- **Arm site — `maybePostCodexReviewRequests` (`src/orchestration/runner.ts:2466-2484`).**
  On the transition *into* `pr-comments` from `pr-create` / `update-docs` / `review` — and
  only those initial paths, not merge-loop re-entry — it sets
  `state.prCodexReviewDeferredSince = nowEpoch()` (`runner.ts:2483`). This arms a deferral
  anchored to pr-comments phase entry. The function is gated on there being a Codex
  reviewer agent (`a.role === "reviewer" && a.provider === "codex"`) and at least one PR
  URL.
- **Fire site — `checkAndRedispatchPrComments` (`src/orchestration/runner.ts:1738-1774`).**
  While `state.prCodexReviewDeferredSince` is set, it computes
  `deferralTimeout = Math.min(600, Math.floor(state.config.prCommentsTimeout / 2))`
  (`runner.ts:1740`, = 600 s with the default `prCommentsTimeout = 1800`), partitions the
  PRs into those still missing a Codex review (`urlsMissingReview`, via
  `hasCodexSubmittedReview` / `hasCodexPostedComment`), and once the deadline is reached
  posts `postCodexReviewComment(prUrl, customPrompt)` for each PR still missing a review,
  setting `prCodexReviewFallbackPosted`. The per-PR `urlsMissingReview` partitioning is
  what makes the logic correct for duo / multi-PR flows.
- **Cleanup.** `applyPhaseSideEffects` (`runner.ts:2445-2448`) clears
  `prCodexReviewDeferredSince` / `prCodexReviewFallbackPosted` when leaving `pr-comments`,
  so merge-loop re-entries don't see a stale expired timer and post spurious comments.
- **Config.** `prCommentsTimeout` is a field on `OrchestrationConfig`
  (`src/orchestration/state.ts:151`), defaulted via
  `defaultOrchestrationConfig` (`state.ts:380`, `DEFAULT_PR_COMMENTS_TIMEOUT = 1800`,
  `state.ts:355`). It alone governs both the human-comment quiet window
  (`phases.ts:510`, `phases.ts:716`) and — via the `min(600, /2)` derivation — the
  reviewer-nag delay; that coupling is the issue's fix 3.
- **Helpers.** `hasCodexSubmittedReview` (`github.ts:95`), `hasCodexPostedComment`
  (`github.ts:110`), and `postCodexReviewComment` (`github.ts:203`) are the dedup-check and
  request-post primitives. Both checks fail closed (return `false` on API error) so the
  fallback still fires on a transient GitHub failure.

Net: anchor (pr-comments entry, ~5 min post-creation) + ~10-min deferral ⇒ ~15-16 min from
PR-up to the explicit request, of which the ~10 min is avoidable dead latency.

### Resolved-design rationale

The chosen approach is the **gentle/minimal** one (resolved 2026-06-24 with the user): keep
the anchor at the pr-comments transition, drop the ~10-min wait, gate the immediate request
on a single point-in-time "is a Codex review already present?" check, and expose the delay
as a new knob defaulting to 0. This is **not** the issue's fix 1 or fix 2 — there is *no*
re-anchoring to PR-creation and *no* PR-creation timestamp (in-process or GitHub
`createdAt`).

**Why the anchor stays at pr-comments entry rather than moving to PR-up:** the
`pr-comments` transition is reached only *after* the local review phase has approved, so the
cheap/abundant local approval is always banked before the precious remote (Codex) review is
spent. Re-anchoring earlier (to PR creation) would forgo that sequencing for little extra
gain. "Start gentle" = minimal scope, anchor unchanged, and let the new knob absorb any
future tuning need.

(Scope note: the "local approval banked before remote spend" guarantee only holds when the
local review phase runs; for review-skipping configs only the latency cut applies — still
desirable, and it doesn't change the design.)

### Accepted residual + open implementation check

The dropped ~10-min wait existed to absorb one case: Codex's auto-review landing shortly
*after* the pr-comments-entry check, which would make the explicit request redundant (a
double-spend). With an immediate point-in-time check this race is no longer absorbed. This
residual is **accepted** because (a) empirically the auto-review usually lands *before*
pr-comments entry (~5 min post-PR-open; PR #603: PR 10:59 → pr-comments 11:04), and (b) the
new delay knob lets a small grace be dialed in without a code change if double-spends are
observed in practice.

**Open implementation check to confirm during the work:** whether an explicit
`@codex review` issued while Codex's own auto-review is already *in flight* simply no-ops
(Codex self-dedups). If it does, the accepted residual is largely moot. This should be
noted in the implementation (and, if cheaply confirmable, verified) but does not gate the
change.

## Approach

A localized change to `src/orchestration/runner.ts` plus one new field on
`OrchestrationConfig`. Sketch, not a line-by-line plan:

1. **New config field.** Add a field to `OrchestrationConfig`
   (`state.ts:138-163`), e.g. `codexReviewRequestDelay: number` (seconds), with a new
   `DEFAULT_CODEX_REVIEW_REQUEST_DELAY = 0` constant and an `overrides.… ?? DEFAULT…`
   line in `defaultOrchestrationConfig` (`state.ts:364-398`). This decouples the
   reviewer-nag delay from `prCommentsTimeout`. Surface it in the config-reference template
   if the other `pr-comments` knobs are documented there.

2. **Fire-site delay sourced from the new knob.** In `checkAndRedispatchPrComments`
   (`runner.ts:1738-1774`), replace
   `deferralTimeout = Math.min(600, Math.floor(state.config.prCommentsTimeout / 2))`
   (`runner.ts:1740`) with the new field
   (`deferralTimeout = state.config.codexReviewRequestDelay`). With the default of 0,
   `deadlineReached` is true on the first tick after the transition, so the request — for
   PRs still in `urlsMissingReview` — is posted immediately. The existing per-PR
   `urlsMissingReview` partitioning and the `prCodexReviewFallbackPosted` one-shot guard are
   **preserved** as-is: they provide the point-in-time review check (skip PRs that already
   have a Codex review) and the no-duplicate guarantee for free.

3. **Arm site unchanged in shape.** `maybePostCodexReviewRequests` (`runner.ts:2466-2484`)
   still sets `state.prCodexReviewDeferredSince = nowEpoch()` on initial pr-comments entry
   only, gated on a Codex reviewer + a present PR URL. The "initial entry only" guard
   (`initialPrCommentsPaths` excludes `merge-review`) and the leave-pr-comments cleanup in
   `applyPhaseSideEffects` (`runner.ts:2445-2448`) are kept, so merge-loop re-entry neither
   re-arms nor duplicates the request. (Note: at default delay 0, `prCodexReviewDeferredSince`
   functions as a "request pending / not yet resolved" marker rather than a long timer — the
   request fires on the next tick — so the field and its update docstring should be
   re-described accordingly.)

4. **Tests.** Extend `runner.pr-comments.test.ts` (and/or `phases.test.ts`) to cover:
   - no Codex review present at entry → explicit request posted immediately at default delay;
   - Codex review already present at entry → no explicit request (no double-spend);
   - `codexReviewRequestDelay > 0` → request not posted until the grace has elapsed;
   - merge-loop re-entry (`merge-review → pr-comments`) → no re-arm / no duplicate request;
   - multi-PR partitioning preserved (request only for PRs lacking a review).

   The existing tests in `runner.pr-comments.test.ts` that assert the `600 s`
   `deferralTimeout` (e.g. the `nowSec - 700` past-deadline cases) must be updated to the
   new knob-driven timing.

Guards to preserve explicitly: (a) the Codex-reviewer + has-PR gating at the arm site;
(b) the "initial pr-comments entry only" path filter; (c) the leave-pr-comments cleanup;
(d) the per-PR `urlsMissingReview` partitioning and the `prCodexReviewFallbackPosted`
one-shot. The only behavioral change is the *timing source* of `deferralTimeout` (now a
decoupled knob defaulting to 0) — everything that made the dedup correct stays in place.
