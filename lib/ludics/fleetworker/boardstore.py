"""Anchor-side wave boards (ludics-lite#619). Invoked by fleet-worker's ``board`` verb.

A board was a markdown file the coordinator edited with ``sed`` substitutions on table rows, which
broke on cell text holding ``#``, ``(``, ``)`` or ``/`` (OCANNL wave-20261014, three times). Now the
board is one JSON document per wave, ``<state root>/boards/<wave>.json``, and the markdown is a view
rendered from it: no cell text is ever a pattern, a delimiter or a shell word anywhere on its way in.

How it runs, as the execution registry runs (``registry.py``'s header): this module is SHIPPED.
``fleet-worker.sh board`` sends its source to the anchor, where a Python >= 3.12 runs it from stdin,
the writers inside the lease lock after the lease check (``lease.LEASE_MUTATION``), ``show`` with no
lock and no lease. So it imports nothing from the ``ludics`` package, and its argv is the contract:

Argv: <state root> <action> <coordinator> <json payload>

  set   {"wave", "create", "task", "fields": [[key, value], ...]}   a task's row: each key set, in
        order (a new key joins the row's end; a task not yet on the board joins the table's end)
  note  {"wave", "create", "fields": [[key, value], ...]}           the wave's own facts (coordinator,
        scope, base, ...), shown above the table
  log   {"wave", "create", "text"}                                  one line appended to the log,
        stamped with the time and the coordinator; nothing edits or removes a log line
  show  {"wave", "json"}                                            the markdown view, or the document

What it accepts, fail-closed (anything else refuses, ``BOARD REFUSED: <why>`` on stderr, exit 1):
a wave is ``[A-Za-z0-9][A-Za-z0-9._-]*`` (it names a file); a key is ``[A-Za-z][A-Za-z0-9_-]*``; a
task is nonempty text with no control character, not starting with ``-``; a value or a log line is
any text that is valid UTF-8, newlines included. A writer on a wave with no board refuses unless
``create`` is true; ``create`` on an existing board is no refusal, so a retried first write is safe.
A board file that does not parse as a board is refused, never overwritten. Every write is exactly
one ``os.replace`` of the whole document, so a reader without the lock sees the old board or the
new one, never a part.

The markdown view, and its boundary: the JSON document is the board, and the view is for reading.
In a cell ``|`` is written ``\\|`` and a line break ``<br>``; in a note or a log line a line break
is ``<br>``. Nothing else is escaped, so text that is itself markdown (backticks, links, emphasis)
renders as markdown. Columns are the keys in the order the rows first name them.
"""
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn, cast

type Doc = dict[str, Any]

WAVE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
KEY = re.compile(r"[A-Za-z][A-Za-z0-9_-]*")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


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
    if not task or task.startswith("-") or CONTROL.search(task):
        refuse("a task must be nonempty, with no control character, and not start with '-'")
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
        for key in ("created_at", "updated_at"):
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


def sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish(path: Path, doc: Doc) -> None:
    """Write the whole document atomically and durably: exactly one ``os.replace``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".board-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(doc, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def cell(text: str) -> str:
    """A table cell's markdown: ``|`` escaped and line breaks as ``<br>`` (the view's boundary)."""
    return lines(text).replace("|", "\\|")


def lines(text: str) -> str:
    return text.replace("\r\n", "<br>").replace("\r", "<br>").replace("\n", "<br>")


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
        if payload.get("create") is not True:
            refuse(f"no board for wave {wave} on the anchor (start it with --create)")
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
