# lib/ludics: the v2 rewrite's Python package

The core scripts are being ported to type-checked, standard-library-only Python 3.12, one script
(and for `pr-review.sh`, one subcommand) at a time, behind the command lines the skills already
call ([ludics-lite#403](https://github.com/lukstafi/ludics-lite/issues/403)). This file is for
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
  it, under `bash` 5 and `/bin/bash` 3.2.
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
lib/ludics/prreview/core.py      pr-review.sh's prelude: fail/die/warn, Config, GhSession
                                 (gh_retry and its classification), parse_ref/pr_arg,
                                 repo_from_cwd, api_list, mark_of
lib/ludics/prreview/<name>.py    one module per ported subcommand: run(session, args) -> int
lib/ludics/prreview/__main__.py  the dispatcher: `scripts/py -m ludics.prreview <name> ...`
lib/ludics/<script>/             the next script's package (e.g. checkprompts/, fleetworker/),
                                 with its own __main__.py
lib/ludics/tests/test_*.py       unittest suites (fake.py: a fake tool first on PATH)
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
prreview/drift.py          warn_base_drift (merge, watch), and read_base_drift's Drift for the merge build
prreview/mergebuild.py     merge's build of the would-be merge commit (.github/ship-pr-merge-build, #611)
prreview/checkruns.py      conclusion_class, newest_first
prreview/ere.py            the advisory list, asked of grep (is_advisory, ere_valid)
prreview/gate.py           gate_checks (checks, merge, and base's merged-head source)
prreview/runners.py        build jobs that never got a runner: NO RUNNER, NEVER STARTED (checks, merge;
                           merge.py's Recovery reruns once, #560/#728)
prreview/workflows.py      the workflow-file reads and the paths-ignore walk (checks/merge, base)
prreview/workflow_yaml.py  the narrow workflow-YAML readers and the glob translation
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

## Checking

```sh
npx --yes pyright@1.1.414 --pythonplatform Linux                  # from the repo root
npx --yes pyright@1.1.414 --pythonplatform Darwin                 # (CI runs both)
scripts/py -m unittest discover -s lib -t lib -p 'test_*.py'     # the package's unit tests
scripts/test-py.sh                                                # the wrapper
ship-pr/scripts/test-pr-review-<suite>.sh                         # the conformance suites
```

CI runs pyright and the unit tests in the `python` job of `.github/workflows/skill-scripts.yml`,
and the shell suites where they always ran. `scripts/fleet-peers.py` is not behind `scripts/py`
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
