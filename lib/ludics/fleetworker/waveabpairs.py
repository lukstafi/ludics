"""``wave ab-pairs``: export blinded, area-matched PR pairs for dual-family judging (ludics#1274).

``wave ab`` stays strictly read-only. This sibling verb consumes ``wave ab``'s join — either from
one or more ``<wave.json>`` files in-process or from a saved ``wave ab --json`` v1 document — pairs
merged, non-reassigned PRs from two arms by changed-path overlap before reading any diff body,
scrubs model/profile names from the exported task text, randomises A/B sides with balanced counts
using a recorded seed, and writes the unblinding key apart from the pair directory:

    fleet-worker.sh wave ab-pairs (<wave.json>... | --from-json <ab.json>)
      --out <dir> --key <file>
      [--arms <armA> <armB>] [--group D1+D1/D2|D2|D2/D3+D3]
      [--max-pairs <N>] [--seed <int>] [--scrub <word>]...

WHAT IT READS (fail-closed allowlist):
  inputs        either ``<wave.json>...`` (via ``waveab.load_waves``, ``waveab.read_boards``,
                ``waveab.join_wave`` with ``no_github=True``; no lock, no lease) or
                ``--from-json <ab.json>`` (a ``wave ab --json`` v1 document: ``version == 1`` and
                its ``tasks`` / optional ``readings``).
  PR files      for eligible sample PRs only (merged, non-reassigned, complete arm, tier in
                ``waveab.GROUP_NAMES``, direct ``issue`` reference ``<owner>/<repo>#<N>``, valid
                ``repository`` and numeric ``pr``), batched GraphQL (``BATCH_SIZE`` PRs per call,
                subdivided on alias-level failure) reading ``state``, ``title``, ``createdAt``,
                ``mergedAt``, ``mergeCommit.oid`` and ``files(first: 100)`` (falling back to
                paginated REST ``repos/<owner>/<name>/pulls/<n>/files`` when ``hasNextPage`` is
                true). Rows whose board ``merge`` disagrees with GitHub ``mergeCommit.oid`` are
                skipped with a note.
  issue & diff  ONLY for tasks chosen into a pair: ``gh issue view <N> --repo <irepo> --json
                title,body,comments`` and ``gh pr diff <pr> --repo <repo>``, all through
                ``ludics.prreview.core.GhSession.retry("read", ...)``. Only issue comments whose
                ``createdAt`` is strictly earlier than the task's parseable ``launched_at`` are
                included, keeping pre-launch decisions while excluding the worker's own reconciled
                plan and landing comments (when ``launched_at`` is absent or unparseable, issue
                comments are omitted with a note rather than falling back to PR ``createdAt``).

WHAT IT WRITES, AND THE KEY-SEPARATION BOUNDARY:
  ``--out <dir>``   ``manifest.json`` (blinded index: ``version``, ``pairs`` with ``pair``,
                    ``repository``, ``group``, ``dir`` only) and ``<pair_id>/{A-task.md, A.diff,
                    B-task.md, B.diff}`` (diffs written with ``surrogateescape`` and ``newline=""``
                    to preserve non-UTF-8 bytes losslessly). Generated headers, filenames, manifest,
                    and stdout omit wave names, task IDs, arm labels, PR/issue numbers, branch
                    names, PR titles, PR bodies, commit messages, and the seed; self-references to
                    the selected task's own issue/PR/wave/task are redacted from both task prose
                    and diff hunks (below). Residual: the surrounding local checkout
                    (``@@CHECKOUT@@``) is not scrubbed and still contains merged files and project
                    docs (see ``issue-wave/references/ab-judging.md``).
  ``--key <file>``  published exclusively (via temp file + hard link, never replacing an existing
                    key) apart from ``--out``, while pairs are staged and cleaned up on any write
                    failure. Refused (exit 2) before any network or board read — and re-checked via
                    filesystem identity (``samefile``) before publication — whenever ``--key`` lies
                    inside or equals ``--out`` (including through symlinks or case-insensitive
                    spellings). Refused (exit 1) if ``--key`` already exists or ``--out`` already
                    exists as a file, symlink, or non-empty directory.

AREA MATCHING (project-neutral, before reading any diff):
  - Each changed file is classified into ``src`` vs non-``src`` (``*.md``, ``docs/``,
    ``*.expected``, ``/goldens/``, ``(^|/)(test|tests)/``, ``(^|/)test[-_][^/]*$``, ``_test.<ext>``).
    A PR's area profile uses its ``src`` files whenever it touches at least one, falling back to
    all changed files only for pure-test/doc/golden PRs so shared test directories do not mask
    source areas.
  - File churn weights ``max(1, additions + deletions)`` are normalised per PR as exact ``Fraction``
    shares summing to 1 (size-invariant). Similarity uses weighted Jaccard on exact files and on
    parent directories (``"."`` for root files).
  - Pairs form 1-to-1 within the same ``(repository, group)`` across the two selected arms (auto-
    selected when exactly two complete arms are eligible; ``--arms <armA> <armB>`` required when
    more than two complete arms are eligible). Two PRs may pair only when they share at least one
    parent directory (or exact file). Candidate edges are taken greedily in descending order of
    ``(file_score, dir_score, same_tier, same_host, same_wave)`` with deterministic ``(wave, task)``
    tie-break.

SIDE RANDOMISATION:
  - Controlled by ``random.Random(seed)`` (``--seed <int>``, else generated via ``secrets`` and
    recorded in ``--key``). Side assignments are balanced within +-1 across the exported pairs
    (half with arm1 as A, half with arm2 as A, coin flip for an odd count) and both side
    assignments and pair order are shuffled with the seeded RNG.

SCRUBBING BOUNDARY (closed allowlist of forms):
  - **What is scrubbed**:
    - Model, profile, vendor, branch, and ``Co-Authored-By`` forms (1–6, 8) apply to
      ``A-task.md`` and ``B-task.md`` (issue title, body, and pre-launch comments) only.
    - Selected-task self-references (form 7: the task's own issue/PR refs, short ``<name>#N``
      forms, GitHub ``/issues/<N>`` / ``/pull/<pr>`` URLs, wave ID, and task ID) apply to BOTH
      ``A-task.md``/``B-task.md`` AND ``A.diff``/``B.diff`` so odd/even issue-number parity cannot
      leak through comments or docstrings in exported diffs.
  - **Recognised forms (closed)**:
    1. ``Co-Authored-By:`` lines (``(?im)^Co-Authored-By:[^\\n]*$`` -> ``Co-Authored-By: [agent]``).
    2. Arm-prefixed branch names (``(?i)(?<![A-Za-z0-9_])(?:codex|claude|gemini)/[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?``
       -> ``[branch]``).
    3. Dynamic terms (sorted longest-first, case-insensitive, bounded by ``(?<![A-Za-z0-9_])`` /
       ``(?![A-Za-z0-9_])`` -> ``[agent]``): each exported arm's ``model`` and ``model.split("/")[0]``,
       wave ``profiles`` keys of length >= 3 (when loaded from wave files), and any explicit
       ``--scrub <word>`` arguments.
    4. Versioned model IDs (``gpt-<ver>...``, ``claude-(?:opus|sonnet|haiku|<n>)...``,
       ``gemini-<ver>...``, case-insensitive, boundary-guarded -> ``[agent]``).
    5. Named model + version (``(?:opus|sonnet|haiku) <ver>``, case-insensitive -> ``[agent]``).
    6. Named agents, families, profiles, and vendors (``Google DeepMind``, ``DeepMind``, ``OpenAI``,
       ``Anthropic``, ``Antigravity``, ``Claude``, ``Codex``, ``Gemini``, ``GPT``, ``Opus``,
       ``Sonnet``, ``Haiku``, ``Sol``, ``Astra``, ``Neon``, ``Fable``, ``agy``, case-insensitive,
       boundary-guarded -> ``[agent]``).
    7. Selected-task self-references (in both task prose and diffs): full GitHub URLs to the
       selected issue or PR (``https?://github.com/<issue_repo>/issues/<N>...`` -> ``[this-issue]``,
       ``https?://github.com/<repo>/pull/<pr>...`` -> ``[this-pr]``), ``<issue_repo>#<N>`` /
       ``<issue_repo_name>#<N>`` / bare ``#<N>`` -> ``[this-issue]``, ``<repo>#<pr>`` /
       ``<repo_name>#<pr>`` / bare ``#<pr>`` -> ``[this-pr]``, wave ID -> ``[wave]``, and task ID
       -> ``[task]``. Unrelated cross-references stay intact.
    8. Adjacent ``[agent]`` tokens separated only by spaces, tabs, ``/``, ``:``, or ``-`` collapse
       to a single ``[agent]`` so multi-word and single-word names leave the same shape.
  - **What is deliberately NOT scrubbed**: model/profile/vendor names inside ``A.diff`` and
    ``B.diff`` (unified diffs carry no commit messages, branch names, or PR bodies, whereas
    scrubbing model words in code hunks corrupts identifiers such as OCaml ``sol`` variables or
    ludics ``claude``/``codex`` paths and identifiers); prose style; unrelated cross-referenced
    issue numbers; names outside the closed list and dynamic terms (pass ``--scrub <word>``); and
    the local checkout ``@@CHECKOUT@@`` read by judges for surrounding context.

Exit: 0 exported cleanly; 1 refused (missing/refused board, existing output/key, invalid JSON
input, <2 eligible arms, 0 matched pairs, or all selected pairs failed to fetch; nothing written);
2 usage (bad flags, key inside ``--out``, >2 arms without ``--arms``); 3 exported >=1 pair with
partial read errors recorded in ``--key``'s ``errors``; 4 anchor unreachable.
"""

