# Pair Work (Coder)

{{PROPOSAL_INSTRUCTION}}

Implement the task in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Reviewer guidance from prior round:

{{PEER_REVIEW}}

Commit in small batches (4-6 files), and include a regression test alongside each behavior change in the same batch — deferring the test to a follow-up round tends to drift into abandonment. Build, lint, and run targeted tests before signaling done.

Before modifying any symbol, re-run a project-wide grep for it — the plan's occurrence list may have missed an inline reimplementation (regex pattern, copy-pasted logic, string literal) that the same change needs to reach. Handle new hits in this round rather than deferring. See [exhaustive occurrence search](../../docs/orchestration-patterns.md#exhaustive-occurrence-search) for the variants to look for.

Documented interfaces drift when the code behind them changes — config schemas drift from their reference doc, CLI USAGE strings drift from the README. When you touch one side, update the other in the same round so CI can confirm the pair; see [CI drift files](../../docs/orchestration-patterns.md#ci-drift-files) for the known pairs and their lint scripts.

For data-shape changes or format-compat serializers, add a round-trip fidelity test (serialize → deserialize → compare key fields) so silent field omissions show up this round rather than as data loss later. See [round-trip serialization fidelity](../../docs/orchestration-patterns.md#round-trip-serialization-fidelity) for the minimal test shape.

Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

{{#IF PROPOSAL_PATH}}
**Scope discipline**: AC is a floor, not a ceiling — see [scope: floor, not ceiling](../../docs/orchestration-patterns.md#scope-floor-not-ceiling) for the boundary that decides absorb vs declare. Small adjacent fixes that the change made obvious (a typo, a one-line type tightening, a stale comment, an obvious dead-code drop in a file you're already editing) should be absorbed without ceremony — mention them in the commit body if helpful, but no `scope-expansion:` trailer or follow-up task is required.

Reach for declare/defer when the fix is more than a few lines, introduces a new abstraction or new import, touches a file you wouldn't otherwise have opened, or materially broadens the PR's review surface:
- **Declare it** — add a `scope-expansion: <one-line reason>` trailer to the commit message so the reviewer sees it and can decide per-expansion, or
- **Defer it** — leave the file untouched and jot the idea in the task's `Notes` section (or open a follow-up task directly).

Cross-cutting cleanups in unrelated files (whole-file reformatting, dead-code sweeps, adjacent refactors not driven by this change) still belong in a separate task, not here. See [scope declaration and salvage](../../docs/orchestration-patterns.md#scope-declaration-and-salvage).

**Salvage on rejection**: If the reviewer rejects a declared scope expansion, capture the diff before reverting so nothing useful is lost:

1. `git diff -- <rejected-paths> > /tmp/salvage-{{TASK_ID}}.patch` — snapshot the rejected changes.
2. `ludics tasks create "<short description of the deferred work>" <project> C` — create the follow-up task. Then edit the new task file's frontmatter to set `status: needs-confirmation` and, under the existing `dependencies:` block, replace `relates_to: []` with `relates_to: [{{TASK_ID}}]` (the field lives under `dependencies:`; a top-level `relates_to` is ignored by parsers). Paste the captured patch + one-line justification into the task body. (Mirrors `ludics-process-suggestions` — the `ludics tasks create` CLI does not accept `--relates-to`, so the frontmatter edit is required.)
3. `git checkout -- <rejected-paths>` — revert the files in this worktree, then continue with the in-scope work. The new task flows through the existing needs-confirmation surface (dashboard + briefing).
{{/IF}}

**Acceptance Criteria self-check.** Before writing the done status, verify every acceptance criterion is satisfied. Produce a visible checklist — don't just think it through. AC drift is the long-tail failure mode of this workflow.

{{#IF PROPOSAL_PATH}}
1. Re-read `{{PROPOSAL_PATH}}` in the project repo for the authoritative acceptance criteria.
{{/IF}}
{{#UNLESS PROPOSAL_PATH}}
1. Re-read the task spec above (from context) for the acceptance criteria — no proposal file exists for this task.
{{/UNLESS}}
{{#IF TASK_AC}}
Task acceptance criteria from the task file:

{{TASK_AC}}
{{/IF}}

For each criterion, append a one-line confirmation to `{{WORKFLOW_FEEDBACK_FILE}}` under a `## AC Verification` heading (create the heading if absent), naming the evidence that satisfies it (file, test, commit). Each verification line must name the invariant the cited evidence enforces — the property that would no longer hold if the AC were violated — not the capability it merely exercises; when the evidence is a test, cite the exact assertion that would fail (not one that only traverses the AC's code path), and when it is a doc or config artifact, cite the structural property (e.g. a resolvable anchor, a consumer that still reads the field) whose absence would break the AC. For each verification line, also name the harness condition that instantiates the AC's case — the concrete setup state that makes the assertion actually exercise the AC, not merely traverse the surrounding code path; a test that passes whether or not that condition holds does not enforce the AC, and applies equally to "skips on X" / "no-ops when Y" ACs and to N-outcome enumerations where each outcome needs its own dedicated test. When the AC's passing condition is a property of "the world" (template set, real config, live filesystem) rather than a unit invariant, run a [pre-assertion harness probe](../../docs/orchestration-patterns.md#pre-assertion-harness-probe) against the world *before* drafting the assertion. Only write the done status after every criterion has a confirmation line. See [AC self-check](../../docs/orchestration-patterns.md#ac-self-check) and [harness instantiation](../../docs/orchestration-patterns.md#harness-instantiation).

If the task is already resolved on the base branch (fix already merged, no meaningful changes needed), don't make empty commits — they waste a round and pollute git history. Signal bail-out instead (see [bail-out contract](../../docs/orchestration-patterns.md#bail-out-contract)):

```sh
printf 'bail-out|%s|<describe why task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

Use bail-out only when there's genuinely nothing to do. Partially-done tasks still finish normally.

If you believe you're stuck in a contradictory or looping situation that ordinary progress can't escape — e.g., the reviewer keeps flipping verdict on identical work, or you've done nothing meaningful for several rounds on unchanged input — raise your hand with `bail-out: escalate`. The runner halts at the current phase (no discarded work, no phase advance), flags the slot, and notifies the user. See [escalation contract](../../docs/orchestration-patterns.md#escalation-contract) for when to use it.

```sh
printf 'escalate|%s|<one-sentence reason>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
