"""THE GRACES (ludics#827): how long each layer that stops a run waits between the SIGTERM it sends
inward and the SIGKILL it escalates to, stated in this one place.

A stopped run is ended from the outside in, and every layer used to escalate on its own 10 s clock:
``bg-run.sh stop``, the ``execution slot`` or ``execution hold`` wrapper around a batch, and inside a
leg the outer wrapper and the nested per-run slot. At the tie the outer KILL won, so the innermost
layer -- the project's runner, whose own supervisor reaps what it started (OCANNL's
``tools/test-run.sh`` reaps its dune group, which holds the worktree's run lock) -- never got to
finish its reap, and the after-the-fact sweeps (``bg-run.sh stop``'s tree, the far stop's THE
ESCAPED) caught what it left. Here each layer's grace is strictly longer than the one inside it:

    grace(rung) = runner + MARGIN * rung

THE INPUT. ``runner`` is ``FLEET_RUNNER_GRACE``: the whole seconds the innermost command needs from
the SIGTERM its wrapper sends its group to its exit, its own reap included. It is the project's
fact, so the project states it (the operator sets it where the runs are started); this repository
does not know any runner's. Unset or empty, it is ``DEFAULT_RUNNER``, the grace every layer had
before. Anything but a whole number is refused, before the layer reading it has started anything
(``runner``).

THE RUNGS, inside out:

  1 ``NESTED``     an ``execution slot`` (or a hold) nested in an enclosing slot or measurement hold,
                   run with ``--deadline``, so leading a group of its own (``slot.run_command``):
                   the leg's per-run slot around the runner;
  2 ``WRAPPER``    an ``execution slot`` or ``execution hold`` that is not nested: a batch's slot, a
                   leg's outer wrapper, a measurement's hold;
  3 ``FAR_SHELL``  the far stop's wait for the leg's far shell to end (``leg.py``, THE STOP: it ends
                   once its wrapper has ended its group and the shell has wound down);
  4 ``LEG``        the leg's wait for the far stop's report, before it dies of its signal;
  5 ``BG_RUN``     ``bg-run.sh stop``'s TERM-to-KILL, around any of these (``bg-run.sh`` spells this
                   rung in shell, from these constants; ``tests/test_fleetworker_graces.py`` runs it
                   and pins the two equal).

A layer gets its rung's grace whether or not the layer inside it runs: a top-level slot gets
``WRAPPER`` with no nested slot in it, and ``bg-run.sh stop`` gets ``BG_RUN`` around any command. A
grace is a bound, never a delay: each layer escalates only while its group still has a member, so
the longer outer graces cost time only when something ignores its TERM.

WHERE EACH LAYER READS IT. Each layer reads the input from its own environment when it starts, and
derives its grace once: the slot and the hold before they take anything, the leg before it reaches
the box. The leg's far side reads the leg's value, not the box's: ``transport.FORWARDED`` carries
it in the far ``fleet-worker.sh``'s environment, and the far stop's bound is passed as its argument.
``bg-run.sh`` records its rung in the run's ``pid`` file when the run starts, and ``stop`` uses that
record, so a stop issued from another environment (a later tool call that did not export the input)
still gives the run the grace its layers were started with; an explicit ``BG_RUN_STOP_GRACE`` on the
stop overrides it, as before.

THE BOUNDARY. What is NOT a rung: the far stop's sweep of THE ESCAPED (its own TERM, then KILL after
10 s, on what left the ladder's groups after the far shell ended); ``bg-run.sh stop``'s settle after
its KILL (2 s for a process stuck in the kernel); ``group.py``'s guardian, which KILLs at once a
group whose wrapper was itself killed outright (a SIGKILL leaves no grace to give); and the runner's
own inner clocks (OCANNL's supervisor's reap and its reader), which the input sums. A nesting deeper
than these rungs -- a slot whose command is a runner that itself starts a nested ``execution slot
--deadline`` around a second runner -- gets the same two wrapper rungs, so the input must cover the
outer runner's reap of the inner. A run started with one input and a nested layer started later
under another (a different ``FLEET_RUNNER_GRACE`` exported inside the run) is that layer's caller's
to keep consistent.
"""

from collections.abc import Mapping

ENV = "FLEET_RUNNER_GRACE"
DEFAULT_RUNNER = 10  # seconds: the one grace every layer had before ludics#827
MARGIN = 5  # seconds each layer's grace exceeds the one inside it

NESTED = 1
WRAPPER = 2
FAR_SHELL = 3
LEG = 4
BG_RUN = 5


def runner(env: Mapping[str, str]) -> int:
    """``FLEET_RUNNER_GRACE``: the innermost command's grace in whole seconds, ``DEFAULT_RUNNER`` when
    unset or empty. Raises ValueError, naming the variable and the value, on anything else."""
    value = env.get(ENV) or ""
    if not value:
        return DEFAULT_RUNNER
    if not (value.isascii() and value.isdigit()):
        raise ValueError(f"{ENV} must be a whole number of seconds (the innermost command's stop grace), got {value!r}")
    return int(value)


def seconds(rung: int, env: Mapping[str, str]) -> int:
    """The grace of the layer at ``rung`` (THE RUNGS), from the input in ``env``."""
    return runner(env) + MARGIN * rung
