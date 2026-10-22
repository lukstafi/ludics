"""``pr-review.sh watch <pr> [watermark]``: wait for the reviewer's next round, and say what it was.

Ported from ``cmd_watch``, ``watch_loop`` and their helpers (``watch_round``, ``watch_note_past``,
``watch_quiet_line``, ``watch_act``, ``watch_round_counts``/``_trailer``/``_note``,
``watch_settle``, ``watch_preserve_unarmed_nudge``, ``watch_end``, ``watch_grace_deadline``,
``watch_post_request``, ``item_about_head``, ``tmp_sweep_stale``). The shell's comments above each
of them carry the incidents behind every rule kept here -- they are pr-review.sh as of the port's
parent commit (``git show 14f2ca7:ship-pr/scripts/pr-review.sh``); read them before changing one:

- the wait ends only on reviewer activity ABOUT the head being watched (ludics-lite#72); items
  about another commit are printed for the record on stderr and the watermark moves past them;
- every verdict that says "nothing is coming" polls once more first, re-reads the state, and is
  withheld (exit 3) when either did not answer -- a nudge over a round that just landed clears
  the 👍 it was about to get;
- "keep waiting" is said only while something runs: a live round or a fresh nudge extends the
  window ONCE, to a frozen deadline (handed off once from a nudge's pickup to its review);
- a `failed` run is re-requested by the watch itself, once per head per process, on a state read
  fresh after the round, and the request is sent ONCE whatever its error (it may have landed);
- an `expected` verdict -- a 👀 round that ended without a review of the head (a push landed
  during it), or a head with no 👀 past its grace -- is answered with the watch's own
  '@codex review' (ludics-lite#570), once per head, when the verdict's re-reads stand and
  ``state.nudge_read`` finds nothing for the head, its request record included; the watch then
  waits out that request's grace for the head's round. It is held, not given, while this watch
  has seen the head for less than ``PICKUP`` (a commit's date is not its push, so an old-dated
  push reads as overdue the moment it lands), while a request on the head is younger than its
  grace, and for a draft or a PR that conflicts with its base. ``--no-nudge`` posts nothing, here
  or for a failed run, and prints the advice instead;
- a ``stalled`` round -- a 👀 or Running row up longer than a round takes -- does not end the wait
  (ludics-lite#760). When ``state.stall_nudge_read`` finds nothing standing for the head (no 👍,
  no verdict, no request since it arrived) and the write gate passes, the watch posts its one
  '@codex review' for the head (the same once-per-head record as the ``expected`` nudge) and waits
  out that request's grace for the new round, once it has seen the head for ``PICKUP`` (a push
  under an old head's hung 👀 reads stalled at once) and on a round whose poll answered. Otherwise, and always under ``--no-nudge``, it posts
  nothing and keeps waiting, bounded by the window: the reviewer posting ends it as any round does,
  a state that leaves ``stalled`` goes on by that state's rules, and a stall still standing at the
  window's end is answered as a verdict, with the move the final read names.

Exit: 0 something to act on (a round, an approval, a verdict); 1 a quiet window; 3 the window, its
tail or the verdict's re-reads were not observed. The last stdout line is always the watermark.
"""

import glob
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import assert_never

from ludics.proc import windows_command_line
from ludics.prreview import knobs
from ludics.prreview.budget import pause as budget_pause
from ludics.prreview.core import (
    GhFailed,
    GhOk,
    GhSession,
    GhUnanswered,
    die,
    mark_of,
    pr_arg,
    warn,
)
from ludics.prreview.clock import Clock, age_of, clock_from_env, fmt_age
from ludics.prreview.drift import warn_base_drift
from ludics.prreview.feeds import Ctx, pr_head_read
from ludics.prreview.poll import poll
from ludics.prreview.state import (
    NudgeBarred,
    NudgeClear,
    NudgeRead,
    Rounds,
    State,
    approval_gate,
    gated_state,
    nudge_read,
    review_rounds,
    stall_nudge_read,
    status_line,
    status_state,
)

_NUMBER = re.compile(r"[0-9]+")
_WATERMARK = re.compile(r"[0-9].*,[0-9].*,[0-9].*", re.DOTALL)
_REQUEST_BODY = "@codex review\n\n_\U0001f916 Addressed by an automated coding agent_"
_ADVICE = " — consider nudging with a '@codex review' comment"
_NEW_HEAD = (
    "read the PR feed (retry --read pr view <pr> --comments), then push a new head (an amend"
    " suffices: git commit --amend --no-edit && git push --force-with-lease) or hand it to the"
    " maintainer"
)
# end()'s answer when it posted the automatic nudge: the loop goes on, watching the request.
_NUDGED = -1
# end()'s answer when its final poll read a head the nudge is held for (a new head, or a request
# younger than its grace): the loop goes on to ``held_until``.
_HELD = -2
# How long this watch must itself have seen a head, with nothing started on it, before it nudges:
# the evidence a commit's date cannot give that the push is not simply too new for the reviewer's
# own automatic review. That 👀 lands seconds after a push (on ludics-lite#583, 18s to the
# connector's first answer, 12s from a request to its 👀); five minutes is the margin, capped by the
# grace for a grace set shorter.
PICKUP = 300


@dataclass(frozen=True)
class WatchConfig:
    """The watch's source-time constants (validated, as the shell validated them, before anything
    is read) and its two environment knobs (read when the watch starts)."""

    grace: int
    stall: int
    stale_base: int | None
    interval: int = 90
    timeout: int = 900


def _number(env: Mapping[str, str], name: str, default: str, what: str) -> int:
    text = env.get(name, "") or default
    if not _NUMBER.fullmatch(text):
        die(f"{name} must be {what}, got '{text}'")
    return int(text)


def load_watch_config(env: Mapping[str, str]) -> WatchConfig:
    grace, stall = knobs.review_clocks(env)
    return WatchConfig(grace, stall, knobs.stale_base(env))


