"""The closing-keyword scans ``merge`` runs before every attempt: the PR body, and the commit series.

Ported from pr-review.sh's ``MULTI_CLOSE_FILTER`` (an awk program in the shell),
``warn_multi_close`` (ludics-lite#227) and ``warn_series_close`` (#296). The filter's rules are the
product of seventeen review rounds, each recorded in the shell's comment beside the rule it
shaped; this is the same filter, rule for rule, in the same order:

  * a body line is classified (indentation in tab-expanded columns, list markers peeled, fences
    opened and closed only on their own delimiter, ``>`` quotes), then cut into sentence units at
    terminal punctuation followed by whitespace;
  * in each unit, URLs are scrubbed first, then ONE match finds a closing keyword between
    whitelisted boundaries, and the references are read FORWARD from it, each needing a
    whitelisted boundary before it and no identifier character after it, deduplicated
    case-insensitively with this repository's own qualified spelling folded into the bare one;
  * a unit is reported when its keyword binds two or more references (``sentence``), or any
    reference inside a quoted, fenced or (in a commit message) indented line (``quoted``);
  * and, in a unit of an unquoted line, a closing keyword NEGATED right before it and a reference
    right after it (``negated``, ludics#815): GitHub's parser does not read negation, so "The PR
    does not close #1647:" in ocannl-staging#1463's body closed ahrefs/ocannl#1647.

The negated reading is the README's ludics-lite#75 line-shaped scan, and its boundary is a
fail-closed allowlist (``_NEGATION``): within ONE sentence unit of ONE line, a negation word --
``not``, ``never``, ``cannot``, or the contractions don't, doesn't, didn't, won't, wouldn't, can't,
couldn't, shouldn't, mustn't, isn't, aren't, with a straight or a curly apostrophe -- then blanks
only, then a closing keyword the scan already knows (close, closes, closed, fix, fixes, fixed,
resolve, resolves, resolved, any case), an optional colon, blanks, and a reference of ``_REF``'s
shape at once. Deliberately not read: a negation across a line break or a sentence end, a word
between the negation and the keyword ("does not yet close #N", "not to close #N"), a quoted, fenced
or indented line (reported as ``quoted`` already, whatever its wording), and paraphrase ("leaves #N
open", "#N stays open"). A form outside that list is a follow-up, never a reason to read prose. It
warns; it never refuses.

awk's regex matching is leftmost-longest and Python's is leftmost-first; every pattern below was
checked to choose the same match under both (each is either fixed-width at its end or has a
greedy tail no alternative can outrun). Lowercasing is ASCII-only, as the shell's awk did it, so
offsets into the unit stay the unit's own. Checked against the shell's awk program on 8,176 bodies
and messages (the merge suite's, and generated ones) in the C locale: identical findings. One
divergence, on purpose: macOS awk 20200816 in a UTF-8 locale ABORTS ("towc: multibyte conversion
failure") on a reference followed by a non-ASCII letter, which the shell reported as a scan that
did not run; here such a body is scanned. A sentence is cut at 200 characters, not bytes.
"""

import re
from dataclasses import dataclass
from typing import Literal

from ludics import cli
from ludics.prreview.core import GhOk, GhSession, shell_quote, warn
from ludics.prreview.shtext import count_nonempty

_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")

_URL_SCHEME = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^ \t]*")
_URL_HOST = re.compile(
    r"(^|[ \t(\[{<\"'])[a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z][a-zA-Z]+(:[0-9]+)?([/?#][^ \t]*)?"
)
_REF = re.compile(r"(^|[ \t(\[{<\"'`*_,;])([a-zA-Z0-9][-a-zA-Z0-9]*/[-a-zA-Z0-9._]+)?#[1-9][0-9]*")
_KEYWORD = re.compile(
    r"(^|[ \t(\[{<\"'`*,;:>])(close[sd]?|fix(e[sd])?|resolve[sd]?)"
    r"([ \t)\]}>\"'`*,;:!?]|\.[^a-z0-9_]|\.$|$)"
)
# The negations a closing keyword may follow (the module docstring states the boundary), matched
# on the ASCII-lowercased unit, ending where the reference must begin.
_NEGATION = re.compile(
    r"(^|[ \t(\[{<\"'`*,;:>])(not|never|cannot|(do|does|did|wo|would|ca|could|should|must|is|are)n['\u2019]t)"
    r"[ \t]+(close[sd]?|fix(e[sd])?|resolve[sd]?)[ \t]*:?[ \t]*"
)
_IDENT_CHAR = re.compile(r"[0-9a-zA-Z_-]")
_SENTENCE_END = re.compile(r"[.!?]([^ \ta-zA-Z0-9][^ \t]*)?[ \t]+")
_CONTROL = re.compile(r"[\x01-\x08\x0b-\x1f\x7f]")


