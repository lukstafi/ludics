"""The CLI worker's life: ``launch``, ``attach``, ``status``, ``log``, ``unstick``, ``close`` and ``ls``
(fleet-worker.sh's ``cmd_launch``, ``cmd_attach``, ``cmd_status``, ``cmd_log``, ``cmd_unstick``,
``cmd_close``, ``cmd_ls``).

``--result-file <local path>`` opts into a JSON object with worker, host, session and
worktree. Only the remote result stdout is written there; human output is on stderr.
The file is written only after start succeeds. It is evidence of startup, not readiness;
on a missing/malformed result reconcile status and reservations before retrying.

``--status <local path>`` (ludics#1290) writes one JSON object atomically as ``launch``'s
last act on every non-usage exit (never on usage exit 2): ``{"exit", "host", "worker",
"outcome"}``, where ``outcome`` is one of ``LAUNCH_OUTCOMES``:
  - ``pre-start``: refused or failed before any standing reservation was created and before
    any spawn was issued (including an initial or pre-preparation lease gate refusal, and a
    standing ``execution run`` lease refusal before registry mutation);
  - ``not-started``: a standing reservation was created and cleanly concluded ``not-launched``;
  - ``reserved``: a standing reservation was created and could not be concluded (for example,
    post-reservation lease loss or a failed ``not-launched`` conclusion);
  - ``started``: worker startup succeeded (and ``--result-file``, if requested, was written);
  - ``uncertain``: any other outcome whose reservation or startup state is not proven.
A failure to write ``--status`` prints a ``LAUNCH STATUS NOTE`` on stderr and leaves the exit
status unchanged. Callers read ``--status`` fail-closed and never infer pre-start from prose.

A CLI worker is a detached tmux session on its box with its record under the box's
``$STATE/workers/<name>/`` (fleet-worker.sh's header has the model, the two kinds and their
states). Every read and every change of a record is the far side's (``ludics.fleetworker.farside``),
run on the box; this module is the near side: the command line, the lease and halt fences on the
anchor, the preflight and base gate in front of a launch, the staging of every prompt as a FILE
(issue prose is full of backticks and $() a shell would expand before the model saw them), and the
retry of an ``attach`` whose box dropped off the network -- the worker runs on regardless.

Every verb that changes a worker -- ``launch``, ``unstick``, ``close`` -- requires the lease;
``launch`` also refuses while halted (``--force`` admits the one triage worker). A box that does
not answer is ``<VERB> UNREACHABLE ...``, exit 4, never a verdict about the worker.
"""

import json
import os
import re
import shlex
import time
from typing import Any, cast

from ludics import cli
from ludics.fleetworker import farside, tally, tiprun
from ludics.fleetworker.config import Config, fetch_timeout_s, short_hostname
from ludics.fleetworker.gate import base_gate
from ludics.fleetworker.identity import die, gen_uuid
from ludics.fleetworker.lease import LEASE_LOST_STATUS, anchor_gate, lost_status
from ludics.fleetworker.preflight import knob, run_preflight, siblings_of
from ludics.fleetworker.transport import err, fleet_name, is_local, prelude, put_file, run_on, substitution
from ludics.fleetworker.wavebrief import write_atomically

_NAME = re.compile(r"[A-Za-z0-9._-]+")
_SHA = re.compile(r"[0-9a-f]{40}")
_DIGITS = re.compile(r"[0-9]+")

LAUNCH_OUTCOMES = ("pre-start", "not-started", "reserved", "started", "uncertain")


def write_launch_status(path: str, rc: int, host: str, worker: str, outcome: str) -> None:
    """Write ``launch --status`` atomically; a write failure is a NOTE and never changes the exit."""
    payload = json.dumps({"exit": rc, "host": host, "worker": worker, "outcome": outcome}, ensure_ascii=False) + "\n"
    try:
        write_atomically(path, payload)
    except OSError as exc:
        err(f"LAUNCH STATUS NOTE {host}/{worker}: cannot write {shlex.quote(path)} ({exc.strerror}): {payload.rstrip()}")