import collections
import json
import os
import random
import re
import secrets
import shutil
import tempfile
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, assert_never, cast

from ludics import cli
from ludics.fleetworker import waveab
from ludics.fleetworker.config import Config
from ludics.fleetworker.identity import die
from ludics.fleetworker.transport import err
from ludics.fleetworker.wave import USAGE as WAVE_USAGE, Wave
from ludics.prreview import core as prcore

VERSION = 1
BATCH_SIZE = 20
MIN_PROFILE_SCRUB_LEN = 3

# Shipped prompt template under issue-wave/templates/ab/ (checked by checkprompts/brieftemplate.py).
AB_PART_NAMES: dict[str, frozenset[str]] = {
    "judge.md": frozenset({"REPO", "CHECKOUT", "DIR", "PAIR"}),
}

_NON_WORD_LEFT = r"(?<![A-Za-z0-9_])"
_NON_WORD_RIGHT = r"(?![A-Za-z0-9_])"

_CO_AUTHORED_RE = re.compile(r"(?im)^Co-Authored-By:[^\n]*$")
_ARM_BRANCH_RE = re.compile(rf"(?i){_NON_WORD_LEFT}(?:codex|claude|gemini)/[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?")
_VERSIONED_MODEL_RE = re.compile(
    rf"(?i){_NON_WORD_LEFT}(?:"
    r"gpt-[0-9]+(?:\.[0-9]+)*(?:-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*(?:/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?"
    r"|claude-(?:opus|sonnet|haiku|[0-9]+)(?:[A-Za-z0-9._/-]*[A-Za-z0-9_-])?"
    r"|gemini-[0-9]+(?:\.[0-9]+)*(?:-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*"
    rf"){_NON_WORD_RIGHT}"
)
_NAMED_MODEL_VER_RE = re.compile(
    rf"(?i){_NON_WORD_LEFT}(?:opus|sonnet|haiku)[ \t]+[0-9]+(?:\.[0-9]+)*{_NON_WORD_RIGHT}"
)
_NAMED_AGENTS_RE = re.compile(
    rf"(?i){_NON_WORD_LEFT}(?:"
    r"google[ \t]+deepmind|deepmind|openai|anthropic|antigravity|"
    r"claude|codex|gemini|gpt|opus|sonnet|haiku|sol|astra|neon|fable|agy"
    rf"){_NON_WORD_RIGHT}"
)
_COLLAPSE_AGENT_RE = re.compile(r"\[agent\](?:[ \t/:-]+\[agent\])+")

_TEST_PATH_RE = re.compile(r"(?:^|/)(?:test|tests)/|(?:^|/)test[-_][^/]*$|_test\.[^/]+$")
_INT_RE = re.compile(r"-?[0-9]+")
_POS_INT_RE = re.compile(r"[1-9][0-9]*")


@dataclass(frozen=True)
class Options:
    wave_paths: tuple[str, ...]
    from_json: str | None
    out_dir: str
    key_path: str
    arms: tuple[str, str] | None
    group: str | None
    max_pairs: int | None
    seed: int | None
    extra_scrub: tuple[str, ...]


@dataclass(frozen=True)
class Candidate:
    wave: str
    task: str
    tier: str | None
    group: str
    arm_label: str
    arm_kind: str
    arm_model: str
    agent_host: str | None
    repository: str
    pr: int
    merge: str | None
    issue_ref: str
    issue_repo: str
    issue_number: int
    launched_at: str | None
    task_dict: dict[str, Any]


@dataclass(frozen=True)
class FileChange:
    path: str
    additions: int
    deletions: int


@dataclass(frozen=True)
class PrMeta:
    state: str | None
    title: str
    created_at: str | None
    merged_at: str | None
    merge_commit: str | None
    files: tuple[FileChange, ...]


@dataclass(frozen=True)
class MatchedPair:
    repository: str
    group: str
    arm1: Candidate
    arm2: Candidate
    file_score: Fraction
    dir_score: Fraction
    shared_files: tuple[str, ...]
    shared_dirs: tuple[str, ...]

    @property
    def area_score(self) -> Fraction:
        return (3 * self.file_score + 2 * self.dir_score) / 5


@dataclass(frozen=True)
class SidePayload:
    candidate: Candidate
    pr_meta: PrMeta
    task_md: str
    diff_text: str
    scrub_hits: int
    diff_scrub_hits: int
    comments_included: int
    comments_excluded: int


# --- CLI parsing and target checks ----------------------------------------------------------------

