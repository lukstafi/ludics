# Introduce `docs/swe-textbook.md` as Mag-side write memory for filter-rejected retro learnings

## Goal

Today's competent-SWE filter (codified in
`harness/claude-memory/feedback_competent_swe_filter.md` and applied during
`/ludics-process-suggestions` and `/ludics-feedback-digest`) correctly keeps
*always-loaded* prompts lean by abandoning hygiene-flavoured retro and
feedback items. The downside: those items vanish without a record, so Mag
re-litigates the same filter call every time the pattern recurs (recently:
`gh-ludics-496` OrchestrationConfig adapter-call-site lint and
`gh-ludics-497` lint:test-isolation pinned-warning ergonomics, both flagged
as competent-SWE-filter candidates after being filed by feedback-digest).

This proposal introduces a **write-side memory file** —
`docs/swe-textbook.md` — that journals filter decisions, plus a third
disposition (`capture-textbook`) in the two skills that produce filter
verdicts. The textbook is consulted only by Mag and the feedback-digest
worker; coder and reviewer agents never see it. Long-term off-ramp: at
~20+ entries the corpus is publishable as a standalone "competent-SWE
textbook," so the entry shape stays self-contained markdown — no
Ludics-internal jargon required for comprehension.

Relates to (out of scope here, but the first non-seed captures once this
ships): `gh-ludics-496`, `gh-ludics-497`.

## Acceptance Criteria

- [ ] **AC1 — `docs/swe-textbook.md` exists** under `~/ludics/docs/`. The
      file's preamble explicitly states the directionality: *not* consulted
      by coder or reviewer agents; consulted only by Mag and the
      feedback-digest worker; entries are write-side memory for filter
      decisions and a future publication seed. Falsifier: the file is
      missing OR its preamble omits any one of the three statements above
      OR its preamble contains a "consult this doc" / "see also" pointer
      back from `worker-conventions.md` or any
      `skills/orchestration/pair-coder-*.md` /
      `skills/orchestration/pair-reviewer-*.md` file.

- [ ] **AC2 — Entry shape is defined and honoured.** The preamble specifies
      the per-entry skeleton, and the seed entry instantiates every field:
      (a) a short headline naming the pattern;
      (b) a one-paragraph plain-English description that does not require
          Ludics-internal context to read (publication-friendly);
      (c) the precipitating retro / GH issue / PR
          (`task-…` / `gh-…` / PR URL);
      (d) the filter decision — i.e., why a process-suggestions or
          feedback-digest run would skip this item under the
          competent-SWE filter;
      (e) optionally, a "second-occurrence" line if the entry is added on a
          repeat hit rather than the first sighting.
      Falsifier: the seed entry written for AC6 below is missing any of
      fields (a)–(d), OR field (b) requires a reader to understand
      Ludics-internal jargon.

- [ ] **AC3 — `/ludics-process-suggestions` gains a third disposition.**
      `skills/ludics-process-suggestions.md` is edited so that:
      (a) the classification step (currently `<!-- section:classify -->`,
          two-way: substantive → create-task / nitpicky → skip-with-reason)
          becomes a three-way split: substantive → create-task,
          recurring-but-not-doctrine → capture-textbook, one-off-hygiene →
          skip-with-reason;
      (b) the "Judgment Criteria" section gains a third bucket describing
          when `capture-textbook` fires;
      (c) the result-JSON schema in `<!-- section:write-result -->` gains
          a sibling array `"textbookCaptures": [{"suggestion": "...",
          "entryHeadline": "...", "precipitatingRetro": "..."}]`, alongside
          the existing `skipReasons` array;
      (d) the example block in that section is updated to show the new
          field.
      Falsifier: a fresh process-suggestions run on a textbook-eligible item
      writes a result JSON with no `textbookCaptures` field, OR
      `grep -n "capture-textbook" skills/ludics-process-suggestions.md`
      returns no match in the classification or judgment-criteria sections.

- [ ] **AC4 — `/ludics-feedback-digest` gains the same third disposition.**
      `skills/ludics-feedback-digest.md` and/or
      `skills/ludics-feedback-digest-worker.md` (whichever holds the
      classification logic) is edited to:
      (a) name the third disposition `capture-textbook` and describe when
          it fires (matching the AC3 narrative);
      (b) introduce a new `textbookCaptures` field in the worker's result
          JSON schema (today the worker reports
          `issues_created/updated/skipped` counts but no per-item array;
          the new field is a sibling counts/array, e.g.
          `"textbookCaptures": [{"feedbackItem": "...",
          "entryHeadline": "...", "precipitatingRetro": "..."}]`).
      Falsifier: after this task ships, a feedback-digest run that captures
      a filter-rejected item to the textbook produces no record of the
      capture in either the worker's result JSON or its skill log
      output, OR `grep -n "capture-textbook"
      skills/ludics-feedback-digest.md skills/ludics-feedback-digest-worker.md`
      returns no match in the classification narrative.

