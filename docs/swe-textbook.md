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

### Test the AC's load-bearing call site, not the leaf function whose argument is forwarded

Description: When an AC names a chain `A → B(x) → C(x')` — a binding at a call site `A` is supposed to flow through a helper `B` to a leaf `C` — a test that calls the leaf `C` directly and asserts the forwarded argument is a tautology, not a falsifier of the AC. The failure mode the AC describes (a future regression at `A` swapping `agent.worktreePath` for some shared path) is unreachable from a test that never exercises `A`. The fix shape is mechanical: when the AC's call site is buried inside a heavyweight orchestrator (one that builds adapter context, persists state, spawns subprocesses, …), extract the smallest enclosing scope that owns the AC's data binding into a named export, and call the helper from both the orchestrator and the test. The exported helper IS the test seam; the orchestrator becomes a thin wrapper. Heuristic for when to extract vs stand up the full integration harness: when the chain from public surface to the AC's seam crosses ≥3 heavyweight side-effecting calls, prefer the helper-extraction (one extra public symbol, no runtime change) over spying ≥5 collaborators. Companion discipline — mutation budget: the reviewer's enumerated mutation list (`projectDir`, `rootWorktree`, "any slot-shared path") is the test's coverage contract; verify locally with at least two of the named substitutions before claiming the assertion is sensitive to the value, and use real fixtures (e.g. drive `createWorktrees(repo, "task-x", agents, "main", slot, "duo")` rather than hand-built distinct strings) so the harness condition the AC needs ("distinct duo paths") is instantiated by upstream code, not by stipulation.

Precipitating retro: `task-7a5e2add` round 2 (coder feedback, 2026-05-10). Round 1's scope-3a tmux test called `createTmuxAgentSession(slot, name, agent.worktreePath, taskId)` directly and asserted the inner `tmuxNewSession` saw the same path — testing only that an unmutated argument is forwarded. Reviewer rejected: the AC's failure mode is the **call site** in `setupOrchestratedSlot`, not the leaf. Round 2 extracted the per-agent loop into the new export `startTmuxAgentSessionsForOrchestratedSlot`, drove it from a real duo `createWorktrees` setup, and verified two named mutations (`peerSyncDir` and `"/tmp/shared"`) both flip PASS→FAIL with distinct error messages — confirming sensitivity to the value, not just to its presence.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" test-target discipline — exercising the AC's true call site is general AC-writing hygiene, and adjacent always-loaded memories (`feedback_per_seam_harness_for_multi_boundary_ac`, the "mutation-tests as standard AC verification" issue #478) cover the broader policy layer. Captured here rather than promoted to coder-prompt checklists because the failure mode is recognition-shaped (the coder needs to see when a leaf-function test is a tautology), and the extract-as-helper fix is most usefully delivered as a precedent for reviewers to name when they see the shape, not as a per-turn rule.

### Failure-path tamper-and-restore harness pattern for CLI exit-code ACs

Description: When an AC asserts a CLI's failure-path shape — non-zero exit, stderr layout, remediation phrasing — the honest harness spawns the actual CLI against a tampered real in-scope input file, with try/finally restoration. Shape: pick a real in-scope file the lint scans, in a `try` block write a synthetic violation into it (e.g. a fenced bash block referencing `$LINT_<NAME>_PROBE_XYZ`), `Bun.spawnSync(["bun", "run", scriptPath])`, assert `exitCode === 1` plus each named stderr substring (the `❌` summary, the `file:line $NAME (snippet)` row, the three remediation phrasings), then in `finally` restore the file's original bytes. An in-process call to the linter function (e.g. `lintFile(...)` returning a `Violation[]`) is not equivalent: removing `process.exit(1)` or stripping the `❌` summary leaves the in-process assertion green. Companion happy-path test asserts `exitCode === 0` + `stdout.contains("✅")` on the live corpus, pinning the success branch. Keeping one harness shape across the lint family (`scripts/lint-skill-cli-refs.test.ts`, `scripts/lint-skill-shell.test.ts`, `scripts/lint-test-spawn-coverage.test.ts`) makes future failure-path tests boilerplate — the third lint reusing the pattern proves the cross-family stability.