def read_launch_status(path: str, rc: int, host: str, worker: str) -> dict[str, Any] | None:
    """Read ``launch --status`` fail-closed: exact schema, matching exit/host/worker, known outcome."""
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    st = cast(dict[str, Any], data)
    if (set(st) != {"exit", "host", "worker", "outcome"}
            or type(st["exit"]) is not int or st["exit"] != rc
            or st["host"] != host or st["worker"] != worker
            or st["outcome"] not in LAUNCH_OUTCOMES):
        return None
    return st


def valid_name(name: str) -> bool:
    """A worker name: [A-Za-z0-9._-]+, and no leading dot -- a `*` glob (the fleet inventory) would
    not see such a record."""
    return bool(_NAME.fullmatch(name)) and not name.startswith(".")


def feeder_wait_ok(cfg: Config) -> bool:
    """The run.sh feeder bound, checked by the commands that write one: a whole number of seconds,
    above zero (a zero bound would refuse every CLI whose feeder took one poll to record its pid)."""
    return bool(_DIGITS.fullmatch(cfg.feeder_wait)) and not cfg.feeder_wait.startswith("0")


def stamp() -> str:
    """``$(date -u +%Y%m%dT%H%M%SZ)-$$``: a staged file's name, unique per coordinator process."""
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"


def _box_and_name(args: list[str], verb: str) -> tuple[str, str]:
    box = args[0] if args else ""
    name = args[1] if len(args) > 1 else ""
    if not box or not name:
        die(f"{verb}: <box> <name> required")
    return box, name


def _value(args: list[str], i: int) -> str:
    """``${2:-}``: the option's value, or empty when there is none."""
    return args[i + 1] if i + 1 < len(args) else ""


def _unreachable(line: str) -> int:
    cli.say(line)
    return 4


def preflight_note(pf: str) -> str:
    """``${pf#*skills=* }``: the OK line past its ``skills=<sha> `` field (the notes it carries)."""
    start = pf.find("skills=")
    if start < 0:
        return pf
    space = pf.find(" ", start + len("skills="))
    return pf if space < 0 else pf[space + 1 :]


# --- launch ------------------------------------------------------------------------------------


def standing_request(path: str, box: str, target: str) -> dict[str, Any]:
    """Read one JSON object only; bind standing correctness to this launch's host/repository.

    The registry validates all remaining fields. Checkout is supplied after preparation; the
    caller's file is never rewritten. No existing dispatch is adopted on retry.
    """
    try:
        with open(path, encoding="utf-8") as source:
            request = json.load(source)
    except (OSError, ValueError):
        die(f"launch: --standing {shlex.quote(path)} must be a readable JSON reservation")
    if not isinstance(request, dict):
        die("launch: --standing requires one JSON object")
    request = cast(dict[str, Any], request)
    if request.get("standing") is not True or request.get("kind") != "correctness":
        die("launch: --standing requires standing=true and kind=correctness")
    if request.get("execution_host") != box or request.get("repository") != target:
        die("launch: --standing execution_host and repository must match the launch box and --target-repo")
    return request


