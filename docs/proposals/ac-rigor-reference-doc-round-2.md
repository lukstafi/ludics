# AC verification rigor reference doc — round 2 (clauses 7–9)

## Goal

Append three reviewer-flagged AC-rigor durable learnings to `docs/ac-rigor-reference.md` (created by `task-66feb317` / PR #471, merged 2026-04-30). The doc currently ships 10 clauses across 5 thematic families; this round brings it to 13. Also update the AC-rigor pointer in `skills/worker-conventions.md` so workers grepping the in-place title list see the three new clauses.

The three new clauses come from the round-2 / round-3 retrospective of `gh-ludics-441` (manual-smoke evidence playbook, PR #452). Sibling tasks `task-e91abdff` (closed-set / cardinality clause — projected 14th) and `task-9cd6cdb9` Pattern 2 (stash-prod mutation-test clause — projected 15th) are queued behind this task to avoid moving-target framing during implementation.

## Acceptance Criteria

The verifier checks every AC below by literal-string `grep -F` or `grep -cE` against the post-commit tree (cite `git diff main...HEAD -- <paths>` or line-numbered direct reads, not bare `git diff`). Per-element decomposition follows the doc's own *Per-element assertions for enumerated-element ACs* clause; the cardinality probe in AC1 follows the *count probe paired with per-clause presence* shape established by `task-66feb317`'s round-1 reviewer feedback.

### AC1 — Clause cardinality is exactly 13, paired with per-clause presence

After the change, `grep -cE '^### ' docs/ac-rigor-reference.md` returns the integer `13`. In addition, for each of the three new H3 titles below (AC2), `grep -F "<exact title>" docs/ac-rigor-reference.md` returns at least one match.

- `### Literal paths in ACs are literal — don't substitute the platform abstraction`
- `### Diff-enumerated verification lines go stale — anchor to invariants, not snapshots`
- `### Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'`

**Falsifier (count):** `grep -cE '^### ' docs/ac-rigor-reference.md` returns any value other than `13`.

**Falsifier (per-element presence):** `grep -F` for any of the three literal H3 titles above against `docs/ac-rigor-reference.md` returns no match.

### AC2 — Heading-separator convention matches the dominant existing style (em-dash)

Each of the three new H3 titles uses the `—` em-dash separator between the short and long parts of the heading (e.g. `### Literal paths in ACs are literal — don't…`), matching the dominant style in the existing 10 clauses (4 of 10 use the em-dash shape and the new task body's three suggested titles converge on it). No new H3 added by this change uses a `:` colon separator between short and long parts.

**Falsifier:** `grep -nE '^### .*: ' docs/ac-rigor-reference.md` shows any of the three new clause lines with a colon separating short-and-long parts (existing clauses with colons inside the long-part body do not count — only the short—long boundary).

### AC3 — Thematic placement: each new clause lands in its declared family at its declared position

The three new clauses are inserted at thematically-correct positions, not appended end-of-file:

- **Clause 9 (probe before cleanup)** lives under `## Vacuous-harness family`, immediately after the existing `### Vacuous doc/config harness — same rule, doc artifacts`. Reading order in that family becomes: test-harness → doc/config-harness → runtime-cleanup harness.
- **Clause 8 (diff-enumerated verification lines)** lives under `## Verification-evidence family`, immediately after the existing `### AC verification evidence must survive the commit boundary`.
- **Clause 7 (literal paths in ACs)** lives under `## Falsifier-shape family`, at the end of that family (after `### Prose-only template instructions are unverifiable`).

**Falsifier (per-element):** Run `grep -nE '^(##|###) ' docs/ac-rigor-reference.md`. The line numbers of the three new H3 titles, relative to the surrounding `## ` family heading lines and existing `### ` siblings, must satisfy:

- Clause 9's line number is greater than `### Vacuous doc/config harness — same rule, doc artifacts` and less than `## Proposal-as-canonical family`.
- Clause 8's line number is greater than `### AC verification evidence must survive the commit boundary` and less than `## Baseline-aware framing family`.
- Clause 7's line number is greater than `### Prose-only template instructions are unverifiable` and less than `## Verification-evidence family`.

If any of the three relative-position checks fails, the AC is falsified.

### AC4 — Each new clause body is 3–5 sentences and contains its identifying literal

Each new H3 subsection's body (prose between that H3 and the next H3 or H2) is between 3 and 5 sentences inclusive (matching the doc's existing template) and contains a short distinctive literal phrase from the source clause:

- Clause 7 — body contains `mkdtempSync` AND contains `/var/folders` (the macOS-vs-Linux divergence is the clause's load-bearing example).
- Clause 8 — body contains `anchor` (or `anchor to`) AND contains `invariant` (the prescriptive clause).
- Clause 9 — body contains `before cleanup` (the rule's name) AND contains `--keep` (the recommended remediation).

**Falsifier (per-element):** `grep -F` for any of the seven literal phrases above against `docs/ac-rigor-reference.md` returns no match. (Sentence count is reviewer-checked, not auto-checked.)

### AC5 — Preamble count update: "ten clauses" replaced by "thirteen clauses", parenthetical pruned

The preamble's clause-count assertion is updated from "ten" to "thirteen" and the parenthetical that listed the now-shipped examples (`literal paths in ACs, diff-enumerated lines, probe-before-cleanup, and others`) is pruned: either trimmed to "and others" or replaced with the next-anticipated example (e.g. closed-set / cardinality from sibling `task-e91abdff`). Both directions are acceptable; reviewer reads the preamble for cohesion.

**Falsifier (count present):** `grep -F "thirteen clauses" docs/ac-rigor-reference.md` returns no match.

**Falsifier (count absent):** `grep -F "ten clauses" docs/ac-rigor-reference.md` still returns a match. (Mechanical "still passes" trap — the literal must change, not be left alongside the new one.)

**Falsifier (parenthetical pruned):** The substring `literal paths in ACs, diff-enumerated lines, probe-before-cleanup` (any subset of the three phrases joined by `, `) still appears in the preamble. The parenthetical may name future-anticipated clauses, but must not name the three this task lands.

### AC6 — `skills/worker-conventions.md` pointer lists the 13 H3 titles

The `## AC verification rigor` block in `skills/worker-conventions.md` is updated so that the `Sections (grep-able in-place):` list, taken across all bullets in that block, names every one of the 13 H3 titles (the existing 10 plus the three new ones from AC1). The bullets may be rebalanced thematically (any split that reads coherently is accepted; the existing 5+5 status quo is not preserved as a constraint).

**Falsifier (per-element presence):** `grep -F` for any of the 13 H3 titles (the 10 existing plus the 3 new from AC1, with em-dash separators preserved) against `skills/worker-conventions.md` returns no match.

**Falsifier (count probe):** Within the `## AC verification rigor` block (the lines from `## AC verification rigor` down to the next `## ` heading exclusive), the total number of titles enumerated does not equal 13. (Reviewer counts by reading; the per-element grep above is the strict gate.)

**Falsifier (location):** Any of the 13 titles is present in the file but outside the `## AC verification rigor` block.

### AC7 — Cross-links in worker skills are unchanged

The cross-link lines in `skills/ludics-draft-proposal-worker.md` and `skills/ludics-verify-completion-worker.md` (added by `task-66feb317`) are not modified by this task; the title list still lives only in `worker-conventions.md`.

**Falsifier:** `git diff main...HEAD -- skills/ludics-draft-proposal-worker.md skills/ludics-verify-completion-worker.md` shows any non-empty hunk.

### AC8 — No accidental scope leak

The change does not modify any file outside the two touched paths.

**Falsifier:** `git diff --name-only main...HEAD` returns any path other than `docs/ac-rigor-reference.md` and `skills/worker-conventions.md`.

## Context

The reference doc as merged on `origin/main` (verified at PR #471 merge commit `8f2028a`) contains 10 `### ` clauses across 5 `## ` family sections. Heading inventory (line numbers will drift; reference by named-section boundaries):

- `## Vacuous-harness family` — `### Vacuous test harness — assert on the artifact the AC names`; `### Vacuous doc/config harness — same rule, doc artifacts` (Clause 5 — explicit runtime-cleanup parent of incoming Clause 9).
- `## Proposal-as-canonical family` — `### Proposal beats task file when AC counts diverge`; `### Self-contradicting AC literal probe — revise the AC, not the verification narrative`.
- `## Falsifier-shape family` — `### Literal-grep AC — relocate the literal, don't keep it under a new rule`; `### Per-element assertions for enumerated-element ACs`; `### Byte-pinned assertions on rendered or normalised output`; `### Prose-only template instructions are unverifiable`.
- `## Verification-evidence family` — `### AC verification evidence must survive the commit boundary`.
- `## Baseline-aware framing family` — `### No-regression framing when the gate baseline is red`.

The doc preamble explicitly anticipates this task: *"Today it covers ten clauses across five thematic families; further reviewer-flagged learnings (literal paths in ACs, diff-enumerated lines, probe-before-cleanup, and others) are expected to land as additional `### ` subsections under the same families or new sibling families."* — so all three new clauses are pre-named and pre-slotted to existing families.

The clause source paragraphs (the long-form retrospective notes) live in the body of `tasks/task-d6656cf3.md` under `### Clause 7`, `### Clause 8`, `### Clause 9`. They must be condensed to 3–5 sentences each to match the existing clauses' template (heading naming the failure mode, then a single paragraph: state the rule, give a concrete trigger, end with a prescriptive clause).

The pointer block in `skills/worker-conventions.md` lives at the `## AC verification rigor` heading; the title list spans two bullets (5 + 5 = 10 titles) using `;` separators within each bullet. Q4 of the elaboration was answered "rebalance using best judgement" — the existing 5+5 status quo is not preserved; pick a thematic-cluster-per-bullet split that reads coherently across all 13 titles.

The four scope questions (insertion position, separator convention, preamble count update, pointer-bullet structure) were resolved in the elaboration on 2026-04-30; the resolutions are baked into the ACs above. The user's `feedback_reference_layer_not_inline` memory still applies: trust agents over upfront prescription — this proposal pins shape (placement, separator, count) but lets the coder choose paragraph wording within the 3–5 sentence template and the pointer-bullet split.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The work is doc-only with two touched files. A natural single-commit shape:

1. Open `docs/ac-rigor-reference.md`. Update the preamble: replace the literal `ten clauses` with `thirteen clauses`; prune the parenthetical examples (`literal paths in ACs, diff-enumerated lines, probe-before-cleanup`) — either trim to `and others` or replace with the next-anticipated example (e.g. closed-set / cardinality from sibling `task-e91abdff`).

2. Insert Clause 9 (`### Probe before cleanup — distinguish 'AC satisfied' from 'cleanup hid the violation'`) under `## Vacuous-harness family`, immediately after `### Vacuous doc/config harness — same rule, doc artifacts`. Distil the source paragraph from `tasks/task-d6656cf3.md` § *Clause 9* to 3–5 sentences. Body must contain `before cleanup` and `--keep`.

3. Insert Clause 8 (`### Diff-enumerated verification lines go stale — anchor to invariants, not snapshots`) under `## Verification-evidence family`, immediately after `### AC verification evidence must survive the commit boundary`. Body must contain `anchor` and `invariant`.

4. Insert Clause 7 (`### Literal paths in ACs are literal — don't substitute the platform abstraction`) under `## Falsifier-shape family`, at the end (after `### Prose-only template instructions are unverifiable`). Body must contain `mkdtempSync` and `/var/folders`.

5. Open `skills/worker-conventions.md`. In the `## AC verification rigor` block, replace the existing two `;`-separated bullets with a thematically-rebalanced bullet split that lists all 13 H3 titles (the existing 10 plus the three new ones from step 1 with em-dash separators). Suggested split: bullet 1 = Vacuous-harness + Probe-before-cleanup (3 titles); bullet 2 = Proposal-as-canonical + Falsifier-shape (6 titles); bullet 3 = Verification-evidence (incl. diff-enumerated) + Baseline-aware framing (4 titles) — but the coder picks whichever bullet split reads most coherently.

6. Verify before committing:
   - `grep -cE '^### ' docs/ac-rigor-reference.md` → `13`.
   - Per-element `grep -F` loop against the 13 titles in both files.
   - `grep -F "thirteen clauses" docs/ac-rigor-reference.md` → match; `grep -F "ten clauses" docs/ac-rigor-reference.md` → no match.
   - `grep -F "/var/folders\|mkdtempSync\|--keep\|before cleanup\|anchor\|invariant" docs/ac-rigor-reference.md` (decomposed per AC4) → all match.
   - `git diff --name-only main...HEAD` → exactly two paths.

Use `git diff main...HEAD -- docs/ac-rigor-reference.md skills/worker-conventions.md` (post-commit, symmetric) for verification evidence — not bare `git diff`. This proposal is itself an AC-rigor exercise: the ACs above use literal `grep -F` / `grep -cE` falsifiers, per-element decomposition, and post-commit-evidence framing — the patterns the doc captures.

## Scope

**In scope:**

- Append three new `### ` clause subsections to `docs/ac-rigor-reference.md` at the thematically-correct positions (Clause 7 end-of-Falsifier-shape, Clause 8 after the existing Verification-evidence clause, Clause 9 after the existing Vacuous doc/config-harness clause).
- Update the doc preamble's clause count from "ten" to "thirteen" and prune the now-shipped parenthetical examples.
- Update the AC-rigor pointer block in `skills/worker-conventions.md` so the `Sections (grep-able in-place):` list names all 13 H3 titles, with bullets rebalanced thematically (any coherent split).

**Out of scope:**

- Editing the cross-link lines in `skills/ludics-draft-proposal-worker.md` or `skills/ludics-verify-completion-worker.md` (already added by `task-66feb317`; this task does not touch them).
- Materializing the fabricated coder memories (`feedback_ac_verification_invariant_over_filelist.md`, `feedback_refresh_pr_body_after_followup.md`) — those belong to a separate `/ludics-learn` pass.
- Clauses for closed-set / cardinality (sibling `task-e91abdff`, projected 14th clause) and stash-prod mutation-test (sibling `task-9cd6cdb9` Pattern 2, projected 15th clause) — those ship in their own tasks once this lands.
- Restructuring family sections, renaming existing clauses, or reflowing the preamble's "five thematic families" wording (still accurate after this round).

**Dependencies:**

- `blocked_by: []` — `task-66feb317` (which created the doc) merged in PR #471 on 2026-04-30, so this task is unblocked.
- Blocks `task-e91abdff` and `task-9cd6cdb9` (both queued behind this to avoid moving-target framing on the cardinality probe).
- Relates to `gh-ludics-441` (the round-2/round-3 retrospective that surfaced these three clauses) and `task-66feb317` (the parent task that established the doc and the cardinality-probe AC pattern).
