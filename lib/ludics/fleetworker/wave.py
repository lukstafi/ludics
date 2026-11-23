"""``wave``: the coordinator kit (ludics#1047), the per-wave tooling every coordinator re-wrote.

Each wave's coordinator rebuilt the same scripts under ``$ISSUE_WAVE_STATE/<wave>/`` -- a brief
renderer, a launch-prep ``next.sh``, an integration-loop ``loop.sh``, a ``heartbeat.sh`` -- and each
copy re-learnt an old trap: an exit status lost in a pipe, a ``tail`` cutting a PR line, a restarted
loop orphaning its run. The kit is those four, project-neutral, so a wave directory holds data:

  wave render [--set NAME=VALUE]... [--set-file NAME=<path>]... [--out <file>] <part>...   wavebrief.py
  wave prep <wave.json> <task> --base <base-or-stacked-rev>                                waveprep.py
            [--issue <N> | --source <N>] [--mode none|paired|paired+critique] [--legs <box,...>] [--allow-rival <pr>]...
            [--profile <name>] [--host <box>] [--tier D1|D1/D2|D2|D2/D3|D3]
  wave launch <wave.json> <task> [--status <file>] [--launch-id <id>]                      wavelaunch.py
  wave unprep <wave.json> <task>                                                           waveunprep.py
  wave loop <wave.json> <name> [--resume-after <request id> |                              waveloop.py
            --rerun <red id> -- <command> | --release]
  wave heartbeat <wave.json> [--sleep <seconds>] [--until-attention] [--max-quiet <seconds>] here
  wave drive <wave.json> [--poll <seconds>] [--once]                                       wavedrive.py
  wave turn <wave.json> <task>                                                             wavedrive.py
  wave decide <wave.json> <issue> --tier 2|mid-wave|3 --call <line> --body-file <file>     wavedecide.py
              --by <model> [--task <task>] [--posted <url>]
  wave decisions <wave.json>                                                               wavedecide.py
  wave review <wave.json> <task> <pr> <sha> --kind at-open|confirm                         wavereview.py
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
  kind              ``claude``, ``codex`` or ``gemini`` (CLI only)      required
  standing_purpose  the agent host's standing reservation purpose,    required
                    rendered with the task's placeholders (waveprep.py)
  issue_repository  <owner>/<name> the issues live in                 default: repository
  vars              {NAME: text}: wave-wide placeholder values (the   default: {}
                    coordinator's session id, a lock path); a built-in NAME is refused.
                    The shipped template (waveprep.py, THE PARTS) names COORDINATOR
                    (the coordinator's session id) and MAIN (the main branch)
  project_part      the project's own brief part, a path relative to  default: none
                    the checkout, read at the task's base, else origin/<vars.MAIN>
                    (waveprep.py, THE PROJECT PART); no leading ``/``, no ``..`` component
  legs              {<box>: {checkout, suffix, purpose[, vars]}}: a   default: {}
                    GPU home box --legs may name; its far-side worktree is
                    ``<checkout>-worktrees/<worker>-<suffix>``, ``vars`` are the leg's own NAMEs;
                    each suffix is its leg's alone and none is ``base``, since a leg's payload
                    file is ``reserve/<task>-<suffix>.json``
  loops             {<name>: {box, purpose, checkout, tip, command    default: {}
                    [, cpu][, integration][, poll][, reserve_slot][, standby {box, checkout}]
                    [, failover_after]}}: an integration loop (waveloop.py; the last three are
                    THE RESERVED SLOT's: ``reserve_slot`` needs ``cpu``, ``standby`` needs
                    ``reserve_slot`` and another box, ``failover_after`` -- whole seconds, default
                    1800 -- needs ``standby``)
  split             "issue-number" enables wave prep's A/B NOTE      default: none
                    (waveprep.py, THE ISSUE-NUMBER SPLIT)
  profiles          {<name>: {transport, kind[, model][, effort]}}: a  default: {}
                    kind of worker ``wave prep --profile`` gives a task in place of the wave's
                    own transport and kind (a mixed wave: native Claude workers beside Codex CLI
                    ones); ``transport`` is ``subagent`` or ``cli``, and ``model`` and ``effort``
                    are a CLI worker's (``wave launch`` passes them to its CLI); ``gemini``
                    (Antigravity's agy) has no native transport, so it is ``cli`` only
  hosts             {<box>: {checkout, scratch}}: where a CLI worker     default: {}
                    lives on a box that is not the agent host: the box's clone of the repository
                    (its worktree goes under ``<checkout>-worktrees/``) and the directory its
                    scratch goes under (``<scratch>/<wave>/<task>``), both absolute there
  review            {kind, model[, label][, project_part][, timeout]}: default: none
                    the review checkpoint's reviewer (wavereview.py): ``kind`` the CLI that runs
                    it (``claude``, or ``gemini`` for Antigravity's ``agy``), ``model`` its model
                    (an agy model's slug carries its effort: ``gemini-4-neon-high``), ``label`` the
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
coordinator within ``ATTENTION_POLL`` seconds, not at the next tick.

THE SLEEP is ``--sleep <seconds>``, by default ``HEARTBEAT_SLEEP``, 1200 s (ludics#1157's
follow-up). Since #1175 and #1182 every wake that needs an answer ends it early (a driver attention
line, a cued native task, a refused queue file), and a native worker's hand-off returns on its own,
so a full tick is a liveness read only. It was 600 s, to stay under the Claude Desktop app's pause
of an idle coordinator after about fifteen minutes; on 2026-11-15 a lone 25-minute background
command, with nothing else running and no message meanwhile, re-invoked an idle desktop
coordinator 12 s after it exited, so a tracked command's exit wakes it past that pause.

THE NO-CHANGE LINE (ludics#1157). Every read is taken before anything is printed, and compared with
the last full read, kept in ``logs/heartbeat.last`` (versioned JSON, replaced whole). A tick that
compares equal prints ONE line in place of the read: ``HEARTBEAT <wave> <UTC time> unchanged since
<the last full read's time> (prs exit=<n>, halted exit=<n>, drive running|drive NOT RUNNING|no
driver): the last full read is <that file>``, whose ``read`` holds the lines it printed. Any other
tick prints the whole read as above, after a ``HEARTBEAT changed since <time>: <parts>`` line when
there is a saved read, and is saved. The board-rows part names up to five changed tasks in
sorted order, with old→new state words, ``added``/``removed``, or ``fields changed`` when the
state word stayed the same, then a count of the remaining changed rows. Task names are capped
at 40 characters and quoted to keep control characters on one line; state words at 24.
If duplicate rows collapse to the same task fields, fall back to plain ``board rows``.
An unreadable saved row shape yields ``board rows (previous rows unavailable)``.
Boundary, a fail-closed allowlist of what is compared:
  board rows  each row's task and fields (``board show --json``); a board that does not read makes
              the tick a full read (``HEARTBEAT board: did not read ...``), never an unchanged one,
              and is not saved
  prs         its stdout lines, with the fields that move with the clock alone cut
              (supervision.steady_prs_line: the head's age, a merge build's elapsed seconds and a
              queued one's wait), and its exit
  halted      its stdout and exit
  loops       each loop's line
  driver      THE DRIVER's own line (running or not, and the last line of ``logs/drive.log``)
  attention   any new record makes a full read, whatever its text
Nothing else is read: no stderr, and no field a read's stdout does not print. A loop whose last
line carries a time makes every tick a full read, which is safe. A missing, torn or other-version
state file is no saved read. Two heartbeats run at once race on the file, as on
``logs/attention.seen``: the kit runs one per wave.

UNTIL-ATTENTION MODE (ludics#1312). ``wave heartbeat <wave.json> --until-attention`` keeps ticking
(its sleep, then its reads) and exits 0 only when a tick meets one of this closed list of exit
conditions or reaches the stall bound ``--max-quiet <seconds>`` (positive whole seconds; default
``HEARTBEAT_MAX_QUIET``, 14400 s / 4 h). Plain ``wave heartbeat`` stays one tick by default;
``--max-quiet`` requires ``--until-attention``, and ``--until-attention`` requires a positive
``--sleep``. When ``logs/heartbeat.last`` exists, the first tick compares against it (and reads live
loop locks if the saved file predates ``loop_running``); when no saved read exists and no unread
attention record is pending, a silent baseline read is taken before the first sleep without
advancing ``logs/attention.seen``, so transitions during the first sleep are caught and pre-existing
done rows do not wake immediately.

Closed list of exit conditions (fail-closed):
  attention       any new JSON-object record in ``logs/attention.jsonl`` past ``logs/attention.seen``
                  when ``logs/drive.lock`` exists (also ends the sleep early within ``ATTENTION_POLL``)
  loop alert      a configured loop ``<name>`` whose log's last non-blank line changed and matches
                  ``LOOP <name> RED`` or ``LOOP <name> UNKNOWN`` (optionally preceded by a UTC
                  timestamp ``YYYY-MM-DDTHH:MM:SSZ ``, followed by end-of-line, space or ``:`` --
                  what ``waveloop.py`` writes; no other wording or substring matches)
  loop stopped    a configured loop ``<name>`` whose ``logs/loop-<name>.lock`` went from held to not held
  halt            ``halted`` exited 1 when the last readable ``halted`` read did not exit 1
                  (``halt appeared``), or exited 1 with a different normalized halt reason/id
                  (``halt changed``; leading UTC timestamps on ``HALTED`` / ``update`` lines are
                  ignored so reissuing the same reason stays quiet while the full read keeps the
                  original text); clearing a halt (exit 0) or an unreachable anchor (exit 4) does
                  not exit, and a transient unreadable ``halted`` preserves the last readable halt
                  state in memory
  board done      any board row whose derived phase (``takeover.phase_of``: ``merged``, ``done``,
                  ``closed``, ``dropped``) is in ``DONE_STATES`` now and was not in the previous read
                  (including a newly added done row; bounded to 5 tasks + ``+N more``); live-state
                  or field changes do not exit
  driver stopped  ``logs/drive.lock`` went from held (``HEARTBEAT drive: running``) to not held or absent
  max-quiet       no compared part (THE NO-CHANGE LINE's allowlist) and no loop lock state changed
                  for at least ``--max-quiet`` seconds (each sleep is capped to the remaining budget);
                  any non-exit change resets the quiet timer; an unread board does not reset it

A non-exit tick prints nothing to stdout (capturing board-read diagnostics such as
``BOARD UNREACHABLE`` so they do not leak on quiet ticks) and still updates ``logs/heartbeat.last``:
when the board reads, unchanged ticks keep ``at`` and ``read`` from the last complete snapshot
while updating ``checked_at`` and ``loop_running``; when the board is unreadable, the last complete
``at``/``parts``/``read`` stays untouched while ``alert_state`` records the latest non-board state
so a reported alert is not replayed on re-arm. When an exit condition or the stall bound triggers,
it prints ``HEARTBEAT wake <wave>: <comma-separated causes>`` first, then the full read (including
any captured board diagnostic and ending with ``HEARTBEAT <wave> <UTC time>``), and updates
``logs/heartbeat.last``.
"""

