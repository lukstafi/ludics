"""``tally``: a task's coordinator turns on its board row, routine or not, the same for every
transport (ludics#1214), and its relaunches beside them (ludics#1236).

issue-wave SKILL.md's *Codex model choice* compares worker models by "review rounds, coordinator
interventions and time to merge", and the boards could not count the middle one: a CLI worker's
``msgs/`` files counted every driver answer, a native worker's messages lived only in its
coordinator's transcript, and resumes only in per-worker meta on the agent host. So each row
carries three counters, written by the verbs that send a worker its messages or launch it again,
and never summed:

  interventions     the coordinator turns that needed judgment
  routine_answers   the protocol's answers, which a rule gives
  relaunches        the task's worker launched again: a relaunch or a finisher

THE RELAUNCH DECISION (the maintainer's, ludics#1236:
https://github.com/lukstafi/ludics/issues/1236#issuecomment-7007592831): relaunches and finishers
count, in ``relaunches=`` and never in ``interventions=``. A finisher is the heaviest way a
coordinator steps in, and a comparison that omits it can rank well an arm whose workers needed
replacing; mixed into the message count it would hide which kind of intervention an arm needed.
The first launch counts nothing. A CLI replacement, a native respawn, and a finisher from a
``board takeover`` brief each count on the original task's row. Each launch path has one writer:

  fleet-worker.sh launch <box> <worker> --replace ...   after a launch that exits 0 and replaced a
                                                 record (the far side's archive of it under the
                                                 launch's own stamp is there), ``after_replace``'s
                                                 tally of the CLI row by worker and host
  fleet-worker.sh board spawned <wave> <task> --agent <id> --transport <t> [--model <m>]
                                                 a recorded spawn on a row with ``launched_at``
                                                 (boardstore.py, ludics#1264)

``board takeover`` itself writes nothing (takeover.py): it may be read, and read again, without a
spawn. Legacy ``board set state=launched`` calls still count under THE RELAUNCH COUNT in
``boardstore.py``, including a CLI worker launched under a new name or on another box. A
``launch --replace`` whose worker no row names (a name reused outside a wave) is a ``BOARD TALLY
NOTE``, as an unstick's is. The board records reported spawns only. Check ``board show`` after a
lost acknowledgement, since repeating a recorded spawn increments the count again. Correct a
count with a set that names ``relaunches`` after reading the row.

The turns: two writers, one classifier (``classify``):

  fleet-worker.sh unstick <box> <worker> ...     after an unstick that exits 0, its own tally of the
                                                 row (boardstore's ``tally`` by worker and host);
                                                 every CLI resume is one -- the coordinator's, the
                                                 driver's own (``wave drive``), and ``execution
                                                 assign --unstick``'s -- so the driver writes its
                                                 answers through the unstick it calls
  fleet-worker.sh board tally <wave> <task> --message <file>
                                                 a native worker's: the coordinator saves each
                                                 message it sends the worker (SendMessage, a Codex
                                                 follow-up) to a file and calls this beside it

THE MESSAGE CLASSIFIES ITSELF. Recognised forms (closed): a message is ROUTINE when its first
non-blank line, read as whitespace-separated words, begins with the words of one of ``ROUTINE``:

  REVIEW_POSTED, MERGE CLEARED, MERGE NOT CLEARED           the review checkpoint's answers
  EXECUTION_ASSIGNED, EXECUTION_CONCLUDED, EXECUTION_REFUSED,
  EXECUTION_PENDING, EXECUTION_DEFERRED                     the execution requests' answers
  WINDOWS_WITNESS_RESULT                                  the coordinator's Windows witness result
  PEER_PLAN, PEER_PLAN_UNAVAILABLE, PEER_CRITIQUE           paired planning's relays

compared exactly (case kept, a word whole: ``REVIEW_POSTEDX`` or a backticked marker is not one).
Everything else is an INTERVENTION, a fail-closed allowlist: an escalation's answer, a nudge, a
correction, a "continue", an empty message. So is every ``unstick --kill`` and ``unstick
--interrupt``, whatever message rides with it: stopping a worker's turn or its process is the
coordinator stepping in. The boundary: only the first non-blank line's leading words are read, never
the rest of the message, so a routine marker followed by prose of the coordinator's counts as
routine; the classifier judges the message's form, never its sender, so a protocol answer the
coordinator sends by hand (a PEER_PLAN relay to a CLI worker, a review answered while the driver is
down) is routine for both transports alike.

NOT COUNTED as a turn, deliberately: a launch, a relaunch or a finisher (``relaunches`` counts the
last two, above), ``close``, board edits, the driver's attention lines, a decision ``wave decide`` posts, a hand-back's
closure, PR comments and CI reruns, and an unstick that exits non-zero (it reached no worker, or not
surely: its retry is the one counted). ``board tally`` counts what it is given, once per call.

The board is best effort (boardstore.py's header): a tally that fails, or finds no row, is one
``BOARD TALLY WARNING`` or ``BOARD TALLY NOTE`` line on stderr, and the unstick's exit is its own;
``wave drive`` carries such a line into the note of every answer whose unstick it called (``said``,
over that unstick's own stderr) or ``execution assign`` called for it (``said_lines`` over the
unstick's own stderr alone, which assign's ``--status`` file carries: never a step's line): the
``answered`` notes, and the attention lines of a partly assigned turn (wavedrive.py's *request*
answer names them), so a lost count is never silent; an unstick that exits non-zero prints no such
line, so the answers that resumed nobody carry none.
A lost acknowledgement and a retry may count twice: reconcile with ``board show``, never by sending
a worker a message again.
"""

