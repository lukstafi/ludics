"""``board``: the wave board on the anchor as structured data (ludics-lite#619).

The board is one JSON document per wave under FLEET_ANCHOR_STATE, kept by
``ludics.fleetworker.boardstore``, whose SOURCE travels to the anchor and runs there from stdin under a
Python >= 3.12 the far side finds, as the execution registry's does (``execution.registry_command``).
Its header is the contract: the document, what it accepts, and the markdown view's boundary.

  board set [--create] [--new-row] <wave> <task> <key=value>...   a task's row (lease); a task with
                                                      no row yet refuses without ``--new-row``
  board note [--create] <wave> <key=value>...         the wave's own facts (lease)
  board log <wave> <text>...                          one appended log line, the words joined (lease)
  board show <wave> [--json]                          the markdown view, or the document (no lease);
                                                      exit 5 for a wave with no board (the store's
                                                      NO_BOARD_EXIT), 1 for any other refusal
  board check <wave>                                  the close-out check: every row done (no lease)
  board takeover <wave> <task>                        a worker's stored brief and its state now (no
                                                      lease; ``ludics.fleetworker.takeover``)
  board close <wave> <task> [--pr <n>] ...            a merged task's close-out, in one line (lease;
                                                      ``ludics.fleetworker.closeout``)

``record_placement`` is assign's internal writer: the store unions a requested host/checkout
into the unique worker row under the lease lock (boardstore.py's placement contract).

A row's state is its ``state`` key, a STATE WORD first (``takeover``'s header states the vocabulary,
ludics#810). ``set`` writes any value as given, and warns on stderr (``BOARD WARNING: ...``, the exit
unchanged) for a ``state`` whose first word is no state word and for a ``status`` key, the name
boards before #810 used beside ``state``. ``check`` reads each row's ``state``, or on a row with no
``state`` its ``status``, by the state words and nothing else of the row, the notes or the log: it
prints ``BOARD CHECK <wave>: <n> rows, <d> done, <o> not done``, then a line per row not done, and
exits 0 when every row's state is a done word, 3 when a row's is not (a live word, no state word or
no state: an allowlist), 1 with no board, 4 when the anchor did not answer.

The writers run inside the lease lock after the lease check (``lease.LEASE_MUTATION``), the lock and
check every halt and registry write takes; ``show`` takes neither, so anyone may read a board. Every
argument travels inside one JSON payload, ASCII-escaped, so no cell text is a shell word, a ``sed``
pattern or a delimiter on the near side, over ssh, or on the anchor; the payload rides the far-side
script to the store's fd 3, never one argv word, so no length of it fails execve (ludics-lite#636,
``transport.shipped_python``). A ``key=value`` splits at its
FIRST ``=``: the value is everything after it, ``=`` included. ``--create`` (the board) and ``--new-row``
(``set`` only: the task's row) are read only right after the action, in either order, so no value can
be mistaken for one; ``log`` takes neither and never starts a board, since an append is not idempotent
and a retried first write must be.
"""

import json

from typing import Any, cast

from ludics import cli
from ludics.fleetworker import boardstore
from ludics.fleetworker.config import Config
from ludics.fleetworker.farside import FLEET_PYTHON
from ludics.fleetworker.identity import check_identity, coordinator_id, die, my_token
from ludics.fleetworker.lease import LEASE_MUTATION
from ludics.fleetworker.takeover import DONE_STATES, LIVE_STATES, board_document, cmd_takeover, state_word
from ludics.fleetworker.transport import PAYLOAD_ON_FD, err, prelude, run_on, shipped_python

USAGE = (
    "board set [--create] [--new-row] <wave> <task> <key=value>... | board note [--create] <wave> <key=value>... | "
    "board log <wave> <text>... | board show <wave> [--json] | board check <wave> | board takeover <wave> <task> | "
    "board close <wave> <task> [--pr <n>] [--agent <id>] [--evidence <text>]"
)
STATE_WORDS = f"live {', '.join(LIVE_STATES)}; done {', '.join(DONE_STATES)}"

FIND_PYTHON = (
    FLEET_PYTHON
    + 'py=$(fleet_python) || { echo "BOARD REFUSED: no Python >= 3.12 on $BOX to keep the board'
    + " (scripts/py's probe; install one, or name it in LUDICS_PY_CANDIDATES)\" >&2; exit 1; }\n"
)


def store_command(raw: str) -> str:
    """The far side's last lines: the store's source as the program, its argv after it, and the
    payload on its fd 3 (``transport.shipped_python``; the argv's payload word is PAYLOAD_ON_FD)."""
    with open(boardstore.__file__, encoding="utf-8") as f:
        source = f.read()
    return shipped_python(FIND_PYTHON, source, "FLEET_BOARD_PY", raw)


def fields_of(words: list[str], action: str) -> list[list[str]]:
    """``key=value`` words as [key, value] pairs, split at the first ``=``. The key's grammar is the
    store's to judge; a word with no ``=`` is a usage error here."""
    if not words:
        die(f"board {action}: give at least one <key>=<value> ({USAGE})")
    pairs: list[list[str]] = []
    for word in words:
        key, sep, value = word.partition("=")
        if not sep:
            die(f"board {action}: expected <key>=<value>, got {json.dumps(word, ensure_ascii=False)} ({USAGE})")
        pairs.append([key, value])
    return pairs