def parse_args(args: list[str]) -> Options:
    wave_paths: list[str] = []
    from_json: str | None = None
    out_dir: str | None = None
    key_path: str | None = None
    arms: tuple[str, str] | None = None
    group: str | None = None
    max_pairs: int | None = None
    seed: int | None = None
    extra_scrub: list[str] = []

    i = 0
    while i < len(args):
        word = args[i]
        if word == "--from-json":
            if i + 1 >= len(args):
                die(f"wave ab-pairs: --from-json requires a path; usage: {WAVE_USAGE}")
            if from_json is not None:
                die("wave ab-pairs: --from-json may be given at most once")
            from_json = args[i + 1]
            i += 2
        elif word == "--out":
            if i + 1 >= len(args):
                die(f"wave ab-pairs: --out requires a directory path; usage: {WAVE_USAGE}")
            if out_dir is not None:
                die("wave ab-pairs: --out may be given at most once")
            out_dir = args[i + 1]
            i += 2
        elif word == "--key":
            if i + 1 >= len(args):
                die(f"wave ab-pairs: --key requires a file path; usage: {WAVE_USAGE}")
            if key_path is not None:
                die("wave ab-pairs: --key may be given at most once")
            key_path = args[i + 1]
            i += 2
        elif word == "--arms":
            if i + 2 >= len(args):
                die(f"wave ab-pairs: --arms requires two arm labels; usage: {WAVE_USAGE}")
            if arms is not None:
                die("wave ab-pairs: --arms may be given at most once")
            a1, a2 = args[i + 1].strip(), args[i + 2].strip()
            if not a1 or not a2 or a1 == a2:
                die("wave ab-pairs: --arms requires two distinct non-empty arm labels")
            arms = (a1, a2)
            i += 3
        elif word == "--group":
            if i + 1 >= len(args):
                die(f"wave ab-pairs: --group requires one of {', '.join(waveab.GROUP_NAMES)}")
            if group is not None:
                die("wave ab-pairs: --group may be given at most once")
            g = args[i + 1]
            if g not in waveab.GROUP_NAMES:
                die(f"wave ab-pairs: unknown --group {g!r} (expected one of {', '.join(waveab.GROUP_NAMES)})")
            group = g
            i += 2
        elif word == "--max-pairs":
            if i + 1 >= len(args):
                die("wave ab-pairs: --max-pairs requires a positive integer")
            if max_pairs is not None:
                die("wave ab-pairs: --max-pairs may be given at most once")
            raw_mp = args[i + 1]
            if not _POS_INT_RE.fullmatch(raw_mp):
                die(f"wave ab-pairs: --max-pairs takes a positive integer, not {raw_mp!r}")
            max_pairs = int(raw_mp)
            i += 2
        elif word == "--seed":
            if i + 1 >= len(args):
                die("wave ab-pairs: --seed requires an integer")
            if seed is not None:
                die("wave ab-pairs: --seed may be given at most once")
            raw_seed = args[i + 1]
            if not _INT_RE.fullmatch(raw_seed):
                die(f"wave ab-pairs: --seed takes an integer, not {raw_seed!r}")
            seed = int(raw_seed)
            i += 2
        elif word == "--scrub":
            if i + 1 >= len(args):
                die("wave ab-pairs: --scrub requires a non-empty word")
            term = args[i + 1].strip()
            if not term:
                die("wave ab-pairs: --scrub requires a non-empty word")
            extra_scrub.append(term)
            i += 2
        elif word.startswith("-"):
            die(f"wave ab-pairs: unknown option {word}; usage: {WAVE_USAGE}")
        else:
            wave_paths.append(word)
            i += 1

    if from_json is not None and wave_paths:
        die("wave ab-pairs: pass either <wave.json>... or --from-json <ab.json>, not both")
    if from_json is None and not wave_paths:
        die(f"wave ab-pairs: name at least one wave.json file or --from-json <ab.json>; usage: {WAVE_USAGE}")
    if not out_dir or not out_dir.strip():
        die(f"wave ab-pairs: --out <dir> is required; usage: {WAVE_USAGE}")
    if not key_path or not key_path.strip():
        die(f"wave ab-pairs: --key <file> is required; usage: {WAVE_USAGE}")

    return Options(
        wave_paths=tuple(wave_paths),
        from_json=from_json,
        out_dir=out_dir,
        key_path=key_path,
        arms=arms,
        group=group,
        max_pairs=max_pairs,
        seed=seed,
        extra_scrub=tuple(extra_scrub),
    )


def _deepest_existing_ancestor(path: str) -> tuple[str, tuple[str, ...]]:
    """Split ``path`` into (deepest existing ancestor, remaining non-existent path components)."""
    cur = os.path.realpath(path)
    tail: list[str] = []
    while not os.path.exists(cur):
        parent, name = os.path.split(cur)
        if parent == cur:
            break
        if name:
            tail.append(name)
        cur = parent
    return os.path.realpath(cur), tuple(reversed(tail))


def dir_is_case_insensitive(existing_dir: str) -> bool:
    """Probe whether ``existing_dir`` lies on a case-insensitive filesystem."""
    cur = existing_dir
    while True:
        parent, name = os.path.split(cur)
        if name and name.swapcase() != name:
            swapped = os.path.join(parent, name.swapcase())
            try:
                if os.path.exists(swapped) and os.path.samefile(cur, swapped):
                    return True
                return False
            except OSError:
                return False
        if parent == cur:
            return False
        cur = parent


def _key_is_inside_out(out_dir: str, key_path: str) -> bool:
    out_real = os.path.realpath(out_dir)
    key_real = os.path.realpath(key_path)
    try:
        if os.path.commonpath([out_real, key_real]) == out_real:
            return True
    except ValueError:
        pass

    # If out_dir already exists, check filesystem identity against every existing ancestor of key_path.
    if os.path.exists(out_real):
        anc = key_real
        while True:
            if os.path.exists(anc):
                try:
                    if os.path.samefile(out_real, anc):
                        return True
                except OSError:
                    pass
            parent = os.path.dirname(anc)
            if parent == anc:
                break
            anc = parent

    # Handle not-yet-created path segments on case-insensitive volumes (e.g. macOS APFS).
    out_anc, out_tail = _deepest_existing_ancestor(out_dir)
    key_anc, key_tail = _deepest_existing_ancestor(key_path)
    try:
        same_anc = os.path.samefile(out_anc, key_anc)
    except OSError:
        same_anc = False
    if same_anc and dir_is_case_insensitive(out_anc):
        out_cf = tuple(p.casefold() for p in out_tail)
        key_cf = tuple(p.casefold() for p in key_tail)
        if len(key_cf) >= len(out_cf) and key_cf[: len(out_cf)] == out_cf:
            return True
    return False


def validate_targets(out_dir: str, key_path: str) -> int | None:
    """Enforce key separation (exit 2) and non-overwrite (exit 1) before any read."""
    if _key_is_inside_out(out_dir, key_path):
        die(f"wave ab-pairs: --key ({key_path}) must live outside --out ({out_dir})")
    if os.path.isdir(key_path):
        die(f"wave ab-pairs: --key ({key_path}) is a directory")
    if os.path.lexists(key_path):
        err(f"WAVE AB-PAIRS REFUSED: key path already exists: {key_path}")
        return 1
    if os.path.lexists(out_dir):
        if os.path.islink(out_dir) or not os.path.isdir(out_dir):
            err(f"WAVE AB-PAIRS REFUSED: output path already exists and is not a directory: {out_dir}")
            return 1
        try:
            existing = os.listdir(out_dir)
        except OSError as exc:
            err(f"WAVE AB-PAIRS REFUSED: cannot read output directory {out_dir}: {exc}")
            return 1
        if existing:
            err(f"WAVE AB-PAIRS REFUSED: output directory is not empty: {out_dir}")
            return 1
    return None


# --- input loading (wave.json... or wave ab --json) -----------------------------------------------

def _load_from_json(path: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]] | int:
    try:
        with open(path, encoding="utf-8") as f:
            raw: Any = json.load(f)
    except (OSError, ValueError) as exc:
        err(f"WAVE AB-PAIRS REFUSED: cannot read {path}: {exc}")
        return 1
    if not isinstance(raw, dict):
        err(f"WAVE AB-PAIRS REFUSED: {path} is not a JSON object")
        return 1
    doc = cast(dict[str, Any], raw)
    if doc.get("version") != waveab.VERSION:
        err(f"WAVE AB-PAIRS REFUSED: {path} has unsupported version {doc.get('version')!r} (expected {waveab.VERSION})")
        return 1
    tasks_raw: Any = doc.get("tasks")
    if not isinstance(tasks_raw, list):
        err(f"WAVE AB-PAIRS REFUSED: {path} is missing a tasks list")
        return 1
    tasks = [cast(dict[str, Any], t) for t in cast(list[Any], tasks_raw) if isinstance(t, dict)]
    readings_raw: Any = doc.get("readings")
    readings = (
        [cast(dict[str, Any], r) for r in cast(list[Any], readings_raw) if isinstance(r, dict)]
        if isinstance(readings_raw, list)
        else []
    )
    notes: list[str] = []
    return tasks, readings, notes


