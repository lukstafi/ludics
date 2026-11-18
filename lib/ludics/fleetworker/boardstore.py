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
        a board that exists, so a retried first write is safe. THE LAUNCH STAMP: a set that leaves
        the row's ``state`` with ``launched`` as its first word (``;:,.`` stripped, case ignored),
        on a row with no ``launched_at``, also writes ``launched_at``, this module's now (the
        ``updated_at`` stamp), at the row's end: every launch, ``wave launch``'s and a native
        coordinator's ``state=launched`` alike, is timed by one clock with no step of its own. A
        row keeps its first stamp (a finisher's relaunch is not a new launch time), and a set that
        names ``launched_at`` itself writes its own value. THE COUNTERS START AT ZERO: a set that
        creates a row also writes ``interventions=0`` and ``routine_answers=0`` after its own pairs
        (unless it names them), so a row that has the fields was measured from its start and a row
        without them (one made before ludics#1214) was not; a set on an existing row, ``--new-row``
        again included, keeps the counts.
  tally {"counter", "why", "wave", "task"} | {"counter", "why", "worker", "host", "done": [word, ...]}
        one more of a row's coordinator turns (ludics#1214; the classifier and its closed list are
        ``ludics.fleetworker.tally``'s, near side): ``counter`` is ``interventions`` or
        ``routine_answers``, and its value goes up by one under the same lease lock as set, in one
        publish, so two tallies never read one starting value. The value is a decimal count
        (``0`` or no leading zero), and a row without the key counts from 0; any other value refuses,
        nothing written. A row with neither counter (one made before ludics#1214, its turns until now
        uncounted) also gets ``counted_from``, the tally's now, so its counts never read as a whole
        task's. An ``interventions`` tally also appends one log line in the same replace,
        ``<task> interventions=<n>: <why>``; a ``routine_answers`` tally logs nothing. The row is
        named by ``wave`` and ``task`` (no row refuses, with the nearest task, as set does; no board
        refuses), or, for ``unstick``, which knows only a box and a worker, by ``worker`` and
        ``host``: every board under ``boards/`` (listed and read as ``scan`` lists and reads them, by
        one listing; a board that does not load, or is no regular file, is skipped) is searched for the rows whose ``worker`` field is ``worker``, whose
        ``agent_host`` is ``host``, whose ``transport`` is ``cli`` or absent (an unstick reaches only
        a CLI worker, so a native row of the same name is never charged with it) and whose state's
        first word (its ``state``, else its ``status``; ``;:,.`` stripped, case ignored) is none of
        ``done``. Exactly one is counted; none, or more than one, is ``BOARD TALLY NOTE
        ...; nothing counted`` on stdout, exit 0: a worker outside any wave is no refusal, and an
        ambiguous one is counted nowhere rather than on a guess.
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


COUNTERS = ("interventions", "routine_answers")  # tally's counters (the header)
COUNT = re.compile(r"0|[1-9][0-9]*")


def counter_ok(value: Any) -> str:
    if value not in COUNTERS:
        refuse(f"a tally's counter is one of {', '.join(COUNTERS)}, not {json.dumps(value)}")
    return cast(str, value)


def count(path: Path, doc: Doc, row: Doc, coordinator: str, payload: Doc) -> str:
    """``tally``'s write (the header): the row's counter one more, an intervention's log line, one
    publish; the acknowledgement it returns."""
    counter = counter_ok(payload.get("counter"))
    why = text_ok(payload.get("why"), "a tally's why")
    fields = cast(dict[str, str], row["fields"])
    old = fields.get(counter, "0")
    if not COUNT.fullmatch(old):
        refuse(f"the row of {json.dumps(row['task'])} holds {counter}={json.dumps(old)}, no count; nothing counted")
    now = now_utc().strftime(STAMP)
    if not any(key in fields for key in COUNTERS):
        fields["counted_from"] = now  # a row made before THE COUNTERS START AT ZERO: its counts are partial
    new = str(int(old) + 1)
    fields[counter] = new
    if counter == "interventions":
        line = f"{row['task']} interventions={new}: {why.strip() or '(no reason given)'}"
        cast(list[Doc], doc["log"]).append({"at": now, "by": coordinator, "text": line})
    row["updated_at"] = doc["updated_at"] = now
    publish(path, doc)
    return f"BOARD TALLY {doc['wave']}: {json.dumps(row['task'])} {counter}={new}"


def tally_by_worker(root: str, coordinator: str, payload: Doc) -> None:
    """``tally`` by ``worker`` and ``host`` (the header): the one row not done across every board."""
    counter_ok(payload.get("counter"))
    worker = text_ok(payload.get("worker"), "worker")
    host = text_ok(payload.get("host"), "host")
    done_raw: Any = payload.get("done")
    if not isinstance(done_raw, list) or not all(isinstance(w, str) for w in cast(list[Any], done_raw)):
        refuse("a tally by worker names its done words, a list of text")
    done = {w.lower() for w in cast(list[str], done_raw)}
    if not worker or not host:
        refuse("a tally by worker names a worker and a host")
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
            if (fields.get("worker") == worker and fields.get("agent_host") == host and word not in done
                    and fields.get("transport", "cli") == "cli"):
                found.append((path, doc, row))
    who = f"worker {json.dumps(worker)} on {json.dumps(host)}"
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
    if action not in ("set", "note", "log"):
        refuse(f"unknown action {action}")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if doc is None:
        if action == "log" or payload.get("create") is not True:
            refuse(f"no board for wave {wave} on the anchor (start it with set or note --create)")
        doc = cast(Doc, {"board": 1, "wave": wave, "created_at": now, "created_by": coordinator,
                         "updated_at": now, "notes": {}, "tasks": [], "log": []})
    match action:
        case "set":
            task = task_ok(payload.get("task"))
            pairs = fields_ok(payload.get("fields"))
            tasks = cast(list[Doc], doc["tasks"])
            row: Doc | None = next((entry for entry in tasks if entry["task"] == task), None)
            if row is None:
                if payload.get("new_row") is not True:
                    near = difflib.get_close_matches(task, [cast(str, entry["task"]) for entry in tasks], n=1)
                    hint = f"; the nearest is {json.dumps(near[0])}" if near else ""
                    refuse(f"no task {json.dumps(task)} on the board of {wave}{hint} (a new row takes set --new-row)")
                row = {"task": task, "fields": {}, "updated_at": now}
                tasks.append(row)
                created = True
            else:
                created = False
            fields = cast(dict[str, str], row["fields"])
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
            said = f"BOARD SET {wave}: {json.dumps(task)} " + " ".join(key for key, _ in pairs)
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
