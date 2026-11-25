"""Anchor-side wave boards (ludics-lite#619). Invoked by fleet-worker's ``board`` verb.

A board was a markdown file the coordinator edited with ``sed`` substitutions on table rows, which
broke on cell text holding ``#``, ``(``, ``)`` or ``/`` (OCANNL wave-20261014, three times). Now the
board is one JSON document per wave, ``<state root>/boards/<wave>.json``, and the markdown is a view
rendered from it: no cell text is ever a pattern, a delimiter or a shell word anywhere on its way in.

What a board is, and is not (the boundary every rule below is drawn against): a coordinator-only,
lease-gated, best-effort record of a wave, written in the coordinator's own words through this
verb. It is not a registry, a lock or a verdict source: nothing gates on it. So its durability is
that of one fsynced file replaced atomically -- a power loss may lose the latest write, never leave a
partial board -- with no directory sync. Its writer is the coordinator, and its recovery is a
re-read: a failed or interrupted write may or may not have landed (an acknowledgement lost after
the replace, a connection dropped), so before retrying one the coordinator re-reads the board with
``board show``. There is no outcome-unknown exit: 0 is written, anything else is re-read. Its
inputs are what the verb writes; a file edited by hand is read only as far as ``validate`` checks
its shape.

How it runs, as the execution registry runs (``registry.py``'s header): this module is SHIPPED.
``fleet-worker.sh board`` sends its source to the anchor, where a Python >= 3.12 runs it from stdin,
the writers inside the lease lock after the lease check (``lease.LEASE_MUTATION``), ``show`` with no
lock and no lease. So it imports nothing from the ``ludics`` package, and its argv is the contract:

Argv: <state root> <action> <coordinator> <json payload>

The payload word `-` says the payload is on file descriptor 3 (ludics-lite#636), one JSON string,
as ``registry.py``'s header states it for the registry; any other word is the payload itself.

  set   {"wave", "create", "new_row", "task", "fields": [[key, value], ...]}   a task's row: each key
        set, in order (a new key joins the row's end). A task with no row yet refuses unless
        ``new_row`` is true, when it joins the table's end (#1114: a task typed wrong, ``2032`` for
        ``t2032``, made an empty second row each time); the refusal names the nearest task the
        board has. ``new_row`` on a task that has its row is no refusal, as ``create`` is none on
        a board that exists.
        A write of ``planner`` or ``planner_effort`` takes the existing paired row's
        ``plan_dir`` as a guard: give the same value in the write. Changing the directory
        or setting a mode other than ``paired`` or ``paired+critique`` clears the planner fields.
        THE LAUNCH STAMP: a write that leaves the row's ``state`` with ``launched`` as its first
        word (``;:,.`` stripped, case ignored) adds ``launched_at`` if the row has no stamp. The
        stamp is the store's clock (the same as ``updated_at``), and only a set naming
        ``launched_at`` can replace it.
        THE RELAUNCH COUNT (ludics#1236; the decision is ``ludics.fleetworker.tally``'s header):
        for compatibility, a set naming a ``launched`` state on a previously stamped row still
        counts a relaunch. A set that supplies its own ``relaunches`` writes that value directly.
        A set on the same CLI worker's row leaves counting to ``launch --replace``: the transport
        is ``cli`` or absent both times and ``worker`` and ``agent_host`` match as written.
        THE COUNTERS START AT ZERO: a set that creates a row also writes ``interventions=0``,
        ``routine_answers=0`` and ``relaunches=0`` after its own pairs (unless it names them), so a
        row that has the fields was measured from its start and a row without them (one made before
        ludics#1214, or for ``relaunches`` before ludics#1236) was not; a set on an existing row,
        ``--new-row`` again included, keeps the counts.
  spawned {"wave", "task", "agent", "transport", optional "model", optional "launch_id"} records the
        returned runtime identity on a prepared row (ludics#1264, ludics#1294). The runtime facts
        are nonblank text. An omitted model preserves the recorded one. It sets ``state=launched``
        and uses THE LAUNCH STAMP above. If ``launched_at`` was already present, it counts one
        relaunch for any transport. Both writers publish the row, counter and tally log together
        and acknowledge a relaunch with a ``BOARD TALLY`` line after the write acknowledgement. An
        invalid counter refuses the whole write.
        THE LAUNCH-ATTEMPT IDENTITY (ludics#1294; shared with ``wave launch``, ludics#1290): an
        optional caller-chosen opaque identifier matching ``LAUNCH_ID`` (same regex as ``WAVE`` and
        ``takeover.REQUEST_ID``: ``[A-Za-z0-9][A-Za-z0-9._-]*``, validated by ``launch_id_ok``; CLI
        flag ``--launch-id <id>``, payload key and row field ``launch_id``). The wave's recipe is
        ``<wave>-<task-slug>-<n>`` (for example ``w1123-t1294-1``, replacing characters outside
        ``[A-Za-z0-9._-]`` in task names such as ``ll#1``, where ``<n>`` is the 1-based attempt
        number chosen before spawning and reused on every retry of that attempt). ``launch_id`` is
        owned by ``spawned`` and refused by ``set``. When ``launch_id`` is supplied, ``spawned``
        writes ``fields["launch_id"]`` and records the attempt's runtime facts (``agent``,
        ``transport``, optional ``model``) and exact acknowledgement ``said`` under
        ``row["spawns"][launch_id]`` in the same atomic publish. Replaying an ID already in
        ``row["spawns"]`` with matching runtime facts is a no-op (nothing written, ``relaunches``
        and ``updated_at`` untouched, any later row state preserved) that prints the original
        ``said``; replaying it with different runtime facts refuses, nothing written. A distinct
        ``launch_id`` (even under the same ``agent``) counts a new spawn and updates
        ``fields["launch_id"]``. An unkeyed ``spawned`` or a legacy ``set`` relaunch behaves as
        before while clearing any stale ``fields["launch_id"]`` and keeping ``row["spawns"]``, and
        an unkeyed ``spawned`` still requires a re-read with ``show`` before retrying.
  tally {"counter", "why", "wave", "task", optional "turn_id", optional "message_sha256"} | {"counter", "why", "worker", "hosts": [box, ...], "done": [word, ...]}
        one more of a row's coordinator turns or relaunches (ludics#1214, ludics#1236, ludics#1342; the
        classifier and its closed list are ``ludics.fleetworker.tally``'s, near side): ``counter``
        is ``interventions``, ``routine_answers`` or ``relaunches``, and its value goes up by one
        under the same lease lock as set, in one publish, so two tallies never read one starting
        value. The value is a decimal count (``0`` or no leading zero), and a row without the key
        counts from 0; any other value refuses, nothing written. A row with none of the counters
        (one made before ludics#1214, its turns until now uncounted) also gets ``counted_from``,
        the tally's now, so its counts never read as a whole task's; a row with the others but
        without this one (``relaunches`` on a row made before ludics#1236) gets ``<counter>_from``
        instead. An ``interventions`` or ``relaunches`` tally also appends one log line in the same
        replace, ``<task> <counter>=<n>: <why>``; a ``routine_answers`` tally logs nothing. The row is
        named by ``wave`` and ``task`` (no row refuses, with the nearest task, as set does; no board
        refuses).
        THE TURN IDENTITY (ludics#1342): an optional caller-chosen opaque identifier matching
        ``TURN_ID`` (same regex as ``WAVE`` and ``LAUNCH_ID``: ``[A-Za-z0-9][A-Za-z0-9._-]*``,
        validated by ``turn_id_ok``; CLI flag ``--turn-id <id>``, payload key ``turn_id``). The
        wave's recipe is ``<wave>-<task-slug>-<n>`` (for example ``w1125-t1342-1``, replacing
        characters outside ``[A-Za-z0-9._-]`` in task names such as ``ll#1``, where ``<n>`` is the
        1-based message/turn number chosen before sending and reused on every retry of that turn).
        When ``turn_id`` is supplied, ``tally`` records the turn's facts (``counter``, ``why``,
        optional 64-hex ``message_sha256``) and exact acknowledgement ``said`` under
        ``row["tallies"][turn_id]`` in the same atomic publish. Replaying an ID already in
        ``row["tallies"]`` with matching facts is a no-op (nothing written, counter, log and
        ``updated_at`` untouched, any later row state preserved) that prints the original ``said``;
        replaying it with different facts (including differing ``counter``, ``why``, or
        ``message_sha256``, or presence/absence of ``message_sha256``) refuses, nothing written. A
        distinct ``turn_id`` counts one more, and an unkeyed ``tally`` behaves as before while
        keeping ``row["tallies"]`` and still requires a re-read with ``show`` before retrying.
        Recovery boundary: ``turn_id`` (and ``message_sha256``, which requires ``turn_id``) is
        accepted only on explicit ``wave``/``task`` payloads, never on worker-addressed tallies
        whose row lookup follows the currently active row. ``board tally`` hashes the raw message
        bytes into ``message_sha256`` when ``--turn-id`` is passed so two different messages
        sharing a first line cannot silently collide under one ID; direct store callers without
        ``message_sha256`` match on ``counter`` and ``why`` alone.
        ``unstick`` and ``launch --replace`` know only a box and a worker, so they name
        ``worker`` and ``hosts`` (every spelling the near side knows: the fleet name and ``local``
        for this box, since a wave file may name either and prep writes it as given). The store
        uses ``scan``'s one listing of ``boards/`` and skips boards that fail to load or are not
        regular files. A matching row has the given ``worker``, an ``agent_host`` in ``hosts``, and
        ``transport`` ``cli`` or absent, since both verbs reach only CLI workers. Its state's first
        word (its ``state``, else its ``status``, with ``;:,.`` stripped and case ignored) is outside
        ``done``. Exactly one match is counted. Zero or multiple matches print
        ``BOARD TALLY NOTE ...; nothing counted`` on stdout and exit 0.
  placement {"wave", "worker", "host", "checkout"}                internal to execution assign:
        union the host and host:checkout into exec_hosts and farside on the unique worker row,
        under the same lease lock as set. With the lease held, no board or no matching row is a no-op
        (assign also
        serves work without a wave board); ambiguous worker rows refuse. Existing words retain
        their order, duplicates and the placeholder none disappear. exec_hosts accepts commas
        or whitespace and is written comma-separated; farside is whitespace-separated, as
        farside-close reads it. A new host/checkout containing whitespace, or a host containing
        a colon, refuses before either field changes: it cannot fit one cleanup word.
        No row or board is created.
  forget {"wave", "task", "worker", "state"}                     internal to ``wave unprep``
        (waveunprep.py): remove the task's row, a compare-and-delete under the same lease lock as
        set, only while its ``state`` and ``worker`` fields are the given ones; any other row
        refuses, nothing written. No board or no row is a no-op (a retried removal whose first
        acknowledgement was lost). No other row, note or log line changes.
  note  {"wave", "create", "fields": [[key, value], ...]}           the wave's own facts (coordinator,
        scope, base, ...), shown above the table
  log   {"wave", "text"}                                            one line appended to the log,
        stamped with the time and the coordinator; nothing edits or removes a log line, and it
        never starts a board (an append is not idempotent: a retried first write must be)
  show  {"wave", "json"}                                            the markdown view, or the document
  scan  {"since_hours"}                                             every board, for ``status --json``
        (ludics#1165): no lock and no lease, as ``show``. It lists ``<root>/boards/`` once, keeps
        each entry named ``<wave>.json`` with the wave in the grammar below (anything else there --
        the writers' ``.board-`` temporaries included -- is skipped, not reported), and ``load``s
        each that is a regular file (a FIFO would block the scan): one that is not, does not
        validate or cannot be read is ``{"wave", "why"}`` under ``refused``, and the scan goes on. ``since_hours`` (a positive finite number, or null for
        every board) keeps a board whose ``updated_at`` is at or after this anchor's now less that
        many hours -- the clock that stamped it -- and refuses one whose ``updated_at`` is not this
        module's stamp (``%Y-%m-%dT%H:%M:%SZ``). No ``boards`` directory is no boards; a root or a
        ``boards`` that is no directory refuses. It prints one line, ``{"boards": [<document>...],
        "refused": [...]}``, the boards in name order. The payload names no wave.

What it accepts, fail-closed (anything else refuses, ``BOARD REFUSED: <why>`` on stderr, exit 1):
a wave is ``[A-Za-z0-9][A-Za-z0-9._-]*`` (it names a file); a key is ``[A-Za-z][A-Za-z0-9_-]*``; a
task is nonempty text with no control character (Unicode category Cc) and no line or paragraph
separator (Zl, Zp), not starting with ``-``; a value or a log line is any text that is valid UTF-8,
newlines included. ``set`` or ``note`` on a wave with no board refuses unless ``create`` is true;
``create`` on an existing board is no refusal, so a retried first write is safe. ``log`` refuses a
wave with no board.

"No board" is a fact, not a sentence (#1047's follow-up): ``show`` of a wave with no board refuses
with exit NO_BOARD_EXIT (5), its line ``BOARD REFUSED: no board for wave <wave> on the anchor`` on
stderr for a person, and a reader (``takeover.board_status``) tests the exit, never the text. The
boundary of that exit, an allowlist: the state root is a directory and its ``boards/<wave>.json``
does not exist (``lstat`` says ENOENT: no file, no link, the ``boards`` directory absent with it).
Everything else stays exit 1 -- a root that is no directory, a ``boards`` that is a file, a path
that cannot be looked up or read, a dangling link, a board that is no board -- and so does a
writer's no-board refusal, which carries its hint. No other status is 5 on the far side's way
back: its shell exits 1 (no Python) or 255 (ssh), Python 1 or 2, a signal 128+.
A board file that does not parse as a board is refused, never overwritten. Every write is exactly
one ``os.replace`` of the whole document, so a reader without the lock sees the old board or the
new one, never a part.

The markdown view, and its boundary: the JSON document is the board, and the view is for reading.
Everywhere in it, a line break -- each one ``str.splitlines`` breaks at (``\\r\\n``, ``\\n``, ``\\r``,
``\\v``, ``\\f``, U+001C-U+001E, U+0085, U+2028, U+2029) -- is written ``<br>``, and any other
control character but the tab is written U+FFFD, so no text can end a row or a bullet. In a cell,
``|`` is written ``\\|`` with the backslashes just before it doubled, so the pipe stays escaped
whatever backslashes precede it (GFM's cell scanner reads ``\\\\`` as one escaped backslash); inside
a code span such a doubled backslash shows doubled. Nothing else is escaped, so text that is itself
markdown (backticks, links, emphasis) renders as markdown. Columns are the keys in the order the
rows first name them.
"""
import difflib
import json
import math
import os
import re
import stat
import sys
import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, NoReturn, cast