def _load_from_waves(
    cfg: Config, wave_paths: tuple[str, ...]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], list[str]] | int:
    waves: list[Wave] = waveab.load_waves(list(wave_paths))
    boards_or_rc = waveab.read_boards(cfg, waves, label="WAVE AB-PAIRS")
    if isinstance(boards_or_rc, int):
        return boards_or_rc
    boards = boards_or_rc
    notes: list[str] = []
    all_tasks: list[waveab.Task] = []
    for w, rows in boards:
        all_tasks.extend(waveab.join_wave(w, rows, [], {}, True, notes))
    doc = waveab.build_document(waves, all_tasks, True, [], [])
    profile_terms: list[str] = []
    for w in waves:
        for pname, prof in w.profiles.items():
            if len(pname) >= MIN_PROFILE_SCRUB_LEN:
                profile_terms.append(pname)
            if prof.model:
                profile_terms.append(prof.model)
                head = prof.model.split("/", 1)[0]
                if head:
                    profile_terms.append(head)
    return (
        cast(list[dict[str, Any]], doc["tasks"]),
        cast(list[dict[str, Any]], doc["readings"]),
        notes,
        profile_terms,
    )


def select_candidates(
    task_dicts: list[dict[str, Any]], group_filter: str | None, notes: list[str]
) -> tuple[list[Candidate], list[dict[str, Any]]]:
    """Filter ``wave ab --json`` tasks to pairable candidates; record every skipped merged task."""
    eligible: list[Candidate] = []
    skipped: list[dict[str, Any]] = []

    for td in task_dicts:
        wave_name = waveab.text_or_none(td.get("wave")) or "<unknown>"
        task_name = waveab.text_or_none(td.get("task")) or "<unnamed>"
        phase = waveab.text_or_none(td.get("phase")) or "unknown"
        reason = waveab.text_or_none(td.get("reassignment_reason"))
        in_sample = td.get("in_sample") is True or (phase == "merged" and reason is None)
        if not in_sample:
            if phase == "merged" and reason is not None:
                skipped.append({"wave": wave_name, "task": task_name, "why": f"reassigned ({reason})"})
            continue

        group = waveab.text_or_none(td.get("group")) or waveab.UNTIERED
        if group not in waveab.GROUP_NAMES:
            skipped.append({"wave": wave_name, "task": task_name, "why": f"tier group {group!r} excluded"})
            continue
        if group_filter is not None and group != group_filter:
            continue

        arm_raw: Any = td.get("arm")
        if not isinstance(arm_raw, dict):
            skipped.append({"wave": wave_name, "task": task_name, "why": "missing arm"})
            continue
        arm_d = cast(dict[str, Any], arm_raw)
        arm_label = waveab.text_or_none(arm_d.get("label")) or ""
        arm_kind = waveab.text_or_none(arm_d.get("kind")) or "-"
        arm_model = waveab.text_or_none(arm_d.get("model")) or "-"
        if arm_d.get("complete") is not True or not arm_label:
            skipped.append({"wave": wave_name, "task": task_name, "why": f"incomplete arm {arm_label or '-'}"})
            continue

        repo = waveab.text_or_none(td.get("repository"))
        pr_raw = td.get("pr")
        pr_str = str(pr_raw).strip() if isinstance(pr_raw, (str, int)) and not isinstance(pr_raw, bool) else ""
        if not repo or not waveab.REPO_NAME.fullmatch(repo) or not waveab.PR_NUMBER.fullmatch(pr_str):
            skipped.append({"wave": wave_name, "task": task_name, "why": "missing valid repository/pr"})
            continue

        issue_source = waveab.text_or_none(td.get("issue_source"))
        if issue_source != "issue":
            skipped.append({
                "wave": wave_name,
                "task": task_name,
                "why": "post-wave --source task (no direct issue)" if issue_source == "source" else "no direct issue",
            })
            continue

        issue_ref = waveab.text_or_none(td.get("issue"))
        if issue_ref and waveab.ISSUE_REF.fullmatch(issue_ref):
            irepo, inum_s = issue_ref.rsplit("#", 1)
            inum = int(inum_s)
        else:
            skipped.append({
                "wave": wave_name,
                "task": task_name,
                "why": "missing full issue reference (<owner>/<repo>#<N>); regenerate wave ab --json",
            })
            continue

        eligible.append(Candidate(
            wave=wave_name,
            task=task_name,
            tier=waveab.text_or_none(td.get("tier")),
            group=group,
            arm_label=arm_label,
            arm_kind=arm_kind,
            arm_model=arm_model,
            agent_host=waveab.text_or_none(td.get("agent_host")),
            repository=repo,
            pr=int(pr_str),
            merge=waveab.text_or_none(td.get("merge")),
            issue_ref=issue_ref,
            issue_repo=irepo,
            issue_number=inum,
            launched_at=waveab.text_or_none(td.get("launched_at")),
            task_dict=td,
        ))

    return eligible, skipped


def resolve_arms(candidates: list[Candidate], requested: tuple[str, str] | None) -> tuple[str, str] | int:
    present = sorted({c.arm_label for c in candidates})
    if requested is not None:
        a1, a2 = requested
        missing = [a for a in (a1, a2) if a not in present]
        if missing:
            avail = ", ".join(present) if present else "(none)"
            err(f"WAVE AB-PAIRS REFUSED: --arms names arm(s) with no eligible tasks: {', '.join(missing)} (available: {avail})")
            return 1
        return a1, a2
    if len(present) < 2:
        avail = ", ".join(present) if present else "none"
        err(f"WAVE AB-PAIRS REFUSED: need two eligible complete arms to pair (found {len(present)}: {avail})")
        return 1
    if len(present) > 2:
        die(
            f"wave ab-pairs: found {len(present)} complete arms ({', '.join(present)});"
            " pass --arms <armA> <armB> to select two"
        )
    return present[0], present[1]


# --- GitHub readers (PR files before pairing; issue + diff only for selected pairs) ---------------

def _files_batch_query(chunk: list[tuple[str, int]]) -> str:
    parts: list[str] = []
    for idx, (repo, num) in enumerate(chunk):
        owner, name = repo.split("/", 1)
        parts.append(
            f"p{idx}: repository(owner: {json.dumps(owner)}, name: {json.dumps(name)}) {{"
            f" pullRequest(number: {num}) {{"
            " number state title createdAt mergedAt mergeCommit { oid }"
            " files(first: 100) { pageInfo { hasNextPage } nodes { path additions deletions } }"
            " } }"
        )
    return "query { " + " ".join(parts) + " }"


def _parse_paginated_json_arrays(stdout: str) -> list[dict[str, Any]] | None:
    """Decode one or more concatenated JSON arrays from ``gh api --paginate``."""
    dec = json.JSONDecoder()
    pos = 0
    n = len(stdout)
    out: list[dict[str, Any]] = []
    while pos < n:
        while pos < n and stdout[pos].isspace():
            pos += 1
        if pos >= n:
            break
        try:
            obj, end = dec.raw_decode(stdout, pos)
        except ValueError:
            return None
        if not isinstance(obj, list):
            return None
        for item in cast(list[Any], obj):
            if isinstance(item, dict):
                out.append(cast(dict[str, Any], item))
        pos = end
    return out


def _rest_pr_files(
    session: prcore.GhSession, repo: str, num: int, errors: list[dict[str, str]]
) -> tuple[FileChange, ...] | None:
    res = session.retry("read", ["api", "--paginate", f"repos/{repo}/pulls/{num}/files"])
    match res:
        case prcore.GhOk(stdout=stdout):
            items = _parse_paginated_json_arrays(stdout)
            if items is None:
                errors.append({"source": "github", "pr": f"{repo}#{num}", "why": "REST files response was not a JSON array"})
                return None
            changes: list[FileChange] = []
            for item in items:
                path = waveab.text_or_none(item.get("filename"))
                if not path:
                    continue
                add_raw = item.get("additions")
                del_raw = item.get("deletions")
                adds = add_raw if isinstance(add_raw, int) and not isinstance(add_raw, bool) and add_raw >= 0 else 0
                dels = del_raw if isinstance(del_raw, int) and not isinstance(del_raw, bool) and del_raw >= 0 else 0
                changes.append(FileChange(path, adds, dels))
            return tuple(changes)
        case prcore.GhFailed() | prcore.GhUnanswered():
            why = session.err_line() or "GitHub REST PR files read failed"
            errors.append({"source": "github", "pr": f"{repo}#{num}", "why": why})
            return None
        case _:
            assert_never(res)