Precipitating retro: `task-9329e350` round 2 (coder feedback, 2026-05-10). Round 1's failure-path test was named `"exits 1 when a synthetic typo is wired into the in-scope set"` but the body called `lintFile` in-process and asserted `violations.length > 0` — a misdirection: removing `process.exit(1)` or stripping the `❌` summary would not have failed it. Round 2 replaced it with a `Bun.spawnSync` test that tampers `templates/harness/CLAUDE.md` with `$LINT_SKILL_SHELL_PROBE_XYZ` in `try`, restores in `finally`, and asserts `exitCode === 1` plus the five named stderr substrings. This is the second occurrence of the same shape — first observed at `gh-ludics-439` (memory `feedback_cli_exit_code_needs_spawn.md`); the recurrence motivated the `lint:test-spawn-coverage` mechanization shipped in `task-f534e799` / PR #521.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" CLI-test discipline — exercising the actual binary's exit code and stderr is general CLI-author hygiene. Captured here rather than promoted to always-loaded prompts because the failure mode survives competent engineers (the in-process test reads correctly to a reviewer scanning test names), and the mechanical catch-net at `lint:test-spawn-coverage` already enforces the "exits-named tests must spawn" rule at the lint layer; the textbook entry preserves the harness shape (tamper-in-try / restore-in-finally / assert-each-named-substring) as a precedent for future failure-path tests across the lint family.

### Lexical filename-grep falsifiers are vacuous against wrong-path drift

Description: When an AC's falsifier counts occurrences of a filename substring (`grep -cF MEMORY.md <body>` ≥ 1), the count is satisfied by any prose mention of that filename — including a worked-example shell command that targets a path which does not exist in the world the rule covers. The lexical count is satisfied; the semantic claim (the command targets the named subtree, e.g. the memory tree at `~/.claude/projects/-*/memory/MEMORY.md`, not a non-existent project-local `<project>/memory/MEMORY.md`) is not. Fix shape: when an AC names a file in a worked example, the falsifier should grep the path-prefix (the directory that locates the file in the rule's world), not just the basename; and the coder's verification should add a quick "does this concrete command target a path reachable in the AC's named world?" sanity check on top of the lexical falsifier. The cheap reality check that catches the "right-substring-wrong-path" class before reviewer round 1: pick the worked-example command and verify its glob/literal-path actually resolves on a live filesystem in the world the rule covers.

Precipitating retro: `task-a8415073` round 2 (coder feedback, 2026-05-10). AC4's falsifier counted `MEMORY.md` substring hits, which passed against round 1's worked example (`<project>/memory/MEMORY.md`) despite that path being non-existent in any project worktree. The reviewer caught the path mismatch despite the falsifier passing; round 2 retargeted the worked-example grep at `~/.claude/projects/-*/memory/MEMORY.md` and the falsifier counted the path-prefix rather than the bare filename. Saved as `feedback_lexical_filename_count_vacuous.md` in coder auto-memory.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" verification-discipline — knowing that grep matches substrings regardless of semantic context is general doc-tooling literacy. Captured here rather than promoted to always-loaded prompts because the failure mode is narrow (worked-example paths in doc ACs whose falsifier greps the basename) and most usefully named as a precedent for coders writing AC verification lines; the textbook entry pairs with the "Heading-literal exact-count grep falsifiers count intra-doc cross-links too" entry above to cover the "lexical grep falsifiers are vacuous against orthogonal drift" theme.

### Self-contradicting-AC numbers + reviewer flip-flop → revise-in-PR is the stable fix

Description: When an AC pins a numeric floor or literal count that empirical observation shows cannot be satisfied (the test would need to fabricate inputs to clear the floor), the in-PR proposal edit is the stable fix even when a first reviewer rejects it as "out of scope for docs/**". The salvage-to-follow-up path is unstable: the next reviewer round will demand AC literal-satisfaction, and the work returns to the original edit at round 3, with extra cost (revert commit, create follow-up task, re-apply edit). The right move at round 1 is to push back on the "out of scope" verdict with the self-contradicting-AC argument — *the AC's empirical falsity overrides the scope discipline, because there is no AC-satisfying completion possible without the edit*. The same reasoning closes `feedback_self_applying_rule_to_own_spec.md` (a rule cannot be the test of its own spec when the spec contradicts the rule's output). When a coder's verification line would read "literal probe unsatisfiable, substituting…", the substitution is the symptom; the cure is to edit the proposal in the same PR. Round-1 reviewer's "out of scope" stance may be technically correct under the scope discipline, but it is not stable equilibrium under a multi-round review where subsequent reviewers will insist on literal satisfaction.