type Doc = dict[str, Any]

WAVE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
KEY = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
PLANNER_KEYS = ("planner", "planner_effort")
# THE LAUNCH-ATTEMPT IDENTITY (the header): the one launch-attempt ID grammar shared by
# ``board spawned`` (#1294) and ``wave launch`` (#1290), sharing WAVE's token grammar.
LAUNCH_ID = WAVE
SPAWN_FACT_KEYS = ("agent", "transport", "model")
SPAWN_RECORD_REQUIRED = frozenset({"agent", "transport", "said"})
SPAWN_RECORD_ALLOWED = frozenset({"agent", "transport", "model", "said"})
# THE TURN IDENTITY (the header): the one turn ID grammar for ``board tally`` (#1342), sharing
# WAVE's and LAUNCH_ID's token grammar.
TURN_ID = WAVE
SHA256 = re.compile(r"[0-9a-f]{64}")
TALLY_FACT_KEYS = ("counter", "why", "message_sha256")
TALLY_RECORD_REQUIRED = frozenset({"counter", "why", "said"})
TALLY_RECORD_ALLOWED = frozenset({"counter", "why", "message_sha256", "said"})
# What may not appear in a task name, which is a table row's first cell: a control character, or a
# character that breaks a line (U+0085 is Cc; U+2028 and U+2029 are Zl and Zp).
NOT_IN_TASK = frozenset({"Cc", "Zl", "Zp"})


