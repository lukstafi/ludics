"""``wave``: the coordinator kit (ludics#1047), the per-wave tooling every coordinator re-wrote.

Each wave's coordinator rebuilt the same scripts under ``$ISSUE_WAVE_STATE/<wave>/`` -- a brief
renderer, a launch-prep ``next.sh``, an integration-loop ``loop.sh``, a ``heartbeat.sh`` -- and each
copy re-learnt an old trap: an exit status lost in a pipe, a ``tail`` cutting a PR line, a restarted
loop orphaning its run. The kit is those four, project-neutral, so a wave directory holds data:

  wave render [--set NAME=VALUE]... [--set-file NAME=<path>]... [--out <file>] <part>...   wavebrief.py
  wave prep <wave.json> <task> --base <rev> [--issue <N> | --source <N>]                    waveprep.py
            [--mode none|paired|paired+critique] [--legs <box,...>] [--allow-rival <pr>]...
            [--profile <name>] [--host <box>]
  wave launch <wave.json> <task>                                                            wavelaunch.py
  wave loop <wave.json> <name> [--resume-after <request id> | --rerun <red id> -- <command>]                                waveloop.py
  wave heartbeat <wave.json> [--sleep <seconds>]                                             here
  wave drive <wave.json> [--poll <seconds>] [--once]                                         wavedrive.py
  wave turn <wave.json> <task>                                                              wavedrive.py
  wave decide <wave.json> <issue> --tier 2|mid-wave|3 --call <line> --body-file <file>      wavedecide.py
              --by <model> [--task <task>] [--posted <url>]
  wave decisions <wave.json>                                                                wavedecide.py
  wave review <wave.json> <task> <pr> <sha> --kind at-open|confirm                          wavereview.py
              [--issue <N> | --source <N>] [--dry-run | --posted <url> | --again]

It wraps the mechanisms that exist and re-implements none: ``execution run`` takes the
reservations, ``board set`` writes the row, ``execution tip-run`` runs and concludes each loop run,
``prs`` and ``halted`` are the heartbeat's reads. The launch gate (``gate --wait``) and the
PLAN_READY extractor (``peer-plan.sh save-plan --from-transcript``) are verbs already, and stay the
coordinator's calls.

THE WAVE FILE, ``wave.json``, the per-wave facts and the only place a project's facts enter the kit.
Its directory is the wave directory. A fail-closed allowlist: a key not listed here, a required key
missing, or a value of the wrong shape is a usage refusal (exit 2) before anything is read or run.

  wave              the wave id                                       required
  repository        <owner>/<name>: the PR repository, the worktrees' required
  checkout          the local primary checkout (absolute); worktrees  required
                    go under ``<checkout>-worktrees/`` (``launch``'s convention, farside.py)
  worker_prefix     the worker is ``<prefix>-<N>`` (``<prefix>-<task>`` required
                    for a --source task), its branch ``<kind>/<worker>``
  agent_host        the box the workers' agents run on                required
  transport         the workers' transport (``subagent``, ...)         required
  kind              ``claude`` or ``codex``                             required
  standing_purpose  the agent host's standing reservation purpose,    required
                    rendered with the task's placeholders (waveprep.py)
  issue_repository  <owner>/<name> the issues live in                 default: repository
  vars              {NAME: text}: wave-wide placeholder values (the   default: {}
                    coordinator's session id, a lock path); a built-in NAME is refused.
                    The shipped template (waveprep.py, THE PARTS) names COORDINATOR
                    (the coordinator's session id) and MAIN (the main branch)
  project_part      the project's own brief part, a path relative to  default: none
                    the checkout and read at the task's base (waveprep.py,
                    THE PROJECT PART); no leading ``/``, no ``..`` component
  legs              {<box>: {checkout, suffix, purpose[, vars]}}: a   default: {}
                    GPU home box --legs may name; its far-side worktree is
                    ``<checkout>-worktrees/<worker>-<suffix>``, ``vars`` are the leg's own NAMEs;
                    each suffix is its leg's alone and none is ``base``, since a leg's payload
                    file is ``reserve/<task>-<suffix>.json``
  loops             {<name>: {box, purpose, checkout, tip, command    default: {}
                    [, cpu][, integration][, poll]}}: an integration loop (waveloop.py)
  profiles          {<name>: {transport, kind[, model][, effort]}}: a  default: {}
                    kind of worker ``wave prep --profile`` gives a task in place of the wave's
                    own transport and kind (a mixed wave: native Claude workers beside Codex CLI
                    ones); ``transport`` is ``subagent`` or ``cli``, and ``model`` and ``effort``
                    are a CLI worker's (``wave launch`` passes them to its CLI)
  hosts             {<box>: {checkout, scratch}}: where a CLI worker     default: {}
                    lives on a box that is not the agent host: the box's clone of the repository
                    (its worktree goes under ``<checkout>-worktrees/``) and the directory its
                    scratch goes under (``<scratch>/<wave>/<task>``), both absolute there
  review            {kind, model[, label][, project_part][, timeout]}: default: none
                    the review checkpoint's reviewer (wavereview.py): ``kind`` the CLI that runs
                    it (``claude``, the one kind there is), ``model`` its model, ``label`` the
                    name its posts carry (default: the model), ``project_part`` the project's
                    own review part, a path as ``project_part`` above, ``timeout`` whole seconds
                    (default 1800)

``wave heartbeat`` is one tick, re-armed by the coordinator (issue-wave SKILL.md, the heartbeat):
it sleeps, then prints, in order and nothing piped, ``prs <repository> --wave <wave>`` whole and
``HEARTBEAT prs exit=<n>``, ``halted`` and ``HEARTBEAT halted exit=<n>``, a ``HEARTBEAT loop <name>:
<last line>`` for each configured loop (``no log yet`` when it has none), THE DRIVER's lines, and
last ``HEARTBEAT <wave> <UTC time>``. It decides nothing: what the lines mean is the coordinator's.
It exits 0 after a tick whatever its reads exited (each status is printed), 2 on usage.

THE DRIVER's lines (``wave drive``, wavedrive.py), printed only for a wave directory that has a
driver's files: ``HEARTBEAT drive: running|not running`` (whether a process holds
``logs/drive.lock``) with the last line of ``logs/drive.log``, then one ``HEARTBEAT attention``
line per record of ``logs/attention.jsonl`` not printed by an earlier heartbeat (a byte offset kept
in ``logs/attention.seen``; the first heartbeat prints every record there is). The sleep ends early
when the attention file grows past that offset, so a turn the driver cannot answer wakes the
coordinator within ``ATTENTION_POLL`` seconds, not at the next ten-minute tick.
"""

