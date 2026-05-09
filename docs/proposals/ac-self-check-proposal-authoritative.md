# AC self-check imperative reads the proposal, not the task-file bullets

## Goal

Stop the recurring AC self-check failure mode where coders enumerate the
task file's coarsened bullets instead of the proposal's authoritative AC
list. The doctrine already exists (`docs/ac-rigor-reference.md`
§ "Proposal beats task file when AC counts diverge"; cited from
`skills/worker-conventions.md`'s rigor enumeration), but the skill body the
coder reads at done-time inlines the task-file ACs as a ready-made checklist
and treats the proposal as a path requiring a re-read. A coder under time
pressure walks the inlined list. Reorder and reframe the
`pair-coder-work.md` AC self-check block so the imperative target is the
proposal's AC list and the inlined `{{TASK_AC}}` content reads as a
non-authoritative pointer.

Tracks: https://github.com/lukstafi/ludics/issues/505

## Acceptance Criteria

1. The `**Acceptance Criteria self-check.**` block in
   `skills/orchestration/pair-coder-work.md`, **when `PROPOSAL_PATH` is
   set**, reads as a single imperative naming the proposal as the
   authoritative AC list and instructing the coder to count its AC bullets
   and walk all of them — not as a "re-read this path, then walk the
   inlined bullets" two-step.
2. The inlined `{{TASK_AC}}` content (rendered inside the
   `{{#IF TASK_AC}} … {{/IF}}` guard) is reframed as a non-authoritative
   coarsened reference — i.e. the surrounding prose explicitly tells the
   coder these bullets do not constitute the checklist and the proposal's
   ACs prevail when their counts diverge.
3. The `{{#UNLESS PROPOSAL_PATH}}` branch (no proposal exists) is left
   functionally unchanged: the coder is still told to walk the task spec's
   ACs as the only available list. Phrasing tweaks are fine; semantics are
   not.
4. The existing wikilinks in the AC self-check paragraph remain present and
   resolvable: `[AC self-check]`, `[harness instantiation]`,
   `[mutation evidence]`, and `[pre-assertion harness probe]`, all pointing
   at `docs/orchestration-patterns.md` (or `../../docs/orchestration-patterns.md`
   per the existing relative-path convention in the file).
5. The `## AC Verification` heading name and the `{{WORKFLOW_FEEDBACK_FILE}}`
   target are unchanged — anything that grepped for either continues to find
   it.
6. No new prescriptive checklist scaffolding is added: no new wikilinks,
   no new "before you signal done, also do X / Y / Z" subsection, no new
   reference doc, no inline restatement of the rigor families enumerated in
   `docs/ac-rigor-reference.md`. The fix is reordering and reframing existing
   text plus at most one short stinger that names the proposal-vs-task-file
   delta. (Scope-discipline guard against the prescriptive-template-bloat
   pattern flagged in `feedback_competent_swe_filter` and
   `feedback_reference_layer_not_inline`.)
7. The two existing template-render tests in
   `src/orchestration/skills.test.ts` continue to pass without modification:
   - `pair-coder-work: AC self-check renders Re-read \`{{PROPOSAL_PATH}}\`
     when proposal exists` (or whatever the current test name is — the
     assertion that matters: rendered output contains
     ``Re-read `docs/proposals/my-feature.md` `` and does **not** contain
     `Re-read the task spec above` / `no proposal file exists` when
     `PROPOSAL_PATH` is set).
   - `pair-coder-work: AC self-check references WORKFLOW_FEEDBACK_FILE and
     the visible-checklist heading` — rendered output continues to contain
     the literal `## AC Verification` heading, the substituted
     `WORKFLOW_FEEDBACK_FILE` value, and the phrase `visible checklist`.
8. The build and the full test suite stay green: `bun run build` and
   `bun test` (or whatever the project's standard pre-PR commands are)
   pass.

## Context

The skill template the coder actually executes at done-time:
`skills/orchestration/pair-coder-work.md`, the
`**Acceptance Criteria self-check.**` block. Current shape (numbered for
reference, not literal):

- The lead sentence says "Before writing the done status, verify every
  acceptance criterion is satisfied. Produce a visible checklist — don't
  just think it through."
- Then a `{{#IF PROPOSAL_PATH}}` step 1: "Re-read `{{PROPOSAL_PATH}}` …
  for the authoritative acceptance criteria."
- A `{{#UNLESS PROPOSAL_PATH}}` step 1: "Re-read the task spec above …
  no proposal file exists for this task."
- Then a `{{#IF TASK_AC}}` block that prints "Task acceptance criteria
  from the task file:" followed by `{{TASK_AC}}` rendered verbatim — this
  is the inlined checklist that the coder, under time pressure, treats as
  the list to walk.
- Finally a long paragraph on per-criterion verification lines, harness
  conditions, mutation evidence, and the wikilinks listed in AC4.

The doctrine that this proposal asks the skill body to *emphasise* lives
in `docs/ac-rigor-reference.md` § "Proposal beats task file when AC counts
diverge" (around line 37 at time of writing) and is already enumerated in
`skills/worker-conventions.md` line 49 under the "Process-around-the-AC"
list. The fix here is **not** to add new doctrine; it is to make the
skill body's own ordering and framing match the doctrine that already
exists.

Template-context plumbing (read-only — no changes proposed here):
`src/orchestration/skills.ts` populates `PROPOSAL_PATH` and `TASK_AC`
(see `buildSkillContext` and the allowed-keys list). `TASK_AC` returns the
empty string when the task file has no `## Acceptance Criteria` section
or when the only bullet is `- [ ] TBD`, so the `{{#IF TASK_AC}}` guard is
already correct for the no-task-AC case.

Render tests for the AC self-check block live in
`src/orchestration/skills.test.ts` near the
`pair-coder-work: AC self-check …` test names (around line 1819 and the
adjacent test that asserts the proposal-path literal). These tests pin
the load-bearing substrings the AC4/AC7 criteria above protect.

Sibling-task informational note: `gh-ludics-502` is in flight and will
modify `pair-coder-plan.md` and `pair-reviewer-gather.md` to substitute
`bun test` with a computed `{{TEST_COMMAND}}` template var. This task's
edit site is `pair-coder-work.md`, a different file — no conflict risk.

Just-completed `task-9120ddcf` (textbook-capture) flagged that the
existing `ac-rigor-reference.md` clause is sufficient and a *new* clause
is not needed. This proposal honours that signal: AC6 explicitly forbids
adding new prescriptive scaffolding.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The straightforward shape (one template edit, no new wikilinks, no new
reference docs):

1. In `skills/orchestration/pair-coder-work.md`, restructure the
   `**Acceptance Criteria self-check.**` block when `PROPOSAL_PATH` is set
   so the imperative reads roughly: "Open `{{PROPOSAL_PATH}}` and treat
   its `## Acceptance Criteria` section as the authoritative list. Count
   the AC bullets there; that count is the length of the
   `## AC Verification` checklist you must produce. Do not substitute the
   task-file bullets — they are a coarsened summary and may have fewer
   entries than the proposal."
2. Reframe the `{{#IF TASK_AC}}` block so the heading is something like
   "Task-file ACs (non-authoritative coarsened reference — for context
   only; the proposal's `## Acceptance Criteria` is the checklist):"
   followed by `{{TASK_AC}}` unchanged. This keeps the existing render
   shape (so AC7 holds) while removing the false signal that the inlined
   block is the list to walk.
3. Leave the long verification paragraph (harness conditions, mutation
   evidence, wikilinks) as-is — that's the rigor scaffolding, separate
   from the proposal-vs-task-file emphasis fix.
4. Leave the `{{#UNLESS PROPOSAL_PATH}}` branch effectively as-is.
5. Run `bun run build && bun test` and `bun run lint:skill-cli-refs` (and
   any other pre-PR lints the project runs) before pushing.

The diff is a few stanzas inside one file. No code changes; no schema
changes; no new tests required (the existing tests cover the
load-bearing render invariants).

## Scope

**In scope**

- Edits to the AC self-check block in
  `skills/orchestration/pair-coder-work.md` per the criteria above.
- A small phrasing nudge in `skills/worker-conventions.md` is
  **acceptable but not required** if the coder finds the existing line-49
  enumeration entry reads more clearly with a one-word emphasis tweak.
  Anything more than a phrasing nudge there is out of scope.

**Out of scope**

- Any mechanical AC-count lint (proposed in the GH issue, explicitly
  dropped per the resolved question on 2026-05-09 — the reviewer is the
  catch-net).
- A new clause in `docs/ac-rigor-reference.md` (the existing
  "Proposal beats task file when AC counts diverge" section already
  carries the doctrine).
- Edits to `pair-reviewer-review.md`, `pair-reviewer-gather.md`,
  `pair-coder-plan.md`, or any other skill file. (gh-ludics-502 is
  already touching `pair-coder-plan.md` and `pair-reviewer-gather.md`
  for an unrelated change — informational only, no overlap with this
  task's edit site.)
- Changes to `src/orchestration/skills.ts` (the template-context
  plumbing). No new template vars are needed.
- Changes to the test file beyond what is required to keep AC7 green
  (which is "no changes" if the load-bearing substrings are preserved).

**Dependencies**

None blocking. Sibling task `gh-ludics-502` touches different files;
either can land first.