NO_BOARD_EXIT = 5


class NoBoard(ValueError):
    """``show`` of a wave whose board does not exist: exit NO_BOARD_EXIT (the header)."""


def refuse(message: str) -> NoReturn:
    raise ValueError(message)


def text_ok(value: Any, what: str) -> str:
    """Any string that is valid UTF-8 (a lone surrogate is a byte that was not)."""
    if not isinstance(value, str):
        refuse(f"{what} must be a string")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        refuse(f"{what} is not valid UTF-8 text")
    return value


def wave_ok(value: Any) -> str:
    if not isinstance(value, str) or not WAVE.fullmatch(value):
        refuse("a wave must be [A-Za-z0-9][A-Za-z0-9._-]*")
    return value


def key_ok(value: Any) -> str:
    if not isinstance(value, str) or not KEY.fullmatch(value):
        refuse(f"a key must be [A-Za-z][A-Za-z0-9_-]*: {json.dumps(value)}")
    return value


def launch_id_ok(value: Any) -> str:
    if not isinstance(value, str) or not LAUNCH_ID.fullmatch(value):
        refuse(f"a launch_id must be {LAUNCH_ID.pattern}")
    return value


def turn_id_ok(value: Any) -> str:
    if not isinstance(value, str) or not TURN_ID.fullmatch(value):
        refuse(f"a turn_id must be {TURN_ID.pattern}")
    return value


