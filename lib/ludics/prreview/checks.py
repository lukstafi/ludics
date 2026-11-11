"""``pr-review.sh checks <pr> [--wait[=seconds]] [--settle] [--check <ERE>]``: the PR head's build
signal, and its trailer.

Ported from the shell's ``cmd_checks`` (ludics-lite#403). The repository's advisory list is read
first (``Gate.advisory_policy``); a policy that could not be read is the command's status, with
nothing judged. The last stdout line is ``checks: verdict=<v> [runners=<kinds>] branch=<agreement>``;
the verdict uses a closed vocabulary (ludics-lite#423): ``fleet-worker.sh prs`` reads the verdict
from it, never from the prose. A head
held by a build job that never got a runner (runners.py: NO RUNNER, NEVER STARTED) adds one field,
``runners=<kinds>``, ``<kinds>`` being ``no-runner``, ``never-started`` or both
in that order, comma-joined (ludics#753): only on exit 4, the verdict's vocabulary unchanged, so
``prs`` can tell a starved head from a running one. No field: no such job was found.

The final field is always ``branch=current|behind|unread`` (#1011): current means both reads
agree on the gated SHA; disagreeing reads or agreement on another SHA means behind. No gated SHA
or no compared tip (including a closed PR, Gone, Unread or a skipped comparison) means unread.

Boundary (#990): immediately before the trailer, one fresh ``branchtip.read_tip`` compares the
PR head with its branch and prints its warning, unless policy refused evaluation or the build
read ended unread (no further reads after a budget/state-directory failure). This also qualifies a completed ``--wait``;
the machine verdict and exit still describe the PR head's build, not branch agreement. The gate
itself does not poll the tip: two reads at reporting time instead of two extra reads per round.
A push after this comparison is unseen. A head move between the gate and this comparison
is not a new build verdict; branch agreement compares the read tip to the SHA the gate judged.
``merge`` retains its own final branch-tip refusal.

Exit: the gate's (0 green or a confirmed absence, 1 red, 3 unread -- under --wait, a head,
check-run or workflow-run read that did not answer is read again until the wait is spent (gate.py,
ludics-lite#795, ludics#808) --, 4 no verdict yet, 5 superseded),
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

Without ``--check``, ``--wait`` settles on the REQUIRED checks, and required means what ``merge``'s
gate means (#1026), since both judge through one ``Gate``: every check run and workflow run on the
head whose name the advisory list does not match, the list being the repository's ADVISORY_FILE on
its default branch read as ``merge`` reads it (``Gate.advisory_policy``), or SHIP_PR_ADVISORY_CHECKS.
So the wait ends green once every required check is green while an advisory job is still queued or
running (its check runs are out of the fold, and its run is released by ``run_inflight_hold`` once
only advisory jobs are unfinished and the job list has been still for the advisory settle); ends red
at the first round that reads a required red, whatever else is still running (``--settle``, below,
waits those out); and holds a run whose
required ``needs:`` dependent has no job yet for as long as its job list moved inside that settle.
Boundary: it reads the advisory file once and the check runs, workflow runs and job lists as they
exist at each read. A dependent job GitHub creates after the settle has passed (a required job that
``needs:`` an advisory one, which the advisory file's own boundary forbids), a workflow a later
event starts (``workflow_run``), and a push after the last read are not seen. When the bound
expires with no verdict, one line before the trailer says the wait was spent, and how long it was;
the exit stays 4 and the trailer's vocabulary is unchanged.

``--settle`` (#1039; only with a ``--wait`` of more than 0 seconds) keeps the wait going past a red while a check the fold
judges -- every required check, or the ``--check`` selection -- is still running, so every red of
the head is reported in one answer rather than one push at a time (``Gate.settling``). It ends once
none is running, at the bound, or on a job that never got a runner, and the exit and trailer are the
red's as without it (1, ``verdict=red`` or ``runred``). A red that ends it with checks still running
(the bound spent, or a runner-less job) says so on one line before the trailer, naming them: the
reds above are those read so far. A head that reads no red waits and answers exactly as without it.
Boundary: it holds on the check runs the fold reads, nothing else -- a required ``needs:`` job with
no check run yet does not hold a red (a red job's dependents are usually skipped), and an in-flight
workflow run around finished checks does not either (an advisory leg can keep a run unfinished long
after every required check settled). The report is the last round's, as without it: a red check
there outranks the run list, which is then not read, so a workflow run that concluded red with no
check behind it (``runred``) is named only when no check is red. Without ``--settle`` a red ends
the wait at once: ``merge`` and every other caller keep that.
"""