def _fetch_files_chunk(
    session: prcore.GhSession,
    chunk: list[tuple[str, int]],
    out: dict[tuple[str, int], PrMeta],
    errors: list[dict[str, str]],
) -> None:
    query = _files_batch_query(chunk)
    result = session.retry("read", ["api", "graphql", "-f", f"query={query}"])
    match result:
        case prcore.GhOk(stdout=stdout):
            try:
                decoded: Any = json.loads(stdout)
            except ValueError as exc:
                for repo, num in chunk:
                    errors.append({"source": "github", "pr": f"{repo}#{num}", "why": f"GraphQL response was not JSON ({exc})"})
                return
            if not isinstance(decoded, dict):
                for repo, num in chunk:
                    errors.append({"source": "github", "pr": f"{repo}#{num}", "why": "GraphQL response was not a JSON object"})
                return
            data_raw: Any = cast(dict[str, Any], decoded).get("data")
            data = cast(dict[str, Any], data_raw) if isinstance(data_raw, dict) else {}
            for idx, (repo, num) in enumerate(chunk):
                repo_node: Any = data.get(f"p{idx}")
                pr_raw: Any = cast(dict[str, Any], repo_node).get("pullRequest") if isinstance(repo_node, dict) else None
                if not isinstance(pr_raw, dict):
                    errors.append({"source": "github", "pr": f"{repo}#{num}", "why": "pullRequest absent in GraphQL response"})
                    continue
                pr_obj = cast(dict[str, Any], pr_raw)
                mc: Any = pr_obj.get("mergeCommit")
                merge_oid = waveab.text_or_none(cast(dict[str, Any], mc).get("oid")) if isinstance(mc, dict) else None

                files_conn: Any = pr_obj.get("files")
                files: tuple[FileChange, ...] | None = None
                if isinstance(files_conn, dict):
                    fdict = cast(dict[str, Any], files_conn)
                    fpage: Any = fdict.get("pageInfo")
                    fnodes: Any = fdict.get("nodes")
                    has_next = not (isinstance(fpage, dict) and cast(dict[str, Any], fpage).get("hasNextPage") is False)
                    if not has_next and isinstance(fnodes, list):
                        parsed: list[FileChange] = []
                        for node in cast(list[Any], fnodes):
                            if not isinstance(node, dict):
                                continue
                            nd = cast(dict[str, Any], node)
                            fpath = waveab.text_or_none(nd.get("path"))
                            if not fpath:
                                continue
                            a_raw, d_raw = nd.get("additions"), nd.get("deletions")
                            adds = a_raw if isinstance(a_raw, int) and not isinstance(a_raw, bool) and a_raw >= 0 else 0
                            dels = d_raw if isinstance(d_raw, int) and not isinstance(d_raw, bool) and d_raw >= 0 else 0
                            parsed.append(FileChange(fpath, adds, dels))
                        files = tuple(parsed)
                if files is None:
                    files = _rest_pr_files(session, repo, num, errors)
                    if files is None:
                        continue

                title_raw: Any = pr_obj.get("title")
                title = title_raw.strip() if isinstance(title_raw, str) else ""
                out[(repo, num)] = PrMeta(
                    state=waveab.text_or_none(pr_obj.get("state")),
                    title=title,
                    created_at=waveab.text_or_none(pr_obj.get("createdAt")),
                    merged_at=waveab.text_or_none(pr_obj.get("mergedAt")),
                    merge_commit=merge_oid,
                    files=files,
                )
        case prcore.GhFailed():
            if len(chunk) > 1:
                mid = len(chunk) // 2
                _fetch_files_chunk(session, chunk[:mid], out, errors)
                _fetch_files_chunk(session, chunk[mid:], out, errors)
                return
            why = session.err_line() or "GitHub GraphQL call failed"
            for repo, num in chunk:
                errors.append({"source": "github", "pr": f"{repo}#{num}", "why": why})
        case prcore.GhUnanswered():
            why = session.err_line() or "GitHub GraphQL call did not answer"
            for repo, num in chunk:
                errors.append({"source": "github", "pr": f"{repo}#{num}", "why": why})
        case _:
            assert_never(result)


def read_pr_files(
    session: prcore.GhSession, targets: list[tuple[str, int]], errors: list[dict[str, str]]
) -> dict[tuple[str, int], PrMeta]:
    out: dict[tuple[str, int], PrMeta] = {}
    for start in range(0, len(targets), BATCH_SIZE):
        _fetch_files_chunk(session, targets[start : start + BATCH_SIZE], out, errors)
    return out


# --- area matching --------------------------------------------------------------------------------

def is_src_path(path: str) -> bool:
    norm = path.lstrip("/")
    if norm.endswith(".expected") or "/goldens/" in f"/{norm}":
        return False
    if norm.endswith(".md") or norm.startswith("docs/"):
        return False
    if _TEST_PATH_RE.search(norm):
        return False
    return True


def _parent_dir(path: str) -> str:
    norm = path.strip("/")
    return norm.rsplit("/", 1)[0] if "/" in norm else "."


def area_profile(files: tuple[FileChange, ...]) -> tuple[dict[str, Fraction], dict[str, Fraction]]:
    """Normalised churn-weighted file and parent-dir shares (src-first, exact Fractions)."""
    if not files:
        return {}, {}
    selected = [f for f in files if is_src_path(f.path)]
    if not selected:
        selected = list(files)
    weights = [max(1, f.additions + f.deletions) for f in selected]
    total = sum(weights)
    file_shares: dict[str, Fraction] = collections.defaultdict(Fraction)
    dir_shares: dict[str, Fraction] = collections.defaultdict(Fraction)
    for f, w in zip(selected, weights):
        share = Fraction(w, total)
        file_shares[f.path] += share
        dir_shares[_parent_dir(f.path)] += share
    return dict(file_shares), dict(dir_shares)


def weighted_jaccard(a: dict[str, Fraction], b: dict[str, Fraction]) -> Fraction:
    keys = set(a) | set(b)
    if not keys:
        return Fraction(0)
    num = sum((min(a.get(k, Fraction(0)), b.get(k, Fraction(0))) for k in keys), Fraction(0))
    den = sum((max(a.get(k, Fraction(0)), b.get(k, Fraction(0))) for k in keys), Fraction(0))
    return num / den if den else Fraction(0)


