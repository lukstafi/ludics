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
  leg``'s THE WINDOW WAIT is the slot's). The shorthand takes the complete runner command, including
  its executable. It refuses literal ``--cpu`` or ``--gpu`` in an argument array or a single line of
  shell words before asking the registry. Redirection and control operator tokens, and words
  starting with ``#``, also require an array for literal arguments or a full ``command`` for shell
  syntax. It does not expand shell syntax, inspect the project for an executable, or infer whether
  a flag belongs to the leg or the runner. Use a full ``command`` when either flag is needed. A
  string runner follows ``--`` as written; an array is
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
  printed for it. A window that exited 3 is pending (registry.py, THE PENDING WINDOW), and the line
  says so: the same call later is its retry. An exit 2 or 5 needs a change or reconciliation before
  trying that block again. It wins over other refusals in this call, even if some blocks assigned.
- ``ASSIGN ALREADY <id>: ...``: the registry already holds the request past ``reserved`` (an earlier
  call dispatched it, or it is concluded), so it is not asked again and nothing is printed: a
  ``run`` would refuse it, and an assignment printed twice is two runs. A still-``reserved`` record is
  dispatched by ``run`` like a new one.
- ``ASSIGN UNKNOWN <id>: ...``: the step exited 4 (the anchor did not answer), output could not be
  collected after the child started, or the step exited 0 with a record this verb cannot read the
  revision off. Reconcile it before retrying. If reporting the unknown outcome also fails, the
  call stops with exit 4 before publishing an assignment message.

A payload staging error before child startup says ``nothing asked`` and is a retryable refusal.

An assign that returns exit 5 ends stderr with one ``ASSIGN ACTION REQUIRED `` summary, with the
ID and diagnostic for each step that exited 2 or 5. Only the step's first ``fleet-worker.sh: ``
usage line (exit 2) or ``EXECUTION REFUSED: `` admission line (exit 5) supplies diagnostic text.
The child's other stderr is relayed live and its stdout is echoed afterwards.

So a RETRY after a partial failure is the same call again: what was assigned answers ALREADY and is
not dispatched or printed again, a refused request is asked afresh, and an unknown one is answered by
the registry's retry rule (``run`` refuses a dispatched record, so it is never launched twice). The
message for an earlier call's assignment is not recomposed: keep it with ``--message``.

THE BOARD / RECOVERY BOUNDARY. For a selected block with an explicit checkout, a successful
run/window, or ASSIGN ALREADY from the registry, unions execution_host:checkout into the unique
row whose worker matches the base, and its host into exec_hosts. This internal board write holds
its lease lock across read/union/write, preserves other placements, and is safe to retry after
an interrupted write or dispatch. With the lease held, no board or no matching worker row is a
noted no-op: assign
also serves workers without boards. An ambiguous row or a failed write is a NOTE and exit 1;
the assignment still prints, and the same call repairs the board via ALREADY without redispatch.
The existing farside format cannot encode whitespace in a path or a colon in a host: such a
placement refuses without changing either field; reconcile it by hand, never record its prefix.
An ALREADY write also requires the registry's wave, worker, execution_host and checkout to match
the base/block; a mismatched retry cannot register an unrelated cleanup path.
Blocks without checkout and nonzero dispatch outcomes add nothing. Checkout is explicit data,
never inferred from command text; this records a requested checkout, not proof a leg made it.

stdout is the message, the assignments only, and a closing line asking for one ``EXECUTION_RESULT``
line per assignment; for a native worker it is what the coordinator sends with SendMessage.
``--message <file>`` writes the same text to the file, and only when something was assigned, so a
retry that assigns nothing never overwrites the earlier message. ``--unstick <box> <name>`` (a CLI
worker; it requires ``--message``) then runs ``fleet-worker.sh unstick <box> <name> --message <file>``
once, only when something was assigned; a failed unstick leaves the records dispatched and is said
with the command that resends the file (exit 4): never assign again.