import contextlib
import fcntl
import io
import json
import os
import re
import shlex
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import run
from ludics.fleetworker.wavebrief import NAME, cmd_render, write_atomically

USAGE = (
    "wave render [--set NAME=VALUE]... [--set-file NAME=<path>]... [--out <file>] <part>... | "
    "wave prep <wave.json> <task> --base <base-or-stacked-rev> [--issue <N> | --source <N>] [--mode none|paired|paired+critique]"
    " [--legs <box,...>] [--allow-rival <pr>]... [--profile <name>] [--host <box>] [--tier D1|D1/D2|D2|D2/D3|D3]"
    " [--reassignment-reason <reason>] | wave launch <wave.json> <task> [--status <file>] [--launch-id <id>] | "
    "wave unprep <wave.json> <task> | "
    "wave loop <wave.json> <name> [--resume-after <request id> | --rerun <red id> -- <command> | --release] | "
    "wave heartbeat <wave.json> [--sleep <seconds>] [--until-attention] [--max-quiet <seconds>] | "
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
                     "BASE", "BASE_ORIGIN", "SCR", "SCR_PARENT", "WORKER", "HOST", "MODE", "PROJECT",
                     "LEGLINES", "LEG", "LEG_ID", "LEG_WT", "LEG_CHECKOUT"})