def _lower(text: str) -> str:
    return text.translate(_ASCII_LOWER)


def scrub_urls(text: str) -> str:
    """``scrub_urls``: every URL, with or without a scheme, blanked to a space. A run link's
    fragment is not an issue (round 3), and a schemeless host with a path, a query or a port is a
    URL too (rounds 5, 8, 10, 11); the owner part is tightened to what a login can hold."""
    return _URL_HOST.sub(" ", _URL_SCHEME.sub(" ", text))


def refs_of(unit: str, repo: str) -> list[str]:
    """``refs_of``: the distinct issue references in ``unit``, as written.

    The boundary BEFORE a reference is a whitelist -- the unit's start, whitespace, an opening
    bracket or quote, Markdown emphasis, a comma or semicolon -- because every blacklist of what a
    URL puts before a hash was outflanked by the next URL shape (rounds 5 and 7). A number starts
    at 1 (`#0` is prose, round 4). A boundary is owed AFTER the digits too (`#123abc` is a colour,
    round 9). `owner/name` may lead its name with punctuation (`github/.github`, round 2). This
    repository's qualified spelling is the bare one (round 5), and spellings are compared without
    case (round 6), so one issue named twice is one issue (round 3)."""
    rest = unit
    out: list[str] = []
    seen: set[str] = set()
    while (m := _REF.search(rest)) is not None:
        ref = m.group(0)
        rest = rest[m.end() :]
        ref = re.sub(r"^[^a-zA-Z0-9#]", "", ref, count=1)
        nxt = rest[:1]
        if nxt and re.fullmatch(r"[0-9a-zA-Z_-]", nxt):
            continue
        if repo and _lower(ref).startswith(_lower(repo) + "#"):
            ref = ref[len(repo) :]
        key = _lower(ref)
        if key in seen:
            continue
        seen.add(key)
        out.append(ref)
    return out


type FindingClass = Literal["sentence", "quoted", "negated"]


@dataclass(frozen=True)
class Finding:
    cls: FindingClass
    count: int
    refs: str
    sentence: str


def negated_refs(unit: str, repo: str) -> list[str]:
    """The distinct references a NEGATED closing keyword in ``unit`` names (``_NEGATION``, the
    module docstring's boundary): each the reference right after the keyword, with a boundary owed
    after its digits as ``refs_of`` owes one. ``unit`` is URL-scrubbed by the caller."""
    out: list[str] = []
    seen: set[str] = set()
    for m in _NEGATION.finditer(_lower(unit)):
        rest = unit[m.end() :]
        r = _REF.match(rest)
        if r is None or _IDENT_CHAR.fullmatch(rest[r.end() : r.end() + 1] or "."):
            continue
        for ref in refs_of(rest[: r.end()], repo):
            if _lower(ref) not in seen:
                seen.add(_lower(ref))
                out.append(ref)
    return out


def _shown(unit: str) -> str:
    # The sentence is contributor-controlled text on its way to a terminal: a control byte could
    # erase or forge the warning it appears in (round 13), so it is shown as `?`.
    shown = re.sub(r"^[ \t>*+-]+", "", unit, count=1)
    shown = re.sub(r"[ \t]+$", "", shown, count=1)
    shown = _CONTROL.sub("?", shown)
    if len(shown) > 200:
        shown = shown[:197] + "..."
    return shown


def _scan_unit(unit: str, quoted: bool, repo: str) -> list[Finding]:
    """The unit's findings: the keyword's (``sentence`` or ``quoted``), then a ``negated`` one."""
    unit = scrub_urls(unit)
    out: list[Finding] = []
    found = _keyword_finding(unit, quoted, repo)
    if found is not None:
        out.append(found)
    if not quoted:
        neg = negated_refs(unit, repo)
        if neg:
            out.append(Finding("negated", len(neg), " ".join(neg), _shown(unit)))
    return out


