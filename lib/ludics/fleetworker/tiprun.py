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
    ``coordinator`` whose ``requested_revision`` is exactly one full commit SHA: the tip the caller
    read, or a red tip being rerun. Anything else is a usage refusal (exit 2) before the anchor is
    asked.
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
    skills checkout after it. The request id must be one the registry does not hold yet: ``run``
    hands back an identical request's existing record, concluded or not, and a second run would
    start under the first one's evidence.
 4. On the box (the far side below): the checkout must be clean before anything touches it, and
    is fetched only when it lacks the commit, checked out detached at it, and checked again (HEAD
    is the SHA, the tree clean). The command then starts in it under ``execution slot --bg
    <runs> --wait 0``: one GPU token unless ``--cpu``, taken only if one is free at once, never
    queued behind or among the workers' batches, and with no ``--wait-window``. An enclosing
    slot's or measurement's marker is dropped first: a loop run is never part of another batch.
    That ``fleet-worker.sh`` is the box's own, and resolves the box's fleet configuration (its
    header's site defaults and ``~/.config/fleet/env.sh``), as every remote call of it does today
    (``run_on``'s far sides, a worker's batch on its GPU home box); forwarding the coordinator's
    is ludics-lite#632, for all of them at once.
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

Exit: 0 started, one line ``TIP-RUN STARTED <id> <box> <sha> <run dir>`` on stdout; 1 not started,
``TIP-RUN NOT STARTED <id>: <why>``; 2 usage; 4 outcome unknown, ``TIP-RUN UNKNOWN <id>: <why>``
(the record is left for the coordinator to reconcile). What the steps print themselves (the
dispatched record, the refresh line) goes to stderr.
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
from ludics.fleetworker.execution import field, listing, record_of, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import err, is_local, prelude, run, run_on

USAGE = "execution tip-run <json-file> --checkout <dir> [--runs <dir>] [--cpu] -- <command> [args...]"
SHA40 = re.compile(r"[0-9a-f]{40}")
SETTLE = 60  # seconds the far side waits for the slot's answer; `--wait 0` answers in about one registry read

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
dir=$("$fw" execution slot --bg "$runs" --wait 0 "$@" </dev/null) || refuse "execution slot --bg did not start the run (above)"
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


def parse(args: list[str]) -> TipRunArgs:
    payload, checkout, runs, cpu = "", "", "", False
    i = 0
    while i < len(args):
        arg = args[i]
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
            return TipRunArgs(payload, checkout, runs, cpu, command)
        elif not payload and not arg.startswith("-"):
            payload = arg
        else:
            die(USAGE)
        i += 1
    die(USAGE)


def request_problem(request: Any) -> str | None:
    """Why the payload cannot be a loop run's request, or None (the registry checks the rest)."""
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
    revision = fields.get("requested_revision")
    if not (isinstance(revision, str) and SHA40.fullmatch(revision)):
        return "requested_revision must be exactly one full 40-hex commit SHA, the revision the run checks out"
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
    parsed = parse(args)
    try:
        with open(parsed.payload, encoding="utf-8", errors="surrogateescape") as f:
            request: Any = json.loads(f.read())
    except (OSError, ValueError) as exc:
        die(f"execution tip-run: {parsed.payload} is not a readable JSON request ({exc})")
    problem = request_problem(request)
    if problem:
        die(f"execution tip-run: {problem}")
    fields = cast(dict[str, Any], request)
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

    rc = fleet_worker(cfg, ["execution", "run", parsed.payload])
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
               "evidence": f"tip-run: {shlex.join(parsed.command)} under execution slot --bg on {box}, at {sha} in a clean checkout",
               "observed_sha": sha, "remote_checkout": parsed.checkout,
               "handle": f"bg-run:{box}:{run_dir}", "log": f"{box}:{run_dir}/log"}
    if fleet_worker(cfg, ["execution", "record"], running) != 0:
        cli.say(f"TIP-RUN STARTED {request_id} {box} {sha} {run_dir}")
        err("TIP-RUN: the run started, but the registry did not take its running record (above); record it by hand")
        return 4
    cli.say(f"TIP-RUN STARTED {request_id} {box} {sha} {run_dir}")
    return 0