- [ ] **AC5 — Idempotency guard, shared across both skills.** Before
      appending a new entry, both skills check the existing textbook for
      a near-duplicate (same headline OR same precipitating-retro). On a
      hit, the skill short-circuits the new append and may instead amend
      the existing entry's "second-occurrence" line (per AC2.e). The guard
      is implemented in **one** location that both skills reference (see
      Approach §4 — exact home picked from the codebase scan). Falsifier:
      a synthetic process-suggestions run on the same skipped item, fired
      twice, produces two entries in `docs/swe-textbook.md` with the same
      headline; OR the guard logic is duplicated verbatim across
      `ludics-process-suggestions.md` and `ludics-feedback-digest*.md`
      (instead of one referenced from both).

- [ ] **AC6 — One seed entry ships with this PR.** The first entry in
      `docs/swe-textbook.md` is the `gh-ocannl-270` AC6 lesson (canonical
      headline e.g. *"'Issue is updated' means an actual GH-side comment,
      not a one-way docs cite"*). Its description quotes the reviewer's
      blocking line from the gh-ocannl-270 review (round 1, retrospective
      at `~/self-improve/harness/retrospectives/gh-ocannl-270.json`):
      AC6 was unsatisfied because the GH issue body still only linked the
      Imbue article and the docs-cite alone did not constitute "issue is
      updated." Falsifier: `docs/swe-textbook.md` contains zero entries
      after merge, OR the seed entry doesn't cite `gh-ocannl-270`.

- [ ] **AC7 — Negative control on agent-loaded prompts.** No coder or
      reviewer-loaded skill file gains a pointer to `swe-textbook.md`.
      Falsifier (positive-presence check on out-of-scope skills):
      ```
      git diff main...HEAD -- skills/ \
        | grep -E "swe-textbook" \
        | grep -vE "^(\\+\\+\\+|---) (a|b)/skills/(ludics-process-suggestions\\.md|ludics-feedback-digest\\.md|ludics-feedback-digest-worker\\.md)"
      ```
      returns any line. The expected in-scope skill files are exactly the
      three named in the grep allowlist; any other `skills/*.md` file
      mentioning `swe-textbook` (notably
      `skills/worker-conventions.md`, any
      `skills/orchestration/pair-coder-*.md`, any
      `skills/orchestration/pair-reviewer-*.md`,
      `skills/ludics-draft-proposal*.md`, etc.) flips this AC.

- [ ] **AC8 — No source-code changes outside doc/skill text.** The diff is
      docs and skill markdown only. Falsifier: `git diff --name-only
      main...HEAD` lists any path under `src/coder/`, `src/reviewer/`, or
      `src/orchestration/`. (If the idempotency-guard helper of AC5 lands
      as a TS module, it goes under a non-coder/-reviewer/-orchestration
      directory — see Approach §4.)

## Context

Today's filter pipeline:

- `skills/ludics-process-suggestions.md` (`<!-- section:classify -->`,
  `<!-- section:judgment-criteria -->`, `<!-- section:write-result -->`):
  classifies retrospective suggestions as substantive (→ `create-task`)
  or nitpicky (→ `skip-with-reason`); reports a `skipReasons: [{suggestion,
  reason}]` array in result JSON. Items hit by the competent-SWE filter
  fall into the nitpicky bucket and disappear into log lines.
- `skills/ludics-feedback-digest.md` and
  `skills/ludics-feedback-digest-worker.md`: cluster
  `feedback/*.md` markdown into GH-issue creates. There is no
  `skipReasons`-style array today — only counts
  (`issues_created/updated/skipped`). Filter-rejected items leave no
  textual trace beyond the worker's free-form `summary`.
- `harness/claude-memory/feedback_competent_swe_filter.md`: the operating
  rule. Stays valid; the textbook complements it rather than replacing it.

The negative-control surface for AC7 (verified 2026-05-05): `skills/`
contains no `ludics-coder-base.md` or `ludics-reviewer-base.md`; coder and
reviewer prompts compose from
`skills/orchestration/pair-coder-{clarify,plan,plan-merge,work,update-docs,pr-create}.md`
and
`skills/orchestration/pair-reviewer-{clarify,gather,plan,plan-review,pushback,review}.md`,
plus the cross-cutting `skills/worker-conventions.md`. None of these may
mention `swe-textbook`.

Peer doc shape: `docs/ac-rigor-reference.md` is the closest sibling — a
markdown reference doc with a stated audience, vocabulary, and a thematic
table of contents. `docs/swe-textbook.md` should be syntactically
peer-shaped (preamble naming audience and directionality; entries as
self-contained `### Headline` sections).

Proposals home: `docs/proposals/` is the standard location; the directory
holds both `task-<hash>.md` and `task-<hash>-<descriptive-suffix>.md`
forms — this proposal uses the descriptive-suffix form.

Triggering items in flight (out of scope for *this* implementation,
listed in the task's `relates_to` for future tracking): `gh-ludics-496`
and `gh-ludics-497` are the first non-seed textbook captures once this
ships; their re-disposition and GH-issue closure with a textbook pointer
are follow-up work.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

1. **`docs/swe-textbook.md`** — create with a preamble that states
   directionality (audience: Mag and the feedback-digest worker; *not*
   consulted by coders/reviewers), entry-shape skeleton (AC2 fields a–e),
   and the publication off-ramp note. Add the seed entry (gh-ocannl-270
   AC6 lesson, AC6 above). Keep the preamble short — `ac-rigor-reference.md`
   is a useful but not-mandatory shape reference.

2. **`skills/ludics-process-suggestions.md`** — edit the existing
   `<!-- section:classify -->`, `<!-- section:judgment-criteria -->`, and
   `<!-- section:write-result -->` blocks per AC3. The classification
   narrative becomes three-way; the result-JSON example in
   `<!-- section:write-result -->` gains the
   `textbookCaptures` array next to `skipReasons`; "Judgment Criteria"
   gains a third bucket describing the recurring-but-not-doctrine
   signature (referencing the competent-SWE-filter memory line).

3. **`skills/ludics-feedback-digest.md` and
   `skills/ludics-feedback-digest-worker.md`** — introduce
   `capture-textbook` symmetrically. The worker's "Response Contract"
   section gains a `textbookCaptures` field (and a corresponding
   schema example), and the per-step narrative gains a step where
   filter-rejected items are routed to the textbook before the
   issues-vs-skipped tally. Asymmetry note: process-suggestions today
   has structured `skipReasons`; feedback-digest does not — this PR adds
   the structured slot for textbook captures only, deferring any
   `skipReasons`-equivalent for filter-rejection-without-capture.

4. **Idempotency-guard helper home (decision deferred to plan phase).**
   The `~/ludics/src/skills/` directory currently holds only
   test files (`ludics-elaborate-worker.test.ts`); there is no
   established TS-helper pattern shared between skills. Three options for
   the plan phase to settle:
   (a) **Markdown convention**: each skill embeds the same three-line
       `grep -F "$HEADLINE" docs/swe-textbook.md` short-circuit snippet,
       documented once in the textbook's preamble as the canonical
       check. Lowest implementation cost; AC5's "one location both
       skills reference" is the textbook preamble itself.
   (b) **TS helper**: a new `src/skills/swe-textbook-guard.ts` module
       exporting a `checkTextbookDuplicate(headline, retro)` helper, and
       both skills shell out to a tiny CLI wrapper. Highest formality;
       paired with a unit test under `src/skills/`.
   (c) **Shell helper**: a new `scripts/swe-textbook-check.sh` that both
       skills invoke. Middle ground.
   The plan phase picks one based on which existing skill-helper pattern
   the codebase already uses for similar grep-style checks (the
   `relates_to:.*$ARGUMENTS` grep in `<!-- section:idempotency-guard -->`
   of `ludics-process-suggestions.md` is the nearest precedent — favours
   option (a) or (c) over (b)).

5. **Verify and commit.** Run the AC7 grep as a self-check before
   committing. Walk AC1–AC8 one-by-one against the diff.

Edits are *additive* on the two skill files — the existing
`skipReasons`/`issues_skipped` paths and the `create-task` /
`skip-with-reason` dispositions stay intact; the third disposition slots
in beside them.

## Scope

**In scope**: the new doc; edits to the three named skill files; the
idempotency-guard helper (option chosen during plan phase); the seed
entry.

**Out of scope** (explicitly):

- Any pull-side integration. Coders and reviewers see no change.
  (AC7/AC8 enforce this.)
- Migrating the corpus to a published-book format. Surface as a future
  task once entries accrue (~20+).
- Backfilling additional seed entries beyond the gh-ocannl-270 AC6
  lesson. Backfill is a follow-up that walks historical
  `mag/results/req-*.json` `skipReasons` arrays.
- The actual re-disposition of `gh-ludics-496` and `gh-ludics-497` as
  textbook captures, and their GH-issue closure with a pointer. Listed
  in the task's `relates_to`; happens after this lands.
- Any update to the GH issues `gh-ludics-496/497` themselves in this PR
  — those issues stay open and proceed via the new disposition once
  the third path exists.

**Dependencies**: none. The competent-SWE-filter memory entry
(`feedback_competent_swe_filter.md`) is the conceptual prerequisite and
already exists.
