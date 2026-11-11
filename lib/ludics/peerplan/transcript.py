"""The worker's ``PLAN_READY`` block, read from a native Claude worker's transcript (#1048).

A native Claude worker hands its plan back as the ``PLAN_READY`` ... ``END_PLAN_READY`` block of
its turn-final message, and the coordinator sees that message only in a task notification. The
notification's "output file" (``<tmp>/<project>/<session>/tasks/<agent-id>.output``) is a symlink
to the worker's Claude Code transcript, ``~/.claude/projects/<project>/<session>/subagents/
agent-<agent-id>.jsonl``: one JSON object per line. ``save-plan`` reads the plan from there.

What the reader accepts, as a fail-closed allowlist: everything not named here is not read.

- The file: UTF-8, every non-blank line one JSON object. Anything else (a background Bash
  command's plain-text ``.output``, a line still being written) refuses the whole file.
- The records: only those with ``type`` ``"assistant"`` whose ``isApiErrorMessage`` is not
  ``true``, and whose ``message`` is an object with ``role`` ``"assistant"`` and a ``content``
  list. User records (the brief, coordinator messages, tool results), ``api-request-blob`` copies
  of the request, attachments and every other type are not read: they quote the brief and the
  files the worker read, ``PLAN_READY`` included.
- The blocks: only ``content`` items with ``type`` ``"text"`` and a string ``text``. Thinking and
  ``tool_use`` blocks, a string ``content``, and any other shape are not read.
- The markers: a line that is exactly ``PLAN_READY`` or ``END_PLAN_READY`` from its first column,
  trailing blanks allowed. An indented or mid-sentence mention is plan text, not a marker.

Which block: the text blocks are taken in file order (Claude Code writes one content block per
line, and the lines of one API message share ``message.id`` and keep their order), and the last
text block holding a marker line decides. Its markers must pair up, each ``PLAN_READY`` closed by
an ``END_PLAN_READY`` before the next opens, and its last pair is the plan, which must not be
blank. A decisive block that is unterminated, nested or stray refuses: an earlier complete block
is never taken in its place, since it is not the worker's last word.
"""

import json
from typing import cast

OPEN = "PLAN_READY"
CLOSE = "END_PLAN_READY"


class Refused(Exception):
    """The transcript holds no plan this reader takes; the message says why."""


def text_blocks(lines: list[str]) -> list[str]:
    """The allowlisted assistant text blocks of a transcript's lines, in file order."""
    texts: list[str] = []
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record: object = json.loads(line)
        except ValueError:
            raise Refused(f"line {number} is not JSON: not a Claude Code transcript, or one still being written") from None
        if not isinstance(record, dict):
            raise Refused(f"line {number} is not a JSON object: not a Claude Code transcript")
        fields = cast(dict[str, object], record)
        if fields.get("type") != "assistant" or fields.get("isApiErrorMessage") is True:
            continue
        message = fields.get("message")
        if not isinstance(message, dict):
            continue
        body = cast(dict[str, object], message)
        content = body.get("content")
        if body.get("role") != "assistant" or not isinstance(content, list):
            continue
        for item in cast(list[object], content):
            if not isinstance(item, dict):
                continue
            block = cast(dict[str, object], item)
            text = block.get("text")
            if block.get("type") == "text" and isinstance(text, str):
                texts.append(text)
    return texts


def marker(line: str) -> str:
    """``OPEN``, ``CLOSE`` or "" for one line of a text block."""
    word = line.rstrip(" \t\r")
    return word if word in (OPEN, CLOSE) else ""


def last_plan(lines: list[str]) -> str:
    """The plan of the decisive text block (the module docstring), newline-terminated."""
    decisive: list[str] | None = None
    for text in text_blocks(lines):
        split = text.split("\n")
        if any(marker(line) for line in split):
            decisive = split
    if decisive is None:
        raise Refused(f"no {OPEN} block in the worker's messages")
    plan: list[str] | None = None
    body: list[str] | None = None
    for line in decisive:
        word = marker(line)
        if word == OPEN:
            if body is not None:
                raise Refused(f"the last {OPEN} block opens again before its {CLOSE}")
            body = []
        elif word == CLOSE:
            if body is None:
                raise Refused(f"the worker's last message with a marker has a {CLOSE} with no {OPEN} before it")
            plan, body = body, None
        elif body is not None:
            body.append(line)
    if body is not None:
        raise Refused(f"the last {OPEN} block is unterminated: no {CLOSE} line closes it")
    assert plan is not None
    text = "\n".join(plan).strip("\n")
    if not text.strip():
        raise Refused(f"the last {OPEN} block is empty")
    return text + "\n"
