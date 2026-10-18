"""``board``: the wave board on the anchor as structured data (ludics-lite#619).

The board is one JSON document per wave under FLEET_ANCHOR_STATE, kept by
``ludics.fleetworker.boardstore``, whose SOURCE travels to the anchor and runs there from stdin under a
Python >= 3.12 the far side finds, as the execution registry's does (``execution.registry_command``).
Its header is the contract: the document, what it accepts, and the markdown view's boundary.

  board set [--create] <wave> <task> <key=value>...   a task's row (lease)
  board note [--create] <wave> <key=value>...         the wave's own facts (lease)
  board log <wave> <text>...                          one appended log line, the words joined (lease)
  board show <wave> [--json]                          the markdown view, or the document (no lease)

The writers run inside the lease lock after the lease check (``lease.LEASE_MUTATION``), the lock and
check every halt and registry write takes; ``show`` takes neither, so anyone may read a board. Every
argument travels inside one JSON payload, ASCII-escaped, so no cell text is a shell word, a ``sed``
pattern or a delimiter on the near side, over ssh, or on the anchor. A ``key=value`` splits at its
FIRST ``=``: the value is everything after it, ``=`` included. ``--create`` is read only right after
``set`` or ``note``, so no value can be mistaken for it; ``log`` takes none and never starts a board,
since an append is not idempotent and a retried first write must be.
"""

import json

from ludics import cli
from ludics.fleetworker import boardstore
from ludics.fleetworker.config import Config
from ludics.fleetworker.farside import FLEET_PYTHON
from ludics.fleetworker.identity import check_identity, coordinator_id, die, my_token
from ludics.fleetworker.lease import LEASE_MUTATION
from ludics.fleetworker.transport import prelude, run_on

USAGE = (
    "board set [--create] <wave> <task> <key=value>... | board note [--create] <wave> <key=value>... | "
    "board log <wave> <text>... | board show <wave> [--json]"
)

FIND_PYTHON = (
    FLEET_PYTHON
    + 'py=$(fleet_python) || { echo "BOARD REFUSED: no Python >= 3.12 on $BOX to keep the board'
    + " (scripts/py's probe; install one, or name it in LUDICS_PY_CANDIDATES)\" >&2; exit 1; }\n"
)


def store_command() -> str:
    """The far side's last lines: the store's source as the program, its argv after it."""
    with open(boardstore.__file__, encoding="utf-8") as f:
        source = f.read()
    return FIND_PYTHON + "\"$py\" -X utf8 -P - \"$ANCHOR_STATE\" \"$@\" <<'FLEET_BOARD_PY'\n" + source + "\nFLEET_BOARD_PY\n"


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
        die(f"board: expected set, note, log or show ({USAGE})")
    create = bool(rest) and rest[0] == "--create"
    if create and action == "log":
        die(f"board log: takes no --create; start the board with set or note --create ({USAGE})")
    if create:
        rest = rest[1:]
    if not rest:
        die(f"board {action}: expected <wave> ({USAGE})")
    payload: dict[str, object] = {"wave": rest[0]}
    if action != "log":
        payload["create"] = create
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


def cmd_board(cfg: Config, args: list[str]) -> int:
    action, payload = payload_of(args)
    raw = json.dumps(payload, separators=(",", ":"))
    if action == "show":
        script = prelude(cfg, cfg.anchor) + "shift 3\n" + store_command()
        argv = ["BOARD", "x", "x", action, "x", raw]
    else:
        check_identity(cfg)
        token = my_token(cfg)
        script = prelude(cfg, cfg.anchor) + LEASE_MUTATION + store_command()
        argv = ["BOARD", token, cfg.lock_wait, action, coordinator_id(cfg), raw]
    done = run_on(cfg, cfg.anchor, script, argv)
    if done.unreachable:
        cli.say(f"BOARD UNREACHABLE {cfg.anchor}")
        return 4
    return done.rc
