"""``execution tip-run``: one run of a coordinator's integration loop, reserved, prepared and started
in one call (ludics-lite#615).

The coordinator's loops -- the cc integration loop and the opportunistic GPU loop beside it
(issue-wave SKILL.md, *Supervise*) -- each run a project's suite at a revision on a fleet box. By
hand that was a reservation payload, ``execution run``, an ssh into the box to fetch, check out and
check the checkout, a ``bg-run.sh`` spawn of the slot-wrapped command, and a record: wave-20261014's
coordinator wrote a script for it. This is that script, project-neutral: the checkout and the
command are the caller's, and so is the request, which says which loop the run belongs to (the cc
loop's carries ``"integration": true``; the GPU loop's does not, so the base gate never reads it).

In order, each step yielding rather than waiting:

 1. THE REQUEST is ``execution run``'s payload, a non-standing ``correctness`` request of transport
    ``coordinator`` whose ``requested_revision`` is exactly one full commit SHA: a red tip being
    rerun, or the tip itself. With ``--tip <branch>`` the payload names no ``requested_revision``
    and the run reads it (ludics-lite#616): the commit ``<branch>`` of the request's repository
    names on GitHub now (``revision.branch_head``, the read a ``head-of:`` request's dispatch
    makes), written into the request before anything else sees it, so the record holds that one
    SHA as if the caller had named it. A payload naming one beside ``--tip`` is refused: one
    source for the revision. Any other shape is a usage refusal (exit 2) before GitHub or the
    anchor is asked; a branch GitHub does not answer for starts nothing and reserves nothing (exit 1).
 2. THE YIELD. The registry is read, before the reservation and again once it is published (the
    first read is not atomic with it: of two runs racing, each then sees the other, or the later
    one the earlier one, so two never run at once), and a record outstanding on the execution
    host other than a standing reservation (a worker's assigned leg, a measurement or its window,
    another loop run) refuses the run: a loop run is the lowest-priority correctness on the box, so it never takes
    a seat or a token a worker's leg was reserved for, and never stands between a measurement and
    its window. Standing reservations are a worker's iteration on its own agent host, whose batches
    the slot below sees as they run.
 3. ``execution run`` reserves and dispatches it, with every check the registry makes (lease,
    halt and its triage exception, cap, measurement exclusivity) and the refresh of the box's
    skills checkout after it; on a remote box that refresh is asked again, and anything but
    ``REFRESH OK`` starts nothing, since the box's own ``fleet-worker.sh`` runs the slot. The
    request id must be one the registry does not hold yet: ``run``
    hands back an identical request's existing record, concluded or not, and a second run would
    start under the first one's evidence.
 4. On the box (the far side below): the checkout must be clean before anything touches it, and
    is fetched only when it lacks the commit, checked out detached at it, and checked again (HEAD
    is the SHA, the tree clean). The command then starts in it under ``execution slot --bg
    <runs> --wait 0``: one GPU token unless ``--cpu``, taken only if one is free at once, never
    queued behind or among the workers' batches, and with no ``--wait-window``. An enclosing
    slot's or measurement's marker is dropped first: a loop run is never part of another batch.
    That ``fleet-worker.sh`` is the box's own, run under the coordinator's fleet configuration
    (the prelude's ``fleet_worker``, ludics-lite#632: the roster, the anchor and its registry, the
    slot and token specs), never the box's own ``~/.config/fleet/env.sh``.
 5. THE SLOT'S ANSWER is read off the run's log for up to ``SETTLE`` seconds. The boundary, a
    fail-closed allowlist: the run STARTED when the log holds the line ``take_slot`` prints after
    it took the slot and before it runs the command (``EXECUTION SLOT <box>: slot <i> of <n>[, GPU
    token <j> of <t>] held for: ...``); it did NOT START when ``rc`` is published and the log
    holds no such line (the slot refused, or its registry read failed, and the command never ran);
    anything else at the bound is unsettled. Nothing else in the log is read: the command's own
    output follows that line, so it can neither start nor un-start the run.

Started, the record is moved to ``running`` with the revision, checkout, handle and log; not
started, anything reserved is concluded ``not-launched`` with the reason as evidence, so a box the
loop yielded on holds no record of it. The conclusion of a started run is ``execution conclude
--from-bg-run <dir> --request <id> --sha <sha>``, read on the execution host.

Exit: 0 started and recorded, one line ``TIP-RUN STARTED <id> <box> <sha> <run dir>`` on stdout
(printed only then); 1 not started, ``TIP-RUN NOT STARTED <id>: <why>``; 2 usage; 4 outcome
unknown, ``TIP-RUN UNKNOWN <id>: <why>`` (a run started but not recorded among them, its directory
named; the record is left for the coordinator to reconcile). What the steps print themselves (the
dispatched record, the refresh line) goes to stderr.

THE END: ``execution tip-run --wait <id> [--within <s>]`` (ludics-lite#616) blocks on a started run
inside one foreground tool call and concludes it. It takes the request id alone: the box, the run
directory and the SHA are read off the record the start wrote, so the id and the directory a
waiter watches cannot drift apart (wave-20261014's hand-written loop watched the wrong one twice).
What it reads, a fail-closed allowlist:
  - a ``concluded`` record: its verdict is reported again (a retry after a lost answer), as
    ``TIP-RUN CONCLUDED <id> <verdict> <box> <sha> <dir>``, ``-`` for a field it has none of;
    nothing is read on a box;
  - a ``running`` record whose ``handle`` is ``bg-run:<execution host>:<absolute dir>`` and whose
    ``observed_sha`` is one full SHA -- what the start records, and nothing else: any other state
    or handle is refused (exit 1), naming it, and left to the coordinator.
On the box, the coordinator's own ``bg-run.sh`` (carried in the script, as ``--from-bg-run``'s far
side does) waits on the directory for up to ``--within`` seconds (``WITHIN``, 480: the tool call's
600 s cap less the registry and GitHub calls around it). Its verdict decides, and nothing else:
``rc=`` or ``STOPPED`` concludes the record with ``execution conclude --from-bg-run <dir> --request
<id> --sha <sha>`` (its verdict mapping is that one's) and reports the record's verdict as above,
exit 0; ``RUNNING`` prints ``TIP-RUN RUNNING <id> <box> <dir>: <wait's line>``, exit 3, to be
re-issued; any other answer (``STARTING``, ``DIED``, an unreachable box, a conclusion that did not
land) prints ``TIP-RUN UNKNOWN <id>: <why>``, exit 4, and concludes nothing. Exit 0 says the record
is concluded, not that the run passed: the verdict is the line's fourth word.
"""

