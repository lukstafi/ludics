# SWE Textbook — Mag-side Write Memory for Filter-Rejected Learnings

## Audience and Directionality

This document is a **write-only journal** with these constraints:

1. The file is **not** consulted by coder agents.
2. The file is **not** consulted by reviewer agents.
3. The only active consumers are Mag and the
   `/ludics-feedback-digest` worker.
4. Entries are write-side memory for **competent-SWE filter
   decisions** — items the filter would otherwise discard from
   always-loaded prompts (see
   `harness/claude-memory/feedback_competent_swe_filter.md`).
5. The corpus is also a **future publication seed**; entries should
   read in plain English, free of Ludics-internal jargon.

## Entry Shape

Each entry is a `### <headline>` section with the following labelled
fields:

- `Description:` one paragraph, plain English, publication-friendly.
- `Precipitating retro:` one of `task-…`, `gh-…`, or a PR URL.
- `Filter decision:` why a `/ludics-process-suggestions` or
  `/ludics-feedback-digest` run would skip this item under the
  competent-SWE filter.
- `Second occurrence:` *(optional)* — appended only when the same
  pattern repeats; carries the new precipitating retro and a
  one-line note.

## Capture Idempotency

This is the **only** location where the duplicate-guard logic lives.
Both `/ludics-process-suggestions` and `/ludics-feedback-digest`
MUST run this check before appending a new entry; both skills
reference this section by anchor
(`docs/swe-textbook.md#capture-idempotency`) and describe its
inputs/outputs in prose. **Skills MUST NOT copy the snippet below
into their own bodies** — duplicating the implementation across
skill files would defeat the single-source-of-truth invariant this
section enforces.

Inputs from the calling skill:

- `ENTRY_HEADLINE` — the proposed headline text **without** the
  leading `### ` markdown prefix; the guard prepends `### ` itself
  when it scans the textbook. (E.g., for an entry that will render
  as `### My pattern name`, the caller passes `ENTRY_HEADLINE="My
  pattern name"`.)
- `PRECIPITATING_RETRO` — the proposed `Precipitating retro:` value.

Outputs:

- `append` — no near-duplicate found; the caller writes a fresh
  `### <headline>` block with the four required labelled fields.
- `skip-duplicate` — a near-duplicate exists by either headline OR
  precipitating-retro; the caller MUST NOT append a new entry. The
  caller MAY amend the matched entry's `Second occurrence:` line
  with the new precipitating retro and a one-line note.

```bash
textbook="docs/swe-textbook.md"
if grep -Fq "### ${ENTRY_HEADLINE}" "$textbook" \
   || grep -Fq "${PRECIPITATING_RETRO}" "$textbook"; then
  echo "skip-duplicate"
  exit 0
fi
echo "append"
```

**Known soft-spot — `ASSUMPTION GAP` escalation.** The disjunctive guard
above (`headline OR retro`) returns `skip-duplicate` whenever a new entry
shares either key with any existing entry. The case it silently
collapses: a new entry whose `Precipitating retro:` matches an existing
entry's, but whose headline and `Filter decision:` describe a materially
distinct lesson. Under the bare contract the caller would amend the
matched entry's `Second occurrence:` line and drop the new lesson. When
the caller runs inside an orchestrated coder/reviewer pair, the right
move is to surface the choice in the merged plan with an
`⚠️ ASSUMPTION GAP: …` marker (per `pair-coder-plan-merge.md`) so the
reviewer sees and rules on the divergence at plan-merge time. When the
caller is a one-shot Mag invocation of `/ludics-feedback-digest` (no
merged plan), the equivalent discipline is to surface the choice in the
digest's result JSON and commit message rather than silently routing
through `skip-duplicate`.

---

### "Issue is updated" means an actual GH-side comment, not a one-way docs cite

Description: When a contract clause says an external issue tracker
entry is "updated" as part of acceptance, the update must be visible
on the tracker itself — a comment, an edited body, or a
closed/labelled state — not merely a one-way pointer from the
repository's own documentation. A docs file that links the issue is
not the same as the issue gaining a link to the docs file. A reader
checking the issue tracker for the update will see no change. Sister
contract clauses ("issue is closed," "issue is labelled") have the
same direction: the side named by the verb is the side that must
visibly change.