def _keyword_finding(unit: str, quoted: bool, repo: str) -> Finding | None:
    # URLs go BEFORE the keyword is located, so the keyword and the references are read off the
    # same text: a keyword in a URL path was a directive until round 16. The keyword's boundaries
    # are whitelists on both sides: `close-out` and `closed/tracker#10` bind nothing (round 6), a
    # non-ASCII letter after it makes another word (`fixés`, round 8), `_` is not a boundary
    # (`auto_closes_items`, round 13), and a dot is one only when no identifier character follows
    # (`fixes.md`, `fix._config`, rounds 14 and 15). The references are read FORWARD from the
    # keyword: GitHub's syntax is the keyword followed by the reference (round 15).
    m = _KEYWORD.search(_lower(unit))
    if m is None:
        return None
    refs = refs_of(unit[m.end() :], repo)
    if not refs:
        return None
    if len(refs) < 2 and not quoted:
        return None
    return Finding("quoted" if quoted else "sentence", len(refs), " ".join(refs), _shown(unit))


def _columns(text: str) -> int:
    col = 0
    for ch in text:
        if ch == " ":
            col += 1
        elif ch == "\t":
            col += 4 - (col % 4)
        else:
            break
    return col


def scan(text: str, repo: str, plain: bool) -> list[Finding]:
    """``awk -v repo=<repo> [-v plain=1] "$MULTI_CLOSE_FILTER" <<<"$text"``: the findings, in order.
    ``plain`` reads a COMMIT MESSAGE, where an indented line is quoted, not skipped as code."""
    findings: list[Finding] = []
    fence = False
    fence_ch = ""
    fence_len = 0
    for record in text.split("\n"):
        line = record[:-1] if record.endswith("\r") else record
        # Up to three leading columns are indentation and four make a CODE block, counted in
        # tab-expanded columns (rounds 4 and 6); an indented line is neither quote nor fence.
        indented = _columns(line) >= 4
        trimmed = re.sub(r"^[ \t]+", "", line, count=1)
        # A quote or fence inside a LIST ITEM is still one (round 3): markers are peeled, an ordered
        # one only up to nine digits (round 10), and four columns past a marker's one space of
        # padding are code inside the item (round 11).
        while not indented:
            if re.match(r"[-*+][ \t]", trimmed):
                trimmed = trimmed[2:]
            elif re.match(r"[0-9]+[.)][ \t]", trimmed):
                digits = len(trimmed) - len(trimmed.lstrip("0123456789"))
                if digits > 9:
                    break
                trimmed = trimmed[digits + 2 :]
            else:
                break
            if _columns(trimmed) >= 4:
                indented = True
                break
            trimmed = re.sub(r"^[ \t]+", "", trimmed, count=1)
        # A fence closes only on its OWN delimiter, at least as long as its opener, with nothing
        # but blanks after it (rounds 1 and 2); a backtick opener's info string holds no backtick
        # (round 6); and an indented delimiter neither opens nor closes one -- inside a fence it is
        # content, and leaving a fence open is the safe error (rounds 12 and 16).
        quoted = False
        if not indented and trimmed[:3] in ("```", "~~~"):
            fch = trimmed[0]
            flen = len(trimmed) - len(trimmed.lstrip(fch))
            frest = trimmed[flen:]
            if not fence:
                if fch != "`" or "`" not in frest:
                    fence = True
                    fence_ch = fch
                    fence_len = flen
                    quoted = True
            elif fch == fence_ch and flen >= fence_len and re.fullmatch(r"[ \t]*", frest):
                fence = False
                quoted = True
        if fence:
            quoted = True
        if not indented and trimmed.startswith(">"):
            quoted = True
        # An indented code block is not SCANNED (round 11) -- except in a commit message, which is
        # not Markdown: there an indented line is how a message quotes, and it closes all the same.
        if indented and not fence and not plain:
            continue
        if indented and not fence:
            quoted = True
        # Terminal punctuation followed by whitespace ends a unit, with no abbreviation rule (its
        # errors were false positives, round 5) and nothing enumerated between the stop and the
        # space -- anything not starting with an alphanumeric may stand there, which covers every
        # Markdown link form (rounds 3, 7, 8, 9) while a version number does not split.
        marked = _SENTENCE_END.sub(lambda mm: mm.group(0) + "\x01", line)
        for unit in marked.split("\x01"):
            findings.extend(_scan_unit(unit, quoted, repo))
    return findings


def _say(*parts: str) -> None:
    """``multi_close_say``: one line on BOTH streams, joined like ``warn``'s."""
    line = " ".join(parts)
    cli.say(line)
    warn(line)


type Binds = Literal["yes", "no", "unknown"]