import json
import os
import re
import shlex
import tempfile
from dataclasses import dataclass
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker import revision
from ludics.fleetworker.execution import field, gh_timeout, listing, record_of, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.preflight import refresh_box
from ludics.fleetworker.transport import err, is_local, prelude, run, run_on

USAGE = (
    "execution tip-run <json-file> [--tip <branch>] --checkout <dir> [--runs <dir>] [--cpu] -- <command> [args...],"
    " or tip-run --wait <id> [--within <s>]"
)
SHA40 = re.compile(r"[0-9a-f]{40}")
SETTLE = 60  # seconds the far side waits for the slot's answer; `--wait 0` answers in about one registry read
WITHIN = 480  # --wait's default bound on the box: under the 600 s tool cap with the calls around it
HANDLE = re.compile(r"bg-run:([^:]+):(/.*)", re.DOTALL)

# Far side, on the execution host, read by `bash -s` from stdin: so every child that could read
# stdin is given /dev/null, or it would eat the rest of this script. Args: checkout, sha, runs parent (empty: $STATE/tip-runs), the
# fleet-worker.sh to run there (empty: the box's skills checkout's), cpu|gpu, the settle bound, then
# the command. Prints `dir=` and `slot=held|ended|unsettled` (and `said=` for ended), or one
# TIP-RUN REFUSED line, exit 1, when nothing was started.
FAR = r"""co="$1" sha="$2" runs="$3" fw="$4" kind="$5" settle="$6"; shift 6
refuse() { echo "TIP-RUN REFUSED: $*"; exit 1; }
[ -n "$runs" ] || runs="$(expand_tilde "$STATE")/tip-runs"
[ -n "$fw" ] || fw="$(expand_tilde "$SKILLS_REPO")/issue-wave/scripts/fleet-worker.sh"
[ -x "$fw" ] || refuse "no executable fleet-worker.sh at $fw on $BOX"
cd "$co" 2>/dev/null || refuse "no checkout $co on $BOX"
dirty=$(git status --porcelain </dev/null 2>/dev/null) || refuse "$co on $BOX is not a git checkout"
[ -z "$dirty" ] || refuse "$co on $BOX has uncommitted changes ($(printf '%s\n' "$dirty" | grep -c '') path(s)): a run over them verifies nothing, and they are not this run's to discard"
if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
  bounded 300 git fetch -q origin >/dev/null; frc=$?
  [ "$frc" -eq 0 ] || refuse "git fetch origin in $co on $BOX failed (exit $frc)"
  git cat-file -e "$sha^{commit}" 2>/dev/null || refuse "$co on $BOX does not have $sha even after fetching origin"
fi
git -c advice.detachedHead=false checkout -q --detach "$sha" </dev/null 2>/dev/null || refuse "cannot check out $sha in $co on $BOX"
head=$(git rev-parse HEAD 2>/dev/null)
[ "$head" = "$sha" ] || refuse "HEAD of $co on $BOX is $head after checking out $sha"
[ -z "$(git status --porcelain </dev/null 2>/dev/null)" ] || refuse "$co on $BOX is not clean after checking out $sha"
unset FLEET_SLOT_HELD FLEET_MEASUREMENT_HELD
if [ "$kind" = cpu ]; then set -- --cpu -- "$@"; else set -- -- "$@"; fi
dir=$(fleet_worker "$fw" execution slot --bg "$runs" --wait 0 "$@" </dev/null) || refuse "execution slot --bg did not start the run (above)"
case "$dir" in /*) [ -d "$dir" ] || refuse "execution slot --bg printed '$dir', not a run directory" ;; *) refuse "execution slot --bg printed '$dir', not a run directory" ;; esac
held='^EXECUTION SLOT [^ ]+: slot [0-9]+ of [0-9]+(, GPU token [0-9]+ of [0-9]+)? held for: '
holds() { LC_ALL=C grep -a -E -q "$held" "$dir/log" 2>/dev/null; }
waited=0
while :; do
  if holds; then printf 'dir=%s\nslot=held\n' "$dir"; exit 0; fi
  # rc after a miss: the held line is written before the command runs, so it is read once more.
  if [ -f "$dir/rc" ]; then
    if holds; then printf 'dir=%s\nslot=held\n' "$dir"; exit 0; fi
    printf 'dir=%s\nslot=ended\nsaid=%s\n' "$dir" "$(head -n1 "$dir/log" 2>/dev/null)"; exit 0
  fi
  [ "$waited" -lt "$settle" ] || { printf 'dir=%s\nslot=unsettled\n' "$dir"; exit 0; }
  sleep 1; waited=$((waited + 1))
done
"""