import json
import os

from ludics import cli
from ludics.fleetworker.board import mutate
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.takeover import DONE_STATES
from ludics.fleetworker.transport import err, fleet_name, is_local, prelude, run_on

USAGE = "board tally <wave> <task> --message <file>"
ROUTINE = ("REVIEW_POSTED", "MERGE CLEARED", "MERGE NOT CLEARED", "EXECUTION_ASSIGNED", "EXECUTION_CONCLUDED",
           "EXECUTION_REFUSED", "EXECUTION_PENDING", "EXECUTION_DEFERRED", "WINDOWS_WITNESS_RESULT", "PEER_PLAN",
           "PEER_PLAN_UNAVAILABLE", "PEER_CRITIQUE")
SHOWN = 120  # the most of a first line a log line repeats
SAID = ("BOARD TALLY WARNING", "BOARD TALLY NOTE")


def first_line(text: str) -> str:
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def routine(text: str) -> bool:
    """THE MESSAGE CLASSIFIES ITSELF (the header): the first non-blank line begins with a marker's words."""
    words = first_line(text).split()
    return any(words[: len(marker.split())] == marker.split() for marker in ROUTINE)


def classify(text: str, *, kill: bool = False, interrupt: bool = False) -> tuple[str, str]:
    """The counter a message counts in and the log line's reason (the header's closed list)."""
    line = first_line(text)
    shown = json.dumps(line[:SHOWN] + ("..." if len(line) > SHOWN else ""), ensure_ascii=False) if line else "no message"
    if kill or interrupt:
        return "interventions", f"unstick {'--kill' if kill else '--interrupt'} ({shown})"
    if routine(text):
        return "routine_answers", shown
    return "interventions", shown


def read_message(path: str) -> str:
    with open(path, "rb") as f:
        return f.read().decode("utf-8", errors="replace")


def tally(cfg: Config, payload: dict[str, object], *, stdout_to_stderr: bool) -> int:
    """One ``tally`` on the anchor, its acknowledgement on stdout or stderr: the exit, 4 when the
    anchor did not answer."""
    done = mutate(cfg, "tally", json.dumps(payload, separators=(",", ":")), stdout_to_stderr=stdout_to_stderr)
    return 4 if done.unreachable else done.rc


def spellings(cfg: Config, box: str) -> list[str]:
    """Every name a row's ``agent_host`` may give the box an unstick named: the name as given, its fleet
    name, and for this box ``local`` too (a wave file may name the agent host either way, and prep
    writes it as given)."""
    names = [box, fleet_name(cfg, box)]
    if is_local(cfg, box):
        names += ["local", cfg.local_box]
    return [n for n in dict.fromkeys(names) if n]