Exit: 0 every selected request ASSIGNED or ALREADY (and the unstick, if asked, landed); 1 one or
more REFUSED or BOARD NOTE failures that can be retried, none UNKNOWN; 2 usage, nothing asked;
4 one or more UNKNOWN, a registry that could not be read first, or an unstick that did not land;
5 one or more refusals need action before retry and none are UNKNOWN. An exit 5 with a message
still dispatched the assignments in that message. What the steps print themselves (the record,
the refresh line, a refusal) goes to stderr.
"""

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, cast

from ludics import cli, proc
from ludics.fleetworker import execution
from ludics.fleetworker.board import record_placement
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.registry import ASSIGN_ACTION_REQUIRED
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
LEG_SLOT_FLAGS = frozenset(("--cpu", "--gpu"))
SHELL_PUNCTUATION = "();<>|&"
ABSOLUTE = re.compile(r"/|[A-Za-z]:[/\\]")
ACTION_REQUIRED_LINE = "ASSIGN ACTION REQUIRED "
ACTION_DIAGNOSTIC_PREFIX = {2: "fleet-worker.sh: ", ASSIGN_ACTION_REQUIRED: "EXECUTION REFUSED: "}


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


def read_blocks(text: str, opening: str = OPEN, closing: str = CLOSE) -> list[Any] | str:
    """THE BLOCKS (see the header): each block's decoded JSON, in order, or why the text is refused.
    ``execution windows-witness`` reads its ``WINDOWS_WITNESS_REQUEST`` blocks by the same rule."""
    blocks: list[Any] = []
    inside: list[str] | None = None
    for line in text.split("\n"):
        word = line.strip()
        if inside is None:
            if word == opening:
                inside = []
            elif word == closing:
                return f"an {closing} line with no {opening} before it"
            continue
        if word == opening:
            return f"an {opening} line inside a block"
        if word == closing:
            try:
                blocks.append(json.loads("\n".join(inside)))
            except ValueError:
                return f"block {len(blocks) + 1} is not one JSON object"
            inside = None
            continue
        inside.append(line)
    if inside is not None:
        return f"block {len(blocks) + 1} has no {closing} line"
    if not blocks:
        return f"no {opening} ... {closing} block"
    return blocks


def is_absolute(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and bool(ABSOLUTE.match(value))


def runner_problem(runner: str | list[str], kind: str, revision: str) -> str | None:
    if isinstance(runner, str):
        lexer = shlex.shlex(runner, posix=True, punctuation_chars=SHELL_PUNCTUATION)
        lexer.whitespace_split = True
        lexer.commenters = ""
        try:
            words = list(lexer)
        except ValueError:
            return 'runner must contain complete shell words; use an argument array or a full leg in "command"'
        if "\n" in runner or any(word and (word.startswith("#") or not word.strip(SHELL_PUNCTUATION)) for word in words):
            return ('runner takes one line of shell words; use an argument array for literal punctuation or "#" words,'
                    ' or a full leg in "command" for shell syntax')
    else:
        words = runner
    if not words or not words[0]:
        return "runner must begin with its executable"
    flags = LEG_SLOT_FLAGS.intersection(words)
    if not flags:
        return None

    # The driver still scans stderr for lease refusals. Show the form without echoing request data.
    slot = " --wait-window [--cpu|--gpu]" if kind == "correctness" else ""
    guidance = (" Put the leg's slot flag before -- if needed. Keep runner-owned flags after --."
                if slot else " Measurement legs take no slot flags. Keep runner-owned flags after --.")
    if revision.startswith(HEAD_OF):
        guidance += " Pin the same full SHA in the command and requested_revision."
    return (f'runner contains {" and ".join(sorted(flags))}. Replace "runner" and "clone" with "command": '
            "fleet-worker.sh execution leg --request <request-id> --rev <full-SHA>"
            f" --checkout <clone> --worktree <checkout>{slot} -- <runner-executable> <runner-args>."
            f"{guidance}")


def block_problem(block: Any) -> str | None:
    """One block's shape (see the header): None, or why it is refused."""
    if not isinstance(block, dict):
        return "is not one JSON object"
    fields = cast(dict[str, Any], block)
    unknown = sorted(set(fields) - BLOCK_FIELDS)
    if unknown:
        return f"names {', '.join(unknown)}; a request block takes only {', '.join(sorted(BLOCK_FIELDS))}"
    for key in BLOCK_REQUIRED:
        if not (isinstance(fields.get(key), str) and fields[key].strip()):
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
    return runner_problem(cast(str | list[str], runner), fields["kind"], revision)


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
    if "runner" in block:
        form = "run it as: the command above already uses execution leg, which chooses slot or hold from the record's kind"
    else:
        wrapper = ("execution slot --wait-window --cpu -- <command> (use --gpu instead of --cpu for a GPU batch)"
                   if block["kind"] == "correctness"
                   else f"execution hold --request {shlex.quote(block['request_id'])} -- <command>")
        form = ("run it as: an execution leg command runs as written; for a bare batch on "
                f"{shlex.quote(block['execution_host'])}, {wrapper}")
    return "\n".join((
        f"EXECUTION_ASSIGNED {block['request_id']}",
        f"command: {command}",
        form,
        f"revision: {revision}",
        f"checkout: {block.get('checkout', '-')}",
        f"log: {block.get('log', '-')}",
    ))