@dataclass(frozen=True)
class TipRunArgs:
    payload: str
    checkout: str
    runs: str
    cpu: bool
    command: list[str]
    tip: str = ""


@dataclass(frozen=True)
class WaitArgs:
    request_id: str
    within: int


def parse_wait(args: list[str]) -> WaitArgs:
    """``--wait <id> [--within <s>]``, ``args`` starting at ``--wait``."""
    usage = "execution tip-run --wait <id> [--within <s>]"
    if len(args) < 2 or not args[1] or args[1].startswith("-"):
        die(f"{usage}: the request id TIP-RUN STARTED printed is required")
    rest, within = args[2:], WITHIN
    if rest:
        if len(rest) != 2 or rest[0] != "--within" or not rest[1].isdigit():
            die(f"{usage}: --within takes whole seconds")
        within = int(rest[1])
    return WaitArgs(args[1], within)


def parse(args: list[str]) -> TipRunArgs:
    payload, checkout, runs, cpu, tip = "", "", "", False, ""
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--tip":
            if i + 1 >= len(args) or not args[i + 1] or args[i + 1].startswith("-"):
                die("execution tip-run: expected a branch for --tip")
            tip = args[i + 1]
            i += 2
            continue
        if arg in ("--checkout", "--runs"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"execution tip-run: expected a directory for {arg}")
            if not args[i + 1].startswith("/"):
                die(f"execution tip-run: {arg} must be absolute (it is a path on the execution host)")
            if arg == "--checkout":
                checkout = args[i + 1]
            else:
                runs = args[i + 1]
            i += 2
            continue
        if arg == "--cpu":
            cpu = True
        elif arg == "--":
            command = args[i + 1 :]
            if not command:
                die("execution tip-run: a command to run is required, after --")
            if not payload or not checkout:
                die(USAGE)
            return TipRunArgs(payload, checkout, runs, cpu, command, tip)
        elif not payload and not arg.startswith("-"):
            payload = arg
        else:
            die(USAGE)
        i += 1
    die(USAGE)


