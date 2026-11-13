"""``wave drive`` and ``wave turn``: the routine answers to a CLI worker's returned turns.

A CLI worker ends its turn for every handoff: a review request, an execution request, a result, the
hand-back. wave-20261111-ocannl's coordinator read 142 such turns by hand, and 140 of them needed no
judgment: 55 hand-backs, 51 review requests, 14 execution requests, 12 results, 6 confirm requests.
Each cost it a handful of tool calls, and every slip it made came from that volume. This driver
answers those turns, so the coordinator is asked only what a rule cannot answer.

    wave drive <wave.json> [--poll <seconds>] [--once]   every CLI worker of the wave, until stopped
    wave turn <wave.json> <task>                          one worker's returned turn, once

WHO IT SERVES. The board's rows whose ``transport`` is ``cli`` and ``kind`` is ``codex``, with a
``worker`` and an ``agent_host``, in a live state past ``pending``. Two kinds of worker are outside
it, and the coordinator answers their turns with the same verbs (``wave review``, ``execution
assign``): a native worker, whose turn returns to its coordinator's own runtime where no process
can resume it; and a Claude CLI worker, whose process outlives its turns, so a message is appended
to it and its ``resumes`` count does not move: nothing ``status`` prints names its turns one by
one, and a driver that cannot tell two turns apart would answer one twice or never.

A TURN is one Codex worker's ``resumes`` count (``status``'s field: 0 for its launch, one more for
each resume: a Codex turn is one process), of one worker and session: a worker launched again in
a task's place, under another name or the same one (``launch --replace``), has a new session and
counts from 0 again, and it does not inherit the turns its predecessor was answered. The ledger,
``<wave dir>/logs/drive.jsonl``, holds one line per step taken for a task, worker, session and
turn, and a turn whose last line is final (``answered`` or ``attention``) is never read again, so a
restarted driver answers nothing twice. ONE DRIVER per wave: an exclusive ``flock`` on
``logs/drive.lock``, taken without waiting; ``wave turn`` takes it too, so it refuses while a
driver runs.

EACH TICK, for each worker: ``status`` on its box. ``RUNNING`` is left alone. ``EXITED`` with no
final ledger line is a returned turn, and THE TURN'S OWN MESSAGE is read before anything is
answered: ``attach`` (which returns at once for a process that has exited) must say ``DONE``, its
verdict for a turn that ended in ``turn.completed`` past the worker's turn offset. Only then is the
final message read with ``log --last-result``, saved to ``msgs/<task>.<worker>.<session>.<turn>.md``
(every file of a turn is named by the turn's whole identity), and classified by
THE MARKERS. ``log --last-result`` alone would not do: it skips a turn that never completed and
prints the message of the turn before it, so a resumed worker that died at startup would be
answered with its previous handoff again. A verdict other than ``DONE`` (``FAILED``: killed, no
terminal event, a failed turn), the states ``ORPHANED``, ``VANISHED`` and ``UNKNOWN``, and a turn
with no final message are attention. A box that does not answer, and a status line this driver cannot read, are tried again
next tick and recorded nowhere: only a state the worker is really in ends a turn's reading.

THE MARKERS, a fail-closed allowlist over the final message's non-blank lines. Exactly one of these
holds, or the turn is attention:
  request   a line that is exactly ``EXECUTION_REQUEST``
  result    one or more lines ``EXECUTION_RESULT {json}``, and no line that starts with
            ``EXECUTION_RESULT`` and is not that, whole (a wrapped or cut result is never dropped
            beside a good one: the turn is attention)
  review    the last line is ``REVIEW_REQUEST <pr> <40-hex sha>``
  confirm   the last line is ``CONFIRM_REQUEST <pr> <40-hex sha>``
  handback  the first line starts with ``HANDBACK``
Two of them in one message, or none (``NEEDS_DESIGN``, ``PLAN_READY``, a question, a status), is
attention, named by the last line's first word.

THE ANSWERS:
  request   ``execution assign <reserve/<task>-base.json> <message> --message <file> --unstick <box>
            <worker>``: it reserves, dispatches and resumes in one call. A block an earlier call
            dispatched (assign's ``ASSIGN ALREADY`` line: a driver that died before it resumed
            the worker) is not assigned again, so its text is not in this call's message. Exit 0
            with no message printed means every block was such: the worker is resumed with that
            call's saved message, and where none was saved the turn is attention. Exit 0 with a
            message and such a block beside it has resumed the worker with part of its
            assignments, which is attention at once. Exit 1 with nothing
            assigned (every block refused: a busy box, a window; assign prints no message then)
            is tried again each ``RETRY`` seconds, ``TRIES`` times, then attention. Exit 1 with
            some blocks assigned has resumed the worker with those, so the turn is over and the
            refused blocks are attention at once: the worker waits for them in a turn this
            driver will read as new. Any other nonzero exit is attention at once (exit 4 above
            all: assign's own line says never to assign again).
  result    each line needs ``request_id``, an absolute ``run`` and a 40-hex ``observed_sha``, and is
            concluded off the run record: ``execution conclude --from-run``, and when that refuses,
            ``--from-bg-run`` (a refused conclusion concludes nothing, so trying both reads is
            safe). The worker is resumed with one ``EXECUTION_CONCLUDED <id> <verdict>`` line per
            result. A line that cannot be read or concluded is attention, and the worker waits.
  review,   ``wave review ... --kind at-open|confirm`` as a ``bg-run.sh spawn`` under
  confirm   ``logs/drive-runs`` (a review takes minutes, and the driver serves the other workers
            meanwhile); the ledger keeps the run directory, and a later tick reads it with
            ``bg-run.sh wait``. Finished with exit 0, its line names the message file the worker is
            resumed with; ``decision=unreadable`` is attention besides (the worker is resumed, the
            review is the coordinator's to read). Any other end is attention, but for a review
            its log shows refused on the lease: that ends the driver as any lost lease does. ``--again`` is passed
            when the ledger holds an answered review of the same PR, kind and head in an earlier
            turn: a new request from the worker is a new round (wavereview.py).
  handback  the PR is the row's ``pr``, else the first ``/pull/<n>`` in the message. The message
            is saved as ``handbacks/<task>.md`` and the task closed with ``board close``, which
            verifies the merge on GitHub itself. Without a PR, each exact ``RUN /absolute/path``
            line supplies a repeated ``--run`` to ``board close --no-pr``; no such line is attention.
            Paths consume the whole line, with no quoting or prose; relative paths are not read. A close that refuses is attention. So is a merge
            that THE CONFIRM does not cover: the coordinator is told, and then the row closes
            (in that order: a closed row is served no more).

THE CONFIRM, read off ``wave review``'s records of the PR that were posted (a record with no
comment, a dry run's, is no review), the rounds ``--again`` set aside included (``<stem>.r<n>.json``:
their comments stay on the PR): when the newest at-open review blocks (``confirm`` or
``unreadable``), a merge is covered only when the newest confirm made after that review is
``cleared``, at the head the PR merged at (``gh pr view --json headRefOid``). A clearance of an
earlier head, one older than the blocking review, one a later confirm round took back (``findings``
after ``cleared``, at the same head or another), and a head GitHub does not answer for are all
not covered.

ATTENTION is a line appended to ``<wave dir>/logs/attention.jsonl`` and printed as ``DRIVE ATTENTION
<task> turn <n>: <why> (<file>)``, written before the turn is made final in the ledger: a driver
killed between the two tells the coordinator again on its restart (the turn is read again), and
never leaves a final turn nobody was told of. The driver goes on serving the other workers; ``wave heartbeat``
prints the new attention lines and returns early when one arrives, so it stays the coordinator's
one wake source. An attention turn is final: the coordinator answers it by hand, and the worker's
next turn is a new turn.

THE QUEUE, ``<wave dir>/queue.json``, is the launches the coordinator decided and left to the driver:

    {"capacity": {"<box>": <n>, ...},
     "tasks": [{"task", "profile", "host"[, "legs": [<box>, ...]][, "mode"][, "after": [<task>, ...]]
                [, "issue" | "source"]}, ...]}

A fail-closed allowlist, read each tick (the coordinator may add tasks while the driver runs): any
other key, a task named twice, a profile that is no ``cli`` profile of the wave file, a host with
no ``capacity``, an ``after`` that is no task id, or one that names the task itself or a task
queued LATER (the file's order is the launch order, so no two queued tasks can wait on each other)
refuses the whole file, said once as ``DRIVE QUEUE REFUSED`` and launching nothing until it reads.
So does a wave file with no ``vars.MAIN``, the branch a queued task is prepared at. An ``after``
task that is not queued needs no row yet: it may be a native task the coordinator has still to
launch. With no file the driver launches nothing. After the workers' turns, each tick takes
the FIRST task in file order that is due and starts it, one a tick:
  due       no row yet, or a ``pending`` row (prepared, its launch refused so far); every ``after``
            task's row ``merged`` or ``done``; fewer CLI rows of this wave holding a slot on its
            host (``slots_held``: any kind, past ``pending`` and not done) than the host's
            capacity; no final ``launch`` line in the ledger; launches not halted (``halted``,
            read once a tick: a halt is waited out, silently); THE GATE open
  started   with no row, ``wave prep <task> --base <origin/MAIN, fetched now> --profile ... [--host]
            [--legs] [--mode] [--issue|--source]`` (a dependent starts from the base its
            prerequisite merged into), then ``wave launch``
When otherwise due, a task waiting only on ``after`` tasks with neither rows nor queue entries
is told through a non-final attention line naming those tasks; it still starts when they merge.
The last missing-task list told for each task is kept in memory (as the queue's and gate's
refusals are): an unchanged list is said once, an empty list clears it, and a restarted driver
tells it again. A task also
waiting on capacity, a halt, THE GATE or a prerequisite with a row or queue entry stays silent.
THE GATE is the launch gate, ``gate --target-repo <repository> --base-branch <MAIN>``, read BEFORE
a task is prepared. A launch needs the branch's tip to be the prepared base, and a prep is not
done twice, so a task prepared under a red base would be stale the moment the fix merged. While the
gate refuses, nothing is prepared or launched; the coordinator is told once for each refusal it
has not been told (kept in memory: a restarted driver tells it again), and the gate is read again
after ``RETRY`` seconds.
A PREPARED task (a ``pending`` row) is launched where and at what its prep recorded, the manifest's
launch record (wavelaunch.py), never the queue's entry: an entry that names another host than the
record's is attention, final, and so is a record whose base is no longer the branch's tip (it was
prepared, its launch was refused, and the branch moved). Both leave the task to the coordinator.
A task whose ``after`` task's row ended without a merge (``closed``, ``dropped``) can never come
due: that is attention, final, since nothing else would say the task is not going to start.
A prep that refuses (a rival PR, a branch that exists, a missing task part) is attention, final:
the coordinator launches that task by hand. A launch its own gates refuse started no worker and
may clear: ``LAUNCH REFUSED`` as its last line (a preflight, a halt) or the base gate's ``BASE
REFUSED:`` on its stderr (a base that turned red after THE GATE read it), with exit 1. It is told
once and tried again each ``RETRY`` seconds, while its base is still the branch's tip. Any other
end of ``wave launch`` (its own refusal, exit 3 with a NOTE, exit 4) is attention, final.
A SLOT HELD: such an end may have started a worker whose row still says ``pending`` (exit 3 with
the row not set, exit 4 with the reservation dispatched), so it holds a slot on the task's host
until the row leaves ``pending`` (the coordinator set it ``launched``, where the row itself then
counts, or closed it). Only ``WAVE LAUNCH REFUSED``, the verb's own reads refusing before it
starts anything, holds none. The launch is written to the ledger (``launching``) before it is
made: a driver that stops inside one leaves that line, and the next driver makes it attention,
final, holding the slot, since it cannot know how the launch ended. An anchor, a remote or GitHub that does not answer is the next tick's.

WHAT IT DOES NOT DO. It scopes nothing and orders nothing (the queue is the coordinator's), reads
no hand-back's proposals (the editorial pass is the
coordinator's, at close-out, over ``handbacks/``), and decides nothing a marker does not state. It
proves the lease through the lease-gated verbs it calls (``unstick``, ``execution assign`` and
``conclude``, ``board close``, and ``wave review`` in its run): one of them refused with a lease
refusal line (``LEASE_LOST``) ends the driver (exit 1), since a takeover is not a refusal to retry.
The refusal is read off those verbs' failures only, never off what a worker wrote: a final message
that quotes the phrase is a message.

It stops on a stop file (``<wave dir>/drive.stop``, read before each tick) with exit 0, on a board
it cannot read as this wave's (exit 1; an anchor that does not answer is tried again), and on a
lost lease. ``--once`` runs one tick. Exit 2 is usage.
"""

