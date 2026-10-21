"""The mac-studio correctness-slot count: fleet-worker.sh's default, and every file that states it.

ludics-lite#160 raised ``FLEET_BOX_CORRECTNESS_SLOTS``' mac-studio default from three to six, and the
number is restated as prose all over the prompts. The default is one line of fleet-worker.sh; every
other statement of it is English, which does not fail a test when it goes stale -- so the number is
read off the script and every statement is required to say the same thing.

WHICH files are held is discovered, not listed: every ``*.md`` and ``*.sh`` under the root, minus the
mechanism's own entry point (``SLOT_MECHANISM``; its suite is Python, which the scan does not read),
is held exactly when it states the count. The three prompts PR #166 quoted it in are also REQUIRED
to keep stating it, so the agreement cannot go vacuous.

WHAT counts as a statement is two shapes: ``mac-studio=<n>`` (the whole token, so ``mac-studio=6oops``
is refused rather than accepted on its prefix; closing punctuation is punctuation), and the run of
numeral words standing before ``on mac-studio`` (``twenty-six``, ``twenty six``, ``one hundred and
six`` are each the whole count they state; ``done on mac-studio`` states none). The ``<N>, not <m>``
justification is deliberately not read (ludics-lite#202): nothing in that shape is about slots, and a
window wide enough to catch the real ones reads ordinary comparisons as counts. The word form is read
without further context, for the same reason; the cost, stated in #202, is that an unrelated
``version six on mac-studio`` would satisfy a required prompt's obligation.

Text INSIDE an assignment of the variable is skipped: a fixture configuring a two-slot box states its
own input. Which text that is is answered structurally -- the assignment word is walked from
``…SLOTS=`` to its first unquoted blank, over the file joined into one line -- and comments are
taken out first, so a commented-out assignment is prose and is held.

The default itself is the ``mac-studio=<n>`` inside the value of the LAST top-level ``SLOTS=``
assignment the shell keeps: not in a heredoc body (data the script writes), not in a function body
(defined, not run), not a command-prefix assignment (scoped to that command). A literal pair list is
validated whole, as the worker validates it: a malformed pair anywhere refuses the spec.

The shell-word readers below (``word_end``, ``uncommented``, ``code_of``, ``unquote``) keep the
shell checker's 1-based positions, since the spans they return are compared with positions in the
joined text.
"""

import os
import re
from dataclasses import dataclass
from typing import assert_never

from ludics.checkprompts.bytes_view import WS, WS_CLASS, ascii_lower, awk_records, lat, read_bytes, u, ws_split
from ludics.checkprompts.tree import Report, Tree

SLOT_SCRIPT = "issue-wave/scripts/fleet-worker.sh"
SLOT_PROMPTS = ("README.md", "issue-wave/SKILL.md", "issue-wave/references/executions.md")
SLOT_MECHANISM = ("scripts/check-prompts.sh",)
NUMBER_WORDS = (
    "zero one two three four five six seven eight nine ten eleven twelve".split(" ")
)
# The vocabulary a word-shaped count is recognized by -- wider than the spellings a default can
# take, because its job is to tell a stated count apart from an ordinary word, not to name one.
NUMERALS = frozenset(
    NUMBER_WORDS
    + "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty"
    " sixty seventy eighty ninety hundred thousand million billion".split(" ")
)

RE_DIGIT = re.compile(r"[^a-z0-9_.\-]mac-studio=[^ \t\n\v\f\r`\"'),;]*")
RE_WORD = re.compile(WS_CLASS + "on" + WS_CLASS + r"+mac-studio(?:[^a-z0-9_.\-]|\Z)")
RE_ASSIGNMENT = re.compile(r"(?:^|[^a-z0-9_])[a-z0-9_]*slots=")
LEAD_PUNCT = re.compile(r"^[^A-Za-z0-9]+")
TRAIL_PUNCT = re.compile(r"[^A-Za-z0-9]+\Z")


def ch(s: str, i: int) -> str:
    """awk's ``substr(s, i, 1)``: the 1-based character, or empty past either end."""
    return s[i - 1] if 1 <= i <= len(s) else ""


