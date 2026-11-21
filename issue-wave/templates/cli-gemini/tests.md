## How the change reads

A reviewer reads your diff and PR body, not your session, so shape both for that reader.
- Do what the issue asks and stop there. A related defect you find goes into your hand-back as a
  proposed follow-up, not into this diff. Reorder, re-sort or reformat nothing the change does not
  need: a golden file churns with it.
- Reuse the project's predicates, helpers and types before adding a parallel table, flag or
  regex. Where the code offers structure (a parsed form, a typed value), match on it, not on
  words in text.
- A comment says why: the invariant, the reason, the case it guards. It does not say what the
  next line does, the procedure you ran, or a date. State a caveat once, where it binds.
- PR body: open with the outcome and your decisions in a few sentences. Then give the evidence
  *Landing* asks for as one line per batch (command, exit status, run directory, leg box). Leave
  out review-round logs, run-by-run narration, and paths beyond those lines. Add only the sections
  something asks for: *Landing* ("Local Codex review", the review-record paragraph when you merge
  on substance) or your task section (a scanner's "Recognised forms (closed)", say).

## Running tests

These are your own batches. For an ASSIGNED command, use the run-record rule beside
`EXECUTION_RESULT` in *Requests*: its `run` names the command's record directory.

Run every batch through the box's run-time slot lock, one batch per run, from the worktree, in the
spelling the project section gives, in the foreground of your turn, with its whole output going to
a log you read afterwards:

    cd "@@WT@@" && ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot --cpu --wait 1800 --wait-window -- <batch> > "@@SCR@@/runs/<label>.log" 2>&1; echo "exit=$?"
    tail -n 30 "@@SCR@@/runs/<label>.log"

`--cpu` goes before the `--` for a batch that holds no GPU; drop it for one that does.
`--wait 1800`: several workers share the box's slots, so wait for one instead of failing.
`--wait-window` waits out a coordinator's measurement window on the box inside the batch. The
command after `--` is exec'd, so a shell builtin goes as `sh -c '...'`. The `exit=` line is the
batch's own status. **Never pipe a suite**, inside that `sh -c` or anywhere: the status is then the
pipe's last stage, and a failed suite reads green (ludics#989). Steps that belong together go
joined with `&&`, as a script under `set -eo pipefail` that pipes nothing, or as one batch each. A
slot refusal prints `EXECUTION SLOT REFUSED` in the log: that batch never ran, and it is not a
test failure.

Keep every command in the foreground until it exits. If your shell tool hands you back a running
session instead of an exit status, keep polling that session until it reports the exit. A
measurement window on your box is not a reason to end your turn: `--wait-window` waits inside the
batch until the window closes, then runs it, so keep polling and do not cancel it.

A commit gated on a batch (the project section names any such gate) is made only after that
batch's own `exit=0`, with no edit in between, and never chained after the batch with `;`.

Your standing reservation `@@WAVE@@-@@T@@-@@HOST@@-iterate` (kind correctness, execution host
`@@HOST@@`, checkout your worktree) covers these targeted batches, with no per-batch request.
Report each batch by its log, with its command, wall time and exit status, in your messages.