import fcntl
import glob
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from typing import Any, cast

from ludics import bgrun, cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.takeover import DONE_STATES, board_document, state_word
from ludics.fleetworker.transport import Done, substitution
from ludics.fleetworker.wave import USAGE, WORD, Wave, load_wave, shim, utc_now
from ludics.fleetworker.wavebrief import write_atomically
from ludics.fleetworker.wavelaunch import Record, read_manifest
from ludics.fleetworker.waveprep import TASK, Stop

sleep: Callable[[float], None] = time.sleep  # the tests' seam, as waveloop's
now: Callable[[], float] = time.time


def execute(argv: Sequence[str], timeout: float | None = None) -> tuple[int, str, str]:
    """A command's status, stdout and stderr (the tests' seam for every command the driver runs). Its
    stderr is passed on to ours, so a verb's own lines stay in the driver's output. With ``timeout``
    (seconds), a command still running then is killed and completes 124, timeout(1)'s status."""
    try:
        done = subprocess.run(list(argv), capture_output=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]}: no answer in {timeout}s\n"
    except OSError as exc:
        return 127, "", f"{argv[0]}: {exc.strerror}\n"
    err = done.stderr.decode("utf-8", "replace")
    sys.stderr.write(err)
    return done.returncode, done.stdout.decode("utf-8", "replace"), err

