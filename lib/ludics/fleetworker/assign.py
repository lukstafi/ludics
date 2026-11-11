"""``execution assign``: a worker's ``EXECUTION_REQUEST`` blocks answered in one call (ludics#869).

By hand, a coordinator completed each request's reservation, ran ``execution run`` (or ``execution
window`` for a measurement), then composed the ``EXECUTION_ASSIGNED`` message -- and once sent one for
a window the registry had REFUSED, since nothing tied the message to the step's exit. This verb is
those steps, in that order, with the message printed only for a request whose step exited 0:

    execution assign <base.json> <requests file|-> [--request <id>]... [--no-gap] [--deadline <s>]
                     [--message <file>] [--unstick <box> <name>]

It composes the existing ``execution run`` and ``execution window`` calls, each a fleet-worker.sh
of this checkout invoked as the coordinator invokes it, so every check they make (the lease, the
halt, the cap, measurement exclusivity, the revision check, a ``head-of:`` resolution, the refresh)
applies unchanged, and no second reservation path exists. A correctness request is ``run``; a
measurement is ``window <its execution_host>``, with ``--no-gap`` and ``--deadline`` passed to it
(a window over a box holding no standing record is ``run``'s admission, so one form serves both).

WHAT IS READ, a fail-closed allowlist; anything outside it refuses the whole call (exit 2) before
the registry is asked, so a malformed request reserves nothing, and neither do its siblings:

- ``<base.json>``: one JSON object, the coordinator's completion of every request in the call, of
  BASE_FIELDS only: ``wave``, ``worker``, ``transport``, ``agent_host``, ``repository`` (required,
  nonempty strings), ``issue`` and ``purpose`` (optional strings). Nothing a worker cannot be
  trusted to choose comes from the worker: a block cannot set the transport, the wave, ``standing``,
  ``integration`` or ``triage_reason``, so ``assign`` never takes a standing, integration or triage
  reservation (those keep their own verbs: ``run``, ``tip-run``).
- the requests file (``-``: stdin): the worker's final message as written, of which only the blocks
  are read -- a line that is, stripped of blanks, ``EXECUTION_REQUEST``, then everything up to a line
  that is, stripped, ``END_EXECUTION_REQUEST``, which must be one JSON object of BLOCK_FIELDS only.
  Text outside the blocks is not read (prose, code fences, the brief's indentation). Required:
  ``request_id``, ``execution_host``, ``kind`` (correctness or measurement), ``requested_revision``
  (strings), and exactly one of ``command`` (a string, sent as written) or ``runner`` (a string, or
  an array of strings, the box-relative runner command of a leg). Optional: ``checkout`` (absolute;
  kept beside the request as the record's, THE CHECKOUT), ``log`` (a string, ``-`` when absent),
  ``purpose`` (a string, preferred to the base's; one of the two must give it), and ``clone``, the leg's ``--checkout``: the
  box's git checkout the leg's worktree is made from. An unterminated block, a block in a block,
  no block, two blocks with one ``request_id``, and a ``--request`` naming no block are refused.
- THE RUNNER (quirk 9): a block with ``runner`` is assigned as the leg form, ``<this fleet-worker.sh>
  execution leg --request <id> --rev <revision> --checkout <clone> --worktree <checkout> [--wait-window]
  -- <runner>`` -- its ``clone`` and ``checkout`` required (absolute), its ``requested_revision`` a full
  40-hex SHA or ``head-of:<branch>`` (free text names no commit a leg can move to), ``--wait-window``
  added for a correctness leg and never for a measurement, whose leg refuses it (``execution
  leg``'s THE WINDOW WAIT is the slot's). A string runner follows ``--`` as written; an array is
  shell-joined. This fleet-worker.sh is named by its absolute path, ``$HOME`` written ``~``, so the
  worker's own box reads the same layout. A block with ``command`` is assigned that text unchanged.

THE ASSIGNMENT. ``--request <id>`` (repeatable) selects blocks; none selects every block. The
registry is read once first (an unreachable or unreadable one: exit 4, nothing asked). Each selected
block, in file order, then has one outcome, said in one line on stderr:

- ``ASSIGN ASSIGNED <id> <kind> <box> <revision>``: its ``run``/``window`` exited 0, and its
  ``EXECUTION_ASSIGNED <id>`` text (command, revision, checkout, log) is printed on stdout. The
  revision is the record's ``resolved_revision`` for a ``head-of:`` request (read off the step's
  stdout, the record), else the request's ``requested_revision``.
- ``ASSIGN REFUSED <id>: ...``: the step exited nonzero but 4 (its refusal is above); nothing is
  printed for it.
- ``ASSIGN ALREADY <id>: ...``: the registry already holds the request past ``reserved`` (an earlier
  call dispatched it, or it is concluded), so it is not asked again and nothing is printed: a
  ``run`` would refuse it, and an assignment printed twice is two runs. A still-``reserved`` record is
  dispatched by ``run`` like a new one.
- ``ASSIGN UNKNOWN <id>: ...``: the step exited 4 (the anchor did not answer), or exited 0 with a
  record this verb cannot read the revision off; reconcile it, never retry it blind.

So a RETRY after a partial failure is the same call again: what was assigned answers ALREADY and is
not dispatched or printed again, a refused request is asked afresh, and an unknown one is answered by
the registry's retry rule (``run`` refuses a dispatched record, so it is never launched twice). The
message for an earlier call's assignment is not recomposed: keep it with ``--message``.

stdout is the message, the assignments only, and a closing line asking for one ``EXECUTION_RESULT``
line per assignment; for a native worker it is what the coordinator sends with SendMessage.
``--message <file>`` writes the same text to the file, and only when something was assigned, so a
retry that assigns nothing never overwrites the earlier message. ``--unstick <box> <name>`` (a CLI
worker; it requires ``--message``) then runs ``fleet-worker.sh unstick <box> <name> --message <file>``
once, only when something was assigned; a failed unstick leaves the records dispatched and is said
with the command that resends the file (exit 4): never assign again.

Exit: 0 every selected request ASSIGNED or ALREADY (and the unstick, if asked, landed); 1 one or
more REFUSED, none UNKNOWN; 2 usage, nothing asked; 4 one or more UNKNOWN, a registry that could not
be read first, or an unstick that did not land. What the steps print themselves (the record, the
refresh line, a refusal) goes to stderr.
"""

