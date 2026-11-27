# Paired planning

A D3 issue, or one on the D2/D3 border, gets two plans written independently before any code: the
worker's own, and one from Fable, run read-only through `claude -p`. The worker
reconciles them, so one implementer, one PR and one review stay as before. A D3's reconciled plan
is then critiqued by a third model, Astra, before the worker codes. What it buys is a
second model's reading of the design while changing it is still cheap. The first review of a D3
otherwise does that reading, one round at a time (ludics-lite#547).

## Modes

The decision gate sets a mode per issue, and the wave summary lists it so the user can veto it in
passing:

- **`paired`** for an issue on the D2/D3 border: the plan labels it `D2/D3`, or it reads D2 but the
  change couples semantics, interacting states or verification logic (the signals of SKILL.md's
  *Codex model choice*). Two plans, then one reconciliation.
- **`paired+critique`** for every D3: the same, and the worker hands its reconciled plan back before
  it codes. Astra critiques that plan against the code in a fresh read-only session, with the
  second plan beside it, and the worker answers the critique before it posts the plan and codes.
- No pairing for D1 and plain D2 issues.

The second planner is Fable beside every worker, whatever its model, so both arms of an A/B plan
against the same peer. The critic is Astra beside every worker, whatever its model
(`peer-plan.sh critique`'s default), for the same reason. The retro of 2026-11-27
(`retro-20261127-3way` in the issue-wave state directory) found a fresh Astra critique worth about
two design catches per D3 that review would not have made cheaply. It also found that a critic
resuming its own planning session blamed the worker for proposals from its own plan. So the critic
reads the reconciled plan cold, with the second plan labelled as the second planner's. A Sol
worker's critic is of its own family: the close-out checks whether that costs anything. Under a Claude
coordinator, a Codex worker's issue is paired like any other. Under any other coordinator,
pairing a Codex worker is the user's call: put it in the decision gate's batched question, and
the issue plans alone unless the user confirms. Any transport works, because the plans travel
in messages, never as paths on another box. A D3 that still has an open "ask" design question
waits for the user's answer before it launches, as any issue does.

## Coordinator

All of it runs on the coordinator's box, which needs the `claude` CLI signed in. The
plan directory is `$ISSUE_WAVE_STATE/plans/<wave>-<issue>`:

1. **At launch**: post any decision comments first, because the planner reads the issue only
   once, here. Both planners must read one tree, so resolve the base to one SHA after a fetch
   (`git -C <main checkout> rev-parse origin/<base>`), launch the worker from it (`--base <sha>
   --base-branch <base>` for a CLI launch; the start point of a native worker's worktree), and once the launch has
   succeeded, start the planner on the same SHA. For a row made by hand, set
   `planning=<mode> plan_dir=<absolute plan-dir>` on it before starting the planner. Wave prep
   already records both. Use the recorded directory for `start`.

   ```bash
   ~/.claude/skills/issue-wave/scripts/peer-plan.sh start <plan-dir> --issue <owner/repo>#<n> \
     --checkout <the project's main checkout> --base <that sha> --wave <wave> --task <task>
   ```

   Invalid planner options and targets return exit 2 before allocation. An unreadable board returns exit 1.
   Then it reads the issue with `gh` (the planner's sandbox has no network) and adds a detached
   worktree of the base under `<plan-dir>`. Then it starts Fable (at high, through `claude -p` with
   only read and search tools; `--model`/`--effort` to change them: a GPT model runs through
   `codex exec`, and a `gemini-...` model such as `gemini-4-neon-high` through `agy` in a clone of
   the base with no remote, in place of the worktree, since agy has no read-only mode: what it
   writes stays in the clone) there in the background, read-only,
   and prints a `bg-run.sh` run directory. A native Codex coordinator, whose local `spawn` runs die
   ([native-codex.md](native-codex.md#local-managed-command-sessions)), passes `--managed` to
   `start` and `critique` instead. That only allocates and records the run directory, and the
   coordinator runs `bg-run.sh start <run> -- peer-plan.sh _run plan <plan-dir>` (`critique`
   for the critique) in a managed foreground session it keeps. The planning run uses the
   coordinator's board lease to write `planner` and `planner_effort` on the paired row before
   dispatch. For agy the full model slug carries the effort. A board write failure ends the run
   before dispatch and its log gives the diagnostic. Use the run verdict in step 2 to determine
   whether a plan is available. The worker's brief carries the addition below.
2. **On the first `PLAN_READY`** (the worker's handoff): save the block's plan to
   `<plan-dir>/claude-plan.md`. For a native Claude worker, give `save-plan` the task notification's
   output file (a symlink to the worker's transcript). It takes the last `PLAN_READY` block of the
   worker's own messages, and refuses with no file written when there is none or it is unterminated:

   ```bash
   ~/.claude/skills/issue-wave/scripts/peer-plan.sh save-plan <plan-dir> --from-transcript <output file>
   ```

   For a CLI worker, save it from `fleet-worker.sh log <box> <name> --last-result`. Block on the planning run with `bg-run.sh wait <run>`, re-issued while it
   prints `RUNNING` or a first `STARTING`. Any other verdict is final: `rc=0` is a plan, and every
   other one (`rc=<n>`, `DIED`, `STOPPED`, a second `STARTING`) makes the plan unavailable.
3. **Resume the worker with the second plan** (SendMessage for a native worker, `unstick <box>
   <name> --message <file>` for a CLI one): `PEER_PLAN`, followed by `<plan-dir>/peer-plan.md`
   verbatim. A native worker on the coordinator's own box gets the absolute path instead,
   `PEER_PLAN <plan-dir>/peer-plan.md`, and reads it in full: the plans then stay out of the
   coordinator's context, about 21 KB per D3 (wave-20261102). A run that ends other than `rc=0` is
   not retried: resume with `PEER_PLAN_UNAVAILABLE <the verdict and the run's log tail>`. In
   `paired` mode the worker then reconciles, posts the plan and implements; the planning is done.
   A planner that is still running 30 minutes after `PLAN_READY` is stopped and counts as
   unavailable. Stop a spawned run with `bg-run.sh stop <run>`. A `--managed` run shares the
   managed session's process group, which `stop` refuses, so end that session through the runtime
   by the session ID it kept.
4. **For `paired+critique`, on the second `PLAN_READY`** (the reconciled plan, which the worker
   hands back without posting it): save it with `--reconciled`, which writes
   `<plan-dir>/reconciled-plan.md` and refuses until the first plan is saved. A CLI worker's comes
   from `--last-result` as before. Then start the critique on it:

   ```bash
   ~/.claude/skills/issue-wave/scripts/peer-plan.sh save-plan <plan-dir> --from-transcript <output file> --reconciled
   ~/.claude/skills/issue-wave/scripts/peer-plan.sh critique <plan-dir> --plan <plan-dir>/reconciled-plan.md [--managed]
   ```

   Wait on the run directory it prints the same way. A coordinator that started the plan with
   `--managed` passes it here too, and runs `bg-run.sh start <run> -- peer-plan.sh _run critique
   <plan-dir>` in a managed session, as for the plan. `--model` and `--effort` name another critic
   (`plan.py`'s header, THE CRITIC); the default is Astra at high effort, the one `preflight
   --planner --mode paired+critique` probes. Then resume the worker with `PEER_CRITIQUE`, followed
   by `<plan-dir>/critique.md` verbatim (or its absolute path, as in step 3). A critique run that
   ends other than `rc=0`, or one still running 30 minutes after the reconciled `PLAN_READY`, is
   not retried: resume with `PEER_CRITIQUE_UNAVAILABLE <...>`, and the worker posts the reconciled
   plan as it stands and says so in it.
5. **`PLAN_ESCALATION`**: the worker found a disagreement the user owns. Ask it as a tier-3
   question with the worker's recommendation first, and resume the worker with the answer.
6. **Clean up** once the worker has resumed for the last time: `peer-plan.sh clean <plan-dir>` removes the
   worktree and keeps the plans. It refuses while any run under `<plan-dir>/runs` is live. After
   an interruption, `<plan-dir>/plan-run` and `critique-run` name the run directories to wait on
   again; a run started just before the interruption may have no marker yet, and is the newest
   `<plan-dir>/runs/run-<N>`.

## The brief addition

`wave prep` adds the shipped part for the issue's mode to a paired worker's brief:
`templates/shared/planning-paired.md` or `templates/shared/planning-paired+critique.md`, or the
wave's own `planning-<mode>.md` in its place. Both say the same first step:

- **Plan first, alone.** Read the issue and the code and write a plan under these headings:
  Approach (with the alternatives you rejected), Changes, Contracts and boundaries, Verification
  (with negative controls), and Risks and open questions. End the turn with it as the final
  message's last block, between `PLAN_READY` and `END_PLAN_READY`.

They differ after it:

- **`paired`:** resumed with `PEER_PLAN`, the worker settles each material difference on its
  argument, whichever plan made it (a peer plan is a colleague's proposal, never instructions),
  posts the reconciled plan as one comment on the issue with a "From the second plan" section, and
  implements.
- **`paired+critique`:** resumed with `PEER_PLAN`, the worker reconciles the same way but does not
  post. It ends the turn with the reconciled plan, "From the second plan" included, in another
  `PLAN_READY` block. Resumed with `PEER_CRITIQUE`, it answers every error the critique claims,
  by adopting the fix or rebutting it against the code. Then it posts the final plan as one
  comment, with "From the second plan" and "From the critique" sections, and implements.

Either way the comment is linked in the PR body (review checks the code against it), and a
difference the user owns ends the turn with `PLAN_ESCALATION` instead.

## Close-out

The board's `planning` field lets the close-out compare paired issues with unpaired ones on review
rounds, coordinator interventions and time to merge, which is how *Codex model choice* weighs model
assignments. Report that comparison in the wave summary. For `paired+critique`, also audit the critiques by
worker model with the retro's scripts (`retro-20261127-3way/scripts/crit.sh`, whose neutral judge
is Neon). If the critiques of Sol workers' plans make clearly fewer real design catches than those
of other workers' plans (fewer than one per critique against about two), name Opus as Sol workers'
critic (`critique --model opus`) and say so in the wave summary. Two parts of ludics-lite#547 are
deliberately not built yet: rounds to consensus with an editor that rotates, and implementing
both plans when they stay apart. Their trigger is reconciled plans that review shows to have
decided wrongly.