@dataclass(frozen=True)
class StepResult(Done):
    diagnostic: str = ""


def step(cfg: Config, args: Sequence[str], payload: dict[str, Any]) -> StepResult:
    """This checkout's fleet-worker.sh with ``args`` and the payload file last. Relay stderr
    as it arrives so an operator sees the reason before a window sleeps."""
    script = os.path.join(cfg.here, os.path.basename(cfg.script))
    path = ""
    started = False
    diagnostics: dict[str, str] = {}
    try:
        descriptor, path = tempfile.mkstemp(prefix="fw-assign.", suffix=".json", dir=os.environ.get("TMPDIR") or "/tmp")
        with os.fdopen(descriptor, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
        sys.stdout.flush()
        sys.stderr.flush()
        # Spool stdout so a large registry response cannot block the child as we relay stderr.
        with tempfile.TemporaryFile() as stdout:
            try:
                child = subprocess.Popen(
                    [script, *args, path], stdout=stdout, stderr=subprocess.PIPE,
                    env={**os.environ, execution.ASSIGN_STEP_ENV: "1"},
                )
            except OSError as exc:
                err(f"{execution.shown(script)}: {exc.strerror}")
                return StepResult(127, "")
            started = True
            with child:
                assert child.stderr is not None
                for raw in child.stderr:
                    line = proc.decode(raw)
                    sys.stderr.write(line)
                    sys.stderr.flush()
                    for prefix in ACTION_DIAGNOSTIC_PREFIX.values():
                        if line.startswith(prefix):
                            diagnostics.setdefault(prefix, line.splitlines()[0].removeprefix(prefix))
                rc = child.wait()
            stdout.seek(0)
            out = proc.decode(stdout.read())
        if out:
            err(out.removesuffix("\n"))
    except OSError as exc:
        if started:
            return StepResult(4, "", f"could not collect the step's output after it started: {exc.strerror or exc}")
        err(f"execution assign: cannot stage the payload: {exc.strerror}; nothing asked")
        return StepResult(1, "")
    finally:
        if path:
            try:
                os.unlink(path)
            except OSError:
                pass
    prefix = ACTION_DIAGNOSTIC_PREFIX.get(rc)
    if prefix is None:
        return StepResult(rc, out)
    detail = diagnostics.get(prefix) or next(
        (line.removeprefix(prefix) for line in out.splitlines() if line.startswith(prefix)), ""
    )
    return StepResult(rc, out, detail)


def unstick(cfg: Config, box: str, name: str, message: str) -> int:
    script = os.path.join(cfg.here, os.path.basename(cfg.script))
    return run([script, "unstick", box, name, "--message", message], stdout_to_stderr=True).rc


Step = Callable[[Config, Sequence[str], dict[str, Any]], StepResult]
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
            label = f" ({name})" if isinstance(name, str) and execution.shown(name) == name else ""
            die(f"execution assign: block {n}{label} {problem}; nothing assigned")
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

    def placement(block: dict[str, Any], record: dict[str, Any] | None = None) -> bool:
        if "checkout" not in block:
            return True
        if record is not None and (
            any(execution.field(record, "request", key) != base_fields[key] for key in ("wave", "worker"))
            or execution.field(record, "request", "execution_host") != block["execution_host"]
            or execution.recorded_checkout(record) != block["checkout"]
        ):
            err(f"ASSIGN BOARD NOTE {execution.shown(block['request_id'])}: the registry's placement or owner"
                " differs from this request; reconcile it before recording a checkout")
            return False
        try:
            rc = record_placement(cfg, base_fields["wave"], base_fields["worker"], block["execution_host"], block["checkout"])
        except cli.Exit as exc:
            err(f"ASSIGN BOARD NOTE {execution.shown(block['request_id'])}: {exc.message};"
                " placement was not written, and remaining requests will still be handled")
            return False
        if rc:
            err(f"ASSIGN BOARD NOTE {execution.shown(block['request_id'])}: placement write exit {rc};"
                " retry this assign call to repair the row without dispatching again")
        return rc == 0

    texts: list[str] = []
    action_required: list[str] = []
    fw = fleet_worker_word(cfg)
    refusal_status = 0
    unknown = False
    for block in selected:
        request_id, kind, box = block["request_id"], block["kind"], block["execution_host"]
        shown_id = execution.shown(request_id) if request_id.isprintable() else ascii(request_id)
        record = execution.record_of(records, request_id)
        if record is not None and record.get("state") != "reserved":
            if not placement(block, record):
                refusal_status = refusal_status or 1
            err(f"ASSIGN ALREADY {request_id}: the registry holds it {execution.jq_text(record.get('state'))};"
                " an earlier call dispatched it, so it is not asked or assigned again")
            continue
        verb = ["execution", "run"] if kind == "correctness" else [
            "execution", "window", *(["--no-gap"] if parsed.no_gap else []),
            *(["--deadline", parsed.deadline] if parsed.deadline else []), box]
        answer = call(cfg, verb, payload_of(base_fields, block))
        if answer.rc == 4 or answer.unreachable:
            detail = answer.diagnostic or "above"
            try:
                err(f"ASSIGN UNKNOWN {shown_id}: the {verb[1]}'s outcome is unknown ({detail});"
                    " reconcile it, never retry it blind")
            except OSError:
                # Python can replace exit 4 with 120 if it flushes this failed stream at shutdown.
                with suppress(OSError):
                    stderr_fd = sys.stderr.fileno()
                    null_fd = os.open(os.devnull, os.O_WRONLY)
                    if null_fd != stderr_fd:
                        try:
                            os.dup2(null_fd, stderr_fd)
                        finally:
                            os.close(null_fd)
                return 4
            unknown = True
            continue
        if answer.rc != 0:
            # A window exiting 3 is pending (registry.py, THE PENDING WINDOW): refused for now, asked again later.
            pending = "; it is pending: ask again once the box's records conclude" if verb[1] == "window" and answer.rc == 3 else ""
            err(f"ASSIGN REFUSED {shown_id}: the {verb[1]} exited {answer.rc} (above); nothing assigned{pending}")
            if answer.rc in (2, ASSIGN_ACTION_REQUIRED):
                detail = answer.diagnostic or "inspect the assignment diagnostic before retrying"
                action_required.append(f"{shown_id}: {detail}")
                refusal_status = ASSIGN_ACTION_REQUIRED
            else:
                refusal_status = refusal_status or 1
            continue
        if not placement(block):
            refusal_status = refusal_status or 1
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
    if not unknown and refusal_status == ASSIGN_ACTION_REQUIRED:
        err(ACTION_REQUIRED_LINE + "; ".join(action_required))
    return 4 if unknown else refusal_status
