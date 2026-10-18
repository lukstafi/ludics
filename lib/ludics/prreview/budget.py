"""The polling budget (ludics-lite#543): the pause, the quota hold and the one observer per PR.

Ported from pr-review.sh's "the polling budget" section (``budget_*``, ``quota_failure``,
``hold_read``/``hold_set``/``hold_lift``, ``lock_take``/``lock_reap``, ``observer_*``; main at
c3de596). On 2026-10-04 a parallel OCANNL wave exhausted the account's REST quota while approved
heads waited for hosted macOS runners. Every ``merge --wait`` re-read each minute, a quota 403
ended it with exit 3, and its caller armed another, so the reads went on. The recovery used three
policies, and this module turns them into the one mechanism every observer here shares (``watch``,
``checks --wait``, ``merge --wait``, ``retry run watch``). issue-wave reaches GitHub only through
pr-review.sh, so its waves use it too:

1. THE PAUSE. An observer's first read is immediate, and so is the first read after one that saw a
   change. Each read that saw nothing new doubles the pause, from the command's own interval
   (WATCH_INTERVAL, SHIP_PR_CHECKS_INTERVAL) up to its kind's cap: SHIP_PR_REVIEW_POLL_CAP (300)
   for a review, SHIP_PR_BUILD_POLL_CAP (600) for a build. Those are the 10-04 recovery's
   intervals, reached only by a queue that is not moving. A cap at or below the interval keeps the
   interval fixed.
2. THE HOLD. A call GitHub refuses on QUOTA sets one hold for every pr-review.sh process that
   shares this state directory (the user's, on this host), and no call is made while it stands.
   When it ends is read from the FAILING ENDPOINT's own response headers, by one ``gh api -i``
   probe of that endpoint: Retry-After, or else X-RateLimit-Reset when X-RateLimit-Remaining is 0.
   It is never read from /rate_limit, which disagreed with the failing endpoint during the
   incident. A response with neither header holds for a minute, doubling on each repeat, and so
   does a probe that answers: it is a GET or GraphQL's viewer query, and a secondary limit on the
   refused operation itself need not show on it. A standing hold is only ever extended, never
   shortened, by a later refusal (each refusal adds its own entry; see ``hold_read``). Once the
   hold has ended, ONE process probes the same endpoint again, and the hold lifts only when that
   endpoint answers. A quota answer sets the next hold from its own headers. An observer (a
   command with a wait ceiling) waits a hold out within its ceiling, then repeats the READ the
   quota stopped. A write never waits, since it would act on reads the hold made stale, and every
   other command returns 3 at once, without a call.
3. THE OBSERVER. One observer per PR and kind (review: ``watch``; build: ``checks --wait`` and
   ``merge --wait``). A second is refused with exit 2, naming the first's pid, rather than
   doubling the reads. A holder that is no longer running is replaced.

A quota failure is never the API's answer about the PR. ``GhSession.retry`` returns
``GhUnanswered`` (exit 3) for it, read or write, so it reads as UNKNOWN everywhere and can never
permit a merge.

BOUNDARY. The quota reader is a fail-closed ALLOWLIST over the FIRST line of gh's stderr, with
these shapes: ``API rate limit exceeded`` or ``API rate limit already exceeded`` (the primary limit,
in its REST and GraphQL spellings), ``secondary rate limit``, and ``(HTTP 429)``; and two BODILESS
shapes (ludics-lite#612): go-gh's whole line ``HTTP 403 (<url>)`` or ``HTTP 429 (<url>)`` (gh's own
commands, on an error status with no readable body), and a 403 or 429 an own ``gh api`` call's
``--include`` status line names when gh could not read the body (core.py's
``gh_unreadable_answer`` boundary). A 403 with any message is still the API's answer. The probe reads its own answer: the headers up to the
first blank line, and the body after it in ``quota_failure``'s words (GraphQL answers an exhausted
quota with a 200). A probe addresses the call's own endpoint: the one positional of ``api``,
``repos/<repo>/actions/runs/<id>`` (or ``.../jobs/<id>`` with ``--job``) for ``run view``, and
``graphql`` for every other gh command, since gh's pr and issue commands ride GraphQL, which has its
own quota. A call whose endpoint cannot be told sets no hold. The budget covers this script's OWN
calls, and they go to github.com alone: a GH_HOST naming another server, or a run await whose -R
names one (HOST/OWNER/REPO), is refused with exit 2 before any call (ludics-lite#551; it used to put
the calls silently outside the budget), and every probe names github.com. A ``retry`` caller's call
(any host, repository or command form gh accepts) is neither gated, held nor refused. A gate round that waited a hold out between its reads is read again whole
(``Gate.check``), and nothing after ``merge``'s gate waits a hold out at all; ``watch`` rounds are
not re-read (an approval it reports still goes through that gate). The hold is per state
directory, not per account: another host learns of the quota from its own first refusal. And one
state directory serves ONE credential: the hold is that token's quota, so a second token on the
same host (a GH_TOKEN of its own) sets a SHIP_PR_STATE_DIR of its own. Every gh call passes the
hold's gate: the session's, and ``repo_from_cwd``'s ``gh repo view``. An observer counts as live
while its pid runs, so a pid the OS has reused reads as live until that process ends. Under Git Bash
that pid is an MSYS pid, whoever wrote it, and only bash's ``kill -0`` reads it (``pid_alive``). The refusal
names the pid. Two processes replacing one dead lock at the same moment are kept apart by
``lock_reap``; a third arriving in that same window can still make two observers, which costs
duplicate reads and never a verdict.

THE STATE DIRECTORY is shared by every pr-review.sh on the host, whatever its version (the shell's
budget on main, this port), so its format is the shell's, byte for byte:

  quota-holds/<until>.<unique>   one hold entry: "<endpoint> TAB <length> TAB <why>" and a newline,
                                 written aside (``.new.<unique>``) and renamed in
  quota-last                     "<epoch> TAB <length>": the last lifted hold, for the doubling
  quota-probe/owner              the probe lock: "<pid>" and "<epoch taken>", one per line
  observers/<owner~repo#n.kind>/owner
                                 an observer lock, the same two lines (the key lowercased)
"""