Precipitating retro: `task-f534e799` rounds 1–3 (coder feedback, 2026-05-10). Round 1's floor-count meta-test asserted `≥30 / ≥10` against the proposal's `≥35 / ≥12` because the lint's own `findTriggers` recognizer counts only 31 trigger rows in 10 files on `main` — the proposal-time estimate was an unverified agent count. Round 1 reviewer flagged the in-PR proposal edit as out-of-scope (`docs/**` not in this task's scope) and asked for salvage-to-follow-up; round 2 reverted the proposal edit and created `task-5083844f` as the salvage; round 2 reviewer then blocked on "AC #9 still unmet" because the test still asserted `≥30 / ≥10` against the unmodified `≥35 / ≥12` AC. Round 3 reviewer offered "officially change the proposal OR satisfy ≥35/≥12 literally", and the coder re-applied the minimal proposal correction (only the two count-bearing claims). Net cost vs landing the round-1 edit: one extra commit (the revert), one follow-up task (created and immediately marked completed-superseded), and a third review round.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" change-management discipline — scope rules have exceptions when the spec itself is empirically false. Captured here rather than promoted to always-loaded prompts because the failure mode is narrow (the conjunction of a self-contradicting AC and a scope-discipline-enforcing first reviewer) and most usefully named as a precedent the coder can cite when pushing back at round 1; the textbook entry also reinforces `feedback_self_contradicting_ac_revise_not_fabricate.md` (always-loaded) with the second-occurrence multi-round-cost data.

### AC asymmetry — "X uses Y" hides "non-X does NOT use Y"

Description: When a proposal AC names what one side of a partition does ("Top-level test(...) rows with no enclosing describe use the file body as their 'describe body'"), reading literally the clause is a one-way claim about the named side. But the partition's other side is implied: non-top-level (describe-internal) triggers do NOT use the file body. An implementation that satisfies the one-way claim with a subset rule (e.g. `containers(spawn) ⊆ containers(trigger)` without the converse implication) is over-permissive: file-scope spawns silently cover describe-internal triggers. The honest harness asserts both directions: a positive test for the named arm (file-scope spawn covers top-level trigger), AND a negative test for the converse (file-scope spawn does NOT cover trigger inside describe), AND a positive control proving the rule still admits the legitimate nested case (ancestor-describe spawn covers nested trigger). Reusable mutation a reviewer can name: "what if the implementation took the AC's named side literally and did the converse anyway? Which test would catch it?" When an AC names what one side of a partition does, also enforce what the other side does NOT do.

Precipitating retro: `task-f534e799` round 1 (coder feedback, 2026-05-10). The proposal AC #5 said "Top-level test(...) rows with no enclosing describe use the file body as their 'describe body'." Round 1's `spawnCoversTrigger` used a one-way subset rule that admitted file-scope spawn for describe-internal triggers — passing the reviewer's verbatim fixture as clean when it should have produced one violation. Reviewer caught with a fixture; round 2 rewrote to `containers(spawn) ⊆ containers(trigger)` AND `(containers(trigger) empty → containers(spawn) empty)`, and added three new regression tests (one end-to-end with the reviewer's fixture + two unit-level falsifiers on both sides of the asymmetry).

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" AC-reading discipline — reading a partition's named side as implying the negation of the other side is general spec-interpretation hygiene. Captured here rather than promoted to always-loaded prompts because the always-loaded memories `feedback_or_clause_ac_no_short_circuit.md` and `feedback_ac_verbs_are_contract.md` already cover the broader policy, and the textbook entry adds the specific reviewer-probe ("which test would catch the converse?") and the four-fixture coverage shape (positive named arm + negative converse + positive control + symmetric falsifier) as a precedent for coders writing tests against partition-shaped ACs.

### Probe runtime sentinels and library behaviour before drafting tests that depend on them

Description: An AC verification line that asserts "the test runtime sets sentinel `X` automatically" or "library helper `lib.fn(args)` round-trips faithfully" is load-bearing on a runtime/library invariant that the author has not necessarily observed. The temptation is to write the test from a confident mental model of the runtime — citing the docs or a prior version's behaviour — and let the suite discover any drift at run time. The discipline that catches the failure mode before review: open a scratch file (`/tmp/<probe>.ts` or a small `bun -e` invocation; prefer the file form because shell `$(...)` capture has its own escaping pitfalls), feed the runtime/library the exact inputs the test will use, capture the output, then write the test against the observed output. Two flavours: (a) runtime invariants — `bun -e 'console.log(process.env.BUN_TEST)'` confirms whether the test runner auto-sets the sentinel before an `expect(toBeTruthy)` is committed; (b) library behaviour — a 10-line probe that exercises `YAML.setIn(path, null) → emit → parseDocument` confirms the round-trip preserves the `null` cell and adjacent comments before an AC commits to the persistence shape. The general rule: when an AC narrative cites a runtime sentinel as "set automatically" or a library helper as "round-trips faithfully", the author owes a pre-assertion probe whose output appears in the verification trail (transcript, PR comment, scratch-file path). Without the probe the AC verification line is a guess dressed as evidence.

