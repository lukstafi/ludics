# AC-verification lines must name the invariant the test enforces, not the capability it exercises

## Goal

Sharpen the phrasing rubric for coder AC-verification entries in per-round `workflow-feedback-<peer>.md` files so each line names the **invariant the cited test enforces**, not the **capability the test exercises**. Builds on gh-ludics-316 (which established the `## AC Verification` artifact as the mandatory place for criterion-by-criterion confirmation); this task sharpens *what the walk must say*.

Issue: https://github.com/lukstafi/ludics/issues/375

Three recent incidents in 48 hours (all 2026-04-24) show the failure mode is systematic, not one-off:

1. **task-9a5d2344** round-1: "serialization coverage" claimed, but the cited test only checked `EEXIST` from inside the lock holder — proved directory existence, not the retry-and-acquire handoff. The sharp phrasing was the timestamp invariant `childAttemptTs < parentInsideCriticalSectionTs <= childAcquireTs`.
2. **task-3b906d0f**: "CLI covers both paths" claimed by a test that called `runLint()` in-process — missing `process.exit`, stderr writes, and arg parsing boundaries only exercised by a spawned subprocess.
3. **task-72a318c3**: an early draft asserted "`force:true` passed to adapter.stop", which is unobservable — `force` is a remote-dispatch flag, not an adapter flag. The correct observable was the journal entry / remote-slot side effect.

Review is catching these post-hoc, so the quality gate is working; the cost is paid in extra rounds. A short inline rule plus a richer reference block is a proportionate response.

## Acceptance Criteria

1. `skills/orchestration/pair-coder-work.md` — the existing "Acceptance Criteria self-check" paragraph (around line 37 + the AC-Verification confirmation sentence around line 51) gains exactly **one** invariant-vs-capability sentence. No new heading, no new section — the sentence lands inside the existing paragraph flow.
2. `skills/orchestration/pair-reviewer-review.md` — the existing "Acceptance criteria verification" paragraph (around line 13) gains exactly **one** matching reviewer-flag sentence. Same constraint: inline in the existing paragraph, no new heading.
3. `docs/orchestration-patterns.md` — the `### AC self-check` section (anchor `#ac-self-check`, around line 250) is extended with:
   - An **invariant-vs-capability** sub-rule, stated as a principle plus a worked before/after example drawn from task-9a5d2344 (the `childAttemptTs < parentInsideCriticalSectionTs <= childAcquireTs` timestamp invariant — the sharpest of the three incidents).
   - A **side-effect-observability** sub-rule: when the AC refers to a flag/option, the verification line cites an observable downstream consequence (journal entry, remote-slot side effect, stderr output), not the flag's presence in a call signature. Reference task-72a318c3's `force:true` lesson.
   - A **composite-evidence** note: ACs satisfied by multiple assertion sources still phrase each element as the invariant that element enforces, not the capability it demonstrates.
4. `skills/orchestration/solo-work.md` — **unchanged**. Solo mode currently has no `## AC Verification` artifact (only an in-thinking walk-through); extending solo is explicitly out of scope per user-resolved Question 1.
5. No changes to any `.ts` source. This is a rubric-only change.
6. The inline sentences in the coder and reviewer templates stay short enough to avoid template bloat; the `#ac-self-check` reference block carries the expository weight. The existing link from `pair-coder-work.md` to `#ac-self-check` should remain valid (anchor unchanged).

**Regression gate.** No mechanical test exists for markdown-wording changes. Reviewer judgement is the primary gate: review should confirm that (a) inline sentences are each a single sentence and land in the right paragraph, (b) the pattern-doc additions carry a concrete worked example, and (c) solo-work.md is untouched.

## Context

### Coder template (primary target)

`skills/orchestration/pair-coder-work.md` around line 37 contains the "Acceptance Criteria self-check" paragraph. It is followed by a proposal/task-spec re-read step (lines 39–49) and then the confirmation-write sentence at line 51:

> For each criterion, append a one-line confirmation to `{{WORKFLOW_FEEDBACK_FILE}}` under a `## AC Verification` heading (create the heading if absent), naming the evidence that satisfies it (file, test, commit). Only write the done status after every criterion has a confirmation line. See [AC self-check](../../docs/orchestration-patterns.md#ac-self-check).

The invariant-vs-capability sentence belongs in the same paragraph flow — either immediately after the "naming the evidence that satisfies it" sentence at line 51, or tucked into the line-37 paragraph. The link to `#ac-self-check` already exists, so the expansion in `orchestration-patterns.md` is reached via the same anchor.

Suggested wording (from the elaboration, lightly tighten if the coder finds a cleaner form):

> Each verification line must name the invariant the cited test enforces — not the capability the test's helper exposes. Cite the exact assertion that would fail if the AC were violated; do not cite a test that merely exercises the code path the AC would run through.

### Reviewer template (primary target)

`skills/orchestration/pair-reviewer-review.md` line 13 contains the "Acceptance criteria verification" paragraph:

> **Acceptance criteria verification.** Walk through each acceptance criterion and verify the implementation satisfies it. Treat any unmet criterion as a blocking action item listed explicitly in the review. Cross-check against the coder's `## AC Verification` entries in `{{PEER_SYNC_DIR}}/workflow-feedback-{{PEER_NAME}}.md`; a missing or hand-wavy entry is itself a blocker.

The reviewer-flag sentence lands at the end of this paragraph, sharpening what "hand-wavy" covers. Suggested wording:

> Flag AC lines whose cited test exercises the capability but does not enforce the stated invariant (e.g. a CLI-path AC cited by an in-process call, or a serialization-handoff AC cited by a mere existence check) as blocking.

### Reference doc (primary target)

`docs/orchestration-patterns.md` around line 250 contains `### AC self-check`. Current content (lines 250–258) is the principle, the "why" (AC drift), a generic example walk, and the boundary note. The three new sub-rules extend this section without replacing existing wording; the worked before/after example goes inline in the invariant-vs-capability sub-rule.

### Solo template (explicit non-target)

`skills/orchestration/solo-work.md` (around line 20) asks for an in-thinking AC walk-through but does not mandate an `## AC Verification` artifact file. Per user-resolved Question 1, this task does not extend solo. The solo asymmetry stays as-is; file separately if it ever becomes a priority.

### Layering with gh-ludics-316

gh-ludics-316 (closed) established the artifact (`## AC Verification` heading in `workflow-feedback-<peer>.md`), the mandate to populate it, and the reviewer cross-check that flags missing/hand-wavy entries. This task does not touch that layering — it only refines the phrasing rubric for the individual line. The existing link from the coder template to `#ac-self-check` is the natural delivery path for the richer rule block.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Three files, three mechanical edits. No `.ts` changes, no test changes.

1. **`skills/orchestration/pair-coder-work.md`** — Add one sentence in the "Acceptance Criteria self-check" paragraph flow. Cleanest spot is immediately after the existing sentence ending "naming the evidence that satisfies it (file, test, commit)" on line 51, before the "Only write the done status…" clause. Keep the sentence to one line.

2. **`skills/orchestration/pair-reviewer-review.md`** — Add one sentence at the end of the "Acceptance criteria verification" paragraph on line 13. The sentence sharpens what counts as "hand-wavy" — it does not replace the existing hand-wavy-entry-is-a-blocker clause.

3. **`docs/orchestration-patterns.md`** — Extend `### AC self-check` (after line 258's Boundary note or before it, whichever reads cleaner) with three new paragraphs or a short sub-list:
   - **Invariant vs capability** — one-paragraph principle + before/after example using task-9a5d2344's timestamp invariant. The before line is the capability phrasing ("serialization coverage confirmed by `EEXIST` check"); the after line is the invariant phrasing (`childAttemptTs < parentInsideCriticalSectionTs <= childAcquireTs`, asserted by test X).
   - **Side-effect observability** — one-paragraph principle: for flag/option ACs, cite the observable downstream consequence, not the flag's presence in the call signature. Reference task-72a318c3's `force:true` example (the flag is unobservable at the adapter boundary; the journal entry or remote-slot effect is).
   - **Composite evidence** — a short note that ACs satisfied by multiple tests still phrase each element as an invariant.

   Follow the existing section-style conventions in `orchestration-patterns.md` (bolded principle label, short explanatory paragraph, worked example where useful).

No build/test steps beyond the usual `bun run build` sanity check and markdown-link sanity (the `#ac-self-check` anchor must remain resolvable from both pair templates).

## Scope

**In scope:**
- `skills/orchestration/pair-coder-work.md` (one sentence in one paragraph).
- `skills/orchestration/pair-reviewer-review.md` (one sentence in one paragraph).
- `docs/orchestration-patterns.md` (three sub-rules added to the existing `### AC self-check` section, worked example for one of them).

**Out of scope:**
- `skills/orchestration/solo-work.md` — explicitly unchanged per user-resolved Question 1.
- Any `.ts` source, CLI, test, or dashboard code — this is a rubric-only change.
- The gh-ludics-316 artifact layering (`## AC Verification` heading, population mandate, reviewer cross-check) — already in place; this task only refines phrasing.
- Any mechanical enforcement of the new rubric (no lint, no test assertion on wording). Review is the gate.

**Dependencies:**
- Builds on gh-ludics-316 (closed — artifact layer already landed).
- Independent of gh-ludics-374 (sibling plan-merge scope-diff anchoring issue filed in the same feedback-digest run; no file overlap, can land in parallel).
