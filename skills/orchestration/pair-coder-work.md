# Pair Work (Coder)

{{PROPOSAL_INSTRUCTION}}

Implement the task in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Reviewer guidance from prior round:

{{PEER_REVIEW}}

Commit in small batches (4-6 files). **For each behavior change, include a regression test in the same batch.** Build, lint, and run targeted tests before signaling done.
**Before modifying any symbol**: Re-run a project-wide grep for that symbol (and its inline reimplementations — regex patterns, copy-pasted logic) to catch occurrences the plan may have missed. Handle any newly discovered occurrences immediately rather than deferring to a future round.
When changing data shapes or writing format-compat serializers, write a round-trip fidelity test (serialize → deserialize → compare key fields) for each affected serializer. This catches silent field omissions and header-line assumption mismatches early.
Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

{{#IF PROPOSAL_PATH}}
**Before signaling done**: Re-open `{{PROPOSAL_PATH}}` and read each acceptance criterion.
For each criterion, state explicitly (in your thinking) how the implementation satisfies it.
Only after confirming every criterion is met should you write the status file below.
{{/IF}}

If the task is already resolved on the base branch (fix already merged, 0 meaningful changes needed),
do NOT make empty commits. Instead, signal bail-out:

```sh
printf 'bail-out|%s|<describe why task is obsolete>\n' "$(date +%s)" > "{{STATUS_FILE}}"
```

Only use bail-out when genuinely nothing needs to be done. If the task is partially done, complete it normally.

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
