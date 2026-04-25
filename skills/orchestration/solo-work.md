# Solo Work (Coder)

{{PROPOSAL_INSTRUCTION}}

Implement the task in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Commit in small batches (4-6 files), and include a regression test alongside each behavior change in the same batch. Build, lint, and run targeted tests before signaling done.

Before modifying any symbol, re-run a project-wide grep for it — including inline reimplementations (regex patterns, copy-pasted logic) — and handle any occurrences the plan missed in this round rather than deferring.

A few places where drift tends to creep in:
- Config types (`src/config.ts`) or CLI commands (`src/index.ts` USAGE) — update `templates/config.reference.yaml` and/or the README CLI Reference. CI (`lint:config-reference`, `lint:cli-readme`) will flag drift.
- Data-shape changes or format-compat serializers — add a round-trip fidelity test (serialize → deserialize → compare key fields) so silent field omissions show up early.

Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

{{#IF PROPOSAL_PATH}}
Before signaling done, re-read `{{PROPOSAL_PATH}}` and walk through each acceptance criterion, stating explicitly (in your thinking) how the implementation satisfies it. Each criterion's mental walk should also name the harness condition that makes the test exercise that AC — a test that passes whether or not the condition holds does not enforce it. See [harness instantiation](../../docs/orchestration-patterns.md#harness-instantiation). Write the status file only once every criterion is met.
{{/IF}}

If the task is already resolved on the base branch (fix already merged, no meaningful changes needed), don't make empty commits — signal bail-out instead:

```sh
printf 'bail-out|%s|<describe why task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

Solo bail-out is terminal — the runner transitions straight to `done` with no reviewer confirmation. Use bail-out only when there's genuinely nothing to do. Partially-done tasks still finish normally.

If you believe you're stuck in a contradictory or looping situation that ordinary progress can't escape — e.g., contradictory instructions in the proposal you can't reconcile, or an environment problem no retry has fixed — raise your hand with `bail-out: escalate`. The runner halts at the current phase (no discarded work, no phase advance) and notifies the user. See [escalation contract](../../docs/orchestration-patterns.md#escalation-contract) for when to use it.

```sh
printf 'escalate|%s|<one-sentence reason>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