import os
import shlex

from ludics import cli
from ludics.prreview import branchtip, ere
from ludics.prreview.clock import clock_from_env, fmt_age
from ludics.prreview.core import GhSession, die, fail, pr_arg
from ludics.prreview.gate import Gate, load_gate_config, running_list
from ludics.prreview.shtext import is_digits

USAGE = "usage: checks <pr> [--wait[=seconds]] [--settle] [--check <ERE>]"

VERDICTS = (
    "green", "absent", "red", "runred", "waived", "pending", "mixed", "unjudged", "superseded", "unknown",
)
# The trailer's ``runners=`` kinds, in the order they are written (runners.Kind).
RUNNER_KINDS = ("no-runner", "never-started")


def trailer(rc: int, verdict: str, kinds: set[str], branch: str) -> str:
    """The last stdout line: the verdict, and the runner-less kinds found on a no-verdict exit (4)."""
    found = [kind for kind in RUNNER_KINDS if kind in kinds] if rc == 4 else []
    return f"checks: verdict={verdict}" + (f" runners={','.join(found)}" if found else "") + f" branch={branch}"


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
    wait_from = ""  # how the bound was set, for the line that reports its expiry
    select: str | None = None
    settle = False
    rest = args[1:]
    while rest:
        arg = rest[0]
        rest = rest[1:]
        if arg == "--wait":
            wait_for = config.checks_wait
            wait_from = "--wait, from SHIP_PR_CHECKS_WAIT"
        elif arg.startswith("--wait="):
            wait_for = parse_wait(arg[len("--wait=") :], "checks")
            wait_from = arg
        elif arg == "--settle":
            settle = True
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
    if settle and wait_for == 0:
        die("checks: --settle needs a --wait of more than 0 seconds: it keeps a wait going past a red")
    target = pr_arg(pr, session.config.repo, session)
    # A --wait is the PR's build observer from its first read on, the advisory list's included
    # (the polling budget, budget.py): a second is refused before it reads anything.
    if session.budget is not None:
        session.budget.observe("build", wait_for, target.repo, target.num)
    gate = Gate(session, target.repo, config, clock_from_env(os.environ), select=select or "", orphans_on=True,
                images_on=True, settle=settle)
    # A selection names its checks itself; the advisory list has no say in it.
    policy = 0 if select else gate.advisory_policy()
    kinds: set[str] = set()
    if policy == 0:
        rc = gate.check(target.num, wait_for)
        verdict: str = gate.verdict
        kinds = {orphan.kind for orphan in gate.orphans}
        # The bound, reported when it is what ended the wait (a no-runner job ends it early).
        def spent() -> bool:
            return wait_for > 0 and gate.deadline is not None and gate.clock.now() >= gate.deadline

        if rc == 4 and spent():
            cli.say(
                f"checks: the wait is spent: {fmt_age(wait_for)} ({wait_from}) passed with no verdict;"
                " exit 4 is no verdict yet, neither green nor red"
            )
        elif settle and rc == 1 and gate.check_pending > 0:
            if spent():
                why = f"the wait is spent: {fmt_age(wait_for)} ({wait_from}) passed"
            elif gate.orphans:
                why = "a job that never got a runner ended the wait"
            else:
                why = "the wait ended"
            cli.say(
                f"checks: --settle: {why} with {gate.check_pending} check(s) still running:"
                f" {running_list(gate.pending_names)}; the reds above are those read so far"
            )
    else:
        rc = policy
        verdict = "unknown"
    if verdict not in VERDICTS:
        verdict = "unknown"
    branch = "unread"
    if policy == 0 and rc != 3:
        tip = branchtip.read_tip(session, target.repo, target.num)
        if gate.check_sha:
            if isinstance(tip, branchtip.Clear) and tip.head:
                branch = "current" if tip.head == gate.check_sha else "behind"
            elif isinstance(tip, branchtip.Lags):
                branch = "behind"
        warning = branchtip.warning(tip, target.repo, target.num)
        if warning:
            cli.say(warning)
    cli.say(trailer(rc, verdict, kinds, branch))
    return rc