Precipitating retro: `task-87d4b17e` round 1 (coder feedback, 2026-05-12). The proposal's "BUN_TEST is already set by the runner; assert that, not override" assumption fired `expect(process.env.BUN_TEST).toBeTruthy()` failures because Bun 1.3.11 does not auto-set `BUN_TEST`; fix was to set `BUN_TEST="1"` explicitly in `beforeEach`. Same retro family: `task-b43bd578` round 1 (coder feedback, 2026-05-12) where the coder wrote `/tmp/yaml-null-probe.ts` before drafting the v2 plan, confirming `YAML.setIn(path, null)` emits `default_coder: null`, re-parses as `{default_coder: null}` with `"default_coder" in orch === true`, and preserves adjacent comments — empirical evidence that made the v2 plan defensible against the reviewer's "make null real at the read boundaries" alternative.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" verification-discipline — running the experiment before writing the prediction is general scientific method, and the always-loaded memory "Run mutation tests before writing the AC verification line that claims them" (entry above) covers the mutation-evidence half. Captured here rather than promoted to always-loaded prompts because the failure mode is invisible (the line reads correctly either way) and the policy layer already pins the broader rule via #478 (mutation testing as standard AC verification); the textbook entry adds the runtime-sentinel + library-behaviour shape as a precedent so future coders facing "the docs say X is automatic" reach for a `/tmp/*.ts` probe before drafting the assertion.

### Greedy regex extraction over markdown table cells is vacuous against column drift

Description: When an AC's falsifier extracts a structured value from a markdown table cell — issue numbers, statuses, paths — a regex like `sed -E 's/.*#([0-9]+).*/\1/'` extracts the **last** match per line, not the column-1 value. Any row whose evidence cell or comment column references a different `#NNN` (a cross-link memo, a "see #137" prose pointer) is silently misread: the column-1 value becomes the *cross-referenced* number, the AC passes against a wrong-set, and the bug surfaces only when a reviewer enumerates a specific row by hand. The fix shape: anchor extraction to start-of-line with a column-1 prefix literal — `grep -oE '^\| \[#[0-9]+\]'` followed by a non-greedy `sed -E 's/.*#([0-9]+)\]/\1/'` — so column 1 is structurally distinguished from column N's prose. The class generalises: any falsifier that walks markdown table rows with greedy `.*` must anchor to the column it reads, not rely on uniqueness of the substring shape across columns.

Precipitating retro: `task-a993fe29` round 2 (coder feedback, 2026-05-12). Round 2 reviewer flagged AC-1's falsifier as vacuous against the merged v1.1-freshness-sweep triage table: the greedy `sed -E 's/.*#([0-9]+).*/\1/'` misread the #271 row as #137 because that row's evidence cell cross-referenced the #137 memo, giving a duplicated `137` and a missing `271`. Fix in commit `3ee8f3d0` pinned LHS to a frozen 11-element audit-time snapshot and anchored RHS extraction to column 1 via `grep -oE '^\| \[#[0-9]+\]'` + `sed -E 's/.*#([0-9]+)\]/\1/'`.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" doc-tooling discipline — knowing that `.*` is greedy and that column-position is structural information a regex must reach for explicitly is general regex literacy. Captured here rather than promoted to always-loaded prompts because the failure mode is narrow (markdown table cell extraction in doc-AC falsifiers combined with rows that cross-reference *other* matches of the extracted shape) and pairs with the existing "Heading-literal exact-count grep falsifiers count intra-doc cross-links too" and "Lexical filename-grep falsifiers are vacuous against wrong-path drift" entries as the third occurrence of the "lexical grep is vacuous against orthogonal drift" family.

### Sweep ACs must pick audit-time-frozen or post-execution, not both

Description: When a proposal documents dispositions for `N` items (close-as-not-planned, promote, defer, etc.) and the closing commit executes those dispositions, the world-state the AC referenced at draft time no longer exists at execution time: `gh issue list --milestone v1.1 --state open` returns a strict *subset* of the audit-time-`N`, because the closed items have moved out of the live set. An AC that compares "the triage table" to "live open issues" cannot remain falsifiable across the sweep's execution — it would falsely fail any time the AC re-runs against world-state. The fix shape: pin the LHS of any enumeration-completeness check to a frozen audit-time snapshot (`printf '%s\n' 123 137 161 …`) and document live-state as a *subset* relationship if both are needed, not equality. Each AC should pick its referent — `audit-time` for completeness, `post-execution` for world-state mutation — and label it explicitly; conflating the two yields an AC that is vacuous at draft time and false at execution time.