def sha256_ok(value: Any, what: str) -> str:
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        refuse(f"{what} must be 64 lowercase hex digits")
    return value


def task_ok(value: Any) -> str:
    task = text_ok(value, "a task")
    if not task or task.startswith("-") or any(unicodedata.category(c) in NOT_IN_TASK for c in task):
        refuse("a task must be nonempty, with no control character or line separator, and not start with '-'")
    return task


def fields_ok(value: Any) -> list[tuple[str, str]]:
    if not isinstance(value, list) or not value:
        refuse("fields must be a nonempty list of [key, value] pairs")
    pairs: list[tuple[str, str]] = []
    for pair in cast(list[Any], value):
        if not isinstance(pair, list) or len(cast(list[Any], pair)) != 2:
            refuse("fields must be a nonempty list of [key, value] pairs")
        key, text = cast(list[Any], pair)
        pairs.append((key_ok(key), text_ok(text, "a value")))
    return pairs


def spawn_fields(payload: Doc) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for key in SPAWN_FACT_KEYS:
        if key == "model" and key not in payload:
            continue
        value = text_ok(payload.get(key), key)
        if not value.strip():
            refuse(f"{key} must not be blank")
        pairs.append((key, value))
    if "launch_id" in payload:
        pairs.append(("launch_id", launch_id_ok(payload["launch_id"])))
    return [*pairs, ("state", "launched")]


def spawns_ok(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict):
        refuse("spawns must be an object")
    out: dict[str, dict[str, str]] = {}
    for lid, raw in cast(dict[Any, Any], value).items():
        launch_id = launch_id_ok(lid)
        if not isinstance(raw, dict):
            refuse(f"spawn record {json.dumps(launch_id)} must be an object")
        entry = cast(dict[Any, Any], raw)
        keys = set(entry)
        if not SPAWN_RECORD_REQUIRED.issubset(keys) or not keys.issubset(SPAWN_RECORD_ALLOWED):
            refuse(f"spawn record {json.dumps(launch_id)} must hold agent, transport, said and optional model")
        record: dict[str, str] = {}
        for key in SPAWN_FACT_KEYS:
            if key in entry:
                text = text_ok(entry[key], f"spawn {key}")
                if not text.strip():
                    refuse(f"spawn {key} must not be blank")
                record[key] = text
        said = text_ok(entry["said"], "spawn said")
        if not said.strip():
            refuse("spawn said must not be blank")
        record["said"] = said
        out[launch_id] = record
    return out


def tallies_ok(value: Any) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict):
        refuse("tallies must be an object")
    out: dict[str, dict[str, str]] = {}
    for tid, raw in cast(dict[Any, Any], value).items():
        turn_id = turn_id_ok(tid)
        if not isinstance(raw, dict):
            refuse(f"tally record {json.dumps(turn_id)} must be an object")
        entry = cast(dict[Any, Any], raw)
        keys = set(entry)
        if not TALLY_RECORD_REQUIRED.issubset(keys) or not keys.issubset(TALLY_RECORD_ALLOWED):
            refuse(f"tally record {json.dumps(turn_id)} must hold counter, why, said and optional message_sha256")
        record: dict[str, str] = {
            "counter": counter_ok(entry["counter"]),
            "why": text_ok(entry["why"], "tally why"),
        }
        if "message_sha256" in entry:
            record["message_sha256"] = sha256_ok(entry["message_sha256"], "tally message_sha256")
        said = text_ok(entry["said"], "tally said")
        if not said.strip():
            refuse("tally said must not be blank")
        record["said"] = said
        out[turn_id] = record
    return out


def string_map(value: Any, what: str) -> dict[str, str]:
    if not isinstance(value, dict):
        refuse(f"{what} must be an object")
    out: dict[str, str] = {}
    for key, text in cast(dict[Any, Any], value).items():
        out[key_ok(key)] = text_ok(text, "a value")
    return out


def validate(data: Any, wave: str, path: Path) -> Doc:
    """The document as this module writes it, or a refusal naming the file."""
    try:
        if not isinstance(data, dict):
            refuse("not an object")
        doc = cast(Doc, data)
        if type(doc.get("board")) is not int or doc.get("board") != 1 or doc.get("wave") != wave:
            refuse(f"not board version 1 of wave {wave}")
        for key in ("created_at", "created_by", "updated_at"):
            text_ok(doc.get(key), key)
        string_map(doc.get("notes"), "notes")
        tasks: Any = doc.get("tasks")
        if not isinstance(tasks, list):
            refuse("tasks must be a list")
        seen: set[str] = set()
        for entry in cast(list[Any], tasks):
            if not isinstance(entry, dict):
                refuse("a task entry must be an object")
            row = cast(Doc, entry)
            name = task_ok(row.get("task"))
            if name in seen:
                refuse(f"task {json.dumps(name)} appears twice")
            seen.add(name)
            string_map(row.get("fields"), "fields")
            text_ok(row.get("updated_at"), "updated_at")
            if "spawns" in row:
                spawns_ok(row["spawns"])
            if "tallies" in row:
                tallies_ok(row["tallies"])
        log: Any = doc.get("log")
        if not isinstance(log, list):
            refuse("log must be a list")
        for entry in cast(list[Any], log):
            if not isinstance(entry, dict):
                refuse("a log entry must be an object")
            line = cast(Doc, entry)
            for key in ("at", "by", "text"):
                text_ok(line.get(key), f"log {key}")
        return doc
    except ValueError as exc:
        refuse(f"{path} is not a valid board ({exc}); nothing written")


