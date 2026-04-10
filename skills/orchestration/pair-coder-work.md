# Pair Work (Coder)

{{PROPOSAL_INSTRUCTION}}

Implement the task in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Reviewer guidance from prior round:

{{PEER_REVIEW}}

Commit in small batches (4-6 files). Build, lint, and run targeted tests before signaling done.
When changing data shapes or writing format-compat serializers, write a round-trip fidelity test (serialize → deserialize → compare key fields) for each affected serializer. This catches silent field omissions and header-line assumption mismatches early.
Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

{{#IF PROPOSAL_PATH}}
**Before signaling done**: Re-open `{{PROPOSAL_PATH}}` and read each acceptance criterion.
For each criterion, state explicitly (in your thinking) how the implementation satisfies it.
Only after confirming every criterion is met should you write the status file below.
{{/IF}}

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