def cmd_launch(cfg: Config, args: list[str]) -> int:
    box, name = _box_and_name(args, "launch")
    if not valid_name(name):
        die("launch: name must be [A-Za-z0-9._-]+ and not start with a dot")
    kind = brief = cwd = repo = branch = target = base_branch = reason = standing = result_file = status_file = ""
    base = cfg.env.get("FLEET_BASE_REF") or "origin/master"
    force = replace = no_cross = False
    extra: list[str] = []
    rest = args[2:]
    i = 0
    while i < len(rest):
        arg = rest[i]
        match arg:
            case "--target-repo" | "--base-branch":
                if i + 1 >= len(rest) or not rest[i + 1]:
                    die(f"launch: expected value for {arg}")
                if arg == "--target-repo":
                    target = rest[i + 1]
                else:
                    base_branch = rest[i + 1]
                i += 1
            case "--kind":
                kind = _value(rest, i)
                i += 1
            case "--result-file":
                result_file = _value(rest, i)
                if not result_file:
                    die("launch: --result-file <local path> required")
                i += 1
            case "--status":
                if status_file:
                    die("launch: --status may be given at most once")
                status_file = _value(rest, i)
                if not status_file:
                    die("launch: --status <local path> required")
                i += 1
            case "--standing":
                standing = _value(rest, i)
                if not standing:
                    die("launch: --standing <reserve.json> required")
                i += 1
            case "--brief":
                brief = _value(rest, i)
                i += 1
            case "--cwd":
                cwd = _value(rest, i)
                i += 1
            case "--repo":
                repo = _value(rest, i)
                i += 1
            case "--branch":
                branch = _value(rest, i)
                i += 1
            case "--base":
                base = _value(rest, i)
                i += 1
            case "--allow-red-base":
                if i + 1 >= len(rest) or not re.search(r"[^ \t\n\r\f\v]", rest[i + 1]):
                    die("base gate: --allow-red-base requires a triage reason")
                reason = rest[i + 1]
                i += 1
            case "--force":
                force = True
            case "--replace":
                replace = True
            case "--no-cross":
                no_cross = True
            case "--":
                extra = rest[i + 1 :]
                break
            case _:
                die(f"launch: unknown option {arg}")
        i += 1
    if kind not in ("claude", "codex", "gemini"):
        die("launch: --kind claude|codex|gemini")
    if kind == "gemini" and any(a in ("--conversation", "--continue", "-c") or a.startswith("--conversation=") for a in extra):
        die("launch: a gemini worker's conversation is its own: --conversation and --continue are the launcher's to pass, on a"
            " recorded resume, never a launch's (the preflight's probe would otherwise speak into that conversation)")
    if not feeder_wait_ok(cfg):
        die("launch: FLEET_FEEDER_WAIT must be a positive number of seconds")
    if "\n" in cwd + repo + branch + base:
        die("launch: paths and refs must not contain newlines (the record is line-oriented)")
    if not brief or not os.access(brief, os.R_OK):
        die("launch: --brief <readable file>")
    if status_file and os.path.realpath(status_file) in {os.path.realpath(p) for p in (result_file, brief, standing) if p}:
        die("launch: --status names a file of its own, never --result-file, --brief or --standing")
    fetch_timeout = fetch_timeout_s(cfg)
    host = fleet_name(cfg, box)
    request = standing_request(standing, host, target) if standing else None
    label = f"{box}/{name}"

    def finish(rc: int, outcome: str) -> int:
        if status_file:
            write_launch_status(status_file, rc, host, name, outcome)
        return rc

    if not cwd:
        if not repo or not branch:
            die("launch: --cwd <dir>, or --repo <dir> --branch <branch>")
        # --repo is a checkout path on the box while --target-repo is owner/repo, and the two are
        # easily swapped. An existing path is a path whatever its shape (asked of the box, where it
        # resolves); only a missing one shaped like owner/name is refused, before the lease is read.
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+", repo):
            done = run_on(cfg, box, prelude(cfg, box) + farside.LAUNCH_EXISTS, [repo])
            if done.unreachable:
                return finish(_unreachable(f"LAUNCH UNREACHABLE {box}"), "pre-start")
            if done.rc != 0:
                die(
                    f"launch: --repo takes the path of a checkout on {box}, not a GitHub owner/name like {repo};"
                    " the GitHub repository goes in --target-repo"
                )
    rc = anchor_gate(cfg, "LAUNCH", label, force)
    if rc != 0:
        return finish(rc, "pre-start")
    # Worktree creation names its base already. An explicit CI branch is needed for non-origin refs
    # (tags, SHAs, or another remote); an existing cwd uses the repository's default branch.
    if not cwd and not base_branch:
        if not base.startswith("origin/"):
            die("launch: --base-branch required for a non-origin --base")
        base_branch = base[len("origin/") :]
    # The Codex probe runs with the worker's own args, so a model this box's codex cannot serve is
    # refused now rather than found as a worker that died at launch (ludics#539). --no-cross skips
    # the sibling reach probes, for a wave with no cross-box legs: each sleeping sibling costs one
    # FLEET_CROSS_TIMEOUT, serially, on every launch.
    cross = "" if no_cross else siblings_of(cfg, box)
    mode = {"codex": "1", "gemini": "gemini"}.get(kind, "0")
    done = run_preflight(cfg, box, mode, "1", cross, capture=True, cli_args=extra if mode != "0" else [])
    if done.unreachable:
        return finish(_unreachable(f"LAUNCH UNREACHABLE {box}"), "pre-start")
    pf = substitution(done.out)
    if done.rc != 0:
        cli.say(f"LAUNCH REFUSED {label}: {pf}")
        return finish(1, "pre-start")
    # A passing preflight can still carry a note the coordinator must see before briefing a
    # cross-box leg: a sibling that did not answer. Said on stderr, so the LAUNCHED line stays the
    # one thing on stdout.
    if "cross-box unreachable" in pf or "GitHub unreachable" in pf:
        err(f"preflight note for {label}: {preflight_note(pf)}")
    pinned = ""
    if not cwd:
        # Fetch before reading CI, and carry an immutable object into worktree add.
        done = run_on(
            cfg, box, prelude(cfg, box) + farside.LAUNCH_FETCH, [repo, base, fetch_timeout],
            capture=True,
        )
        if done.unreachable:
            return finish(_unreachable(f"LAUNCH UNREACHABLE {box}"), "pre-start")
        if done.rc != 0:
            return finish(done.rc, "pre-start")
        pinned = substitution(done.out)
        if not _SHA.fullmatch(pinned):
            die("launch: could not resolve base commit")
    rc = base_gate(cfg, target, base_branch, force, reason, pinned)
    if rc != 0:
        return finish(rc, "pre-start")
    if pinned:
        base = pinned
    # The preflight and fetch may take minutes; a halt or adoption during that window must
    # still fence this launch, so the gate is read again right before anything is written.
    rc = anchor_gate(cfg, "LAUNCH", label, force)
    if rc != 0:
        return finish(rc, "pre-start")
    # A claude worker's session id, and the uuid the brief's input line carries (its replay
    # proves delivery).
    sid, bid = (gen_uuid(), gen_uuid()) if kind == "claude" else ("", "")
    # The brief lands beside the record, not on it: the far side moves it into place only after
    # the guards pass, so a refused launch leaves a finished worker's brief untouched.
    when = stamp()
    prefix = prelude(cfg, box) + farside.ghprobe(knob(cfg, "FLEET_GH_TIMEOUT", "30"))
    far_args = [
        name, kind, cwd, repo, branch, base, sid, short_hostname(), "1" if replace else "0", when,
        fetch_timeout, bid, host, *extra,
    ]  # fmt: skip
    script = prefix + farside.LAUNCH
    request_id = ""
    if request is not None:
        preparation = (farside.structured_launch(prefix + farside.LAUNCH_WORKTREE)
                       if result_file else prefix + farside.LAUNCH_PREPARE)
        done = run_on(cfg, box, preparation, far_args, capture=True)
        if done.unreachable:
            return finish(_unreachable(f"LAUNCH UNREACHABLE {box}"), "uncertain")
        if done.rc != 0:
            cli.emit(done.out)
            return finish(done.rc, "pre-start")
        if result_file:
            try:
                prepared = json.loads(done.out)["worktree"]
                if not isinstance(prepared, str) or not prepared.startswith("/") or "\0" in prepared:
                    raise ValueError("invalid worktree")
            except (ValueError, KeyError, TypeError):
                cli.say("LAUNCH UNKNOWN: preparation did not return a structured checkout; reconcile before retrying")
                return finish(4, "uncertain")
        else:
            # Legacy callers retain preparation's human output and path convention.
            lines = substitution(done.out).split("\n")
            prepared = lines[-1]
            for notice in lines[:-1]:
                cli.say(notice)
            if not prepared.startswith("/"):
                die("launch: preparation did not return an absolute checkout")
        request["checkout"] = prepared
        check = f'[ "$cwd" = {shlex.quote(prepared)} ] || refuse "worktree path changed after reservation"\n'
        # Revalidation must not call a worktree this preparation made an existing reuse.
        script = prefix + "launch_revalidation=1\n{\n" + farside.LAUNCH_STANDING_WORKTREE + "} >&2\n" + check + farside.LAUNCH_STANDING_START
    # Stage before admission: failure here cannot leave a dispatched reservation behind.
    done = put_file(cfg, box, brief, f"{cfg.state}/incoming/{name}-{when}.md")
    if done.unreachable:
        return finish(_unreachable(f"LAUNCH UNREACHABLE {box}"), "pre-start")
    if done.rc != 0:
        cli.say(f"LAUNCH REFUSED {label}: cannot stage the brief under the worker state dir on {box} (unwritable, or a file in the way)")
        return finish(1, "pre-start")
    if request is not None:
        request_id = str(request.get("request_id", ""))
        rc = tiprun.fleet_worker(cfg, ["execution", "run"], request, verb="LAUNCH")
        if rc != 0:
            run_on(cfg, box, prelude(cfg, box) + farside.LAUNCH_DROP_BRIEF, [f"{name}-{when}.md"])
            if rc == 4:
                cli.say(f"LAUNCH UNKNOWN {label}: reservation {request_id} outcome unknown; reconcile it; worktree kept")
                return finish(4, "uncertain")
            cli.say(f"LAUNCH REFUSED {label}: standing reservation failed; worktree kept")
            # execution run exits 1 (refused) or LEASE_LOST_STATUS (lease_mutation before registry_command):
            # no reservation was created and no spawn was issued; any other nonzero exit is not proven.
            return finish(rc, "pre-start" if rc in (1, LEASE_LOST_STATUS) else "uncertain")
        # A halt/adoption while reserving still fences startup. No start was attempted here,
        # so conclude not-launched; a failed conclusion must be reported as unknown.
        rc = anchor_gate(cfg, "LAUNCH", label, force)
        if rc != 0:
            run_on(cfg, box, prelude(cfg, box) + farside.LAUNCH_DROP_BRIEF, [f"{name}-{when}.md"])
            if rc == LEASE_LOST_STATUS:
                cli.say(f"LAUNCH REFUSED {label}: reconcile reservation {request_id}; worker startup was not attempted")
                return finish(rc, "reserved")
            nrc = tiprun.not_started(cfg, request_id, f"{label}: post-reservation launch gate refused (exit {rc})",
                                     "none: worker startup was not attempted", verb="LAUNCH")
            return finish(nrc, "not-started" if nrc == 1 else "reserved")
    done = run_on(cfg, box, farside.structured_launch(script) if result_file else script, far_args, capture=bool(result_file))
    if result_file and done.rc == 0:
        try:
            with open(result_file, "w", encoding="utf-8") as output:
                output.write(done.out)
        except OSError:
            cli.say("LAUNCH UNKNOWN: cannot write structured result; inspect status before retrying")
            return finish(4, "uncertain")
    if request is not None and done.rc == farside.LAUNCH_NOT_STARTED:
        # The one proven pre-start outcome (farside's closed list): the far side's refusal above
        # says why, and the reservation is concluded not-launched.
        nrc = tiprun.not_started(cfg, request_id, f"{label}: far-side startup refused before starting anything",
                                 "none: worker startup refused before run.sh", verb="LAUNCH")
        return finish(nrc, "not-started" if nrc == 1 else "reserved")
    if request is not None and done.rc != 0:
        # Anything else may follow run.sh starting (tm_worker's trc=2), or is not proven (a signal,
        # a shell error, a dropped connection). Do not conclude it automatically:
        # preserve that evidence and name the reservation to repair.
        cli.say(f"LAUNCH UNKNOWN {label}: reservation {request_id} remains dispatched; inspect status and execution list; "
                "conclude not-launched only if no worker started, otherwise reconcile what ran")
        return finish(4, "uncertain")
    if done.unreachable:
        return finish(_unreachable(f"LAUNCH UNREACHABLE {box}"), "uncertain")
    if done.rc == 0 and replace:
        # The row's relaunch, when this launch replaced a record (tally.py: THE RELAUNCH DECISION),
        # on stderr, never this launch's exit.
        tally.after_replace(cfg, box, name, when)
    return finish(done.rc, "started" if done.rc == 0 else "uncertain")