Precipitating retro: `gh-ocannl-270` (round-1 reviewer; retrospective
at `~/self-improve/harness/retrospectives/gh-ocannl-270.json`). The
reviewer's blocking line: *"AC6 is not satisfied because GitHub issue
#270 has not been updated to link to the committed memo. The proposal
requires 'GH issue #270 is updated to link to it'; the current issue
body still only links the Imbue article […]."*

Filter decision: Under the competent-SWE filter this would land in
the "obvious-to-experienced-engineer" bucket and be discarded from a
`/ludics-process-suggestions` run — yet the failure mode survives
competent engineers under deadline pressure (the contracted artifact
lives on the *other* side of the fence). Captured here rather than
skipped silently.

### New OrchestrationConfig fields require parse+merge in adapter init

Description: A typed configuration object that drives runtime
behaviour usually has four independent surfaces a new field has to
land on: the interface declaration, the in-code default, any
backfill the persistent-state migrator applies to old records, and
the parse+merge step the initialisation path performs against the
user-facing YAML. The first three are easy to spot — they live next
to each other in the same file or test — and a typed compiler will
flag drift between them. The fourth is the most distant from the
field declaration and the least visible to the type checker: if the
init path never reads the YAML key, the documented config is
silently inert and the field always takes its default. Adding a
shared parser called from each init consumer is the cheapest way to
keep the fourth surface visible. The pattern: a single helper named
after the value it produces, called from each adapter's existing
config-load consumer, fed into the partial-config record that the
defaults function consumes — so the adapter knows to read the YAML,
the parser knows the shape, and the merge knows the precedence.
Test the parser as a unit; integration coverage at the call sites
catches regressions there.

Precipitating retro: `task-a670cdbf` round-2 review of PR #493
(settled-no-signal / hung-detection split). The reviewer's blocking
line: the new `mag.orchestration.substantive_stall.*` YAML keys
were documented and runtime-honoured, but neither adapter init
extracted them from the YAML — so the keys were silently inert
until the round-2 fix shipped a shared
`parseSubstantiveStallOverrides` parser called from both adapter
call sites.

Filter decision: Under the competent-SWE filter this is an
"obvious-to-experienced-engineer" doctrine reminder — wiring up the
read site is part of the same change as adding the field, by
definition. Captured here rather than promoted to always-loaded
agent prompts because the failure mode survives competent engineers
under deadline pressure when the four surfaces sit in different
files. The same precipitating retro is closed mechanically by the
adapter-call-site lint shipped in gh-ludics-496, which makes the
typed-default-plus-backfill checkbox no longer sufficient.

### "Adapter init reads YAML" is a separate AC for OrchestrationConfig field additions