def load(path: Path, wave: str) -> Doc | None:
    """The board at ``path``, or None when nothing is there (``lstat``'s ENOENT, the header's
    boundary); any other failure to look it up or read it raises (a refusal, exit 1)."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        refuse(f"{path} is not a valid board ({exc}); nothing written")
    return validate(data, wave, path)


def publish(path: Path, doc: Doc) -> None:
    """Write the whole document atomically: one fsynced file, then exactly one ``os.replace``, the last
    thing that can fail (the header: best effort, no directory sync)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".board-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(doc, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


# The view's boundary (the header): the line breaks str.splitlines breaks at.
LINE_BREAK = re.compile("\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]")
PIPE = re.compile(r"(\\*)\|")


def cell(text: str) -> str:
    """A table cell's markdown: one line, its pipes escaped whatever backslashes precede them."""
    return PIPE.sub(lambda m: m.group(1) * 2 + "\\|", lines(text))


def lines(text: str) -> str:
    """Text as one markdown line: line breaks as ``<br>``, other control characters as U+FFFD."""
    one = LINE_BREAK.sub("<br>", text)
    return "".join("\ufffd" if c != "\t" and unicodedata.category(c) == "Cc" else c for c in one)


def render(doc: Doc) -> str:
    out = [f"# Board: {doc['wave']}", ""]
    notes = cast(dict[str, str], doc["notes"])
    for key, value in notes.items():
        out.append(f"- {key}: {lines(value)}")
    if notes:
        out.append("")
    tasks = cast(list[Doc], doc["tasks"])
    columns: list[str] = []
    for row in tasks:
        for key in cast(dict[str, str], row["fields"]):
            if key not in columns:
                columns.append(key)
    if tasks:
        out.append("| " + " | ".join(["task", *columns]) + " |")
        out.append("|" + " --- |" * (len(columns) + 1))
        for row in tasks:
            fields = cast(dict[str, str], row["fields"])
            cells = [cell(row["task"]), *(cell(fields.get(key, "")) for key in columns)]
            out.append("| " + " | ".join(cells) + " |")
    else:
        out.append("(no tasks)")
    out.extend(["", "## Log"])
    for line in cast(list[Doc], doc["log"]):
        out.append(f"- {line['at']} {lines(line['text'])}")
    return "\n".join(out) + "\n"


def payload_word(word: str) -> str:
    """The JSON payload argv names: the word itself, or for ``-`` the one JSON string on fd 3 (the
    header). registry.py carries the same reader: each shipped module is self-contained."""
    if word != "-":
        return word
    try:
        with open(3, "rb") as stream:
            data = stream.read()
    except OSError as exc:
        raise ValueError(f"payload `-` names file descriptor 3, which cannot be read ({exc.strerror})") from None
    text: Any = json.loads(data.decode("ascii"))
    if not isinstance(text, str):
        raise ValueError("the payload on file descriptor 3 must be one JSON string")
    return text


def placement_word(host: str, checkout: str) -> str:
    """One cleanup word; never let split() reinterpret a path's prefix as another worktree."""
    if not host or ":" in host or any(c.isspace() for c in host + checkout):
        refuse("host/checkout cannot fit one whitespace-separated farside word")
    return f"{host}:{checkout}"


STAMP = "%Y-%m-%dT%H:%M:%SZ"


def launched(state: str) -> bool:
    """THE LAUNCH STAMP's test (the header): the state's first word is ``launched``."""
    words = state.split()
    return bool(words) and words[0].rstrip(";:,.").lower() == "launched"


COUNTERS = ("interventions", "routine_answers", "relaunches")  # tally's counters (the header)
LOGGED = ("interventions", "relaunches")  # the counters whose every count is a log line too
COUNT = re.compile(r"0|[1-9][0-9]*")


def counter_ok(value: Any) -> str:
    if value not in COUNTERS:
        refuse(f"a tally's counter is one of {', '.join(COUNTERS)}, not {json.dumps(value)}")
    return cast(str, value)


def cli_row(fields: dict[str, str]) -> bool:
    """A CLI worker's row: ``transport`` ``cli`` or absent (the header's tally by worker, and THE
    RELAUNCH COUNT's exception)."""
    return fields.get("transport", "cli") == "cli"


def bump(doc: Doc, row: Doc, counter: str, why: str, coordinator: str, now: str) -> str:
    """One more of the row's ``counter`` (the header's tally), written into ``doc`` and not yet
    published: the acknowledgement line, or a refusal for a value that is no count."""
    fields = cast(dict[str, str], row["fields"])
    old = fields.get(counter, "0")
    if not COUNT.fullmatch(old):
        refuse(f"the row of {json.dumps(row['task'])} holds {counter}={json.dumps(old)}, no count; nothing counted")
    if not any(key in fields for key in COUNTERS):
        fields["counted_from"] = now  # a row made before THE COUNTERS START AT ZERO: its counts are partial
    elif counter not in fields:
        fields[f"{counter}_from"] = now  # a row made before this counter was: its count of it is partial
    new = str(int(old) + 1)
    fields[counter] = new
    if counter in LOGGED:
        line = f"{row['task']} {counter}={new}: {why.strip() or '(no reason given)'}"
        cast(list[Doc], doc["log"]).append({"at": now, "by": coordinator, "text": line})
    row["updated_at"] = doc["updated_at"] = now
    return f"BOARD TALLY {doc['wave']}: {json.dumps(row['task'])} {counter}={new}"