import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from ludics import proc
from ludics.prreview.clock import Clock
from ludics.prreview.core import die, quota_failure, warn
from ludics.prreview.knobs import poll_caps

GITHUB = "github.com"
# The forward's name for the shell's resolved BUDGET_DIR (PY_FORWARD_VARS): set, even empty, it is
# the directory (empty: a fixture suite that named none, so no budget at all).
ENV_BUDGET_DIR = "LUDICS_PR_BUDGET_DIR"

_DIGITS = re.compile(r"[0-9]+")


def pause(base: int, cap: int, prev: int | None, changed: bool) -> int:
    """``budget_pause <interval> <cap> <previous pause> <changed>``: the next pause. The interval
    after a change (or first); otherwise the previous pause doubled, up to the cap. A cap below the
    interval is the interval."""
    if cap < base:
        cap = base
    if changed or prev is None:
        return base
    return min(prev * 2, cap)


# `gh api`'s value-taking options, whose value is not the endpoint.
_API_VALUED = frozenset(
    "-X --method -f --raw-field -F --field -H --header -q --jq -t --template -p --preview --cache"
    " --hostname --input".split()
)
# `gh run view`'s, as `gh run view --help` lists them, so `--json status` is not read as the id.
_RUN_VALUED = frozenset("--json --jq -q --template -t --attempt -a".split())


