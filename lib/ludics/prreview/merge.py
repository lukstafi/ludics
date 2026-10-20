"""``pr-review.sh merge <pr> [--override <reason>] [--wait[=s]] [--allow-no-verdict] [--require-green]
[-- <gh pr merge args...>]``: read the build signal, then merge the head it was read for.

Ported from the shell's ``cmd_merge`` with ``refuse_merge_queue``, ``await_mergeable`` and
``absent_base_holds`` (ludics-lite#403). The gate and the merge are one command on purpose
(ahrefs/ocannl#694: a gate you have to remember to run separately is the gate that was missing for
seven merges). The order of the reads is the shell's, and it is load-bearing -- each position was a
review round:

  the body's closing-keyword scan (lead time), the merge queue (a close-out merge), the advisory
  list, a --wait's conflict preflight (ludics-lite#729, ``conflict_preflight``), the gate (with the
  override's waiver), the close-out refusals, the base drift, the build of
  the would-be merge commit where the repository asks for one (mergebuild.py, #611); then before
  EVERY attempt: the body again, the commit series, the open review threads, the merge queue last,
  and an ABSENT verdict's base (ludics-lite#523); then what the merge goes over (an override's
  waived red, an unread signal), announced once, after every refusal before the first call has
  passed; then the call, bound to the gated head (``--match-head-commit``), and the merged state confirmed
  over REST.

Exit: 0 merged; 1 refused (red, a moved head, a real conflict, an open thread, a deferred merge);
2 usage; 3 something that decides it could not be read; 4 no verdict; 5 the head was superseded;
6 no verdict because a build job never got a runner (runners.py: NO RUNNER, NEVER STARTED), and the
one recovery ``--wait`` makes per head run (``Recovery``) is spent or failed, or there was no wait
to make it in -- the refusal names the commands. ``--allow-no-verdict`` still merges it unread.
"""

import os
import re
import shlex
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, assert_never

from ludics import cli
from ludics.prreview.checks import parse_wait
from ludics.prreview.closekw import MultiClose, SeriesClose
from ludics.prreview.core import (
    GhArgsRefused,
    GhOutputWithheld,
    GhFailed,
    GhOk,
    GhSession,
    GhUnanswered,
    api_rejection,
    die,
    fail,
    pr_arg,
    warn,
)
from ludics.prreview.drift import Drift, read_base_drift
from ludics.prreview.clock import Clock, clock_from_env
from ludics.prreview.gate import Gate, GateConfig, load_gate_config
from ludics.prreview.mergebuild import merge_build
from ludics.prreview.runners import (
    HeadRun,
    Idle,
    Orphan,
    Step,
    Stop,
    Wait,
    cancel_command,
    read_jobs,
    recovery_text,
    rerun_command,
)
from ludics.prreview.shtext import tab_fields
from ludics.prreview.threads import merge_threads_gate

USAGE = "usage: merge <pr> [--override <reason>] [--wait[=seconds]] [--allow-no-verdict] [-- <gh pr merge args...>]"

_SPACE = " \t\n\r\f\v"
_REASON = re.compile(f"[^{_SPACE}]+[{_SPACE}]+[^{_SPACE}]+")


@dataclass
class Options:
    pr: str
    override: str = ""
    wait_for: int = 0
    allow_no_verdict: bool = False
    require_green: bool = False
    gh_args: list[str] = field(default_factory=lambda: list[str]())
    forwarded: bool = False