def request_problem(request: Any, tip: bool = False) -> str | None:
    """Why the payload cannot be a loop run's request, or None (the registry checks the rest).
    With ``tip`` (``--tip``) the revision is the run's to read, so the payload names none."""
    if not isinstance(request, dict):
        return "the payload is not a JSON object"
    fields = cast(dict[str, Any], request)
    for key in ("request_id", "execution_host", "repository"):
        if not isinstance(fields.get(key), str) or not fields[key].strip():
            return f"{key} must be a nonempty string"
    if fields.get("kind") != "correctness":
        return "kind must be correctness: a loop run shares the box (a measurement is reserved with `execution run` or `window`)"
    if fields.get("transport") != "coordinator":
        return "transport must be coordinator: a loop run is the coordinator's own"
    if "standing" in fields:
        return "a loop run is never standing: it is one run, concluded when it ends"
    named = fields.get("requested_revision")
    if tip:
        if "requested_revision" in fields:
            return "--tip reads the revision, so the payload names no requested_revision: give one or the other"
        return None
    if not (isinstance(named, str) and SHA40.fullmatch(named)):
        return "requested_revision must be exactly one full 40-hex commit SHA, the revision the run checks out, or --tip <branch>"
    return None


def yielding_to(records: list[dict[str, Any]], box: str, request_id: str) -> list[str]:
    """The records a loop run on ``box`` yields to: everything outstanding there but standing
    reservations and the run's own record, as ``<id> (<state>)``."""
    return [
        f"{r.get('request_id')} ({r.get('state')})"
        for r in records
        if r.get("state") != "concluded"
        and field(r, "request", "execution_host") == box
        and field(r, "request", "standing") is not True
        and r.get("request_id") != request_id
    ]


def far_facts(text: str) -> dict[str, str]:
    """The far side's ``key=value`` lines (the first of each key)."""
    facts: dict[str, str] = {}
    for line in text.split("\n"):
        key, sep, value = line.partition("=")
        if sep and key in ("dir", "slot", "said") and key not in facts:
            facts[key] = value
    return facts


def fleet_worker(cfg: Config, args: list[str], payload: dict[str, Any] | None = None) -> int:
    """Run this fleet-worker.sh with ``args`` (and a payload file appended), its stdout on stderr."""
    script = os.path.join(cfg.here, os.path.basename(cfg.script))
    path = ""
    try:
        if payload is not None:
            descriptor, path = tempfile.mkstemp(prefix="fw-tip-run.", suffix=".json", dir=os.environ.get("TMPDIR") or "/tmp")
            with os.fdopen(descriptor, "w", encoding="utf-8") as f:
                f.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
            args = [*args, path]
        return run([script, *args], stdout_to_stderr=True).rc
    except OSError as exc:
        err(f"TIP-RUN: cannot stage a payload: {exc.strerror}")
        return 1
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass


def not_started(cfg: Config, request_id: str, why: str, log: str) -> int:
    """Conclude the dispatched reservation not-launched, then say so; exit 1, or 4 when the
    conclusion did not land (the record stays dispatched)."""
    done = {"request_id": request_id, "verdict": "not-launched", "log": log, "evidence": f"tip-run: {why}"}
    if fleet_worker(cfg, ["execution", "conclude"], done) != 0:
        cli.say(f"TIP-RUN UNKNOWN {request_id}: nothing started ({why}), but the not-launched conclusion did not land (above); conclude it")
        return 4
    cli.say(f"TIP-RUN NOT STARTED {request_id}: {why}")
    return 1