class MultiClose:
    """``warn_multi_close``'s state across one merge's scans (the shell's MULTI_CLOSE_* globals):
    the last scan's findings and body, whether it ran at all, and whether it held a sentence finding."""

    def __init__(self, session: GhSession, repo: str) -> None:
        self.session = session
        self.repo = repo
        self.last: list[Finding] = []
        self.have = False
        self.body = ""
        self.strong = False
        self.binds: Binds = "unknown"
        self.err = ""

    def read_binds(self, pr: str) -> None:
        """``multi_close_binds``: does a body keyword bind on this merge -- is the PR's base the
        repository's default branch? Read every time (a PR can be retargeted during the wait)."""
        self.err = ""
        base = self.session.retry("read", ["api", f"repos/{self.repo}/pulls/{pr}", "--jq", '.base.ref // ""'])
        if not isinstance(base, GhOk) or not base.stdout:
            self.binds = "unknown"
            self.err = f"the PR base could not be read: {self.session.err_line()}"
            return
        default = self.session.retry("read", ["api", f"repos/{self.repo}", "--jq", '.default_branch // ""'])
        if not isinstance(default, GhOk) or not default.stdout:
            self.binds = "unknown"
            self.err = f"the default branch could not be read: {self.session.err_line()}"
            return
        self.binds = "yes" if base.stdout == default.stdout else "no"

    def deferred_note(self) -> str:
        """``multi_close_deferred_note``."""
        if self.have:
            return (
                "The closing-keyword scan above spoke for the body as it is NOW: a deferred merge lands"
                " whatever the body says at that later moment, and nothing here will be running to re-read it."
            )
        return (
            "And the closing-keyword scan did NOT read the body for this attempt, so nothing here says"
            " what a deferred merge will close when it lands."
        )

    def warn(self, pr: str, again: bool = False) -> None:
        """``warn_multi_close <pr> [again]``: a warning, never a gate."""
        repo = self.repo
        self.read_binds(pr)
        if self.binds == "no":
            if again and self.have and self.last:
                if self.strong:
                    _say(
                        f"CLOSING-KEYWORD WARNING WITHDRAWN: {repo}#{pr} no longer targets the",
                        "default branch, so the keywords above bind nothing on this merge.",
                    )
                else:
                    _say(
                        f"CLOSING-KEYWORD NOTICE WITHDRAWN: {repo}#{pr} no longer targets the default",
                        "branch, so the keyword flagged above binds nothing on this merge.",
                    )
            self.last = []
            self.strong = False
            self.body = ""
            self.have = False
            return
        result = self.session.retry("read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", '.body // ""'])
        if not isinstance(result, GhOk):
            self.have = False
            warn(
                f"could not read {repo}#{pr}'s body ({self.session.err_line()}); the closing-keyword scan did NOT run,",
                "so nothing here says this merge closes only what it means to.",
            )
            return
        body = result.stdout
        found = scan(body, repo, plain=False) if body else []
        n_sentence = sum(1 for f in found if f.cls == "sentence")
        n_negated = sum(1 for f in found if f.cls == "negated")
        n_quoted = sum(1 for f in found if f.cls == "quoted")
        strong = n_sentence + n_negated > 0
        if again and self.have:
            if body == self.body:
                if found:
                    if self.strong and n_quoted > 0:
                        _say(
                            f"CLOSING-KEYWORD WARNING: {repo}#{pr}'s body is UNCHANGED since the scan",
                            "above, so the merge closes the issues its WARNING listed;",
                        )
                        _say("  the line its NOTICE flagged is still there, and still claims nothing.")
                    elif self.strong:
                        _say(
                            f"CLOSING-KEYWORD WARNING: {repo}#{pr}'s body is UNCHANGED since the scan",
                            "above, so the merge closes what it listed.",
                        )
                    else:
                        _say(
                            f"CLOSING-KEYWORD NOTICE: {repo}#{pr}'s body is UNCHANGED since the scan",
                            "above; the line flagged there is the line that lands.",
                        )
                    if self.binds == "unknown":
                        _say(f"  ...though whether they bind could NOT be re-read: {self.err}.", "Unread is not inert.")
                return
            if not found:
                if self.last:
                    if self.strong:
                        _say(
                            f"CLOSING-KEYWORD WARNING WITHDRAWN: {repo}#{pr}'s body was edited since",
                            "the scan above and now binds no keyword to more than it names.",
                        )
                    else:
                        _say(
                            f"CLOSING-KEYWORD NOTICE WITHDRAWN: {repo}#{pr}'s body was edited since the",
                            "scan above and no longer carries a keyword in what reads as an example.",
                        )
                self.last = []
                self.strong = False
                self.body = body
                return
            if strong:
                _say(
                    f"CLOSING-KEYWORD WARNING: {repo}#{pr}'s body was EDITED since the scan above;",
                    "what this merge closes is below, not there.",
                )
            else:
                _say(
                    f"CLOSING-KEYWORD NOTICE: {repo}#{pr}'s body was EDITED since the scan above;",
                    "the line to read is below, not there.",
                )
        self.last = found
        self.body = body
        self.have = True
        self.strong = strong
        if not found:
            return
        for i, f in enumerate(found):
            if i == 0:
                if strong:
                    _say(f"CLOSING-KEYWORD WARNING: {repo}#{pr}'s body closes issues it does not look", "like it closes:")
                else:
                    _say(
                        f"CLOSING-KEYWORD NOTICE: {repo}#{pr}'s body carries a closing keyword in what",
                        "reads as an example:",
                    )
            if f.cls == "quoted":
                _say(f"  reads as a QUOTED or FENCED example, {f.count} reference(s): {f.refs}")
            elif f.cls == "negated":
                _say(f"  a NEGATED mention, which GitHub closes all the same, {f.count} issue(s): {f.refs}")
            else:
                _say(f"  ONE sentence, {f.count} issues: {f.refs}")
            _say(f"      {f.sentence}")
        if n_negated > 0:
            _say(
                "  GitHub's closing keywords do not read negation: \"does not close #N\" closes #N",
                "(ahrefs/ocannl#1647 was closed that way); say \"Refs #N\" or \"leaves #N open\" instead.",
            )
        _say(
            "  A closing keyword binds to EVERY #N in its sentence, and a quoted or",
            "fenced copy of an example binds the same way:",
        )
        _say(
            "  ludics-lite#205 was closed twice over exactly that, by a phase reference",
            "in #210 and then by #226 quoting it back.",
        )
        if n_quoted > 0:
            _say(
                "  A line is judged an example by a best-effort reading of the Markdown, not",
                "by a parser, so one flagged above",
            )
            _say("  may be ordinary prose. Read it; nothing is claimed about what it closes.")
        if not strong:
            return
        _say(
            "  If an issue listed above must stay OPEN, EDIT THE BODY now -- nothing has",
            "closed yet, and this scan runs before the merge.",
        )
        _say(
            "  If the merge has already landed by the time you read this, reopen it in the",
            "repository its own reference names",
        )
        _say(f"  (gh issue reopen <n> --repo <owner>/<name>; a bare #<n> is {repo}).")
        if self.binds == "unknown":
            _say(
                "  Whether these bind at all could NOT be read: a body keyword closes only on a",
                "merge into the repository default",
            )
            _say(f"  branch, and {self.err}. Unread is not inert.")
        if n_sentence == 0:
            _say("  This is a WARNING and not a gate: the scan reads the line's words, not what it means.")
            return
        _say(
            "  This is a WARNING and not a gate: one sentence closing two issues is",
            "sometimes exactly what was meant,",
        )
        _say("  and nothing readable from here tells that apart from the accident.")