import json
import os
import re
import shlex
import sys
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

from ludics import cli
from ludics.fleetworker import execution
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import Done, err, run

USAGE = ("execution assign <base.json> <requests file|-> [--request <id>]... [--no-gap] [--deadline <seconds>]"
         " [--message <file>] [--unstick <box> <name>]")
BASE_REQUIRED = ("wave", "worker", "transport", "agent_host", "repository")
BASE_FIELDS = frozenset((*BASE_REQUIRED, "issue", "purpose"))
BLOCK_REQUIRED = ("request_id", "execution_host", "kind", "requested_revision")
BLOCK_FIELDS = frozenset((*BLOCK_REQUIRED, "checkout", "command", "runner", "clone", "log", "purpose"))
OPEN, CLOSE = "EXECUTION_REQUEST", "END_EXECUTION_REQUEST"
OBJECT_ID = re.compile(r"[0-9a-f]{40}")
HEAD_OF = "head-of:"
ABSOLUTE = re.compile(r"/|[A-Za-z]:[/\\]")


@dataclass
class AssignArgs:
    base: str
    requests: str
    only: list[str] = field(default_factory=lambda: list[str]())
    no_gap: bool = False
    deadline: str = ""
    message: str = ""
    unstick: tuple[str, str] | None = None


def parse(args: list[str]) -> AssignArgs:
    """The command line, flags anywhere after ``assign``; a usage death (exit 2) otherwise."""
    positional: list[str] = []
    only: list[str] = []
    no_gap = False
    deadline = message = ""
    unstick: tuple[str, str] | None = None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ("--request", "--deadline", "--message"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"execution assign: expected a value for {arg} ({USAGE})")
            value = args[i + 1]
            if arg == "--request":
                only.append(value)
            elif arg == "--deadline":
                if not re.fullmatch(r"[0-9]+", value) or int(value) < 1:
                    die("execution assign: --deadline takes a positive whole number of seconds")
                deadline = value
            else:
                message = value
            i += 2
        elif arg == "--unstick":
            if i + 2 >= len(args) or not args[i + 1] or not args[i + 2]:
                die(f"execution assign: --unstick takes a box and a worker name ({USAGE})")
            unstick = (args[i + 1], args[i + 2])
            i += 3
        elif arg == "--no-gap":
            no_gap = True
            i += 1
        elif arg.startswith("--"):
            die(USAGE)
        else:
            positional.append(arg)
            i += 1
    if len(positional) != 2:
        die(USAGE)
    if unstick is not None and not message:
        die("execution assign: --unstick sends the --message file; name one, where the text is kept for a resend")
    return AssignArgs(positional[0], positional[1], list(dict.fromkeys(only)), no_gap, deadline, message, unstick)