# --- attach, status, log -------------------------------------------------------------------------

ATTACH_TRIES = 40
ATTACH_RETRY = 60


def cmd_attach(cfg: Config, args: list[str]) -> int:
    box, name = _box_and_name(args, "attach")
    if not valid_name(name):
        die("attach: name must be [A-Za-z0-9._-]+")
    interval = "30"
    rest = args[2:]
    i = 0
    while i < len(rest):
        if rest[i] != "--interval":
            die(f"attach: unknown option {rest[i]}")
        interval = _value(rest, i) or "30"
        i += 2
    if not _DIGITS.fullmatch(interval) or interval == "0":
        die("attach: --interval must be a positive number of seconds")
    # The far side waits; a dropped connection (box asleep, tailnet blip) is retried here, from the
    # coordinator, because the worker is still running on its box regardless.
    script = prelude(cfg, box) + farside.VERDICT + farside.ATTACH
    tries = 0
    while True:
        done = run_on(cfg, box, script, [name, interval])
        if not done.unreachable:
            return done.rc
        tries += 1
        if tries >= ATTACH_TRIES:
            return _unreachable(f"ATTACH UNREACHABLE {box}/{name}: gave up after {tries} attempts")
        cli.say(f"attach: {box} unreachable (attempt {tries}), retrying in {ATTACH_RETRY}s")
        time.sleep(ATTACH_RETRY)