Precipitating retro: `task-a993fe29` round 2 (coder feedback, 2026-05-12). Round 1's AC-1 falsifier compared the triage table to live `gh issue list`; the comparison drifted after the same round's `ludics tasks abandon` × 6 closed six of the eleven audit-time-open issues. Round-2 fix pinned LHS to the frozen `{123, 137, 161, 186, 190, 200, 216, 271, 278, 297, 404}` set and reframed AC-6 separately as the "world-state mutation" check (live `gh issue list --milestone v1.1 --state open` returns the three deferred-with-annotation rows).

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" AC-authoring discipline — knowing that a sweep mutates the very world its AC names is general spec-temporal-reasoning hygiene. Captured here rather than promoted to always-loaded prompts because the failure mode is shape-specific (multi-item disposition sweeps with completeness ACs spanning the closing commit) and adjacent textbook entries on "Audit-time vs post-execution" and the always-loaded `feedback_self_contradicting_ac_revise_not_fabricate.md` cover the broader temporal-AC family; the textbook entry preserves the frozen-snapshot + subset-relationship shape as a precedent for sweep proposal authors.

### Union-type evidence ACs need per-row anchor coverage, not just per-type existence

Description: When an AC says "every row's evidence cell carries at least one of: (a) doc path, (b) date, (c) code pointer, (d) cross-reference", a falsifier that checks each anchor *type's existence across the table* (e.g., `grep -oE 'docs/[a-z]+\.md' | test -f`) is vacuous: it passes as long as *some* row uses each anchor type, even if other rows carry no anchor at all. The honest falsifier is per-row coverage: for each row, compute `has_a || has_b || has_c || has_d` and report `MISSING-EVIDENCE` if none holds. The shape (awk-style):

```
awk -F'|' '/^\| \[#[0-9]+\]/ {
  cell = $4;
  has_path = match(cell, "docs/[a-z0-9_/-]+\\.md") > 0;
  has_date = match(cell, "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]") > 0;
  has_code = match(cell, "[a-z_]+\\.ml") > 0;
  has_xref = …;  # cross-reference to a different row number
  status = (has_path || has_date || has_code || has_xref) ? "OK" : "MISSING-EVIDENCE";
  print status;
}' <file>
```

The general rule for union-type ACs: a falsifier that checks "at least one row has type X" is necessary but not sufficient; the falsifier the AC actually names ("every row has at least one of {X,Y,Z}") needs per-row coverage. Notation pitfall: awk's `/.../` regex literal treats `/` as the delimiter, so `(cell ~ /docs\/foo\/bar/)` opens a character class containing `/` — use string-form `match(cell, "docs/...")` instead.

Precipitating retro: `task-a993fe29` round 3 (coder feedback, 2026-05-12). Round 2's AC-2 falsifier was a single path-existence grep that silently passed the #297 row whose evidence cell was prose-only with no qualifying anchor. Round 3 broadened AC-2 to four anchor types and added a per-row coverage check; the #297 row was rewritten with concrete pointers (createdAt `2024-12-20`, the v0.7.1 prerequisite `#377` verified OPEN via `gh issue view`, corrected predecessor `#57` to CLOSED on v0.6.4).

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" AC-falsifier discipline — knowing that a disjunctive AC needs per-element coverage to be falsifiable is general AC-writing hygiene. Captured here rather than promoted to always-loaded prompts because the failure mode is narrow (union-type evidence ACs over enumerated rows in doc tables) and pairs with the "Per-element assertions for enumerated-element ACs" pattern in `docs/ac-rigor-reference.md` as the table-cell-shape specialisation; the textbook entry preserves the awk per-row coverage skeleton as a precedent for future doc-table ACs.

### Sweep ACs spanning an elaboration window need audit-time-open plus acknowledged-closed framing

Description: When a sweep proposal is elaborated over a window during which one of its in-scope items changes state (an issue closes mid-flight as the user resolves it independently, a task gets abandoned, a PR merges), the proposal naturally documents the item for self-explanation — but an AC that says "exactly one row per currently-open issue" is internally inconsistent with the included acknowledgment row, and an AC that says "every row corresponds to live state at execution time" is vacuous against the acknowledgment row's pre-resolved state. The honest framing names the union: "audit-time-open ∪ acknowledged-closed-in-elaboration-window", with the acknowledgment rows tagged structurally (e.g., a `defer-with-roadmap-annotation` / `acknowledge-no-op` disposition cell) so the falsifier can distinguish them from live-action rows. The general lesson: any disposition sweep that spans an elaboration window has to budget AC language for rows whose state changed mid-flight; the AC cannot pretend the elaboration window was instantaneous.