TOP_REQUIRED = ("wave", "repository", "checkout", "worker_prefix", "agent_host", "transport", "kind", "standing_purpose")
TOP_OPTIONAL = ("issue_repository", "vars", "legs", "loops", "project_part", "review", "profiles", "hosts", "split")
ISSUE_NUMBER_SPLIT = "issue-number"
PROFILE_REQUIRED, PROFILE_OPTIONAL = ("transport", "kind"), ("model", "effort")
PROFILE_TRANSPORTS = ("subagent", "cli")
KINDS = ("claude", "codex", "gemini")
NO_NATIVE = "gemini"  # a kind no coordinator's runtime spawns: CLI workers only
HOST_REQUIRED = ("checkout", "scratch")
REVIEW_REQUIRED, REVIEW_OPTIONAL = ("kind", "model"), ("label", "project_part", "timeout")
REVIEW_KINDS = ("claude", "gemini")
# A reviewer's model and label: what a CLI flag and pr-review.sh comment's footer both take.
REVIEW_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9 ._+/-]*[A-Za-z0-9._+/-])?")
LEG_REQUIRED, LEG_OPTIONAL = ("checkout", "suffix", "purpose"), ("vars",)
LOOP_REQUIRED = ("box", "purpose", "checkout", "tip", "command")
LOOP_OPTIONAL = ("cpu", "integration", "poll", "reserve_slot", "standby", "failover_after")
FAILOVER_AFTER = 1800  # a loop's failover_after default: longer than about one cc tip run (ludics#1187)


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
    reserve_slot: bool = False  # THE RESERVED SLOT (waveloop.py): the loop owns one slot of its box
    standby: "Standby | None" = None  # the one box and checkout it fails over to
    failover_after: int = FAILOVER_AFTER  # seconds of home refusals before it does