import fcntl
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import run
from ludics.fleetworker.wavebrief import NAME, cmd_render

USAGE = (
    "wave render [--set NAME=VALUE]... [--set-file NAME=<path>]... [--out <file>] <part>... | "
    "wave prep <wave.json> <task> --base <rev> [--issue <N> | --source <N>] [--mode none|paired|paired+critique]"
    " [--legs <box,...>] [--allow-rival <pr>]... [--profile <name>] [--host <box>] | wave launch <wave.json> <task> | "
    "wave loop <wave.json> <name> [--resume-after <request id> | --rerun <red id> -- <command>] | "
    "wave heartbeat <wave.json> [--sleep <seconds>] | "
    "wave drive <wave.json> [--poll <seconds>] [--once] | wave turn <wave.json> <task> | "
    "wave decide <wave.json> <issue> --tier 2|mid-wave|3 --call <line> --body-file <file> --by <model> [--task <task>]"
    " [--posted <url>] | wave decisions <wave.json> | "
    "wave review <wave.json> <task> <pr> <sha> --kind at-open|confirm [--issue <N> | --source <N>]"
    " [--dry-run | --posted <url> | --again]"
)
WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+")
# The NAMEs wave prep gives every part (waveprep.py's header says what each is); a wave's own vars
# may not shadow one.
BUILTIN = frozenset({"WAVE", "T", "N", "ISSUE", "SOURCE", "REPO", "ISSUE_REPO", "CHECKOUT", "WAVE_DIR", "WT", "BR",
                     "BASE", "SCR", "SCR_PARENT", "WORKER", "HOST", "MODE", "PROJECT", "LEGLINES", "LEG", "LEG_ID", "LEG_WT",
                     "LEG_CHECKOUT"})