def cmd_status(cfg: Config, args: list[str]) -> int:
    box, name = _box_and_name(args, "status")
    if not valid_name(name):
        die("status: name must be [A-Za-z0-9._-]+")
    done = run_on(cfg, box, prelude(cfg, box) + farside.STATUS, [name])
    if done.unreachable:
        return _unreachable(f"STATUS UNREACHABLE {box}/{name}")
    return done.rc


def cmd_log(cfg: Config, args: list[str]) -> int:
    box, name = _box_and_name(args, "log")
    if not valid_name(name):
        die("log: name must be [A-Za-z0-9._-]+")
    lines = "40"
    last_result = n_given = False
    rest = args[2:]
    i = 0
    while i < len(rest):
        if rest[i] == "--last-result":
            last_result = True
            i += 1
            continue
        if rest[i] != "-n":
            die(f"log: unknown option {rest[i]}")
        lines = _value(rest, i) or "40"
        n_given = True
        i += 2
    # The final message is read whole or not at all: a tail of it could cut off the lines a
    # coordinator parses it for (EXECUTION_REQUEST / EXECUTION_RESULT, the hand-back report).
    if last_result and n_given:
        die("log: --last-result prints the whole final message; -n does not apply to it")
    if last_result:
        done = run_on(cfg, box, prelude(cfg, box) + farside.LOG_LAST_RESULT, [name])
    else:
        done = run_on(cfg, box, prelude(cfg, box) + farside.LOG, [name, lines])
    if done.unreachable:
        return _unreachable(f"LOG UNREACHABLE {box}/{name}")
    return done.rc