def word_end(line: str, start: int) -> int:
    """The 1-based index of the last character of the shell word that starts after ``start``: it
    ends at the first UNQUOTED, UNESCAPED blank. A quote that never closes was not quoting (prose
    carries apostrophes), so the unquoted reading stands then."""
    q = ""
    plain = 0
    i = start + 1
    while i <= len(line):
        c = line[i - 1]
        if q == "":
            if c == "\\":
                i += 2  # an escaped blank is part of the word
                continue
            if c in "\"'":
                q = c
                i += 1
                continue
            if c in " \t":
                break
        elif c == q:
            q = ""
        elif c in " \t" and plain == 0:
            plain = i - 1
        i += 1
    if q != "" and plain > 0:
        return plain
    return i - 1


def uncommented(line: str) -> str:
    """``line`` with its comment -- a ``#`` outside quotes, at the start or after a blank --
    blanked to its original length, so positions do not shift. Quoted text is kept."""
    q = ""
    i = 1
    while i <= len(line):
        c = line[i - 1]
        if q == "":
            if c == "\\":
                i += 2
                continue
            if c in "\"'":
                q = c
                i += 1
                continue
            if c == "#" and (i == 1 or line[i - 2] in WS):
                return line[: i - 1].ljust(len(line))
        elif c == q:
            q = ""
        i += 1
    return line


def code_of(line: str) -> str:
    """The part of ``line`` the shell would EXECUTE: its comment dropped and its quoted text
    blanked, at the same length. Both are places a ``<<word`` can stand without opening anything.
    A redirection operator and the word after it are copied whole, quotes and all."""
    q = ""
    out: list[str] = []
    n = len(line)
    i = 1
    while i <= n:
        c = line[i - 1]
        if q == "":
            if c == "\\":
                out.append("  ")
                i += 2
                continue
            if c == "<" and ch(line, i + 1) == "<":
                j = i
                while ch(line, j) == "<":
                    out.append("<")
                    j += 1
                if ch(line, j) == "-":
                    out.append("-")
                    j += 1
                while j <= n and line[j - 1] in WS:
                    out.append(line[j - 1])
                    j += 1
                dq = ch(line, j)
                if dq in ('"', "'"):
                    out.append(dq)
                    j += 1
                    while j <= n and line[j - 1] != dq:
                        out.append(line[j - 1])
                        j += 1
                    if j <= n:
                        out.append(dq)
                        j += 1
                else:
                    while j <= n and line[j - 1] not in WS + ";&|<>()":
                        out.append(line[j - 1])
                        j += 1
                i = j
                continue
            if c in "\"'":
                q = c
                out.append(" ")
                i += 1
                continue
            if c == "#" and (i == 1 or line[i - 2] in WS):
                return "".join(out).ljust(n)  # the length stands; the code stops
            out.append(c)
        else:
            if c == q:
                q = ""
            out.append(" ")
        i += 1
    return "".join(out)


def unquote(s: str) -> str:
    """``s`` with the quote characters that grouped it removed, and each escape resolved to the
    character it escapes."""
    out: list[str] = []
    q = ""
    i = 0
    while i < len(s):
        c = s[i]
        if q == "":
            if c == "\\":
                out.append(s[i + 1 : i + 2])
                i += 2
                continue
            if c in "\"'":
                q = c
                i += 1
                continue
        elif c == q:
            q = ""
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def as_number(token: str) -> str:
    """``token`` as a decimal number, leading zeros dropped; a token that is not all digits is
    returned unchanged, so it is reported as written and agrees with nothing. The number is bash
    arithmetic's (``$((10#n))``), which wraps at 64 bits: 2^64 + 6 is 6, and 2^63 is negative."""
    if not (token and token.isascii() and token.isdigit()):
        return token
    n = int(token) % 2**64
    return str(n - 2**64 if n >= 2**63 else n)


# --- the default ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Count:
    """A well-formed default, as the digits written."""

    digits: str


@dataclass(frozen=True)
class BadPair:
    """A pair the worker refuses outright, so nothing downstream of it is reached."""

    pair: str


@dataclass(frozen=True)
class NoCount:
    """No ``mac-studio=<n>`` in the value the shell keeps."""


type SlotDefault = Count | BadPair | NoCount