def match_pairs(
    candidates: list[Candidate],
    pr_meta: dict[tuple[str, int], PrMeta],
    arm1_label: str,
    arm2_label: str,
    max_pairs: int | None,
) -> tuple[list[MatchedPair], list[dict[str, Any]]]:
    """Deterministically pair arm1 and arm2 candidates within each (repository, group)."""
    profiles: dict[tuple[str, str], tuple[dict[str, Fraction], dict[str, Fraction]]] = {}
    buckets: dict[tuple[str, str], tuple[list[Candidate], list[Candidate]]] = collections.defaultdict(lambda: ([], []))
    for c in candidates:
        meta = pr_meta.get((c.repository, c.pr))
        if meta is None or not meta.files:
            continue
        profiles[(c.wave, c.task)] = area_profile(meta.files)
        if c.arm_label == arm1_label:
            buckets[(c.repository, c.group)][0].append(c)
        elif c.arm_label == arm2_label:
            buckets[(c.repository, c.group)][1].append(c)

    chosen: list[MatchedPair] = []
    used: set[tuple[str, str]] = set()

    for (repo, group) in sorted(buckets):
        left, right = buckets[(repo, group)]
        edges: list[tuple[tuple[Fraction, Fraction, int, int, int], tuple[str, str, str, str], MatchedPair]] = []
        for u in left:
            u_files, u_dirs = profiles[(u.wave, u.task)]
            for v in right:
                v_files, v_dirs = profiles[(v.wave, v.task)]
                shared_files = tuple(sorted(set(u_files) & set(v_files)))
                shared_dirs = tuple(sorted(set(u_dirs) & set(v_dirs)))
                if not shared_files and not shared_dirs:
                    continue
                f_score = weighted_jaccard(u_files, v_files)
                d_score = weighted_jaccard(u_dirs, v_dirs)
                rank = (
                    f_score,
                    d_score,
                    1 if (u.tier is not None and u.tier == v.tier) else 0,
                    1 if (u.agent_host is not None and u.agent_host == v.agent_host) else 0,
                    1 if u.wave == v.wave else 0,
                )
                tie = (u.wave, u.task, v.wave, v.task)
                edges.append((rank, tie, MatchedPair(repo, group, u, v, f_score, d_score, shared_files, shared_dirs)))

        edges.sort(key=lambda item: (-item[0][0], -item[0][1], -item[0][2], -item[0][3], -item[0][4], item[1]))
        for _, _, pair in edges:
            uk = (pair.arm1.wave, pair.arm1.task)
            vk = (pair.arm2.wave, pair.arm2.task)
            if uk in used or vk in used:
                continue
            used.add(uk)
            used.add(vk)
            chosen.append(pair)

    chosen.sort(
        key=lambda p: (
            -p.file_score,
            -p.dir_score,
            p.group,
            p.repository,
            p.arm1.wave,
            p.arm1.task,
            p.arm2.wave,
            p.arm2.task,
        )
    )
    dropped_by_cap: list[MatchedPair] = []
    if max_pairs is not None and len(chosen) > max_pairs:
        dropped_by_cap = chosen[max_pairs:]
        chosen = chosen[:max_pairs]
        for p in dropped_by_cap:
            used.discard((p.arm1.wave, p.arm1.task))
            used.discard((p.arm2.wave, p.arm2.task))

    unpaired: list[dict[str, Any]] = []
    capped_keys = {(p.arm1.wave, p.arm1.task) for p in dropped_by_cap} | {(p.arm2.wave, p.arm2.task) for p in dropped_by_cap}
    for c in candidates:
        if c.arm_label not in (arm1_label, arm2_label):
            continue
        if (c.repository, c.pr) not in pr_meta or not pr_meta[(c.repository, c.pr)].files:
            continue
        key = (c.wave, c.task)
        if key not in used:
            why = "excluded by --max-pairs cap" if key in capped_keys else "no unmatched counterpart sharing a directory in the same repo and tier group"
            unpaired.append({
                "wave": c.wave,
                "task": c.task,
                "arm": c.arm_label,
                "group": c.group,
                "repository": c.repository,
                "pr": str(c.pr),
                "why": why,
            })

    return chosen, unpaired


# --- closed-list scrubbing ------------------------------------------------------------------------

def collect_dynamic_scrub_terms(
    candidates: list[Candidate], profile_terms: list[str], extra_scrub: tuple[str, ...]
) -> tuple[str, ...]:
    """Collect unique dynamic scrub terms (arm models, model stems, wave profiles, --scrub), longest first."""
    raw: list[str] = list(profile_terms) + list(extra_scrub)
    for c in candidates:
        if c.arm_model and c.arm_model != "-":
            raw.append(c.arm_model)
            head = c.arm_model.split("/", 1)[0].strip()
            if head:
                raw.append(head)
    seen: set[str] = set()
    unique: list[str] = []
    for term in sorted((t.strip() for t in raw if t.strip()), key=lambda s: (-len(s), s.lower())):
        low = term.lower()
        if low not in seen:
            seen.add(low)
            unique.append(term)
    return tuple(unique)


def scrub_text(text: str, dynamic_terms: tuple[str, ...] = ()) -> tuple[str, int]:
    """Scrub model/profile/vendor/branch/Co-Authored-By forms per the closed allowlist in the header."""
    hits = 0

    text, n = _CO_AUTHORED_RE.subn("Co-Authored-By: [agent]", text)
    hits += n

    text, n = _ARM_BRANCH_RE.subn("[branch]", text)
    hits += n

    if dynamic_terms:
        dyn_pattern = re.compile(
            rf"(?i){_NON_WORD_LEFT}(?:" + "|".join(re.escape(t) for t in dynamic_terms) + rf"){_NON_WORD_RIGHT}"
        )
        text, n = dyn_pattern.subn("[agent]", text)
        hits += n

    text, n = _VERSIONED_MODEL_RE.subn("[agent]", text)
    hits += n

    text, n = _NAMED_MODEL_VER_RE.subn("[agent]", text)
    hits += n

    text, n = _NAMED_AGENTS_RE.subn("[agent]", text)
    hits += n

    text = _COLLAPSE_AGENT_RE.sub("[agent]", text)
    return text, hits


def scrub_self_references(text: str, cand: Candidate) -> tuple[str, int]:
    """Redact references to this task's own issue/PR/wave/task IDs (prose and diffs)."""
    hits = 0
    issue_repo_name = cand.issue_repo.rsplit("/", 1)[-1]
    pr_repo_name = cand.repository.rsplit("/", 1)[-1]
    url_tail = r"(?:/[A-Za-z0-9._/%-]*)?(?:#[A-Za-z0-9._-]+)?"
    replacements: list[tuple[re.Pattern[str], str]] = [
        # Canonical GitHub URLs first (before shorter owner/repo#N or #N patterns).
        (re.compile(rf"(?i)https?://github\.com/{re.escape(cand.issue_repo)}/issues/{cand.issue_number}(?![0-9]){url_tail}"), "[this-issue]"),
        (re.compile(rf"(?i)https?://github\.com/{re.escape(cand.repository)}/pull/{cand.pr}(?![0-9]){url_tail}"), "[this-pr]"),
        # Full owner/repo#N references.
        (re.compile(rf"(?i){_NON_WORD_LEFT}{re.escape(cand.issue_ref)}(?![0-9])"), "[this-issue]"),
        (re.compile(rf"(?i){_NON_WORD_LEFT}{re.escape(f'{cand.repository}#{cand.pr}')}(?![0-9])"), "[this-pr]"),
        # Short repo-name#N references (e.g. ludics#1274, proj#101).
        (re.compile(rf"(?i){_NON_WORD_LEFT}{re.escape(issue_repo_name)}#{cand.issue_number}(?![0-9])"), "[this-issue]"),
        (re.compile(rf"(?i){_NON_WORD_LEFT}{re.escape(pr_repo_name)}#{cand.pr}(?![0-9])"), "[this-pr]"),
        # Bare #N references.
        (re.compile(rf"(?<![A-Za-z0-9_/])#{cand.issue_number}(?![0-9])"), "[this-issue]"),
        (re.compile(rf"(?<![A-Za-z0-9_/])#{cand.pr}(?![0-9])"), "[this-pr]"),
    ]
    if cand.wave and cand.wave != "<unknown>":
        replacements.append((re.compile(rf"{_NON_WORD_LEFT}{re.escape(cand.wave)}{_NON_WORD_RIGHT}"), "[wave]"))
    if cand.task and cand.task != "<unnamed>" and len(cand.task) >= 2:
        replacements.append((re.compile(rf"{_NON_WORD_LEFT}{re.escape(cand.task)}{_NON_WORD_RIGHT}"), "[task]"))
    for pat, repl in replacements:
        text, n = pat.subn(repl, text)
        hits += n
    return text, hits


# --- issue & diff fetching for selected pairs -----------------------------------------------------

