# Work

{{#IF PROPOSAL_PATH}}
**Step 0**: Read the proposal file at `{{PROPOSAL_PATH}}` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.
{{/IF}}

Implement the task in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Prior review feedback:

{{PEER_REVIEW}}

Commit in small batches (4-6 files). Build, lint, and run targeted tests before signaling done.
Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

```sh
printf '%s|%s|implementation complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