def cmd_tip_run(cfg: Config, args: list[str]) -> int:
    if args and args[0] == "--wait":
        return cmd_wait(cfg, parse_wait(args))
    parsed = parse(args)
    try:
        with open(parsed.payload, encoding="utf-8", errors="surrogateescape") as f:
            request: Any = json.loads(f.read())
    except (OSError, ValueError) as exc:
        die(f"execution tip-run: {parsed.payload} is not a readable JSON request ({exc})")
    problem = request_problem(request, bool(parsed.tip))
    if problem:
        die(f"execution tip-run: {problem}")
    fields = cast(dict[str, Any], request)
    resolved: dict[str, Any] | None = None
    if parsed.tip:
        repo = str(fields["repository"])
        read = revision.branch_head(repo, parsed.tip, gh_timeout(cfg))
        if not isinstance(read, str):
            cli.say(read[0])
            cli.say(f"TIP-RUN NOT STARTED {fields['request_id']}: the tip of {parsed.tip} in {repo} could not be read (above); nothing reserved")
            return 1
        resolved = {**fields, "requested_revision": read}
        fields = resolved
        err(f"TIP-RUN TIP {fields['request_id']}: {parsed.tip} is {read} in {repo} on GitHub now; the run checks out that commit")
    request_id, box, sha = fields["request_id"], fields["execution_host"], fields["requested_revision"]

    listed = listing(cfg)
    records = records_of(listed.out) if listed.rc == 0 else None
    if records is None:
        cli.say(f"TIP-RUN UNKNOWN {request_id}: the anchor's registry could not be read, so whether {box} is free is unknown; nothing reserved")
        return 4
    # A request id the registry holds is never run again (step 3).
    held = record_of(records, request_id)
    if held is not None:
        cli.say(f"TIP-RUN NOT STARTED {request_id}: the registry already holds it ({held.get('state')}); a loop run takes a fresh request id")
        return 1
    busy = yielding_to(records, box, request_id)
    if busy:
        cli.say(f"TIP-RUN NOT STARTED {request_id}: {box} has {', '.join(busy)} outstanding; a loop run yields to it; nothing reserved")
        return 1

    # A resolved request is staged anew: the file names no revision.
    rc = fleet_worker(cfg, ["execution", "run"], resolved) if resolved else fleet_worker(cfg, ["execution", "run", parsed.payload])
    if rc != 0:
        if rc == 4:
            cli.say(f"TIP-RUN UNKNOWN {request_id}: the reservation's outcome is unknown (above); reconcile it")
        else:
            cli.say(f"TIP-RUN NOT STARTED {request_id}: the reservation was refused (above)")
        return rc
    # THE YIELD, AGAIN (step 2): the read above is not atomic with the reservation, so a leg or a
    # second loop run reserved in between is looked for once ours is published. Of two that race,
    # each sees the other's record and yields, or the later one sees the earlier one's: never both run.
    nothing = f"{box}:{parsed.checkout} (no run directory: nothing started)"
    listed = listing(cfg)
    records = records_of(listed.out) if listed.rc == 0 else None
    if records is None:
        return not_started(cfg, request_id, f"the registry could not be re-read after the reservation, so whether {box} is still free is unknown", nothing)
    busy = yielding_to(records, box, request_id)
    if busy:
        return not_started(cfg, request_id, f"{box} has {', '.join(busy)} outstanding, reserved beside this run; a loop run yields to it", nothing)

    # The box's own fleet-worker.sh runs the slot, so it must be the one `execution run` just tried
    # to bring current: that refresh reports and never fails the dispatch, so it is asked again
    # here (a current checkout answers at once) and anything but REFRESH OK starts nothing.
    if not is_local(cfg, box) and refresh_box(cfg, box, to_stderr=True) != 0:
        return not_started(cfg, request_id, f"the skills checkout on {box} was not refreshed (above), so its fleet-worker.sh may be stale", nothing)
    fw = os.path.join(cfg.here, os.path.basename(cfg.script)) if is_local(cfg, box) else ""
    kind = "cpu" if parsed.cpu else "gpu"
    far = [parsed.checkout, sha, parsed.runs, fw, kind, str(SETTLE), *parsed.command]
    done = run_on(cfg, box, prelude(cfg, box) + FAR, far, capture=True)
    text = done.out.rstrip("\n")
    if done.unreachable:
        uncertain = {"request_id": request_id, "state": "uncertain",
                     "evidence": f"tip-run: ssh to {box} failed (exit 255) while preparing or starting the run; whether it started is unknown"}
        fleet_worker(cfg, ["execution", "record"], uncertain)
        cli.say(f"TIP-RUN UNKNOWN {request_id}: {box} did not answer while the run was being started; recorded uncertain, reconcile it")
        return 4
    refusals = [line for line in text.split("\n") if line.startswith("TIP-RUN REFUSED: ")]
    if done.rc == 1 and refusals:
        why = refusals[-1][len("TIP-RUN REFUSED: ") :]
        return not_started(cfg, request_id, why, nothing)
    facts = far_facts(text)
    run_dir, slot = facts.get("dir", ""), facts.get("slot", "")
    if done.rc != 0 or not run_dir or slot not in ("held", "ended", "unsettled"):
        cli.emit(text)
        cli.say(f"TIP-RUN UNKNOWN {request_id}: unreadable answer from {box} (exit {done.rc}); the record stays dispatched, reconcile it")
        return 4
    if slot == "ended":
        why = f"the slot did not run the command ({facts.get('said') or 'no slot line in the log'})"
        return not_started(cfg, request_id, why, f"{box}:{run_dir}/log")
    if slot == "unsettled":
        cli.say(f"TIP-RUN UNKNOWN {request_id}: no slot answer in {run_dir} on {box} within {SETTLE}s;"
                " read its log, then record or conclude the reservation")
        return 4
    running = {"request_id": request_id, "state": "running",
               "evidence": f"tip-run: {shlex.join(parsed.command)} under execution slot --bg on {box}, at {sha} in a clean checkout"
                           + (f" (the tip of {parsed.tip} on GitHub when the run started)" if parsed.tip else ""),
               "observed_sha": sha, "remote_checkout": parsed.checkout,
               "handle": f"bg-run:{box}:{run_dir}", "log": f"{box}:{run_dir}/log"}
    if fleet_worker(cfg, ["execution", "record"], running) != 0:
        cli.say(f"TIP-RUN UNKNOWN {request_id}: the run started in {run_dir} on {box} at {sha}, but the registry did not"
                " take its running record (above); the record stays dispatched, record it by hand")
        return 4
    cli.say(f"TIP-RUN STARTED {request_id} {box} {sha} {run_dir}")
    return 0


