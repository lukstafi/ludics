"""The reference native-Claude brief template that ``wave prep`` renders (ludics#1072).

Every wave's brief used to come from the newest wave's private ``common-*.md``, copied forward
outside the repository, so a step a PR retired lived on in it: #1078 retired the worker's Auto-fix
step from SKILL.md and native-claude.md, and its brief text survived only in the coordinator's
state directory, where no diff, review or check could see it. The template now ships in
``issue-wave/templates/`` (waveprep.py's header, THE PARTS, is its contract), and this check reads
it with the project part this repository renders into it, ``.github/wave-brief.md``.

WHAT IT READS, a fail-closed allowlist. The obligation exists when
``lib/ludics/fleetworker/waveprep.py``, the code that looks the template up, is a file (a tree
without it has no template to keep, as the suites' trees of copied prompts do not).
- THE FILES. ``issue-wave/templates/`` holds directories ``native-<kind>`` for a kind wave.json
  takes (claude, codex) and nothing else; ``native-claude`` is required; each holds exactly the
  parts waveprep's ``SHIPPED`` names, as regular files. Anything missing or extra fails.
- THE NAMES. Each shipped part, and the project part, renders through wavebrief's own ``render``
  with one value for each NAME it may use: ``common.md`` the built-ins every task is given (no
  ISSUE, no SOURCE, no leg NAME), waveprep's ``SHIPPED_VARS`` and PROJECT; a planning part those and
  ISSUE; the project part those of ``common.md`` but PROJECT. A placeholder outside its set fails,
  named by its part and line, as prep would refuse it.
- THE REFERENCES. In a backticked span, each blank-separated word that begins ``~/.claude/skills/``
  or ``~/ludics/`` (both read as this tree's root) or with a top-level entry of the tree and a
  ``/``, and is made of ``[A-Za-z0-9_.+*/-]`` only, names an existing file or directory (a ``*``
  word: one match at least). Where such a ``.md`` word's span is followed by ``, *<heading>*``
  (blanks and line breaks read as one blank), the file has a Markdown heading line with exactly
  that text.
- RETIRED. No part holds a line containing one of ``RETIRED``'s strings: the steps a PR retired
  from SKILL.md's *The brief*, each with that PR. The PR that retires a brief step adds its
  string here.

What it deliberately does NOT read: the prose's meaning; whether every item of SKILL.md's *The
brief* has a line in the template, or the template says it the same way (that is the review of the
one diff that now holds both); a word of any other shape (an absolute path, a relative ``../``,
a placeholder-built path); a heading named in any other form; wave directories, which are not in
the repository.
"""

import re

from ludics.checkprompts.tree import Report, Tree
from ludics.fleetworker.wave import BUILTIN
from ludics.fleetworker.waveprep import SHIPPED, SHIPPED_VARS
from ludics.fleetworker.wavebrief import Part, render

PREP = "lib/ludics/fleetworker/waveprep.py"
TEMPLATES = "issue-wave/templates"
KINDS = ("claude", "codex")
PROJECT_PART = ".github/wave-brief.md"
NOT_COMMON = frozenset({"ISSUE", "SOURCE", "LEGLINES", "LEG", "LEG_ID", "LEG_WT", "LEG_CHECKOUT"})
COMMON_NAMES = (BUILTIN - NOT_COMMON) | frozenset(SHIPPED_VARS)
PLANNING_NAMES = COMMON_NAMES | {"ISSUE"}
PROJECT_NAMES = COMMON_NAMES - {"PROJECT"}
RETIRED: tuple[tuple[str, str], ...] = (
    ("set_monitor", "#1078 retired the worker's Auto-fix step"),
    ("auto_fix", "#1078 retired the worker's Auto-fix step"),
    ("FLEET_AUTOFIX_OFF", "#1078 retired the worker's Auto-fix step"),
    ("Auto-fix off", "#1078 retired the worker's Auto-fix step"),
)
SPAN = re.compile(r"`([^`\n]+)`")
WORD = re.compile(r"[A-Za-z0-9_.+*/-]+")
HEADING_AFTER = re.compile(r"\A, \*([^*]+)\*")
HEADING_LINE = re.compile(r"#+[ \t]+(.*?)[ \t]*#*[ \t]*")


