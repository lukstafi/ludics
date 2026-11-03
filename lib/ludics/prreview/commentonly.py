"""COMMENTS ONLY (#861): whether two versions of a file differ in comments and whitespace alone,
for the merge build's ``comments`` lines (mergebuild.py).

THE BOUNDARY -- a fail-closed allowlist. A file is read by its NAME, and only these are read:

  *.ml, *.mli                          OCaml: ``(* *)`` comments, nested, doc comments ``(** *)``
                                       included
  dune, dune-project, dune-workspace   dune (by the last path component): ``;`` to the end of
                                       the line

Any other file has no comments here, so any change of it is code. Within a file it reads, every
character of a string literal is kept, and outside strings each run of blanks and each comment
reads as one space, so a change of indentation or line breaks between tokens is no change. It
gives up -- the change is code -- on what it does not read soundly: in OCaml, a quoted extension
(``{%``), a line whose first token is ``#`` (a line directive or a toplevel one), a character
outside ASCII outside comments and strings, a ``"`` inside a comment right after ``'`` or ``\\``
that no character literal accounts for, and an unterminated comment, string or quoted string;
in dune, a block or datum comment (``#|``, ``#;``) or a verbatim string (``"\\|``, ``"\\>``)
anywhere in the file, and an unterminated string. A file that is not UTF-8 decodes with
surrogates, which OCaml reads as outside ASCII and both read verbatim inside strings.

What it does not see, and why mergebuild takes it as an opt-in per glob: a comment is still text
that something may read. odoc reads doc comments, the compiler attaches them (warning 50 on one
left unattached), and a comment that adds or removes lines moves every position the build reports
(``__LINE__``, an assertion's location in an expect test's output). A repository whose command
reads any of these leaves those paths out of its ``comments`` globs.
"""

import re

_OCAML = (".ml", ".mli")
_DUNE = ("dune", "dune-project", "dune-workspace")
_BLANKS = " \t\n\r\f"
_SEP = " "  # what a run of blanks or a comment reads as; no other part is ever exactly it
_IDENT = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_']*")
_ESCAPE = r"\\(?:[\\'\"ntbr ]|[0-9]{3}|o[0-3][0-7]{2}|x[0-9a-fA-F]{2})"
_PLAIN = r"(?![\\'\n\r])[\x00-\x7f]"  # a byte OCaml takes as a character literal's one character
_CHAR = re.compile(rf"'(?:\r*\n|{_PLAIN}|{_ESCAPE})'")
# Inside a comment OCaml's lexer also skips '' (so the quote after it starts nothing).
_CHAR_IN_COMMENT = re.compile(rf"''|'(?:\r*\n|{_PLAIN}|{_ESCAPE})'")
_QUOTED = re.compile(r"\{([a-z_]*)\|")


def language(path: str) -> str | None:
    """The language ``path`` is read as (THE BOUNDARY), or None: no comments are read in it."""
    leaf = path.rsplit("/", 1)[-1]
    if leaf.endswith(_OCAML):
        return "ocaml"
    if leaf in _DUNE:
        return "dune"
    return None


def code_of(path: str, text: str) -> str | None:
    """``text`` with its comments and blank runs read as single spaces, strings kept whole; None
    when ``path`` is outside THE BOUNDARY or the text holds what it gives up on."""
    lang = language(path)
    if lang == "ocaml":
        return _ocaml(text)
    if lang == "dune":
        return _dune(text)
    return None


def same_code(path: str, old: str, new: str) -> bool:
    """True when ``old`` and ``new`` differ only in comments and blanks (THE BOUNDARY); False
    whenever either cannot be read so."""
    a = code_of(path, old)
    return a is not None and a == code_of(path, new)


def _squeezed(parts: list[str]) -> str:
    out: list[str] = []
    for part in parts:
        if part == _SEP and (not out or out[-1] == _SEP):
            continue
        out.append(part)
    if out and out[-1] == _SEP:
        out.pop()
    return "".join(out)


def _string_end(text: str, i: int) -> int | None:
    """The index past the ``"`` that closes a string whose body starts at ``i``; None: none does."""
    n = len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
        elif c == '"':
            return i + 1
        else:
            i += 1
    return None


def _quoted_end(text: str, i: int) -> int | None:
    """The index past an OCaml quoted string ``{id|...|id}`` at ``i``; None when there is none to
    end (the caller checked ``_QUOTED`` matches at ``i``)."""
    m = _QUOTED.match(text, i)
    if m is None:
        return None
    close = f"|{m.group(1)}}}"
    end = text.find(close, m.end())
    return None if end < 0 else end + len(close)


def _ocaml_comment_end(text: str, i: int) -> int | None:
    """The index past the ``*)`` that closes a comment whose body starts at ``i``, read as
    OCaml's lexer reads one: nested comments, and strings, quoted strings and character literals
    inside it (so a ``*)`` in a string ends nothing)."""
    n, depth = len(text), 1
    while i < n:
        if text.startswith("(*", i):
            depth += 1
            i += 2
        elif text.startswith("*)", i):
            depth -= 1
            i += 2
            if depth == 0:
                return i
        elif text[i] == '"':
            if i > 0 and text[i - 1] in "'\\":
                return None
            end = _string_end(text, i + 1)
            if end is None:
                return None
            i = end
        elif text[i] == "{":
            if text.startswith("{%", i):
                return None
            if _QUOTED.match(text, i):
                end = _quoted_end(text, i)
                if end is None:
                    return None
                i = end
            else:
                i += 1
        elif text[i] == "'":
            m = _CHAR_IN_COMMENT.match(text, i)
            i = m.end() if m else i + 1
        else:
            i += 1
    return None


def _ocaml(text: str) -> str | None:
    parts: list[str] = []
    i, n = 0, len(text)
    line_start = True  # nothing but blanks and comments since the last newline
    while i < n:
        c = text[i]
        if c in _BLANKS:
            parts.append(_SEP)
            if c == "\n":
                line_start = True
            i += 1
            continue
        if text.startswith("(*", i):
            end = _ocaml_comment_end(text, i + 2)
            if end is None:
                return None
            if "\n" in text[i:end]:
                line_start = True
            parts.append(_SEP)
            i = end
            continue
        if c == "#" and line_start:
            return None
        line_start = False
        if c == '"':
            end = _string_end(text, i + 1)
            if end is None:
                return None
            parts.append(text[i:end])
            i = end
        elif c == "{":
            if text.startswith("{%", i):
                return None
            if _QUOTED.match(text, i):
                end = _quoted_end(text, i)
                if end is None:
                    return None
                parts.append(text[i:end])
                i = end
            else:
                parts.append(c)
                i += 1
        elif c == "'":
            m = _CHAR.match(text, i)
            parts.append(m.group() if m else c)
            i = m.end() if m else i + 1
        elif m := _IDENT.match(text, i):
            parts.append(m.group())
            i = m.end()
        elif not c.isascii():
            return None
        else:
            parts.append(c)
            i += 1
    return _squeezed(parts)


def _dune(text: str) -> str | None:
    if any(form in text for form in ("#|", "#;", '"\\|', '"\\>')):
        return None
    parts: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in _BLANKS:
            parts.append(_SEP)
            i += 1
        elif c == ";":
            end = text.find("\n", i)
            parts.append(_SEP)
            i = n if end < 0 else end
        elif c == '"':
            end = _string_end(text, i + 1)
            if end is None:
                return None
            parts.append(text[i:end])
            i = end
        else:
            parts.append(c)
            i += 1
    return _squeezed(parts)