def tsv_unescape(text: str) -> str:
    """``printf '%b'`` over an ``@tsv`` field: the four escapes @tsv makes, restored."""
    table = {"\\": "\\", "t": "\t", "n": "\n", "r": "\r"}
    return re.sub(r"\\(.)", lambda m: table.get(m.group(1), "\\" + m.group(1)), text, flags=re.DOTALL)


class SeriesClose:
    """``warn_series_close``'s state across one merge's attempts: the head whose series the last scan
    read whole (SERIES_READ), and the findings it printed (SERIES_LAST)."""

    def __init__(self, session: GhSession, repo: str) -> None:
        self.session = session
        self.repo = repo
        self.read = ""
        self.last = ""

    def deferred_note(self) -> str:
        """``series_deferred_note``."""
        if self.read:
            return (
                f"The commit-series scan read the series up to {self.read[:8]}; a push before the auto-merge"
                " fires lands messages nothing here reads."
            )
        return (
            "And the commit-series scan did NOT read the series, so nothing here says what its messages"
            " close when it lands."
        )

    def warn(self, pr: str, gated: str) -> None:
        """``warn_series_close <pr> <gated head>``: a warning, never a gate."""
        repo = self.repo
        self.read = ""
        meta = self.session.retry(
            "read", ["api", f"repos/{repo}/pulls/{pr}", "--jq", '[(.commits|tostring), (.head.sha // "")] | @tsv']
        )
        if not isinstance(meta, GhOk):
            warn(
                f"could not read {repo}#{pr}'s commit count ({self.session.err_line()}); the commit-series closing-keyword",
                "scan did NOT run, so nothing here says what the series' messages close.",
            )
            return
        count = meta.stdout.split("\t", 1)[0]
        parts = meta.stdout.split("\t", 1)
        head = parts[1] if len(parts) == 2 else meta.stdout
        if not re.fullmatch(r"[0-9]+", count):
            count = ""
        if not re.fullmatch(r"[0-9a-zA-Z-]+", head):
            head = ""
        if not count or not head or int(count) == 0:
            warn(
                f"{repo}#{pr}'s commit count and head did not parse ('{shell_quote(meta.stdout)}'); the",
                "commit-series closing-keyword scan did NOT run.",
            )
            return
        if head != gated:
            warn(
                f"{repo}#{pr}'s head is now {head[:8]}, not {gated[:8]}, the head the build signal was read for;",
                "the commit-series closing-keyword scan did NOT run, and the merge's head binding refuses.",
            )
            return
        if int(count) > 250:
            warn(
                f"{repo}#{pr} has {count} commits and the commits endpoint serves at most 250; the",
                "commit-series closing-keyword scan did NOT run rather than read a part as the whole.",
            )
            return
        rows_result = self.session.retry(
            "read",
            [
                "api",
                "--paginate",
                f"repos/{repo}/pulls/{pr}/commits?per_page=100",
                "--jq",
                '.[] | [.sha, .commit.message] | if all(type == "string") then @tsv\n'
                '          else error("a commit row without a string sha and message") end',
            ],
        )
        if not isinstance(rows_result, GhOk):
            warn(
                f"could not read {repo}#{pr}'s commits ({self.session.err_line()}); the commit-series closing-keyword",
                "scan did NOT run.",
            )
            return
        rows = rows_result.stdout
        n = count_nonempty(rows)
        last = rows.rsplit("\n", 1)[-1].split("\t", 1)[0]
        if n != int(count) or last != head:
            warn(
                f"{repo}#{pr}'s commits read answered {n} row(s) ending at {last[:8]}, while the PR states",
                f"{count} ending at {head[:8]}; a page is missing or the series moved between the reads, and",
                "the commit-series closing-keyword scan did NOT run.",
            )
            return
        findings = ""
        for row in rows.split("\n"):
            if not row:
                continue
            sha = row.split("\t", 1)[0]
            msg_parts = row.split("\t", 1)
            msg = tsv_unescape(msg_parts[1] if len(msg_parts) == 2 else row)
            for f in scan(msg, repo, plain=True):
                if f.cls == "quoted":
                    findings += (
                        f"  commit {sha[:8]}: a QUOTED, FENCED or INDENTED line, and it closes all the same,"
                        f" {f.count} issue(s): {f.refs}\n"
                    )
                elif f.cls == "negated":
                    findings += (
                        f"  commit {sha[:8]}: a NEGATED mention, and it closes all the same,"
                        f" {f.count} issue(s): {f.refs}\n"
                    )
                else:
                    findings += f"  commit {sha[:8]}: ONE sentence, {f.count} issues: {f.refs}\n"
                findings += f"      {f.sentence}\n"
        self.read = head
        if not findings:
            if self.last:
                _say(
                    f"CLOSING-KEYWORD WARNING WITHDRAWN: {repo}#{pr}'s commit",
                    "series, read again for this attempt, no longer carries the finding above.",
                )
            self.last = ""
            return
        if findings == self.last:
            return
        self.last = findings
        _say(f"CLOSING-KEYWORD WARNING: {repo}#{pr}'s commit series closes issues it does not look", "like it closes:")
        for row in findings.split("\n"):
            if row:
                _say(row)
        _say(
            "  A commit message is plain text: GitHub applies every keyword in it, a quoted or",
            "indented copy and a negated one (\"does not close #N\") included, once the commit reaches the",
            "default branch, and editing the PR body",
            "does not change it.",
        )
        _say(
            "  To keep an issue listed above OPEN, reword the commit (git rebase -i, then",
            "git push --force-with-lease) before merging; that moves the head, so the gate reads it again.",
        )
        _say(
            "  If the commit has already reached the default branch, reopen the issue in the",
            f"repository its own reference names (gh issue reopen <n> --repo <owner>/<name>; a bare #<n> is {repo}).",
        )
        _say("  This is a WARNING and not a gate: a commit may close exactly what it names.")

