# AC verification rigor reference doc

## Goal

Capture ten reviewer-flagged AC-rigor durable learnings (six from the 2026-04-30 retrospective wave on `task-138eb60b`, `task-d024e32c`, `task-2c5bd512`, `task-4f13a49b`, plus four from the same-day triage of 89 abandoned tasks: `gh-ludics-432`, `gh-ludics-334`, `task-ff2dc368`/`gh-ludics-442`, `task-b2190ba9`#1) as a single project-agnostic reference at `docs/ac-rigor-reference.md`. Workers grep the doc when ACs are unusually contract-heavy; the rest of the time it sits beside `docs/task-frontmatter-reference.md` and `docs/testing-patterns.md` as a sibling reference.

The reshape into a separate reference doc (rather than inlining into `skills/worker-conventions.md`) is the user-confirmed choice from the elaboration's three-option Q1, anchored in the `feedback_reference_layer_not_inline` memory: trust agents over upfront prescription. The pointer in `worker-conventions.md` is therefore intentionally terse, and the cross-links in `ludics-draft-proposal-worker.md` and `ludics-verify-completion-worker.md` are one-liners.

Sibling task `task-d6656cf3` ships clauses 7–9 (literal paths in ACs / diff-enumerated lines / probe before cleanup) into the same doc later; section anchors in this proposal are chosen to remain stable as that growth lands.

Related: `gh-ludics-441` (manual-smoke real-evidence playbook, adjacent family) and `task-4101f0d5` (CLI exit-code falsifiers, sibling concern at the implementation level).

## Acceptance Criteria

The verifier checks every AC below by literal-string `grep -F` or `head`-style file-presence tests. Each AC names its falsifier explicitly. There is no code to run.

### AC1 — `docs/ac-rigor-reference.md` exists with the documented shape

The file `docs/ac-rigor-reference.md` exists in `~/ludics/`. It opens with an H1 title (`# AC verification rigor`), one short scope paragraph, a "this doc grows over time" note in the spirit of `docs/task-frontmatter-reference.md`'s opener, and a thematic table of contents listing the five family headings below.

**Falsifier:** `test -f docs/ac-rigor-reference.md` returns non-zero, OR `head -1 docs/ac-rigor-reference.md` does not yield an H1 starting with `# AC verification rigor`.

### AC2 — Preamble defines AC, harness condition, falsifier in project-agnostic terms

The doc's preamble (the prose between the H1 and the first `## ` family heading) defines all three terms — *AC*, *harness condition*, *falsifier* — in language that does not name ludics-specific files, projects, or commands. The vocabulary is reused verbatim from `orchestration-patterns.md` § *AC self-check* and § *Harness instantiation*; the preamble cross-links to both with the relative paths `orchestration-patterns.md#ac-self-check` and `orchestration-patterns.md#harness-instantiation`.

**Falsifier (per-element):** Any of the following `grep -F` invocations against `docs/ac-rigor-reference.md` returns no match: the literal token `AC`, the phrase `harness condition`, the word `falsifier`, the relative anchor `orchestration-patterns.md#ac-self-check`, the relative anchor `orchestration-patterns.md#harness-instantiation`.

### AC3 — Five thematic family headings present, in declared order

The doc contains exactly these five `## ` (H2) family headings, in this order, after the preamble and before any appendix:

1. `## Vacuous-harness family`
2. `## Proposal-as-canonical family`
3. `## Falsifier-shape family`
4. `## Verification-evidence family`
5. `## Baseline-aware framing family`

**Falsifier (per-element):** `grep -nF` for any of the five literal headings against `docs/ac-rigor-reference.md` returns no match, OR the line numbers returned are not in strictly increasing order matching the declared sequence.

### AC4 — All ten clauses present, each under a stable named subsection

Within those five families, the doc contains a `### ` (H3) named subsection for every clause from the elaboration body. The subsection titles are anchor-stable identifiers chosen to survive future appends (clauses 7–9 from `task-d6656cf3`). The ten required H3 titles are:

- Under *Vacuous-harness family*: `### Vacuous test harness — assert on the artifact the AC names` (clause 2); `### Vacuous doc/config harness — same rule, doc artifacts` (clause 5).
- Under *Proposal-as-canonical family*: `### Proposal beats task file when AC counts diverge` (clause 3); `### Self-contradicting AC literal probe — revise the AC, not the verification narrative` (clause 6).
- Under *Falsifier-shape family*: `### Literal-grep AC — relocate the literal, don't keep it under a new rule` (clause 1); `### Per-element assertions for enumerated-element ACs` (clause 4); `### Byte-pinned assertions on rendered or normalised output` (clause 12); `### Prose-only template instructions are unverifiable` (clause 13).
- Under *Verification-evidence family*: `### AC verification evidence must survive the commit boundary` (clause 10).
- Under *Baseline-aware framing family*: `### No-regression framing when the gate baseline is red` (clause 11).

**Falsifier (per-element):** `grep -F` for any of the ten literal H3 titles against `docs/ac-rigor-reference.md` returns no match. Removing any single clause's H3 title falsifies this AC by the same per-element check, on exactly that title.

### AC5 — Every clause body is 3–5 sentences and contains its identifying literal

Each H3 subsection's body (the prose between that H3 and the next H3 or H2) is between 3 and 5 sentences inclusive and contains a short distinctive literal phrase from the source clause in the elaboration. The required literal phrases are: clause 1 — `the literal lives in a different file`; clause 2 — `reads the artifact the AC names`; clause 3 — `count the AC bullets in the proposal`; clause 4 — `one toContain per element`; clause 5 — `vacuous` AND `doc`; clause 6 — `revise the AC text in the proposal`; clause 10 — `git diff main...HEAD`; clause 11 — `no regression from the base`; clause 12 — `byte-identity`; clause 13 — `actual shell commands`.

**Falsifier (per-element):** `grep -F` for any of the ten literal phrases above against `docs/ac-rigor-reference.md` returns no match. (Sentence-count is not auto-checked; reviewer reads each body for the 3–5 range as a calibration check.)

### AC6 — Reciprocal cross-link from the new doc back to `orchestration-patterns.md`

The new doc contains at least one explicit `→ See also` style pointer near the preamble that names `orchestration-patterns.md` § *AC self-check* and § *Harness instantiation* with relative-path anchors as in AC2.

**Falsifier:** `grep -F "orchestration-patterns.md"` against `docs/ac-rigor-reference.md` yields zero matches.

### AC7 — Terse pointer in `skills/worker-conventions.md`, immediately before Manual-Smoke

`skills/worker-conventions.md` contains a new paragraph (≤ 8 lines) that points readers at `docs/ac-rigor-reference.md`. The paragraph lists the ten clause H3 titles (the same titles enumerated in AC4) so a worker can grep in-place. The paragraph appears **immediately before** the existing `## Manual-Smoke Evidence` heading: there is no other `## ` heading between the new pointer paragraph and `## Manual-Smoke Evidence`.

**Falsifier (placement):** Run `grep -nE '^## ' skills/worker-conventions.md`. The pointer's `## ` heading line number must be strictly less than the `## Manual-Smoke Evidence` line number, and no other `## ` line numbers must fall between them.

**Falsifier (presence):** `grep -F "docs/ac-rigor-reference.md" skills/worker-conventions.md` returns zero matches, OR `grep -F` for any of the ten H3 titles from AC4 against `skills/worker-conventions.md` returns zero matches.

**Falsifier (terseness):** The new pointer paragraph (counted from its own `## ` heading down to the first blank line preceding `## Manual-Smoke Evidence`) exceeds 8 non-blank lines.

### AC8 — Terse one-liner cross-links from the two worker skills

`skills/ludics-draft-proposal-worker.md` and `skills/ludics-verify-completion-worker.md` each contain exactly one new line that references `docs/ac-rigor-reference.md` via relative path (`../docs/ac-rigor-reference.md`). The line is a one-liner — it does **not** include the ten clause titles; the title list lives only in `worker-conventions.md` (per Q3 default in the elaboration).

**Falsifier (presence):** `grep -F "ac-rigor-reference.md" skills/ludics-draft-proposal-worker.md` returns zero matches, OR the same `grep -F` against `skills/ludics-verify-completion-worker.md` returns zero matches.

**Falsifier (terseness):** Either of the two skill files contains more than one line matching `grep -F "ac-rigor-reference.md"`, OR any line matching that grep in the two skill files also literally contains any of the ten H3 titles from AC4 (i.e. the title list leaked from `worker-conventions.md`).

### AC9 — No accidental scope leak

The change does not modify the body of `## Manual-Smoke Evidence` in `worker-conventions.md`, does not modify `### AC self-check` or `### Harness instantiation` in `orchestration-patterns.md`, and does not introduce any new files outside the four touched paths.

**Falsifier:** `git diff main...HEAD -- skills/worker-conventions.md` shows hunks inside the Manual-Smoke section (any line at or after `## Manual-Smoke Evidence` other than additions strictly *before* it). OR `git diff main...HEAD -- docs/orchestration-patterns.md` shows non-empty hunks. OR `git diff --name-only main...HEAD` returns any file other than these four: `docs/ac-rigor-reference.md`, `skills/worker-conventions.md`, `skills/ludics-draft-proposal-worker.md`, `skills/ludics-verify-completion-worker.md`.

## Context

The elaboration body of `task-66feb317` carries all ten clauses verbatim with full quoted source paragraphs, plus a thematic grouping suggestion that this proposal adopts. Three structural decisions — separate reference doc; pointer placement *before* Manual-Smoke; one-liner cross-links from the two skill files — are the user-confirmed defaults from Q1 / Q2 / Q3 of the elaboration.

Code pointers (verified 2026-04-30):

- `~/ludics/skills/worker-conventions.md:44` — `## Manual-Smoke Evidence` heading; the new pointer paragraph sits immediately above this line.
- `~/ludics/docs/orchestration-patterns.md:328` — `### AC self-check`; `~/ludics/docs/orchestration-patterns.md:350` — `### Harness instantiation`. Both are the cross-link targets for the new doc's preamble (AC2, AC6).
- `~/ludics/docs/task-frontmatter-reference.md` — sibling reference doc whose opener (H1 + scope paragraph + "this doc grows over time" note) is the shape to imitate (AC1).
- `~/ludics/skills/ludics-draft-proposal-worker.md` — the proposal template's `## Acceptance Criteria` subsection is the natural slot for the one-line cross-link (AC8).
- `~/ludics/skills/ludics-verify-completion-worker.md` — step 3 ("Inspect codebase for completion evidence") or step 4 ("Make a completion judgment") is the natural slot for the one-line cross-link (AC8).

The ten clause source paragraphs in `tasks/task-66feb317.md` are the canonical text the new doc paraphrases into 3–5-sentence bodies; AC5 pins each body to a literal phrase drawn from those sources so the verifier can confirm fidelity without re-reading the originals.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The work is doc-only and the structure is fixed by the ACs. A natural single-commit shape:

1. Write `docs/ac-rigor-reference.md` from the ten clause sources, using the H1 + preamble + five `## ` family headings + ten `### ` clause subsections layout enumerated in AC3 and AC4. Reuse `orchestration-patterns.md` § *AC self-check* and § *Harness instantiation* terminology verbatim in the preamble (AC2). Add the reciprocal `→ See also` pointer to those two sections (AC6). Each clause body should distil its source paragraph to 3–5 sentences while retaining the literal phrase that AC5 pins (the literal phrases in AC5 are drawn straight from the source clauses, so this is paraphrasing rather than rewriting).
2. Insert the terse pointer paragraph in `skills/worker-conventions.md` *immediately before* the existing `## Manual-Smoke Evidence` heading (AC7). The paragraph's own H2 (or shorter heading) plus body must stay ≤ 8 non-blank lines and must list the ten H3 titles from AC4 verbatim.
3. Add the one-line cross-link to `skills/ludics-draft-proposal-worker.md` (near the proposal template's `## Acceptance Criteria` subsection) and `skills/ludics-verify-completion-worker.md` (at the top of step 3 or step 4) — one line each, no title list (AC8).

Anchor-stable H3 titles (AC4) matter for `task-d6656cf3` follow-on growth: clauses 7–9 will land under an existing or new family heading and must not require rewriting any of these ten titles' anchors.

The proposal is meta — it is itself an AC-rigor exercise. The ACs above use literal `grep -F` falsifiers, per-element decomposition (AC3, AC4, AC5), no-regression framing for the diff scope (AC9), and `git diff main...HEAD` post-commit-evidence framing (AC9) — exactly the patterns the new reference doc captures.

## Scope

**In scope:**

- Create `docs/ac-rigor-reference.md` with all ten clauses under five thematic families and a project-agnostic preamble.
- Add a terse pointer paragraph in `skills/worker-conventions.md` immediately before the Manual-Smoke section.
- Add a one-line cross-link in `skills/ludics-draft-proposal-worker.md` and `skills/ludics-verify-completion-worker.md`.

**Out of scope:**

- Extracting the existing `## Manual-Smoke Evidence` section (~80 lines inline in `worker-conventions.md`) to its own reference doc.
- Editing `### AC self-check` or `### Harness instantiation` in `orchestration-patterns.md`.
- Clauses 7–9 from the original AC-rigor scope (literal paths in ACs / diff-enumerated lines / probe before cleanup) — those ship in sibling `task-d6656cf3` (`blocked_by: task-66feb317`).

**Dependencies:**

- Blocks `task-d6656cf3` (clauses 7–9, which append into the same `docs/ac-rigor-reference.md` once this lands).
- Relates to `task-138eb60b`, `task-d024e32c`, `task-2c5bd512`, `task-4f13a49b`, `gh-ludics-441` (the retrospectives that surfaced clauses 1–6 and 10–13).
