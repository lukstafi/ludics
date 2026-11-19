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

Use the full commit SHA for a head whose branch has not been pushed. The commit itself must
already be visible to GitHub. Use `head-of:@@BR@@` only once that branch exists on GitHub.

For a native Windows witness on a dual-boot box, use this separate block instead of an
`EXECUTION_REQUEST` for a `-win` host. End the turn; the driver hands it to coordinator
attention immediately, without assignment retries. The coordinator owns the Linux-side
measurement reservation, boot and recovery (see *Bounded native Windows verification* in
`issue-wave/references/executions.md`). Supply the pushed revision, the absolute local script
path for the coordinator to review, and the cap. The site supplies the Windows paths.

    WINDOWS_WITNESS_REQUEST
    {"request_id":"@@WAVE@@-@@T@@-windows-<k>","linux_host":"<dual-boot Linux fleet name>",
     "windows_host":"<native Windows ssh alias>","requested_revision":"<full pushed 40-hex SHA>",
     "script":"<absolute local script path>","cap_seconds":120,"purpose":"<Windows witness needed>"}
    END_WINDOWS_WITNESS_REQUEST

Do not combine this block with other handoff markers. Wait for the coordinator's result or
repair instructions; an attention handoff is not authorization to run or retry the witness.

For a cross-box leg you may give `"runner":"<runner-executable> <runner-args>","clone":"<the box's checkout>"`
in place of `"command"`. Give the executable and arguments as an array or one line of shell words.
Use the full `"command"` for shell syntax such as redirection. `execution assign` wraps it into the leg form,
with `--wait-window` for correctness. To specify leg options such as `--cpu` or `--gpu`, give the
full leg in `"command"`, putting leg options before `--`. The full command form also lets you pass
a runner's own `--cpu` or `--gpu` argument after `--`. Keep `"checkout"` for the worktree and put
the clone path in the leg's `--checkout` (ludics#869, #1245).
Read `issue-wave/references/executions.md`, *A leg on another box*,
before writing a leg yourself: it runs from `@@HOST@@` as `~/.claude/skills/issue-wave/scripts/fleet-worker.sh
execution leg --request <id> --rev <sha> --checkout <the box's clone> --worktree <that
clone>-worktrees/@@WORKER@@ -- <command>` as a long run (*Blocking rule*). The far-side worktree is yours;
the far-side clone is served to every session there and stays clean on its main branch. Spell
far-side paths absolutely (an unquoted `~` expands to YOUR home). A measurement is timing only: the
build, the fixtures and a dry run go first under your standing reservation. A measurement on
`@@HOST@@` is `fleet-worker.sh execution hold --request <id> -- <runner>` as a long run;
on another box an `execution leg` with `--deadline <s>` only (no `--cpu/--gpu/--wait/--wait-window`).
An assigned correctness command on `@@HOST@@` runs as
`fleet-worker.sh execution slot --wait-window --cpu -- <command>` (use `--gpu` for a GPU batch).
A command already wrapped as `execution leg` runs as written: the leg selects slot or hold from
its record's kind. Follow the assignment's form; `execution hold --request` refuses correctness.

### Multi-command legs with `--file`

For several commands, put them in a local script under your scratch directory, starting with
`set -eu`. Request the complete leg as `"command"` (rather than the `"runner"` / `"clone"`
shorthand, which does not carry leg options). For example, use this command in the request:

```sh
~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution leg \
  --request <id> --rev <sha> --checkout <the box's clone> \
  --worktree <that clone>-worktrees/@@WORKER@@ --wait-window \
  --file <absolute local script path> -- env <backend-variable>=<backend> /bin/bash '{file}'
```

This example assumes the project supplies an environment pin (`pin-env`).
Replace `<backend-variable>` and `<backend>` with that pin from the project part (and quote
paths as needed). The pin must be a leading argv word after `env`; putting it inside a `sh -c`
or `bash -ec` string hides it from the guard. `--file` ships the local file to the execution box;
each runner word exactly equal to `{file}` becomes the shipped copy's absolute path. A word
merely containing `{file}` is not replaced. `--file` and the `{file}` word must occur together.
The copy lives outside the worktree and is removed when the leg ends. For a measurement, omit
`--wait-window` and use only `--deadline <s>` as described above. This is a request example;
wait for assignment before running it.

You will be resumed with one of:

- `EXECUTION_ASSIGNED <request_id>` with the exact command and revision: run only that, at that
  revision (after a rebase, end your turn with `EXECUTION_REBIND <id> <new pushed sha>` first).
  Every assigned command needs its own run record: use the *Blocking rule*'s `bg-run.sh new` /
  `start` recipe (native Claude: `spawn` / `wait`), wrapping the entire assigned command, including
  its slot, hold or leg wrapper; its `log` retains a direct shell leg's transcript. A bg-run
  conclusion also reads the last runner sentinel in that log: a harness with intentionally red
  nested tests needs its own final `harness: exit: <status>` line as well as its returned status.
  The coordinator must include that in the assigned harness; wrapping alone does not override
  nested failure sentinels. Automatic authoritative harness receipts remain a follow-up.
  Alternatively, when the assigned command itself is the project's test runner, name the record
  returned by `tools/test-run.sh paths run last`. `run` below is that record's absolute directory,
  never the `runs/` parent, a plain log directory or a nested run with a different verdict.
  As soon as it ends, before any other work, end your turn with one line:
  `EXECUTION_RESULT {"request_id":"<id>","run":"<run dir>","exit":<n>,"observed_sha":"<40-hex sha that ran>"}`.
  An unreported finished run holds the box's reservation and blocks a sibling.
- `EXECUTION_REFUSED <reason>` (sometimes with an offer of another box): keep implementing, or send
  a new request built for the offered box.
- `EXECUTION_PENDING <request_id> <...>`: answer with the one line `PENDING <request_id>` and end
  your turn, starting nothing.
- `EXECUTION_DEFERRED <request_id> <reason>`: hand back early: commit and push what has passed its
  tests, stop a review watch or merge wait you left running (`bg-run.sh stop <dir>` for a spawned
  record; interrupt the running task for a foreground `bg-run.sh start` record), and end with a status
  block: head SHA, PR, the pending request verbatim, what its result decides, and the step after
  it. You will not be resumed after that.