@dataclass(frozen=True)
class Standby:
    box: str
    checkout: str


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
    split: str = ""


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
        raise ValueError(f"{w}.kind must be one of {', '.join(KINDS)}, not {json.dumps(kind)}")
    if kind == NO_NATIVE and top.get("transport") != "cli":
        raise ValueError(f"{w}: a {NO_NATIVE} wave's own workers are CLI workers (no runtime spawns agy); its transport is cli")
    split = text(top, "split", w) if "split" in top else ""
    if split and split != ISSUE_NUMBER_SPLIT:
        raise ValueError(f"{w}.split must be {json.dumps(ISSUE_NUMBER_SPLIT)}, not {json.dumps(split)}")
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
        if (transport, its_kind) == ("subagent", NO_NATIVE):
            raise ValueError(f"{what}: a {NO_NATIVE} worker has no native transport (no runtime spawns agy); its transport is cli")
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
        if "reserve_slot" in entry and not isinstance(entry["reserve_slot"], bool):
            raise ValueError(f"{what}.reserve_slot must be true or false")
        reserve = bool(entry.get("reserve_slot", False))
        if reserve and not entry.get("cpu", False):
            raise ValueError(f"{what}.reserve_slot needs cpu: true (the reserved slot is a box's highest, never a GPU token)")
        box = text(entry, "box", what, WORD)
        standby: Standby | None = None
        if "standby" in entry:
            if not reserve:
                raise ValueError(f"{what}.standby needs reserve_slot: true (the loop fails over to a slot reserved there)")
            spare = objects({"standby": entry["standby"]}, what)["standby"]
            problem = keys_problem(spare, f"{what}.standby", ("box", "checkout"), ())
            if problem:
                raise ValueError(problem)
            standby = Standby(text(spare, "box", f"{what}.standby", WORD), absolute(spare, "checkout", f"{what}.standby"))
            if standby.box == box:
                raise ValueError(f"{what}.standby.box must be another box than {what}.box")
        failover: Any = entry.get("failover_after", FAILOVER_AFTER)
        if "failover_after" in entry and standby is None:
            raise ValueError(f"{what}.failover_after needs a standby")
        if not (isinstance(failover, int) and not isinstance(failover, bool) and failover > 0):
            raise ValueError(f"{what}.failover_after must be a positive whole number of seconds")
        loops[name] = Loop(name, box, text(entry, "purpose", what), absolute(entry, "checkout", what),
                           text(entry, "tip", what), list(cast(list[str], command)), bool(entry.get("cpu", False)),
                           bool(entry.get("integration", False)), poll, reserve, standby, failover)
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
        split=split,
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
    return cfg.shim_command()[0]


def loop_log(wave: Wave, name: str) -> str:
    return os.path.join(wave.directory, "logs", f"loop-{name}.log")


def loop_lock(wave: Wave, name: str) -> str:
    return os.path.join(wave.directory, "logs", f"loop-{name}.lock")