POLL = 30
ATTACH_WAIT = 60.0  # attach answers at once for an exited worker; one that started running since is left for the next tick
RETRY, TRIES = 300, 6
FINAL = ("answered", "attention")
RETURNED = re.compile(r"(EXITED\([0-9]+\)|IDLE)")
GONE = ("ORPHANED", "VANISHED", "UNKNOWN")  # states that are no returned turn and will not become one
WORKING = "RUNNING"  # the worker's state while its turn runs (farside.py's state_of), not bg-run.sh's verdict word
STATUS = re.compile(r"(\S+) \S+/\S+ .*?\bsession=(\S*) .*\bresumes=([0-9]*)")
ASK = re.compile(r"(REVIEW|CONFIRM)_REQUEST #?([1-9][0-9]*) ([0-9a-f]{40})")
RESULT = re.compile(r"EXECUTION_RESULT (\{.*\})")
PULL = re.compile(r"/pull/([1-9][0-9]*)")
SHA40 = re.compile(r"[0-9a-f]{40}")
REF = re.compile(r"[^#\s]+#([1-9][0-9]*)")
REVIEWED = re.compile(r"WAVE REVIEW \S+: .* decision=([a-z]+) comment=\S+ message=(.+?\.message\.md)(?: \(already reviewed.*)?")
# A lease refusal as lease.py's gates print it: `<VERB> REFUSED <label>: coordinator lease held by ...`,
# on a line of its own or inside the line of a verb that wraps a step's refusal (`board close`: `...
# board log exit 1 (BOARD REFUSED fleet: coordinator lease held by ...)`). Read only where no worker's
# words are: the output of a lease-gated verb that exited nonzero (``Driver.call``'s ``gated``; of
# ``execution assign`` its stderr alone, since its stdout is the assignment message, built from the
# worker's request) and a failed review's log. Never a final message or a status summary.
LEASE_LOST = re.compile(r"\b[A-Z][A-Z -]* REFUSED [^:\n]*: coordinator lease held by [^\n]*")
ALREADY = re.compile(r"ASSIGN ALREADY (\S+):")


