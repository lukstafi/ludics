# Pair Plan Merge (Coder)

Both you and the reviewer have written independent plans for `{{FEATURE}}`. Your task is to produce a single merged plan that takes the best ideas from each.

**Your plan** is at `{{PLAN_FILE}}` — read it now.

**Reviewer's independent plan**:

{{PEER_PLAN}}

**Reviewer's feedback on the previous merged plan** (if any — "(no review yet)" means this is the first merge iteration):

{{PEER_REVIEW}}

Read the two plans and any reviewer feedback above, then write a merged plan to `{{MERGED_PLAN_FILE}}`. The merged plan should:
- Select the strongest approach from each plan, resolving any conflicts
- Incorporate reviewer feedback if this is a revision
- Remain concrete: list files to modify, describe each change, and include validation steps

Then write:

```sh
printf '%s|%s|merged plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
