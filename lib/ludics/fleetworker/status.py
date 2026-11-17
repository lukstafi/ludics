"""``status --json [--since <hours>]`` (ludics#1165): one read-only document for observers.

An observer of the anchor (Flotilla's issue-wave panel, lukstafi/flotilla#8) read four layouts of its
own -- the board files, the ``COORDINATOR`` file (dropping its token), the ``HALT`` file and ``execution
list`` -- and guessed from a row's free-text state when a task was finished. This verb is that read,
owned here: a closed document, and a row's phase as Ludics derives it (``takeover``'s THE PHASE).

``status`` with any other first argument is a CLI worker's stall read, ``status <box> <name>``
(``workers.cmd_status``), unchanged: a box name never starts with ``-``, so ``--json`` names this form.

THE DOCUMENT, version 1 (this header is the one statement of it). One JSON object on stdout:

  version       1
  anchor        the anchor box read (FLEET_ANCHOR)
  generated_at  this box's clock, ``%Y-%m-%dT%H:%M:%SZ``
  since_hours   the window given, a number, or null for every board
  coordinator   {"host", "since"} from the lease (each a string or null), or null with no lease; never
                the token
  halt          the HALT marker's text (``""`` for an empty one), or null with no halt -- and null when
                HALT could not be read, which ``errors`` then names
  waves         one per board, in name order (only those the window keeps):
                {"wave", "created_at", "created_by", "updated_at", "notes": {key: text}, "tasks": [...]},
                each task, in board order:
                {"task", "updated_at", "state", "state_word", "phase", "issue", "repository", "pr",
                 "merge", "branch", "worker", "agent", "agent_host", "exec_hosts", "worktree", "kind",
                 "model", "transport"}
                ``state`` is the row's ``state`` (else its ``status``) as written, or null;
                ``state_word`` its STATE WORD or null; ``phase`` one of active, merged, done, closed,
                dropped, unknown (THE PHASE); ``exec_hosts`` a list, the row's value split at commas
                and whitespace with ``none`` dropped; every other key the row's value as written, or
                null when the row has none
  executions    the registry's open records, as ``execution list --active --compact`` gives them (the
                compact form drops ``history`` and ``lease_token``, the coordinator's token, and this
                verb drops those two keys again should a record carry them), or null when unread
  errors        [{"source": "board"|"boards"|"lease"|"halt"|"executions", "wave"?, "why"}]: each read
                that failed; ``board`` names one board the scan refused, the rest went on

Adding a key keeps version 1; removing or renaming one, or changing what one means, bumps it.

Exit: 0 printed, every source read; 3 printed, with ``errors`` (a reader takes the document as partial
then: no source in ``errors`` reads as empty or absent); 4 the anchor did not answer, nothing on
stdout and ``STATUS UNREACHABLE <anchor>`` on stderr; 2 usage.

What it reads, and nothing else (the boundary, an allowlist): on the anchor only, ``boards/<wave>.json``
(the board store's ``scan``: no lock, as ``board show``; each write is one ``os.replace``, so each board
is whole), the lease's ``host=`` and ``since=`` lines and ``HALT`` (lease.py's ``ANCHOR_FACTS``: no lock,
no lease, no identity), and the registry's ``list`` with ``active`` and ``compact`` (``execution list``'s
own read, under the registry's ``executions.lock`` as every ``execution list`` takes it). Three anchor
calls, whatever the number of boards. Not read: board logs (left out of the document), worker
processes, GitHub, the dashboard, any other box. ``phase`` reads a row's state's first word and nothing
else of the row. It writes nothing of its own (the registry's read may create its lock file, as any
``execution list`` does), takes no lease and needs no coordinator identity.

What it is not: an atomic snapshot of the fleet. Each board is one atomic document and the
executions one locked registry read, but the lease, the halt, the boards and the registry may each
move between the three reads. Orchestration (wavedrive's dependency and hold reads) keeps its own
``state_word`` reads; nothing here changes them.
"""

import json
import math
import re
from datetime import datetime, timezone
from typing import Any, cast

from ludics import cli
from ludics.fleetworker import lease
from ludics.fleetworker.board import store_command
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import listing, records_of
from ludics.fleetworker.identity import die
from ludics.fleetworker.takeover import phase_of, row_state, state_word
from ludics.fleetworker.transport import PAYLOAD_ON_FD, err, prelude, run_on

USAGE = "status --json [--since <hours>] | status <box> <name>"
VERSION = 1
HOURS = re.compile(r"[0-9]+(\.[0-9]+)?")
# The task keys printed as the row holds them (THE DOCUMENT), in their printed order around the
# derived ones.
ROW_KEYS = ("issue", "repository", "pr", "merge", "branch", "worker", "agent", "agent_host")
TAIL_KEYS = ("worktree", "kind", "model", "transport")
SECRET_KEYS = frozenset({"history", "lease_token"})


class Unreachable(Exception):
    """The anchor did not answer one of the three reads."""


def since_of(args: list[str]) -> float | None:
    """``--json [--since <hours>]``'s window, or the usage refusal (exit 2)."""
    if args[:1] != ["--json"]:
        die(f"status: expected --json ({USAGE})")
    rest = args[1:]
    if not rest:
        return None
    if rest[0] != "--since" or len(rest) != 2:
        die(f"status --json: expected [--since <hours>] ({USAGE})")
    hours = float(rest[1]) if HOURS.fullmatch(rest[1]) else math.nan
    if not math.isfinite(hours) or hours <= 0:
        die(f"status --json: --since takes a positive number of hours, not {json.dumps(rest[1], ensure_ascii=False)}")
    return hours


