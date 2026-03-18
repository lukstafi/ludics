# Work

Implement the task in `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Peer review from prior round (empty in round 1 — this is expected):

{{PEER_REVIEW}}

Scope guidance:
- If the task involves many files, work in batches of 4–6 files per commit.
- Commit each batch before starting the next so the reviewer can give incremental feedback.
- Prefer smaller, well-tested commits over one large commit.

Rules:
- Stay inside `{{WORKTREE_PATH}}`.
- If `{{INTERRUPT_FILE}}` appears, stop promptly and write `interrupted`.
- If you open a PR, write its URL to `{{PR_FILE}}`.
- If the task involves documentation or non-code deliverables, substitute "run tests" with "verify compilation/rendering of the output" and confirm the deliverable matches the spec format.

Before signaling done, run quick checks:
- Build: the project's primary build command (e.g., `make`, `dune build`, `npm run build`)
- Lint: the project's lint command if available
- Targeted tests: run only the tests related to changed files, not the full suite

When the round is done:

```sh
printf '%s|%s|implementation complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