Precipitating retro: `task-a993fe29` round 3 (coder feedback, 2026-05-12). The triage table included #190 (closed NOT_PLANNED on 2026-05-05 inside the elaboration window) for self-explanation, but AC-1 originally said "exactly one row per currently-open issue" — internally inconsistent. Round-3 fix reframed AC-1 to compare against a frozen 11-element audit-time set, treated #190 as the explicit acknowledgment row with a `No-op for sweep` disposition cell and a rationale line, and documented in the AC body that audit-time-open ∪ acknowledged-closed is the correct referent.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" sweep-authoring discipline — knowing that an elaboration window is a finite period during which the world keeps moving is general spec-temporal-reasoning hygiene. Captured here rather than promoted to always-loaded prompts because the failure mode is narrow (sweep proposals whose elaboration spans days and whose AC has a completeness clause) and pairs with the "Sweep ACs must pick audit-time-frozen or post-execution, not both" entry above as the elaboration-window-specific specialisation; the textbook entry preserves the union-framing precedent for future sweep authors.

### Surface AC semantic gaps as ASSUMPTION GAP markers in v0 of a merged plan

Description: When a proposal's AC describes a state space the existing code does not honour — for example, an AC that requires explicit `null` payloads to round-trip distinctly from absent keys when the read site coerces both identically — the merged-plan v0 that papers over the gap with a folklore "this is fine, here's a comment in the source" deferral is unstable: a reviewer will correctly reject the deferral as sub-AC implementation, and the work returns to the original choice with revision cost. The right discipline at plan-merge time is to surface the gap explicitly with a `⚠️ ASSUMPTION GAP: …` marker (per `pair-coder-plan-merge.md`) describing what the AC requires, what the code currently does, and proposing the resolution: either (a) implement the AC's full state space (which may be a multi-AC sub-task), or (b) revise the AC in the same PR to scope it to a smaller domain mirroring an existing AC's precedent. The cost of an explicit ASSUMPTION GAP in v0 is one extra paragraph the reviewer reads in plan-merge; the cost of papering over it is one or more rejected plan-merge rounds.