# --- unstick, close ------------------------------------------------------------------------------


def cmd_unstick(cfg: Config, args: list[str]) -> int:
    box, name = _box_and_name(args, "unstick")
    if not valid_name(name):
        die("unstick: name must be [A-Za-z0-9._-]+")
    msg = ""
    kill = interrupt = given = False
    extra: list[str] = []
    rest = args[2:]
    i = 0
    while i < len(rest):
        match rest[i]:
            case "--message":
                msg = _value(rest, i)
                i += 1
            case "--kill":
                kill = True
            case "--interrupt":
                interrupt = True
            case "--":
                extra = rest[i + 1 :]
                given = True
                break
            case _:
                die(f"unstick: unknown option {rest[i]}")
        i += 1
    if interrupt:
        if kill:
            die("unstick: --interrupt stops the turn and keeps the process, --kill replaces the process; pass one")
        if given:
            die("unstick: --interrupt reaches a live process, which takes no CLI arguments (they need --kill)")
        if msg and not os.access(msg, os.R_OK):
            die("unstick: --message <readable file>")
    elif not msg or not os.access(msg, os.R_OK):
        die("unstick: --message <readable file> (or --interrupt)")
    dwait = knob(cfg, "FLEET_DELIVERY_WAIT", "20")
    if not _DIGITS.fullmatch(dwait):
        die("unstick: FLEET_DELIVERY_WAIT must be a number of seconds")
    if not feeder_wait_ok(cfg):
        die("unstick: FLEET_FEEDER_WAIT must be a positive number of seconds")
    # The uuid the message's input line carries: its replay in the stream proves delivery. An
    # interrupt's request_id plays the same part for the CLI's receipt of it.
    mid = gen_uuid()
    rid = gen_uuid() if interrupt else ""
    label = f"{box}/{name}"
    rc = anchor_gate(cfg, "UNSTICK", label, True, lost_status(cfg.lease_loss_status))
    if rc != 0:
        return rc
    # No message (a bare --interrupt): nothing to stage, and an empty stamp tells the far side so.
    when = ""
    if msg:
        when = stamp()
        done = put_file(cfg, box, msg, f"{cfg.state}/incoming/{name}-{when}.md")
        if done.unreachable:
            return _unreachable(f"UNSTICK UNREACHABLE {box}")
        if done.rc != 0:
            cli.say(f"UNSTICK REFUSED {label}: cannot stage the message under the worker state dir on {box} (unwritable, or a file in the way)")
            return 1
    # Re-read the lease after the upload, right before the worker is touched: an adoption that
    # completed meanwhile fences this intervention (residual window: one ssh round trip).
    rc = anchor_gate(cfg, "UNSTICK", label, True, lost_status(cfg.lease_loss_status))
    if rc != 0:
        return rc
    script = prelude(cfg, box) + farside.ghprobe(knob(cfg, "FLEET_GH_TIMEOUT", "30")) + farside.UNSTICK
    # given: the unstick named its CLI args (`--`, even with none after it), which replace the
    # recorded ones; without it a resume reuses the launch's (ludics#539).
    done = run_on(cfg, box, script, [name, "1" if kill else "0", when, mid, dwait, rid, "1" if given else "0", *extra])
    if done.unreachable:
        return _unreachable(f"UNSTICK UNREACHABLE {box}/{name}")
    if done.rc == 0:
        # The row's count of this coordinator turn (tally.py: the message classifies itself), on
        # stderr, never this unstick's exit.
        tally.after_unstick(cfg, box, name, msg, kill=kill, interrupt=interrupt)
    return done.rc