def fetch_side(
    session: prcore.GhSession,
    cand: Candidate,
    meta: PrMeta,
    dynamic_terms: tuple[str, ...],
    notes: list[str],
    errors: list[dict[str, str]],
) -> SidePayload | None:
    iss_res = session.retry(
        "read",
        ["issue", "view", str(cand.issue_number), "--repo", cand.issue_repo, "--json", "title,body,comments"],
    )
    match iss_res:
        case prcore.GhOk(stdout=stdout):
            try:
                decoded: Any = json.loads(stdout)
            except ValueError as exc:
                errors.append({"source": "issue", "issue": cand.issue_ref, "why": f"issue JSON parse failed ({exc})"})
                return None
            if not isinstance(decoded, dict):
                errors.append({"source": "issue", "issue": cand.issue_ref, "why": "issue response was not a JSON object"})
                return None
            iss = cast(dict[str, Any], decoded)
        case prcore.GhFailed() | prcore.GhUnanswered():
            why = session.err_line() or "gh issue view failed"
            errors.append({"source": "issue", "issue": cand.issue_ref, "why": why})
            return None
        case _:
            assert_never(iss_res)

    diff_res = session.retry("read", ["pr", "diff", str(cand.pr), "--repo", cand.repository])
    match diff_res:
        case prcore.GhOk(stdout=diff_out):
            if not diff_out.strip():
                errors.append({"source": "diff", "pr": f"{cand.repository}#{cand.pr}", "why": "PR diff is empty"})
                return None
            diff_text = diff_out if diff_out.endswith("\n") else diff_out + "\n"
        case prcore.GhFailed() | prcore.GhUnanswered():
            why = session.err_line() or "gh pr diff failed"
            errors.append({"source": "diff", "pr": f"{cand.repository}#{cand.pr}", "why": why})
            return None
        case _:
            assert_never(diff_res)

    title_raw: Any = iss.get("title")
    body_raw: Any = iss.get("body")
    title = title_raw.strip() if isinstance(title_raw, str) else ""
    body = body_raw if isinstance(body_raw, str) else ""

    # Only include comments strictly before launched_at; never fall back to PR createdAt, which is
    # after the worker's own pre-PR reconciled plan comment.
    cutoff = waveab.parse_iso(cand.launched_at)
    comments_raw: Any = iss.get("comments")
    comments_list = [cast(dict[str, Any], c) for c in cast(list[Any], comments_raw) if isinstance(c, dict)] if isinstance(comments_raw, list) else []
    included_bodies: list[str] = []
    excluded_count = 0
    if cutoff is None and comments_list:
        notes.append(f"{cand.wave}/{cand.task}: no parseable launched_at; {len(comments_list)} issue comment(s) omitted")
        excluded_count = len(comments_list)
    else:
        for cm in comments_list:
            c_at = waveab.parse_iso(waveab.text_or_none(cm.get("createdAt")))
            c_body = cm.get("body")
            if cutoff is not None and c_at is not None and c_at < cutoff and isinstance(c_body, str) and c_body.strip():
                included_bodies.append(c_body.strip())
            else:
                excluded_count += 1

    parts = [f"# Task: {title}\n\n{body.rstrip()}\n"]
    for cm_body in included_bodies:
        parts.append(f"\n---\n## Issue comment (before work started)\n\n{cm_body}\n")
    raw_task = "".join(parts)
    scrubbed_task, hits = scrub_text(raw_task, dynamic_terms)
    scrubbed_task, self_hits = scrub_self_references(scrubbed_task, cand)
    scrubbed_diff, diff_self_hits = scrub_self_references(diff_text, cand)

    return SidePayload(
        candidate=cand,
        pr_meta=meta,
        task_md=scrubbed_task,
        diff_text=scrubbed_diff,
        scrub_hits=hits + self_hits,
        diff_scrub_hits=diff_self_hits,
        comments_included=len(included_bodies),
        comments_excluded=excluded_count,
    )


# --- balanced seeded side assignment --------------------------------------------------------------