Description: When an acceptance criteria list enumerates the surfaces
that have to change for a new typed config field — interface,
default, migration backfill — the adapter init path's read of the
user-facing YAML is easy to bundle into the umbrella line "config
field exists". That bundling lets a typed-interface-plus-default
checkbox count as completion even when the YAML is silently
ignored. The remedy is to give the init-side read its own AC,
phrased as a behavioural property at the user-visible boundary
("setting the YAML key to a non-default value produces the
non-default behaviour"), distinct from any structural AC about the
type or the default. The behavioural framing makes the AC
falsifiable by an end-to-end test that sets the YAML and observes
the runtime, not by an inspection of the type declaration.

Precipitating retro: `task-a670cdbf` round-2 review of PR #493. The
proposal's AC list bundled the YAML-read step into "config field
exists"; round-1 implementation satisfied the structural ACs without
satisfying the behavioural one, and the gap surfaced only at
round-2 review.

Filter decision: Under the competent-SWE filter this is also
"obvious-to-experienced-engineer" doctrine — separate ACs for
separate surfaces is general AC-writing hygiene. Captured here
rather than promoted to AC templates loaded by always-on agent
prompts because the doctrine is most useful as guidance to humans
writing proposals, not as a rule enforced at every coder turn. The
mechanical lint from the sibling entry above closes the same
failure mode for the specific case of `OrchestrationConfig` fields.

### Cherry-picking one named lint into pair-coder-work.md is editorially inconsistent

Description: Named-lint enumeration in `pair-coder-work.md` is editorially inconsistent unless you name **all** repo-wide gates; cherry-picking one (`lint:test-isolation`) advertises it as special. The competent-SWE filter applies — the other lints (`bun run lint`, `bun run typecheck`, `bun run lint:contracts`, etc.) are not enumerated either. The skill says "Build, lint, and run targeted tests before signaling done" without naming individual scripts; adding one named lint inverts that established editorial stance.

Precipitating retro: `task-a670cdbf` round-2 review of PR #493; aggregated via `/ludics-feedback-digest` 2026-05-04 (gh-ludics-497 issue body action 1).

Filter decision: Under the competent-SWE filter this is doctrine ("remind coders to run X") and would be skipped from a `/ludics-process-suggestions` run. Captured here rather than promoted to always-loaded agent prompts because surfacing the failure message at the moment of trip (gh-ludics-497 action 2c) accomplishes the ergonomic goal without naming the lint in a checklist.

### "Optional pre-commit hook" feedback-digest items must verify the infra exists

Description: Feedback-digest items proposing optional pre-commit hook integration if a Husky setup exists should verify the infrastructure is present before treating as in-scope. Introducing Husky is a separate decision affecting every commit on every machine; not a workflow-feedback fix. The verification pattern: `ls .husky` plus a `package.json` grep for `"husky"` / `"lint-staged"` keys — both empty means the proposal's "if exists" antecedent is false and the action is captured-as-doctrine rather than executed.

Precipitating retro: `task-a670cdbf` round-2 review of PR #493; aggregated via `/ludics-feedback-digest` 2026-05-04 (gh-ludics-497 issue body action 3).

Filter decision: Under the competent-SWE filter this is doctrine — verifying infrastructure preconditions before acting on a conditional suggestion is general engineering hygiene. Captured here because the failure mode is asymmetric: feedback-digest aggregation tends to bundle "if X exists, also do Y" suggestions without checking X, and a competent reviewer can still miss that the antecedent never held.

### Run mutation tests before writing the AC verification line that claims them

Description: An AC verification line that asserts "mutation: changing X to Y flips the assertion from pass to fail" only earns its evidence weight when the mutation has actually been observed. The temptation under deadline pressure is to write the line based on a confident mental model — flip the literal mentally, predict the failure, write the verification — then run the mutation later (or skip the run entirely because the suite was green). The right discipline reverses the order: edit the source, run the test, observe the failure message verbatim, revert the edit, then write the verification line citing the observed message. The mutation-as-prediction failure mode is silent — a wrong prediction passes review because reviewers can't easily distinguish "ran and observed" from "thought through and described" — but the cost surfaces later when an actual regression slips past a vacuously-passing assertion.

Precipitating retro: `task-c4e0e80a` round-1 (coder feedback, 2026-05-05). The coder explicitly noted: *"I asserted 'mutation: the AC7 walker test failed loudly when I temporarily added the string' before actually running that mutation, then ran it after the AC verification was already written. The claim happened to be true, but the order was sloppy."* Same pattern echoed in gh-ludics-497 round 1 (the coder ran the mutation as a "scratch run during implementation" but documented the discipline rather than relying on a prediction).

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" discipline — running the experiment before writing the result is general scientific method. Captured here rather than promoted to always-loaded agent prompts because the failure mode is invisible (the line reads correctly either way) and rule-by-rule enforcement at every coder turn would be heavy-handed; #478's "mutation testing as standard AC verification" issue closes the broad case at the policy layer, and the textbook entry preserves the order-of-operations refinement for future readers.

### When introducing a new AC pattern at the reference layer, instantiate it in the same proposal's own ACs

Description: A reference-layer doc (e.g. `docs/ac-rigor-reference.md`) that introduces a new AC pattern — a (b)-form scope invariant, a per-seam harness shape, an idempotency guard — gains evidence weight when the proposal that *introduces* the pattern instantiates it in the proposal's own AC list. Two effects: (a) the pattern is demonstrated in a working example in the same diff that documents it, so a future reader sees both the prose and a worked instance; (b) the new pattern survives any environmental drift the proposal itself triggers (e.g. a proposal-on-main commit advancing the merge-base, which is exactly the failure mode the new clause names). The pattern stays a piece of inert prose if the proposal's own ACs don't reach for it; eating-your-own-dog-food makes the prose battle-tested before merge.

Precipitating retro: `task-097cca67` round 1 (coder feedback, 2026-05-05). The proposal added a new (b)-form "scope invariant" clause to `docs/ac-rigor-reference.md` and AC10 of the same proposal was phrased as a (b)-form invariant — "no `src/**`, `scripts/**`, `templates/**`, or `*.test.ts` path appears in `git diff --name-only main...HEAD`" — rather than the more brittle "exactly these two paths appear" form. The (b)-form survived the merge-base-advance reproduction the new clause describes; the brittle form would not have.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" doctrine — using a new pattern in its own definition is a standard refactor-discipline tell. Captured here rather than promoted to `ludics-draft-proposal-worker` checklists because the doctrine is most useful as a hint to the proposer at draft time, not as a rule enforced at every proposal turn; the proposer who writes a proposal that defines a pattern is the one most able to instantiate it cleanly, and a generic checklist would mostly fire on proposals that don't introduce reference-layer patterns.

### Symmetric-OR ACs need each arm's own dedicated harness, and no implementation short-circuit

Description: When a contract clause names two failure conditions joined by an OR ("exit on A OR B"), an implementation that exits early on A alone passes every test that only exercises A — even though the second arm is silently disabled. The fix shape is mechanical: (a) the implementation does not short-circuit downstream of one arm; if the contract names an OR, the run loop computes both arms before deciding; (b) the test harness contributes four conditions per OR pair (paired/unpaired × arm-1/arm-2), with a load-bearing `not.toContain(<other-arm's-evidence-string>)` negative assertion in each arm-unpaired test to catch implementations that route through the wrong machinery; (c) the AC self-check enumerates each arm separately, citing the dedicated test for each. The failure is silent under the original symmetric AC because review questions like "does this test pass?" check arm-1 only.

Precipitating retro: `gh-ludics-479` round 1 (coder feedback, 2026-05-03). The proposal AC was *"0 = paired, 1 = asymmetry (added/changed field with no migrator change OR migrator change with no test fixture)"*. Round 1's `lint:state-migration` short-circuited to `exit 0` whenever `checkShapes(...)` returned `[]`, so the second arm (migrator change without test fixture) was unreachable; round-1 tests only exercised the first arm. Reviewer flagged with REQUEST_CHANGES; round 2 extracted `enforceMigratorTestPairing` and added four harness conditions plus the `not.toContain` negative assertions.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" test discipline — exercising both branches of a disjunctive contract is general logic-coverage hygiene, and the reviewer caught it cleanly in a single REQUEST_CHANGES round. Captured here rather than promoted to a new clause in `docs/ac-rigor-reference.md` (the originally proposed "doctrine" landing) because the catch-net works without a preamble bullet, the auto-memory `feedback_or_clause_ac_no_short_circuit.md` already covers the coder-side artifact, and adjacent memories (`feedback_per_seam_harness_for_multi_boundary_ac`, `feedback_short_circuit_ac_observe_outcome`) cover overlapping territory at the always-loaded layer.

### "Do X then continue" ACs need an assertion downstream of the fall-through

Description: When an AC reads "do X then continue / proceed", a single assertion on the artifact of X (a file rewrite, a journal event, a log line) is insufficient: a regression that performs X correctly and then immediately `return`s passes every X-side assertion, because each side-effect happened before the unwanted early exit. The test must observe both — the artifact of X **and** something only the proceed-arm would produce (e.g. a downstream phase transition, a counter incremented later in the loop, an output that only the continued path emits). The reusable mutation a reviewer can name: "what if the implementation did the side-effects and then returned?". If no assertion in the test would notice, the harness is not yet a falsifier of the AC's "then continue" half.

Precipitating retro: `gh-ludics-509` round 2 (coder feedback, 2026-05-09). The reclaim path's first round shipped tests asserting file-rewrite, journal event, and reclaim-log — all of which fire before any hypothetical `return;` after `emitEvent`. Reviewer REQUEST_CHANGES specifically asked for the proceed-arm half; round 2 added `expect(transitionCalls).toBeGreaterThan(0)` and `expect(state.phase).toBe("done")` against a spied `evaluateTransition`, then ran the actual mutation (insert `return;`, watch the new asserts fail, revert) before signalling done.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" test-completeness discipline — exercising the full path the AC names is general AC-writing hygiene, and #478's mutation-evidence coverage already names the broad rule. Captured here rather than promoted to always-loaded prompts because the failure mode is shape-specific (the side-effects-before-return pattern) and most usefully delivered as a reviewer probe ("what if the implementation did X and then returned?") rather than a per-coder checklist; the textbook entry preserves the reusable mutation question for future reviewers.

### "Does NOT do Y" invariants need observation at Y's persistent surface, not adjacent narration

Description: When an AC asserts "the runner must NOT mutate file F" / "must NOT write key K", asserting the adjacent log line ("X mismatch — exiting") is insufficient: a regression that emits the log AND silently writes anyway passes every log-side assertion. The honest harness reads F (or K) post-hoc and asserts the value the regression would have changed (`expect(persisted.field).toBe(originalValue)`). Generalises: for any negative invariant, observe the named artifact at its persistent surface (file/db/in-memory map), not at adjacent narration that fires regardless of the mutation. The mutation a reviewer can name: "what if the code logs the same message but also performs the forbidden write?"

Precipitating retro: `gh-ludics-509` round 2 (coder feedback, 2026-05-09). Pre-existing live-mismatch trio asserted the `"PID mismatch ... exiting"` log fired, but the log fires regardless of whether the file was rewritten. Round 2 added `expect(persisted.orchestration.pid).toBe(wrongPid)` after `runOrchestration` returns, observing the no-rewrite invariant at its persistent surface.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" test discipline — observing the named artifact at its persistent surface is general negative-AC hygiene, and the reviewer caught it cleanly. Captured here rather than promoted to `docs/ac-rigor-reference.md` because the failure mode is symmetric to the "X then continue" entry above (both are about asserting the right place for a multi-effect AC) and adjacent always-loaded memories already cover the broader vacuous-harness family at the policy layer.

### Heading-literal exact-count grep falsifiers count intra-doc cross-links too

Description: When a doc-AC's falsifier reads `grep -cF '<full heading text>' <file>` returns *exactly* N, any *other* place in the doc that quotes the same literal (a markdown link's bracket text, a bold inline reference, a `> blockquote` paraphrase) flips the count silently — the heading itself stays unique, but the AC fails because the grep is unconditioned by line position or markdown role. The remedy when adding intra-doc cross-links to a uniquely-headed clause: paraphrase the link text rather than reproducing the full heading literal in the bracket. The Stash-prod precedent uses bold-name (`**No-regression framing when the gate baseline is red**`) for exactly this reason — it's a clause reference, not a clause-text reproduction. After landing a new heading clause whose AC pins exact-count, grep the literal across the touched doc(s) and verify the count matches before signalling done.

