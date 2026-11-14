# lib/ludics: the v2 rewrite's Python package

The core scripts are being ported to type-checked, standard-library-only Python 3.12, one script
(and for `pr-review.sh`, one subcommand) at a time, behind the command lines the skills already
call ([ludics-lite#403](https://github.com/lukstafi/ludics/issues/403)). This file is for
porters: where code goes, how a subcommand is forwarded, and how to check it.

## The rules that do not bend

- **Standard library only.** No third-party imports, no `requirements.txt`, no build step.
- **Python 3.12 is the floor.** Nothing from 3.13 or later. `pyrightconfig.json` pins
  `pythonVersion` to 3.12, so pyright refuses a newer API even when the local interpreter has it
  (this Mac's is 3.14).
- **Strict pyright**, `reportMatchNotExhaustive` on. A sum type is a union of frozen dataclasses,
  matched with `match`, and every match over a union ends in `case _: assert_never(x)`. See
  `GhResult` in `prreview/core.py` and the match in `prreview/body.py`. Pyright checks only the
  `sys.platform` branch of the platform it evaluates (by default the host's), so the tree passes
  it as Linux and as Darwin. CI's runner is Linux, and its second step adds `--pythonplatform
  Darwin`, so a darwin branch such as `fleetworker/group.py`'s kqueue wait is checked too. Windows
  is not checked: the package is POSIX-only (`fcntl.flock`, `os.fork`, `os.killpg`, `SIGALRM`).
- **The command line is fixed.** Subcommands, flags, stdout lines, stderr wording that a suite
  or a skill reads, and exit codes stay exactly what the script did. The shell suites are the
  conformance suite: a port lands only when the script's existing suites pass unchanged against
  it, under `bash` 5 and `/bin/bash` 3.2. Once a script has no shell left, its suite ports to a
  `unittest` module here that still runs the entry point as a subprocess, case for case, in its
  own PR: `check-prompts.sh`'s first, as `tests/test_checkprompts_cli.py`.
- **External tools are binaries.** `gh` and `git` run through `ludics.proc.run_tool`, resolved
  on PATH, never replaced by an HTTP client, so the suites' fixtures drive the Python as they
  drove the shell.

## Layout

```
scripts/py                       the interpreter wrapper: the first Python >= 3.12, run as
                                 `-X utf8 -P` with PYTHONPATH=lib and PYTHONCOERCECLOCALE=0,
                                 the caller's own values noted in LUDICS_CALLER_PYTHONPATH and
                                 LUDICS_CALLER_PYTHONCOERCECLOCALE (scripts/test-py.sh)
lib/ludics/cli.py                shared by every entry point: Exit, main (the caller's
                                 PYTHONPATH and PYTHONCOERCECLOCALE back, then main_guard),
                                 main_guard (an Exit's message
                                 and status; a closed stdout ends the command by SIGPIPE, 141, as
                                 it ended the shell's printf), say/emit/note
lib/ludics/proc.py               run_tool, the shell bridge, and Git Bash's PATH lookup and quoting
lib/ludics/bgrun.py              bg-run.sh wait's verdict line: parse, its one reader
lib/ludics/prreview/core.py      pr-review.sh's prelude: fail/die/warn, Config, GhSession
                                 (gh_retry and its classification), parse_ref/pr_arg,
                                 checkout_pr, repo_from_cwd, api_list, mark_of
lib/ludics/prreview/<name>.py    one module per ported subcommand: run(session, args) -> int
lib/ludics/prreview/__main__.py  the dispatcher: `scripts/py -m ludics.prreview <name> ...`
lib/ludics/<script>/             the next script's package (e.g. checkprompts/, fleetworker/),
                                 with its own __main__.py
lib/ludics/tests/test_*.py       unittest suites (fake.py: a fake tool first on PATH, answering by
                                 call order or by argv routes)
```

The helpers more than one `pr-review.sh` subcommand reads are ported once, in a module of their own:

```
prreview/jqsem.py          jq's value semantics, order and regex dialect, for every ported jq program
prreview/shtext.py         the shell's readings of text (`IFS=$'\t' read`, `${x#*$'\n'}`), encode_ref
prreview/clock.py          the clock (SHIP_PR_TEST_CLOCK), the bridged sleep, newest/age_of/freshest_age/fmt_age
prreview/budget.py         the polling budget (ludics-lite#543): the pause, the quota hold and its probe,
                           the observer locks, and the state directory every version on a host shares
prreview/knobs.py          the source-time constants beyond the core's, one forward name each
prreview/feeds.py          the feeds, the round snapshot, pr_head_read, substantive_reviews
prreview/state.py          status_state, status_line, approval_gate, gated_state, review_rounds
prreview/poll.py           cmd_poll (poll, and every watch round)
prreview/threads.py        the review-threads walk and the open-thread gate (resolve, status, merge)
prreview/branchtip.py      whether a PR's head is its branch's tip (status, watch, merge; #960)
prreview/drift.py          warn_base_drift (merge, watch), and read_base_drift's Drift for the merge build
prreview/commentonly.py    whether a change is to comments only (the merge build's comments lines, #861)
prreview/mergebuild.py     merge's build of the would-be merge commit (.github/ship-pr-merge-build, #611)
prreview/mergedry.py       merge-build, that build alone as a dry run for two revisions (#751)
prreview/buildhistory.py   what a repository's merge build has taken on this box, for an overrun's advice (#982)
prreview/localreview.py    local-review, the local Codex review before a PR opens (#750)
prreview/rerun.py          rerun, the head's workflow runs, their jobs/log tails, a run's completion
                           wait, and the re-run of failed jobs inside the polling budget (#1111);
                           read_jobs is the shared paginated latest-attempt reader
prreview/checkruns.py      conclusion_class, newest_first
prreview/ere.py            the advisory list, asked of grep (is_advisory, ere_valid)
prreview/gate.py           gate_checks (checks, merge, and base's merged-head source)
prreview/runners.py        build jobs that never got a runner: NO RUNNER, NEVER STARTED (checks, merge;
                           merge.py's Recovery reruns once, #560/#728)
prreview/jobsteps.py       pending job step evidence for checks heartbeat prose only (#1112)
prreview/images.py         a red check's runner image against the base's last green run of it:
                           NEW IMAGE (checks, merge; #959)
prreview/workflows.py      the workflow-file reads and the paths-ignore walk (checks/merge, base)
prreview/workflow_yaml.py  the narrow workflow-YAML readers and the glob translation
```

`execution slot`'s holder record is a module of its own, so both of its readers import it:

```
fleetworker/slotrecord.py  THE HOLDER RECORD: Holder, record_holder, read_holder and its boundary
                           (slot.py's drain names a holder from it; holders.py's listing confirms it)
```

A script other than `pr-review.sh` gets a sibling package, `lib/ludics/<script>/`, run as
`scripts/py -m ludics.<script>`; its shell file becomes the one-line forward (`exec "$(dirname
"$0")/../../scripts/py" -m ludics.<script> "$@"`, with the right number of `..`).

## pr-review.sh: the command line in front of the package

Every `pr-review.sh` subcommand is served here, and the shell half is retired: `pr-review.sh` is
the usage text, the source-time knobs and their validation, and the forward (its implementation
before the retirement is `git show c66d06b:ship-pr/scripts/pr-review.sh`). What it still defines,
and why:

- the knobs (`GRACE`, `CHECKS_INTERVAL`, `BUDGET_DIR`, ...), resolved from the environment and
  validated once, so a bad value is refused before anything runs. `PY_FORWARD_VARS` hands each to
  the Python as `SHELLVAR=ENVNAME` (with `Config` or `knobs.py` reading `ENVNAME`), because a
  suite's `retune` and `main`'s `--repo` change the shell variable, not the environment. A
  constant whose being SET is itself meaningful (`SHIP_PR_ADVISORY_CHECKS`) has a private
  environment name for the forward;
- `main`, which execs `scripts/py -m ludics.prreview <subcommand>`, and `py_usage`, the one
  refusal it makes itself (bash's own `${1:?}` message for a reader with no PR);
- `py_forward`, `py_bridge_state` and `py_native_path`: the forward, and the bridge below;
- a `cmd_<name>` stub per subcommand (`py_forward call <name> "$@"`), for the fixture suites,
  which source the script and call the function;
- `fail`/`die`, for the refusals above, and `jq`/`jq_lf` with the line-ending probe
  (ludics-lite#335), which nothing in the script runs any more: they are for the scripts that
  source it and run jq themselves, the fixture suites and `pr-review-api-contract.sh`.

A new subcommand is a module `lib/ludics/prreview/<name>.py` with `run(session: GhSession, args:
list[str]) -> int` (the core: `session.retry`, `pr_arg`, `fail`/`die`, `cli.emit`; `fail(rc, ...)`
ends the command from any depth with `pr-review.sh: <message>` on stderr), its `case` and its
`PORTED` entry in `__main__.py`, its name in `main`'s case in `pr-review.sh` with a `cmd_<name>`
stub, and any new knob in `PY_FORWARD_VARS`. Run its suites under `bash` and `/bin/bash`, and the
hostile pass (`ship-pr/scripts/run-pr-review-hostile.sh`, which needs `en_US.UTF-8`).

### The shell bridge, and what it does not cover

The pr-review suites source the script and define `gh` as a shell **function**. When the
forwarder sees that `gh` or `git` is a function, it writes the shell's functions, variables and
`-u`/`pipefail` options to a file (`pr-review-bridge.<pid>.*` under TMPDIR, removed on return),
and the Python runs each such call as `<the same bash> -c '. <file>; gh "$@"'`. That is what the
shell's own `$(gh ...)` subshell saw, so a fixture that keeps its counters in files (they all do,
for that reason) behaves the same. In production nothing is a function and `gh` is the binary.

Not bridged: a suite's stub of the **clock** (`date`, SECONDS). The clock is an environment
interface instead, `SHIP_PR_TEST_CLOCK` (`prreview/clock.py`, shared by every port): a file holding
an epoch second that IS the clock -- every age and deadline is read from it -- and that a sleep
advances instead of waiting. A suite that exports it drives every subcommand's clock;
test-pr-review-watch.sh runs every case on it.

`sleep` IS bridged (with `gh` and `git`): a suite's `sleep` observes the wait -- the pauses it logs,
what it lets happen meanwhile (test-pr-review-budget.sh's SLEEP_HOOK) -- which only a call carries.
When the forwarding shell defines one, it is every sleep the Python takes, the test clock's
included, so a suite that defines one under SHIP_PR_TEST_CLOCK advances that clock in it.

## Helpers shared across subcommands

A port needs a helper another port already has: import it from the module above (or from
`core.py`), never port it a second time. During a wave of parallel ports, each porter ported what
its subcommand needed into its own module and marked it `# SHARED-CANDIDATE: <shell function>`;
the integration consolidated those into the modules above, one implementation each, and removed
the markers. Two remain, in `postmergecleanup/`, on purpose (`git grep SHARED-CANDIDATE` lists
them with their reasons): its `printf %q` (bash 5's rules, computed) beside `core.shell_quote`
(which asks the running bash), and its signal-safe process runner beside `proc.run_tool`.

## Wave prep host paths

For a lock shared by a wave's workers on one host, use prep's `SCR_PARENT`: the parent of that
worker's `SCR`, including `hosts.<box>.scratch` for a remote CLI worker. Launch creates the task
scratch directory and therefore its parent. `WAVE_DIR` belongs to the coordinator; prep refuses
that placeholder in parts rendered for a remote worker (the exact boundary is in waveprep.py's
header). The MixedWave unit cases cover both hosts and an agent-host `WAVE_DIR` control; on the
base they fail on the missing built-in and the accepted remote path (ludics#1134).

## Native Codex wave briefs

`wave prep` selects `templates/native-codex/` through the same transport/kind lookup as the
other shipped kinds. Its four own parts describe mid-turn coordinator messages and local
managed foreground command sessions, following `references/native-codex.md`. Shared handoff
blocks retain their format; the native worker sends them by message and waits for dispatch.
No planning parts ship for this kind: Codex-coordinated pairing requires explicit confirmation
and wave-local parts. The Prep regression renders without wave-local common parts; running it
against the pre-template base must refuse on missing who.md, rather than pass with placeholders.

## Stacked wave prep briefs

Prep reads a project's brief part at its task base first, then at the local
`origin/<vars.MAIN>` commit if absent. It reports the path, SHA and source; no fetch or checkout
read supplies a fallback. BASE_ORIGIN identifies the default tip only on a SHA match and otherwise
names the explicit revision, so a stacked launch keeps its own base (#1099).
The Prep unit cases and the "wave kit" shell section pin this boundary; the new cases fail
against the pre-change implementation (missing fallback, provenance and BASE_ORIGIN).

## Which suites drive each module

The unit tests (`lib/ludics/tests/test_*.py`) run whole, by discovery, before every push that
touches `lib/`. A suite that drives a module through its command line can also pin what the module
prints, and that suite is the one that goes red only in CI when nobody knew it drove the verb.
`issue-wave/scripts/test-fleet-execution.py` pinned `execution window`'s usage line, so adding
`[--no-gap]` went red there (ludics-lite#667). A new `execution` action broke the usage pin in
`test-fleet-worker.sh`'s "execution run and conclude --from-run" section, not in "usage" (#811). So
before a push, run the suites listed under each module the diff changes, slot-wrapped, under
`bash` and `/bin/bash`. Each suite line below is a command: the arguments on a
`test-fleet-worker.sh` line are its section selection, a `lib/ludics/tests/` path runs as `scripts/py
-m unittest ludics.tests.<name>`, and a glob stands for each suite it matches.

A line is the map author's reading of the module's call paths: the verbs it serves, and the modules
that import it. It may name more than strictly drives the module, and it cannot prove that no other
suite does. check-prompts (`checkprompts/suitemap.py`) pins the map's shape: each module has
exactly one line, and every suite, glob and section the line names exists. A new module needs its
line. A new section, a new suite, or a verb a suite starts to drive needs the lines it reaches.

A module word may name a PART of the module instead, `module.py:NAME`: a function, class or
plain-name assignment at its top level (check-prompts reads the names from the source). A part's
line is for a diff confined to the parts it names, their bodies and nothing else in the module:
such a diff runs the line of each part it changes. Any other change to the module (its imports, an
unnamed part, a statement between the parts) runs the module's own line, which every module keeps.
A part's line is the map author's reading of the verbs that part serves, as a module's line is.
`fleetworker/__main__.py:run_verb` is the verb table: a diff to one of its arms (a new verb, say)
also runs the line of the module that arm calls, which names the verb's own section.
`fleetworker/farside.py`'s own line is the whole of `test-fleet-worker.sh` on purpose: its
`HELPERS` is every far side's prelude (`transport.prelude`), and `FRESHNESS`, `REFRESH` and
`FLEET_PYTHON` reach the execution actions through `refresh_box` and the registry. A change to one
verb's script is one of its named parts.

For worker verbs and execution actions, `issue-wave/scripts/test-fleet-worker.sh
--sections-calling <verb> [action [--mode]]` lists sections containing recognised source
calls, including the suite's worker setup helpers. The closed lexical boundary is in
`fleetworker/suitecalls.py`'s header: this is evidence for the part lines, not proof of
Python call-path coverage. Execution parts also include indirect callers (`assign` uses
`window`, for example). Unnamed execution helpers and its dispatch table keep the module line.

A usage case matches the verb and its positional tail, not the option list between them (the rule
`test-fleet-worker.sh`'s usage cases follow), so a PR that adds an option does not edit the cases
of every suite that drives the verb.

```
cli.py proc.py
    issue-wave/scripts/test-fleet-worker.sh
    issue-wave/scripts/test-fleet-execution.py
    ship-pr/scripts/test-pr-review-*.sh
    ship-pr/scripts/test-post-merge-cleanup.sh
    lib/ludics/tests/test_checkprompts_cli.py
    lib/ludics/tests/test_peerplan.py
    scripts/test-py.sh

fs.py
    lib/ludics/tests/test_prreview_budget.py
    lib/ludics/tests/test_prreview_mergebuild.py
    lib/ludics/tests/test_peerplan.py

bgrun.py
    issue-wave/scripts/test-fleet-worker.sh "conclude --from-bg-run" tip-run board
    lib/ludics/tests/test_bgrun.py
    lib/ludics/tests/test_peerplan.py

checkprompts/__main__.py checkprompts/brieftemplate.py checkprompts/bytes_view.py checkprompts/cleanup.py
checkprompts/drift.py checkprompts/frontmatter.py checkprompts/links.py checkprompts/readwhen.py checkprompts/registers.py
checkprompts/roster.py checkprompts/slots.py checkprompts/suitemap.py checkprompts/tree.py
checkprompts/verdicts.py
    lib/ludics/tests/test_checkprompts_cli.py

fleetworker/__main__.py fleetworker/config.py fleetworker/identity.py fleetworker/transport.py
    issue-wave/scripts/test-fleet-worker.sh
    issue-wave/scripts/test-fleet-execution.py

fleetworker/__main__.py:VERBS fleetworker/__main__.py:run_verb
    issue-wave/scripts/test-fleet-worker.sh usage

fleetworker/farside.py
    issue-wave/scripts/test-fleet-worker.sh
    issue-wave/scripts/test-fleet-execution.py
    scripts/test-py.sh

fleetworker/farside.py:GHPROBE fleetworker/farside.py:ghprobe fleetworker/farside.py:PREFLIGHT
fleetworker/farside.py:LAUNCH_EXISTS fleetworker/farside.py:LAUNCH_FETCH fleetworker/farside.py:LAUNCH_WORKTREE
fleetworker/farside.py:LAUNCH_DROP_BRIEF fleetworker/farside.py:LAUNCH_PREPARE fleetworker/farside.py:LAUNCH_START
fleetworker/farside.py:LAUNCH fleetworker/farside.py:LAUNCH_NOT_STARTED fleetworker/farside.py:_REFUSE_EXIT
fleetworker/farside.py:_proven_refusals fleetworker/farside.py:LAUNCH_STANDING_WORKTREE
fleetworker/farside.py:LAUNCH_STANDING_START fleetworker/farside.py:VERDICT fleetworker/farside.py:ATTACH
fleetworker/farside.py:CLOSE
    issue-wave/scripts/test-fleet-worker.sh preflight "the real checkout" "base gate" "coordinator lease" halt "launch /" "failure verdicts" unstick "codex workers" usage

fleetworker/farside.py:STATUS
    issue-wave/scripts/test-fleet-worker.sh "launch /" "failure verdicts" unstick "codex workers" usage

fleetworker/farside.py:LOG fleetworker/farside.py:LOG_LAST_RESULT
    issue-wave/scripts/test-fleet-worker.sh "launch /" "codex workers" "log --last-result"

fleetworker/farside.py:UNSTICK
    issue-wave/scripts/test-fleet-worker.sh unstick "failure verdicts" "codex workers" usage

fleetworker/farside.py:LS
    issue-wave/scripts/test-fleet-worker.sh "launch /" "failure verdicts"

fleetworker/execution.py fleetworker/registry.py
    issue-wave/scripts/test-fleet-worker.sh execution "prs (" refresh "base gate" "launch /" "wave kit"
    issue-wave/scripts/test-fleet-execution.py

fleetworker/execution.py:from_run_payload
fleetworker/execution.py:conclude_from_run
    issue-wave/scripts/test-fleet-worker.sh "execution run and conclude --from-run"

fleetworker/execution.py:from_bg_run_payload
fleetworker/execution.py:conclude_from_bg_run
    issue-wave/scripts/test-fleet-worker.sh "execution conclude --from-bg-run" "execution tip-run" "execution revisions resolve" "execution leg"

fleetworker/execution.py:standing_handback_payload
fleetworker/execution.py:standing_handback
    issue-wave/scripts/test-fleet-worker.sh "execution conclude --standing-handback" "wave kit"

fleetworker/execution.py:window_gap
fleetworker/execution.py:window_deadline
fleetworker/execution.py:gap_wait
fleetworker/execution.py:window_payload
fleetworker/execution.py:with_gap
fleetworker/execution.py:window_lines
    issue-wave/scripts/test-fleet-worker.sh "execution run and conclude --from-run" "execution assign" "execution leg" "execution slot"
    issue-wave/scripts/test-fleet-execution.py

fleetworker/execution.py:checked_rebind
    issue-wave/scripts/test-fleet-worker.sh "execution revisions resolve"

fleetworker/execution.py:execution_refresh
fleetworker/execution.py:refresh_host
fleetworker/execution.py:with_resolution
    issue-wave/scripts/test-fleet-worker.sh "execution run and conclude --from-run" "execution conclude --from-bg-run" "execution tip-run" "execution revisions resolve" "execution assign" "execution conclude --standing-handback" "execution leg" refresh "execution slot" "wave kit" "launch /"
    issue-wave/scripts/test-fleet-execution.py

fleetworker/revision.py fleetworker/cotenants.py
    issue-wave/scripts/test-fleet-worker.sh execution refresh
    issue-wave/scripts/test-fleet-execution.py

fleetworker/lease.py
    issue-wave/scripts/test-fleet-worker.sh "coordinator lease" halt "base gate" "the real checkout" "launch /" board execution
    issue-wave/scripts/test-fleet-execution.py

fleetworker/preflight.py
    issue-wave/scripts/test-fleet-worker.sh preflight refresh "the real checkout" "launch /" execution
    issue-wave/scripts/test-fleet-execution.py

fleetworker/gate.py
    issue-wave/scripts/test-fleet-worker.sh "base gate" halt "execution run and conclude" "the real checkout" "coordinator lease" "launch /" "failure verdicts" unstick "codex workers" usage

fleetworker/workers.py
    issue-wave/scripts/test-fleet-worker.sh "the real checkout" "base gate" "coordinator lease" halt "launch /" "failure verdicts" unstick "codex workers" "log --last-result" "wave kit" usage

fleetworker/workers.py:cmd_launch
    issue-wave/scripts/test-fleet-worker.sh "the real checkout" "base gate" "coordinator lease" "launch /" "failure verdicts" unstick "codex workers" halt usage "wave kit"

fleetworker/workers.py:cmd_attach
fleetworker/workers.py:cmd_close
    issue-wave/scripts/test-fleet-worker.sh "base gate" "launch /" "failure verdicts" unstick "codex workers" halt "wave kit" usage

fleetworker/workers.py:cmd_status
    issue-wave/scripts/test-fleet-worker.sh "launch /" "failure verdicts" unstick "codex workers" usage "wave kit"

fleetworker/workers.py:cmd_log
    issue-wave/scripts/test-fleet-worker.sh "launch /" "codex workers" "log --last-result" "wave kit"

fleetworker/workers.py:cmd_unstick
    issue-wave/scripts/test-fleet-worker.sh "failure verdicts" unstick "codex workers" usage "wave kit"

fleetworker/workers.py:cmd_ls
    issue-wave/scripts/test-fleet-worker.sh "launch /" "failure verdicts"

fleetworker/suitecalls.py
    issue-wave/scripts/test-fleet-worker.sh "section call listing"
    lib/ludics/tests/test_fleetworker_suitecalls.py

fleetworker/supervision.py
    issue-wave/scripts/test-fleet-worker.sh load "prs (" sibling-scan

fleetworker/siblingscan.py
    issue-wave/scripts/test-fleet-worker.sh sibling-scan
    lib/ludics/tests/test_fleetworker_siblingscan.py

fleetworker/board.py fleetworker/boardstore.py fleetworker/takeover.py
    issue-wave/scripts/test-fleet-worker.sh board "execution assign" "wave kit"

fleetworker/closeout.py
    issue-wave/scripts/test-fleet-worker.sh "execution conclude --standing-handback" board
    lib/ludics/tests/test_fleetworker_closeout.py

fleetworker/slot.py fleetworker/holders.py fleetworker/group.py fleetworker/slotrecord.py
fleetworker/graces.py fleetworker/leg.py
    issue-wave/scripts/test-fleet-worker.sh "execution slot" "execution leg" tip-run

fleetworker/farsideclose.py
    issue-wave/scripts/test-fleet-worker.sh "execution leg"

fleetworker/tiprun.py
    issue-wave/scripts/test-fleet-worker.sh "launch /" tip-run

fleetworker/assign.py
    issue-wave/scripts/test-fleet-worker.sh "execution assign" board

fleetworker/wave.py fleetworker/wavebrief.py fleetworker/waveprep.py fleetworker/waveloop.py fleetworker/wavereview.py fleetworker/wavelaunch.py fleetworker/waveunprep.py fleetworker/wavedrive.py fleetworker/wavedecide.py
    issue-wave/scripts/test-fleet-worker.sh "wave kit"
    lib/ludics/tests/test_fleetworker_wave.py
    lib/ludics/tests/test_checkprompts_cli.py

peerplan/__main__.py peerplan/plan.py peerplan/transcript.py
    lib/ludics/tests/test_peerplan.py

postmergecleanup/__main__.py postmergecleanup/cleanup.py postmergecleanup/options.py
postmergecleanup/shellquote.py postmergecleanup/system.py postmergecleanup/transaction.py
    ship-pr/scripts/test-post-merge-cleanup.sh

prreview/__main__.py
    ship-pr/scripts/test-pr-review-*.sh
    scripts/test-py.sh

prreview/core.py prreview/jqsem.py
    ship-pr/scripts/test-pr-review-*.sh
    issue-wave/scripts/test-fleet-worker.sh load "prs (" sibling-scan

prreview/knobs.py prreview/shtext.py prreview/clock.py
    ship-pr/scripts/test-pr-review-*.sh

prreview/base.py
    ship-pr/scripts/test-pr-review-base-*.sh
    ship-pr/scripts/test-pr-review-api-contract.sh
    ship-pr/scripts/test-pr-review-budget.sh

prreview/budget.py
    ship-pr/scripts/test-pr-review-budget.sh
    ship-pr/scripts/test-pr-review-watch.sh
    ship-pr/scripts/test-pr-review-base-*.sh
    ship-pr/scripts/test-pr-review-checks-absent.sh
    ship-pr/scripts/test-pr-review-merge.sh
    ship-pr/scripts/test-pr-review-retry.sh

prreview/body.py prreview/space.py
    ship-pr/scripts/test-pr-review-reply.sh
    ship-pr/scripts/test-pr-review-retry.sh

prreview/comment.py
    ship-pr/scripts/test-pr-review-reply.sh
    ship-pr/scripts/test-pr-review-retry.sh
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-watch.sh
    ship-pr/scripts/test-pr-review-budget.sh

prreview/reply.py
    ship-pr/scripts/test-pr-review-reply.sh
    ship-pr/scripts/test-pr-review-retry.sh
    ship-pr/scripts/test-pr-review-lib.sh

prreview/resolve.py
    ship-pr/scripts/test-pr-review-reply.sh
    ship-pr/scripts/test-pr-review-retry.sh
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-merge.sh

prreview/retry.py prreview/runwatch.py
    ship-pr/scripts/test-pr-review-retry.sh
    ship-pr/scripts/test-pr-review-budget.sh
    ship-pr/scripts/test-pr-review-lib.sh

prreview/poll.py prreview/rounds.py
    ship-pr/scripts/test-pr-review-watch.sh
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-rounds.sh

prreview/feeds.py prreview/state.py prreview/threads.py
    ship-pr/scripts/test-pr-review-watch.sh
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-rounds.sh
    ship-pr/scripts/test-pr-review-retry.sh
    ship-pr/scripts/test-pr-review-reply.sh
    ship-pr/scripts/test-pr-review-merge.sh

prreview/branchtip.py
    ship-pr/scripts/test-pr-review-merge.sh
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-watch.sh
    ship-pr/scripts/test-pr-review-checks-absent.sh
    ship-pr/scripts/test-pr-review-budget.sh
    lib/ludics/tests/test_prreview_merge.py

prreview/status.py
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-retry.sh

prreview/watch.py
    ship-pr/scripts/test-pr-review-watch.sh
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-budget.sh
    ship-pr/scripts/test-pr-review-base-drift.sh

prreview/drift.py
    ship-pr/scripts/test-pr-review-base-drift.sh
    ship-pr/scripts/test-pr-review-merge.sh
    ship-pr/scripts/test-pr-review-status.sh
    ship-pr/scripts/test-pr-review-watch.sh

prreview/checks.py prreview/runners.py prreview/jobsteps.py
    ship-pr/scripts/test-pr-review-checks-absent.sh
    ship-pr/scripts/test-pr-review-merge.sh
    ship-pr/scripts/test-pr-review-budget.sh
    ship-pr/scripts/test-pr-review-lib.sh

prreview/merge.py prreview/closekw.py
    ship-pr/scripts/test-pr-review-merge.sh
    ship-pr/scripts/test-pr-review-base-drift.sh
    ship-pr/scripts/test-pr-review-checks-absent.sh
    ship-pr/scripts/test-pr-review-budget.sh
    ship-pr/scripts/test-pr-review-lib.sh

prreview/gate.py prreview/ere.py prreview/checkruns.py prreview/images.py
    ship-pr/scripts/test-pr-review-checks-absent.sh
    ship-pr/scripts/test-pr-review-merge.sh
    ship-pr/scripts/test-pr-review-base-*.sh
    ship-pr/scripts/test-pr-review-budget.sh
    ship-pr/scripts/test-pr-review-lib.sh
    ship-pr/scripts/test-pr-review-retry.sh

prreview/workflows.py prreview/workflow_yaml.py
    ship-pr/scripts/test-pr-review-base-*.sh
    ship-pr/scripts/test-pr-review-checks-absent.sh
    ship-pr/scripts/test-pr-review-merge.sh

prreview/mergebuild.py prreview/commentonly.py prreview/mergedry.py prreview/buildhistory.py
    ship-pr/scripts/test-pr-review-merge.sh
    lib/ludics/tests/test_prreview_mergebuild.py
    lib/ludics/tests/test_prreview_buildhistory.py
    lib/ludics/tests/test_prreview_commentonly.py

prreview/localreview.py
    lib/ludics/tests/test_prreview_localreview.py

prreview/rerun.py
    lib/ludics/tests/test_prreview_rerun.py
    ship-pr/scripts/test-pr-review-budget.sh
```

## Checking

Placement recovery (#1133): `wave launch` reads the worker's path from `LAUNCHED`, uses the
prepared host, and records it beside reserved legs. `execution assign` calls the board store's internal `placement`
operation under the lease lock, including for matching `ASSIGN ALREADY` records: a union keeps
one copy of each host/checkout across partial writes and retries. It matches the base's worker
to an existing row and creates neither rows nor boards. The manifest and row schema are unchanged;
`exec_hosts` stays comma-separated and `farside` uses the existing whitespace-separated words.
Unit cases in the wave, assign and board suites pin those paths and the recovery boundary.
The new launch/assignment regressions fail on c0f3b07f (four selected tests, ten subtest failures)
and pass with the fix; the mapped macOS sections passed 686 assertions. Local review identified
whitespace paths as unsafe cleanup words: both writers now reject those words before publication,
keeping valid placements and reporting reconciliation instead of publishing a path prefix.
The two whitespace regression cases fail against the pre-guard commit 4c0158d7 and pass with it.
Review round 1 also rejects repeated launch-line cwd/stream delimiters before publishing any
placement. Only LF separates launch output lines, so Unicode separators cannot forge a second
LAUNCHED line. A missing board-writer identity becomes an assignment NOTE rather than aborting the
remaining requests. Board mutations share one lease-protocol helper.

```sh
npx --yes pyright@1.1.414 --pythonplatform Linux                  # from the repo root
npx --yes pyright@1.1.414 --pythonplatform Darwin                 # (CI runs both)
scripts/py -m unittest discover -s lib -t lib -p 'test_*.py'     # the package's unit tests
scripts/test-py.sh                                                # the wrapper
ship-pr/scripts/test-pr-review-<suite>.sh                         # the conformance suites
scripts/py -m unittest ludics.tests.test_checkprompts_cli         # ...and the ported ones
```

CI runs pyright and the unit tests in the `python` job of `.github/workflows/skill-scripts.yml`,
and the shell suites where they always ran. A ported conformance suite runs where its shell suite
did as well, named as a module: `test_checkprompts_cli` in the small-guards job, whatever the diff,
and in macos-weekly.yml's repo-guards job. `scripts/fleet-peers.py` is not behind `scripts/py`
yet: its callers and its tests run it with `python3` and by path.

The execution registry (formerly `issue-wave/scripts/fleet-execution.py`) is
`lib/ludics/fleetworker/registry.py`, and it is SHIPPED: `fleet-worker.sh execution` sends its
source to the anchor box, where a Python >= 3.12 found by the far side's own probe runs it from
stdin. So it imports nothing from `ludics` (the anchor's checkout may hold another version) and its
positional argv is a contract, its JSON payload on file descriptor 3 rather than one argv word
(ludics-lite#636, `transport.shipped_python`); `issue-wave/scripts/test-fleet-execution.py` loads it with `runpy`
and patches `os.replace` between records. The wave board's store,
`lib/ludics/fleetworker/boardstore.py` (`fleet-worker.sh board`, ludics-lite#619), is the other
shipped module, under the same rules: self-contained, its argv a contract (its header).

Every other far side of `fleet-worker.sh` -- the bash a worker verb runs on its box, local child or
`ssh <box> bash -s` -- is still bash, the shell's heredocs byte for byte, in
`lib/ludics/fleetworker/farside.py`: a box needs no Python for a worker's record, only for the
batches it runs (`execution slot`) and, on the anchor, the registry. The one verb `fleet-worker.sh`
still answers itself is `execution slot --probe`, which must answer on a box without Python 3.12.

### Safety state reads (#1092)

At the six read sites below, only ENOENT beneath searchable directories means absent
(`fs.absent`); a present dangling or looping link and any read/list error refuse. The budget returns lock status 2 for unread
owners and a gate reason (session exit 3) for unread quota state, without sleeping or probing.
The hold drain exits 1 before starting its command when its directory cannot be listed. Merge
builds exit 3 on an unread present slot runner; genuinely absent runners and unsupported probe
answers retain the existing bare-build policy. Peer-plan clean exits 1 and keeps the worktree
when its run directory or a named run cannot be read. Lease HALT reads follow `tiprun.HALT_READ`:
absent is open, readable is halted, unread refuses (exit 1), with the explicit force gate retained.
These failures return immediately; observers do not retry unread state within their wait,
including a hold read after a quota response (`core.GhSession`). Numeric hold entries and lock
owners, like the merge-build runner, must be regular files before open: FIFOs cannot block a read.
Readable malformed quota lines keep the existing shell-format boundary; this change does not
redesign lock ownership or harden unrelated evidence writers. #551 covers hold writes, while
#1092 covers the reads.

The new unit fixtures use dangling links and injected EACCES. Each site's fixture fails against
launch base d794b0e: lock success, no quota hold, command started after an unread drain, bare slot
runner, git worktree removal, and all three open HALT checks respectively. Task t1092's batch logs
are under `~/.local/state/issue-wave/wave-20261113b-ludics/scratch/t1092/runs/`; the PR records the
commands and outcomes.