def assign_sides(count: int, seed: int) -> tuple[list[int], list[bool]]:
    """Return (shuffled_indices, arm1_is_A_flags) with A/B counts balanced within +-1."""
    rng = random.Random(seed)
    order = list(range(count))
    rng.shuffle(order)
    flags = [True] * (count // 2) + [False] * (count // 2)
    if count % 2 == 1:
        flags.append(rng.choice([True, False]))
    rng.shuffle(flags)
    return order, flags


# --- entry point ----------------------------------------------------------------------------------

def _side_key_record(payload: SidePayload) -> dict[str, Any]:
    c = payload.candidate
    return {
        "arm": c.arm_label,
        "wave": c.wave,
        "task": c.task,
        "tier": c.tier,
        "agent_host": c.agent_host,
        "issue": c.issue_ref,
        "pr": str(c.pr),
        "merge": c.merge,
        "title": payload.pr_meta.title,
        "scrub_hits": payload.scrub_hits,
        "diff_scrub_hits": payload.diff_scrub_hits,
        "comments_included": payload.comments_included,
        "comments_excluded": payload.comments_excluded,
        "task_row": c.task_dict,
    }


def cmd_ab_pairs(cfg: Config, args: list[str]) -> int:
    opts = parse_args(args)
    target_err = validate_targets(opts.out_dir, opts.key_path)
    if target_err is not None:
        return target_err

    profile_terms: list[str] = []
    if opts.from_json is not None:
        loaded_json = _load_from_json(opts.from_json)
        if isinstance(loaded_json, int):
            return loaded_json
        task_dicts, readings, notes = loaded_json
    else:
        loaded_waves = _load_from_waves(cfg, opts.wave_paths)
        if isinstance(loaded_waves, int):
            return loaded_waves
        task_dicts, readings, notes, profile_terms = loaded_waves

    candidates, skipped = select_candidates(task_dicts, opts.group, notes)
    arms_or_rc = resolve_arms(candidates, opts.arms)
    if isinstance(arms_or_rc, int):
        return arms_or_rc
    arm1_label, arm2_label = arms_or_rc

    selected_candidates = [c for c in candidates if c.arm_label in (arm1_label, arm2_label)]
    targets = sorted({(c.repository, c.pr) for c in selected_candidates})

    pr_cfg = prcore.load_config(cfg.env)
    session = prcore.GhSession(pr_cfg)
    errors: list[dict[str, str]] = []
    raw_pr_meta = read_pr_files(session, targets, errors)

    valid_meta: dict[tuple[str, int], PrMeta] = {}
    validated_candidates: list[Candidate] = []
    for c in selected_candidates:
        meta = raw_pr_meta.get((c.repository, c.pr))
        if meta is None:
            skipped.append({"wave": c.wave, "task": c.task, "why": "PR metadata/files unread"})
            continue
        if meta.state != "MERGED":
            notes.append(
                f"{c.wave}/{c.task}: GitHub {c.repository}#{c.pr} state is {meta.state or 'unknown'}, not MERGED; excluded"
            )
            skipped.append({"wave": c.wave, "task": c.task, "why": f"GitHub PR state is {meta.state or 'unknown'}, not MERGED"})
            continue
        if not waveab.merge_agrees(c.merge, meta.merge_commit):
            notes.append(
                f"{c.wave}/{c.task}: board merge {c.merge} disagrees with GitHub {c.repository}#{c.pr}"
                f" mergeCommit {meta.merge_commit}; excluded from pairing"
            )
            skipped.append({"wave": c.wave, "task": c.task, "why": "board/GitHub merge commit mismatch"})
            continue
        if not meta.files:
            skipped.append({"wave": c.wave, "task": c.task, "why": "PR has no changed files"})
            continue
        valid_meta[(c.repository, c.pr)] = meta
        validated_candidates.append(c)

    matched, unpaired = match_pairs(validated_candidates, valid_meta, arm1_label, arm2_label, opts.max_pairs)
    if not matched:
        err(f"WAVE AB-PAIRS REFUSED: no area-matched pairs found between {arm1_label!r} and {arm2_label!r}")
        return 1

    dynamic_terms = collect_dynamic_scrub_terms(validated_candidates, profile_terms, opts.extra_scrub)

    ready_pairs: list[tuple[MatchedPair, SidePayload, SidePayload]] = []
    for pair in matched:
        s1 = fetch_side(session, pair.arm1, valid_meta[(pair.arm1.repository, pair.arm1.pr)], dynamic_terms, notes, errors)
        s2 = fetch_side(session, pair.arm2, valid_meta[(pair.arm2.repository, pair.arm2.pr)], dynamic_terms, notes, errors)
        if s1 is None or s2 is None:
            notes.append(
                f"dropped pair ({pair.arm1.wave}/{pair.arm1.task} vs {pair.arm2.wave}/{pair.arm2.task}):"
                " issue or diff could not be read"
            )
            continue
        ready_pairs.append((pair, s1, s2))

    if not ready_pairs:
        err("WAVE AB-PAIRS REFUSED: all matched pairs failed to fetch issue or diff; nothing written")
        return 1

    seed = opts.seed if opts.seed is not None else secrets.randbelow(2**31)
    order, arm1_is_a = assign_sides(len(ready_pairs), seed)
    width = max(2, len(str(len(ready_pairs))))

    # Re-check targets immediately before staging and publishing.
    recheck = validate_targets(opts.out_dir, opts.key_path)
    if recheck is not None:
        return recheck

    out_abs = os.path.abspath(opts.out_dir)
    out_parent = os.path.dirname(out_abs) or "."
    key_abs = os.path.abspath(opts.key_path)
    key_parent = os.path.dirname(key_abs) or "."
    out_existed = os.path.isdir(out_abs)

    stage_dir: str | None = None
    tmp_key: str | None = None
    key_published = False
    try:
        os.makedirs(out_parent, exist_ok=True)
        os.makedirs(key_parent, exist_ok=True)
        # Re-verify key separation now that both parents exist on the real filesystem.
        if _key_is_inside_out(opts.out_dir, opts.key_path):
            die(f"wave ab-pairs: --key ({opts.key_path}) must live outside --out ({opts.out_dir})")

        stage_dir = tempfile.mkdtemp(prefix=".wave-ab-pairs-stage.", dir=out_parent)
        manifest_pairs: list[dict[str, Any]] = []
        key_pairs: list[dict[str, Any]] = []
        summary_lines: list[str] = []

        for out_idx, (src_idx, first_is_a) in enumerate(zip(order, arm1_is_a), 1):
            pair, s1, s2 = ready_pairs[src_idx]
            pid = f"P{out_idx:0{width}d}"
            side_a, side_b = (s1, s2) if first_is_a else (s2, s1)
            pdir = os.path.join(stage_dir, pid)
            os.makedirs(pdir, exist_ok=False)
            for fname, content in (("A-task.md", side_a.task_md), ("B-task.md", side_b.task_md)):
                with open(os.path.join(pdir, fname), "w", encoding="utf-8", errors="surrogateescape") as f:
                    f.write(content)
            for fname, content in (("A.diff", side_a.diff_text), ("B.diff", side_b.diff_text)):
                with open(os.path.join(pdir, fname), "w", encoding="utf-8", errors="surrogateescape", newline="") as f:
                    f.write(content)

            manifest_pairs.append({
                "pair": pid,
                "repository": pair.repository,
                "group": pair.group,
                "dir": pid,
            })
            key_pairs.append({
                "pair": pid,
                "repository": pair.repository,
                "group": pair.group,
                "area_score": round(float(pair.area_score), 4),
                "file_score": round(float(pair.file_score), 4),
                "dir_score": round(float(pair.dir_score), 4),
                "shared_files": list(pair.shared_files),
                "shared_dirs": list(pair.shared_dirs),
                "A": _side_key_record(side_a),
                "B": _side_key_record(side_b),
            })
            summary_lines.append(
                f"  {pid}  {pair.group}  {pair.repository}  area={float(pair.area_score):.3f}"
                f" (file={float(pair.file_score):.3f}, dir={float(pair.dir_score):.3f})"
            )

        manifest_doc = {"version": VERSION, "pairs": manifest_pairs}
        with open(os.path.join(stage_dir, "manifest.json"), "w", encoding="utf-8") as f:
            f.write(json.dumps(manifest_doc, ensure_ascii=False, indent=2) + "\n")

        # Publish the key exclusively (no-replace hard link) BEFORE exposing --out, so an
        # unwritable key path or concurrent exporter never leaves an unkeyed --out behind.
        fd, tmp_key = tempfile.mkstemp(prefix=".wave-ab-pairs-key.", dir=key_parent)
        try:
            key_doc = {
                "version": VERSION,
                "seed": seed,
                "arms": [arm1_label, arm2_label],
                "scrub_words": list(dynamic_terms),
                "out_dir": os.path.realpath(out_abs),
                "readings": readings,
                "pairs": key_pairs,
                "unpaired": unpaired,
                "skipped": skipped,
                "notes": notes,
                "errors": errors,
            }
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(key_doc, ensure_ascii=False, indent=2) + "\n")
                f.flush()
                os.fsync(f.fileno())
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise

        try:
            os.link(tmp_key, key_abs)
            key_published = True
        except FileExistsError:
            err(f"WAVE AB-PAIRS REFUSED: key path already exists: {opts.key_path}")
            return 1

        # Publish staged pairs into --out, rolling back moved entries if any rename fails so an
        # existing empty --out never remains partially populated without a key.
        moved_entries: list[str] = []
        if out_existed:
            if os.listdir(out_abs):
                raise FileExistsError(f"output directory is not empty: {opts.out_dir}")
            try:
                for entry in sorted(os.listdir(stage_dir)):
                    os.rename(os.path.join(stage_dir, entry), os.path.join(out_abs, entry))
                    moved_entries.append(entry)
            except OSError:
                for entry in reversed(moved_entries):
                    src = os.path.join(out_abs, entry)
                    try:
                        os.rename(src, os.path.join(stage_dir, entry))
                    except OSError:
                        if os.path.isdir(src) and not os.path.islink(src):
                            shutil.rmtree(src, ignore_errors=True)
                        else:
                            try:
                                os.unlink(src)
                            except OSError:
                                pass
                raise
            os.rmdir(stage_dir)
            stage_dir = None
        else:
            os.rename(stage_dir, out_abs)
            stage_dir = None

        # Final filesystem-identity check in case --out was created with an alias of key_parent.
        if _key_is_inside_out(out_abs, key_abs):
            if out_existed:
                for entry in reversed(moved_entries):
                    target = os.path.join(out_abs, entry)
                    if os.path.isdir(target) and not os.path.islink(target):
                        shutil.rmtree(target, ignore_errors=True)
                    else:
                        try:
                            os.unlink(target)
                        except OSError:
                            pass
            else:
                shutil.rmtree(out_abs, ignore_errors=True)
            die(f"wave ab-pairs: --key ({opts.key_path}) must live outside --out ({opts.out_dir})")
    except cli.Exit:
        if key_published:
            try:
                os.unlink(key_abs)
            except OSError:
                pass
        raise
    except OSError as exc:
        if key_published:
            try:
                os.unlink(key_abs)
            except OSError:
                pass
        err(f"WAVE AB-PAIRS REFUSED: failed to write export ({exc})")
        return 1
    finally:
        if tmp_key is not None:
            try:
                os.unlink(tmp_key)
            except OSError:
                pass
        if stage_dir is not None:
            shutil.rmtree(stage_dir, ignore_errors=True)

    # Never print the seed, arm labels, PR numbers, or issue numbers on stdout so the terminal log
    # cannot unblind the comparison; the seed is recorded in key.json only.
    cli.say(
        f"WAVE AB-PAIRS: exported {len(key_pairs)} pair(s) to {opts.out_dir}"
        f" (key: {opts.key_path}, unpaired: {len(unpaired)}, skipped: {len(skipped)})"
    )
    for line in summary_lines:
        cli.say(line)
    return 3 if errors else 0
