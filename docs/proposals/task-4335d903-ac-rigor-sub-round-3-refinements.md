# Proposal: AC-rigor sub-round — self-contradicting-AC enforceability, set-equality for closed-set ACs, sibling-mutation for cardinality probes

Task: `task-4335d903`

## Goal

Land three AC-rigor refinements in `docs/ac-rigor-reference.md` per the resolved-question decisions, with `skills/worker-conventions.md` per-family list updates and preamble (clause-count + parenthetical) cleanup.

## Context

Sub-round bundling three durable learnings from the retrospective on `task-d5c37bc5` (PR #475, salvage stale-base merge-base form, 2 review rounds):

- **Refinement 1** — self-contradicting-AC revisions must be programmatically enforceable (sub-paragraph extension).
- **Refinement 2** — set-equality is the strongest "exactly N" probe shape, subsuming count + enumeration (new sibling clause under Falsifier-shape).
- **Refinement 3** — sibling-mutation (add to world) is the peer of stash-prod (subtract from world) for cardinality probes (new sibling clause under Vacuous-harness, with cross-link to `orchestration-patterns.md#mutation-evidence`).

All six task-elaboration questions resolved 2026-05-09 — this proposal pins those decisions. `task-9cd6cdb9` merged (Stash-prod clause now lives under Vacuous-harness — Refinement 3's neighbour). `task-e91abdff` abandoned (no in-flight cardinality clause to refine; Refinement 2 lands as fresh `### `). Doc-only proposal — orchestration plan phase skipped.

## Acceptance Criteria

1. **Refinement 1 sub-paragraph extension.** The clause body of `### Self-contradicting AC literal probe — revise the AC, not the verification narrative` (under `## Proposal-as-canonical family` in `docs/ac-rigor-reference.md`) gains a "What to revise into" sub-paragraph (or equivalent follow-on prose in the same `### ` body) that prescribes a programmatically-enforceable revision: a `:(exclude)<spec-file>` clause on the falsifier's `git grep` invocation **and** an enforcing test that spawns the exact `git grep` invocation with the exclusion. Falsifier: `grep -F ':(exclude)' docs/ac-rigor-reference.md` returns ≥ 1 hit; `grep -F 'programmatically enforceable' docs/ac-rigor-reference.md` returns ≥ 1 hit; `grep -F 'enforcing test that spawns' docs/ac-rigor-reference.md` returns ≥ 1 hit. **No new `### ` heading is added under `## Proposal-as-canonical family`** — the family clause count stays at 2 (negative control: `awk '/^## Proposal-as-canonical family/,/^## /' docs/ac-rigor-reference.md | grep -c '^### '` returns `2`).

2. **Refinement 2 new clause heading and adjacency.** A new `### ` clause titled exactly `### Closed-set / cardinality ACs — set-equality is the strongest probe shape` lands under `## Falsifier-shape family`, immediately adjacent to (within 6 body lines, no intervening `### ` heading) `### Per-element assertions for enumerated-element ACs`. Falsifier: `grep -Fn 'Closed-set / cardinality ACs — set-equality is the strongest probe shape' docs/ac-rigor-reference.md` returns exactly one hit; `awk '/^### Per-element assertions for enumerated-element ACs/,/^### /' docs/ac-rigor-reference.md | grep -F 'Closed-set / cardinality ACs'` returns at least one hit (i.e., the new clause sits in the body interval that begins at Per-element).

3. **Refinement 2 clause body articulates count-vs-substitution and prescribes set-equality.** The new clause body (a) names the *substitution* failure mode that pure-count probes miss (rename target → renamed file, sibling gains literal, cardinality unchanged); (b) names the *addition* failure mode that pure-per-element-presence probes miss; (c) prescribes the set-equality probe shape with a code-block sketch using `expect(`, `toEqual`, and `new Set([` literals adjacent on contiguous source lines. Falsifier: within the clause body interval (between the new `### Closed-set...` heading and the next `### `), `grep -F 'expect('` ∧ `grep -F 'toEqual'` ∧ `grep -F 'new Set(['` all return ≥ 1 hit; `grep -F 'substitution'` returns ≥ 1 hit.

4. **Refinement 3 new sibling clause heading and adjacency.** A new `### ` clause titled exactly `### Sibling-mutation for cardinality probes` lands under `## Vacuous-harness family`, immediately after `### Stash-prod mutation test — confirm your new test actually falsifies` and before `### Vacuous doc/config harness — same rule, doc artifacts`. Falsifier: `grep -nE '^### ' docs/ac-rigor-reference.md` lists, in this exact order, `### Stash-prod mutation test — confirm your new test actually falsifies`, then `### Sibling-mutation for cardinality probes`, then `### Vacuous doc/config harness — same rule, doc artifacts`.

5. **Refinement 3 clause body cross-links to orchestration-patterns and names sibling-append as a fourth shape.** The new clause body (a) cross-links to `orchestration-patterns.md#mutation-evidence` using the literal anchor; (b) explicitly names sibling-append as a *fourth* canonical mutation shape alongside the existing three (one-liner / typed-code / guard-removal); (c) frames the two AC-rigor mutation shapes (stash-prod = subtract from world / sibling-append = add to world) as complementary peers for complementary AC limbs (per-site / cardinality). Falsifier: within the clause body interval, `grep -F 'orchestration-patterns.md#mutation-evidence'` returns ≥ 1 hit; `grep -F 'fourth'` returns ≥ 1 hit; `grep -F 'sibling-append'` returns ≥ 1 hit; `grep -E 'one-liner|typed-code|guard-removal'` returns ≥ 1 hit.

6. **Preamble updated — clause count bumped, parenthetical pruned.** The preamble paragraph at line 5 of `docs/ac-rigor-reference.md` is updated: (a) the clause-count word reflects the new total `^### ` heading count after this task lands (this task adds **+2** clauses; if `gh-ludics-495` lands first the baseline is its post-merge count, otherwise baseline is the current 17 → new count is 19); the implementer reads `grep -c '^### ' docs/ac-rigor-reference.md` against the working tree *before* writing the new clauses, computes `baseline + 2`, and writes the corresponding English number; (b) the parenthetical `(closed-set / cardinality probes, and others)` is replaced (e.g., with `(and others)` or removed in full). Falsifier: `grep -F 'closed-set / cardinality probes' docs/ac-rigor-reference.md` returns **0** hits (negative control); `grep -cE '^### ' docs/ac-rigor-reference.md` returns the same number as the English clause-count word in the preamble (positive control — verify by grep'ing the English number in line 5).

7. **`skills/worker-conventions.md` per-family bullets updated.** The two new heading titles are appended to the matching family bullets under `## AC verification rigor`: `Sibling-mutation for cardinality probes` joins the **Vacuous-harness family** bullet (after `Stash-prod mutation test — confirm your new test actually falsifies`); `Closed-set / cardinality ACs — set-equality is the strongest probe shape` joins the **Falsifier-shape family** bullet. Falsifier: `grep -F 'Sibling-mutation for cardinality probes' skills/worker-conventions.md` returns ≥ 1 hit; `grep -F 'Closed-set / cardinality ACs — set-equality is the strongest probe shape' skills/worker-conventions.md` returns ≥ 1 hit; both literal occurrences sit in the bulleted list block under `## AC verification rigor`. **Refinement 1 adds no heading** so worker-conventions's Process-around-the-AC bullet is unchanged (negative control: `git diff -- skills/worker-conventions.md` shows changes only on the Vacuous-harness and Falsifier-shape bullet lines).

8. **Coordination with `gh-ludics-495`.** The implementer of either task checks the other's status before landing. If `gh-ludics-495` has already merged, this task re-runs `grep -c '^### ' docs/ac-rigor-reference.md` against the post-merge working tree and bumps the preamble's clause-count word from *that* baseline + 2; the parenthetical prune in AC6 is unchanged. If this task lands first, `gh-ludics-495`'s implementer follows the same re-grep-and-bump protocol. The proposal text (this file) explicitly states this protocol. Falsifier on the proposal text: `grep -F 'gh-ludics-495' docs/proposals/task-4335d903-ac-rigor-sub-round-3-refinements.md` returns ≥ 1 hit; `grep -F 're-grep' docs/proposals/task-4335d903-ac-rigor-sub-round-3-refinements.md` returns ≥ 1 hit (or equivalent literal naming the re-count step).

## Approach

- **Pinned heading texts** (use these literals verbatim — they are AC-load-bearing):
  - Refinement 2: `### Closed-set / cardinality ACs — set-equality is the strongest probe shape`
  - Refinement 3: `### Sibling-mutation for cardinality probes`
- **Pinned cross-link anchor**: `orchestration-patterns.md#mutation-evidence` (relative path from `docs/`).
- **Pinned clause-count delta**: this task adds **+2** `^### ` clauses (Refinement 1 is sub-paragraph, no delta). Compute the new preamble English number as `current(grep -c '^### ' docs/ac-rigor-reference.md) + 2` against the working tree at landing time.
- **Pinned parenthetical edit**: remove `closed-set / cardinality probes` from the preamble's "expected to land" parenthetical. The minimal-token form is `(and others)`; full removal of the parenthetical is also acceptable if the surrounding sentence still reads cleanly.
- **Pinned worker-conventions touches**: append the two new heading titles to the matching family bullets under `## AC verification rigor` in `skills/worker-conventions.md`. No reordering of existing entries; no new bullet lines.
- **Coordination protocol** (re-grep-and-bump): the second task to land re-runs `grep -c '^### ' docs/ac-rigor-reference.md` and updates the preamble's English clause-count word from the post-merge baseline.

## Out of scope

- Structural pinning tests for `docs/ac-rigor-reference.md` in `src/orchestration/skills.test.ts` (Q5 rejected — verification stays per-PR `grep -F` snippet probes).
- Any AC-rigor clause additions outside Refinements 1–3.
- Refactoring or reordering existing `### ` clauses or `## ` families.
- `gh-ludics-495`'s clause additions (separate task; coordinate via AC8's re-grep-and-bump protocol — do not land its clauses here).
- Editing `docs/orchestration-patterns.md § Mutation evidence` (cross-link is one-way: this task references it, doesn't modify it). The three-canonical-mutation-shape enumeration there stays at three; sibling-append is named as a fourth shape **in the new ac-rigor clause body**, not added to the orchestration-patterns enumeration.
- Bash snippet conventions in `docs/swe-textbook.md`.
