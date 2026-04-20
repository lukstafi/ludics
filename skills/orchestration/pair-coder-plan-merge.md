# Pair Plan Merge (Coder)

{{PROPOSAL_INSTRUCTION}}

## Code-Proposal Alignment Check

Before merging, spot-check the proposal's code assumptions against the actual codebase in this worktree (grep, search, or type-check). In particular:

- APIs/functions mentioned in the proposal exist.
- Function/module signatures match what the proposal expects.
- Data structures (types, interfaces) exist as assumed.
- File paths in the proposal point to real files.
- Dependencies mentioned are available.
- Code the proposal assumes from prior phases is present.

If something is off, note it in the merged plan as
`⚠️ ASSUMPTION GAP: proposal assumes X but codebase has Y. Recommend <remediation>.`

Minor gaps (e.g., a renamed method with identical behavior) — document and proceed. Substantial gaps (a missing API or module that would cause rework) — reassign to the reviewer with REQUEST_CHANGES.

Now merge the two independent plans for `{{TASK_ID}}` into one at `{{MERGED_PLAN_FILE}}`.

**Your plan**: `{{PLAN_FILE}}`

**Reviewer's plan**:

{{PEER_PLAN}}

**Reviewer's feedback on previous merge** (if any):

{{PEER_REVIEW}}

Use numbered lists for structured data; avoid wide tables (they get truncated between agents). Pick the strongest approach from each plan, fold in feedback, keep it concrete.

```sh
printf '%s|%s|merged plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