def endpoint(args: Sequence[str], gh_repo: str = "") -> str:
    """``budget_endpoint``: the endpoint a call addresses (see BOUNDARY), "" when it cannot be told.
    ``gh_repo`` is GH_REPO, which gh reads when no -R names a repository."""
    first = args[0] if args else ""
    if first == "api":
        skip = False
        for a in args[1:]:
            if skip:
                skip = False
                continue
            if a in _API_VALUED:
                skip = True
            elif a.startswith("-"):
                continue
            else:
                return a[1:] if a.startswith("/") else a
        return ""
    if first == "run":
        if (args[1] if len(args) > 1 else "") != "view":
            return "graphql"
        repo = run_id = job = ""
        pending = ""
        for a in args[2:]:
            if pending == "repo":
                repo, pending = a, ""
                continue
            if pending == "job":
                job, pending = a, ""
                continue
            if pending == "value":
                pending = ""
                continue
            if a in ("--repo", "-R"):
                pending = "repo"
            elif a.startswith("--repo="):
                repo = a[len("--repo="):]
            elif a in ("--job", "-j"):
                pending = "job"
            elif a.startswith("--job="):
                job = a[len("--job="):]
            elif a in _RUN_VALUED:
                pending = "value"
            elif a.startswith("-"):
                continue
            elif not run_id:
                run_id = a
        repo = repo or gh_repo
        if not repo:
            return ""
        if repo.startswith(f"{GITHUB}/"):
            repo = repo[len(GITHUB) + 1:]
        if job:
            return f"repos/{repo}/actions/jobs/{job}"
        if run_id:
            return f"repos/{repo}/actions/runs/{run_id}"
        return ""
    return "graphql"


def at(epoch: int | str) -> str:
    """``budget_at``: an epoch as the hold's messages print it, HH:MM:SSZ."""
    text = str(epoch)
    if not _DIGITS.fullmatch(text):
        return f"epoch {text}"
    try:
        return time.strftime("%H:%M:%SZ", time.gmtime(int(text)))
    except (OverflowError, OSError, ValueError):
        return f"epoch {text}"


def _first_line(path: str) -> str:
    """``sed -n 1p <file>``: "" when the file cannot be read."""
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return f.readline().rstrip("\n")
    except OSError:
        return ""