def read_text(path: str, what: str) -> str:
    try:
        if path == "-":
            return sys.stdin.read()
        with open(path, encoding="utf-8", errors="surrogateescape") as f:
            return f.read()
    except OSError as exc:
        die(f"execution assign: cannot read {what} {execution.shown(path)}: {exc.strerror}")


def base_problem(base: Any) -> str | None:
    """THE BASE (see the header): None when it is the coordinator's completion, else why not."""
    if not isinstance(base, dict):
        return "the base is not one JSON object"
    fields = cast(dict[str, Any], base)
    unknown = sorted(set(fields) - BASE_FIELDS)
    if unknown:
        return f"the base names {', '.join(unknown)}; it takes only {', '.join(sorted(BASE_FIELDS))}"
    for key in BASE_REQUIRED:
        if not (isinstance(fields.get(key), str) and fields[key]):
            return f"the base must give {key}, a nonempty string"
    for key in ("issue", "purpose"):
        if key in fields and not (isinstance(fields[key], str) and fields[key]):
            return f"the base's {key} must be a nonempty string"
    return None


def read_blocks(text: str) -> list[Any] | str:
    """THE BLOCKS (see the header): each block's decoded JSON, in order, or why the text is refused."""
    blocks: list[Any] = []
    inside: list[str] | None = None
    for line in text.split("\n"):
        word = line.strip()
        if inside is None:
            if word == OPEN:
                inside = []
            elif word == CLOSE:
                return f"an {CLOSE} line with no {OPEN} before it"
            continue
        if word == OPEN:
            return f"an {OPEN} line inside a block"
        if word == CLOSE:
            try:
                blocks.append(json.loads("\n".join(inside)))
            except ValueError:
                return f"block {len(blocks) + 1} is not one JSON object"
            inside = None
            continue
        inside.append(line)
    if inside is not None:
        return f"block {len(blocks) + 1} has no {CLOSE} line"
    if not blocks:
        return f"no {OPEN} ... {CLOSE} block"
    return blocks