Precipitating retro: `task-4335d903` round 1 (coder feedback, 2026-05-09). A reverse cross-link in the new Sibling-mutation clause body — `[Closed-set / cardinality ACs — set-equality is the strongest probe shape](#anchor)` — repeated the heading literal in the link's bracket text, so `grep -cF` returned 2 against the AC's "exactly one hit" invariant. Caught only by running the AC's literal probe; visual review missed it because both occurrences read as "talking about the same clause." Fix was paraphrase to `**set-equality probe shape**`.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" doc-author discipline — knowing that grep counts substring occurrences regardless of markdown role is general doc-tooling literacy. Captured here rather than promoted to a new `docs/ac-rigor-reference.md` clause because the failure mode is narrow (heading-literal-exact-count ACs combined with intra-doc cross-links) and the post-edit grep-the-literal hygiene reads as "obvious" once named; the textbook entry preserves the cross-link-bracket paraphrase precedent for future readers.

### State-repo file paths in proposals need an explicit `~/<state-repo>/` qualifier

Description: When a proposal AC names `config.yaml`, `tasks.yaml`, `briefing.md`, `journal/events.jsonl`, or any other harness artefact and writes a falsifier like `grep -c X config.yaml`, that grep target almost always lives in the user's private state repo (mounted at a fixed path under the user's home dir), not in the project worktree the PR opens against. CLAUDE.md is explicit on this separation. When a proposal's AC and "PR contains N commits" wording disagree about where a file lives, the correct fix is to revise the AC in the same PR (qualifying the path with the explicit `~/<state-repo>/...` prefix) rather than fabricate a path-substitution narrative or quietly re-target the grep at a sibling path. The reviewer can then accept-or-push-back on the revised partition explicitly.