def tally_request(payload: Doc) -> tuple[str, str, str | None, dict[str, str]]:
    """Validate a ``tally`` payload's counter, reason, optional turn_id and optional message_sha256."""
    counter = counter_ok(payload.get("counter"))
    why = text_ok(payload.get("why"), "a tally's why")
    turn_id = turn_id_ok(payload["turn_id"]) if "turn_id" in payload else None
    facts: dict[str, str] = {"counter": counter, "why": why}
    if "message_sha256" in payload:
        if turn_id is None:
            refuse("a tally's message_sha256 requires turn_id")
        facts["message_sha256"] = sha256_ok(payload["message_sha256"], "a tally's message_sha256")
    return counter, why, turn_id, facts


def count(path: Path, doc: Doc, row: Doc, coordinator: str, payload: Doc) -> str:
    """``tally``'s write (the header): the row's counter one more, its log line, optional turn_id
    record, one publish; or a no-op returning the original acknowledgement on a matching replay."""
    counter, why, turn_id, facts = tally_request(payload)
    if turn_id is not None:
        tallies = cast(dict[str, dict[str, str]], row.get("tallies") or {})
        if turn_id in tallies:
            recorded = tallies[turn_id]
            recorded_facts = {key: recorded[key] for key in TALLY_FACT_KEYS if key in recorded}
            if recorded_facts != facts:
                refuse(
                    f"turn_id {json.dumps(turn_id)} is already recorded on {json.dumps(row['task'])}"
                    " with different tally facts; nothing written"
                )
            return recorded["said"]
    said = bump(doc, row, counter, why, coordinator, now_utc().strftime(STAMP))
    if turn_id is not None:
        tallies = cast(dict[str, dict[str, str]], row.setdefault("tallies", {}))
        tallies[turn_id] = {**facts, "said": said}
    publish(path, doc)
    return said


def set_relaunched(before: dict[str, str], after: dict[str, str], pairs: list[tuple[str, str]]) -> bool:
    """The legacy set rule (THE RELAUNCH COUNT) after the first launch."""
    named = {key for key, _ in pairs}
    if "state" not in named or "relaunches" in named:
        return False
    if not launched(after.get("state", "")):
        return False
    same = all(before.get(key) == after.get(key) for key in ("worker", "agent_host"))
    return not (cli_row(before) and cli_row(after) and same)


def tally_by_worker(root: str, coordinator: str, payload: Doc) -> None:
    """``tally`` by ``worker`` and ``host`` (the header): the one row not done across every board."""
    if "turn_id" in payload or "message_sha256" in payload:
        refuse("turn_id requires an explicit wave and task")
    tally_request(payload)
    worker = text_ok(payload.get("worker"), "worker")
    hosts_raw: Any = payload.get("hosts")
    if not isinstance(hosts_raw, list) or not hosts_raw or not all(isinstance(h, str) and h for h in cast(list[Any], hosts_raw)):
        refuse("a tally by worker names its hosts, a nonempty list of text")
    hosts = [text_ok(h, "host") for h in cast(list[str], hosts_raw)]
    done_raw: Any = payload.get("done")
    if not isinstance(done_raw, list) or not all(isinstance(w, str) for w in cast(list[Any], done_raw)):
        refuse("a tally by worker names its done words, a list of text")
    done = {w.lower() for w in cast(list[str], done_raw)}
    if not worker:
        refuse("a tally by worker names a worker")
    found: list[tuple[Path, Doc, Doc]] = []
    for path, wave in board_files(root):
        try:
            doc = load_regular(path, wave)
        except (ValueError, OSError):
            continue  # a board that does not load holds no row this tally can count
        if doc is None:
            continue
        for row in cast(list[Doc], doc["tasks"]):
            fields = cast(dict[str, str], row["fields"])
            words = (fields["state"] if "state" in fields else fields.get("status", "")).split()
            word = words[0].rstrip(";:,.").lower() if words else ""
            if (fields.get("worker") == worker and fields.get("agent_host") in hosts and word not in done
                    and cli_row(fields)):
                found.append((path, doc, row))
    who = f"worker {json.dumps(worker)} on {' or '.join(json.dumps(h) for h in hosts)}"
    if not found:
        print(f"BOARD TALLY NOTE: no row of {who} that is not done, on any board; nothing counted")
        return
    if len(found) > 1:
        rows = ", ".join(f"{doc['wave']}/{row['task']}" for _, doc, row in found)
        print(f"BOARD TALLY NOTE: {who} names {len(found)} rows that are not done ({rows}); nothing counted")
        return
    path, doc, row = found[0]
    print(count(path, doc, row, coordinator, payload))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def board_files(root: str) -> list[tuple[Path, str]]:
    """Every ``<wave>.json`` under ``<root>/boards/`` as (path, wave), in name order: ``scan``'s listing
    (the header), which ``tally`` by worker reads too. Any other entry is skipped, not reported; no
    ``boards`` directory is no boards; a root or a ``boards`` that is no directory refuses."""
    if not Path(root).is_dir():
        refuse(f"the anchor state root {root} is not a directory")
    directory = Path(root) / "boards"
    try:
        os.lstat(directory)
    except FileNotFoundError:
        return []
    if not directory.is_dir():
        refuse(f"{directory} is not a directory")
    with os.scandir(directory) as entries:
        names = sorted(entry.name for entry in entries)
    return [(directory / name, wave) for name in names
            if (wave := name.removesuffix(".json")) != name and WAVE.fullmatch(wave)]


def load_regular(path: Path, wave: str) -> Doc | None:
    """``load``, of a regular file only (a link to one included, as ``load`` reads it): a FIFO or a
    device would block the read, and every board after it."""
    if not stat.S_ISREG(os.stat(path).st_mode):
        refuse(f"{path} is no regular file")
    return load(path, wave)