def lock_held(path: str) -> bool | None:
    """True when another process holds an exclusive flock on ``path``, False when unlocked, None when absent."""
    if not os.path.exists(path):
        return None
    with open(path, "rb") as held:
        try:
            fcntl.flock(held.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        except OSError:
            return True
    return False


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
HEARTBEAT_SLEEP = 1200  # THE SLEEP (the header)
HEARTBEAT_MAX_QUIET = 14400  # 4 h default stall bound for --until-attention (ludics#1312)
sleep: Callable[[float], None] = time.sleep  # the tests' seam, as waveloop's
clock: Callable[[], float] = time.monotonic  # the quiet bound and nap's clock, the tests' seam too


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


def has_unread_attention(wave: Wave) -> bool:
    """True when a driver's lock file exists and ``attention.jsonl`` has bytes past ``attention.seen``."""
    if not os.path.exists(os.path.join(wave.directory, "logs", "drive.lock")):
        return False
    _, _, offset, size = attention_state(wave)
    return size > offset


def nap(wave: Wave, seconds: float) -> None:
    """The heartbeat's sleep, ended early by a new attention record (THE DRIVER's lines)."""
    deadline = clock() + seconds
    while (left := deadline - clock()) > 0:
        if has_unread_attention(wave):
            return
        sleep(min(ATTENTION_POLL, left))


def driver_lines(wave: Wave, *, consume: bool = True) -> tuple[list[str], list[str]]:
    """THE DRIVER's lines (the header): the driver's own line and the new attention lines; none for a
    wave no driver has served. Reading them moves the attention cursor unless ``consume`` is False."""
    running = lock_held(os.path.join(wave.directory, "logs", "drive.lock"))
    if running is None:
        return [], []
    last = last_line(os.path.join(wave.directory, "logs", "drive.log"))
    own = [f"HEARTBEAT drive: {'running' if running else 'NOT RUNNING'}; {last if last is not None else 'no log yet'}"]
    lines: list[str] = []
    if consume:
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
    return own, lines


HEARTBEAT_STATE = 1  # the version of ``logs/heartbeat.last`` (THE NO-CHANGE LINE): another one is no saved read


def board_rows(cfg: Config, wave: Wave) -> list[Any] | None:
    """The board's rows, as ``[task, [[field, value], ...]]`` in task order, or None when it does not read."""
    from ludics.fleetworker.takeover import board_document
    from ludics.fleetworker.wavedrive import rows_of

    doc = board_document(cfg, wave.wave)
    if isinstance(doc, int):
        return None
    return sorted([task, sorted([k, v] for k, v in fields.items())] for task, fields in rows_of(doc))


def saved_read(path: str) -> dict[str, Any] | None:
    """The last full read (THE NO-CHANGE LINE), or None for a missing, torn or other-version file."""
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    saved = cast(dict[str, Any], data)
    if saved.get("v") != HEARTBEAT_STATE or not isinstance(saved.get("at"), str) or not isinstance(saved.get("parts"), dict):
        return None
    return saved


def decode_board_rows(raw: Any) -> dict[str, dict[str, str]] | None:
    """Decode ``parts['board rows']`` into ``{task: {field: value}}``, or None on an unexpected shape."""
    if not isinstance(raw, list):
        return None
    result: dict[str, dict[str, str]] = {}
    for item in cast(list[Any], raw):
        if not isinstance(item, list):
            return None
        row = cast(list[Any], item)
        if len(row) != 2 or not isinstance(row[0], str) or not isinstance(row[1], list):
            return None
        fields: dict[str, str] = {}
        for pair in cast(list[Any], row[1]):
            if not isinstance(pair, list):
                return None
            field_pair = cast(list[Any], pair)
            if len(field_pair) != 2 or not isinstance(field_pair[0], str) or not isinstance(field_pair[1], str):
                return None
            fields[field_pair[0]] = field_pair[1]
        result[row[0]] = fields
    return result


def _quote_task(task: str) -> str:
    return shlex.quote(task[:40].encode("unicode_escape").decode("ascii"))


def changed_board_rows(previous: Any, current: list[Any]) -> str:
    """Bounded detail for THE NO-CHANGE LINE's board part; compare every field, summarize states."""
    from ludics.fleetworker.takeover import state_word

    old, new = decode_board_rows(previous), decode_board_rows(current)
    if old is None or new is None:
        return "board rows (previous rows unavailable)"
    changed = sorted(task for task in old.keys() | new.keys() if old.get(task) != new.get(task))
    if not changed:
        return "board rows"
    names: list[str] = []
    for task in changed[:5]:
        name = _quote_task(task)
        if task not in old:
            detail = "added"
        elif task not in new:
            detail = "removed"
        else:
            before = (state_word(old[task].get("state", "")) or "unknown")[:24]
            after = (state_word(new[task].get("state", "")) or "unknown")[:24]
            detail = f"{before}→{after}" if before != after else "fields changed"
        names.append(f"{name} {detail}")
    if len(changed) > 5:
        names.append(f"+{len(changed) - 5} more")
    return f"board rows ({'; '.join(names)})"


def done_board_rows(previous: Any, current: list[Any]) -> str | None:
    """Bounded detail for tasks reaching a done phase since ``previous`` (UNTIL-ATTENTION MODE), or None."""
    from ludics.fleetworker.takeover import DONE_STATES, phase_of

    old, new = decode_board_rows(previous), decode_board_rows(current)
    if old is None or new is None:
        return None
    reached: list[str] = []
    for task in sorted(new):
        after = phase_of(new[task])
        if after not in DONE_STATES:
            continue
        before = phase_of(old[task]) if task in old else None
        if before not in DONE_STATES:
            reached.append(f"{_quote_task(task)} {after}")
    if not reached:
        return None
    shown = reached[:5]
    if len(reached) > 5:
        shown.append(f"+{len(reached) - 5} more")
    return f"board done ({'; '.join(shown)})"


def loop_alert(name: str, line: str | None) -> str | None:
    """``RED`` or ``UNKNOWN`` when ``line`` matches ``waveloop.py``'s terminal alert shape, else None."""
    if line is None:
        return None
    match = re.match(
        r"^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z )?LOOP " + re.escape(name) + r" (RED|UNKNOWN)(?:$|[: ])",
        line,
    )
    return match.group(1) if match else None


_HALT_STAMP = re.compile(r"^(HALTED|update) \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z ")


def halt_signature(lines: tuple[str, ...]) -> tuple[str, ...]:
    """Normalize leading UTC timestamps on ``halted`` lines so reissuing the same reason stays quiet."""
    return tuple(_HALT_STAMP.sub(r"\1 ", line) for line in lines)


def halt_state(raw: Any) -> tuple[int, tuple[str, ...]] | None:
    """``(exit_code, stdout_lines)`` from ``parts['halted']``, or None on an unexpected shape."""
    if not isinstance(raw, list) or not raw:
        return None
    items = cast(list[Any], raw)
    if not all(isinstance(x, str) for x in items):
        return None
    lines = cast(list[str], items)
    tail = lines[-1]
    if not tail.startswith("exit="):
        return None
    code = tail.removeprefix("exit=")
    if not (code.isascii() and code.isdigit()):
        return None
    return int(code), tuple(lines[:-1])


def driver_running(own: Any) -> bool:
    """True when ``parts['driver']`` reports the handoff driver as running."""
    if not isinstance(own, list) or not own:
        return False
    first = cast(list[Any], own)[0]
    return isinstance(first, str) and first.startswith("HEARTBEAT drive: running")


def _parse_bool_map(raw: Any) -> dict[str, bool] | None:
    if not isinstance(raw, dict):
        return None
    result: dict[str, bool] = {}
    for k, v in cast(dict[Any, Any], raw).items():
        if not isinstance(k, str) or not isinstance(v, bool):
            return None
        result[k] = v
    return result


def saved_loop_running(saved: dict[str, Any] | None) -> dict[str, bool] | None:
    """``loop_running`` map from ``heartbeat.last``, or None when absent or malformed."""
    return _parse_bool_map(saved.get("loop_running")) if saved is not None else None


def _loops_by_name(raw: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(raw, list):
        for entry in cast(list[Any], raw):
            if isinstance(entry, str) and entry.startswith("HEARTBEAT loop ") and ": " in entry:
                head, _, body = entry.partition(": ")
                out[head.removeprefix("HEARTBEAT loop ")] = body
    return out


def saved_alert_state(path: str) -> dict[str, Any] | None:
    """Read ``alert_state`` from ``heartbeat.last`` (persisted across unread-board wakes), or None."""
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    doc = cast(dict[str, Any], data)
    if doc.get("v") != HEARTBEAT_STATE or not isinstance(doc.get("alert_state"), dict):
        return None
    return cast(dict[str, Any], doc["alert_state"])


@dataclass(frozen=True)
class HeartbeatTick:
    stamp: str
    prs_rc: int
    halted_rc: int
    parts: dict[str, Any]
    read: list[str]
    own: list[str]
    attention: list[str]
    rows: list[Any] | None
    loop_raw: dict[str, str | None]
    loop_running: dict[str, bool]
    board_notes: list[str]


def take_tick(cfg: Config, wave: Wave, *, consume_attention: bool = True) -> HeartbeatTick:
    """Capture one heartbeat read without printing or writing ``heartbeat.last``."""
    from ludics.fleetworker.supervision import steady_prs_line

    script = shim(cfg)
    # Each read is printed whole, never piped: no tail can cut a PR line (#1050), and its exit is
    # printed after it rather than lost in a pipe. It is captured first, for THE NO-CHANGE LINE.
    prs = run([script, "prs", wave.repository, "--wave", wave.wave], capture=True)
    halted = run([script, "halted"], capture=True)
    loop_raw = {name: last_line(loop_log(wave, name)) for name in wave.loops}
    loop_running = {name: lock_held(loop_lock(wave, name)) is True for name in wave.loops}
    loops = [f"HEARTBEAT loop {name}: {line if line is not None else 'no log yet'}" for name, line in loop_raw.items()]
    own, attention = driver_lines(wave, consume=consume_attention)
    # Capture stdout emitted by board_rows (e.g. BOARD UNREACHABLE) so quiet ticks print nothing
    # and waking ticks still print HEARTBEAT wake first.
    board_buf = io.StringIO()
    with contextlib.redirect_stdout(board_buf):
        rows = board_rows(cfg, wave)
    board_notes = board_buf.getvalue().splitlines()
    parts: dict[str, Any] = {
        "board rows": rows,
        "prs": [steady_prs_line(line) for line in prs.out.splitlines()] + [f"exit={prs.rc}"],
        "halted": [*halted.out.splitlines(), f"exit={halted.rc}"],
        "loops": loops,
        "driver": own,
    }
    stamp = utc_now()
    read = [
        *prs.out.splitlines(),
        f"HEARTBEAT prs exit={prs.rc}",
        *halted.out.splitlines(),
        f"HEARTBEAT halted exit={halted.rc}",
        *loops,
        *own,
        *attention,
        f"HEARTBEAT {wave.wave} {stamp}",
    ]
    return HeartbeatTick(stamp, prs.rc, halted.rc, parts, read, own, attention, rows, loop_raw, loop_running, board_notes)


def _alert_state_of(tick: HeartbeatTick, prev_halted: tuple[int, tuple[str, ...]] | None) -> dict[str, Any]:
    cur_h = halt_state(tick.parts["halted"])
    if cur_h is not None and cur_h[0] in (0, 1):
        halted_part: Any = tick.parts["halted"]
    elif prev_halted is not None:
        halted_part = [*prev_halted[1], f"exit={prev_halted[0]}"]
    else:
        halted_part = tick.parts["halted"]
    return {
        "loops": tick.parts["loops"],
        "loop_running": tick.loop_running,
        "halted": halted_part,
        "driver": tick.own,
    }


def save_heartbeat_state(
    state: str,
    *,
    at: str | None,
    checked_at: str,
    parts: dict[str, Any] | None,
    read: list[str],
    loop_running: dict[str, bool],
    alert_state: dict[str, Any] | None = None,
) -> None:
    os.makedirs(os.path.dirname(state), exist_ok=True)
    payload: dict[str, Any] = {
        "v": HEARTBEAT_STATE,
        "at": at,
        "checked_at": checked_at,
        "parts": parts,
        "read": read,
        "loop_running": loop_running,
    }
    if alert_state is not None:
        payload["alert_state"] = alert_state
    write_atomically(state, json.dumps(payload, ensure_ascii=False) + "\n")


def emit_full_read(tick: HeartbeatTick, prev_at: str | None, prev_parts: dict[str, Any] | None) -> None:
    moved = [
        key for key in tick.parts
        if prev_parts is not None and (key != "board rows" or tick.rows is not None)
        and prev_parts.get(key) != tick.parts[key]
    ]
    if prev_parts is not None and "board rows" in moved and tick.rows is not None:
        moved[moved.index("board rows")] = changed_board_rows(prev_parts.get("board rows"), tick.rows)
    if prev_at is not None and (moved or tick.attention):
        cli.say(f"HEARTBEAT changed since {prev_at}: {', '.join([*moved, *(['attention'] if tick.attention else [])])}")
    for note in tick.board_notes:
        cli.say(note)
    if tick.rows is None:
        cli.say("HEARTBEAT board: did not read, so this tick is not called unchanged")
    for line in tick.read:
        cli.say(line)


def attention_causes(
    wave: Wave,
    prev_rows: Any,
    prev_loops: dict[str, str],
    prev_loop_running: dict[str, bool],
    prev_halted: tuple[int, tuple[str, ...]] | None,
    prev_driver_running: bool,
    tick: HeartbeatTick,
) -> list[str]:
    """Closed list of event causes that end ``wave heartbeat --until-attention`` (UNTIL-ATTENTION MODE)."""
    causes: list[str] = []
    if tick.attention:
        causes.append("attention")

    for name in wave.loops:
        raw = tick.loop_raw.get(name)
        alert = loop_alert(name, raw)
        cur_body = raw if raw is not None else "no log yet"
        if alert is not None and cur_body != prev_loops.get(name):
            causes.append(f"loop {name} {alert}")
        if prev_loop_running.get(name) is True and not tick.loop_running.get(name, False):
            causes.append(f"loop {name} stopped")

    cur_halted = halt_state(tick.parts["halted"])
    if cur_halted is not None and cur_halted[0] == 1:
        if prev_halted is None or prev_halted[0] != 1:
            causes.append("halt appeared")
        elif halt_signature(cur_halted[1]) != halt_signature(prev_halted[1]):
            causes.append("halt changed")

    if prev_rows is not None and tick.rows is not None:
        done_now = done_board_rows(prev_rows, tick.rows)
        if done_now is not None:
            causes.append(done_now)

    if prev_driver_running and not driver_running(tick.own):
        causes.append("driver stopped")

    return causes


def _whole_seconds(raw: str) -> int | None:
    return int(raw) if raw.isascii() and raw.isdigit() else None


def cmd_heartbeat(cfg: Config, args: list[str]) -> int:
    if not args or args[0].startswith("--"):
        die(f"wave heartbeat: name the wave file; usage: {USAGE}")
    seconds: int | None = None
    until_attention = False
    max_quiet: int | None = None
    rest = args[1:]
    while rest:
        opt = rest[0]
        if opt == "--sleep":
            if seconds is not None or len(rest) < 2 or (val := _whole_seconds(rest[1])) is None:
                die(f"wave heartbeat: --sleep takes one <whole seconds>; usage: {USAGE}")
            seconds, rest = val, rest[2:]
        elif opt == "--until-attention":
            if until_attention:
                die(f"wave heartbeat: --until-attention given twice; usage: {USAGE}")
            until_attention, rest = True, rest[1:]
        elif opt == "--max-quiet":
            if max_quiet is not None or len(rest) < 2 or (val := _whole_seconds(rest[1])) is None or val <= 0:
                die(f"wave heartbeat: --max-quiet takes one <positive whole seconds>; usage: {USAGE}")
            max_quiet, rest = val, rest[2:]
        else:
            die(f"wave heartbeat: takes --sleep <whole seconds>, --until-attention and --max-quiet <positive whole seconds>; usage: {USAGE}")
    if max_quiet is not None and not until_attention:
        die(f"wave heartbeat: --max-quiet requires --until-attention; usage: {USAGE}")
    sleep_seconds = HEARTBEAT_SLEEP if seconds is None else seconds
    if until_attention and sleep_seconds <= 0:
        die(f"wave heartbeat: --until-attention requires a positive --sleep; usage: {USAGE}")
    quiet_bound = HEARTBEAT_MAX_QUIET if max_quiet is None else max_quiet

    wave = load_wave(args[0], "heartbeat")
    state = os.path.join(wave.directory, "logs", "heartbeat.last")
    if not until_attention:
        if sleep_seconds:
            nap(wave, sleep_seconds)
        saved = saved_read(state)
        tick = take_tick(cfg, wave)
        if saved is not None and tick.rows is not None and not tick.attention and saved["parts"] == tick.parts:
            drive = ("no driver" if not tick.own else "drive running" if driver_running(tick.own) else "drive NOT RUNNING")
            cli.say(f"HEARTBEAT {wave.wave} {tick.stamp} unchanged since {saved['at']} (prs exit={tick.prs_rc}, halted exit={tick.halted_rc}, {drive}):"
                    f" the last full read is {state}")
            return 0
        emit_full_read(tick, cast(str, saved["at"]) if saved is not None else None,
                       cast(dict[str, Any], saved["parts"]) if saved is not None else None)
        if tick.rows is not None:
            save_heartbeat_state(state, at=tick.stamp, checked_at=tick.stamp, parts=tick.parts, read=tick.read,
                                 loop_running=tick.loop_running)
        return 0

    saved = saved_read(state)
    alerts = saved_alert_state(state)
    # Complete-snapshot fields (at, parts, read) always stay in lockstep; non-board alert baselines
    # may advance ahead of them when the board is temporarily unreadable.
    saved_parts: dict[str, Any] | None = None
    saved_at: str | None = None
    saved_read_lines: list[str] | None = None
    prev_loops: dict[str, str] = {}
    prev_loop_running: dict[str, bool] = {}
    prev_halted: tuple[int, tuple[str, ...]] | None = None
    prev_driver_running = False
    if saved is not None:
        saved_parts = dict(cast(dict[str, Any], saved["parts"]))
        saved_at = cast(str, saved["at"])
        raw_read = saved.get("read")
        if isinstance(raw_read, list) and all(isinstance(x, str) for x in cast(list[Any], raw_read)):
            saved_read_lines = list(cast(list[str], raw_read))
        prev_loops = _loops_by_name(saved_parts.get("loops"))
        saved_loops = saved_loop_running(saved)
        prev_loop_running = saved_loops if saved_loops is not None else {name: lock_held(loop_lock(wave, name)) is True for name in wave.loops}
        h = halt_state(saved_parts.get("halted"))
        if h is not None and h[0] in (0, 1):
            prev_halted = h
        prev_driver_running = driver_running(saved_parts.get("driver"))
    if alerts is not None:
        prev_loops = _loops_by_name(alerts.get("loops"))
        alert_loops = _parse_bool_map(alerts.get("loop_running"))
        if alert_loops is not None:
            prev_loop_running = alert_loops
        h = halt_state(alerts.get("halted"))
        if h is not None and h[0] in (0, 1):
            prev_halted = h
        prev_driver_running = driver_running(alerts.get("driver"))
    elif saved is None and not has_unread_attention(wave):
        base = take_tick(cfg, wave, consume_attention=False)
        prev_loops = _loops_by_name(base.parts["loops"])
        prev_loop_running = dict(base.loop_running)
        h = halt_state(base.parts["halted"])
        if h is not None and h[0] in (0, 1):
            prev_halted = h
        prev_driver_running = driver_running(base.own)
        if base.rows is not None:
            saved_parts = dict(base.parts)
            saved_at = base.stamp
            saved_read_lines = base.read
            save_heartbeat_state(state, at=base.stamp, checked_at=base.stamp, parts=base.parts, read=base.read,
                                 loop_running=base.loop_running)
        else:
            save_heartbeat_state(state, at=None, checked_at=base.stamp, parts=None, read=[],
                                 loop_running=base.loop_running, alert_state=_alert_state_of(base, prev_halted))

    quiet_since = clock()
    quiet_deadline = quiet_since + quiet_bound
    while True:
        remaining = quiet_deadline - clock()
        wait = min(float(sleep_seconds), max(0.0, remaining))
        if wait > 0:
            nap(wave, wait)
        tick = take_tick(cfg, wave)
        causes = attention_causes(
            wave,
            saved_parts.get("board rows") if saved_parts is not None else None,
            prev_loops,
            prev_loop_running,
            prev_halted,
            prev_driver_running,
            tick,
        )
        snapshot_changed = tick.rows is not None and (saved_parts is None or saved_parts != tick.parts)
        moved = tick.rows is not None and (snapshot_changed or prev_loop_running != tick.loop_running)
        now = clock()
        if not causes:
            if moved:
                quiet_since = now
                quiet_deadline = now + quiet_bound
            elif now >= quiet_deadline:
                elapsed = max(quiet_bound, int(now - quiet_since + 1e-9))
                causes.append(f"quiet {elapsed}s (max-quiet {quiet_bound}s)")
        if causes:
            cli.say(f"HEARTBEAT wake {wave.wave}: {', '.join(causes)}")
            emit_full_read(tick, saved_at, saved_parts)
            if tick.rows is not None:
                save_heartbeat_state(state, at=tick.stamp, checked_at=tick.stamp, parts=tick.parts, read=tick.read,
                                     loop_running=tick.loop_running)
            else:
                save_heartbeat_state(
                    state,
                    at=saved_at,
                    checked_at=tick.stamp,
                    parts=saved_parts,
                    read=saved_read_lines if saved_read_lines is not None else [],
                    loop_running=tick.loop_running,
                    alert_state=_alert_state_of(tick, prev_halted),
                )
            return 0
        if tick.rows is not None:
            if snapshot_changed or saved_at is None:
                saved_at = tick.stamp
                saved_read_lines = tick.read
                saved_parts = dict(tick.parts)
            save_heartbeat_state(
                state,
                at=saved_at,
                checked_at=tick.stamp,
                parts=saved_parts,
                read=saved_read_lines if saved_read_lines is not None else tick.read,
                loop_running=tick.loop_running,
            )
        else:
            save_heartbeat_state(
                state,
                at=saved_at,
                checked_at=tick.stamp,
                parts=saved_parts,
                read=saved_read_lines if saved_read_lines is not None else [],
                loop_running=tick.loop_running,
                alert_state=_alert_state_of(tick, prev_halted),
            )
        prev_loops = _loops_by_name(tick.parts["loops"])
        prev_loop_running = dict(tick.loop_running)
        h = halt_state(tick.parts["halted"])
        if h is not None and h[0] in (0, 1):
            prev_halted = h
        prev_driver_running = driver_running(tick.own)


def cmd_wave(cfg: Config, args: list[str]) -> int:
    from ludics.fleetworker import wavedecide, wavedrive, wavelaunch, waveloop, waveprep, wavereview, waveunprep

    match args[:1]:
        case ["render"]:
            return cmd_render(args[1:])
        case ["prep"]:
            return waveprep.cmd_prep(cfg, args[1:])
        case ["launch"]:
            return wavelaunch.cmd_launch(cfg, args[1:])
        case ["unprep"]:
            return waveunprep.cmd_unprep(cfg, args[1:])
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
