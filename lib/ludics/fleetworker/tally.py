"""``tally``: a task's coordinator turns on its board row, routine or not, the same for every
transport (ludics#1214).

issue-wave SKILL.md's *Codex model choice* compares worker models by "review rounds, coordinator
interventions and time to merge", and the boards could not count the middle one: a CLI worker's
``msgs/`` files counted every driver answer, a native worker's messages lived only in its
coordinator's transcript, and resumes only in per-worker meta on the agent host. So each row
carries two counters, written by the verbs that send a worker its messages, and never summed:

  interventions     the coordinator turns that needed judgment
  routine_answers   the protocol's answers, which a rule gives

Two writers, one classifier (``classify``):

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

NOT COUNTED, deliberately: a launch, a relaunch or a finisher (``launch --replace``, a fresh agent),
``close``, board edits, the driver's attention lines, a decision ``wave decide`` posts, a hand-back's
closure, PR comments and CI reruns, and an unstick that exits non-zero (it reached no worker, or not
surely: its retry is the one counted). ``board tally`` counts what it is given, once per call.

The board is best effort (boardstore.py's header): a tally that fails, or finds no row, is one
``BOARD TALLY WARNING`` or ``BOARD TALLY NOTE`` line on stderr, and the unstick's exit is its own;
``wave drive`` carries such a line into the note of every answer whose unstick it called or
``execution assign`` called for it (``said``): the ``answered`` notes, and the attention lines of a
partly assigned turn (wavedrive.py's *request* answer names them), so a lost count is never silent;
an unstick that exits non-zero prints no such line, so the answers that resumed nobody carry none.
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
from ludics.fleetworker.transport import err, fleet_name, is_local

USAGE = "board tally <wave> <task> --message <file>"
ROUTINE = ("REVIEW_POSTED", "MERGE CLEARED", "MERGE NOT CLEARED", "EXECUTION_ASSIGNED", "EXECUTION_CONCLUDED",
           "EXECUTION_REFUSED", "EXECUTION_PENDING", "EXECUTION_DEFERRED", "PEER_PLAN", "PEER_PLAN_UNAVAILABLE",
           "PEER_CRITIQUE")
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


def said(stderr: str) -> str:
    """``wave drive``'s note suffix: the tally's WARNING and NOTE lines an unstick printed, or ""."""
    lines = [line.strip() for line in stderr.splitlines() if line.strip().startswith(SAID)]
    return "".join(f"; {line}" for line in lines)


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
