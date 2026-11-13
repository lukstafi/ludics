## Requests: anything beyond your standing reservations

A leg on another box not covered by your task section, a measurement (only for a timing-grade
claim or a run that needs the box to itself), a full suite, or any batch that can hold a slot past
about 20 minutes needs a request first. End your turn with a final message carrying the block(s)
below, back to back, nothing after the last (do not start the run):

    EXECUTION_REQUEST
    {"request_id":"@@WAVE@@-@@T@@-<host>-<k>","execution_host":"<box>","kind":"correctness|measurement",
     "requested_revision":"<full 40-hex pushed SHA (git rev-parse), or head-of:@@BR@@>",
     "checkout":"<absolute path on the execution host: for a leg, its --worktree>",
     "purpose":"<what the run is for, in one line>",
     "command":"<one bounded command>","log":"-"}
    END_EXECUTION_REQUEST

For a cross-box leg you may give `"runner":"<runner args>","clone":"<the box's checkout>"` in place
of `"command"`; `execution assign` wraps it into the `execution leg` form, with `--wait-window`
for correctness (ludics#869). Read `issue-wave/references/executions.md`, *A leg on another box*,
before writing a leg yourself: it runs from `@@HOST@@` as `~/.claude/skills/issue-wave/scripts/fleet-worker.sh
execution leg --request <id> --rev <sha> --checkout <the box's clone> --worktree <that
clone>-worktrees/@@WORKER@@ -- <command>` as a long run (*Blocking rule*). The far-side worktree is yours;
the far-side clone is served to every session there and stays clean on its main branch. Spell
far-side paths absolutely (an unquoted `~` expands to YOUR home). A measurement is timing only: the
build, the fixtures and a dry run go first under your standing reservation. A measurement on
`@@HOST@@` is `fleet-worker.sh execution hold --request <id> -- <runner>` as a long run;
on another box an `execution leg` with `--deadline <s>` only (no `--cpu/--gpu/--wait/--wait-window`).
You will be resumed with one of:

- `EXECUTION_ASSIGNED <request_id>` with the exact command and revision: run only that, at that
  revision (after a rebase, end your turn with `EXECUTION_REBIND <id> <new pushed sha>` first),
  and as soon as it ends, before any other work, end your turn with one line:
  `EXECUTION_RESULT {"request_id":"<id>","run":"<run dir>","exit":<n>,"observed_sha":"<40-hex sha that ran>"}`.
  An unreported finished run holds the box's reservation and blocks a sibling.
- `EXECUTION_REFUSED <reason>` (sometimes with an offer of another box): keep implementing, or send
  a new request built for the offered box.
- `EXECUTION_PENDING <request_id> <...>`: answer with the one line `PENDING <request_id>` and end
  your turn, starting nothing.
- `EXECUTION_DEFERRED <request_id> <reason>`: hand back early: commit and push what has passed its
  tests, stop a review watch or merge wait you left running (`bg-run.sh stop <dir>`), and end with a status
  block: head SHA, PR, the pending request verbatim, what its result decides, and the step after
  it. You will not be resumed after that.