def after_unstick(cfg: Config, box: str, name: str, message: str, *, kill: bool, interrupt: bool) -> None:
    """``unstick``'s own tally, after it exited 0 (the header), all on stderr: never changes its exit."""
    host = fleet_name(cfg, box)
    try:
        text = read_message(message) if message else ""
        counter, why = classify(text, kill=kill, interrupt=interrupt)
        rc = tally(cfg, {"worker": name, "hosts": spellings(cfg, box), "done": list(DONE_STATES), "counter": counter,
                         "why": why}, stdout_to_stderr=True)
    except (OSError, SystemExit) as exc:
        err(f"BOARD TALLY WARNING {host}/{name}: the unstick reached the worker, and its turn was not counted ({exc})")
        return
    if rc != 0:
        err(f"BOARD TALLY WARNING {host}/{name}: the unstick reached the worker, and its turn was not counted (board"
            f" exit {rc}); reconcile with board show")


# Whether the launch replaced a record: the far side's archive of it, ``$STATE/replaced/<name>-<stamp>``
# under the launch's own stamp (farside.LAUNCH_START), is a directory. Exit 0 yes, NOT_REPLACED no
# (nothing at all is there); any other status, a shell's or ssh's included, is unknown.
NOT_REPLACED = 3
REPLACED = f'[ -d "$STATE/replaced/$1" ] && exit 0; [ -e "$STATE/replaced/$1" ] || [ -L "$STATE/replaced/$1" ] || exit {NOT_REPLACED}; exit 2\n'


def after_replace(cfg: Config, box: str, name: str, stamp: str) -> None:
    """``launch --replace``'s own tally, after it exited 0 (THE RELAUNCH DECISION, the header): one
    ``relaunches`` on the CLI row when the launch replaced a record, nothing when it found none to
    replace (a first launch), all on stderr: never changes the launch's exit."""
    host = fleet_name(cfg, box)
    try:
        seen = run_on(cfg, box, prelude(cfg, box) + REPLACED, [f"{name}-{stamp}"], capture=True)
        if seen.rc == NOT_REPLACED:
            return
        if seen.rc != 0:
            err(f"BOARD TALLY WARNING {host}/{name}: the launch exited 0, and whether it replaced a record"
                f" could not be read (exit {seen.rc}), so its relaunch was not counted; reconcile with board show")
            return
        rc = tally(cfg, {"worker": name, "hosts": spellings(cfg, box), "done": list(DONE_STATES), "counter": "relaunches",
                         "why": f"launch --replace {host}/{name}"}, stdout_to_stderr=True)
    except (OSError, SystemExit) as exc:
        err(f"BOARD TALLY WARNING {host}/{name}: the launch exited 0, and its relaunch was not counted ({exc})")
        return
    if rc != 0:
        err(f"BOARD TALLY WARNING {host}/{name}: the launch replaced a record, and its relaunch was not counted (board"
            f" exit {rc}); reconcile with board show")


def said_lines(stderr: str) -> list[str]:
    """The tally's WARNING and NOTE lines an unstick printed on its stderr, in order."""
    return [line.strip() for line in stderr.splitlines() if line.strip().startswith(SAID)]


def suffix(lines: list[str]) -> str:
    """``wave drive``'s note suffix of tally lines, or ""."""
    return "".join(f"; {line}" for line in lines)


def said(stderr: str) -> str:
    """``wave drive``'s note suffix: the tally's WARNING and NOTE lines an unstick printed, or ""."""
    return suffix(said_lines(stderr))


def cmd_tally(cfg: Config, args: list[str]) -> int:
    """``board tally <wave> <task> --message <file>``: a native message, classified and counted."""
    if len(args) != 4 or args[2] != "--message" or not args[0] or not args[1]:
        die(f"board tally: expected <wave> <task> --message <file> ({USAGE})")
    wave, task, _, path = args
    if not os.access(path, os.R_OK) or os.path.isdir(path):
        die(f"board tally: --message <readable file>, the message sent to the worker ({USAGE})")
    try:
        text = read_message(path)
    except OSError as exc:
        die(f"board tally: cannot read {path}: {exc.strerror}")
    counter, why = classify(text)
    rc = tally(cfg, {"wave": wave, "task": task, "counter": counter, "why": f"message {why}"}, stdout_to_stderr=False)
    if rc == 4:
        cli.say(f"BOARD UNREACHABLE {cfg.anchor}")
    return rc
