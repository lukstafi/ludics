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
  out review-round logs, run-by-run narration, and paths beyond those lines. The only other
  sections are the two *Landing* asks for: "Local Codex review" and, when you merge on substance,
  the review-record paragraph.

## Running tests

These are your own batches. For an ASSIGNED command, use the run-record rule beside
`EXECUTION_RESULT` in *Requests*: its `run` names the command's record directory.

Run each batch from your worktree through its execution host's run-time slot, in the spelling
the project section gives. Keep the command in a local managed `exec_command` session, with its
whole output recorded outside the worktree:

    cd "@@WT@@" && ~/.claude/skills/issue-wave/scripts/fleet-worker.sh execution slot --cpu --wait 1800 --wait-window -- <batch> > "@@SCR@@/runs/<label>.log" 2>&1

Use `--cpu` before `--` for a batch that holds no GPU; drop it for one that does. `--wait 1800`
waits for a shared slot, and `--wait-window` waits out a coordinator's measurement window.
The command after `--` is exec'd, so a shell builtin goes as `sh -c '...'`.
Never pipe a suite: that would report the last stage's status. Join dependent steps with `&&`
or use a script with `set -eo pipefail` that pipes nothing.

If `exec_command` returns a session ID, retain it and observe that session with `write_stdin`
until it reports the command's terminal exit status. Keep your turn open during slot and window
waits too. Read the log afterwards with `tail` or `rg`. `EXECUTION SLOT REFUSED` means the batch
never ran, not that its tests failed. A handle, a log path or elapsed time proves no result.

A commit gated on a batch is made only after that batch's own exit 0, with no intervening edit.
When running the batch and commit in one shell command, join them with `&&`, never `;`: a
semicolon would commit even after a failed batch.
Your standing reservation `@@WAVE@@-@@T@@-@@HOST@@-iterate` (kind correctness, execution host
`@@HOST@@`, checkout your worktree) covers targeted batches. Report each batch's command, log,
wall time and exit status. For work beyond that reservation, message the coordinator using the
request block below and wait for assignment before starting it; report the result immediately
by message, then wait for further dispatch.
