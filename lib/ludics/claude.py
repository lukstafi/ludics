"""One headless read-only ``claude -p`` invocation shared by roles whose writes must not land
anywhere that matters: the paired planner (``peerplan/plan.py``), the review checkpoint's
``claude`` reviewer (``fleetworker/wavereview.py``), and the coordinator preflight probe
(``fleetworker/preflight.py``).

TWO SEPARATE BOUNDS:

- **MCP tools:** ``--strict-mcp-config`` with no ``--mcp-config``. Neither ``--tools`` nor
  ``--allowedTools``/``--disallowedTools`` bounds MCP servers: without ``--strict-mcp-config``,
  ``claude -p`` starts every MCP server configured on the box, and any tool whose box settings
  already allow it needs no prompt in a headless turn. ``readonly_argv`` always emits
  ``--strict-mcp-config`` before any variadic tool flag and never emits ``--mcp-config``.
- **Built-in tools:** every caller passes an explicit ``ToolBound``:
  - ``BuiltinTools(spec)`` emits ``--tools <spec>`` (the offered built-in set, e.g.
    ``"Read,Grep,Glob"`` for the planner or ``""`` for no built-in tools);
  - ``ToolRules(allowed, disallowed)`` emits ``--allowedTools <allowed...> --disallowedTools
    <disallowed...>`` for callers like the reviewer that need ``Bash(<command pattern>)``
    allowlist rules alongside explicit built-in write denials.

What this does not stop: a writing option on an allowed ``Bash(...)`` verb (e.g.
``git show --output=<file>``) and anything an allowed ``gh`` read reaches with the fleet's token.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import assert_never


@dataclass(frozen=True)
class BuiltinTools:
    """Offer only these built-in tools (``--tools``; ``""`` offers none)."""

    spec: str


@dataclass(frozen=True)
class ToolRules:
    """Allowlist and denylist over built-in tools (``--allowedTools`` / ``--disallowedTools``)."""

    allowed: Sequence[str]
    disallowed: Sequence[str]


ToolBound = BuiltinTools | ToolRules


def readonly_argv(
    model: str,
    bound: ToolBound,
    *,
    effort: str = "",
    persist: bool = True,
    resume: str = "",
) -> list[str]:
    """Build a read-only ``claude -p --output-format json`` argv that always disables configured
    MCP servers via ``--strict-mcp-config`` (with no ``--mcp-config``) and applies ``bound`` to
    built-in tools."""
    if not model or model.startswith("-"):
        raise ValueError(f"model must be a non-empty model name, not {model!r}")
    if effort and effort.startswith("-"):
        raise ValueError(f"effort must not start with '-', got {effort!r}")
    if resume and not persist:
        raise ValueError("resume cannot be combined with persist=False (--no-session-persistence)")
    if resume and resume.startswith("-"):
        raise ValueError(f"resume session id must not start with '-', got {resume!r}")

    words = ["-p", "--model", model]
    if effort:
        words += ["--effort", effort]
    words += ["--output-format", "json"]
    if not persist:
        words.append("--no-session-persistence")
    words.append("--strict-mcp-config")

    match bound:
        case BuiltinTools(spec):
            if spec.startswith("-"):
                raise ValueError(f"tools spec must not start with '-', got {spec!r}")
            words += ["--tools", spec]
        case ToolRules(allowed, disallowed):
            if isinstance(allowed, str) or isinstance(disallowed, str):
                raise ValueError("ToolRules allowed and disallowed must be sequences of tool names, not bare strings")
            if not allowed or not disallowed:
                raise ValueError("ToolRules requires non-empty allowed and disallowed tool lists")
            if any(not item or item.startswith("-") for item in (*allowed, *disallowed)):
                raise ValueError("ToolRules entries must be non-empty and must not start with '-'")
            words += ["--allowedTools", *allowed, "--disallowedTools", *disallowed]
        case _:
            assert_never(bound)

    if resume:
        words += ["--resume", resume]
    return words
