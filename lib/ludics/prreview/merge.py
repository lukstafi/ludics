"""``pr-review.sh merge <pr> [--override <reason>] [--wait[=s]] [--allow-no-verdict] [--require-green]
[-- <gh pr merge args...>]``: read the build signal, then merge the head it was read for.

Ported from the shell's ``cmd_merge`` with ``refuse_merge_queue``, ``await_mergeable`` and
``absent_base_holds`` (ludics-lite#403). The gate and the merge are one command on purpose
(ahrefs/ocannl#694: a gate you have to remember to run separately is the gate that was missing for
seven merges). The order of the reads is the shell's, and it is load-bearing -- each position was a
review round:

  the body's closing-keyword scan (lead time), the merge queue (a close-out merge), the advisory
  list, the gate (with the override's waiver), the close-out refusals, the base drift, the build of
  the would-be merge commit where the repository asks for one (mergebuild.py, #611); then before
  EVERY attempt: the body again, the commit series, the open review threads, the merge queue last,
  and an ABSENT verdict's base (ludics-lite#523); then what the merge goes over (an override's
  waived red, an unread signal), announced once, after every refusal before the first call has
  passed; then the call, bound to the gated head (``--match-head-commit``), and the merged state confirmed
  over REST.

Exit: 0 merged; 1 refused (red, a moved head, a real conflict, an open thread, a deferred merge);
2 usage; 3 something that decides it could not be read; 4 no verdict; 5 the head was superseded.
"""

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import assert_never

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
        self.gate = Gate(session, repo, config, clock)
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
        rc = gate.check(pr, opts.wait_for, waive=bool(opts.override))
        # The gate's verdict is about the moment of its last round. Nothing after it waits a quota
        # hold out: a read here during one is 3, so the merge never lands on a verdict the wait made
        # old (the polling budget, budget.py).
        if self.session.budget is not None:
            self.session.budget.wait_until = None
        waived = gate.check_waived + gate.run_waived
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