HEREDOC = re.compile(
    r"(?:^|[^<])<<-?" + WS_CLASS + r"*[\"\\']?[^ \t\n\v\f\r;&|<>()]+"
)
FUNCTION_OPEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\(\))?" + WS_CLASS + r"*\{")
FUNCTION_KEYWORD = re.compile("function" + WS_CLASS)
VALID_PAIR = re.compile(r"[^= \t\n\v\f\r]+=0*[1-9][0-9]*")
DEFAULT_PAIR = re.compile(r"(?:^|[^a-z0-9_.\-])mac-studio=[^ \t\n\v\f\r)}]*")
TAIL_OK = re.compile(r"[#;&|<>)]")


def slot_default(text: str) -> SlotDefault:
    """The ``mac-studio=<n>`` default inside the value of the last top-level SLOTS assignment."""
    queued: list[tuple[str, bool]] = []  # heredoc delimiters, and whether `<<-` strips tabs
    in_func = False
    last = ""
    for rec in awk_records(text):
        # A heredoc body is data the script WRITES, not code it runs.
        if queued:
            line = re.sub(r"^\t+", "", rec) if queued[0][1] else rec
            if line == queued[0][0]:
                queued.pop(0)  # this body ends; the next one on that line begins
            continue
        # Every heredoc the line opens, in the order the shell consumes their bodies. The leading
        # `[^<]` keeps a here-STRING (`<<<`) from reading as a heredoc opened by its second `<`.
        rest = code_of(rec)
        while (m := HEREDOC.search(rest)) is not None:
            tag = re.sub(r"^[^<]", "", m.group(0))
            dash = tag[2:3] == "-"
            tag = re.sub(r"^<<-?" + WS_CLASS + "*", "", tag)
            queued.append((re.sub(r"[\"'\\]", "", tag), dash))
            rest = rest[m.end() :]
        # A function body is defined, not run (a definition opening at column zero, its body
        # closed by a `}` at column zero).
        if FUNCTION_OPEN.match(rec) or FUNCTION_KEYWORD.match(rec):
            in_func = True
            continue
        if in_func:
            if rec.startswith("}"):
                in_func = False
            continue
        if not rec.startswith("SLOTS="):
            continue
        eq = rec.index("=") + 1
        stop = word_end(rec, eq)
        # `SLOTS=… some-command` scopes the assignment to that command; a separator or a
        # redirection after it does not.
        tail = rec[stop:].lstrip(WS)
        if tail != "" and not TAIL_OK.match(tail):
            continue
        value = unquote(rec[eq:stop])
        last = ""
        bad = ""
        # A literal pair list is what the worker splits and validates in order, so a malformed
        # pair ANYWHERE in one refuses the whole spec. An expression cannot be read this way.
        if not re.search(r"[$`(]", value):
            for pair in ws_split(value):
                if bad:
                    break
                if pair != "" and not VALID_PAIR.fullmatch(pair):
                    bad = pair
        # EVERY mac-studio pair: the last valid one is the default (the registry keeps the last
        # value for a box named twice), and a malformed one before it refuses the spec.
        rest = value
        while (m := DEFAULT_PAIR.search(rest)) is not None:
            pair = re.sub(r"^[^m]", "", m.group(0))
            count = pair[len("mac-studio=") :]
            if re.fullmatch(r"[0-9]+", count):
                last = count
            elif not bad:
                bad = pair
            rest = rest[m.end() :]
        if bad:
            last = "!" + bad
    if last.startswith("!"):
        return BadPair(last[1:])
    if last == "":
        return NoCount()
    return Count(last)


# --- the mentions --------------------------------------------------------------------------------


@dataclass(frozen=True)
class DigitMention:
    """``mac-studio=<token>``: the token, and the mention as written."""

    token: str
    shown: str


@dataclass(frozen=True)
class WordMention:
    """``<numerals> on mac-studio``: the numeral phrase."""

    numerals: str


type Mention = DigitMention | WordMention


def numeral(word: str) -> bool:
    """A word from the vocabulary, or hyphenated words all of which are (``twenty-six``)."""
    return word != "" and all(part in NUMERALS for part in word.split("-"))


def numerals_before(lower: str, at: int) -> str:
    """The maximal run of numeral words ending just before the 1-based position ``at``, read
    backwards from at most 90 characters before it. A word carrying trailing punctuation ENDS the
    run without joining it, and ``and`` joins only between two numerals."""
    start = max(at - 90, 1)
    words = ws_split(lower[start - 1 : at - 1])
    run = ""
    joined = ""
    for raw in reversed(words):
        word = re.sub(r"^[^a-z]+", "", raw)
        if not re.fullmatch(r"[a-z][a-z-]*", word):
            break
        if numeral(word):
            run = f"{word} {joined} {run}" if joined else (word if run == "" else f"{word} {run}")
            joined = ""
        elif word == "and" and run and not joined:
            joined = "and"
        else:
            break
    return run


def find_assignments(code: str) -> list[tuple[int, int]]:
    """The 1-based span of every assignment of a ``…slots`` variable over the JOINED text, from
    the match through the end of the assignment word. Read past the comments (``code``), so a
    count in a comment shaped like an assignment is still a statement."""
    spans: list[tuple[int, int]] = []
    rest = ascii_lower(code)
    base = 0
    while (m := RE_ASSIGNMENT.search(rest)) is not None:
        st = m.start() + 1
        length = m.end() - m.start()
        at = base + st
        spans.append((at, word_end(code, at + length - 1)))
        base = at + length - 1
        rest = rest[st - 1 + length :]
    return spans


def slot_mentions(text: str) -> list[Mention]:
    """Every statement of the count in ``text``: the digit form first, then the word form, each in
    the order it stands."""
    recs = awk_records(text)
    joined = "".join(" " + r for r in recs)
    code = "".join(" " + uncommented(r) for r in recs)
    lower = ascii_lower(joined)
    spans = find_assignments(code)
    out: list[Mention] = []

    def inside_assignment(pos: int) -> bool:
        return any(lo <= pos <= hi for lo, hi in spans)

    def scan(pattern: re.Pattern[str], digit: bool) -> None:
        rest = lower
        base = 0
        while (m := pattern.search(rest)) is not None:
            st = m.start() + 1
            length = m.end() - m.start()
            at = base + st
            frag = joined[at - 1 : at - 1 + length]
            if digit:
                name = ascii_lower(frag).index("mac-studio=") + 1
                # The variable being SET, not a statement of its default.
                if not inside_assignment(at + name - 1):
                    token = TRAIL_PUNCT.sub("", frag[name + 10 :])
                    shown = TRAIL_PUNCT.sub("", LEAD_PUNCT.sub("", frag))
                    out.append(DigitMention(token, shown))
            else:
                n = numerals_before(lower, at)
                if n:
                    out.append(WordMention(n))
            base = at + length - 1
            rest = rest[st - 1 + length :]

    scan(RE_DIGIT, True)
    scan(RE_WORD, False)
    return out


def awk_assigned(value: str) -> str | None:
    """What an ``awk -v name=<value>`` assignment holds under the macOS awk: escapes processed
    (``\\n``, ``\\t``, ``\\b``, ``\\f``, ``\\r``, ``\\v``, ``\\a``, ``\\\\``, up to three
    digits as octal, any other escaped character as itself, a trailing backslash kept), the
    result cut at a NUL as a C string is; None when the value holds a newline, which that awk
    refuses as a syntax error, running nothing."""
    out: list[str] = []
    i = 0
    while i < len(value):
        c = value[i]
        if c == "\n":
            return None
        i += 1
        if c != "\\":
            out.append(c)
            continue
        if i == len(value):
            out.append("\\")
            break
        c = value[i]
        i += 1
        if c in AWK_ESCAPES:
            out.append(AWK_ESCAPES[c])
        elif "0" <= c <= "9":
            n = ord(c) - ord("0")
            for _ in range(2):
                if i < len(value) and "0" <= value[i] <= "9":
                    n = 8 * n + ord(value[i]) - ord("0")
                    i += 1
            out.append(chr(n & 0xFF))
        else:
            out.append(c)
    return "".join(out).split("\0", 1)[0]


AWK_ESCAPES = {
    "\\": "\\",
    "n": "\n",
    "t": "\t",
    "b": "\b",
    "f": "\f",
    "r": "\r",
    "v": "\v",
    "a": "\a",
}


def slot_files(tree: Tree) -> list[str]:
    """Every ``*.md`` and ``*.sh`` regular file under the root, as the shell checker listed them:
    ``find "$ROOT" -name .git -prune -o -type f ... -print`` (symbolic links neither followed nor
    listed, and a root that IS one not entered), its output read as awk records, each cut back to
    root-relative by an ``awk -v root="$ROOT/"`` prefix -- escape-processed, so a root whose path
    holds a backslash matches no record -- minus the mechanism's own two (a match inside their
    space-joined list), then byte-sorted."""
    if os.path.basename(tree.root) == ".git" or os.path.islink(tree.root):
        return []
    cut = awk_assigned(lat(tree.root) + "/")
    if cut is None:
        return []
    found: list[str] = []

    def walk(directory: str, prefix: str) -> None:
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for entry in entries:
            if entry.name == ".git":
                continue
            rel = prefix + lat(entry.name)
            try:
                if entry.is_dir(follow_symlinks=False):
                    walk(entry.path, rel + "/")
                elif entry.is_file(follow_symlinks=False) and entry.name.endswith((".md", ".sh")):
                    found.append(rel)
            except OSError:
                continue

    walk(tree.root, "")
    skip = " " + " ".join(SLOT_MECHANISM) + " "
    out: list[str] = []
    for rel in found:
        # A newline in a name splits find's output line, and awk reads the halves apart.
        for rec in (lat(tree.root) + "/" + rel).split("\n"):
            if rec.startswith(cut):
                f = rec[len(cut) :]
                if f and f" {f} " not in skip:
                    out.append(f)
    return sorted(out)


def check_slots(report: Report, tree: Tree) -> None:
    # A root without fleet-worker.sh carries no obligation, as with the fixture register.
    if not tree.is_file(SLOT_SCRIPT):
        return
    match slot_default(tree.read(SLOT_SCRIPT) or ""):
        case BadPair(pair):
            report.ko(
                SLOT_SCRIPT, f"SLOTS assignment states '{pair}', which is not <box>=<positive n>"
            )
            return
        case NoCount():
            report.ko(SLOT_SCRIPT, "SLOTS assignment states no 'mac-studio=<n>' default")
            return
        case Count(digits):
            default = as_number(digits)
        case _ as unreachable:
            assert_never(unreachable)
    # As a NUMBER: the worker reads `mac-studio=06` as six and `00` as zero, and refuses a count
    # below one, so a zero default is a roster every mac-studio slot call dies on.
    if int(default) < 1:
        report.ko(
            SLOT_SCRIPT,
            f"SLOTS assignment states mac-studio={default}; the worker requires <box>=<positive n>",
        )
        return
    # An unspellable default leaves the word forms unmatchable rather than unchecked.
    word = NUMBER_WORDS[int(default)] if int(default) < len(NUMBER_WORDS) else ""
    stated = " "  # the files that state the count, each followed by a blank, as the shell kept them
    bad = False
    for f in slot_files(tree):
        data = read_bytes(tree.root + "/" + u(f))  # `$ROOT/$f`, whatever `f` begins with
        # Both shapes contain the literal `mac-studio`, so a file without it states no count.
        if data is None or b"mac-studio" not in data.lower():
            continue
        mentions = slot_mentions(data.decode("latin-1"))
        if not mentions:
            continue
        stated += f + " "
        for mention in mentions:
            match mention:
                case DigitMention(token, shown):
                    # The shell read each mention back with `IFS=<TAB> read kind n shown`, and a
                    # tab is IFS whitespace: an EMPTY token collapsed into the next field.
                    if token == "":
                        token, shown = shown, ""
                    if as_number(token) != default:
                        report.ko(
                            f, f"states '{shown}'; {SLOT_SCRIPT} defaults to mac-studio={default}"
                        )
                        bad = True
                case WordMention(numerals):
                    if numerals != word:
                        report.ko(
                            f,
                            f"spells the mac-studio slot count '{numerals}'; {SLOT_SCRIPT}"
                            f" defaults to mac-studio={default}",
                        )
                        bad = True
                case _ as unreachable:
                    assert_never(unreachable)
    # A prompt that stops stating the count is how the agreement would quietly stop being checked.
    for f in SLOT_PROMPTS:
        if f" {f} " not in stated:
            report.ko(
                f,
                "states no mac-studio slot count in a form this check reads"
                f" ('mac-studio={default}', '{word} on mac-studio')",
            )
            bad = True
    if not bad:
        report.ok(
            f"mac-studio correctness slots agree: {SLOT_SCRIPT} and every file that states the"
            f" count say {default}"
        )