Precipitating retro: `task-b43bd578` rounds 1–2 (coder feedback, 2026-05-12). The v0 merge plan said "delete YAML key on null payload, the read side coerces null and absent identically anyway." Reviewer caught that this collapsed an explicit user "none" selection into the unset-effective-default on reload (contradicts AC 10's `null` body contract). v1 fixed the persistence but left the dashboard-vs-auto-fill asymmetry as folklore in the plan body; reviewer caught it again. v2 promoted the asymmetry to a proposal AC (`13a`) and pinned both auto-fill read sites with regression tests — three merge rounds before implementation could begin.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" plan-merge discipline — knowing that a "this is fine" deferral on a state-space-mismatch AC will be caught by a competent reviewer is general spec-implementation hygiene. Captured here rather than promoted to always-loaded prompts because the failure mode is shape-specific (the AC-vs-current-code state-space mismatch at plan-merge time) and the `pair-coder-plan-merge.md` skill already names the `ASSUMPTION GAP` marker as the load-bearing surface; the textbook entry preserves the precedent that papering-over costs more rounds than surfacing-explicitly, and pairs with `feedback_self_contradicting_ac_revise_not_fabricate.md` (always-loaded) on the AC-revision-as-resolution branch.

### Same-PR proposal revision beats new semantics when the AC asymmetry is additive

Description: When a reviewer flags a partial-AC implementation with multiple remediation options — (1) implement the full AC's state space (multi-AC sub-task), (2) revise the proposal in the same PR to scope the AC to a smaller domain mirroring an existing AC precedent, (3) accept partial implementation with caveat — option (2) is the stable fix when three conditions hold: (a) the existing proposal already has parallel "deferred to N≥X" or "limitation in mode Y" language an additive limitation can mirror, (b) the asymmetry does not break the user's headline goal (the feature still does what the proposal title claims), (c) the revision is *additive* (a new limitation note), not a contradiction of an existing AC. The discipline that catches the wrong choice: when option (1) would expand scope by a factor of 2× or more in lines-of-test, prefer (2); when option (3) would ship folklore where an AC edit will do, also prefer (2). Memory hits: `feedback_self_contradicting_ac_revise_not_fabricate.md` (always-loaded) and `feedback_salvage_to_followup_unstable_when_ac_contradicts_reality.md` cover the broader rule; the textbook entry adds the three-condition shape that distinguishes "revise the AC" from "implement the AC" or "ship a caveat".

Precipitating retro: `task-b43bd578` round 1 (coder feedback, 2026-05-12). The v1 plan implemented persistent `null` round-trip but the dashboard-vs-auto-fill asymmetry remained — the auto-fill read sites (`selectOrchestrationFlags`, `expandDuoSlots`) coerced `null` to literal defaults rather than honouring "no preference" semantics, and the proposal's AC 10 (dashboard payload contract) did not constrain that behaviour. Reviewer offered three remediations: (1) make `null` real at auto-fill (multi-AC sub-task: solo/tiny/pair combinations × coder/reviewer arms), (2) revise the proposal in the same PR to scope `null` to dashboard state only, mirroring AC 13's existing duo-mode limitation precedent, (3) ship the asymmetry as folklore. v2 chose (2): added AC `13a` describing the asymmetry as a limitation with regression tests pinning both auto-fill read sites' coercion behaviour. Cost: one paragraph in the proposal plus two pinned regression tests, vs ≥4 ACs and ≥6 fixtures for option (1).

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" change-management discipline — knowing when to revise a spec vs implement it is general engineering judgement, and the always-loaded `feedback_self_contradicting_ac_revise_not_fabricate.md` covers the broader rule. Captured here rather than promoted because the three-condition test (parallel-language-exists + headline-goal-preserved + revision-is-additive) is most usefully delivered as a precedent for coders facing a multi-remediation reviewer flag, not as a per-turn rule; the textbook entry preserves the three-condition heuristic and the cost-comparison shape ("multi-AC sub-task vs one paragraph") for future remediation choices.

### No-DOM test runtime: source-grep invariant pins plus live HTTP smoke probe

Description: When a feature ships browser-side JavaScript (a UI module that constructs DOM, a static-asset script that mutates layout, a service worker) and the project's test runtime (Bun's `bun:test`, Node without `jsdom`/`happy-dom`) lacks `document`, the obvious move — add a `happy-dom` dependency just to test the DOM construction — is rarely the right scope decision. Two cheaper surfaces compose to cover the AC: (a) source-grep invariant pins extract the DOM-construction invariants as literal-substring assertions against the module body (literal class names, literal `aria-label` and visible-text strings appearing the expected number of times, the `classList.toggle("active", …)` literal that the AC names) — catches drift before runtime, no DOM dependency; (b) a live HTTP smoke probe boots the real server entrypoint against a temp-dir mirror of the asset tree and `fetch`es the route the AC names, producing a transcript that pins end-to-end rendered output (see `worker-conventions.md` § Manual-Smoke Evidence). Together the two surfaces cover the same ground a DOM-test runtime would: source-grep catches structural drift, smoke catches end-to-end rendering bugs. The general rule: when an AC names a DOM construction invariant and the test runtime lacks `document`, the question "what should the pinning surface be?" has a default answer (source-grep + smoke) before reaching for a runtime dependency.

Precipitating retro: `task-b43bd578` round 1 (coder feedback, 2026-05-12). The role-switcher UI module (`templates/dashboard/role-switcher.js`) constructs a multi-button DOM tree with class-name invariants and cascade-rule logic spanning the N=2 and N≥3 provider cases. Coder source-grep tests (`templates/dashboard/role-switcher.test.ts`) pinned literal class names, the "Defaults for new sessions" label appearing 2× (once as `aria-label`, once as visible text), and the `classList.toggle("active",` literal; live HTTP smoke probe (`/tmp/task-b43bd578-smoke.ts`) booted `startDashboardServer` against a `mkdtemp`'d fixture and pinned AC 19.i–iv plus the v1 null round-trip and AC 10 duplicate-rejection. Together: 0 DOM-runtime dependencies, +74 new tests, end-to-end coverage of every AC in scope.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" test-strategy discipline — knowing that source-grep + integration probe composes to cover what a DOM test runtime would is general test-architecture literacy. Captured here rather than promoted to always-loaded prompts because the failure mode is shape-specific (DOM-construction ACs in a no-DOM-runtime project) and the `worker-conventions.md` § Manual-Smoke Evidence already names the live HTTP probe pattern; the textbook entry preserves the two-surface decomposition (source-grep for structure + smoke for end-to-end) as a precedent for coders facing the same setup, so the default question becomes "which invariants live at which surface?" rather than "should we add a DOM-test dependency?".

### Asymmetry-pin tests at multiple read seams need one fixture per seam