def is_absolute(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and bool(ABSOLUTE.match(value))


def block_problem(block: Any) -> str | None:
    """One block's shape (see the header): None, or why it is refused."""
    if not isinstance(block, dict):
        return "is not one JSON object"
    fields = cast(dict[str, Any], block)
    unknown = sorted(set(fields) - BLOCK_FIELDS)
    if unknown:
        return f"names {', '.join(unknown)}; a request block takes only {', '.join(sorted(BLOCK_FIELDS))}"
    for key in BLOCK_REQUIRED:
        if not (isinstance(fields.get(key), str) and fields[key]):
            return f"must give {key}, a nonempty string"
    if fields["kind"] not in ("correctness", "measurement"):
        return "kind must be correctness or measurement"
    for key in ("log", "purpose"):
        if key in fields and not (isinstance(fields[key], str) and fields[key]):
            return f"{key} must be a nonempty string"
    if "checkout" in fields and not is_absolute(fields["checkout"]):
        return "checkout must be an absolute path on the execution host"
    if ("command" in fields) == ("runner" in fields):
        return "must give exactly one of command (sent as written) or runner (wrapped into the leg form)"
    if "command" in fields:
        if not (isinstance(fields["command"], str) and fields["command"].strip()):
            return "command must be a nonempty string"
        if "clone" in fields:
            return "clone is a runner's leg --checkout; a command names its own"
        return None
    runner = fields["runner"]
    words = cast(list[Any], runner) if isinstance(runner, list) else None
    if not ((isinstance(runner, str) and runner.strip())
            or (words and all(isinstance(word, str) and word for word in words))):
        return "runner must be a nonempty string or a nonempty array of nonempty strings"
    for key, flag in (("clone", "--checkout"), ("checkout", "--worktree")):
        if not is_absolute(fields.get(key)):
            return f"a runner needs {key}, absolute on the execution host: the leg's {flag}"
    revision = fields["requested_revision"]
    if not (OBJECT_ID.fullmatch(revision) or revision.startswith(HEAD_OF)):
        return "a runner's requested_revision must be a full 40-hex SHA or head-of:<branch>: the leg moves to one commit"
    return None


def fleet_worker_word(cfg: Config) -> str:
    """This fleet-worker.sh, absolute, ``$HOME`` written ``~`` and the rest shell-quoted."""
    path = os.path.abspath(cfg.script)
    home = (cfg.env.get("HOME") or "").rstrip("/")
    if home and path.startswith(home + "/"):
        return "~/" + shlex.quote(path[len(home) + 1 :])
    return shlex.quote(path)


def leg_command(fw: str, block: dict[str, Any], revision: str) -> str:
    """THE RUNNER (see the header): the block's runner wrapped into the leg form."""
    runner = block["runner"]
    tail = runner if isinstance(runner, str) else shlex.join(cast(list[str], runner))
    words = ["execution", "leg", "--request", block["request_id"], "--rev", revision,
             "--checkout", block["clone"], "--worktree", block["checkout"]]
    if block["kind"] == "correctness":
        words.append("--wait-window")
    return f"{fw} {shlex.join(words)} -- {tail}"


def payload_of(base: dict[str, Any], block: dict[str, Any]) -> dict[str, Any]:
    """The ``run``/``window`` reservation: the base, the block's request fields, its checkout beside
    them (THE CHECKOUT), and the worker's command as the dispatch's evidence."""
    request = {key: base[key] for key in BASE_FIELDS if key in base and key != "purpose"}
    request.update({key: block[key] for key in BLOCK_REQUIRED})
    purpose = block.get("purpose") or base.get("purpose")
    if purpose:
        request["purpose"] = purpose
    asked = block.get("command") if "command" in block else block["runner"]
    shown = asked if isinstance(asked, str) else shlex.join(cast(list[str], asked))
    payload: dict[str, Any] = {**request, "evidence": f"assigned by execution assign; the worker asked: {shown}"}
    if "checkout" in block:
        payload["checkout"] = block["checkout"]
    return payload


def assigned_revision(stdout: str, block: dict[str, Any]) -> str | None:
    """The revision the assignment names: the dispatched record's ``resolved_revision`` for a
    ``head-of:`` request, read off the step's stdout (the record, first), else the requested one."""
    if not block["requested_revision"].startswith(HEAD_OF):
        return block["requested_revision"]
    try:
        record, _ = json.JSONDecoder().raw_decode(stdout.lstrip())
    except ValueError:
        return None
    resolved = cast(dict[str, Any], record).get("resolved_revision") if isinstance(record, dict) else None
    return resolved if isinstance(resolved, str) and OBJECT_ID.fullmatch(resolved) else None


def assignment_text(block: dict[str, Any], command: str, revision: str) -> str:
    return "\n".join((
        f"EXECUTION_ASSIGNED {block['request_id']}",
        f"command: {command}",
        f"revision: {revision}",
        f"checkout: {block.get('checkout', '-')}",
        f"log: {block.get('log', '-')}",
    ))


def step(cfg: Config, args: Sequence[str], payload: dict[str, Any]) -> Done:
    """This checkout's fleet-worker.sh with ``args`` and the payload file last: stdout captured
    (the record) and echoed on stderr, stderr the caller's."""
    script = os.path.join(cfg.here, os.path.basename(cfg.script))
    path = ""
    try:
        descriptor, path = tempfile.mkstemp(prefix="fw-assign.", suffix=".json", dir=os.environ.get("TMPDIR") or "/tmp")
        with os.fdopen(descriptor, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
        done = run([script, *args, path], capture=True)
    except OSError as exc:
        err(f"execution assign: cannot stage the payload: {exc.strerror}; nothing asked")
        return Done(1, "")
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
    if done.out:
        sys.stderr.write(done.out if done.out.endswith("\n") else done.out + "\n")
        sys.stderr.flush()
    return done


def unstick(cfg: Config, box: str, name: str, message: str) -> int:
    script = os.path.join(cfg.here, os.path.basename(cfg.script))
    return run([script, "unstick", box, name, "--message", message], stdout_to_stderr=True).rc


Step = Callable[[Config, Sequence[str], dict[str, Any]], Done]
Unstick = Callable[[Config, str, str, str], int]


def cmd_assign(cfg: Config, args: list[str], *, call: Step = step, resend: Unstick = unstick) -> int:
    parsed = parse(args)
    try:
        base: Any = json.loads(read_text(parsed.base, "the base"))
    except ValueError:
        base = None
    problem = base_problem(base)
    if problem:
        die(f"execution assign: {problem} ({execution.shown(parsed.base)})")
    read = read_blocks(read_text(parsed.requests, "the requests"))
    if isinstance(read, str):
        die(f"execution assign: {read} in {execution.shown(parsed.requests)}")
    blocks: list[dict[str, Any]] = []
    for n, block in enumerate(read, 1):
        problem = block_problem(block)
        if problem:
            name = cast(dict[str, Any], block).get("request_id") if isinstance(block, dict) else None
            die(f"execution assign: block {n}{f' ({name})' if isinstance(name, str) else ''} {problem}; nothing assigned")
        blocks.append(cast(dict[str, Any], block))
    ids = [block["request_id"] for block in blocks]
    twice = sorted({i for i in ids if ids.count(i) > 1})
    if twice:
        die(f"execution assign: {', '.join(twice)} named by two blocks; nothing assigned")
    missing = [i for i in parsed.only if i not in ids]
    if missing:
        die(f"execution assign: --request {', '.join(missing)} names no block; nothing assigned")
    selected = [block for block in blocks if not parsed.only or block["request_id"] in parsed.only]
    base_fields = cast(dict[str, Any], base)
    aimless = [block["request_id"] for block in selected if not (block.get("purpose") or base_fields.get("purpose"))]
    if aimless:
        die(f"execution assign: {', '.join(aimless)} has no purpose, and the base gives none; nothing assigned")

    done = execution.listing(cfg)
    records = execution.records_of(done.out) if done.rc == 0 and not done.unreachable else None
    if records is None:
        # stdout is the message alone: nothing on it may read as an assignment.
        if done.out:
            err(done.out.rstrip("\n"))
        err(f"ASSIGN UNKNOWN: the registry on {cfg.anchor} could not be read; nothing asked")
        return 4

    fw = fleet_worker_word(cfg)
    texts: list[str] = []
    refused = unknown = False
    for block in selected:
        request_id, kind, box = block["request_id"], block["kind"], block["execution_host"]
        record = execution.record_of(records, request_id)
        if record is not None and record.get("state") != "reserved":
            err(f"ASSIGN ALREADY {request_id}: the registry holds it {execution.jq_text(record.get('state'))};"
                " an earlier call dispatched it, so it is not asked or assigned again")
            continue
        verb = ["execution", "run"] if kind == "correctness" else [
            "execution", "window", *(["--no-gap"] if parsed.no_gap else []),
            *(["--deadline", parsed.deadline] if parsed.deadline else []), box]
        answer = call(cfg, verb, payload_of(base_fields, block))
        if answer.rc == 4 or answer.unreachable:
            err(f"ASSIGN UNKNOWN {request_id}: the {verb[1]}'s outcome is unknown (above); reconcile it, never retry it blind")
            unknown = True
            continue
        if answer.rc != 0:
            err(f"ASSIGN REFUSED {request_id}: the {verb[1]} exited {answer.rc} (above); nothing assigned")
            refused = True
            continue
        revision = assigned_revision(answer.out, block)
        if revision is None:
            err(f"ASSIGN UNKNOWN {request_id}: dispatched, but no resolved_revision could be read off its record (above);"
                " reconcile it, and assign its resolved_revision by hand")
            unknown = True
            continue
        command = block["command"] if "command" in block else leg_command(fw, block, revision)
        texts.append(assignment_text(block, command, revision))
        err(f"ASSIGN ASSIGNED {request_id} {kind} {box} {revision}")
    if texts:
        texts.append(f"Run only the {len(texts)} assignment{'s' if len(texts) > 1 else ''} above, and end your turn with"
                     " one EXECUTION_RESULT line for each.")
        message = "\n\n".join(texts)
        cli.say(message)
        if parsed.message:
            try:
                with open(parsed.message, "w", encoding="utf-8") as f:
                    f.write(message + "\n")
            except OSError as exc:
                err(f"ASSIGN UNKNOWN: the message could not be written to {execution.shown(parsed.message)}"
                    f" ({exc.strerror}); it is the text above")
                return 4
        if parsed.unstick is not None:
            box, name = parsed.unstick
            if resend(cfg, box, name, parsed.message) != 0:
                err(f"ASSIGN UNSTICK FAILED {box}/{name}: the assignments are dispatched; once the worker's state is"
                    f" known, resend with: fleet-worker.sh unstick {shlex.quote(box)} {shlex.quote(name)} --message"
                    f" {execution.shown(parsed.message)} -- never assign again")
                return 4
    elif parsed.unstick is not None:
        err("ASSIGN UNSTICK SKIPPED: nothing was assigned")
    return 4 if unknown else 1 if refused else 0