def cmd_close(cfg: Config, args: list[str]) -> int:
    box, name = _box_and_name(args, "close")
    if not valid_name(name):
        die("close: name must be [A-Za-z0-9._-]+")
    if len(args) > 2:
        die(f"close: unknown option {args[2]}")
    cwait = knob(cfg, "FLEET_CLOSE_WAIT", "60")
    if not _DIGITS.fullmatch(cwait):
        die("close: FLEET_CLOSE_WAIT must be a number of seconds")
    rc = anchor_gate(cfg, "CLOSE", f"{box}/{name}", True)
    if rc != 0:
        return rc
    done = run_on(cfg, box, prelude(cfg, box) + farside.VERDICT + farside.CLOSE, [name, cwait])
    if done.unreachable:
        return _unreachable(f"CLOSE UNREACHABLE {box}/{name}")
    return done.rc


# --- ls ------------------------------------------------------------------------------------------


def cmd_ls(cfg: Config, args: list[str]) -> int:
    """Every worker on each box named, or on this box and every other roster box (exit 4 when one
    did not answer, else 1 when one's inventory failed)."""
    boxes = " ".join(args).split()
    if not boxes:
        boxes = ["local", *(b for b in cfg.boxes.split() if not is_local(cfg, b))]
    worst = 0
    for box in boxes:
        done = run_on(cfg, box, prelude(cfg, box) + farside.LS, [])
        if done.unreachable:
            cli.say(f"{box}: unreachable")
            worst = 4
        elif done.rc != 0:
            cli.say(f"{box}: inventory failed (exit {done.rc})")
            if worst != 4:
                worst = 1
    return worst
