"""Anchor-side wave boards (ludics-lite#619). Invoked by fleet-worker's ``board`` verb.

A board was a markdown file the coordinator edited with ``sed`` substitutions on table rows, which
broke on cell text holding ``#``, ``(``, ``)`` or ``/`` (OCANNL wave-20261014, three times). Now the
board is one JSON document per wave, ``<state root>/boards/<wave>.json``, and the markdown is a view
rendered from it: no cell text is ever a pattern, a delimiter or a shell word anywhere on its way in.

What a board is, and is not (the boundary every rule below is drawn against): a coordinator-only,
lease-gated, best-effort record of a wave, written in the coordinator's own words through this
verb. It is not a registry, a lock or a verdict source: nothing gates on it. So its durability is
that of one fsynced file replaced atomically -- a power loss may lose the latest write, never leave a
partial board -- with no directory sync, and nothing can fail after the replace: a refusal means
nothing was written. Its inputs are what the verb writes; a file edited by hand is read only as far
as ``validate`` checks its shape.

How it runs, as the execution registry runs (``registry.py``'s header): this module is SHIPPED.
``fleet-worker.sh board`` sends its source to the anchor, where a Python >= 3.12 runs it from stdin,
the writers inside the lease lock after the lease check (``lease.LEASE_MUTATION``), ``show`` with no
lock and no lease. So it imports nothing from the ``ludics`` package, and its argv is the contract:

Argv: <state root> <action> <coordinator> <json payload>

  set   {"wave", "create", "task", "fields": [[key, value], ...]}   a task's row: each key set, in
        order (a new key joins the row's end; a task not yet on the board joins the table's end)
  note  {"wave", "create", "fields": [[key, value], ...]}           the wave's own facts (coordinator,
        scope, base, ...), shown above the table
  log   {"wave", "text"}                                            one line appended to the log,
        stamped with the time and the coordinator; nothing edits or removes a log line, and it
        never starts a board (an append is not idempotent: a retried first write must be)
  show  {"wave", "json"}                                            the markdown view, or the document

What it accepts, fail-closed (anything else refuses, ``BOARD REFUSED: <why>`` on stderr, exit 1):
a wave is ``[A-Za-z0-9][A-Za-z0-9._-]*`` (it names a file); a key is ``[A-Za-z][A-Za-z0-9_-]*``; a
task is nonempty text with no control character (Unicode category Cc) and no line or paragraph
separator (Zl, Zp), not starting with ``-``; a value or a log line is any text that is valid UTF-8,
newlines included. ``set`` or ``note`` on a wave with no board refuses unless ``create`` is true;
``create`` on an existing board is no refusal, so a retried first write is safe. ``log`` refuses a
wave with no board.
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
import json
import os
import re
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn, cast

type Doc = dict[str, Any]

WAVE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
KEY = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
# What may not appear in a task name, which is a table row's first cell: a control character, or a
# character that breaks a line (U+0085 is Cc; U+2028 and U+2029 are Zl and Zp).
NOT_IN_TASK = frozenset({"Cc", "Zl", "Zp"})


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
        if doc.get("board") != 1 or doc.get("wave") != wave:
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
    if not path.exists():
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


def main(argv: list[str]) -> None:
    root, action, coordinator, raw = argv[1:5]
    decoded: Any = json.loads(raw)
    if not isinstance(decoded, dict):
        refuse("the payload must be a JSON object")
    payload = cast(Doc, decoded)
    wave = wave_ok(payload.get("wave"))
    path = Path(root) / "boards" / f"{wave}.json"
    doc = load(path, wave)
    if action == "show":
        if doc is None:
            refuse(f"no board for wave {wave} on the anchor")
        sys.stdout.write(json.dumps(doc, indent=2, ensure_ascii=False) + "\n" if payload.get("json") else render(doc))
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
                row = {"task": task, "fields": {}, "updated_at": now}
                tasks.append(row)
            fields = cast(dict[str, str], row["fields"])
            for key, value in pairs:
                fields[key] = value
            row["updated_at"] = now
            said = f"BOARD SET {wave}: {json.dumps(task, ensure_ascii=False)} " + " ".join(key for key, _ in pairs)
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
    """``main`` with the board's refusal contract: one ``BOARD REFUSED: <why>`` line on stderr, exit 1."""
    try:
        main(argv)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"BOARD REFUSED: {exc}", file=sys.stderr)
        return 1
    return 0


# A program (``python - <argv>`` on the anchor) or ``runpy.run_path``, never an import.
if __name__ in ("__main__", "<run_path>"):
    if run(sys.argv) != 0:
        sys.exit(1)
