# Pair Work (Coder)

{{PROPOSAL_INSTRUCTION}}

Implement the task in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Reviewer guidance from prior round:

{{PEER_REVIEW}}

Commit in small batches (4-6 files), and include a regression test alongside each behavior change in the same batch. Build, lint, and run targeted tests before signaling done.

Before modifying any symbol, re-run a project-wide grep for it — including inline reimplementations (regex patterns, copy-pasted logic) — and handle any occurrences the plan missed in this round rather than deferring.

A few places where drift tends to creep in:
- Config types (`src/config.ts`) or CLI commands (`src/index.ts` USAGE) — update `templates/config.reference.yaml` and/or the README CLI Reference. CI (`lint:config-reference`, `lint:cli-readme`) will flag drift.
- Data-shape changes or format-compat serializers — add a round-trip fidelity test (serialize → deserialize → compare key fields) so silent field omissions show up early.

Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

{{#IF PROPOSAL_PATH}}
Before signaling done, re-read `{{PROPOSAL_PATH}}` and walk through each acceptance criterion, stating explicitly (in your thinking) how the implementation satisfies it. Write the status file only once every criterion is met.
{{/IF}}

If the task is already resolved on the base branch (fix already merged, no meaningful changes needed), don't make empty commits — signal bail-out instead:

```sh
printf 'bail-out|%s|<describe why task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

Use bail-out only when there's genuinely nothing to do. Partially-done tasks still finish normally.

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