def scan(root: str, payload: Doc) -> None:
    """``scan`` (the header): every board under ``root``, one JSON line, with no lock."""
    since: Any = payload.get("since_hours")
    if since is not None and (type(since) not in (int, float) or not math.isfinite(since) or since <= 0):
        refuse("since_hours must be a positive finite number of hours, or null")
    files = board_files(root)
    cutoff: datetime | None = None
    if since is not None:
        try:
            cutoff = now_utc() - timedelta(hours=since)
        except OverflowError:
            cutoff = datetime.min.replace(tzinfo=timezone.utc)  # a window wider than the calendar: every board
    boards: list[Doc] = []
    refused: list[Doc] = []
    for path, wave in files:
        try:
            doc = load_regular(path, wave)
            if doc is None:
                continue  # removed between the listing and the read
            if cutoff is not None:
                try:
                    stamp = datetime.strptime(doc["updated_at"], STAMP).replace(tzinfo=timezone.utc)
                except ValueError:
                    refuse(f"its updated_at {json.dumps(doc['updated_at'])} is no {STAMP} stamp, so no window can place it")
                if stamp < cutoff:
                    continue
        except (ValueError, OSError) as exc:
            refused.append({"wave": wave, "why": str(exc)})
            continue
        boards.append(doc)
    sys.stdout.write(json.dumps({"boards": boards, "refused": refused}, ensure_ascii=False) + "\n")


