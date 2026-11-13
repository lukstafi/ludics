"""Lexical call index for test-fleet-worker.sh, not a shell interpreter.

Recognised forms (closed): section "NAME" && { at column zero; "$FW" or
"${FW[A-Z0-9]*[@]}" followed by literal unquoted verb/action words (including
--flags), separated by whitespace or backslash-newline; and command-position
need_worker, settle, need_lease and need_slot_fixture. These four helpers have
column-zero name() { definitions, ending on the same line or a column-zero };
their recognised calls are expanded transitively. Full-line comments are ignored.
Wrapper array definitions are not resolved: their call sites supply the verb.

This reads source text only, including quoted fixture scripts and heredocs, so a
listed call may be conditional or only fixture text. It does not interpret shell
quoting, variables, aliases, arbitrary functions, array contents or runtime paths.
A query with no recognised call is refused, never reported as verified absence.
An unlisted section is a loud miss outside this closed lexical boundary, not a
claim of completeness; use the module-wide suite line when call forms differ.
"""

from pathlib import Path
import re
import sys

SECTION = re.compile(r'^section "([^"\n]+)" && \{', re.MULTILINE)
CALL = re.compile(r'"(?:\$FW|\$\{FW[A-Z0-9]*\[@\]\})"\s+([a-z][a-z-]*)(?:[ \t]+([a-z-][a-z0-9-]*))?(?:[ \t]+(--[a-z-]+))?')
HELPERS = ("need_worker", "settle", "need_lease", "need_slot_fixture")
HELPER_DEF = re.compile(
    r"^(" + "|".join(HELPERS) + r")\(\) \{([^\n]*\}|.*?^\})", re.MULTILINE | re.DOTALL
)
HELPER_CALL = re.compile(r"(?:^|[;&|])\s*(" + "|".join(HELPERS) + r")(?=\s|$)", re.MULTILINE)


def sections_calling(source: str, query: tuple[str, ...]) -> list[str]:
    """Return section names in source order for the documented lexical forms."""
    source = re.sub(r"\\\n", " ", source)
    source = re.sub(r"^[ \t]*#.*$", "", source, flags=re.MULTILINE)
    helpers = {m[1]: m[2] for m in HELPER_DEF.finditer(source)}
    source = HELPER_DEF.sub("", source)

    def calls(text: str, seen: frozenset[str] = frozenset()) -> set[tuple[str, ...]]:
        found = {tuple(w for w in m.groups() if w) for m in CALL.finditer(text)}
        for m in HELPER_CALL.finditer(text):
            name = m[1]
            if name in helpers and name not in seen:
                found.update(calls(helpers[name], seen | {name}))
        return found

    headers = list(SECTION.finditer(source))
    result: list[str] = []
    for i, header in enumerate(headers):
        end = headers[i + 1].start() if i + 1 < len(headers) else len(source)
        if any(words[:len(query)] == query for words in calls(source[header.end():end])):
            result.append(header[1])
    return result


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2 or not 1 <= len(args[1:]) <= 3:
        print("usage: --sections-calling <verb> [action [--mode]]", file=sys.stderr)
        return 2
    names = sections_calling(Path(args[0]).read_text(), tuple(args[1:]))
    if not names:
        print(f"no recognised call for {args[1:]!r}; see suitecalls.py's closed boundary", file=sys.stderr)
        return 1
    for name in names:
        print(name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
