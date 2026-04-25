# Proposal: Test harness must instantiate AC negative-path conditions

**Task:** gh-ludics-404
**Issue:** https://github.com/lukstafi/ludics/issues/404
**Related:** #375 (precursor — invariant-vs-capability phrasing)

## Goal

Extend the existing AC self-check guidance so that, in addition to phrasing each verification line as an *invariant* (the #375 outcome), the coder must also name the **harness condition** that instantiates each AC outcome — the concrete setup state that makes the AC's hypothetical case (the "X" in "skips on X", the case-N branch in an N-outcome AC) actually occur during the test. A test that never produces the condition the AC talks about cannot enforce the AC, even when the verification line is invariant-phrased. The reviewer gains a parallel cheap check ("what harness condition would I have to remove for this test to fail?"), and an integration-flavoured "manual probe before assertion" practice gets institutionalised as its own pattern in `docs/orchestration-patterns.md`.

## Acceptance Criteria

1. `docs/orchestration-patterns.md` `### AC self-check` section gains a new subsection (e.g. `**Harness instantiation.**`) that:
   - States the rule: every AC outcome (positive and negative) needs a test whose harness setup actually produces the condition the AC's wording targets.
   - Covers both the literal "skips on X" / "no-ops when Y" shape and the N-outcome enumeration shape ("returns A in case 1, B in case 2, …").
   - Shows a *before/after* worked example drawn from the issue's data points (the task-91667552 stale-base / `git fetch` failure case is the cleanest — capability-only setup vs. real broken-URL fetch).
   - Names the falsifier framing for this rule: "what harness condition would I remove for this test to fail?" — and notes its dual relationship to the existing invariant-falsifier question.
   - Cross-references `### Negative-case regression testing` (the dynamic, "deliberately break and re-run" version of the same idea) and `### Collapsed-branch negative tests`.
2. `docs/orchestration-patterns.md` gains a new sibling pattern `### Pre-assertion harness probe` (or equivalent heading) that institutionalises the task-b435e58d practice: when an AC's passing condition is a property of "the world" (template set, real config, live filesystem) rather than a unit-level invariant, run a one-liner probe (`bun -e`, `bun --print`, ad-hoc grep) against the live target *before* drafting the assertion, with a debug print of every failure surfaced. Includes a worked example sketch from the lint-template-safety case and a scoping note ("don't apply to trivial unit assertions").
3. `skills/orchestration/pair-coder-work.md` `**Acceptance Criteria self-check**` paragraph (currently the long "For each criterion, append a one-line confirmation…" line that already names the invariant-vs-capability rule from #375) is extended by *one sentence* (or a short parenthetical clause) requiring that each verification line additionally name the harness condition it depends on, and links to the new doc subsection. The skill template gains no new `{{...}}` variables and no new bullet block — the addition stays in the existing paragraph register.
4. `skills/orchestration/pair-reviewer-review.md` `**Acceptance criteria verification**` paragraph gains a parallel one-sentence addition: the reviewer asks "what harness condition would I have to remove for this test to fail?" for each AC entry, treating "none" or "the assertion itself" as a blocking flag (vacuous on that AC). The addition is keyed to verifying what the coder named, not re-deriving from scratch.
5. `skills/orchestration/solo-work.md` brief AC walk paragraph gains a single corresponding clause — solo mode has no reviewer second-check, so the harness-condition discipline is at least mentioned (one sentence). No template-block expansion.
6. The new doc subsections render correctly in the in-tree markdown (anchor links resolve; existing cross-references to `#ac-self-check` still work; new anchors are reachable from the cross-references in 3, 4, 5).
7. No regressions in skill-template lint / doc-link checks (`bun run` test surface that touches `skills/` and `docs/orchestration-patterns.md`); existing pair-coder / pair-reviewer / solo-work test snapshots still pass or are updated minimally to absorb the prose addition.

## Context

From issue #404:

> When an AC says "silently skips on X" or "no-ops when Y", the test setup must make X/Y *actually happen* and assert the skip/no-op. Multiple recent tasks shipped tests that "passed" only because the setup never instantiated the negative-path condition the code was supposed to handle. Reviewers catch this; coders should catch it earlier.

Three concrete data points from the digest:

- **task-91667552 (stale-base warning):** AC said the warning skips on `git fetch` failure. The `makeGitRepo` harness seeded `refs/remotes/origin/main` via `update-ref` but never configured a fetchable origin URL, so `git fetch origin main` failed with exit 128 in *every* test. The code under review ignored `fetched.exitCode` entirely; positive-path tests "passed" by measuring against cached refs after an ignored fetch failure. The harness condition for the positive path (a *successful* fetch) was never instantiated; the harness condition for the negative path (a *failed* fetch *that the code skips on*) was instantiated for the wrong reason.
- **task-b435e58d (lint-template-safety):** Before drafting the meta-test assertion, the coder ran a one-off `bun --print` probe against the live template set to enumerate unknown first-tokens. That cheaply surfaced the `PR_URL=$(cat ...)` / `BASE=$(gh pr view ...)` env-stripper gaps *before* the assertion was written. Generalisable as a standalone pattern.
- **task-e3295f1e (defaultAssignMachine):** AC enumerated four outcomes (federated+self-match, federated+leader, federated+null, non-federated+null). Round 1 wrote the no-self/no-leader branch but skipped its test, reasoning that adjacent tests "bracketed" the path. Reviewer flagged as blocking — neighbours traversed *other* branches and didn't enforce the invariant on this one. Generalises the rule from "negative path" to "every enumerated outcome."

**Why this matters.** #375 fixed the *phrasing* of the verification line (invariant, not capability). #404 narrows further: even an invariant-phrased verification line is vacuous if the harness never produces the condition the invariant talks about. The two together close the loop — the verification line says what would fail, *and* the test setup actually exercises the case where that property could fail.

**Sibling-task coordination.** The 04/25 workflow-feedback wave includes several tasks (gh-ludics-405, 406, 411) that also extend `docs/orchestration-patterns.md`. The user has not yet decided whether to bundle these PRs; this proposal assumes **separate PRs** and writes the new sections as additive subsections that won't textually conflict with siblings as long as each task adds in a distinct anchor region. Anchor name (`#harness-instantiation` or similar) and `#pre-assertion-harness-probe` should be chosen to be unambiguous if a sibling task happens to add adjacent text.

## Approach

This is a docs-and-skill-template change spanning 4 files. Order of edits:

1. **`docs/orchestration-patterns.md`** (the substantive content):
   - Inside `### AC self-check`, after the existing `**Composite evidence.**` paragraph and before `**Boundary.**`, add a new paragraph headed `**Harness instantiation.**` Structure: principle sentence → "what 'instantiates' means" (the harness setup must produce the condition the AC's wording targets) → coverage of both AC shapes (negative-path "skips on X" and N-outcome enumeration) → before/after example drawn from task-91667552 (capability-only setup of `update-ref`-seeded refs vs. invariant-enforcing setup with a real bare `file://` origin and an actual broken-URL regression) → falsifier framing ("what harness condition would I remove for this test to fail?") → cross-reference to `### Negative-case regression testing` (dynamic dual) and `### Collapsed-branch negative tests`. Match the prose register of existing paragraphs in this section (terse `**Bold lead.**` paragraph style, one worked example, no nested bullets unless mirroring an existing pattern).
   - Add new section `### Pre-assertion harness probe` placed near `### Negative-case regression testing` (since they're a related family). Structure: principle (probe "the world" before asserting against it) → why (cheap surfacing of unknowns before test bytes commit) → recipe (3–4 numbered steps: identify the world the assertion targets, write a one-liner that enumerates current-state with a debug print of every would-fail item, decide what 'pass' means based on the enumeration, then write the assertion) → worked example from task-b435e58d (`bun --print` against the template set, surfacing `PR_URL=$(cat ...)` and `BASE=$(gh pr view ...)` gaps) → "when not to apply" (trivial unit assertions, ACs whose passing condition isn't a property of external state).
   - Both new subsections close with `See also` lines linking to neighbouring patterns.

2. **`skills/orchestration/pair-coder-work.md`** — extend the existing AC self-check paragraph (line 51) with one sentence at the end, before the existing `See [AC self-check](...)` link: something like *"For each verification line, also name the harness condition that instantiates the AC's case — the setup state that makes the assertion actually exercise the AC (not just traverse the surrounding code path); a test that passes whether or not that condition holds does not enforce the AC. See [harness instantiation](../../docs/orchestration-patterns.md#harness-instantiation)."* Then optionally append `Consider running a [pre-assertion harness probe](../../docs/orchestration-patterns.md#pre-assertion-harness-probe) when the AC's passing condition is a property of "the world" rather than a unit invariant.` as a short final clause. No new `{{...}}` variable; no new bullet block.

3. **`skills/orchestration/pair-reviewer-review.md`** — extend the existing AC verification paragraph (line 13) with one sentence at the end: *"For each AC entry, also ask 'what harness condition would I have to remove for this test to fail?' — if the answer is 'none' or 'the assertion itself,' the test is vacuous on that AC line; flag as blocking. See [harness instantiation](../../docs/orchestration-patterns.md#harness-instantiation)."*

4. **`skills/orchestration/solo-work.md`** — extend the brief AC walk paragraph (line 20) with one clause noting that each AC's verification mention should also name the harness condition that makes the test exercise that AC. Solo mode has no reviewer second-check, so the discipline is mentioned even though the artifact requirements are lighter.

5. **Verification.** Run whatever existing test surface validates skill templates and doc anchors (`bun test` over the orchestration-patterns / skills surface). Confirm the new anchors resolve. Spot-check that the `### AC self-check` renders cleanly (the new paragraph fits the pattern's structure).

**Estimated diff size.** ~50–80 lines of new prose in `docs/orchestration-patterns.md` (two new subsections), 1–3 sentences each in the three skill files. No new code, no new tests beyond running existing template/doc-link checks.

**Anchor naming.** Suggested: `#harness-instantiation` (under `#ac-self-check`) and `#pre-assertion-harness-probe` (top-level). Both should be checked against existing anchors in the file and against pending sibling-task anchors if they land first.

**Reviewer cue.** The most important reviewer check is that the new `**Harness instantiation.**` paragraph distinguishes itself cleanly from the *existing* `**Invariant vs capability.**` paragraph immediately above it — they're closely related but not the same thing (one is about *line phrasing*, the other is about *test setup state*). The before/after example must concretely show that even an invariant-phrased verification line can be vacuous when the harness condition isn't instantiated.

## Out of Scope

- Editing the closed task #375 or its existing wording (cited as precursor only).
- Adding new template variables or `{{#IF}}` conditional blocks to skill files.
- Retrofitting closed tasks' verification lines to name harness conditions (the new shape applies to future tasks only — see issue's Edge Cases note).
- Coordinating with sibling tasks 405 / 406 / 411 on PR bundling — assume separate PRs; if user later decides to bundle, the additive subsection approach makes that easy.