def parse(args: list[str], config: GateConfig) -> Options:
    if not args or not args[0]:
        fail(1, USAGE)
    opts = Options(pr=args[0])
    rest = args[1:]
    while rest:
        arg = rest[0]
        if arg == "--override":
            if len(rest) < 2 or not rest[1]:
                fail(1, "--override needs a reason")
            opts.override = rest[1]
            rest = rest[2:]
            continue
        if arg.startswith("--override="):
            opts.override = arg[len("--override=") :]
        elif arg == "--wait":
            opts.wait_for = config.checks_wait
        elif arg.startswith("--wait="):
            opts.wait_for = parse_wait(arg[len("--wait=") :], "merge")
        elif arg == "--allow-no-verdict":
            opts.allow_no_verdict = True
        elif arg == "--require-green":
            opts.require_green = True
        elif arg == "--check" or arg.startswith("--check="):
            die(
                "merge: --check is checks-only. merge's gate is every non-advisory check of the head,",
                "never a subset; wait on one check with `checks <pr> --wait --check <ERE>`, then merge.",
            )
        elif arg == "--":
            opts.gh_args = rest[1:]
            break
        else:
            die(f"merge: unknown option '{arg}' (extra `gh pr merge` flags go after --)")
        rest = rest[1:]
    opts.forwarded = bool(opts.gh_args)
    if not opts.gh_args:
        opts.gh_args = ["--merge"]  # the repo convention: preserve the commit series
    for arg in opts.gh_args:
        if arg == "--match-head-commit" or arg.startswith("--match-head-commit="):
            die(
                "merge: --match-head-commit is set by the",
                "script to the head the build signal was read for, and cannot be forwarded.",
            )
    if opts.require_green:
        for arg in opts.gh_args:
            if arg == "--auto" or arg.startswith("--auto="):
                die(
                    "merge: --require-green cannot be combined with --auto — a close-out",
                    "merge lands the gated head now or refuses; it is never deferred to auto-merge.",
                )
    # grep reads lines: a reason is two words on ONE line of it.
    if opts.override and not any(_REASON.search(line) for line in opts.override.split("\n")):
        die(
            f"merge: --override takes a REASON in words, not '{opts.override}'. Say why this red is",
            "known-unrelated to this PR — e.g. --override 'ci Deps step fails on an opam solve,",
            "same red on master before this branch existed'.",
        )
    return opts


@dataclass
class _Recovered:
    """What the recovery did to one head run: ``cancel`` (a NEVER STARTED, the rerun still to
    come) or ``rerun``; the attempt it acted on; and when (the clock's seconds)."""

    action: Literal["cancel", "rerun"]
    attempt: int | None
    at: int


