# Capture Idempotency: name the same-retro-distinct-headline failure mode

## Goal

Add a single ASSUMPTION GAP paragraph to `docs/swe-textbook.md`'s `## Capture Idempotency` section so the documented soft-spot in the bash guard's disjunctive (`headline OR retro`) semantics is visible to digest-worker / process-suggestions callers without softening the bash snippet or touching skill templates.

Source: https://github.com/lukstafi/ludics/issues/506

## Acceptance Criteria

1. **One new paragraph in `docs/swe-textbook.md`**, inserted between the closing fence of the bash snippet (the line ` ``` ` that follows `echo "append"`) and the `---` divider that separates the Capture Idempotency contract from the first `### "Issue is updated"` entry. No other section of the file is modified.
2. **The new paragraph names the structural property, not an incident.** The paragraph contains, in this order, all four phrases (case-sensitive substring matches):
   - `ASSUMPTION GAP`
   - `Precipitating retro:` (the labelled-field name; signals "shared retro" structurally)
   - `Filter decision:` (signals "materially distinct lessons" via the labelled-field name)
   - `plan-merge` (so the orchestrated escalation path is named)
   The paragraph does NOT contain `gh-ludics-497`, `gh-ludics-496`, `task-a670cdbf`, `Entries A/B`, `Entries C/D`, or any other incident-detail string. (Negative-control assertion.)
3. **The paragraph also covers the un-orchestrated caller.** The paragraph contains either the literal phrase `result JSON` or `commit message` (or both), as the surrogate-surfacing guidance for one-shot Mag invocations of `/ludics-feedback-digest` that have no merged plan to attach an `⚠️ ASSUMPTION GAP:` line to.
4. **The bash snippet is byte-identical to HEAD.** A `git diff HEAD -- docs/swe-textbook.md` shows zero changes inside the fenced code block: `grep -Fq "### ${ENTRY_HEADLINE}"`, `grep -Fq "${PRECIPITATING_RETRO}"`, `echo "skip-duplicate"`, `echo "append"`, and the surrounding `if`/`then`/`fi` lines are all unmodified.
5. **The shape test passes unchanged.** `bun test docs/swe-textbook.shape.test.ts` is green with **no edits to `docs/swe-textbook.shape.test.ts`**. In particular, the AC5-positive slice between `^## Capture Idempotency` and `^### "Issue is updated"` still matches `grep -Fq "### ${ENTRY_HEADLINE}"`, `grep -Fq "${PRECIPITATING_RETRO}"`, `echo "skip-duplicate"`, `echo "append"`, `headline OR\s+precipitating-retro`, and the existing `ENTRY_HEADLINE … without … leading … ###` / `guard prepends`-`### `` lints.
6. **No skill, reviewer prompt, or template files are touched.** `git diff --name-only HEAD` lists exactly one path: `docs/swe-textbook.md`. In particular, `skills/orchestration/pair-reviewer-plan-review.md`, `skills/orchestration/pair-coder-plan-merge.md`, `skills/ludics-feedback-digest.md`, `skills/ludics-feedback-digest-worker.md`, and `skills/ludics-process-suggestions.md` are untouched.
7. **AC7 negative-control still passes.** The new paragraph stays inside `docs/swe-textbook.md`; no skill body gains a `swe-textbook` substring, so the existing AC7 allowlist test is unaffected.

## Context

User resolved both elaboration questions on 2026-05-09:

- **Q1 → option 2**: keep the bash snippet as the single source of truth (`headline OR retro` semantics) and pay the divergence cost in prose by naming the failure mode explicitly. Don't soften bash to require both predicates (would need fuzzy headline matching in pure bash; `grep -F` can't deliver that cleanly).
- **Q2 → (a) docs-only**: the textbook paragraph is sufficient; the reviewer prompt's existing generic "If plan-merge found gaps, are they documented with ASSUMPTION GAP markers?" line covers the catch. Don't bloat the always-loaded reviewer prompt with a Capture-Idempotency-specific note.

Why the gap matters: at HEAD, the prose Outputs bullet for `skip-duplicate` already reads disjunctive ("a near-duplicate exists by either headline OR precipitating-retro"), so the bash≠prose gap the issue title names is narrower than it sounds — the bash and prose agree. What's missing is acknowledgement of what the OR-semantics *cost*: when a new entry shares its precipitating retro with an existing-but-unrelated entry (different headline, different Filter decision, different lesson), the bash returns `skip-duplicate` and the caller silently drops the new lesson via `Second occurrence:` amendment instead of surfacing the choice. That silent-drop is the gh-ludics-497 incident's failure mode.

The fix is editorial: name the soft-spot, point to `⚠️ ASSUMPTION GAP:` as the orchestrated escalation path and to result-JSON / commit-message surrogate-surfacing for un-orchestrated callers.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. Open `docs/swe-textbook.md`, locate the bash snippet (lines ~62-70 on HEAD) ending with `` ``` `` followed by a blank line and the `---` divider on line 72.
2. Insert one paragraph between the closing `` ``` `` of the bash block and the `---` divider, separated by blank lines on both sides. Suggested wording (final wording is the agent's call as long as the AC2/AC3 substring contracts hold):

   > **Known soft-spot — `ASSUMPTION GAP` escalation.** The disjunctive guard above (`headline OR retro`) returns `skip-duplicate` whenever a new entry shares either key with any existing entry. The case it silently collapses: a new entry whose `Precipitating retro:` matches an existing entry's, but whose headline and `Filter decision:` describe a materially distinct lesson. Under the bare contract the caller would amend the matched entry's `Second occurrence:` and drop the new lesson. When the caller runs inside an orchestrated coder/reviewer pair, the right move is to surface the choice in the merged plan with an `⚠️ ASSUMPTION GAP: …` marker (per `pair-coder-plan-merge.md`) so the reviewer sees and rules on the divergence at plan-merge time. When the caller is a one-shot Mag invocation of `/ludics-feedback-digest` (no merged plan), the equivalent discipline is to surface the choice in the digest's result JSON and commit message rather than silently routing through `skip-duplicate`.

3. Verify locally:
   - `git diff HEAD -- docs/swe-textbook.md` shows additions only between the fenced bash block and the `---` divider.
   - `git diff --name-only HEAD` lists exactly `docs/swe-textbook.md`.
   - `bun test docs/swe-textbook.shape.test.ts` is green.
4. Commit with a message naming the issue: `docs(swe-textbook): name same-retro-distinct-headline ASSUMPTION GAP (#506)`.

## Scope

In scope:

- One new paragraph in `docs/swe-textbook.md`'s `## Capture Idempotency` section, between the bash snippet and the `---` divider.

Out of scope:

- **Bash-semantics change.** Option 1 from the issue body (require both `headline AND retro` for `skip-duplicate`) is rejected per Q1 — single-source-of-truth stays at the bash snippet, and `grep -F` can't deliver fuzzy headline matching cleanly anyway.
- **Reviewer-prompt note.** A targeted line in `skills/orchestration/pair-reviewer-plan-review.md` is rejected per Q2 — the existing generic ASSUMPTION-GAP check is sufficient and the always-loaded reviewer prompt stays lean.
- **Skill-template touches.** `skills/ludics-feedback-digest.md`, `skills/ludics-feedback-digest-worker.md`, and `skills/ludics-process-suggestions.md` already reference the textbook by anchor; no edits there.
- **Shape-test edits.** The shape test pins the bash snippet byte-for-byte; the new paragraph lives outside the AC5-positive slice and outside the AC2 "Entry Shape" slice, so the test is unaffected and must not be touched.
- **Re-litigating the gh-ludics-497 incident.** The paragraph names the structural property; incident details belong in retrospectives, not the textbook prose.

Dependencies: none.
