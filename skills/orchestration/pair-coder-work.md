# Pair Work (Coder)

Implement the task in `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Reviewer guidance from prior round (empty in round 1 — this is expected):

{{PEER_REVIEW}}

Scope guidance:
- If the task involves many files, work in batches of 4–6 files per commit.
- Commit each batch before starting the next so the reviewer can give incremental feedback.
- Prefer smaller, well-tested commits over one large commit.

If you create a PR, write it to `{{PR_FILE}}`.
If `{{INTERRUPT_FILE}}` appears, stop and write `interrupted`.
If the task involves documentation or non-code deliverables, substitute "run tests" with "verify compilation/rendering of the output" and confirm the deliverable matches the spec format.

Before signaling done, run quick checks:
- Build: the project's primary build command (e.g., `make`, `dune build`, `npm run build`)
- Lint: the project's lint command if available
- Targeted tests: run only the tests related to changed files, not the full suite

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