class Recovery:
    """``merge --wait``'s one recovery per head run per wait, from a job that never got a runner
    (runners.py; ludics-lite#560, #728). Its writes are the only ones it makes, both on a run of
    the gated head, each recorded BEFORE it is sent so an ambiguous one is never sent again:

    - NO RUNNER: ``gh run rerun <id> --failed``, and the wait's deadline moves to at least
      ``now + wait`` -- the rerun gets the budget the first run had.
    - NEVER STARTED: the job re-read still ``queued``, then ``gh run cancel <id>``, and the deadline
      moves to at least ``TRANSITION`` seconds on; on a later round that sees the run completed,
      the rerun as above. A cancel that has not completed the run within ``TRANSITION`` seconds
      ends the wait.
    - After a rerun, a job of the run that again never got a runner on a LATER attempt is the second
      occurrence: the wait ends. Jobs still of the attempt that was rerun are the API showing the
      old attempt, ignored for ``TRANSITION`` seconds, after which the rerun did not take and the
      wait ends too.

    Before each write the PR head is re-read: a head that moved is ``superseded`` (5), and nothing
    is written; one that could not be re-read is ``unread`` (3). Every other end leaves ``why`` and
    ``commands`` for merge's exit 6."""

    TRANSITION = 300

    def __init__(self, session: GhSession, repo: str, num: str, gate: Gate, clock: Clock, wait_for: int) -> None:
        self.session = session
        self.repo = repo
        self.num = num
        self.gate = gate
        self.clock = clock
        self.wait_for = wait_for
        self.done: dict[str, _Recovered] = {}
        self.why = ""
        self.commands: list[str] = []
        self.superseded = ""
        self.unread = False

    def stop(self, why: str, *commands: str) -> Stop:
        self.why = why
        self.commands = list(commands)
        return Stop()

    def head_moved(self) -> bool:
        read = self.session.retry("read", ["api", f"repos/{self.repo}/pulls/{self.num}", "--jq", '.head.sha // "-"'])
        if not isinstance(read, GhOk) or read.stdout in ("", "-"):
            self.why = f"the PR head could not be re-read before the recovery's write ({self.session.err_line()})"
            self.unread = True
            return True
        if read.stdout != self.gate.check_sha:
            self.superseded = read.stdout
            return True
        return False

    def write(self, rid: str, action: Literal["cancel", "rerun"], attempt: int | None, now: int) -> bool:
        """Record, then send, one write; False (with ``why``) when it was not sent or failed."""
        if self.head_moved():
            return False
        self.done[rid] = _Recovered(action, attempt, now)
        args = ["run", "cancel", rid, "--repo", self.repo] if action == "cancel" else \
            ["run", "rerun", rid, "--failed", "--repo", self.repo]
        command = cancel_command(rid, self.repo) if action == "cancel" else rerun_command(rid, self.repo)
        warn(f"{self.repo}#{self.num}: run {rid}: a build job never got a runner; recovering once: {command}")
        result = self.session.retry("write", args)
        if isinstance(result, GhOk):
            return True
        unclear = isinstance(result, GhUnanswered)
        self.why = (
            f"`{command}` failed ({self.session.err_line()})"
            + ("; it may have landed — read `gh run view " + rid + f" --repo {self.repo}` before repeating it" if unclear else "")
        )
        self.commands = [command] if action == "rerun" else [command, rerun_command(rid, self.repo)]
        return False

    def still_queued(self, rid: str, jid: str) -> bool:
        jobs = read_jobs(self.session, self.repo, rid)
        return jobs is not None and any(j.jid == jid and j.status == "queued" for j in jobs)

    def __call__(self, orphans: list[Orphan], runs: list[HeadRun]) -> Step:
        now = self.clock.now()
        until = 0
        acted = False
        by_run: dict[str, Orphan] = {}
        for orphan in orphans:
            by_run.setdefault(orphan.rid, orphan)
        for rid, orphan in by_run.items():
            done = self.done.get(rid)
            attempt = orphan.job.attempt
            if done is None:
                acted = True
                if orphan.kind == "never-started":
                    if not self.still_queued(rid, orphan.job.jid):
                        continue
                    if not self.write(rid, "cancel", attempt, now):
                        return Stop()
                    # The wait outlives the cancel's window, so the rerun it promises is made (or
                    # the window's end is what stops it), however near its deadline it was sent.
                    until = max(until, now + self.TRANSITION)
                    continue
                if not self.write(rid, "rerun", attempt, now):
                    return Stop()
                until = max(until, now + self.wait_for)
            elif done.action == "cancel" and orphan.kind == "no-runner":
                acted = True
                if not self.write(rid, "rerun", done.attempt, now):
                    return Stop()
                until = max(until, now + self.wait_for)
            elif done.action == "rerun" and attempt is not None and done.attempt is not None and attempt > done.attempt:
                return self.stop(
                    f"run {rid} got no runner again on its rerun (attempt {attempt}): the one recovery this wait"
                    " makes per run is spent",
                    rerun_command(rid, self.repo),
                    rerun_command(rid, self.repo, failed=False),
                )
            elif now - done.at >= self.TRANSITION:
                return self.stop(
                    f"run {rid} still shows the job that never got a runner {(now - done.at) // 60} min after"
                    f" its {done.action}, which did not take",
                    *([cancel_command(rid, self.repo)] if done.action == "cancel" else []),
                    rerun_command(rid, self.repo),
                )
            else:
                acted = True
        # A cancelled run whose job did read as started after all (a runner took it between the
        # re-read and the cancel) is no NO RUNNER, but it was stopped by this recovery: rerun it.
        for run in runs:
            done = self.done.get(run.rid)
            if done is None or done.action != "cancel" or run.rid in by_run:
                continue
            acted = True
            if run.status == "completed":
                if not self.write(run.rid, "rerun", done.attempt, now):
                    return Stop()
                until = max(until, now + self.wait_for)
            elif now - done.at >= self.TRANSITION:
                return self.stop(
                    f"run {run.rid} is still in flight {(now - done.at) // 60} min after its cancel",
                    cancel_command(run.rid, self.repo),
                    rerun_command(run.rid, self.repo),
                )
        return Wait(until) if acted else Idle()


