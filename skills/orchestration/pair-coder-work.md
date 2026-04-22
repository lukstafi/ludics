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
Before signaling done, re-read `{{PROPOSAL_PATH}}` and walk through each acceptance criterion, stating explicitly (in your thinking) how the implementation satisfies it — AC drift is the long-tail failure mode. Write the status file only once every criterion is met. See [AC self-check](../../docs/orchestration-patterns.md#ac-self-check) for why the walk is visible rather than implicit.
{{/IF}}

If the task is already resolved on the base branch (fix already merged, no meaningful changes needed), don't make empty commits — they waste a round and pollute git history. Signal bail-out instead (see [bail-out contract](../../docs/orchestration-patterns.md#bail-out-contract)):

```sh
printf 'bail-out|%s|<describe why task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

Use bail-out only when there's genuinely nothing to do. Partially-done tasks still finish normally.

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