# Far side of `--wait`, on the run's box: the coordinator's bg-run.sh, carried in the script, waits on
# the directory. Args: the run directory, the bound. Prints wait's one line and exits with its code
# (its heartbeats go to stderr, passed through), or one TIP-RUN REFUSED line, exit 1, for a
# directory that is not there.
WAIT_HEAD = r"""dir="$1" within="$2"
[ -d "$dir" ] || { echo "TIP-RUN REFUSED: no run directory $dir on $BOX"; exit 1; }
bash -s -- wait "$dir" --within "$within" <<'FLEET_BG_RUN_SH'
"""
WAIT_TAIL = "FLEET_BG_RUN_SH\n"


def started_run(record: dict[str, Any]) -> tuple[str, str, str] | str:
    """A running record the start wrote, as (box, dir, sha), or why it is not one."""
    host = field(record, "request", "execution_host")
    handle, sha = record.get("handle"), record.get("observed_sha")
    found = HANDLE.fullmatch(handle) if isinstance(handle, str) else None
    if found is None or found.group(1) != host:
        return f"its handle is {json.dumps(handle)}, not bg-run:{host}:<dir>, the one a started tip-run records"
    if not (isinstance(sha, str) and SHA40.fullmatch(sha)):
        return f"its observed_sha is {json.dumps(sha)}, not one full SHA"
    return found.group(1), found.group(2), sha