def with_window(cfg: WatchConfig, env: Mapping[str, str]) -> WatchConfig:
    """``${WATCH_INTERVAL:-90}`` and ``${WATCH_TIMEOUT:-900}``. The shell fed them to its
    arithmetic unchecked; a value that is not whole seconds is a usage error here."""
    return replace(
        cfg,
        interval=_number(env, "WATCH_INTERVAL", "90", "whole seconds"),
        timeout=_number(env, "WATCH_TIMEOUT", "900", "whole seconds"),
    )


def _err(text: str) -> None:
    """``echo ... >&2``: a line on stderr, after whatever stdout already holds."""
    sys.stdout.flush()
    sys.stderr.write(text + "\n")
    sys.stderr.flush()


def _say(text: str) -> None:
    sys.stdout.write(text + "\n")


def _strip(text: str) -> str:
    """What ``$(...)`` keeps of a command's output: trailing newlines dropped."""
    return text.rstrip("\n")


def _drop_last_line(text: str) -> str:
    """``$(sed '$d' <<<"$text")``."""
    return _strip("\n".join(text.split("\n")[:-1]))


def _last_line(text: str) -> str:
    """``$(tail -n 1 <<<"$text")``."""
    return text.split("\n")[-1]


def _upto(text: str, sep: str) -> str:
    """``${text%%<sep>*}``."""
    return text.split(sep, 1)[0]


def _after(text: str, sep: str) -> str:
    """``${text#*<sep>}``: everything after the first separator, or all of it when there is none."""
    return text.split(sep, 1)[1] if sep in text else text


def _cut_f12(text: str) -> str:
    """``cut -d'|' -f1-2``: a line without the delimiter prints whole."""
    parts = text.split("|")
    return text if len(parts) == 1 else "|".join(parts[:2])


def item_about_head(stamp: str, head: str) -> bool:
    """Is a rendered item about the head being watched? A prefix test, either way round; YES for
    an item with no stamp and for any item when the head could not be read."""
    if stamp in ("", "-") or not head:
        return True
    return head.startswith(stamp) or stamp.startswith(head)


# The forwarding shell's own bash, handed over by pr-review.sh under Git Bash only (py_forward).
CALLER_SHELL = "LUDICS_CALLER_SHELL"


