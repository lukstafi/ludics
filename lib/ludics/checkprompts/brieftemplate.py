"""The reference brief template that ``wave prep`` renders (ludics#1072).

Every wave's brief used to come from the newest wave's private ``common-*.md``, copied forward
outside the repository, so a step a PR retired lived on in it: #1078 retired the worker's Auto-fix
step from SKILL.md and native-claude.md, and its brief text survived only in the coordinator's
state directory, where no diff, review or check could see it. The template now ships in
``issue-wave/templates/`` (waveprep.py's header, THE PARTS, is its contract), and this check reads
it with the project part this repository renders into it, ``.github/wave-brief.md``.

WHAT IT READS, a fail-closed allowlist. The obligation exists when
``lib/ludics/fleetworker/waveprep.py``, the code that looks the template up, is a file (a tree
without it has no template to keep, as the suites' trees of copied prompts do not).
- THE FILES. ``issue-wave/templates/`` holds ``shared`` (waveprep's ``SHARED`` parts, exactly:
  the sections every transport's brief states once), directories ``native-<kind>`` and
  ``cli-<kind>`` for a kind wave.json takes (claude, codex), optionally ``review`` (the review
  checkpoint's prompt, wavereview.py), and nothing else. A kind's directory holds every one of
  waveprep's ``OWN`` parts, may hold its ``PLANNING`` parts, and holds nothing else: half a brief
  is not shipped. ``native-claude`` is required, with its planning parts, so with ``shared`` it is
  every common part. ``review`` holds exactly wavereview's parts. All are regular files; anything
  missing or extra fails.
- THE NAMES. Each shipped part, and the project part, renders through wavebrief's own ``render``
  with one value for each NAME it may use: a common part the built-ins every task is given (no
  ISSUE, no SOURCE, no leg NAME), waveprep's ``SHIPPED_VARS`` and PROJECT; a planning part those and
  ISSUE; the project part those of a common part but PROJECT; a ``review`` part the NAMEs
  wavereview's ``PART_NAMES`` gives it, and this repository's own review part,
  ``.github/review-checkpoint.md`` when it has one, wavereview's ``COMMON_NAMES``. A placeholder
  outside its set fails, named by its part and line, as prep (or ``wave review``) would refuse it.
- THE REFERENCES. In a backticked span, each blank-separated word that begins ``~/.claude/skills/``
  or ``~/ludics/`` (both read as this tree's root) or with a top-level entry of the tree and a
  ``/``, and is made of ``[A-Za-z0-9_.+*/-]`` only, names an existing file or directory (a ``*``
  word: one match at least). Where such a ``.md`` word's span is followed by ``, *<heading>*``
  (blanks and line breaks read as one blank), the file has a Markdown heading line with exactly
  that text.
- RETIRED. No part holds a line containing one of ``RETIRED``'s strings: the worker steps a PR
  retired from the brief, each with that PR. The PR that retires a brief step adds its
  string here.

What it deliberately does NOT read: the prose's meaning; whether the template states each rule a
worker needs (the template is where those rules live, and SKILL.md's *The brief* only says what a
task part adds: that is the review of the diff that changes either); a word of any other shape (an absolute path, a relative ``../``,
a placeholder-built path); a heading named in any other form; wave directories, which are not in
the repository.
"""

import re

from ludics.checkprompts.tree import Report, Tree
from ludics.fleetworker.wave import BUILTIN
from ludics.fleetworker.waveprep import OWN, PLANNING, SHARED, SHIPPED_VARS
from ludics.fleetworker.wavebrief import Part, render
from ludics.fleetworker.wavereview import COMMON_NAMES as REVIEW_NAMES, PART_NAMES as REVIEW_PART_NAMES

PREP = "lib/ludics/fleetworker/waveprep.py"
TEMPLATES = "issue-wave/templates"
KINDS = ("claude", "codex")
PROJECT_PART = ".github/wave-brief.md"
REVIEW = "review"
SHARED_DIR = "shared"
REQUIRED_KIND = "native-claude"
REVIEW_PROJECT_PART = ".github/review-checkpoint.md"
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
    if tree.is_file(REVIEW_PROJECT_PART):
        parts.append((REVIEW_PROJECT_PART, REVIEW_NAMES))
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
    kinds = {f"{transport}-{kind}" for transport in ("native", "cli") for kind in KINDS}
    for name in sorted(listed):
        if name not in kinds | {SHARED_DIR, REVIEW} or tree.is_link(f"{TEMPLATES}/{name}"):
            report.ko(f"{TEMPLATES}/{name}", f"is no template directory: native-<kind> or cli-<kind> (kinds: {', '.join(KINDS)}),"
                                             f" {SHARED_DIR} or {REVIEW}")
            bad = True
            continue
        inside = tree.names(f"{TEMPLATES}/{name}")
        if inside is None:
            report.ko(f"{TEMPLATES}/{name}", "is not a directory")
            bad = True
            continue
        reader = "wave review" if name == REVIEW else "wave prep"
        if name == REVIEW:
            allowed = required = tuple(REVIEW_PART_NAMES)
        elif name == SHARED_DIR:
            allowed = required = SHARED
        else:
            allowed, required = OWN + PLANNING, OWN + (PLANNING if name == REQUIRED_KIND else ())
        for extra in sorted(set(inside) - set(allowed)):
            report.ko(f"{TEMPLATES}/{name}/{extra}", f"is no part {reader} reads there (it reads {', '.join(allowed)})")
            bad = True
        for part in allowed:
            rel = f"{TEMPLATES}/{name}/{part}"
            if part not in inside and part not in required:
                continue
            if not tree.is_file(rel) or tree.is_link(rel):
                report.ko(rel, f"is missing, or no regular file: {reader} looks this shipped part up")
                bad = True
                continue
            out.append((rel, REVIEW_PART_NAMES[part] if name == REVIEW else PLANNING_NAMES if part in PLANNING else COMMON_NAMES))
    for needed, what in ((REQUIRED_KIND, "the reference native-Claude brief's own parts"),
                         (SHARED_DIR, "the parts every transport's brief shares")):
        if needed not in listed:
            report.ko(TEMPLATES, f"has no {needed}/: {what}")
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
