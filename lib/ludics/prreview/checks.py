"""``pr-review.sh checks <pr> [--wait[=seconds]] [--check <ERE>]``: the PR head's build signal, and
its trailer.

Ported from the shell's ``cmd_checks`` (ludics-lite#403). The repository's advisory list is read
first (``Gate.advisory_policy``); a policy that could not be read is the command's status, with
nothing judged. The last stdout line is always ``checks: verdict=<v>`` from a closed vocabulary
(ludics-lite#423): ``fleet-worker.sh prs`` reads the verdict from it, never from the prose.

Exit: the gate's (0 green or a confirmed absence, 1 red, 3 unread, 4 no verdict yet, 5 superseded),
or the policy's refusal (2, 3). ``--wait=`` takes whole seconds, and an empty value is no wait (the
shell's arithmetic read '' as 0); the shell fed anything else to its arithmetic, which failed
obscurely (``abc`` ended the command with status 0 and no output), so here it is a usage error (2).

``--check <ERE>`` (or ``--check=<ERE>``, ludics-lite#569) judges only the check runs whose name the
ERE matches -- grep reads it, as it reads the advisory list (ere.py) -- under the same wait, budget
and exit statuses, so a worker can wait on one fast job while a slow one runs. The selection is the
ERE alone: the advisory list is not read, and an advisory check the ERE matches is waited for. A
selection that matches no check run is held while a matching one can still appear (a run in
flight, or a run-less head inside the creation grace), and otherwise refused with 2 and
``verdict=unknown``, never green. Boundary: it reads check runs as they exist at each read; a job
that has no check run yet while others it would match have settled (a ``needs:`` dependent not yet
queued) is not seen, so an ERE meant for several jobs can settle on those that exist. ``merge``
takes no ``--check``: its gate is every non-advisory check, never a subset (merge.py).
"""

import os
import shlex

from ludics import cli
from ludics.prreview import ere
from ludics.prreview.clock import clock_from_env
from ludics.prreview.core import GhSession, die, fail, pr_arg
from ludics.prreview.gate import Gate, load_gate_config
from ludics.prreview.shtext import is_digits

USAGE = "usage: checks <pr> [--wait[=seconds]] [--check <ERE>]"

VERDICTS = (
    "green", "absent", "red", "runred", "waived", "pending", "mixed", "unjudged", "superseded", "unknown",
)


def parse_wait(value: str, command: str) -> int:
    """A ``--wait=<seconds>`` value: whole seconds (empty is 0), or a usage error."""
    if value == "":
        return 0
    if not is_digits(value):
        die(f"{command}: --wait takes whole seconds, got '{value}'")
    return int(value)


def run(session: GhSession, args: list[str]) -> int:
    config = load_gate_config(os.environ)
    if not args or not args[0]:
        fail(1, USAGE)
    pr = args[0]
    wait_for = 0
    select: str | None = None
    rest = args[1:]
    while rest:
        arg = rest[0]
        rest = rest[1:]
        if arg == "--wait":
            wait_for = config.checks_wait
        elif arg.startswith("--wait="):
            wait_for = parse_wait(arg[len("--wait=") :], "checks")
        elif arg == "--check" or arg.startswith("--check="):
            if arg == "--check":
                if not rest:
                    die("checks: --check needs an ERE naming the check(s) to judge")
                value, rest = rest[0], rest[1:]
            else:
                value = arg[len("--check=") :]
            if select is not None:
                die("checks: --check given twice; join the names into one ERE with |")
            if value == "":
                die("checks: --check needs an ERE; an empty one would match every check")
            if not ere.valid(value):
                die(f"checks: --check {shlex.quote(value)} is not an ERE grep accepts")
            select = value
        else:
            die(f"checks: unknown option '{arg}'")
    target = pr_arg(pr, session.config.repo)
    # A --wait is the PR's build observer from its first read on, the advisory list's included
    # (the polling budget, budget.py): a second is refused before it reads anything.
    if session.budget is not None:
        session.budget.observe("build", wait_for, target.repo, target.num)
    gate = Gate(session, target.repo, config, clock_from_env(os.environ), select=select or "")
    # A selection names its checks itself; the advisory list has no say in it.
    policy = 0 if select else gate.advisory_policy()
    if policy == 0:
        rc = gate.check(target.num, wait_for)
        verdict: str = gate.verdict
    else:
        rc = policy
        verdict = "unknown"
    if verdict not in VERDICTS:
        verdict = "unknown"
    cli.say(f"checks: verdict={verdict}")
    return rc
