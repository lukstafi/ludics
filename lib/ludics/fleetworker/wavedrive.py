"""``wave drive`` and ``wave turn``: the routine answers to a CLI worker's returned turns.

A CLI worker ends its turn for every handoff: a review request, an execution request, a result, the
hand-back. wave-20261111-ocannl's coordinator read 142 such turns by hand, and 140 of them needed no
judgment: 55 hand-backs, 51 review requests, 14 execution requests, 12 results, 6 confirm requests.
Each cost it a handful of tool calls, and every slip it made came from that volume. This driver
answers those turns, so the coordinator is asked only what a rule cannot answer.

    wave drive <wave.json> [--poll <seconds>] [--once]   every CLI worker of the wave, until stopped
    wave turn <wave.json> <task>                          one worker's returned turn, once

WHO IT SERVES. The board's rows whose ``transport`` is ``cli``, with a ``worker`` and an
``agent_host``, in a live state past ``pending``. A native worker's turn returns to its
coordinator's own runtime and no process can resume it: the coordinator answers those with the
same verbs (``wave review``, ``execution assign``).

A TURN is one worker's ``resumes`` count (``status``'s field: 0 for its launch, one more for each
resume). The ledger, ``<wave dir>/logs/drive.jsonl``, holds one line per step taken for a task and
turn, and a turn whose last line is final (``answered`` or ``attention``) is never read again, so a
restarted driver answers nothing twice. ONE DRIVER per wave: an exclusive ``flock`` on
``logs/drive.lock``, taken without waiting; ``wave turn`` takes it too, so it refuses while a
driver runs.

EACH TICK, for each worker: ``status`` on its box. ``RUNNING`` is left alone. ``EXITED`` (a Codex
turn that ended) or ``IDLE`` (a Claude one) with no final ledger line is a returned turn: its final
message is read with ``log --last-result``, saved to ``msgs/<task>-<turn>.md``, and classified by
THE MARKERS. ``ORPHANED``, ``VANISHED`` and ``UNKNOWN``, and a turn with no final message, are
attention. A box that does not answer, and a status line this driver cannot read, are tried again
next tick and recorded nowhere: only a state the worker is really in ends a turn's reading.

THE MARKERS, a fail-closed allowlist over the final message's non-blank lines. Exactly one of these
holds, or the turn is attention:
  request   a line that is exactly ``EXECUTION_REQUEST``
  result    one or more lines ``EXECUTION_RESULT {json}``
  review    the last line is ``REVIEW_REQUEST <pr> <40-hex sha>``
  confirm   the last line is ``CONFIRM_REQUEST <pr> <40-hex sha>``
  handback  the first line starts with ``HANDBACK``
Two of them in one message, or none (``NEEDS_DESIGN``, ``PLAN_READY``, a question, a status), is
attention, named by the last line's first word.

THE ANSWERS:
  request   ``execution assign <reserve/<task>-base.json> <message> --message <file> --unstick <box>
            <worker>``: it reserves, dispatches and resumes in one call. Exit 1 (a block refused: a
            busy box, a window) is tried again each ``RETRY`` seconds, ``TRIES`` times, then
            attention; any other nonzero exit is attention at once (exit 4 above all: assign's own
            line says never to assign again).
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
            review is the coordinator's to read). Any other end is attention. ``--again`` is passed
            when the ledger holds an answered review of the same PR, kind and head in an earlier
            turn: a new request from the worker is a new round (wavereview.py).
  handback  the PR is the row's ``pr``, else the first ``/pull/<n>`` in the message. The message
            is saved as ``handbacks/<task>.md`` and the task closed with ``board close``, which
            verifies the merge on GitHub itself. A close that refuses is attention. So is a merge
            whose blocking at-open review has no cleared confirm on record: the row closes, and the
            coordinator is told.

ATTENTION is a line appended to ``<wave dir>/logs/attention.jsonl`` and printed as ``DRIVE ATTENTION
<task> turn <n>: <why> (<file>)``. The driver goes on serving the other workers; ``wave heartbeat``
prints the new attention lines and returns early when one arrives, so it stays the coordinator's
one wake source. An attention turn is final: the coordinator answers it by hand, and the worker's
next turn is a new turn.

WHAT IT DOES NOT DO. It launches nothing, reads no hand-back's proposals (the editorial pass is the
coordinator's, at close-out, over ``handbacks/``), and decides nothing a marker does not state. It
proves the lease through the verbs it calls: a call refused because the lease is another
coordinator's ends the driver (exit 1), since a takeover is not a refusal to retry.

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
from dataclasses import dataclass
from typing import Any, cast

from ludics import bgrun, cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.takeover import DONE_STATES, board_document, state_word
from ludics.fleetworker.transport import Done, substitution
from ludics.fleetworker.wave import USAGE, Wave, load_wave, shim, utc_now
from ludics.fleetworker.wavebrief import write_atomically
from ludics.fleetworker.waveprep import TASK

sleep: Callable[[float], None] = time.sleep  # the tests' seam, as waveloop's
now: Callable[[], float] = time.time


def execute(argv: Sequence[str]) -> tuple[int, str, str]:
    """A command's status, stdout and stderr (the tests' seam for every command the driver runs). Its
    stderr is passed on to ours, so a verb's own lines stay in the driver's output."""
    try:
        done = subprocess.run(list(argv), capture_output=True, check=False)
    except OSError as exc:
        return 127, "", f"{argv[0]}: {exc.strerror}\n"
    err = done.stderr.decode("utf-8", "replace")
    sys.stderr.write(err)
    return done.returncode, done.stdout.decode("utf-8", "replace"), err

POLL = 30
RETRY, TRIES = 300, 6
FINAL = ("answered", "attention")
RETURNED = re.compile(r"(EXITED\([0-9]+\)|IDLE)")
GONE = ("ORPHANED", "VANISHED", "UNKNOWN")  # states that are no returned turn and will not become one
WORKING = "RUNNING"  # the worker's state while its turn runs (farside.py's state_of), not bg-run.sh's verdict word
STATUS = re.compile(r"(\S+) \S+/\S+ .*\bresumes=([0-9]*)")
ASK = re.compile(r"(REVIEW|CONFIRM)_REQUEST #?([1-9][0-9]*) ([0-9a-f]{40})")
RESULT = re.compile(r"EXECUTION_RESULT (\{.*\})")
PULL = re.compile(r"/pull/([1-9][0-9]*)")
SHA40 = re.compile(r"[0-9a-f]{40}")
REF = re.compile(r"[^#\s]+#([1-9][0-9]*)")
REVIEWED = re.compile(r"WAVE REVIEW \S+: .* decision=([a-z]+) comment=\S+ message=(.+?\.message\.md)(?: \(already reviewed.*)?")
LEASE_LOST = "coordinator lease held by"


class LeaseLost(Exception):
    """A verb refused because the lease is another coordinator's: the driver's to stop on."""


@dataclass(frozen=True)
class Worker:
    task: str
    name: str
    box: str
    fields: dict[str, str]


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
    results = tuple(m.group(1) for m in (RESULT.fullmatch(line) for line in lines) if m)
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


def workers_of(doc: dict[str, Any]) -> list[Worker]:
    """WHO IT SERVES (the header)."""
    out: list[Worker] = []
    tasks: Any = doc.get("tasks")
    for row in cast(list[Any], tasks) if isinstance(tasks, list) else []:
        raw: Any = cast(dict[str, Any], row).get("fields") if isinstance(row, dict) else None
        if not isinstance(raw, dict):
            continue
        fields = {str(k): str(v) for k, v in cast(dict[Any, Any], raw).items()}
        word = state_word(fields.get("state", ""))
        if fields.get("transport") != "cli" or not fields.get("worker") or not fields.get("agent_host"):
            continue
        if word is None or word == "pending" or word in DONE_STATES:
            continue
        out.append(Worker(str(cast(dict[str, Any], row).get("task")), fields["worker"], fields["agent_host"], fields))
    return out


class Driver:
    def __init__(self, cfg: Config, wave: Wave) -> None:
        self.cfg, self.wave = cfg, wave
        self.script = shim(cfg)
        self.ledger_path = self.path("logs", "drive.jsonl")
        self.ledger: list[dict[str, Any]] = []

    def path(self, *parts: str) -> str:
        return os.path.join(self.wave.directory, *parts)

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

    def last(self, task: str, turn: int) -> dict[str, Any] | None:
        mine = [e for e in self.ledger if e.get("task") == task and e.get("turn") == turn]
        return mine[-1] if mine else None

    def note(self, worker: Worker, turn: int, kind: str, status: str, text: str, **more: Any) -> None:
        entry = {"at": utc_now(), "task": worker.task, "turn": turn, "kind": kind, "status": status, "note": text, **more}
        with open(self.ledger_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self.ledger.append(entry)
        if status != "attention":
            self.say(f"DRIVE {worker.task} turn {turn}: {kind} {status}: {text}")

    def attention(self, worker: Worker, turn: int, kind: str, why: str, file: str = "") -> None:
        self.note(worker, turn, kind, "attention", why, file=file)
        with open(self.path("logs", "attention.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": utc_now(), "task": worker.task, "turn": turn, "why": why, "file": file}, ensure_ascii=False) + "\n")
        self.say(f"DRIVE ATTENTION {worker.task} turn {turn}: {why}" + (f" ({file})" if file else ""))

    def say(self, line: str) -> None:
        cli.say(line)
        with open(self.path("logs", "drive.log"), "a", encoding="utf-8") as f:
            f.write(f"{utc_now()} {line}\n")

    def call(self, *args: str) -> Done:
        """This fleet-worker.sh with ``args``, its stdout captured; a lost lease ends the driver."""
        rc, out, err = execute([self.script, *args])
        for text in (out, err):
            if LEASE_LOST in text:
                raise LeaseLost(next(line for line in text.splitlines() if LEASE_LOST in line))
        return Done(rc, out)

    # --- one worker, one tick ---------------------------------------------------------------------

    def tick(self, worker: Worker) -> None:
        done = self.call("status", worker.box, worker.name)
        if done.rc == 4:
            return  # the box did not answer: next tick
        read = STATUS.match(substitution(done.out).splitlines()[-1] if done.out.strip() else "")
        state = read.group(1) if read else (done.out.split() or [""])[0]
        turn = int(read.group(2) or 0) if read else 0
        if state == WORKING:
            return
        last = self.last(worker.task, turn)
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
        message = self.path("msgs", f"{worker.task}-{turn}.md")
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
        done = self.call("unstick", worker.box, worker.name, "--message", message)
        if done.rc != 0:
            self.attention(worker, turn, kind, f"{text}, and the worker was NOT resumed (unstick exit {done.rc}:"
                                               f" {substitution(done.out)[-200:]}); resume it with {message}", message)
            return False
        self.note(worker, turn, kind, "answered", text, **more)
        return True

    def assign(self, worker: Worker, turn: int, message: str, last: dict[str, Any] | None) -> None:
        out = self.path("msgs", f"{worker.task}-{turn}.assigned.md")
        done = self.call("execution", "assign", self.path("reserve", f"{worker.task}-base.json"), message,
                         "--message", out, "--unstick", worker.box, worker.name)
        if done.rc == 0:
            return self.note(worker, turn, "request", "answered", f"assigned and resumed with {out}")
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
                done = self.call("execution", "conclude", form, where, "--request", request, "--sha", sha)
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
        out = self.path("msgs", f"{worker.task}-{turn}.concluded.md")
        write_atomically(out, "\n".join(lines) + "\n\nContinue with your task.\n")
        self.resume(worker, turn, "result", out, "; ".join(lines))

    def review(self, worker: Worker, turn: int, what: Turn) -> None:
        again = any(e.get("task") == worker.task and e.get("turn") != turn and e.get("status") == "answered"
                    and e.get("kind") == what.kind and e.get("pr") == what.pr and e.get("sha") == what.sha for e in self.ledger)
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
            return self.attention(worker, turn, kind, f"the review did not end with a verdict ({line or 'no wait line'}); its log"
                                                      " says why, and the worker waits", log)
        decision, message = said.group(1), said.group(2)
        # pr and sha on the answered line are what a later turn's --again reads.
        resumed = self.resume(worker, turn, kind, message, f"decision={decision}, resumed with {message}",
                              pr=last.get("pr"), sha=last.get("sha"))
        if resumed and decision == "unreadable":
            self.attention(worker, turn, kind, "the review ended on no verdict line: the worker was told to ask for a confirm;"
                                               " the review is yours to read", message)

    def unconfirmed(self, pr: str) -> bool:
        """A blocking at-open review of the PR on record, and no cleared confirm."""
        def records(kind: str) -> list[dict[str, Any]]:
            out: list[dict[str, Any]] = []
            for path in glob.glob(glob.escape(self.path("reviews")) + f"/{pr}-{kind}-*.json"):
                if not re.fullmatch(re.escape(pr) + "-" + kind + r"-[0-9a-f]{12}\.json", os.path.basename(path)):
                    continue
                try:
                    with open(path, encoding="utf-8") as f:
                        data: Any = json.load(f)
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict):
                    out.append(cast(dict[str, Any], data))
            return out

        blocking = any(r.get("decision") in ("confirm", "unreadable") for r in records("at-open"))
        return blocking and not any(r.get("decision") == "cleared" for r in records("confirm"))

    def handback(self, worker: Worker, turn: int, message: str, what: Turn) -> None:
        pr = worker.fields.get("pr", "") or what.pr
        kept = self.path("handbacks", f"{worker.task}.md")
        os.makedirs(os.path.dirname(kept), exist_ok=True)
        with open(message, encoding="utf-8", errors="surrogateescape") as f:
            write_atomically(kept, f.read())
        if not pr:
            return self.attention(worker, turn, "handback", "the hand-back names no PR (the row has none, the message no"
                                                            " /pull/<n>); close the task by hand", kept)
        done = self.call("board", "close", self.wave.wave, worker.task, "--pr", pr, "--evidence", f"hand-back {kept}")
        said = substitution(done.out).splitlines()[-1] if done.out.strip() else f"board close exit {done.rc}"
        if done.rc != 0:
            return self.attention(worker, turn, "handback", f"board close refused: {said}", kept)
        if self.unconfirmed(pr):
            return self.attention(worker, turn, "handback", f"#{pr} merged with a blocking review and no cleared confirm on"
                                                            f" record; the task is closed ({said})", kept)
        self.note(worker, turn, "handback", "answered", said)

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