TOP_REQUIRED = ("wave", "repository", "checkout", "worker_prefix", "agent_host", "transport", "kind", "standing_purpose")
TOP_OPTIONAL = ("issue_repository", "vars", "legs", "loops", "project_part", "review", "profiles", "hosts")
PROFILE_REQUIRED, PROFILE_OPTIONAL = ("transport", "kind"), ("model", "effort")
PROFILE_TRANSPORTS = ("subagent", "cli")
KINDS = ("claude", "codex")
HOST_REQUIRED = ("checkout", "scratch")
REVIEW_REQUIRED, REVIEW_OPTIONAL = ("kind", "model"), ("label", "project_part", "timeout")
REVIEW_KINDS = ("claude",)
# A reviewer's model and label: what a CLI flag and pr-review.sh comment's footer both take.
REVIEW_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._+/-]*[A-Za-z0-9._+/-])?")
LEG_REQUIRED, LEG_OPTIONAL = ("checkout", "suffix", "purpose"), ("vars",)
LOOP_REQUIRED, LOOP_OPTIONAL = ("box", "purpose", "checkout", "tip", "command"), ("cpu", "integration", "poll")


@dataclass(frozen=True)
class Leg:
    box: str
    checkout: str
    suffix: str
    purpose: str
    vars: dict[str, str]


@dataclass(frozen=True)
class Loop:
    name: str
    box: str
    purpose: str
    checkout: str
    tip: str
    command: list[str]
    cpu: bool
    integration: bool
    poll: int


@dataclass(frozen=True)
class Profile:
    transport: str
    kind: str
    model: str = ""  # "" when the profile names none: the CLI's own default
    effort: str = ""


@dataclass(frozen=True)
class Host:
    box: str
    checkout: str
    scratch: str


@dataclass(frozen=True)
class Review:
    kind: str
    model: str
    label: str
    project_part: str  # relative to checkout; "" when the wave file names none
    timeout: int


@dataclass(frozen=True)
class Wave:
    path: str  # the wave file, absolute
    directory: str  # the wave directory: the file's
    wave: str
    repository: str
    checkout: str
    worker_prefix: str
    agent_host: str
    transport: str
    kind: str
    standing_purpose: str
    issue_repository: str
    project_part: str = ""  # relative to checkout; "" when the wave file names none
    vars: dict[str, str] = field(default_factory=lambda: {})
    legs: dict[str, Leg] = field(default_factory=lambda: {})
    loops: dict[str, Loop] = field(default_factory=lambda: {})
    review: Review | None = None
    profiles: dict[str, Profile] = field(default_factory=lambda: {})
    hosts: dict[str, Host] = field(default_factory=lambda: {})


def keys_problem(obj: dict[str, Any], what: str, required: tuple[str, ...], optional: tuple[str, ...]) -> str | None:
    unknown = sorted(set(obj) - set(required) - set(optional))
    if unknown:
        return f"{what} has unknown key(s) {', '.join(unknown)} (it takes {', '.join(required + optional)})"
    missing = [k for k in required if k not in obj]
    if missing:
        return f"{what} lacks {', '.join(missing)}"
    return None


def text(obj: dict[str, Any], key: str, what: str, pattern: re.Pattern[str] | None = None) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value or "\n" in value:
        raise ValueError(f"{what}.{key} must be one non-empty line of text, not {json.dumps(value)}")
    if pattern is not None and not pattern.fullmatch(value):
        raise ValueError(f"{what}.{key} {json.dumps(value)} does not match {pattern.pattern}")
    return value


def absolute(obj: dict[str, Any], key: str, what: str) -> str:
    value = text(obj, key, what)
    if not value.startswith("/"):
        raise ValueError(f"{what}.{key} must be an absolute path, not {json.dumps(value)}")
    return value.rstrip("/") or "/"