Precipitating retro: `gh-ludics-502` round 1 (coder feedback, 2026-05-09). Proposal AC4/5/8 named `config.yaml` (intent: harness `~/self-improve/harness/config.yaml`); proposal text "PR contains N commits" implied all changes land in the project repo. Implementer revised the AC in commit `75a3bfc` to acknowledge the cross-repo split (companion commits in the state repo and a sibling staging worktree) rather than substitute a path-translation narrative.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" proposal-authoring discipline — naming an unambiguous absolute path is general spec hygiene, and the same-PR-revision rule (`feedback_self_contradicting_ac_revise_not_fabricate.md`) already covers the broader case. Captured here rather than promoted to always-loaded prompts because the failure mode is specific to the cross-repo-state architecture (the proposer's mental model conflates "harness file" with "this repo") and most usefully named at the proposal-authoring step, not enforced at every coder turn; the textbook entry preserves the qualifier discipline for future proposal authors.

### Dogfood-the-discipline ACs ship code as literals, not paraphrased prose

Description: When a doc-AC requires a new clause's body to "contain the recipe inline" — a worked code snippet that demonstrates the discipline the clause names — the non-vacuous shape is to ship a complete fenced code block with all the named tokens as literals (function names, variable names, assertion expressions). Paraphrasing the recipe into prose ("seed a file, then assert byte-identity") would pass a reader's smell test but fail a literal-grep AC, and — more importantly — would not be mutation-testable: removing any one named token from a literal recipe flips the falsifier; paraphrased prose has no such single-edit handles. The precedent: `### Stash-prod mutation test` carries the literal `git stash push --` command form in its body. Generalises: ACs that assert "X is demonstrated inline" should pin specific call/expression literals, and clause authors should write the literals (not the paraphrase) to satisfy them.

Precipitating retro: `task-a1e55a19` round 1 (coder feedback, 2026-05-10). New `### Real-decoy + byte-identity for path-safety probes` clause's AC8 required `writeFileSync(decoyPath, decoyContent);`, `readFileSync(decoyPath, "utf8")`, `expect(after).toBe(decoyContent)`, and `decoyPath = join(siblingDir, "decoy.md")` to all appear inside the new clause's body. Implementer shipped a fenced ```ts``` block with all four literals, making the recipe both the documentation and the mutation-target.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" doc-author discipline — knowing that paraphrased prose has no grep-able handles is general doc-tooling literacy. Captured here rather than promoted to a new `docs/ac-rigor-reference.md` clause because the pattern is narrow (a sub-shape of "literal-grep AC") and most usefully named as a precedent for clause authors, not as a per-coder rule; the textbook entry pairs with the heading-literal entry above to cover the "literals over paraphrase in doc-AC bodies" theme.