def append_line(path: str, record: dict[str, Any]) -> None:
    """One JSON record appended as a whole line, fsynced. A file whose last write was cut (a driver
    killed mid-line: no final newline) gets its newline first, so the torn piece stays a line of its
    own, which every reader skips, and never swallows the record appended after it."""
    with open(path, "a+b") as f:
        f.seek(0, os.SEEK_END)
        if f.tell() > 0:
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                f.write(b"\n")
        f.write((json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8"))
        f.flush()
        os.fsync(f.fileno())


LAUNCH = -1  # the ledger's turn for a queued task's launch, which is no worker's turn
LANDED = ("merged", "done")  # the row states of an ``after`` task that let its dependents start
# A launch its own gates refused before anything started, which may clear (THE QUEUE): the launch
# verb's refusal as stdout's last line, or the base gate's, which it writes to stderr.
PRESTART = re.compile(r"^(?:LAUNCH REFUSED |BASE REFUSED: ).*$", re.M)
QUEUE_KEYS, QUEUED_REQUIRED = ("capacity", "tasks"), ("task", "profile", "host")
QUEUED_OPTIONAL = ("legs", "mode", "after", "issue", "source")


@dataclass(frozen=True)
class Queued:
    task: str
    profile: str
    host: str
    legs: tuple[str, ...]
    mode: str
    after: tuple[str, ...]
    issue: str
    source: str


def label(turn: int) -> str:
    return "launch" if turn == LAUNCH else f"turn {turn}"


def read_queue(wave: Wave) -> tuple[dict[str, int], list[Queued]] | str | None:
    """THE QUEUE (the header): the capacities and the tasks, None with no file, or why it is refused."""
    path = os.path.join(wave.directory, "queue.json")
    try:
        with open(path, encoding="utf-8") as f:
            data: Any = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        return f"{path} is not readable JSON ({exc})"
    if not isinstance(data, dict) or set(cast(dict[str, Any], data)) - set(QUEUE_KEYS):
        return f"{path} is one object with the keys {', '.join(QUEUE_KEYS)} and no other"
    top = cast(dict[str, Any], data)
    raw_capacity: Any = top.get("capacity", {})
    raw_tasks: Any = top.get("tasks", [])
    if not isinstance(raw_capacity, dict) or not isinstance(raw_tasks, list):
        return f"{path}: capacity is an object of <box>: <n>, and tasks a list"
    capacity: dict[str, int] = {}
    for box, n in cast(dict[str, Any], raw_capacity).items():
        if not WORD.fullmatch(box) or not isinstance(n, int) or isinstance(n, bool) or n < 1:
            return f"{path}: capacity.{box} must be a whole number of workers, at least 1"
        capacity[box] = n
    tasks: list[Queued] = []
    later: set[str] = set()  # the tasks an entry so far comes after: none of them may be queued from here on, or be the entry
    for entry in cast(list[Any], raw_tasks):
        if not isinstance(entry, dict):
            return f"{path}: a task is an object"
        item = cast(dict[str, Any], entry)
        name = item.get("task")
        what = f"{path}: task {json.dumps(name)}"
        if set(item) - set(QUEUED_REQUIRED) - set(QUEUED_OPTIONAL) or any(key not in item for key in QUEUED_REQUIRED):
            return f"{what} takes {', '.join(QUEUED_REQUIRED)} and optionally {', '.join(QUEUED_OPTIONAL)}"
        lists = {key: item.get(key, []) for key in ("legs", "after")}
        texts = {key: item.get(key, "") for key in ("task", "profile", "host", "mode", "issue", "source")}
        if not all(isinstance(v, str) for v in texts.values()) or not all(
                isinstance(v, list) and all(isinstance(x, str) and x for x in cast(list[Any], v)) for v in lists.values()):
            return f"{what}: its values are text, and legs and after lists of text"
        if not TASK.fullmatch(texts["task"]) or any(q.task == texts["task"] for q in tasks):
            return f"{what} is no task id ({TASK.pattern}), or is queued twice"
        chosen = wave.profiles.get(texts["profile"])
        if chosen is None or chosen.transport != "cli":
            return f"{what}: profile {texts['profile']!r} is no cli profile of the wave file (the driver launches CLI workers)"
        if texts["host"] not in capacity:
            return f"{what}: host {texts['host']!r} has no capacity"
        if texts["issue"] and texts["source"]:
            return f"{what} names both an issue and a source"
        if any(not TASK.fullmatch(dep) for dep in cast(list[str], lists["after"])):
            return f"{what}: after takes task ids ({TASK.pattern})"
        later.update(cast(list[str], lists["after"]))
        if texts["task"] in later:
            return (f"{what} comes after itself, or is queued after a task that waits on it: the file's order is the launch"
                    " order, so a task's queued prerequisites are above it")
        tasks.append(Queued(texts["task"], texts["profile"], texts["host"], tuple(cast(list[str], lists["legs"])), texts["mode"],
                            tuple(cast(list[str], lists["after"])), texts["issue"], texts["source"]))
    return capacity, tasks


class LeaseLost(Exception):
    """A verb refused because the lease is another coordinator's: the driver's to stop on."""


@dataclass(frozen=True)
class Worker:
    task: str
    name: str
    box: str
    fields: dict[str, str]
    session: str = ""  # status's session= (a Codex thread id), read each tick: part of a turn's identity


@dataclass(frozen=True)
class Turn:
    kind: str  # request, result, review, confirm, handback, or other
    why: str = ""  # other: what the turn is, for the attention line
    pr: str = ""
    sha: str = ""
    results: tuple[str, ...] = ()


def classify(message: str) -> Turn:
    """THE MARKERS (the header)."""
    lines = [line.strip() for line in message.split("\n") if line.strip()]
    if not lines:
        return Turn("other", "an empty final message")
    found: list[Turn] = []
    if "EXECUTION_REQUEST" in lines:
        found.append(Turn("request"))
    claimed = [line for line in lines if line.startswith("EXECUTION_RESULT")]
    results = tuple(m.group(1) for m in (RESULT.fullmatch(line) for line in claimed) if m)
    if len(results) != len(claimed):
        # One result read and another dropped would conclude part of a turn and resume the worker.
        return Turn("other", "an EXECUTION_RESULT line that is not `EXECUTION_RESULT {json}` whole on its own line")
    if results:
        found.append(Turn("result", results=results))
    ask = ASK.fullmatch(lines[-1])
    if ask:
        found.append(Turn("review" if ask.group(1) == "REVIEW" else "confirm", pr=ask.group(2), sha=ask.group(3)))
    if lines[0].startswith("HANDBACK"):
        pull = PULL.search(message)
        found.append(Turn("handback", pr=pull.group(1) if pull else ""))
    if len(found) == 1:
        return found[0]
    if found:
        return Turn("other", "a final message with more than one marker: " + ", ".join(t.kind for t in found))
    return Turn("other", f"no marker this driver answers; the last line starts {lines[-1].split()[0][:40]!r}")


def rows_of(doc: dict[str, Any]) -> list[tuple[str, dict[str, str]]]:
    """The board's rows as (task, fields), a row with no fields object left out."""
    out: list[tuple[str, dict[str, str]]] = []
    tasks: Any = doc.get("tasks")
    for row in cast(list[Any], tasks) if isinstance(tasks, list) else []:
        raw: Any = cast(dict[str, Any], row).get("fields") if isinstance(row, dict) else None
        if isinstance(raw, dict):
            out.append((str(cast(dict[str, Any], row).get("task")), {str(k): str(v) for k, v in cast(dict[Any, Any], raw).items()}))
    return out


def workers_of(doc: dict[str, Any]) -> list[Worker]:
    """WHO IT SERVES (the header)."""
    out: list[Worker] = []
    for task, fields in rows_of(doc):
        word = state_word(fields.get("state", ""))
        if fields.get("transport") != "cli" or fields.get("kind") != "codex" or not fields.get("worker") or not fields.get("agent_host"):
            continue
        if word is None or word == "pending" or word in DONE_STATES:
            continue
        out.append(Worker(task, fields["worker"], fields["agent_host"], fields))
    return out


def slots_held(doc: dict[str, Any]) -> dict[str, int]:
    """THE QUEUE's capacity count: for each host, the wave's CLI rows that hold a slot there. That is
    every CLI row of ANY kind that is not ``pending`` and not done, whether or not this driver answers
    its turns (a Claude CLI worker fills a slot too), and a row whose state it cannot read counts:
    an unreadable row frees no slot."""
    held: dict[str, int] = {}
    for _, fields in rows_of(doc):
        word = state_word(fields.get("state", ""))
        if fields.get("transport") == "cli" and fields.get("agent_host") and word != "pending" and word not in DONE_STATES:
            held[fields["agent_host"]] = held.get(fields["agent_host"], 0) + 1
    return held


class Driver:
    def __init__(self, cfg: Config, wave: Wave) -> None:
        self.cfg, self.wave = cfg, wave
        self.script = shim(cfg)
        self.ledger_path = self.path("logs", "drive.jsonl")
        self.ledger: list[dict[str, Any]] = []
        self.err = ""  # the last call's stderr
        self.queue_refusal = ""  # the queue's refusal last said, so it is said once
        self.queue_missing: dict[str, tuple[str, ...]] = {}  # each task's missing prerequisites last told
        self.gate_refusal, self.gate_next = "", 0.0  # THE GATE's refusal last told, and when it is read again

    def path(self, *parts: str) -> str:
        return os.path.join(self.wave.directory, *parts)

    def turn_file(self, worker: Worker, turn: int, suffix: str) -> str:
        """A file of one turn under ``msgs/``, named by the turn's whole identity (A TURN, the header):
        a worker launched in a task's place never reads, or is resumed with, its predecessor's file."""
        session = re.sub(r"[^A-Za-z0-9._-]", "_", worker.session) or "nosession"
        return self.path("msgs", f"{worker.task}.{worker.name}.{session}.{turn}.{suffix}")

    # --- the ledger and the lines -----------------------------------------------------------------

    def load(self) -> None:
        self.ledger = []
        try:
            with open(self.ledger_path, encoding="utf-8") as f:
                for line in f:
                    try:
                        entry: Any = json.loads(line)
                    except ValueError:
                        continue  # a torn last line: the step is taken again, and each step is a re-read
                    if isinstance(entry, dict):
                        self.ledger.append(cast(dict[str, Any], entry))
        except FileNotFoundError:
            pass

    def last(self, worker: Worker, turn: int) -> dict[str, Any] | None:
        mine = [e for e in self.ledger if e.get("task") == worker.task and e.get("worker") == worker.name
                and e.get("session") == worker.session and e.get("turn") == turn]
        return mine[-1] if mine else None

    def note(self, worker: Worker, turn: int, kind: str, status: str, text: str, **more: Any) -> None:
        entry = {"at": utc_now(), "task": worker.task, "worker": worker.name, "session": worker.session, "turn": turn,
                 "kind": kind, "status": status, "note": text, **more}
        append_line(self.ledger_path, entry)
        self.ledger.append(entry)
        if status != "attention":
            self.say(f"DRIVE {worker.task} {label(turn)}: {kind} {status}: {text}")

    def attention(self, worker: Worker, turn: int, kind: str, why: str, file: str = "", **more: Any) -> None:
        """The coordinator is told first, and the turn made final after: a driver that dies between
        the two tells it again on its restart, never not at all."""
        self.tell(worker, turn, why, file)
        self.note(worker, turn, kind, "attention", why, file=file, **more)

    def tell(self, worker: Worker, turn: int, why: str, file: str = "") -> None:
        """The attention line itself, with no ledger entry: what must reach the coordinator before a
        step that would stop this turn from being read again (a resume, a close)."""
        append_line(self.path("logs", "attention.jsonl"), {"at": utc_now(), "task": worker.task, "turn": turn, "why": why, "file": file})
        self.say(f"DRIVE ATTENTION {worker.task} {label(turn)}: {why}" + (f" ({file})" if file else ""))

    def say(self, line: str) -> None:
        cli.say(line)
        with open(self.path("logs", "drive.log"), "a", encoding="utf-8") as f:
            f.write(f"{utc_now()} {line}\n")

    def call(self, *args: str, timeout: float | None = None, gated: str = "") -> Done:
        """This fleet-worker.sh with ``args``, its stdout captured and its stderr kept in ``self.err``.
        ``gated`` names a verb that proves the lease, and which of its streams hold no worker's words
        (``both``, or ``stderr``): a lease refusal there (LEASE_LOST), on a failure, ends the driver."""
        rc, out, self.err = execute([self.script, *args], timeout)
        if gated and rc != 0:
            lost = LEASE_LOST.search(self.err if gated == "stderr" else out + "\n" + self.err)
            if lost:
                raise LeaseLost(lost.group(0).strip())
        return Done(rc, out)

    # --- one worker, one tick ---------------------------------------------------------------------

    def tick(self, worker: Worker) -> None:
        done = self.call("status", worker.box, worker.name)
        if done.rc == 4:
            return  # the box did not answer: next tick
        read = STATUS.match(substitution(done.out).splitlines()[-1] if done.out.strip() else "")
        state = read.group(1) if read else (done.out.split() or [""])[0]
        turn = int(read.group(3) or 0) if read else 0
        if state == WORKING:
            return
        worker = replace(worker, session=read.group(2) if read else "")
        last = self.last(worker, turn)
        if last is not None and last.get("status") in FINAL:
            return
        if state in GONE:
            return self.attention(worker, turn, "state", f"the worker is {state} on {worker.box}, no returned turn")
        if not RETURNED.fullmatch(state):
            return  # a status line that is no state's (a transient failure): read again next tick
        if last is not None and last.get("status") == "reviewing":
            return self.collect(worker, turn, last)
        if last is not None and last.get("status") == "retry" and now() < float(last.get("next", 0)):
            return
        ended = self.call("attach", worker.box, worker.name, timeout=ATTACH_WAIT)
        if ended.rc in (4, 124):
            return  # the box did not answer, or the worker runs again: next tick
        verdict = substitution(ended.out).splitlines()[-1] if ended.out.strip() else ""
        if not verdict.startswith("DONE "):
            return self.attention(worker, turn, "turn", f"the turn did not complete: {verdict[:300] or f'attach exit {ended.rc}'}")
        message = self.turn_file(worker, turn, "md")
        read_log = self.call("log", worker.box, worker.name, "--last-result")
        if read_log.rc == 4:
            return
        if read_log.rc != 0:
            return self.attention(worker, turn, "turn", f"the turn ended with no final message ({substitution(read_log.out)[-200:]})")
        write_atomically(message, read_log.out)
        what = classify(read_log.out)
        match what.kind:
            case "request":
                self.assign(worker, turn, message, last)
            case "result":
                self.conclude(worker, turn, message, what)
            case "review" | "confirm":
                self.review(worker, turn, what)
            case "handback":
                self.handback(worker, turn, message, what)
            case _:
                self.attention(worker, turn, "turn", what.why, message)

    def resume(self, worker: Worker, turn: int, kind: str, message: str, text: str, **more: Any) -> bool:
        done = self.call("unstick", worker.box, worker.name, "--message", message, gated="both")
        if done.rc != 0:
            self.attention(worker, turn, kind, f"{text}, and the worker was NOT resumed (unstick exit {done.rc}:"
                                               f" {substitution(done.out)[-200:]}); resume it with {message}", message)
            return False
        self.note(worker, turn, kind, "answered", text, **more)
        return True

    def assign(self, worker: Worker, turn: int, message: str, last: dict[str, Any] | None) -> None:
        out = self.turn_file(worker, turn, "assigned.md")
        done = self.call("execution", "assign", self.path("reserve", f"{worker.task}-base.json"), message,
                         "--message", out, "--unstick", worker.box, worker.name, gated="stderr")
        earlier = ALREADY.findall(self.err)
        if done.rc == 0 and not done.out.strip():
            # Nothing assigned by this call: an earlier one dispatched every block and never resumed the worker.
            if os.path.isfile(out):
                self.resume(worker, turn, "request", out, f"dispatched by an earlier call; resumed with its saved message {out}")
                return
            return self.attention(worker, turn, "request", "every block was dispatched by an earlier call, the worker was not"
                                  " resumed, and no assignment message was saved: resume it by hand with its assignments", message)
        if done.rc == 0 and earlier:
            # Some blocks assigned now and some by an earlier call whose message never reached the worker.
            return self.attention(worker, turn, "request", f"the worker was resumed with part of its assignments ({out}): an"
                                  f" earlier call had dispatched {', '.join(earlier)} and its message is not in this one; send"
                                  " the worker those assignments", message)
        if done.rc == 0:
            return self.note(worker, turn, "request", "answered", f"assigned and resumed with {out}")
        if done.rc == 1 and done.out.strip():
            return self.attention(worker, turn, "request", "execution assign refused some of the turn's blocks and resumed the"
                                  f" worker with the rest ({out}); its lines name the refused ones, which the worker still waits for",
                                  message)
        tries = int(last.get("tries", 0)) + 1 if last is not None and last.get("status") == "retry" else 1
        if done.rc == 1 and tries < TRIES:
            return self.note(worker, turn, "request", "retry", f"execution assign refused a block (try {tries} of {TRIES})",
                             tries=tries, next=now() + RETRY)
        self.attention(worker, turn, "request", f"execution assign exit {done.rc}" + (f" after {tries} tries" if done.rc == 1 else "")
                       + ": read its lines before anything else; the request is in the turn's message", message)

    def conclude(self, worker: Worker, turn: int, message: str, what: Turn) -> None:
        lines: list[str] = []
        for raw in what.results:
            try:
                data: Any = json.loads(raw)
            except ValueError:
                data = None
            result = cast(dict[str, Any], data) if isinstance(data, dict) else {}
            request, where, sha = result.get("request_id"), result.get("run"), result.get("observed_sha")
            if not (isinstance(request, str) and request and isinstance(where, str) and where.startswith("/")
                    and isinstance(sha, str) and SHA40.fullmatch(sha)):
                return self.attention(worker, turn, "result", "an EXECUTION_RESULT line names no request_id, absolute run and"
                                                              " 40-hex observed_sha; nothing more concluded", message)
            verdict = ""
            for form in ("--from-run", "--from-bg-run"):
                done = self.call("execution", "conclude", form, where, "--request", request, "--sha", sha, gated="both")
                if done.rc == 0:
                    try:
                        record: Any = json.loads(done.out)
                    except ValueError:
                        record = None
                    verdict = str(cast(dict[str, Any], record).get("verdict", "")) if isinstance(record, dict) else ""
                    break
            if not verdict:
                return self.attention(worker, turn, "result", f"{request} could not be concluded off {where} (neither run record"
                                                              " reads); conclude it by hand, then resume the worker", message)
            lines.append(f"EXECUTION_CONCLUDED {request} {verdict}")
        out = self.turn_file(worker, turn, "concluded.md")
        write_atomically(out, "\n".join(lines) + "\n\nContinue with your task.\n")
        self.resume(worker, turn, "result", out, "; ".join(lines))

    def review(self, worker: Worker, turn: int, what: Turn) -> None:
        mine = (worker.name, worker.session, turn)
        again = any(e.get("task") == worker.task and (e.get("worker"), e.get("session"), e.get("turn")) != mine
                    and e.get("status") == "answered" and e.get("kind") == what.kind and e.get("pr") == what.pr
                    and e.get("sha") == what.sha for e in self.ledger)
        subject: list[str] = []
        for key, flag in (("issue", "--issue"), ("source", "--source")):
            ref = REF.fullmatch(worker.fields.get(key, ""))
            if ref and not subject:
                subject = [flag, ref.group(1)]
        kind = "at-open" if what.kind == "review" else "confirm"
        runs = self.path("logs", "drive-runs")
        os.makedirs(runs, exist_ok=True)
        helper = os.path.join(self.cfg.here, "bg-run.sh")
        rc, out, _ = execute([helper, "spawn", runs, "--", self.script, "wave", "review", self.wave.path, worker.task, what.pr,
                              what.sha, "--kind", kind, *subject, *(["--again"] if again else [])])
        where = substitution(out).splitlines()[-1] if out.strip() else ""
        if rc != 0 or not where.startswith("/"):
            return self.attention(worker, turn, what.kind, f"the review could not be started (bg-run.sh spawn exit {rc})")
        self.note(worker, turn, what.kind, "reviewing", f"wave review {kind} of #{what.pr} at {what.sha[:8]} started in {where}",
                  run=where, pr=what.pr, sha=what.sha)

    def collect(self, worker: Worker, turn: int, last: dict[str, Any]) -> None:
        where, kind = str(last.get("run", "")), str(last.get("kind"))
        rc, out, _ = execute([os.path.join(self.cfg.here, "bg-run.sh"), "wait", where, "--within", "1"])
        line = substitution(out).splitlines()[-1] if out.strip() else ""
        verdict = bgrun.parse(line, rc)
        if verdict is not None and verdict.word in (bgrun.Word.RUNNING, bgrun.Word.STARTING):
            return
        log = os.path.join(where, "log")
        said: re.Match[str] | None = None
        if verdict is not None and verdict.word is bgrun.Word.RC and verdict.status == 0:
            try:
                with open(log, encoding="utf-8", errors="replace") as f:
                    found = [m for m in (REVIEWED.fullmatch(text.rstrip("\n")) for text in f) if m]
            except OSError:
                found = []
            said = found[-1] if found else None
        if said is None:
            try:
                with open(log, encoding="utf-8", errors="replace") as f:
                    found = LEASE_LOST.search(f.read())
                    lost = found.group(0).strip() if found else ""
            except OSError:
                lost = ""
            if lost:
                raise LeaseLost(lost)
            return self.attention(worker, turn, kind, f"the review did not end with a verdict ({line or 'no wait line'}); its log"
                                                      " says why, and the worker waits", log)
        decision, message = said.group(1), said.group(2)
        if decision == "unreadable":
            # Told before the worker is resumed and the turn made final, so no crash in between loses it.
            self.tell(worker, turn, "the review ended on no verdict line: the worker is told to ask for a confirm; the review"
                                    " is yours to read", message)
        # pr and sha on the answered line are what a later turn's --again reads.
        self.resume(worker, turn, kind, message, f"decision={decision}, resumed with {message}", pr=last.get("pr"), sha=last.get("sha"))

    def unconfirmed(self, pr: str) -> bool:
        """THE CONFIRM (the header): whether the PR's merge is one no posted clearance covers."""
        def records(kind: str) -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for path in glob.glob(glob.escape(self.path("reviews")) + f"/{pr}-{kind}-*.json"):
                if not re.fullmatch(re.escape(pr) + "-" + kind + r"-[0-9a-f]{12}(\.r[0-9]+)?\.json", os.path.basename(path)):
                    continue
                try:
                    with open(path, encoding="utf-8") as f:
                        data: Any = json.load(f)
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict) and cast(dict[str, Any], data).get("comment") and isinstance(cast(dict[str, Any], data).get("at"), str):
                    out.append(cast(dict[str, Any], data))
            return out

        opened = records("at-open")
        if not opened:
            return False
        newest = max(opened, key=lambda r: str(r["at"]))
        if newest.get("decision") not in ("confirm", "unreadable"):
            return False
        since = [r for r in records("confirm") if str(r["at"]) > str(newest["at"])]
        latest = max(since, key=lambda r: str(r["at"])) if since else None
        if latest is None or latest.get("decision") != "cleared":
            return True  # no confirm since, or the last word of the confirms withholds the clearance
        rc, out, _ = execute(["gh", "pr", "view", pr, "--repo", self.wave.repository, "--json", "headRefOid", "--jq", ".headRefOid"])
        return rc != 0 or out.strip() != str(latest.get("sha"))

    def handback(self, worker: Worker, turn: int, message: str, what: Turn) -> None:
        pr = worker.fields.get("pr", "") or what.pr
        kept = self.path("handbacks", f"{worker.task}.md")
        os.makedirs(os.path.dirname(kept), exist_ok=True)
        with open(message, encoding="utf-8", errors="surrogateescape") as f:
            contents = f.read()
        write_atomically(kept, contents)
        runs = re.findall(r"^RUN (/[^\r\n]+)$", contents, re.MULTILINE)
        if not pr and not runs:
            return self.attention(worker, turn, "handback", "the hand-back names no PR (the row has none, the message no"
                                                            " /pull/<n>); close the task by hand", kept)
        # THE CONFIRM is read, and the coordinator told, before the close: a closed row is served no
        # more, so a driver killed after the close could never come back to say it.
        uncovered = (f"the hand-back reports #{pr} merged, with a blocking review and no cleared confirm of the merged head on"
                     " record; the task is being closed") if pr and self.unconfirmed(pr) else ""
        if uncovered:
            self.tell(worker, turn, uncovered, kept)
        form = ["--pr", pr] if pr else ["--no-pr", *[arg for directory in runs for arg in ("--run", directory)]]
        done = self.call("board", "close", self.wave.wave, worker.task, *form, "--evidence", f"hand-back {kept}", gated="both")
        said = substitution(done.out).splitlines()[-1] if done.out.strip() else f"board close exit {done.rc}"
        if done.rc != 0:
            return self.attention(worker, turn, "handback", f"board close refused: {said}", kept)
        if uncovered:
            return self.note(worker, turn, "handback", "attention", f"{uncovered} ({said})", file=kept)
        self.note(worker, turn, "handback", "answered", said)

    # --- the queue ----------------------------------------------------------------------------------

    def launches(self, doc: dict[str, Any]) -> None:
        """THE QUEUE (the header): the first due task started, at most one a tick."""
        queue = read_queue(self.wave)
        if queue is None:
            return
        if not self.wave.vars.get("MAIN"):
            queue = f"{self.wave.path} names no vars.MAIN, the branch a queued task is prepared at"
        if isinstance(queue, str):
            if queue != self.queue_refusal:
                self.say(f"DRIVE QUEUE REFUSED {self.wave.wave}: {queue}; nothing is launched until it reads")
            self.queue_refusal = queue
            return
        self.queue_refusal = ""
        capacity, tasks = queue
        queued_tasks = {task.task for task in tasks}
        rows = dict(rows_of(doc))
        live = slots_held(doc)
        # A SLOT HELD (the header): a launch that may have started a worker whose row does not say so yet.
        launch_ends: dict[str, dict[str, Any]] = {str(e.get("task")): e for e in self.ledger if e.get("turn") == LAUNCH}
        for task, entry in launch_ends.items():
            if entry.get("holds") and state_word(rows.get(task, {}).get("state", "pending")) == "pending":
                live[str(entry["holds"])] = live.get(str(entry["holds"]), 0) + 1
        for queued in tasks:
            slot = Worker(queued.task, "", queued.host, {})
            last = self.last(slot, LAUNCH)
            row = rows.get(queued.task)
            if (last is not None and last.get("status") in FINAL) or (row is not None and state_word(row.get("state", "")) != "pending"):
                continue
            if last is not None and last.get("status") == "launching":
                self.attention(slot, LAUNCH, "launch", "a launch of the task was begun and its end was not recorded (the driver stopped"
                                                       f" meanwhile): read its worker's status on {last.get('holds')}; the task is yours from here",
                               holds=last.get("holds"))
                continue
            states = {dep: state_word(rows.get(dep, {}).get("state", "")) for dep in queued.after}
            ended = sorted(dep for dep, word in states.items() if word in DONE_STATES and word not in LANDED)
            if ended:
                self.attention(slot, LAUNCH, "launch", f"the queued task cannot come due: {', '.join(ended)}, which it comes after, ended"
                                                       f" without a merge ({states[ended[0]]}); launch it by hand, or take it off the queue")
                continue
            missing = tuple(sorted(dep for dep in states if dep not in rows and dep not in queued_tasks))
            if not missing:
                self.queue_missing.pop(queued.task, None)
            if any(word not in LANDED and dep not in missing for dep, word in states.items()):
                continue
            record = self.prepared(queued.task) if row is not None else None
            if record is not None and record.host != queued.host:
                self.attention(slot, LAUNCH, "launch", f"the task is prepared on {record.host}, and the queue names {queued.host} for it:"
                                                       " a prepared task launches where it was prepared; launch it by hand")
                continue
            if live.get(queued.host, 0) >= capacity[queued.host]:
                continue
            if last is not None and last.get("status") == "retry" and now() < float(last.get("next", 0)):
                continue
            if missing and self.queue_missing.get(queued.task) == missing:
                continue  # already told: do not spend another potentially blocking gate read on it
            if self.call("halted").rc == 0 and self.gate_open(slot):
                if missing:
                    self.tell(slot, LAUNCH, f"the queued task waits only on after tasks with no row or queue entry: {', '.join(missing)};"
                                           " check their names, or launch them when ready; this task will still start when they merge")
                    self.queue_missing[queued.task] = missing
                    continue  # a missing prerequisite must not hold up another due task
                self.start(queued, slot, row is not None, record, last)
            return  # one launch a tick, and a halt, a closed gate or an unreachable anchor is the next tick's

    def prepared(self, task: str) -> Record | None:
        """A prepared task's launch record, or None when its manifest does not read (``wave launch`` says why)."""
        try:
            return read_manifest(self.path("prep", f"{task}.json"), task)[1]
        except Stop:
            return None

    def gate_open(self, slot: Worker) -> bool:
        """THE GATE (the header)."""
        if now() < self.gate_next:
            return False
        done = self.call("gate", "--target-repo", self.wave.repository, "--base-branch", self.wave.vars["MAIN"], gated="both")
        if done.rc == 0:
            self.gate_refusal = ""
            return True
        if done.rc == 4:
            return False  # the anchor did not answer: the next tick's
        self.gate_next = now() + RETRY
        lines = [line for line in (substitution(done.out) + "\n" + self.err).splitlines() if line.strip()]
        why = (lines[-1].strip() if lines else f"gate exit {done.rc}")[:300]
        if why != self.gate_refusal:
            self.tell(slot, LAUNCH, f"the launch gate refuses, so no queued task is prepared or launched until it passes (read again every {RETRY} s): {why}")
        self.gate_refusal = why
        return False

    def start(self, queued: Queued, slot: Worker, prepared: bool, record: Record | None, last: dict[str, Any] | None) -> None:
        main = self.wave.vars["MAIN"]
        checkout = self.wave.checkout
        fetched = execute(["git", "-C", checkout, "fetch", "-q", "origin", main])[0]
        rc, sha, _ = execute(["git", "-C", checkout, "rev-parse", "--verify", "-q", f"refs/remotes/origin/{main}^{{commit}}"])
        if fetched != 0 or rc != 0 or not SHA40.fullmatch(sha.strip()):
            return  # the remote did not answer: the next tick's
        if record is not None and record.base != sha.strip():
            return self.attention(slot, LAUNCH, "launch", f"{main} moved since the task was prepared at {record.base[:12]} (now {sha.strip()[:12]}),"
                                                          " and a prepared task launches at its base only; it is yours: prepare it again"
                                                          " under a new task id (wavelaunch.py's header)")
        if not prepared:
            done = self.call("wave", "prep", self.wave.path, queued.task, "--base", sha.strip(), "--profile", queued.profile,
                             *(["--host", queued.host] if queued.host != self.wave.agent_host else []),
                             *(["--legs", ",".join(queued.legs)] if queued.legs else []),
                             *(["--mode", queued.mode] if queued.mode else []),
                             *(["--issue", queued.issue] if queued.issue else []),
                             *(["--source", queued.source] if queued.source else []), gated="both")
            if done.rc == 4:
                return
            if done.rc != 0:
                said = (substitution(done.out).splitlines() or [f"wave prep exit {done.rc}"])[-1]
                return self.attention(slot, LAUNCH, "launch", f"the queued task was not prepared: {said[:300]}; launch it by hand")
        host = record.host if record is not None else queued.host
        # A SLOT HELD (the header): the launch is on record before it is made, so a driver that stops
        # inside it leaves a line the next one reads.
        self.note(slot, LAUNCH, "launch", "launching", f"wave launch on {host}", holds=host)
        done = self.call("wave", "launch", self.wave.path, queued.task, gated="both")
        said = (substitution(done.out).splitlines() or [f"wave launch exit {done.rc}"])[-1]
        if done.rc == 0:
            return self.note(slot, LAUNCH, "launch", "answered", said)
        gate = PRESTART.search(said) or PRESTART.search(self.err)
        if done.rc == 1 and gate:
            said = gate.group(0).strip()
            tries = int(last.get("tries", 0)) + 1 if last is not None and last.get("status") == "retry" else 1
            if tries == 1:
                self.tell(slot, LAUNCH, f"the queued launch was refused and is tried again every {RETRY} s: {said[:300]}")
            return self.note(slot, LAUNCH, "launch", "retry", said[:300], tries=tries, next=now() + RETRY)
        # A SLOT HELD (the header): only wave launch's own refusal is known to have started nothing.
        started_nothing = done.rc == 1 and said.startswith("WAVE LAUNCH REFUSED ")
        self.attention(slot, LAUNCH, "launch", f"wave launch exit {done.rc}: {said[:300]}; the task is yours from here",
                       **({} if started_nothing else {"holds": host}))

    # --- the loop -----------------------------------------------------------------------------------

    def round(self, only: str = "") -> int:
        """One tick over the wave's CLI workers (``only``: one task). 0, or the status to end with."""
        doc = board_document(self.cfg, self.wave.wave)
        if doc == 4:
            return 0  # the anchor did not answer: next tick
        if isinstance(doc, int):
            cli.say(f"DRIVE STOPPED {self.wave.wave}: its board cannot be read (above)")
            return 1
        self.load()
        workers = workers_of(doc)
        if only and not any(w.task == only for w in workers):
            cli.say(f"DRIVE REFUSED {self.wave.wave}: {only} is no live CLI worker's task on the board")
            return 1
        for worker in workers:
            if not only or worker.task == only:
                self.tick(worker)
        if not only:
            self.launches(doc)
        return 0


def locked(cfg: Config, wave: Wave, body: Callable[[Driver], int]) -> int:
    os.makedirs(os.path.join(wave.directory, "logs"), exist_ok=True)
    os.makedirs(os.path.join(wave.directory, "msgs"), exist_ok=True)
    with open(os.path.join(wave.directory, "logs", "drive.lock"), "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            cli.say(f"DRIVE REFUSED {wave.wave}: another driver holds {lock.name}")
            return 1
        try:
            return body(Driver(cfg, wave))
        except LeaseLost as lost:
            cli.say(f"DRIVE STOPPED {wave.wave}: the lease is another coordinator's ({lost})")
            return 1


def cmd_drive(cfg: Config, args: list[str]) -> int:
    if not args or args[0].startswith("--"):
        die(f"wave drive: name the wave file; usage: {USAGE}")
    poll, once = POLL, False
    rest = args[1:]
    while rest:
        if rest[0] == "--once":
            once, rest = True, rest[1:]
        elif rest[0] == "--poll" and len(rest) > 1 and rest[1].isdigit() and int(rest[1]) > 0:
            poll, rest = int(rest[1]), rest[2:]
        else:
            die(f"wave drive: takes --poll <whole seconds> and --once; usage: {USAGE}")
    wave = load_wave(args[0], "drive")
    stop = os.path.join(wave.directory, "drive.stop")

    def body(driver: Driver) -> int:
        while True:
            if os.path.lexists(stop):
                cli.say(f"DRIVE STOPPED {wave.wave}: stop file {stop}")
                return 0
            rc = driver.round()
            if rc != 0 or once:
                return rc
            sleep(poll)

    return locked(cfg, wave, body)


def cmd_turn(cfg: Config, args: list[str]) -> int:
    if len(args) != 2 or args[0].startswith("--") or not TASK.fullmatch(args[1]):
        die(f"wave turn: name the wave file and the task; usage: {USAGE}")
    wave = load_wave(args[0], "turn")
    return locked(cfg, wave, lambda driver: driver.round(args[1]))