def _live_msys_pids(env: Mapping[str, str], pids: set[str]) -> set[str] | None:
    """Which of these MSYS pids are alive, asked of the caller's own Git Bash with the shell's
    ``kill -0``: a native Windows interpreter cannot ask about an MSYS pid itself, and its
    ``os.kill(pid, 0)`` TERMINATES whatever Windows process has that number. None when there is
    no such bash or it did not answer, which sweeps nothing."""
    shell = env.get(CALLER_SHELL, "")
    if not shell:
        return None
    script = 'for p; do kill -0 "$p" 2>/dev/null && printf "%s\\n" "$p"; done; exit 0'
    try:
        done = subprocess.run(
            windows_command_line([shell, "-c", script, "_", *sorted(pids)]),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if done.returncode != 0:
        return None
    return set(done.stdout.decode("ascii", "replace").split())


def tmp_sweep_stale(env: Mapping[str, str]) -> None:
    """Remove what a SIGKILLed run left in TMPDIR: every family keyed by an owning pid that is no
    longer alive, this user's only. A name with no pid in it names no owner and is left alone.

    Under Git Bash (a native Python) the pids in those names are MSYS pids, so their liveness is
    the caller's bash's ``kill -0`` (``_live_msys_pids``), and ownership is not read: Windows
    reports no owner through ``stat`` and the scratch root is the user's own. Without that bash a
    leftover stays, the safe way round, as it is for a reused pid."""
    root = env.get("TMPDIR", "") or "/tmp"
    if root.endswith("/"):
        root = root[:-1]
    if not root or not os.path.isdir(root):
        return
    windows = os.name == "nt"
    uid = None if windows else os.geteuid()
    found: list[tuple[str, str]] = []
    for family in ("snap", "err", "gh", "probe", "test", "build"):
        prefix = f"pr-review-{family}."
        for path in sorted(glob.glob(os.path.join(glob.escape(root), prefix + "*"))):
            try:
                if not os.path.exists(path) or (uid is not None and os.stat(path).st_uid != uid):
                    continue
            except OSError:
                continue
            pid_text = os.path.basename(path)[len(prefix):].split(".", 1)[0]
            if pid_text.isdigit() and pid_text.isascii():
                found.append((path, pid_text))
    if not found:
        return
    live: set[str] | None = None
    if windows:
        live = _live_msys_pids(env, {pid for _, pid in found})
        if live is None:
            return
    for path, pid_text in found:
        if live is not None:
            if pid_text in live:
                continue
        else:
            try:
                os.kill(int(pid_text), 0)
                continue
            except (OSError, OverflowError, ValueError):
                pass
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            try:
                os.remove(path)
            except OSError:
                pass


@dataclass
class Polled:
    """``watch_round``'s POLLED_* globals."""

    rc: int = 0
    out: str = ""
    mark: str = ""
    head: str = ""
    on: str = ""
    on_n: int = 0
    past: str = ""
    past_n: int = 0


class Watch:
    def __init__(
        self,
        ctx: Ctx,
        pr: str,
        mark: str,
        cfg: WatchConfig,
        round_gap: int,
        threshold: str,
        nudge: bool = True,
    ) -> None:
        self.ctx = ctx
        self.pr = pr
        self.mark = mark
        self.watch_from = mark
        self.cfg = cfg
        self.round_gap = round_gap
        self.threshold = threshold
        self.clock: Clock = ctx.clock
        self.polled = Polled()
        self.saw = 0
        self.blind = 0
        self.past_seen = 0
        self.past_last = ""
        self.last_healthy_mark = mark
        self.state: State = State("unknown", None, "-", "")
        self.rounds_now = Rounds(None, "")
        self.rounds_before = Rounds(None, "")
        self.nudge = nudge
        # The heads this process posted its automatic nudge on, and when: the in-process half of
        # the once-per-head record (the feed is the other, nudge_read), which also covers a comments
        # feed that has not caught up with the post yet.
        self.own_nudges: dict[str, int] = {}
        # When this process first read each head (round()).
        self.first_seen: dict[str, int] = {}
        self.last_head = ""
        self.held_until = 0
        # The heads whose automatic nudge over a stalled round was attempted and did not go
        # through, with the failure line the window's end prints: an attempt is once per head as a
        # post is, but it buys no request grace (review of #770, round 1).
        self.stall_failed: dict[str, str] = {}

    # --- the pieces of a round -------------------------------------------------------------------

    @property
    def repo(self) -> str:
        return self.ctx.repo

    def line(self, state: State) -> str:
        return status_line(state, self.repo, self.pr)

    def drift_note(self) -> None:
        warn_base_drift(self.ctx.session, self.repo, self.pr, self.cfg.stale_base, say=_err, err=_err)

    def round(self) -> None:
        """``watch_round``: one poll, the head read after it, and the split of its items."""
        snap = self.ctx.snap
        snap.arm()
        result = poll(self.ctx, self.pr, self.mark)
        p = Polled(rc=result.rc, out=_strip(result.text), mark=self.mark)
        self.polled = p
        if p.rc != 0:
            snap.drop()
            return
        if _WATERMARK.fullmatch(result.watermark):
            p.mark = result.watermark
        head = pr_head_read(self.ctx, self.pr)
        snap.put_head(self.pr, head)
        p.head = head.sha
        if head.sha and head.sha != self.last_head:
            # From each arrival: a head that comes back (A, B, A) is a new push of it, and so is
            # any head read after one that did not read (it may have moved and come back unseen).
            self.first_seen[head.sha] = self.clock.now()
            self.last_head = head.sha
        elif not head.sha:
            self.last_head = ""
        for entry in result.items.split():
            kind = _upto(entry, ":")
            rest = _after(entry, ":")
            ident = _upto(rest, ":")
            rest = _after(rest, ":")
            commit = _upto(rest, ":")
            rest = _after(rest, ":")
            login = _upto(rest, ":")
            state = _after(rest, ":")
            desc = f"{kind} id={ident}"
            if state != "-":
                desc += f" state={state}"
            desc += f" commit={commit} by {login}"
            if item_about_head(commit, p.head):
                p.on_n += 1
                p.on = p.on or desc
            else:
                p.past_n += 1
                p.past = p.past or desc

    def note_past(self) -> None:
        p = self.polled
        if p.past_n <= 0:
            return
        self.past_seen += p.past_n
        self.past_last = p.past
        warn(
            f"PR {self.repo}#{self.pr}: {p.past_n} item(s) NOT about head {p.head[:7]} (first:"
            f" {p.past}) — printed below for the record; the watermark advances past them and the"
            " wait continues, but a thread among them left unresolved still holds an approval back"
            " from `merge`"
        )
        kept = [
            ln for ln in p.out.split("\n")
            if not ln.startswith("watermark: ") and not ln.startswith("items: ")
        ]
        sys.stdout.flush()
        sys.stderr.write("".join(f"{ln}\n" for ln in kept))
        sys.stderr.flush()

    def quiet_line(self, window: str) -> str:
        p = self.polled
        about = f"head {p.head[:7] or 'UNREAD'}"
        if p.rc != 0:
            about = "the head (the last poll did not answer)"
        out = f"no reviewer activity about {about}"
        if window != "-":
            out += f" in {window}s"
        if self.past_seen:
            out += (
                f"; {self.past_seen} item(s) about another commit scrolled past (last:"
                f" {self.past_last})"
            )
        return out

    def round_counts(self) -> None:
        self.rounds_now = review_rounds(self.ctx, self.pr, self.round_gap)
        self.rounds_before = review_rounds(
            self.ctx, self.pr, self.round_gap, mark_of(self.watch_from, 2), mark_of(self.watch_from, 3)
        )

    def rounds_trailer(self) -> str:
        return (
            f"watch-rounds: from={self.rounds_before.token()} to={self.rounds_now.token()}"
            f" threshold={self.threshold}"
        )

    def round_note(self) -> str:
        now, before = self.rounds_now, self.rounds_before
        if now.count is None or before.count is None:
            detail = before.detail if now.count is not None else now.detail
            return f" — round UNKNOWN ({detail}); read `rounds` before citing a round number"
        n, b = now.count, before.count
        past = ""
        if not _NUMBER.fullmatch(self.threshold):
            of = " (no threshold set)"
        else:
            t = int(self.threshold)
            of = f" of {t}"
            if n > t:
                if n > b + 1 and b + 1 <= t:
                    past = (
                        f"; from round {t + 1} on PAST the threshold: blocking-only there,"
                        f" rounds {b + 1}–{t} in full"
                    )
                else:
                    past = ", PAST the threshold: blocking-only from here"
        if n <= b:
            return f" — this window opened no round; rounds with findings: {n}{of}{past}"
        if n == b + 1:
            return f" — this window opened round {n}{of}{past}"
        return f" — this window opened rounds {b + 1}–{n}{of}{past}"

    def preserve_unarmed_nudge(self, pre_mark: str, previous: State | None, new: State) -> None:
        old_issue = mark_of(pre_mark, 2)
        next_issue = mark_of(self.mark, 2)
        if next_issue <= old_issue:
            return
        match new.tok:
            case "nudged":
                if previous is not None and previous.tok == "nudged" and previous.detail == new.detail:
                    return
            case "unknown":
                pass
            case _:
                return
        self.mark = f"{mark_of(self.mark, 1)},{old_issue},{mark_of(self.mark, 3)}"
        warn(
            "keeping the final poll's issue comments pending for the next watch; a new nudge may"
            " still need its grace"
        )

    def act(self, state: State) -> None:
        """``watch_act``: what the wait ended on, by name, and the round itself on stdout."""
        p = self.polled
        extra = ""
        original_mark = self.mark
        if p.on_n > 1:
            extra = f" (+{p.on_n - 1} more about this head)"
        if p.past_n != 0:
            extra += f" (+{p.past_n} about another commit, below)"
        if not p.head:
            extra += " (the head did not read this round, so nothing was held back for being old)"
        if state.tok == "nudged":
            pending = _upto(state.detail, "|")
            if _NUMBER.fullmatch(pending):
                pid = int(pending)
                if pid > 0 and mark_of(self.mark, 2) >= pid:
                    self.mark = f"{mark_of(self.mark, 1)},{pid - 1},{mark_of(self.mark, 3)}"
                    warn(
                        f"nudge {pending} remains pending; keep an observer after handling these"
                        " review items"
                    )
        elif state.tok == "unknown":
            self.preserve_unarmed_nudge(self.last_healthy_mark, None, state)
        if self.mark != original_mark:
            p.out = _drop_last_line(p.out) + f"\nwatermark: {self.mark}"
        _err(f"status: {self.line(state)}")
        self.drift_note()
        self.round_counts()
        warn(
            f"PR {self.repo}#{self.pr}: ending the wait on {p.on or 'reviewer activity'}{extra}"
            f"{self.round_note()}"
        )
        last = _last_line(p.out)
        if last.startswith("watermark: "):
            p.out = f"{_drop_last_line(p.out)}\n{self.rounds_trailer()}\n{last}"
        else:
            p.out = f"{p.out}\n{self.rounds_trailer()}"
        _say(p.out)

    def settle(self) -> int:
        """``watch_settle``: 0 nothing new; 1 a round about the head arrived; 3 no answer."""
        self.round()
        self.mark = self.polled.mark
        if self.polled.rc == 0:
            self.saw = 1
            self.blind = 0
        else:
            self.blind += 1
            return 3
        if self.polled.on_n != 0:
            return 1
        self.note_past()
        return 0

    def end(self, verdict: str, message: str, remedy: str = "") -> int:
        """``watch_end``: the final poll and state re-read before a nothing-is-coming verdict. With
        ``remedy="due"`` (the nothing-is-coming verdicts on a due head), the message gets its
        remedy, or the verdict is answered with the automatic nudge (``_NUDGED``) or held
        (``_HELD``); with ``remedy="failed-run"`` (``--no-nudge``), the message is the final read's."""
        before_settle = self.mark
        before_state = self.state
        rc = self.settle()
        where = f"PR {self.repo}#{self.pr}"
        if rc == 1:
            self.act(gated_state(self.ctx, self.pr))
            return 0
        if rc == 3:
            _say(
                f"the final poll before the '{verdict}' verdict on {where} did not answer"
                f" ({self.ctx.session.err_line()}), so nothing rules out a round that landed while"
                " the state was being read — the verdict is WITHHELD, and this window says nothing"
                " about the reviewer; re-arm"
            )
            _say(f"watermark: {self.mark}")
            return 3
        state = status_state(self.ctx, self.pr)
        self.preserve_unarmed_nudge(before_settle, before_state, state)
        state = approval_gate(self.ctx, self.pr, state)
        self.state = state
        tok = state.tok
        if tok == "unknown":
            _say(
                f"the state could not be re-read after the final poll on {where}, so the"
                f" '{verdict}' verdict is WITHHELD — {state.detail}; this is NOT 'the reviewer"
                " stayed quiet', re-arm"
            )
            _say(f"watermark: {self.mark}")
            return 3
        if tok in ("approved", "unresolved") and verdict != "approved":
            _say(
                f"the '{verdict}' verdict on {where} was dropped: the 👍 landed while it was being"
                f" read — {self.line(state)}"
            )
            _say(f"watermark: {self.mark}")
            return 0
        if tok == "nudged" and before_state.tok == "nudged" and before_state.detail != state.detail:
            _say(
                f"the '{verdict}' verdict on {where} was dropped: a newer nudge still needs its"
                " grace; re-arm"
            )
            _say(f"watermark: {self.mark}")
            return 1
        if tok != verdict:
            _say(
                f"the '{verdict}' verdict on {where} was dropped: the state moved to '{tok}' while"
                f" it was being read — {self.line(state)}; nothing here says the reviewer is done,"
                " re-arm"
            )
            _say(f"watermark: {self.mark}")
            return 1
        if remedy == "due":
            # Again on the final poll's own read: a head it read first, or a request it read, holds
            # the nudge as it would have held the loop's (review of #583, round 2).
            hold = self.nudge_hold(state)
            if hold is not None:
                self.held_until = hold
                return _HELD
            move = self.nudge_or_remedy(state, message)
            if move is None:
                return _NUDGED
            if isinstance(move, int):
                self.held_until = move
                return _HELD
            message += move
        elif remedy == "stalled":
            message = self.stall_remedy()
        elif remedy == "failed-run":
            # --no-nudge on a failed run: the remedy is the FINAL read's, since a request landing
            # in the final poll turns `run` into `run-again`, whose line names the move itself.
            fsha, _, rest = state.detail.partition("|")
            message = (
                f"--no-nudge: the watch did not re-request the failed run on head {fsha}; post it"
                f" yourself (pr-review.sh comment {self.repo}#{self.pr} '@codex review')"
                if rest.startswith("run|") else ""
            )
        self.drift_note()
        if message:
            _say(message)
        _say(f"{self.quiet_line('-')}; status: {self.line(state)}")
        _say(f"watermark: {self.mark}")
        return 0

    def stall_hold(self, read: NudgeRead) -> int | None:
        """Until when a stalled round's nudge is held rather than posted or advised (review of
        #770, round 2), as ``nudge_hold`` holds the ``expected`` one: while this watch has seen the
        head for less than ``PICKUP`` (a push under an old head's hung 👀 reads stalled at once),
        and while a request standing on the head is younger than its grace."""
        head = self.polled.head
        if not head:
            return None
        now = self.clock.now()
        hold = self.first_seen.get(head, now) + min(PICKUP, self.cfg.grace)
        if hold > now:
            return hold
        match read:
            case NudgeBarred(asked=asked) if asked:
                age = age_of(asked, self.clock.time())
                if age is not None and age < self.cfg.grace:
                    return now + self.cfg.grace - age
                return None
            case NudgeBarred() | NudgeClear():
                return None
            case _:
                assert_never(read)

    def stall_nudge(self, read: NudgeRead) -> str | None:
        """The automatic '@codex review' over a stalled round (ludics-lite#760): None when it was
        posted, else why not. Posted only when ``stall_nudge_read`` finds nothing standing for the
        head and the write gate reads the PR open, on that same head. It is sent once whatever its
        error (it may have landed): a post is recorded in ``own_nudges``, a failed one in
        ``stall_failed``, and a head in either is never attempted again."""
        match read:
            case NudgeBarred(why=why):
                return why
            case NudgeClear(head=head):
                if head in self.own_nudges or head in self.stall_failed:
                    return f"this watch already nudged head {head[:7]}"
                pr_state, now_head = self.write_gate()
                if pr_state != "open":
                    return f"the PR reads {pr_state or 'UNREAD'}, not open"
                if now_head != head:
                    return "the head moved while the nudge was being read"
                posted, post_err = self.post_request()
                if not posted:
                    self.stall_failed[head] = (
                        f"the automatic '@codex review' over the stalled round on head {head[:7]} did"
                        f" not go through ({post_err}): read the PR's comments before posting it by"
                        " hand, since a request that failed ambiguously may have landed"
                    )
                    return self.stall_failed[head]
                self.own_nudges[head] = self.clock.now()
                warn(
                    f"PR {self.repo}#{self.pr}: posted '@codex review' on head {head[:7]} — the round"
                    " on it STALLED, with no 👍, no verdict and no request on the head; one automatic"
                    " nudge per head (--no-nudge turns it off), watching for the round it asks for"
                )
                return None
            case _:
                assert_never(read)

    def stall_remedy(self) -> str:
        """What a stall still standing at the window's end says to do, from the final read."""
        failed = self.stall_failed.get(self.polled.head)
        if failed is not None:
            return failed
        own = self.own_nudge()
        if own is not None:
            return (
                f"this watch's own '@codex review' on head {self.polled.head[:7]},"
                f" {fmt_age(self.clock.now() - own)} ago, drew no finished round, and a second is"
                f" never posted automatically: {_NEW_HEAD}"
            )
        flag = "" if self.nudge else "--no-nudge: "
        read = stall_nudge_read(self.ctx, self.pr)
        if self.stall_hold(read) is not None:
            # Inside the pickup margin or a standing request's grace: what holds the automatic
            # nudge holds the advice too (review of #770, round 2).
            return (
                f"{flag}not nudged yet — head {self.polled.head[:7]} is new to this watch, or a"
                " request on it is still inside its grace, and the round it may draw has not had"
                " its time: re-arm the watch before any nudge"
            )
        match read:
            case NudgeBarred(why=why, asked=asked) if asked:
                return f"{flag}not nudged — {why}, so no second one: {_NEW_HEAD}"
            case NudgeBarred(why=why):
                return (
                    f"{flag}not nudged — {why}. Read the PR feed (retry --read pr view <pr>"
                    " --comments) before any move; never re-request while a 👍 may stand"
                )
            case NudgeClear(head=head):
                pr_state, now_head = self.write_gate()
                if pr_state != "open" or now_head != head:
                    # The automatic write's own gate, so the advice never asks for a post the
                    # watch would have refused (review of #770, round 2).
                    moved = "the head moved" if pr_state == "open" else f"the PR reads {pr_state or 'UNREAD'}"
                    return (
                        f"{flag}not nudged — {moved}, not an open PR on head {head[:7]}: deal with"
                        " that first, then re-arm the watch"
                    )
                return (
                    f"{flag}the watch did not nudge the stalled round on head {head[:7]}; nothing"
                    " stands for it (no 👍, no verdict, no request since it arrived), so post it"
                    f" once (pr-review.sh comment {self.repo}#{self.pr} '@codex review') and re-arm"
                    " the watch"
                )
            case _:
                assert_never(read)

    def own_nudge(self) -> int | None:
        """When this process nudged the head the last round read, if it did."""
        head = self.polled.head
        return self.own_nudges.get(head) if head else None

    def nudge_or_remedy(self, state: State, verdict: str) -> str | int | None:
        """The remedy a due head's verdict prints, or None when the watch posted the nudge itself
        (on an ``expected`` head only: a ``nudged`` one has a request pending, and an ``idle`` one
        the reviewer's word), or the time to hold to when the head moved under the write gate."""
        where = f"PR {self.repo}#{self.pr}"
        failed = self.stall_failed.get(self.polled.head)
        if failed is not None:
            # This process already attempted the head's one request, over its stall.
            return f" — {failed}"
        own = self.own_nudge()
        if own is not None:
            return (
                f" — this watch's own '@codex review' on head {self.polled.head[:7]},"
                f" {fmt_age(self.clock.now() - own)} ago, drew no review, and a second is never posted"
                f" automatically: {_NEW_HEAD}"
            )
        if self.nudge and state.tok == "nudged":
            # A request stood on the head through its grace and drew nothing: the once-per-head
            # remedy, as for one below the watermark (review of #583, round 6).
            return f" — a '@codex review' request on this head drew no review in its grace, so no second one: {_NEW_HEAD}"
        if not self.nudge or state.tok != "expected":
            return _ADVICE
        if state.merge in ("dirty", "draft"):
            return (
                " — not nudged automatically: a review of this head cannot land it until the"
                " status below is dealt with (a draft marked ready, a conflict merged), so take"
                " that move first"
            )
        read = nudge_read(self.ctx, self.pr)
        match read:
            case NudgeBarred(why=why, asked=asked) if asked:
                return f" — {why}, so the watch posts no second one: {_NEW_HEAD}"
            case NudgeBarred(why=why):
                return f" — not nudged automatically ({why}); consider nudging with a '@codex review' comment"
            case NudgeClear(head=head):
                pr_state, now_head = self.write_gate()
                if pr_state != "open":
                    return (
                        f" — not nudged automatically: the PR reads {pr_state or 'UNREAD'}, not open"
                    )
                if now_head != head:
                    # A push since the nudge's read: that head starts its own pickup margin.
                    if now_head:
                        self.last_head = now_head
                        self.first_seen[now_head] = self.clock.now()
                    return self.clock.now() + min(PICKUP, self.cfg.grace)
                # Recorded before the post: it is sent once whatever its error (it may have landed).
                self.own_nudges[head] = self.clock.now()
                posted, post_err = self.post_request()
                if not posted:
                    return (
                        f" — the automatic '@codex review' nudge for head {head[:7]} did not go"
                        f" through ({post_err}): read the PR's comments before posting it by hand,"
                        " since a request that failed ambiguously may have landed"
                    )
                warn(
                    f"{where}: posted '@codex review' on head {head[:7]} — {verdict}, with no"
                    " review, no verdict, no 👍 and no request on it; one automatic nudge per head"
                    " (--no-nudge turns it off), watching for the round it asks for"
                )
                return None
            case _:
                assert_never(read)

    def write_gate(self) -> tuple[str, str]:
        """The PR's state as the automatic write's last gate reads it fresh, and its head (review
        of #583, rounds 3 to 5: a PR closed, merged, made a draft or conflicted mid-watch is still
        `expected`, and a push between the nudge's read and its post would be nudged unheld). The
        state is ``open`` only for an open, non-draft PR whose mergeability is not ``dirty`` or
        ``draft``; otherwise it names what it is, "" unread."""
        result = self.ctx.session.retry(
            "read",
            [
                "api", f"repos/{self.repo}/pulls/{self.pr}", "--jq",
                '[(.state // "-"), (.head.sha // "-"), (.draft | tostring), (.mergeable_state // "-")] | @tsv',
            ],
        )
        match result:
            case GhOk(stdout=out):
                fields = (out.strip().split("\t") + ["", "", "", ""])[:4]
                state, head, draft, merge = fields
                head = "" if head in ("", "-") else head
                if state == "-" or not state:
                    return "", head
                if state == "open" and draft == "true":
                    return "a draft", head
                if state == "open" and merge in ("dirty", "draft"):
                    return f"open but mergeable_state={merge}", head
                return state, head
            case GhFailed() | GhUnanswered():
                return "", ""
            case _:
                assert_never(result)

    def nudge_hold(self, state: State) -> int | None:
        """Until when a due head's verdict is held rather than given, when it is: the watch would
        nudge it (``nudge_or_remedy``) but has seen the head for less than ``PICKUP``, or a request
        on the head is younger than its grace. Read before ``end`` and its final poll, from the
        round's own snapshot; ``end`` decides the nudge afresh."""
        head = self.polled.head
        if (
            not self.nudge or state.tok != "expected" or state.merge in ("dirty", "draft")
            or not head or self.own_nudge() is not None or head in self.stall_failed
        ):
            return None
        now = self.clock.now()
        hold = self.first_seen.get(head, now) + min(PICKUP, self.cfg.grace)
        if hold > now:
            return hold
        read = nudge_read(self.ctx, self.pr)
        match read:
            case NudgeBarred(asked=asked) if asked:
                age = age_of(asked, self.clock.time())
                if age is not None and age < self.cfg.grace:
                    return now + self.cfg.grace - age
                return None
            case NudgeBarred() | NudgeClear():
                return None
            case _:
                assert_never(read)

    def grace_deadline(self, state: State) -> int | None:
        if state.tok not in ("reviewing", "nudged") or state.age is None:
            return None
        return self.clock.now() + self.cfg.grace - state.age

    def post_request(self) -> tuple[bool, str]:
        """The watch's one write, ATTEMPTED ONCE: a gateway refusal that did land would otherwise
        be a second review run nobody asked for (review of #465, round 4). Returns whether it
        posted, and its error line, which the failure message quotes. The shell's gh_err_line
        quoted the LAST FAILED call's error: the post's when the drift read after it succeeded,
        but the drift read's own when that failed too (its command substitutions wrote the shared
        err file). That message says the re-request did not go through, so it quotes the
        re-request's error either way; the drift read's is on stderr in its own UNKNOWN line."""
        session = self.ctx.session
        saved = session.config
        session.config = replace(saved, api_attempts=1)
        try:
            result = session.retry(
                "write",
                [
                    "api", "-X", "POST", f"repos/{self.repo}/issues/{self.pr}/comments", "-f",
                    f"body={_REQUEST_BODY}", "--jq", ".html_url",
                ],
                include=True,
            )
        finally:
            session.config = saved
        return isinstance(result, GhOk), session.err_line()

    # --- the loop ------------------------------------------------------------------------------------

    def run(self) -> int:
        ctx = self.ctx
        cfg = self.cfg
        pr = self.pr
        where = f"PR {self.repo}#{pr}"
        interval, timeout = cfg.interval, cfg.timeout
        start = self.clock.now()
        quiet = 0
        extension_end: int | None = None
        extension_kind = ""
        extension_mark = ""
        rerequested = ""
        rerequest_end: int | None = None
        last_key: str | None = None
        last_pause: int | None = None
        ctx.nudge_after = mark_of(self.mark, 2)
        # The review observer of this PR (the polling budget, budget.py), which may wait a quota
        # hold out within its window.
        budget = ctx.session.budget
        if budget is not None:
            budget.observer_claim("review", self.repo, pr)
            budget.wait_until = self.clock.now() + timeout
        cap = budget.review_cap if budget is not None else interval

        self.state = status_state(ctx, pr)
        was = self.state.tok
        candidate_end = self.grace_deadline(self.state)
        candidate_kind: str = was
        _err(
            f"watching {where}, every {interval}s for up to {timeout}s; from:"
            f" {self.line(self.state)}"
        )

        while True:
            self.round()
            self.mark = self.polled.mark
            if self.polled.rc == 0:
                self.saw = 1
                self.blind = 0
            else:
                self.blind += 1

            state = gated_state(ctx, pr)
            tok = state.tok
            if tok == "failed":
                fkind = _cut_f12(state.detail)
                if _after(fkind, "|") == "run" and rerequested != _upto(fkind, "|"):
                    ctx.snap.drop()
                    state = gated_state(ctx, pr)
                    tok = state.tok
                    if _cut_f12(state.detail) != fkind:
                        warn(
                            f"{where}: not re-requesting the failed run on {_upto(fkind, '|')} — a"
                            f" fresh read says: {self.line(state)}"
                        )
            self.state = state
            age = state.age
            if tok != "unknown":
                if not (was == "reviewing" and tok != "reviewing" and tok != "nudged" and quiet == 0):
                    candidate_end = self.grace_deadline(state)
                    candidate_kind = tok
                self.last_healthy_mark = self.mark
            own = self.own_nudge()
            if own is not None and candidate_end is None:
                # The automatic nudge's grace, while the feed has not caught up with it.
                candidate_end = own + cfg.grace
                candidate_kind = "nudged"

            if self.polled.on_n > 0:
                self.act(state)
                return 0
            self.note_past()
            warn(f"{where}: {self.line(state)}")

            match tok:
                case "unknown":
                    warn(f"state unreadable this round on {where}; holding '{was}'")
                case "approved" | "unresolved":
                    _say(self.line(state))
                    _say(f"watermark: {self.mark}")
                    return 0
                case "stalled":
                    # Not a verdict yet (ludics-lite#760): nudge once when nothing stands for the
                    # head, else keep waiting; the window's end answers a stall still standing. A
                    # round whose poll did not answer posts nothing: it may have missed a round.
                    # Nor does a head this watch has seen for less than PICKUP: a 👀 is a level, so
                    # a push under an old head's hung 👀 reads STALLED at once, before the
                    # reviewer's own review of the push has had time to start (#770's own head
                    # 1af99c3, 81 minutes "stalled" on the 👀 its predecessor's round left up).
                    # Held, the window stays open to the hold, as for the expected nudge.
                    if self.nudge and own is None and self.polled.rc == 0 and self.polled.head:
                        read = stall_nudge_read(ctx, pr)
                        hold = self.stall_hold(read)
                        if hold is not None:
                            if candidate_end is None or candidate_end < hold:
                                candidate_end = hold
                                candidate_kind = "nudged"
                            if extension_end is not None and extension_end < hold:
                                extension_end = hold
                                extension_kind = "nudged"
                        elif self.stall_nudge(read) is None:
                            candidate_end = self.clock.now() + cfg.grace
                            candidate_kind = "nudged"
                            if extension_end is not None:
                                extension_end = candidate_end
                                extension_kind = "nudged"
                            was = "nudged"
                            quiet = 0
                case "failed":
                    detail = state.detail
                    fsha = _upto(detail, "|")
                    fkind = _upto(_after(detail, "|"), "|")
                    if fkind == "run" and rerequested != fsha and not self.nudge:
                        return self.end(tok, "", remedy="failed-run")
                    if fkind == "run" and rerequested != fsha:
                        posted, post_err = self.post_request()
                        if posted:
                            rerequested = fsha
                            rerequest_end = self.clock.now() + cfg.grace
                            candidate_end = rerequest_end
                            candidate_kind = "nudged"
                            warn(
                                f"{where}: re-requested the review with '@codex review' — the run"
                                f" on head {fsha} failed with no review and no 👍 to clear;"
                                " watching for the new round"
                            )
                        else:
                            self.drift_note()
                            _say(
                                f"the '@codex review' re-request for the failed run on head {fsha}"
                                f" did not go through ({post_err}) — read the PR's"
                                " comments before posting it by hand, since a request that failed"
                                " ambiguously may have landed"
                            )
                            _say(f"status: {self.line(state)}")
                            _say(f"watermark: {self.mark}")
                            return 0
                        was = tok
                        quiet = 0
                    elif fkind == "run":
                        candidate_end = rerequest_end
                        candidate_kind = "nudged"
                        was = tok
                        quiet = 0
                    else:
                        return self.end(tok, "")
                case "reviewing" | "expected" | "idle" | "nudged":
                    verdict = ""
                    if was == "reviewing" and tok != "reviewing" and tok != "nudged":
                        quiet += 1
                        if quiet >= 2:
                            verdict = (
                                f"the 👀 round on {where} ended without a review of the head commit"
                            )
                    else:
                        quiet = 0
                        was = tok
                    if (
                        not verdict
                        and tok in ("expected", "nudged")
                        and not (was == "reviewing" and quiet == 1)
                    ):
                        # A head this watch nudged is due from its own request, whatever the feed
                        # says yet.
                        due = age
                        if own is not None:
                            due = min(due, self.clock.now() - own) if due is not None else self.clock.now() - own
                        if due is not None and due >= cfg.grace:
                            verdict = (
                                f"no review materialized on {where} in the {fmt_age(due)} since it"
                                " became due"
                            )
                    hold = self.nudge_hold(state) if verdict else None
                    if verdict and hold is None:
                        rc = self.end(tok, verdict, remedy="due")
                        if rc == _HELD:
                            hold = self.held_until
                        elif rc != _NUDGED:
                            return rc
                        else:
                            # The request's grace is the next window; it replaces a deadline already
                            # fixed, once per head, since the request is a new one.
                            candidate_end = self.clock.now() + cfg.grace
                            candidate_kind = "nudged"
                            if extension_end is not None:
                                extension_end = candidate_end
                                extension_kind = "nudged"
                            was = "nudged"
                            quiet = 0
                    if hold is not None:
                        # Held: the window stays open to the hold, as it does for a fresh nudge, an
                        # extension already running included (each hold is bounded: the pickup
                        # margin from a head's first sight, a request's grace from its post).
                        if candidate_end is None or candidate_end < hold:
                            candidate_end = hold
                            candidate_kind = "nudged"
                        if extension_end is not None and extension_end < hold:
                            extension_end = hold
                            extension_kind = "nudged"
                case _:
                    assert_never(tok)

            # The budget's pause: back to the interval after a round whose state moved, doubling
            # toward the review cap while it does not. Moved is the token, the head or the state's
            # detail -- never its age, which moves on every read (ludics-lite#551: a new head inside
            # one token was read at the doubled pause).
            key = "\t".join((tok, self.polled.head, state.detail))
            pause = budget_pause(interval, cap, last_pause, key != last_key)
            last_key = key
            last_pause = pause
            # A pause the budget GREW past the window's end is cut to it, so the budget never ends
            # a window earlier than the fixed interval would have: its last read is at the window's
            # end, not up to a whole cap before it. A pause still at the interval keeps the
            # fixed-interval rule.
            now = self.clock.now()
            remaining = timeout - (now - start)
            if pause > interval and 0 < remaining < pause:
                pause = remaining
            if now - start + pause > timeout:
                if candidate_end is None:
                    break
                if extension_end is None:
                    remaining = candidate_end - now
                    if remaining <= 0:
                        break
                    extension_end = candidate_end
                    extension_kind = candidate_kind
                    extension_mark = self.mark
                    warn(
                        "extending watch for the live review or fresh nudge, at most"
                        f" {remaining}s beyond this poll"
                    )
                if extension_kind == "nudged" and candidate_kind == "reviewing":
                    extension_end = candidate_end
                    extension_kind = "reviewing"
                    warn("review started after the nudge; handing off to its fixed live-review deadline")
                remaining = extension_end - self.clock.now()
                if remaining <= 0:
                    break
                if pause > remaining:
                    pause = remaining
            self.clock.sleep(pause)

        if self.state.tok == "stalled":
            return self.end("stalled", "", remedy="stalled")
        if self.settle() == 1:
            self.act(gated_state(ctx, pr))
            return 0
        if mark_of(self.mark, 2) > mark_of(self.last_healthy_mark, 2):
            final_state = status_state(ctx, pr)
            self.preserve_unarmed_nudge(self.last_healthy_mark, self.state, final_state)
        if extension_mark and mark_of(self.mark, 2) > mark_of(extension_mark, 2):
            self.mark = f"{mark_of(self.mark, 1)},{mark_of(extension_mark, 2)},{mark_of(self.mark, 3)}"
            warn("comments after the fixed grace began remain pending; re-arm to observe any newer request")
        if self.saw == 0:
            _say(
                f"could not read {where} for the whole {timeout}s window — NOT the same as quiet;"
                " nothing was observed, so re-arm the watch rather than concluding the reviewer is"
                " silent"
            )
            _say(f"watermark: {self.mark}")
            return 3
        if self.blind > 0:
            _say(
                f"the last {self.blind} poll(s) of the {timeout}s window on {where} did not answer,"
                " so the tail of this window was NOT observed — nothing here says the reviewer"
                " stayed quiet; re-arm"
            )
            _say(f"watermark: {self.mark}")
            return 3
        elapsed = timeout if extension_end is None else self.clock.now() - start
        _say(f"{self.quiet_line(str(elapsed))}; status: {self.line(self.state)}")
        _say(f"watermark: {self.mark}")
        return 1


def run(session: GhSession, args: list[str], env: Mapping[str, str] | None = None) -> int:
    e = dict(os.environ) if env is None else env
    cfg = load_watch_config(e)
    tmp_sweep_stale(e)
    if not args or not args[0]:
        # The shell's `${1:?usage: ...}`: bash's own message, and its exit status 1.
        sys.stdout.flush()
        sys.stderr.write("pr-review.sh: 1: usage: watch <pr> [watermark] [--no-nudge]\n")
        return 1
    nudge = "--no-nudge" not in args[1:]
    rest = [a for a in args[1:] if a != "--no-nudge"]
    # A misspelt opt-out must not leave the writes on: anything but one watermark is refused.
    for a in rest:
        if a.startswith("-"):
            die(f"watch: unknown option '{a}' (usage: watch <pr> [watermark] [--no-nudge])")
    if len(rest) > 1:
        die(f"watch: one watermark at most, got {len(rest)} arguments after the PR")
    mark = rest[0] if rest else ""
    target = pr_arg(args[0], session.config.repo)
    cfg = with_window(cfg, e)
    threshold = "off" if session.config.round_threshold is None else str(session.config.round_threshold)
    ctx = Ctx(session, target.repo, session.config.reviewer, clock_from_env(e), cfg.stall)
    return Watch(ctx, target.num, mark, cfg, session.config.round_gap, threshold, nudge).run()