def main(argv: list[str]) -> None:
    root, action, coordinator, word = argv[1:5]
    raw = payload_word(word)
    decoded: Any = json.loads(raw)
    if not isinstance(decoded, dict):
        refuse("the payload must be a JSON object")
    payload = cast(Doc, decoded)
    if action == "scan":
        scan(root, payload)
        return
    if action == "tally" and "wave" not in payload:
        tally_by_worker(root, coordinator, payload)
        return
    wave = wave_ok(payload.get("wave"))
    path = Path(root) / "boards" / f"{wave}.json"
    doc = load(path, wave)
    if action == "show":
        if doc is None:
            if not Path(root).is_dir():
                refuse(f"the anchor state root {root} is not a directory")
            raise NoBoard(f"no board for wave {wave} on the anchor")
        sys.stdout.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n" if payload.get("json") else render(doc))
        return
    if action == "placement":
        worker = text_ok(payload.get("worker"), "worker")
        host = text_ok(payload.get("host"), "host")
        checkout = text_ok(payload.get("checkout"), "checkout")
        rows = [row for row in cast(list[Doc], doc["tasks"]) if row["fields"].get("worker") == worker] if doc else []
        if len(rows) > 1:
            refuse(f"worker {json.dumps(worker)} names multiple rows; nothing written")
        if not rows:
            print(f"BOARD PLACEMENT NOTE {wave}: no row for worker {json.dumps(worker)}; nothing written")
            return
        cleanup_word = placement_word(host, checkout)
        row = rows[0]
        fields = cast(dict[str, str], row["fields"])
        for key, value, sep in (("exec_hosts", host, ","), ("farside", cleanup_word, " ")):
            old = fields.get(key, "")
            words = (old.replace(",", " ") if key == "exec_hosts" else old).split()
            fields[key] = sep.join(dict.fromkeys([*(w for w in words if w != "none"), value]))
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        assert doc is not None
        row["updated_at"] = doc["updated_at"] = now
        publish(path, doc)
        print(f"BOARD PLACEMENT {wave}: {json.dumps(worker)}")
        return
    if action == "forget":
        task = task_ok(payload.get("task"))
        worker = text_ok(payload.get("worker"), "worker")
        state = text_ok(payload.get("state"), "state")
        tasks = cast(list[Doc], doc["tasks"]) if doc else []
        found = next((entry for entry in tasks if entry["task"] == task), None)
        if found is None:
            print(f"BOARD FORGET {wave}: {json.dumps(task)} has no row; nothing written")
            return
        fields = cast(dict[str, str], found["fields"])
        if fields.get("state") != state or fields.get("worker") != worker:
            refuse(f"the row of {json.dumps(task)} is state={json.dumps(fields.get('state'))} worker={json.dumps(fields.get('worker'))},"
                   f" not state={json.dumps(state)} worker={json.dumps(worker)}; nothing written")
        assert doc is not None
        doc["tasks"] = [entry for entry in tasks if entry is not found]
        doc["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        publish(path, doc)
        print(f"BOARD FORGET {wave}: {json.dumps(task)}")
        return
    if action == "tally":
        if doc is None:
            refuse(f"no board for wave {wave} on the anchor")
        task = task_ok(payload.get("task"))
        tasks = cast(list[Doc], doc["tasks"])
        found = next((entry for entry in tasks if entry["task"] == task), None)
        if found is None:
            near = difflib.get_close_matches(task, [cast(str, entry["task"]) for entry in tasks], n=1)
            hint = f"; the nearest is {json.dumps(near[0])}" if near else ""
            refuse(f"no task {json.dumps(task)} on the board of {wave}{hint}; nothing counted")
        print(count(path, doc, found, coordinator, payload))
        return
    if action not in ("set", "spawned", "note", "log"):
        refuse(f"unknown action {action}")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if doc is None:
        if action not in ("set", "note") or payload.get("create") is not True:
            refuse(f"no board for wave {wave} on the anchor (start it with set or note --create)")
        doc = cast(Doc, {"board": 1, "wave": wave, "created_at": now, "created_by": coordinator,
                         "updated_at": now, "notes": {}, "tasks": [], "log": []})
    match action:
        case "set" | "spawned":
            task = task_ok(payload.get("task"))
            pairs = spawn_fields(payload) if action == "spawned" else fields_ok(payload.get("fields"))
            if action == "set" and any(key == "launch_id" for key, _ in pairs):
                refuse("launch_id is recorded by board spawned, not board set")
            tasks = cast(list[Doc], doc["tasks"])
            row: Doc | None = next((entry for entry in tasks if entry["task"] == task), None)
            if row is None:
                if action != "set" or payload.get("new_row") is not True:
                    near = difflib.get_close_matches(task, [cast(str, entry["task"]) for entry in tasks], n=1)
                    hint = f"; the nearest is {json.dumps(near[0])}" if near else ""
                    refuse(f"no task {json.dumps(task)} on the board of {wave}{hint} (a new row takes set --new-row)")
                row = {"task": task, "fields": {}, "updated_at": now}
                tasks.append(row)
                created = True
            else:
                created = False
            launch_id: str | None = None
            spawn_facts: dict[str, str] = {}
            if action == "spawned":
                spawn_facts = {key: value for key, value in pairs if key in SPAWN_FACT_KEYS}
                launch_id = next((value for key, value in pairs if key == "launch_id"), None)
                if launch_id is not None:
                    spawns = cast(dict[str, dict[str, str]], row.get("spawns") or {})
                    if launch_id in spawns:
                        recorded = spawns[launch_id]
                        recorded_facts = {key: recorded[key] for key in SPAWN_FACT_KEYS if key in recorded}
                        if recorded_facts != spawn_facts:
                            refuse(
                                f"launch_id {json.dumps(launch_id)} is already recorded on {json.dumps(task)}"
                                " with different spawn facts; nothing written"
                            )
                        print(recorded["said"])
                        return
            fields = cast(dict[str, str], row["fields"])
            before = None if created else dict(fields)
            if action == "set":
                changed = dict(pairs)
                paired = changed.get("planning", fields.get("planning")) in ("paired", "paired+critique")
                if any(key in changed for key in PLANNER_KEYS):
                    if not paired:
                        refuse(f"planner fields require a paired planning mode on {json.dumps(task)}")
                    plan_dir = changed.get("plan_dir")
                    if not plan_dir or plan_dir != fields.get("plan_dir"):
                        refuse(f"planner fields require the recorded plan_dir on {json.dumps(task)}"
                               f" (has {json.dumps(fields.get('plan_dir'))}, got {json.dumps(plan_dir)})")
                if (("planning" in changed and not paired)
                        or ("plan_dir" in changed and changed["plan_dir"] != fields.get("plan_dir"))):
                    for key in PLANNER_KEYS:
                        fields.pop(key, None)
            for key, value in pairs:
                fields[key] = value
            if created:
                for key in COUNTERS:
                    fields.setdefault(key, "0")  # THE COUNTERS START AT ZERO (the header)
            if "launched_at" not in fields and launched(fields.get("state", "")):
                fields["launched_at"] = now  # THE LAUNCH STAMP (the header)
            row["updated_at"] = now
            # ASCII whatever the task holds (json escapes it; wave and keys are ASCII by grammar), so
            # no stdout encoding can fail the acknowledgement.
            if action == "spawned":
                said = f"BOARD SPAWNED {wave}: {json.dumps(task)}"
                lid_note = f" launch_id={launch_id}" if launch_id is not None else ""
                reason = f"board spawned agent={json.dumps(fields['agent'], ensure_ascii=False)}{lid_note}"
            else:
                said = f"BOARD SET {wave}: {json.dumps(task)} " + " ".join(key for key, _ in pairs)
                reason = f"state={json.dumps(fields.get('state'), ensure_ascii=False)}"
            relaunching = False
            if before is not None and "launched_at" in before and (action == "spawned" or set_relaunched(before, fields, pairs)):
                relaunching = True
                why = f"{reason} on a row launched at {before['launched_at']}"
                said += "\n" + bump(doc, row, "relaunches", why, coordinator, now)
            if launch_id is None and (action == "spawned" or relaunching):
                # An unkeyed spawn or legacy set relaunch replaces the active launch, so drop any
                # prior launch_id from fields while retaining row["spawns"] for earlier replays.
                fields.pop("launch_id", None)
            if action == "spawned" and launch_id is not None:
                spawns = cast(dict[str, dict[str, str]], row.setdefault("spawns", {}))
                spawns[launch_id] = {**spawn_facts, "said": said}
        case "note":
            pairs = fields_ok(payload.get("fields"))
            notes = cast(dict[str, str], doc["notes"])
            for key, value in pairs:
                notes[key] = value
            said = f"BOARD NOTE {wave}: " + " ".join(key for key, _ in pairs)
        case _:
            text = text_ok(payload.get("text"), "a log line")
            if not text.strip():
                refuse("a log line must not be empty")
            log = cast(list[Doc], doc["log"])
            log.append({"at": now, "by": coordinator, "text": text})
            said = f"BOARD LOG {wave}: line {len(log)} at {now}"
    doc["updated_at"] = now
    publish(path, doc)
    print(said)


def run(argv: list[str]) -> int:
    """``main`` with the board's exit: any failure is one ``BOARD REFUSED: <why>`` line on stderr, exit
    1 (whether a failed write landed is a re-read's to say: the header), or NO_BOARD_EXIT for show's
    no board."""
    try:
        main(argv)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"BOARD REFUSED: {exc}", file=sys.stderr)
        return NO_BOARD_EXIT if isinstance(exc, NoBoard) else 1
    return 0


# A program (``python - <argv>`` on the anchor) or ``runpy.run_path``, never an import.
if __name__ in ("__main__", "<run_path>"):
    if (status := run(sys.argv)) != 0:
        sys.exit(status)