class Merge:
    def __init__(
        self, session: GhSession, repo: str, num: str, config: GateConfig, clock: Clock, opts: Options
    ) -> None:
        self.session = session
        self.repo = repo
        self.num = num
        self.config = config
        self.clock = clock
        self.opts = opts
        self.gate = Gate(session, repo, config, clock, orphans_on=True)
        # The one recovery from a job that never got a runner, under --wait only: a merge that does
        # not wait does not rerun (runners.py; Recovery above).
        self.recovery = Recovery(session, repo, num, self.gate, clock, opts.wait_for)
        self.multi = MultiClose(session, repo)
        self.series = SeriesClose(session, repo)
        # What the merge goes over (--override's waived red, --allow-no-verdict's unread signal):
        # each a stdout line and its stderr record, held by judge() and said by announce() just
        # before the first merge call. Said at the verdict, "merging" stood above a refusal that
        # followed it -- --require-green's, the merge build's, an open thread's (ludics-lite#684).
        self.announced: list[tuple[str, tuple[str, ...]]] = []

    def drift(self) -> Drift:
        return read_base_drift(self.session, self.repo, self.num, self.config.stale_base)

    def refuse_merge_queue(self) -> None:
        """``refuse_merge_queue``: a close-out merge refuses a base with a merge queue (1), and one
        whose queue could not be read (3) -- the queue is GraphQL-only, and unread is not "no queue"."""
        repo, pr = self.repo, self.num
        base = self.session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", ".base.ref"])
        if not isinstance(base, GhOk) or not base.stdout:
            fail(
                3,
                f"NOT merging {repo}#{pr}: the base branch",
                f"could not be read ({self.session.err_line()}), so whether it has a merge queue is unknown.",
            )
        base_ref = base.stdout
        owner, _, rest = repo.partition("/")
        queue = self.session.retry(
            "read",
            [
                "api",
                "graphql",
                "-f",
                "query=query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){mergeQueue(branch:$b){id}}}",
                "-f",
                f"o={owner}",
                "-f",
                f"r={rest if '/' in repo else repo}",
                "-f",
                f"b={base_ref}",
                "--jq",
                '.data.repository.mergeQueue.id // ""',
            ],
        )
        if not isinstance(queue, GhOk):
            fail(
                3,
                f"NOT merging {repo}#{pr}: could not read whether {base_ref} has a",
                f"merge queue ({self.session.err_line()}); a close-out merge does not guess. Retry.",
            )
        if queue.stdout:
            fail(
                1,
                f"REFUSING to merge {repo}#{pr}: {base_ref} has a merge queue, so",
                "`gh pr merge` would ENQUEUE the PR to land later on whatever head it has then, and a",
                "close-out merge lands the gated head now or not at all. Hand the merge to the maintainer",
                "with the record on the PR.",
            )

    def await_mergeable(self, sleep: Callable[[float], None]) -> str:
        """``await_mergeable``: GitHub's recomputed answer, true or false; ``unknown`` when the read
        failed, ``null`` when it was still computing after eight reads five seconds apart."""
        for _ in range(8):
            result = self.session.retry(
                "read", ["api", f"repos/{self.repo}/pulls/{self.num}", "--jq", ".mergeable | tostring"]
            )
            if not isinstance(result, GhOk):
                return "unknown"
            if result.stdout in ("true", "false"):
                return result.stdout
            sleep(5)
        return "null"

    # The preflight's reads while GitHub has not computed the answer yet: await_mergeable's bound.
    PREFLIGHT_READS = 8
    PREFLIGHT_PAUSE = 5
    _MERGEABILITY_JQ = '"\\(.mergeable)\\t\\(.mergeable_state // "-")\\t\\(.base.ref // "-")"'

    def conflict_preflight(self) -> None:
        """A ``--wait``'s first question (ludics-lite#729): does the PR conflict with its base? A
        conflict ends no wait in a merge -- on ocannl-staging#1259 it surfaced only at the merge
        call, after 120 minutes on CI -- so it is refused before the wait, exit 1.

        BOUNDARY (a fail-closed allowlist). One REST read of the PR, two fields: ``mergeable``
        (true / false / null) and ``mergeable_state``. GitHub computes them lazily, so ``null`` or
        ``unknown`` in EITHER field is "not computed yet": re-read, at most PREFLIGHT_READS reads
        PREFLIGHT_PAUSE s apart and never a pause past the command's own wait ceiling (the gate's
        deadline, from the same start), and never read as clean or as conflicting. Refused: exactly
        ``mergeable=false`` or ``mergeable_state=dirty``, read while neither field is still
        computing. Silent: exactly ``mergeable=true`` with any other state (``behind``,
        ``blocked``, ``unstable``, ``draft``, ``has_hooks``, ``clean``: the drift read's and the
        gate's, not this one's). Anything else -- a read that failed, a shape outside those
        words, or still computing after the last read -- is said on stderr and the wait goes on:
        this read can only refuse early, so not knowing refuses nothing, and it never says clean.
        Not read: a conflict that arises DURING the wait. That one is the drift read's warning
        after the gate and the merge call's own refusal, decided by the mergeable field
        (``await_mergeable``) as before. A merge with no wait reads nothing here: its gate is one
        read, and the call's refusal answers a conflict at once."""
        repo, pr, clock = self.repo, self.num, self.clock
        started = clock.now()
        budget = self.session.budget
        if budget is not None and budget.wait_from is not None:
            started = budget.wait_from
        deadline = started + self.opts.wait_for
        mergeable = state = base = ""
        reads = 0
        while reads < self.PREFLIGHT_READS:
            if reads and clock.now() + self.PREFLIGHT_PAUSE > deadline:
                break
            if reads:
                clock.sleep(self.PREFLIGHT_PAUSE)
            reads += 1
            result = self.session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", self._MERGEABILITY_JQ])
            if not isinstance(result, GhOk):
                warn(
                    f"whether {repo}#{pr} conflicts with its base is UNREAD ({self.session.err_line()}),",
                    "which is not 'no conflict'; waiting for the build signal, and the merge call re-checks it.",
                )
                return
            mergeable, state, base = tab_fields(result.stdout, 3)
            if mergeable == "null" or state == "unknown":
                continue
            if mergeable == "false" or state == "dirty":
                fail(
                    1,
                    f"REFUSING to merge {repo}#{pr} before the wait: it CONFLICTS with its base",
                    f"{shlex.quote(base)} (mergeable={mergeable}, mergeable_state={state}), so no build verdict",
                    f"can end in a merge. Merge or rebase {shlex.quote('origin/' + base)} in, resolve, push,",
                    "then run merge --wait again for the new head.",
                )
            if mergeable == "true":
                return
            warn(
                f"{repo}#{pr}'s mergeability read answered a shape this check does not know",
                f"(mergeable={shlex.quote(mergeable)}, mergeable_state={shlex.quote(state)}): not read as",
                "clean or as conflicting; waiting for the build signal, and the merge call re-checks it.",
            )
            return
        warn(
            f"{repo}#{pr}'s mergeability is NOT YET COMPUTED after {reads} read(s) within the wait",
            f"(mergeable={mergeable}, mergeable_state={state}): not read as clean or as conflicting;",
            "waiting for the build signal, and the merge call re-checks it.",
        )

    def absent_base_holds(self) -> bool:
        """``absent_base_holds``: is the PR's base still the one the ABSENT verdict was read against?
        A moved base is gated again (no wait, no waiver) and answers False once that read passes on
        the SAME head; any other outcome is a refusal, with the gate's status."""
        repo, pr = self.repo, self.num
        gated = self.gate.check_sha
        was = self.gate.gate_base
        read = self.session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", '.base.sha // "-"'])
        if not isinstance(read, GhOk) or read.stdout in ("", "-"):
            fail(
                3,
                f"NOT merged: {repo}#{pr}'s base could not be re-read ({self.session.err_line()}), and its ABSENT",
                "verdict holds only on the base it was read against. Re-run merge.",
            )
        base = read.stdout
        if base == was:
            return True
        warn(
            f"{repo}#{pr}'s base moved since its ABSENT verdict was read ({was[:8]} -> {base[:8]});",
            "gating the head again against the new base",
        )
        rc = self.gate.check(pr, 0)
        if rc != 0:
            fail(
                rc,
                f"NOT merged: {repo}#{pr}'s base moved since its ABSENT verdict",
                f"was read, and the gate read against the new base is {self.gate.verdict} (above). Re-run merge",
                "(--wait to wait for a run the new base's workflows may create).",
            )
        if self.gate.check_sha != gated:
            fail(
                5,
                f"NOT merged: {repo}#{pr}'s head moved too ({gated[:8]}",
                f"-> {self.gate.check_sha[:8]}) while its base was re-gated; re-run merge to judge the new head.",
            )
        self.drift()
        return False

    def announce_override(self, waived: int) -> None:
        repo, pr, why = self.repo, self.num, self.opts.override
        self.announced.append((
            f"OVERRIDE: merging {repo}#{pr} over a RED build signal — {why}",
            (
                f"OVERRIDE: merging {repo}#{pr} over {waived} red build",
                f"check(s)/run(s), each red when the override was given (marked WAIVED above) — {why}",
            ),
        ))

    def announce(self) -> None:
        """Say what the merge goes over, once, after every refusal before the call has passed."""
        for line, record in self.announced:
            cli.say(line)
            warn(*record)
        self.announced = []

    def judge(self) -> None:
        """The gate's verdict, and every refusal the merge makes on it."""
        repo, pr, opts, gate = self.repo, self.num, self.opts, self.gate
        # The recovery rides on this wait alone; a re-gate after it (absent_base_holds) writes nothing.
        gate.recover = self.recovery if opts.wait_for > 0 else None
        rc = gate.check(pr, opts.wait_for, waive=bool(opts.override))
        gate.recover = None
        # The gate's verdict is about the moment of its last round. Nothing after it waits a quota
        # hold out: a read here during one is 3, so the merge never lands on a verdict the wait made
        # old (the polling budget, budget.py).
        if self.session.budget is not None:
            self.session.budget.wait_until = None
        waived = gate.check_waived + gate.run_waived
        recovery = self.recovery
        if recovery.superseded:
            fail(
                5,
                f"NOT merging {repo}#{pr}: the head moved ({gate.check_sha[:8]} -> {recovery.superseded[:8]})",
                "before the rerun of a job that never got a runner was sent; nothing was written. Re-run merge",
                "to judge the new head.",
            )
        if recovery.unread:
            fail(
                3,
                f"NOT merging {repo}#{pr}: {recovery.why}; nothing was written. Retry.",
            )
        if rc == 4 and (gate.orphans or recovery.why) and not opts.allow_no_verdict:
            self.refuse_no_runner()
        match rc:
            case 1:
                if opts.override and gate.verdict == "waived":
                    self.announce_override(waived)
                elif opts.override:
                    fail(
                        1,
                        f"REFUSING to merge {repo}#{pr}: a build check or run is RED that --override did not",
                        "waive (listed above without WAIVED). The override covers only what was red at the gate's",
                        "first read, one check at a time: this red came after that read, so nobody has read it",
                        "yet, or it shares its workflow and name with another check, which nothing tells apart.",
                        "Open it; if it came later and is just as unrelated, re-run merge with an --override",
                        "whose reason covers it too (a new run records the reds it finds then).",
                    )
                else:
                    fail(
                        1,
                        f"REFUSING to merge {repo}#{pr}: {gate.check_red} build check(s) concluded failure on the",
                        "head commit (listed above). Fix it, or — only if that red is genuinely not about this",
                        "change — re-run with --override '<why this red is unrelated>'.",
                    )
            case 3:
                fail(
                    3,
                    f"NOT merging {repo}#{pr}: the build signal could not be READ. Nothing is known,",
                    "so this is not 'nothing is red' — retry rather than merging past it.",
                )
            case 5:
                fail(5, f"NOT merging {repo}#{pr}: the observed head was SUPERSEDED; re-run to judge the new head.")
            case 4:
                if opts.allow_no_verdict and waived > 0:
                    self.announced.append((
                        f"ALLOW-NO-VERDICT: merging {repo}#{pr} with NO verdict on the unfinished build signal"
                        " (listed above)",
                        (
                            f"ALLOW-NO-VERDICT: merging {repo}#{pr} with checks or runs still unjudged (see",
                            "above) — beside a red the override waives, so this is not 'nothing has failed'.",
                        ),
                    ))
                    self.announce_override(waived)
                elif opts.allow_no_verdict:
                    self.announced.append((
                        f"ALLOW-NO-VERDICT: merging {repo}#{pr} with NO build verdict on the head commit",
                        (
                            f"ALLOW-NO-VERDICT: merging {repo}#{pr} unread — nothing has failed, nothing has",
                            "passed either (see above).",
                        ),
                    ))
                elif waived > 0:
                    fail(
                        4,
                        f"REFUSING to merge {repo}#{pr}: --override waives the red marked WAIVED above, but",
                        f"no verdict after {opts.wait_for // 60} min on the rest (listed above) — a check still",
                        "running, or stopped without a verdict, is not a red, and no override covers it. Wait",
                        f"for it (--wait holds up to {self.config.checks_wait // 60} min, SHIP_PR_CHECKS_WAIT).",
                    )
                else:
                    fail(
                        4,
                        f"REFUSING to merge {repo}#{pr}: no verdict after {opts.wait_for // 60} min —",
                        "re-run with --allow-no-verdict to merge unread, or wait (--wait holds up to",
                        f"{self.config.checks_wait // 60} min, SHIP_PR_CHECKS_WAIT).",
                    )
            case _:
                pass
        # A red --override waived is a verdict READ (ludics-lite#623: a coordinated wave's owned base
        # red), so a close-out merge may go over it and keeps every other refusal of --require-green.
        if opts.require_green and gate.verdict not in ("green", "waived"):
            fail(
                4,
                f"REFUSING to merge {repo}#{pr}: --require-green and the build signal is {gate.verdict},",
                "not green. A close-out merge needs a green verdict READ on the final head. If the head",
                "genuinely runs no build (path filters), get one onto it — dispatch the workflow on the",
                "branch (gh workflow run) — or hand the merge to the maintainer with the record; a",
                "close-out merge is never made by dropping --require-green.",
            )
        if opts.require_green and gate.check_passed == 0:
            waived = gate.verdict == "waived"
            fail(
                4,
                f"REFUSING to merge {repo}#{pr}: --require-green and every build check on the head"
                + (" beside the red --override waived" if waived else ""),
                "was skipped or neutral — " + ("no build RAN green" if waived else "green, but no build RAN")
                + ". A close-out merge needs at least one",
                "check that concluded success. If the head genuinely runs no build (job-level path",
                "filters), get one onto it (gh workflow run) or hand the merge to the maintainer with",
                "the record; a close-out merge is never made by dropping --require-green.",
            )

    def refuse_no_runner(self) -> None:
        """Exit 6: no verdict because a build job never got a runner (runners.py), and the one
        recovery is spent, failed, or -- without --wait -- not made. Names the commands."""
        repo, pr, recovery = self.repo, self.num, self.recovery
        # The recovery's own commands where it ended on one run; else each orphan's, once a run.
        commands = list(recovery.commands) or list(
            dict.fromkeys(recovery_text(orphan, repo) for orphan in self.gate.orphans)
        )
        if recovery.why:
            why = recovery.why
        elif self.opts.wait_for > 0:
            why = "the wait ended on it"
        else:
            why = "merge reruns a run only under --wait"
        fail(
            6,
            f"NOT merging {repo}#{pr}: a build job never got a runner (NO RUNNER / NEVER STARTED, listed above) —",
            f"{why}. No verdict comes of it until the run is re-run. By hand: {'; '.join(commands)};",
            "then merge again (--wait). --allow-no-verdict merges without the verdict instead.",
        )

    def merge_call(self) -> None:
        """The attempts: every pre-call read, the bound call, and its failures told apart."""
        repo, pr, opts, gate = self.repo, self.num, self.opts, self.gate
        attempt = 1
        while True:
            self.multi.warn(pr, again=True)
            self.series.warn(pr, gate.check_sha)
            merge_threads_gate(self.session, repo, pr, self.config.threads_page_cap)
            if opts.require_green:
                self.refuse_merge_queue()
            if gate.verdict == "absent" and not self.absent_base_holds():
                if attempt >= 3:
                    fail(
                        1,
                        f"NOT merged: {repo}#{pr}'s base kept moving under its ABSENT",
                        f"verdict ({attempt} gate reads). Re-run merge.",
                    )
                attempt += 1
                continue
            self.announce()
            args = ["pr", "merge", pr, "--repo", repo, "--match-head-commit", gate.check_sha, *opts.gh_args]
            if opts.forwarded:
                # Still this script's own call, so the polling budget gates it.
                result = self.session.retry_caller("write", args, listed=False, budgeted=True)
            else:
                result = self.session.retry("write", args)
            match result:
                case GhOk(stdout=out):
                    cli.emit(out)
                    return
                case GhFailed() | GhUnanswered() | GhArgsRefused() | GhOutputWithheld():
                    pass
                case _:
                    assert_never(result)
            err = self.session.err_line()
            if "Base branch was modified" in err:
                head = self.session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", '.head.sha // "-"'])
                if not isinstance(head, GhOk) or head.stdout in ("", "-"):
                    fail(
                        3,
                        f"NOT merged: {repo}#{pr}'s base moved during the call ({err}) and its head could",
                        f"not be re-read ({self.session.err_line()}); re-run merge.",
                    )
                if head.stdout == gate.check_sha:
                    if gate.verdict == "absent":
                        fail(
                            1,
                            f"NOT merged: {repo}#{pr}'s base moved during the call,",
                            "and its ABSENT verdict was recognized against the old base. Re-run merge so the gate",
                            "reads the new one.",
                        )
                    if attempt >= 3:
                        fail(
                            1,
                            f"NOT merged: {repo}#{pr}'s base moved during each of",
                            f"{attempt} merge calls; its head is still {gate.check_sha[:8]}. Re-run merge.",
                        )
                    warn(
                        f"{repo}#{pr}'s BASE moved during the merge call, not its head (still",
                        f"{gate.check_sha[:8]}); re-reading the drift and retrying",
                    )
                    self.drift()
                    attempt += 1
                    continue
            if any(s in err for s in ("was modified", "does not match", "head commit", "expected head")):
                fail(
                    1,
                    f"NOT merged: {repo}#{pr}'s head is no longer {gate.check_sha[:8]}, the commit the build",
                    f"signal was read for ({err}). A push moved it; re-run merge so the gate reads the new head.",
                )
            if "not mergeable" in err or "cannot be cleanly created" in err:
                if attempt >= 3:
                    fail(
                        1,
                        f"merge of {repo}#{pr} keeps failing as not mergeable",
                        f"after {attempt} attempts: this is base drift, merge or rebase origin/<base> in.",
                    )
                mergeable = self.await_mergeable(self.clock.sleep)
                if mergeable == "true":
                    warn("'not mergeable' was the stale pre-recompute verdict (mergeable=true now); retrying")
                    attempt += 1
                    continue
                if mergeable == "false":
                    fail(
                        1,
                        f"{repo}#{pr} really does not merge cleanly (mergeable=false after the",
                        "recompute): merge or rebase the base branch in, push, then merge again.",
                    )
                fail(
                    3,
                    f"{repo}#{pr} failed to merge as 'not mergeable' and its mergeable field is",
                    f"{mergeable} — GitHub is still computing, or did not answer. Re-read before concluding.",
                )
            if api_rejection(err):
                fail(1, f"gh pr merge was rejected: {err}")
            fail(
                3,
                f"gh pr merge failed AMBIGUOUSLY: {err}. It may have LANDED — confirm over",
                f"REST (api repos/{repo}/pulls/{pr} --jq .merged) before retrying.",
            )

    def confirm(self) -> int:
        """The merged state over REST: ``gh pr merge`` returns 0 having only ENABLED auto-merge when
        the base defers merges, so its status is not the answer."""
        repo, pr = self.repo, self.num
        state = self.session.retry(
            "read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", '"merged=\\(.merged) state=\\(.state)"']
        )
        if not isinstance(state, GhOk):
            fail(
                3,
                "merge command returned but the state could not be confirmed",
                f"({self.session.err_line()}) — do NOT re-merge; re-read repos/{repo}/pulls/{pr} first.",
            )
        cli.say(f"{repo}#{pr} {state.stdout}")
        if "merged=true" in state.stdout:
            return 0
        if self.opts.require_green:
            disable = self.session.retry("write", ["pr", "merge", pr, "--repo", repo, "--disable-auto"])
            if isinstance(disable, GhOk):
                fail(
                    1,
                    f"NOT merged, and auto-merge DISABLED again: {repo}#{pr} ({state.stdout}) — the base defers",
                    "merges to its required checks or a merge queue, and a close-out merge is never",
                    "deferred. Merge it when the base allows a direct merge, or hand it to the maintainer",
                    "with the record on the PR.",
                )
            fail(
                3,
                f"NOT merged, and auto-merge could NOT be disabled ({self.session.err_line()}): {repo}#{pr}",
                f"({state.stdout}) is armed to land a LATER head ungated. Disable it by hand (gh pr merge",
                "--disable-auto) before anything else.",
            )
        fail(
            1,
            f"{repo}#{pr} is not merged ({state.stdout}) — `gh pr merge` returned having only enabled",
            "auto-merge. It will land when the base's required checks pass; do not treat it as landed.",
            f"{self.multi.deferred_note()} {self.series.deferred_note()}",
        )

    def run(self) -> int:
        self.multi.warn(self.num)
        if self.opts.require_green:
            self.refuse_merge_queue()
        policy = self.gate.advisory_policy()
        if policy != 0:
            return policy
        if self.opts.wait_for > 0:
            self.conflict_preflight()
        self.judge()
        drift = self.drift()
        # The would-be merge commit's build, where the repository asks for one (mergebuild.py,
        # ludics-lite#611): after the drift read it is decided on, before the merge call.
        merge_build(self.session, self.repo, self.num, self.gate.check_sha, drift, self.config.limits.contents_dir_cap)
        self.merge_call()
        return self.confirm()


def run(session: GhSession, args: list[str]) -> int:
    config = load_gate_config(os.environ)
    opts = parse(args, config)
    target = pr_arg(opts.pr, session.config.repo)
    # A --wait is the PR's build observer from its first read on, the body's included (the polling
    # budget, budget.py).
    if session.budget is not None:
        session.budget.observe("build", opts.wait_for, target.repo, target.num)
    return Merge(session, target.repo, target.num, config, clock_from_env(os.environ), opts).run()
