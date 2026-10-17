"""The CLI worker's life: ``launch``, ``attach``, ``status``, ``log``, ``unstick``, ``close`` and ``ls``
(fleet-worker.sh's ``cmd_launch``, ``cmd_attach``, ``cmd_status``, ``cmd_log``, ``cmd_unstick``,
``cmd_close``, ``cmd_ls``).

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

import os
import re
import time

from ludics import cli
from ludics.fleetworker import farside
from ludics.fleetworker.config import Config, short_hostname
from ludics.fleetworker.gate import base_gate
from ludics.fleetworker.identity import die, gen_uuid
from ludics.fleetworker.lease import anchor_gate
from ludics.fleetworker.preflight import knob, run_preflight, siblings_of
from ludics.fleetworker.transport import err, is_local, prelude, put_file, run_on, substitution

_NAME = re.compile(r"[A-Za-z0-9._-]+")
_SHA = re.compile(r"[0-9a-f]{40}")
_DIGITS = re.compile(r"[0-9]+")


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


def cmd_launch(cfg: Config, args: list[str]) -> int:
    box, name = _box_and_name(args, "launch")
    if not valid_name(name):
        die("launch: name must be [A-Za-z0-9._-]+ and not start with a dot")
    kind = brief = cwd = repo = branch = target = base_branch = reason = ""
    base = cfg.env.get("FLEET_BASE_REF") or "origin/master"
    force = replace = False
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
            case "--":
                extra = rest[i + 1 :]
                break
            case _:
                die(f"launch: unknown option {arg}")
        i += 1
    if kind not in ("claude", "codex"):
        die("launch: --kind claude|codex")
    if not feeder_wait_ok(cfg):
        die("launch: FLEET_FEEDER_WAIT must be a positive number of seconds")
    if "\n" in cwd + repo + branch + base:
        die("launch: paths and refs must not contain newlines (the record is line-oriented)")
    if not brief or not os.access(brief, os.R_OK):
        die("launch: --brief <readable file>")
    label = f"{box}/{name}"
    if not cwd:
        if not repo or not branch:
            die("launch: --cwd <dir>, or --repo <dir> --branch <branch>")
        # --repo is a checkout path on the box while --target-repo is owner/repo, and the two are
        # easily swapped. An existing path is a path whatever its shape (asked of the box, where it
        # resolves); only a missing one shaped like owner/name is refused, before the lease is read.
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+", repo):
            done = run_on(cfg, box, prelude(cfg, box) + farside.LAUNCH_EXISTS, [repo])
            if done.unreachable:
                return _unreachable(f"LAUNCH UNREACHABLE {box}")
            if done.rc != 0:
                die(
                    f"launch: --repo takes the path of a checkout on {box}, not a GitHub owner/name like {repo};"
                    " the GitHub repository goes in --target-repo"
                )
    rc = anchor_gate(cfg, "LAUNCH", label, force)
    if rc != 0:
        return rc
    # Worktree creation names its base already. An explicit CI branch is needed for non-origin refs
    # (tags, SHAs, or another remote); an existing cwd uses the repository's default branch.
    if not cwd and not base_branch:
        if not base.startswith("origin/"):
            die("launch: --base-branch required for a non-origin --base")
        base_branch = base[len("origin/") :]
    done = run_preflight(cfg, box, "1" if kind == "codex" else "0", "1", siblings_of(cfg, box), capture=True)
    if done.unreachable:
        return _unreachable(f"LAUNCH UNREACHABLE {box}")
    pf = substitution(done.out)
    if done.rc != 0:
        cli.say(f"LAUNCH REFUSED {label}: {pf}")
        return 1
    # A passing preflight can still carry a note the coordinator must see before briefing a
    # cross-box leg: a sibling that did not answer. Said on stderr, so the LAUNCHED line stays the
    # one thing on stdout.
    if "cross-box unreachable" in pf or "GitHub unreachable" in pf:
        err(f"preflight note for {label}: {preflight_note(pf)}")
    pinned = ""
    if not cwd:
        # Fetch before reading CI, and carry an immutable object into worktree add.
        done = run_on(
            cfg, box, prelude(cfg, box) + farside.LAUNCH_FETCH, [repo, base, knob(cfg, "FLEET_FETCH_TIMEOUT", "300")],
            capture=True,
        )
        if done.unreachable:
            return _unreachable(f"LAUNCH UNREACHABLE {box}")
        if done.rc != 0:
            return done.rc
        pinned = substitution(done.out)
        if not _SHA.fullmatch(pinned):
            die("launch: could not resolve base commit")
    rc = base_gate(cfg, target, base_branch, force, reason, pinned)
    if rc != 0:
        return rc
    if pinned:
        base = pinned
    # The preflight and base read may take minutes; a halt or adoption during that window must
    # still fence this launch, so the gate is read again right before anything is written.
    rc = anchor_gate(cfg, "LAUNCH", label, force)
    if rc != 0:
        return rc
    # A claude worker's session id, and the uuid the brief's input line carries (its replay
    # proves delivery).
    sid, bid = (gen_uuid(), gen_uuid()) if kind == "claude" else ("", "")
    # The brief lands beside the record, not on it: the far side moves it into place only after
    # the guards pass, so a refused launch leaves a finished worker's brief untouched.
    when = stamp()
    done = put_file(cfg, box, brief, f"{cfg.state}/incoming/{name}-{when}.md")
    if done.unreachable:
        return _unreachable(f"LAUNCH UNREACHABLE {box}")
    if done.rc != 0:
        cli.say(f"LAUNCH REFUSED {label}: cannot stage the brief under the worker state dir on {box} (unwritable, or a file in the way)")
        return 1
    script = prelude(cfg, box) + farside.ghprobe(knob(cfg, "FLEET_GH_TIMEOUT", "30")) + farside.LAUNCH
    far_args = [
        name, kind, cwd, repo, branch, base, sid, short_hostname(), "1" if replace else "0", when,
        knob(cfg, "FLEET_FETCH_TIMEOUT", "300"), bid, *extra,
    ]  # fmt: skip
    done = run_on(cfg, box, script, far_args)
    if done.unreachable:
        return _unreachable(f"LAUNCH UNREACHABLE {box}")
    return done.rc


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
    kill = interrupt = False
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
                break
            case _:
                die(f"unstick: unknown option {rest[i]}")
        i += 1
    if interrupt:
        if kill:
            die("unstick: --interrupt stops the turn and keeps the process, --kill replaces the process; pass one")
        if extra:
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
    rc = anchor_gate(cfg, "UNSTICK", label, True)
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
    rc = anchor_gate(cfg, "UNSTICK", label, True)
    if rc != 0:
        return rc
    script = prelude(cfg, box) + farside.ghprobe(knob(cfg, "FLEET_GH_TIMEOUT", "30")) + farside.UNSTICK
    done = run_on(cfg, box, script, [name, "1" if kill else "0", when, mid, dwait, rid, *extra])
    if done.unreachable:
        return _unreachable(f"UNSTICK UNREACHABLE {box}/{name}")
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