def payload_of(args: list[str]) -> tuple[str, dict[str, object]]:
    """The action and the store's payload for a ``board`` command line, or a usage refusal (exit 2)."""
    action = args[0] if args else ""
    rest = args[1:]
    if action == "show":
        if rest[1:] not in ([], ["--json"]) or not rest:
            die(f"board show: expected <wave> [--json] ({USAGE})")
        return action, {"wave": rest[0], "json": rest[1:] == ["--json"]}
    if action not in ("set", "note", "log"):
        die(f"board: expected set, note, log, show, check, takeover or close ({USAGE})")
    flags: set[str] = set()
    while rest and rest[0] in ("--create", "--new-row") and rest[0] not in flags:
        flags.add(rest[0])
        rest = rest[1:]
    create = "--create" in flags
    if create and action == "log":
        die(f"board log: takes no --create; start the board with set or note --create ({USAGE})")
    if "--new-row" in flags and action != "set":
        die(f"board {action}: takes no --new-row; a row is a task's, written with set ({USAGE})")
    if not rest:
        die(f"board {action}: expected <wave> ({USAGE})")
    payload: dict[str, object] = {"wave": rest[0]}
    if action != "log":
        payload["create"] = create
    if action == "set":
        payload["new_row"] = "--new-row" in flags
    rest = rest[1:]
    match action:
        case "set":
            if not rest:
                die(f"board set: expected <task> ({USAGE})")
            payload["task"] = rest[0]
            payload["fields"] = fields_of(rest[1:], action)
        case "note":
            payload["fields"] = fields_of(rest, action)
        case _:
            if not rest:
                die(f"board log: expected the line's text ({USAGE})")
            payload["text"] = " ".join(rest)
    return action, payload


def warnings_of(task: str, pairs: list[list[str]]) -> list[str]:
    """``set``'s warnings on a row's state (the header): a ``status`` key, a ``state`` with no state word."""
    shown = json.dumps(task, ensure_ascii=False)
    out: list[str] = []
    for key, value in pairs:
        if key == "status":
            out.append(f"BOARD WARNING: task {shown}: a row's state is its state key, not status; written as given")
        elif key == "state" and state_word(value) is None:
            out.append(f"BOARD WARNING: task {shown}: state={json.dumps(value, ensure_ascii=False)} starts with no"
                       f" state word ({STATE_WORDS}); written as given")
    return out


def row_state(fields: dict[str, str]) -> tuple[str, str] | None:
    """The key and value ``check`` reads as the row's state: ``state``, else ``status``, else none."""
    for key in ("state", "status"):
        if key in fields:
            return key, fields[key]
    return None


def cmd_check(cfg: Config, args: list[str]) -> int:
    if len(args) != 1 or not args[0]:
        die(f"board check: expected <wave> ({USAGE})")
    wave = args[0]
    doc = board_document(cfg, wave)
    if isinstance(doc, int):
        return doc
    tasks: Any = doc.get("tasks")
    rows = [cast(dict[str, Any], r) for r in cast(list[Any], tasks) if isinstance(r, dict)] if isinstance(tasks, list) else []
    left: list[str] = []
    for row in rows:
        raw: Any = row.get("fields")
        fields = {str(k): str(v) for k, v in cast(dict[Any, Any], raw).items()} if isinstance(raw, dict) else {}
        task = json.dumps(str(row.get("task")), ensure_ascii=False)
        state = row_state(fields)
        if state is None:
            left.append(f"- {task}: no state")
            continue
        key, value = state
        word = state_word(value)
        if word in DONE_STATES:
            continue
        why = "live" if word is not None else f"no state word: {STATE_WORDS}"
        left.append(f"- {task}: {key}={json.dumps(value, ensure_ascii=False)} ({why})")
    cli.say(f"BOARD CHECK {wave}: {len(rows)} rows, {len(rows) - len(left)} done, {len(left)} not done")
    for line in left:
        cli.say(line)
    return 3 if left else 0


def cmd_board(cfg: Config, args: list[str]) -> int:
    if args[:1] == ["takeover"]:
        return cmd_takeover(cfg, args[1:])
    if args[:1] == ["check"]:
        return cmd_check(cfg, args[1:])
    if args[:1] == ["close"]:
        from ludics.fleetworker.closeout import cmd_close

        return cmd_close(cfg, args[1:])
    action, payload = payload_of(args)
    if action == "set":
        for line in warnings_of(cast(str, payload["task"]), cast(list[list[str]], payload["fields"])):
            err(line)
    raw = json.dumps(payload, separators=(",", ":"))
    if action == "show":
        script = prelude(cfg, cfg.anchor) + "shift 3\n" + store_command(raw)
        argv = ["BOARD", "x", "x", action, "x", PAYLOAD_ON_FD]
    else:
        check_identity(cfg)
        token = my_token(cfg)
        script = prelude(cfg, cfg.anchor) + LEASE_MUTATION + store_command(raw)
        argv = ["BOARD", token, cfg.lock_wait, action, coordinator_id(cfg), PAYLOAD_ON_FD]
    done = run_on(cfg, cfg.anchor, script, argv)
    if done.unreachable:
        cli.say(f"BOARD UNREACHABLE {cfg.anchor}")
        return 4
    return done.rc


def record_placement(cfg: Config, wave: str, worker: str, host: str, checkout: str) -> int:
    """Assign's idempotent placement union, performed inside the board writer's lease lock."""
    check_identity(cfg)
    raw = json.dumps({"wave": wave, "worker": worker, "host": host, "checkout": checkout})
    script = prelude(cfg, cfg.anchor) + LEASE_MUTATION + store_command(raw)
    done = run_on(cfg, cfg.anchor, script,
                  ["BOARD", my_token(cfg), cfg.lock_wait, "placement", coordinator_id(cfg), PAYLOAD_ON_FD],
                  stdout_to_stderr=True)
    return 4 if done.unreachable else done.rc