def _second_line(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            f.readline()
            return f.readline().rstrip("\n")
    except OSError:
        return ""


def _tab_read(path: str, n: int) -> list[str] | None:
    """``IFS=$'\\t' read -r a b ... <file``: the first line's tab-separated fields (runs of tabs as
    one separator, the last field taking the rest), or None where ``read`` failed -- no file, or a
    first line with no newline after it."""
    try:
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            line = f.readline()
    except OSError:
        return None
    if not line.endswith("\n"):
        return None
    line = line[:-1].strip("\t")
    parts = re.split(r"\t+", line, maxsplit=n - 1) if line else []
    return parts + [""] * (n - len(parts))


def pid_alive(pid_text: str) -> bool:
    """``kill -0 <pid>``: is the process that took a lock still running?

    Under Git Bash (a native Python) every lock names an MSYS pid: the shell's holders write their
    own, and this port writes ``proc.own_pid``. MSYS numbers its processes apart from Windows, so
    a pid is live when bash's ``kill -0`` reaches it, and Windows is not asked: a Windows process
    of the same number is an unrelated one (an svchost.exe read a dead holder as live, ludics-lite
    run 38235190240), and ``os.kill(pid, 0)`` there TERMINATES whatever process has that number.
    A reused pid reads as live, which the BOUNDARY already accepts."""
    if not _DIGITS.fullmatch(pid_text):
        return False
    pid = int(pid_text)
    if sys.platform == "win32":
        return _bash_pid_alive(pid_text)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (OSError, OverflowError, ValueError):
        return False
    return True


def _bash_pid_alive(pid_text: str) -> bool:
    bash = os.environ.get(proc.BRIDGE_SHELL, "") or "bash"
    try:
        done = proc.run_tool(bash, ["-c", 'kill -0 "$1" 2>/dev/null', "bash", pid_text],
                             stdin=subprocess.DEVNULL)
    except OSError:
        return False
    return done.rc == 0


@dataclass(frozen=True)
class Hold:
    """``hold_read``'s HOLD_UNTIL, HOLD_EP, HOLD_LEN and HOLD_SRC."""

    until: int
    ep: str
    length: int
    src: str


@dataclass(frozen=True)
class Lock:
    """``lock_take``'s answer: 0 taken (or already this process's), 1 a live process holds it
    (``holder``, ``since``), 2 it cannot be taken at all."""

    rc: int
    holder: str = ""
    since: str = ""


type Runner = Callable[[str, Sequence[str]], proc.Completed]


class Budget:
    """One command's share of the budget: the state directory, and what this process is waiting
    within (``wait_until``, from ``wait_from``) -- BUDGET_DIR, BUDGET_WAIT_UNTIL, BUDGET_WAIT_FROM,
    BUDGET_HOST and BUDGET_OBSERVER in the shell. An empty directory is no budget: every hold and
    lock is a no-op, as a fixture suite that names none gets."""

    def __init__(
        self,
        directory: str,
        clock: Clock,
        *,
        review_cap: int = 300,
        build_cap: int = 600,
        env: Mapping[str, str] | None = None,
        run: Runner | None = None,
        pid: int | None = None,
        alive: Callable[[str], bool] = pid_alive,
    ) -> None:
        self.dir = directory
        self.clock = clock
        self.review_cap = review_cap
        self.build_cap = build_cap
        self.env: Mapping[str, str] = os.environ if env is None else env
        self._run: Runner = run if run is not None else proc.run_tool
        self.pid = proc.own_pid() if pid is None else pid
        self._alive = alive
        self.wait_until: int | None = None
        self.wait_from: int | None = None
        # A host the calls NAME (the run await's HOST/OWNER/REPO): GH_HOST applies only when none is.
        self.host = ""
        self.observer = ""
        # ``budget_waited``: a read of this process waited a hold out since the last reset.
        self.waited = False

    # --- paths ---

    @property
    def holds_dir(self) -> str:
        return os.path.join(self.dir, "quota-holds")

    @property
    def probe_lock(self) -> str:
        return os.path.join(self.dir, "quota-probe")

    @property
    def last_file(self) -> str:
        return os.path.join(self.dir, "quota-last")

    # --- scope and waiting ---

    def in_scope(self) -> bool:
        """``budget_scope`` for one of this script's own calls: is its host github.com? The named
        host, else GH_HOST, which gh uses only when no host is named."""
        host = self.host or self.env.get("GH_HOST", "") or GITHUB
        return host == GITHUB

    def require_github(self) -> None:
        """Refuse (exit 2) one of this script's own calls bound for another host, before it is sent
        (ludics-lite#551). Such a call used to go out silently outside the budget -- no hold, no
        observer's wait -- and the fleet reaches no other host; one clear refusal says so instead."""
        if self.in_scope():
            return
        if self.host:
            die(
                f"the repository is named on {self.host} (HOST/OWNER/REPO), and pr-review.sh's own",
                "calls go to github.com alone: its polling budget (the quota hold every process on the",
                "host shares, ludics-lite#543) covers no other server. Name it as owner/name. Nothing",
                "was sent.",
            )
        die(
            f"GH_HOST names {self.env.get('GH_HOST', '')}, and pr-review.sh's own calls go to github.com",
            "alone: its polling budget (the quota hold every process on the host shares,",
            "ludics-lite#543) covers no other server. Unset GH_HOST, or set it to github.com. Nothing",
            "was sent.",
        )

    def waiting(self) -> bool:
        """Is this command an observer still inside its ceiling?"""
        return self.wait_until is not None and self.clock.now() < self.wait_until

    # --- the hold ---

    def _entries(self) -> list[tuple[int, str]]:
        """The hold entries: (until, path) for every regular file named <digits>.<anything>, in the
        order the shell's glob lists them."""
        try:
            names = sorted(os.listdir(self.holds_dir))
        except OSError:
            return []
        out: list[tuple[int, str]] = []
        for name in names:
            if not name[:1].isdigit():
                continue
            path = os.path.join(self.holds_dir, name)
            if not os.path.isfile(path):
                continue
            until = name.split(".", 1)[0]
            if not _DIGITS.fullmatch(until):
                continue
            out.append((int(until), path))
        return out

    def hold_read(self) -> Hold | None:
        """``hold_read``: the standing hold, its latest-ending entry; None when there is none. A
        latest entry whose line this module did not write is no hold at all, as in the shell."""
        if not self.dir or not os.path.isdir(self.holds_dir):
            return None
        best = ""
        best_until = 0
        for until, path in self._entries():
            if until > best_until:
                best, best_until = path, until
        if not best:
            return None
        fields = _tab_read(best, 3)
        if fields is None:
            return None
        ep, length, src = fields
        if not _DIGITS.fullmatch(length) or not ep or not src:
            return None
        return Hold(best_until, ep, int(length), src)

    def hold_set(self, ep: str, verdict: str) -> bool:
        """``hold_set <endpoint> <probe verdict>``: adds the entry a quota (or an unreadable probe)
        calls for. With no reset in the headers it backs off: a minute, doubling from the last
        hold's length while the quota keeps refusing, up to an hour. False when the entry could not
        be written."""
        now = self.clock.now()
        prev = 0
        standing = self.hold_read()
        if standing is not None:
            prev = standing.length
        elif os.path.isfile(self.last_file):
            last = _tab_read(self.last_file, 2)
            if last is not None and _DIGITS.fullmatch(last[0]) and _DIGITS.fullmatch(last[1]):
                if now - int(last[0]) <= 3600:
                    prev = int(last[1])
        src = ""
        until = 0
        if verdict.startswith("quota "):
            text = verdict[len("quota "):]
            until = int(text) if _DIGITS.fullmatch(text) else 0
            src = "its headers"
        if until > now:
            length = until - now
        else:
            length = min(max(prev * 2, 60), 3600)
            until = now + length
            if verdict.startswith("quota "):
                src = "no header names its end; backing off"
            elif verdict == "ok":
                src = ("a probe of another operation answered, so no header names this one's end;"
                       " backing off")
            elif verdict == "unprobed":
                src = "refused while another hold or probe stood, so not probed; backing off"
            else:
                src = "the probe got no reading; backing off"
        try:
            os.makedirs(self.holds_dir, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".new.", dir=self.holds_dir)
        except OSError:
            return False
        try:
            with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape", newline="\n") as f:
                f.write(f"{ep}\t{length}\t{src}\n")
            unique = os.path.basename(tmp)[len(".new."):]
            os.replace(tmp, os.path.join(self.holds_dir, f"{until}.{unique}"))
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
            return False
        return True

    def hold_lift(self, ep: str, probe_start: int) -> None:
        """``hold_lift <endpoint> <probe start>``: that endpoint answered its probe. Removes ITS
        entries that had ended when the probe started, and remembers the longest of them in
        quota-last. Another endpoint's entries stay: its answer is its own (GraphQL and REST have
        separate quotas), so the gate probes each in turn.

        quota-last is written BEFORE any entry goes (ludics-lite#551): a refusal landing between the
        last entry's removal and that write found neither, and held for a minute instead of
        doubling from the hold just lifted."""
        longest = 0
        lifted: list[str] = []
        for until, path in self._entries():
            if until > probe_start:
                continue
            fields = _tab_read(path, 3)
            if fields is None or fields[0] != ep:
                continue
            if _DIGITS.fullmatch(fields[1]) and int(fields[1]) > longest:
                longest = int(fields[1])
            lifted.append(path)
        if longest:
            self._write_last(longest)
        for path in lifted:
            try:
                os.remove(path)
            except OSError:
                pass

    def _write_last(self, length: int) -> None:
        try:
            with open(self.last_file, "w", encoding="utf-8", newline="\n") as f:
                f.write(f"{self.clock.now()}\t{length}\n")
        except OSError:
            pass

    # --- the probe ---

    def probe(self, ep: str) -> str:
        """``budget_probe <endpoint>``: one request to the endpoint with its headers, not retried
        (its answer is the reading). ``ok`` the endpoint answered and nothing in the answer says its
        quota is out; ``quota <epoch>`` held until the epoch its own headers name (0: none);
        ``down`` no status line, a 5xx, or a 4xx that shows no quota either way. github.com by
        name: a GH_HOST naming another server would send the probe there."""
        if ep == "graphql":
            args = ["api", "-i", "--hostname", GITHUB, "graphql", "-f", "query=query{viewer{login}}"]
        else:
            args = ["api", "-i", "--hostname", GITHUB, ep]
        try:
            done = self._run("gh", args)
        except OSError:
            return "down"
        out = proc.substitution(done.stdout).replace("\r", "")
        lines = out.split("\n")
        head: list[str] = []
        body: list[str] = []
        in_head = True
        for line in lines:
            if in_head:
                if line == "":
                    in_head = False
                    continue
                head.append(line.lower())
            else:
                body.append(line)
        status = remaining = reset = after = ""
        for line in head:
            if not status:
                if not re.match(r"http/.* [0-9][0-9][0-9]", line):
                    break
                status = line.split(" ", 1)[1][:3]
                continue
            name, sep, value = line.partition(":")
            if not sep:
                value = line
            value = value[1:] if value.startswith(" ") else value
            if not _DIGITS.fullmatch(value):
                continue
            if name == "x-ratelimit-remaining":
                remaining = value
            elif name == "x-ratelimit-reset":
                reset = value
            elif name == "retry-after":
                after = value
        now = self.clock.now()
        quota = False
        if status == "429":
            quota = True
        elif status[:1] in ("2", "3", "4") and len(status) == 3:
            quota = bool(after) or remaining == "0" or quota_failure("\n".join(body))
        else:
            return "down"
        if quota:
            if after:
                return f"quota {now + int(after)}"
            if remaining == "0" and reset:
                return f"quota {reset}"
            return "quota 0"
        if status.startswith("2"):
            return "ok"
        return "ok" if remaining else "down"

    # --- locks ---

    def lock_take(self, directory: str) -> Lock:
        """``lock_take <dir>``: a lock is a directory holding ``owner``. A holder that no longer runs
        is replaced, and so is a directory still ownerless a second after it was first seen: its
        claimant died between the mkdir and the write. A mkdir that failed with no directory there,
        a lock five reaps could not clear, or an owner that could not be written, is status 2."""
        seen = False
        tries = 0
        while True:
            try:
                os.mkdir(directory)
                break
            except OSError:
                pass
            if not os.path.isdir(directory):
                return Lock(2)
            tries += 1
            if tries > 5:
                return Lock(2)
            owner = os.path.join(directory, "owner")
            holder = _first_line(owner)
            if holder == str(self.pid):
                return Lock(0)
            if holder and self._alive(holder):
                return Lock(1, holder, _second_line(owner))
            if not holder and not seen:
                seen = True
                self.clock.sleep(1)
                continue
            seen = False
            self.lock_reap(directory, holder)
        try:
            with open(os.path.join(directory, "owner"), "w", encoding="utf-8", newline="\n") as f:
                f.write(f"{self.pid}\n{self.clock.now()}\n")
        except OSError:
            # An ownerless lock is reaped by the next claimant a second later, while this process
            # still acts on it: not a lock at all. Give the directory back and say it cannot be
            # taken (the shell's lock_take returned its printf's failure here).
            shutil.rmtree(directory, ignore_errors=True)
            return Lock(2)
        return Lock(0)

    def lock_reap(self, directory: str, judged: str) -> None:
        """``lock_reap <dir> <the owner it was judged by>``: removes a stale lock, but only the one
        that was judged. The lock is renamed aside first (atomic), and the renamed directory's owner
        compared with the one judged; a lock that turns out to be someone else's is put back,
        unless a third process has taken the name meanwhile."""
        aside = f"{directory}.reap.{secrets.token_hex(3)}"
        try:
            os.rename(directory, aside)
        except OSError:
            return
        now_owner = _first_line(os.path.join(aside, "owner"))
        if now_owner == judged:
            shutil.rmtree(aside, ignore_errors=True)
        elif not os.path.exists(directory):
            try:
                os.rename(aside, directory)
            except OSError:
                shutil.rmtree(aside, ignore_errors=True)
        else:
            shutil.rmtree(aside, ignore_errors=True)

    def _drop_probe_lock(self) -> None:
        shutil.rmtree(self.probe_lock, ignore_errors=True)

    # --- the gate before every call ---

    def gate(self, mode: str) -> str | None:
        """``budget_gate <read|write>``: run before every call the session makes. None when no hold
        stands (lifting an ended one first, by probing its endpoint); otherwise why no call was made
        (the session's 3). A READ within ``wait_until`` waits a standing hold out instead, and says
        so once per hold. A write never waits: its caller read its preconditions just before it, and
        a write sent minutes or hours later would act on reads the hold has made stale."""
        if not self.dir:
            return None
        noted: int | None = None
        while (hold := self.hold_read()) is not None:
            now = self.clock.now()
            observing = mode == "read" and self.wait_until is not None and now < self.wait_until
            if now < hold.until:
                if observing and self.wait_until is not None:
                    if noted != hold.until:
                        warn(
                            f"quota hold: {hold.ep} refused on quota; no call to GitHub until {at(hold.until)}",
                            f"({hold.src}). Waiting it out within this command's ceiling; nothing is"
                            " concluded meanwhile.",
                        )
                        noted = hold.until
                    nap = min(hold.until - now, self.wait_until - now)
                    self.clock.sleep(nap)
                    # Whatever this command read before the wait is as old as the wait now.
                    self.waited = True
                    continue
                return (
                    f"quota hold until {at(hold.until)}, set when {hold.ep} refused on quota"
                    f" ({hold.src}); no call was made"
                )
            # The hold has ended. One process probes its endpoint; the rest wait for its answer.
            lock = self.lock_take(self.probe_lock)
            if lock.rc == 2:
                return (
                    f"quota hold: cannot take the probe lock {self.probe_lock} (SHIP_PR_STATE_DIR);"
                    " no call was made"
                )
            if lock.rc == 0:
                # Again under the lock: the prober before this one may have lifted this hold, or set
                # a new one, while this process waited for the lock.
                again = self.hold_read()
                if again is None or self.clock.now() < again.until:
                    self._drop_probe_lock()
                    continue
                probe_start = self.clock.now()
                probed = (again.until, again.ep)
                verdict = self.probe(again.ep)
                if verdict == "ok":
                    self.hold_lift(again.ep, probe_start)
                    warn(f"quota hold lifted: {again.ep} answered again")
                else:
                    self.hold_set(again.ep, verdict)
                self._drop_probe_lock()
                # The probe's answer must have changed the hold: lifted, or replaced by a later one.
                # The same ended entry still standing means the state directory took no write, and
                # probing it again at once would loop on requests.
                after = self.hold_read()
                if after is not None and (after.until, after.ep) == probed:
                    return (
                        f"quota hold: the hold in {self.dir} (SHIP_PR_STATE_DIR) could not be updated"
                        " after its probe; no call was made"
                    )
                continue
            if observing:
                self.clock.sleep(5)
                self.waited = True
                continue
            return f"quota hold: pid {lock.holder} is probing {hold.ep} for its recovery; no call was made"
        return None

    def quota_hit(self, args: Sequence[str]) -> str | None:
        """``budget_quota_hit <gh args...>``: a call was refused on quota. Probe its endpoint and set
        the hold its headers name. A probe that answers sets the backoff hold all the same. Only one
        probe at a time, and none while a hold stands: requests in flight when the quota ran out
        come back refused together, and each probing would be the burst the hold exists to stop.
        Such a refusal adds its endpoint's backoff entry unprobed, which the gate probes in turn
        once it has ended. A call whose endpoint cannot be told sets nothing.

        None once the hold is recorded (or there is nothing to record); otherwise why it is not: a
        hold the state directory cannot take holds no other process, and resending the refused
        call would only be another request during the incident (ludics-lite#551)."""
        if not self.dir:
            return None
        ep = endpoint(args, self.env.get("GH_REPO", ""))
        if not ep:
            return None
        if self._quota_hit(ep):
            return None
        return (
            f"{ep} was refused on quota, and the hold it calls for could not be recorded in"
            f" {self.dir} (SHIP_PR_STATE_DIR), so no other process on this host is held by it; make"
            " the state directory writable. The call is not repeated"
        )

    def _quota_hit(self, ep: str) -> bool:
        standing = self.hold_read()
        if standing is not None and standing.until > self.clock.now():
            return self.hold_set(ep, "unprobed")
        # The first refusal may be the state directory's first use.
        try:
            os.makedirs(self.dir, exist_ok=True)
        except OSError:
            pass
        if self.lock_take(self.probe_lock).rc != 0:
            return self.hold_set(ep, "unprobed")
        # Again under the lock: another refusal may have probed and set a hold meanwhile.
        standing = self.hold_read()
        if standing is not None and standing.until > self.clock.now():
            recorded = self.hold_set(ep, "unprobed")
        else:
            recorded = self.hold_set(ep, self.probe(ep))
        self._drop_probe_lock()
        return recorded

    # --- the observer ---

    def observer_claim(self, kind: str, repo: str, num: str) -> None:
        """``observer_claim <kind>``: take this PR's observer lock of ``kind``, or refuse with exit 2
        before anything is read. Re-entry from the same process is a no-op. GitHub's names are
        case-insensitive and its numbers integers, so ``Owner/Repo#007`` is ``owner/repo#7``."""
        number = int(num) if _DIGITS.fullmatch(num) else num
        key = f"{repo}#{number}.{kind}".replace("/", "~").lower()
        self._claim(key, kind, f"PR {repo}#{num}", "PR")

    def base_claim(self, repo: str, branch: str) -> None:
        """The observer lock of ``base --wait`` on a branch (ludics-lite#551): one per repository and
        branch. The repository is case-insensitive and the branch is not (git's names are), so only
        the repository is lowercased; ``/`` reads as ``~``, which no git ref can hold."""
        key = f"{repo.lower()}@{branch}.base".replace("/", "~")
        self._claim(key, "base", f"{repo} {branch}", "branch")

    def _claim(self, key: str, kind: str, what: str, unit: str) -> None:
        if not self.dir:
            return
        observers = os.path.join(self.dir, "observers")
        directory = os.path.join(observers, key)
        if self.observer == directory:
            return
        try:
            os.makedirs(observers, exist_ok=True)
        except OSError:
            die(f"cannot create {observers} for the observer lock")
        lock = self.lock_take(directory)
        if lock.rc == 1:
            since = f", since {at(lock.since)}" if lock.since else ""
            die(
                f"{what} already has a {kind} observer: pid {lock.holder}{since}.",
                f"One observer per {unit}: wait on that one, or stop it, rather than reading the {unit} twice.",
                "Nothing was read.",
            )
        if lock.rc != 0:
            die(f"cannot take the {kind} observer lock {directory} (SHIP_PR_STATE_DIR). Nothing was read.")
        self.observer = directory

    def observe(self, kind: str, seconds: int, repo: str, num: str) -> None:
        """``budget_observe <kind> <seconds>``: this command is the PR's ``kind`` observer, waiting
        up to ``seconds`` from its start. Called before the command's first read, so a second
        observer reads nothing and a hold standing at the start is waited out like any other."""
        if seconds <= 0:
            return
        self.observer_claim(kind, repo, num)
        if self.wait_from is None:
            self.wait_from = self.clock.now()
        self.wait_until = self.wait_from + seconds

    def release(self) -> None:
        """``observer_release``: drop the observer lock, if it is still this process's."""
        if not self.observer:
            return
        if _first_line(os.path.join(self.observer, "owner")) == str(self.pid):
            shutil.rmtree(self.observer, ignore_errors=True)
        self.observer = ""


def budget_dir(env: Mapping[str, str]) -> str:
    """BUDGET_DIR as the shell resolved it: the forward's value when there is one, else
    SHIP_PR_STATE_DIR, else ``${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/ship-pr``."""
    if ENV_BUDGET_DIR in env:
        return env[ENV_BUDGET_DIR]
    if env.get("SHIP_PR_STATE_DIR", ""):
        return env["SHIP_PR_STATE_DIR"]
    state = env.get("XDG_STATE_HOME", "") or f"{env.get('HOME', '') or '/tmp'}/.local/state"
    return f"{state}/ship-pr"


def from_env(env: Mapping[str, str], clock: Clock) -> Budget:
    review_cap, build_cap = poll_caps(env)
    return Budget(budget_dir(env), clock, review_cap=review_cap, build_cap=build_cap, env=env)