Description: When an AC pins behaviour at multiple read seams — a TypeScript fake-config object consumed by one helper, an on-disk YAML file consumed by another helper that reads via `loadConfigSync()` internally — a single test fixture cannot exercise both seams. The fake-config branch needs a TypeScript object cast (`{mag: {orchestration: {default_coder: null}}} as Config`); the on-disk branch needs a real `mkdtempSync` directory with a written YAML file plus `LUDICS_CONFIG` env, exercising the file-read path verbatim. Substituting one for the other (e.g., spying `loadConfigSync` instead of writing a real file) hides any file-read-specific behaviour (YAML parser edge cases, file-system mock divergence from the real fs, env-var propagation). The general rule for multi-boundary ACs: each read seam gets its own fixture matching its actual input source; the test-effort cost is one extra `mkdtempSync` per file-read seam, the coverage benefit is observing the seam's real behaviour rather than a substitution. Memory hit: the always-loaded `feedback_per_seam_harness_for_multi_boundary_ac.md` covers the broader rule; the textbook entry adds the fake-config-vs-on-disk-fixture decomposition for config-driven multi-seam ACs.

Precipitating retro: `task-b43bd578` round 1 (coder feedback, 2026-05-12). AC `13a` (asymmetry pin: both auto-fill read sites coerce explicit `null` → literal fallback) had two read seams: `selectOrchestrationFlags(config, …)` accepts a `config` param and was tested with a TypeScript fake object cast; `expandDuoSlots(…)` reads `loadConfigSync()` internally and was tested with an on-disk YAML fixture using `mkdtempSync` + per-test cleanup + `LUDICS_CONFIG` env, mirroring the `dashboard.test.ts` standard pattern. Both fixtures landed in `src/orchestration-defaults.test.ts`; each pins its seam's coercion behaviour with assertions that would fail if a future "honour null" change landed on either read site without updating its test.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" test-architecture discipline — knowing that each read seam needs its own input-source-matching fixture is general per-seam-harness hygiene, and the always-loaded `feedback_per_seam_harness_for_multi_boundary_ac.md` covers the broader rule. Captured here rather than promoted to coder prompts because the fake-config-vs-on-disk decomposition is shape-specific (config-driven multi-seam ACs in projects that mix dep-injection with file-read internally) and most usefully named as a precedent for coders writing tests against multi-read-site ACs; the textbook entry preserves the two-fixture shape as a precedent so the default question becomes "which seam does each test exercise?" rather than "can one fixture cover both?".

### When two guards produce identical observables, the AC test needs a seam at the dispatch boundary

Description: When a contract has two guards on the same path — a defence-in-depth pair, where an outer loop short-circuits before calling an inner function that itself re-checks the same condition — and both guards produce identical observables (the same log line, the same absent state file, the same returned value), an AC phrased as "the outer path short-circuits BEFORE reaching the inner function" cannot be falsified by probing the downstream observable: removing either guard alone leaves the other path producing the same string and the same state. The test must observe the dispatch itself — whether the inner function was actually called — which requires an indirection seam exported from the same module. A namespace spy does not help when the call is a same-file local reference (the runtime resolves the local binding directly, not through the module namespace); the minimal seam is a single exported holder object (`{ fn: typeof innerFn }`) that the outer path dispatches through and the test can swap, restored via try/finally. The seam is only half the job: a positive-control sibling test, where the seam IS expected to fire (a non-guarded input records a dispatch), is mandatory to prove the empty-dispatch assertion in the guarded case is non-vacuous.

Precipitating retro: PR https://github.com/lukstafi/ludics/pull/525 (`task-20e5dfce`, coder feedback round 2, 2026-05-13). The batch-loop guard in `runAllTestHealth` and the direct guard in `checkProjectTestHealth` both ended with `[test-health] X: skipped (postponed)` on stderr and left `mag/test-health.json` absent; the round-1 AC1 test was vacuous because removing the batch guard still passed via the direct-guard fallthrough. Round 2 introduced a `_runAllTestHealthDispatch.fn` holder seam plus a `calls: string[]` recorder and a positive-control sibling test; mutation-verified locally — removing the batch guard makes `expect(calls).toEqual([])` fail with `["postponed-proj"]`.

Filter decision: Under the competent-SWE filter this is "obvious-to-experienced-engineer" test-target discipline — observing the dispatch rather than a shared downstream observable is general AC-falsifiability hygiene, and the reviewer caught the vacuity cleanly in a single round. Captured here rather than promoted to always-loaded prompts because the failure mode is recognition-shaped (the coder needs to see when two guards collapse onto the same observable) and pairs with the existing "Test the AC's load-bearing call site, not the leaf function whose argument is forwarded" and "Do X then continue ACs need an assertion downstream of the fall-through" entries as the dispatch-boundary specialisation of the vacuous-harness family; the seam-plus-positive-control shape is most usefully delivered as a precedent for reviewers to name, not as a per-turn rule.