def concluded_line(record: dict[str, Any]) -> str:
    """``TIP-RUN CONCLUDED <id> <verdict> <box> <sha> <dir>`` off a concluded record, ``-`` for a
    field it lacks (a not-launched record names no run)."""
    handle = record.get("handle")
    found = HANDLE.fullmatch(handle) if isinstance(handle, str) else None
    words = [record.get("verdict"), field(record, "request", "execution_host"), record.get("observed_sha"),
             found.group(2) if found else None]
    shown = [w if isinstance(w, str) and w else "-" for w in words]
    return f"TIP-RUN CONCLUDED {record.get('request_id')} {' '.join(shown)}"


def read_record(cfg: Config, request_id: str) -> dict[str, Any] | None | str:
    """The record of ``request_id``, None when the registry holds none, or why it could not be read."""
    listed = listing(cfg)
    records = records_of(listed.out) if listed.rc == 0 else None
    if records is None:
        return f"the anchor's registry could not be read (exit {listed.rc})"
    return record_of(records, request_id)


def cmd_wait(cfg: Config, parsed: WaitArgs) -> int:
    request_id = parsed.request_id
    record = read_record(cfg, request_id)
    if isinstance(record, str):
        cli.say(f"TIP-RUN UNKNOWN {request_id}: {record}; nothing waited on")
        return 4
    if record is None:
        cli.say(f"TIP-RUN REFUSED {request_id}: the registry holds no such request")
        return 1
    if record.get("state") == "concluded":
        cli.say(concluded_line(record))
        return 0
    if record.get("state") != "running":
        cli.say(f"TIP-RUN REFUSED {request_id}: it is {record.get('state')}, not a run tip-run started (running); reconcile it")
        return 1
    run_facts = started_run(record)
    if isinstance(run_facts, str):
        cli.say(f"TIP-RUN REFUSED {request_id}: {run_facts}; conclude it by hand")
        return 1
    box, run_dir, sha = run_facts
    bgrun = os.path.join(cfg.here, "bg-run.sh")
    try:
        with open(bgrun, encoding="utf-8", errors="surrogateescape") as f:
            bg_source = f.read()
    except OSError as exc:
        die(f"execution tip-run --wait: cannot read {bgrun} ({exc.strerror})")
    script = prelude(cfg, box) + WAIT_HEAD + bg_source + WAIT_TAIL
    done = run_on(cfg, box, script, [run_dir, str(parsed.within)], capture=True)
    lines = done.out.rstrip("\n").split("\n")
    said = lines[-1] if lines else ""
    if done.unreachable:
        cli.say(f"TIP-RUN UNKNOWN {request_id}: {box} did not answer; nothing concluded, re-issue the wait")
        return 4
    if done.rc == 1 and said.startswith("TIP-RUN REFUSED: "):
        cli.say(f"TIP-RUN UNKNOWN {request_id}: {said[len('TIP-RUN REFUSED: '):]}; nothing concluded, reconcile it")
        return 4
    if done.rc == 3 and said.startswith("RUNNING"):
        cli.say(f"TIP-RUN RUNNING {request_id} {box} {run_dir}: {said}")
        return 3
    if not ((done.rc == 0 and said.startswith("rc=")) or (done.rc == 7 and said.startswith("STOPPED"))):
        cli.say(f"TIP-RUN UNKNOWN {request_id}: bg-run.sh wait on {run_dir} on {box} said {said!r} (exit {done.rc});"
                " nothing concluded, reconcile it (bg-run.sh's header reads the verdict)")
        return 4
    rc = fleet_worker(cfg, ["execution", "conclude", "--from-bg-run", run_dir, "--request", request_id, "--sha", sha, "--box", box])
    if rc != 0:
        cli.say(f"TIP-RUN UNKNOWN {request_id}: the run in {run_dir} on {box} ended ({said}), but the conclusion did not land"
                " (above); re-issue the wait")
        return 4
    record = read_record(cfg, request_id)
    if not isinstance(record, dict) or record.get("state") != "concluded":
        cli.say(f"TIP-RUN UNKNOWN {request_id}: concluded (above), but its record could not be read back; re-issue the wait to read its verdict")
        return 4
    cli.say(concluded_line(record))
    return 0