def text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def task_of(row: dict[str, Any]) -> dict[str, Any]:
    """One row as THE DOCUMENT's task."""
    raw: Any = row.get("fields")
    fields = {str(k): v for k, v in cast(dict[Any, Any], raw).items() if isinstance(v, str)} if isinstance(raw, dict) else {}
    state = row_state(fields)
    out: dict[str, Any] = {
        "task": text_or_none(row.get("task")),
        "updated_at": text_or_none(row.get("updated_at")),
        "state": state[1] if state is not None else None,
        "state_word": state_word(state[1]) if state is not None else None,
        "phase": phase_of(fields),
    }
    for key in ROW_KEYS:
        out[key] = fields.get(key)
    out["exec_hosts"] = [word for word in fields.get("exec_hosts", "").replace(",", " ").split() if word != "none"]
    for key in TAIL_KEYS:
        out[key] = fields.get(key)
    return out


def wave_of(doc: dict[str, Any]) -> dict[str, Any]:
    notes: Any = doc.get("notes")
    tasks: Any = doc.get("tasks")
    return {
        "wave": text_or_none(doc.get("wave")),
        "created_at": text_or_none(doc.get("created_at")),
        "created_by": text_or_none(doc.get("created_by")),
        "updated_at": text_or_none(doc.get("updated_at")),
        "notes": {str(k): v for k, v in cast(dict[Any, Any], notes).items() if isinstance(v, str)} if isinstance(notes, dict) else {},
        "tasks": [task_of(cast(dict[str, Any], r)) for r in cast(list[Any], tasks) if isinstance(r, dict)] if isinstance(tasks, list) else [],
    }


def read_boards(cfg: Config, since: float | None, errors: list[dict[str, str]]) -> list[dict[str, Any]]:
    """The store's ``scan`` on the anchor: the boards the window keeps, each refusal into ``errors``."""
    raw = json.dumps({"since_hours": since}, separators=(",", ":"))
    script = prelude(cfg, cfg.anchor) + "shift 3\n" + store_command(raw)
    done = run_on(cfg, cfg.anchor, script, ["BOARD", "x", "x", "scan", "x", PAYLOAD_ON_FD], capture=True)
    if done.unreachable:
        raise Unreachable
    try:
        decoded: Any = json.loads(done.out) if done.rc == 0 else None
    except ValueError:
        decoded = None
    if not isinstance(decoded, dict):
        why = f"the board scan exited {done.rc}" if done.rc != 0 else "the board scan's answer is not its JSON object"
        errors.append({"source": "boards", "why": why})
        return []
    scanned = cast(dict[str, Any], decoded)
    boards: Any = scanned.get("boards")
    refused: Any = scanned.get("refused")
    for entry in cast(list[Any], refused) if isinstance(refused, list) else []:
        if isinstance(entry, dict):
            item = cast(dict[str, Any], entry)
            errors.append({"source": "board", "wave": str(item.get("wave")), "why": str(item.get("why"))})
    docs = [cast(dict[str, Any], b) for b in cast(list[Any], boards) if isinstance(b, dict)] if isinstance(boards, list) else []
    return sorted((wave_of(d) for d in docs), key=lambda w: w["wave"] or "")


def read_facts(cfg: Config, errors: list[dict[str, str]]) -> tuple[dict[str, str | None] | None, str | None]:
    """The coordinator (host and since, never the token) and the halt's text, from ``ANCHOR_FACTS``."""
    facts = lease.anchor_facts(cfg)
    if facts is None:
        raise Unreachable
    coordinator: dict[str, str | None] | None = None
    if facts.lease == "present":
        coordinator = {"host": facts.host, "since": facts.since}
    elif facts.lease == "unread":
        errors.append({"source": "lease", "why": facts.why or "the lease on the anchor could not be read"})
    if facts.halt == "unread":
        errors.append({"source": "halt", "why": facts.why or "HALT on the anchor could not be read"})
    return coordinator, facts.halt_text if facts.halt == "present" else None


def read_executions(cfg: Config, errors: list[dict[str, str]]) -> list[dict[str, Any]] | None:
    """The registry's open records, compact (``execution list --active --compact``'s read)."""
    done = listing(cfg, options={"active": True, "compact": True})
    if done.unreachable:
        raise Unreachable
    records = records_of(done.out) if done.rc == 0 else None
    if records is None:
        why = f"the registry listing exited {done.rc}" if done.rc != 0 else "the registry listing is not a JSON array of records"
        errors.append({"source": "executions", "why": why})
        return None
    return [{k: v for k, v in record.items() if k not in SECRET_KEYS} for record in records]


def cmd_status_json(cfg: Config, args: list[str]) -> int:
    since = since_of(args)
    errors: list[dict[str, str]] = []
    try:
        coordinator, halt = read_facts(cfg, errors)
        waves = read_boards(cfg, since, errors)
        executions = read_executions(cfg, errors)
    except Unreachable:
        err(f"STATUS UNREACHABLE {cfg.anchor}")
        return 4
    document = {
        "version": VERSION,
        "anchor": cfg.anchor,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "since_hours": since,
        "coordinator": coordinator,
        "halt": halt,
        "waves": waves,
        "executions": executions,
        "errors": errors,
    }
    cli.say(json.dumps(document, ensure_ascii=False))
    return 3 if errors else 0