def var_map(value: Any, what: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise ValueError(f"{what} must be an object of NAME: text")
    out: dict[str, str] = {}
    for name, given in cast(dict[str, Any], value).items():
        if not NAME.fullmatch(name):
            raise ValueError(f"{what} names {json.dumps(name)}, no placeholder name ([A-Z][A-Z0-9_]*)")
        if name in BUILTIN:
            raise ValueError(f"{what} names {name}, a NAME wave prep gives itself")
        if not isinstance(given, str):
            raise ValueError(f"{what}.{name} must be text")
        out[name] = given
    return out


def relative(obj: dict[str, Any], key: str, what: str) -> str:
    value = text(obj, key, what)
    if value.startswith("/") or ".." in value.split("/") or "\\" in value:
        raise ValueError(f"{what}.{key} must be a path relative to the checkout, with no .. component,"
                         f" not {json.dumps(value)}")
    return value


def objects(value: Any, what: str) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        raise ValueError(f"{what} must be an object")
    out: dict[str, dict[str, Any]] = {}
    for name, entry in cast(dict[str, Any], value).items():
        if not WORD.fullmatch(name):
            raise ValueError(f"{what} names {json.dumps(name)}, which does not match {WORD.pattern}")
        if not isinstance(entry, dict):
            raise ValueError(f"{what}.{name} must be an object")
        out[name] = cast(dict[str, Any], entry)
    return out


def parse_review(value: Any) -> Review:
    what = "review"
    if not isinstance(value, dict):
        raise ValueError(f"{what} must be an object")
    entry = cast(dict[str, Any], value)
    problem = keys_problem(entry, what, REVIEW_REQUIRED, REVIEW_OPTIONAL)
    if problem:
        raise ValueError(problem)
    kind = text(entry, "kind", what)
    if kind not in REVIEW_KINDS:
        raise ValueError(f"{what}.kind must be one of {', '.join(REVIEW_KINDS)}, not {json.dumps(kind)}")
    model = text(entry, "model", what, REVIEW_NAME)
    timeout: Any = entry.get("timeout", 1800)
    if not (isinstance(timeout, int) and not isinstance(timeout, bool) and timeout > 0):
        raise ValueError(f"{what}.timeout must be a positive whole number of seconds")
    return Review(kind, model, text(entry, "label", what, REVIEW_NAME) if "label" in entry else model,
                  relative(entry, "project_part", what) if "project_part" in entry else "", timeout)


def parse_wave(path: str, data: Any) -> Wave:
    """The wave file's facts, or ValueError naming the first thing wrong with it."""
    if not isinstance(data, dict):
        raise ValueError("it is not one JSON object")
    top = cast(dict[str, Any], data)
    problem = keys_problem(top, "the wave file", TOP_REQUIRED, TOP_OPTIONAL)
    if problem:
        raise ValueError(problem)
    w = "the wave file"
    kind = text(top, "kind", w)
    if kind not in KINDS:
        raise ValueError(f"{w}.kind must be claude or codex, not {json.dumps(kind)}")
    profiles: dict[str, Profile] = {}
    for name, entry in objects(top.get("profiles", {}), "profiles").items():
        what = f"profiles.{name}"
        problem = keys_problem(entry, what, PROFILE_REQUIRED, PROFILE_OPTIONAL)
        if problem:
            raise ValueError(problem)
        transport, its_kind = text(entry, "transport", what), text(entry, "kind", what)
        if transport not in PROFILE_TRANSPORTS or its_kind not in KINDS:
            raise ValueError(f"{what} must have a transport of {' or '.join(PROFILE_TRANSPORTS)} and a kind of"
                             f" {' or '.join(KINDS)}, not {json.dumps(transport)} and {json.dumps(its_kind)}")
        profiles[name] = Profile(transport, its_kind, *(text(entry, key, what, REVIEW_NAME) if key in entry else ""
                                                        for key in PROFILE_OPTIONAL))
    hosts: dict[str, Host] = {}
    for box, entry in objects(top.get("hosts", {}), "hosts").items():
        what = f"hosts.{box}"
        problem = keys_problem(entry, what, HOST_REQUIRED, ())
        if problem:
            raise ValueError(problem)
        hosts[box] = Host(box, absolute(entry, "checkout", what), absolute(entry, "scratch", what))
    legs: dict[str, Leg] = {}
    for box, entry in objects(top.get("legs", {}), "legs").items():
        what = f"legs.{box}"
        problem = keys_problem(entry, what, LEG_REQUIRED, LEG_OPTIONAL)
        if problem:
            raise ValueError(problem)
        suffix = text(entry, "suffix", what, WORD)
        # A leg's payload is reserve/<task>-<suffix>.json, kept from prep to a CLI worker's launch: two
        # legs with one suffix would share a file, and `base` is the assign base's own name.
        if suffix == "base" or any(leg.suffix == suffix for leg in legs.values()):
            raise ValueError(f"{what}.suffix {json.dumps(suffix)} is another leg's, or the reserved name base: each leg's payload"
                             " file is named by its suffix")
        legs[box] = Leg(box, absolute(entry, "checkout", what), suffix, text(entry, "purpose", what),
                        var_map(entry.get("vars", {}), f"{what}.vars"))
    loops: dict[str, Loop] = {}
    for name, entry in objects(top.get("loops", {}), "loops").items():
        what = f"loops.{name}"
        problem = keys_problem(entry, what, LOOP_REQUIRED, LOOP_OPTIONAL)
        if problem:
            raise ValueError(problem)
        command: Any = entry.get("command")
        if not (isinstance(command, list) and command and all(isinstance(c, str) for c in cast(list[Any], command))):
            raise ValueError(f"{what}.command must be a non-empty list of argv words")
        for flag in ("cpu", "integration"):
            if flag in entry and not isinstance(entry[flag], bool):
                raise ValueError(f"{what}.{flag} must be true or false")
        poll: Any = entry.get("poll", 300)
        if not (isinstance(poll, int) and not isinstance(poll, bool) and poll > 0):
            raise ValueError(f"{what}.poll must be a positive whole number of seconds")
        loops[name] = Loop(name, text(entry, "box", what, WORD), text(entry, "purpose", what), absolute(entry, "checkout", what),
                           text(entry, "tip", what), list(cast(list[str], command)), bool(entry.get("cpu", False)),
                           bool(entry.get("integration", False)), poll)
    repository = text(top, "repository", w, REPOSITORY)
    return Wave(
        path=path,
        directory=os.path.dirname(path),
        wave=text(top, "wave", w, WORD),
        repository=repository,
        checkout=absolute(top, "checkout", w),
        worker_prefix=text(top, "worker_prefix", w, WORD),
        agent_host=text(top, "agent_host", w, WORD),
        transport=text(top, "transport", w, WORD),
        kind=kind,
        standing_purpose=text(top, "standing_purpose", w),
        issue_repository=text(top, "issue_repository", w, REPOSITORY) if "issue_repository" in top else repository,
        project_part=relative(top, "project_part", w) if "project_part" in top else "",
        vars=var_map(top.get("vars", {}), "vars"),
        legs=legs,
        loops=loops,
        review=parse_review(top["review"]) if "review" in top else None,
        profiles=profiles,
        hosts=hosts,
    )


def load_wave(path: str, verb: str) -> Wave:
    """The wave file at ``path``, or a usage refusal naming what is wrong with it."""
    absolute_path = os.path.abspath(path)
    try:
        with open(absolute_path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except (OSError, ValueError) as exc:
        die(f"wave {verb}: {path} is not a readable JSON wave file ({exc})")
    try:
        return parse_wave(absolute_path, data)
    except ValueError as exc:
        die(f"wave {verb}: {path}: {exc}")


def shim(cfg: Config) -> str:
    """This fleet-worker.sh, as tip-run's ``fleet_worker`` names it."""
    return os.path.join(cfg.here, os.path.basename(cfg.script))


def loop_log(wave: Wave, name: str) -> str:
    return os.path.join(wave.directory, "logs", f"loop-{name}.log")


def last_line(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = [line for line in f.read().split("\n") if line.strip()]
    except OSError:
        return None
    return lines[-1] if lines else None


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


ATTENTION_POLL = 5


def attention_state(wave: Wave) -> tuple[str, str, int, int]:
    """The attention file, the cursor file, the offset already printed, and the file's size."""
    path, seen = os.path.join(wave.directory, "logs", "attention.jsonl"), os.path.join(wave.directory, "logs", "attention.seen")
    try:
        with open(seen, encoding="ascii") as f:
            offset = int(f.read().strip() or 0)
    except (OSError, ValueError):
        offset = 0
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return path, seen, min(offset, size), size


def nap(wave: Wave, seconds: int) -> None:
    """The heartbeat's sleep, ended early by a new attention record (THE DRIVER's lines)."""
    deadline = time.monotonic() + seconds
    while (left := deadline - time.monotonic()) > 0:
        _, _, offset, size = attention_state(wave)
        if size > offset:
            return
        time.sleep(min(ATTENTION_POLL, left))


def driver_lines(wave: Wave) -> list[str]:
    """THE DRIVER's lines (the header); none for a wave no driver has served."""
    lock = os.path.join(wave.directory, "logs", "drive.lock")
    if not os.path.exists(lock):
        return []
    running = False
    with open(lock, "a", encoding="utf-8") as held:
        try:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            running = True
    last = last_line(os.path.join(wave.directory, "logs", "drive.log"))
    lines = [f"HEARTBEAT drive: {'running' if running else 'NOT RUNNING'}; {last if last is not None else 'no log yet'}"]
    path, seen, offset, size = attention_state(wave)
    if size > offset:
        with open(path, "rb") as f:
            f.seek(offset)
            fresh = f.read(size - offset)
        for raw in fresh.decode("utf-8", "replace").splitlines():
            try:
                record: Any = json.loads(raw)
            except ValueError:
                record = None
            if isinstance(record, dict):
                entry = cast(dict[str, Any], record)
                where = f" ({entry.get('file')})" if entry.get("file") else ""
                turn = "launch" if entry.get("turn") == -1 else f"turn {entry.get('turn')}"  # wavedrive.LAUNCH
                lines.append(f"HEARTBEAT attention {entry.get('task')} {turn}: {entry.get('why')}{where}")
        with open(seen, "w", encoding="ascii") as f:
            f.write(f"{size}\n")
    return lines


def cmd_heartbeat(cfg: Config, args: list[str]) -> int:
    if not args or args[0].startswith("--"):
        die(f"wave heartbeat: name the wave file; usage: {USAGE}")
    seconds = 600
    rest = args[1:]
    if rest:
        if len(rest) != 2 or rest[0] != "--sleep" or not rest[1].isdigit():
            die(f"wave heartbeat: takes only --sleep <whole seconds>; usage: {USAGE}")
        seconds = int(rest[1])
    wave = load_wave(args[0], "heartbeat")
    if seconds:
        nap(wave, seconds)
    script = shim(cfg)
    # Each read prints straight to our stdout, whole: no tail can cut a PR line (#1050), and its
    # exit is printed after it rather than lost in a pipe.
    rc = run([script, "prs", wave.repository, "--wave", wave.wave]).rc
    cli.say(f"HEARTBEAT prs exit={rc}")
    rc = run([script, "halted"]).rc
    cli.say(f"HEARTBEAT halted exit={rc}")
    for name in wave.loops:
        line = last_line(loop_log(wave, name))
        cli.say(f"HEARTBEAT loop {name}: {line if line is not None else 'no log yet'}")
    for line in driver_lines(wave):
        cli.say(line)
    cli.say(f"HEARTBEAT {wave.wave} {utc_now()}")
    return 0


def cmd_wave(cfg: Config, args: list[str]) -> int:
    from ludics.fleetworker import wavedecide, wavedrive, wavelaunch, waveloop, waveprep, wavereview

    match args[:1]:
        case ["render"]:
            return cmd_render(args[1:])
        case ["prep"]:
            return waveprep.cmd_prep(cfg, args[1:])
        case ["launch"]:
            return wavelaunch.cmd_launch(cfg, args[1:])
        case ["loop"]:
            return waveloop.cmd_loop(cfg, args[1:])
        case ["heartbeat"]:
            return cmd_heartbeat(cfg, args[1:])
        case ["review"]:
            return wavereview.cmd_review(cfg, args[1:])
        case ["decide"]:
            return wavedecide.cmd_decide(cfg, args[1:])
        case ["decisions"]:
            return wavedecide.cmd_decisions(cfg, args[1:])
        case ["drive"]:
            return wavedrive.cmd_drive(cfg, args[1:])
        case ["turn"]:
            return wavedrive.cmd_turn(cfg, args[1:])
        case _:
            die(f"usage: {USAGE}")