def check_brief_template(report: Report, tree: Tree) -> None:
    if not tree.is_file(PREP):
        return
    parts = template_files(report, tree)
    if parts is None:
        return
    if tree.is_file(PROJECT_PART):
        parts.append((PROJECT_PART, PROJECT_NAMES))
    bad = False
    for rel, allowed in parts:
        text = tree.read(rel)
        if text is None:
            report.ko(rel, "cannot be read")
            bad = True
            continue
        for problem in name_problems(rel, text, allowed) + reference_problems(tree, text) + retired_problems(text):
            report.ko(rel, problem)
            bad = True
    if not bad:
        report.ok(f"the brief template ({len(parts)} parts) renders, its references exist, and it holds no retired step")


def template_files(report: Report, tree: Tree) -> list[tuple[str, frozenset[str]]] | None:
    listed = tree.names(TEMPLATES)
    if listed is None:
        report.ko(PREP, f"{TEMPLATES}/ is missing: wave prep's shipped brief template lives there (waveprep.py, THE PARTS)")
        return None
    out: list[tuple[str, frozenset[str]]] = []
    bad = False
    for name in sorted(listed):
        if name not in {f"native-{k}" for k in KINDS} or tree.is_link(f"{TEMPLATES}/{name}"):
            report.ko(f"{TEMPLATES}/{name}", f"is no native-<kind> template directory (kinds: {', '.join(KINDS)})")
            bad = True
            continue
        inside = tree.names(f"{TEMPLATES}/{name}")
        if inside is None:
            report.ko(f"{TEMPLATES}/{name}", "is not a directory")
            bad = True
            continue
        for extra in sorted(set(inside) - set(SHIPPED)):
            report.ko(f"{TEMPLATES}/{name}/{extra}", f"is no part wave prep reads (it reads {', '.join(SHIPPED)})")
            bad = True
        for part in SHIPPED:
            rel = f"{TEMPLATES}/{name}/{part}"
            if not tree.is_file(rel) or tree.is_link(rel):
                report.ko(rel, "is missing, or no regular file: wave prep looks this shipped part up")
                bad = True
                continue
            out.append((rel, COMMON_NAMES if part == "common.md" else PLANNING_NAMES))
    if "native-claude" not in listed:
        report.ko(TEMPLATES, "has no native-claude/: the reference native-Claude brief")
        bad = True
    return None if bad else out


def name_problems(rel: str, text: str, allowed: frozenset[str]) -> list[str]:
    result = render([Part(rel, text)], {name: "x" for name in allowed})
    return result if isinstance(result, list) else []


def top_entries(tree: Tree) -> set[str]:
    return set(tree.names("") or [])


def reference_problems(tree: Tree, text: str) -> list[str]:
    problems: list[str] = []
    tops = top_entries(tree)
    for span in SPAN.finditer(text):
        for word in span.group(1).split():
            rel = referenced(word, tops)
            if rel is None:
                continue
            exists = bool(tree.glob(rel)) if "*" in rel else tree.is_file(rel) or tree.names(rel.rstrip("/")) is not None
            if not exists:
                problems.append(f"`{word}` names no file of this tree")
                continue
            if rel.endswith(".md") and span.group(1).strip() == word:
                after = HEADING_AFTER.match(" ".join(text[span.end():span.end() + 300].split()))
                if after and after.group(1) not in headings(tree, rel):
                    problems.append(f"`{word}`, *{after.group(1)}*: {rel} has no heading with that text")
    return problems


def referenced(word: str, tops: set[str]) -> str | None:
    for prefix in ("~/.claude/skills/", "~/ludics/"):
        if word.startswith(prefix):
            word = word[len(prefix):]
            break
    else:
        if word.split("/", 1)[0] not in tops or "/" not in word:
            return None
    if not WORD.fullmatch(word) or ".." in word.split("/"):
        return None
    return word


def headings(tree: Tree, rel: str) -> set[str]:
    found: set[str] = set()
    for line in (tree.read(rel) or "").split("\n"):
        match = HEADING_LINE.fullmatch(line)
        if match:
            found.add(match.group(1))
    return found


def retired_problems(text: str) -> list[str]:
    problems: list[str] = []
    for number, line in enumerate(text.split("\n"), 1):
        for needle, why in RETIRED:
            if needle in line:
                problems.append(f"line {number} holds {needle!r}, a retired brief step ({why})")
    return problems
