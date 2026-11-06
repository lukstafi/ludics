"""``farside-close``: a closed wave's far-side worktrees, removed through the board (ludics#981).

    farside-close <wave> [--task <task>]... [--regenerable <dir>]... [--remote <name>] [--dry-run]

Thirty-two far-side worktrees of one wave kept their ``_build`` on rog, about 300 GB, until a later
wave's runs died on a disk with 17 MB free. Local worktrees had a close-out; far-side ones had a
sentence. This verb is that close-out: it reads the ``farside`` key of each row of the wave's board
(``<box>:<path>`` words, native-workers.md) and judges each word by the gates a local worktree gets,
never asked to trust that a word is safe. It is the coordinator's: it needs the lease, unless
``--dry-run``, which runs every gate and removes nothing (it leaves only what the gates' fetch
brought into the object store). A HALT does not stop it: a halt launches nothing new, and this frees.

WHAT IT READS, a fail-closed allowlist. The ``farside`` key of a row of this board, each word
``<box>:<path>``, the box a fleet box and the path absolute with no ``.`` or ``..`` component (``none``
is no word). It takes no path from anywhere else: not a directory listing of the box, not ``git
worktree list``, so a worktree the board does not name is never touched, and a past wave's debris is
removed only by a coordinator who has written it on a board. A word of any other shape is reported
KEPT. A path holding a space cannot be written as a word; the key has no quoting.

THE GATES, in order; the first that fails keeps the worktree, and says why.
  - The row is done: its ``state`` is a done word (``takeover.DONE_STATES``). An unreadable or live
    state keeps it. A worktree a not-done row also names is kept.
  - No outstanding reservation refers to it: no record short of ``concluded`` is named by the row's
    ``standing`` or ``requests``, or carries the row's ``worker`` in this wave, or has this box as its
    execution host and a recorded checkout at or under the path. The registry is read once, first; a
    registry that cannot be read removes nothing (exit 4, or 1).
  - On the box (CLOSE below): the path is a directory and no symlink, the top of a LINKED worktree of
    a git repository, never a main checkout.
  - No leg holds it: the leg's own worktree lock (``leg.WORKTREE``), taken without waiting and held
    through the removal, so a leg that started before this cannot be removed from under, and one that
    starts during it is refused as ``another leg is using it``. A runner that outlived its far shell
    still holds that lock.
  - The tree is clean: nothing changed, staged or untracked, submodules included (``leg``'s ``dirt``).
  - No ignored data but what ``--regenerable`` names. Ignored files are the class a plain status
    does not show, and a removal takes them with the tree. ``--regenerable`` is post-merge-cleanup.sh's
    flag: repeatable, no default, the project's to say (OCANNL's AGENTS.md names ``_build``); each value
    ONE top-level directory, here wholly ignored (git reports it as one ``!! <dir>/`` entry, so no
    tracked file is in it, and a symlink never matches). Any other ignored path keeps the worktree.
  - HEAD is on a branch of the remote: a fresh ``git fetch`` of ``refs/heads/*`` from ``--remote``
    (``origin``), into a private ref namespace, ``refs/fleet-close/<pid>/``, removed again, so neither a
    box's stale remote-tracking ref nor a narrow fetch refspec can answer, and the served clone's own
    refs do not move. Bounded by FLEET_FETCH_TIMEOUT.

THE VERDICTS, one line per word on stdout, ``FARSIDE <verdict> <box>:<path> (<task>): <why>``:
  REMOVED       every gate passed; ``git worktree remove``, never ``--force``, so a locked worktree
                or one with initialized submodules is git's to refuse (KEPT, in git's words)
  TRIMMED       every gate passed but the last (the remote does not hold HEAD, or could not be
                asked), and ``--regenerable`` directories were there: they alone were removed, and
                the worktree stays, with its commits
  KEPT          a gate failed, or the removal did; nothing was removed
  GONE          no such path on the box: an earlier run's work, so a re-run is safe
  UNREACHABLE   the box did not answer; nothing is known of it (wake it, and re-run)
  WOULD-REMOVE, WOULD-TRIM  ``--dry-run``'s REMOVED and TRIMMED
Then ``FARSIDE CLOSE <wave>: <counts>``. Exit 0 when every word is REMOVED, GONE or WOULD-REMOVE
(no word at all included); 3 when one was kept or trimmed; 4 when a box or the anchor did not
answer; 1 for no board, an unreadable registry or a task the board does not have; 2 usage.

THE RECOVERY BOUNDARY. Each word stands alone, and a run writes neither the board nor the registry,
so the way on from any failure, a stopped run included, is to run it again: what went is GONE, what
stayed is judged afresh. Nothing is archived, so a KEPT worktree is exactly as it was, its reason on
the line for the coordinator to act on. Two things are not undone by a re-run. A ``git worktree
remove`` that fails partway (a permission error deep in the tree) has already deleted part of the
tree, and git drops the worktree's metadata regardless, so the next run reports it KEPT, no longer a
worktree: that path is a person's to look at. And a far shell killed mid-fetch leaves its
``refs/fleet-close/<pid>/`` behind: nothing reads them, ``git update-ref -d`` removes them.

WHAT IT DOES NOT JUDGE. A process with no leg around it working in the worktree (a shell, a CLI worker
of the box: ``fleet-worker.sh ls`` is the coordinator's check first); commits reachable only from the
worktree's reflog; a stash, which belongs to the repository and survives; a record that names neither
the row's ids nor the row's worker nor a checkout. It frees space on no box the board does not name,
and says nothing of how much it freed.
"""

import re
import shlex
from collections import Counter
from dataclasses import dataclass
from typing import Any, cast

from ludics import cli
from ludics.fleetworker.config import Config
from ludics.fleetworker.execution import field, jq_text, listing, recorded_checkout, records_of, same_checkout
from ludics.fleetworker.identity import die
from ludics.fleetworker.lease import anchor_gate
from ludics.fleetworker.leg import REMOTE, SECONDS, WORKTREE
from ludics.fleetworker.preflight import knob
from ludics.fleetworker.takeover import DONE_STATES, board_document, state_word
from ludics.fleetworker.transport import err, is_local, prelude, run_on

USAGE = "farside-close <wave> [--task <task>]... [--regenerable <dir>]... [--remote <name>] [--dry-run]"
REGENERABLE = re.compile(r"\.?[A-Za-z0-9_][A-Za-z0-9._-]*")  # one name: no separator, no `..`, no option
CLEARED = ("REMOVED", "GONE", "WOULD-REMOVE")  # the verdicts that leave nothing to look at
FAR_VERDICTS = ("REMOVED", "TRIMMED", "KEPT", "GONE", "WOULD-REMOVE", "WOULD-TRIM")

# The far side, after the prelude and leg.WORKTREE. Args: the worktree, the remote, the fetch's bound
# in seconds, dry (0|1), then the regenerable directories. Its stdout is one line, `<verdict><TAB><why>`,
# whatever it found; every other word goes to stderr.
CLOSE = WORKTREE + r"""wt=$(expand_tilde "$1") remote="$2" fetch_timeout="$3" dry="$4"; shift 4
ns="refs/fleet-close/$$"; cdir=""
verdict() {
  [ -z "$cdir" ] || git --git-dir="$cdir" for-each-ref --format='%(refname)' "$ns/" 2>/dev/null | while IFS= read -r r; do
    git --git-dir="$cdir" update-ref -d "$r" >/dev/null 2>&1
  done
  printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | tr '\t\n' '  ')"
  exit 0
}
kept() { verdict KEPT "$1"; }
[ -e "$wt" ] || [ -L "$wt" ] || verdict GONE "no such path on $BOX"
[ -d "$wt" ] && [ ! -L "$wt" ] || kept "not a directory"
found=$(common "$wt"); [ -n "$found" ] || kept "not the top of a worktree"
top=$(cd "$wt" && git rev-parse --show-toplevel 2>/dev/null)
[ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(cd "$wt" && pwd -P)" ] || kept "not the top of a worktree"
[ "$(gitdir "$wt")" != "$found" ] || kept "the repository's main checkout; only a linked worktree is removed"
cdir=$found
# The leg's own lock (leg.WORKTREE), held to the end of this shell: a leg is refused while it holds.
wkey=$(canon "$wt") || kept "cannot resolve the path"
mkdir -p "$STATE/leg-locks" || kept "cannot create $STATE/leg-locks"
wlock=$(leg_lock_file "$wkey")
exec 9>>"$wlock" || kept "cannot open the worktree lock $wlock"
leg_flock; lrc=$?
[ "$lrc" -ne 3 ] || kept "another leg is using it (lock $wlock)"
[ "$lrc" -eq 0 ] || kept "cannot lock it (scripts/py exit $lrc)"
dirty=$(dirt "$wt") || kept "cannot read its status"
[ -z "$dirty" ] || kept "$(printf '%s\n' "$dirty" | grep -c '') uncommitted path(s): $(printf '%s\n' "$dirty" | head -n 3 | tr '\n' ';')"
# The ignored paths, NUL-delimited, no quoting by git. A fully ignored directory is one entry, its
# name ending in `/` (traditional mode, untracked files not listed one by one); a status that fails
# must not read as none, so its own exit closes the listing, in a record no status entry can be.
regen=(); other=(); listed=""
while IFS= read -r -d '' e; do
  case "$e" in
    '!! '*) ;;
    status=*) listed=${e#status=}; continue ;;
    *) continue ;;
  esac
  p=${e#\!\! }; hit=""
  for r in "$@"; do [ "$p" != "$r/" ] || hit=1; done
  if [ -n "$hit" ]; then regen+=("${p%/}"); else other+=("$(printf '%q' "$p")"); fi
done < <(git -C "$wt" status --porcelain -z --ignored=traditional --untracked-files=normal --ignore-submodules=none 2>/dev/null; printf 'status=%s\0' "$?")
[ "$listed" = 0 ] || kept "cannot list its ignored paths (git status exit ${listed:-none})"
[ "${#other[@]}" -eq 0 ] || kept "ignored data that --regenerable does not name: ${other[*]:0:3}$([ "${#other[@]}" -le 3 ] || printf ' and %s more' "$((${#other[@]} - 3))")"
head=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}') || kept "cannot read HEAD"
# Into private refs of the repository, with the worktree's lock closed: a transport child the bound
# outlives must not hold it. `--refmap=`: without it git also updates the remote-tracking refs the
# configured refspec maps, in a clone served to every session. A fetch that fails leaves the question
# open, and open reads as not held.
( exec 9>&-; bounded "$fetch_timeout" env GIT_TERMINAL_PROMPT=0 git -C "$wt" fetch -q --no-tags --refmap= "$remote" "+refs/heads/*:$ns/*" >&2 ); frc=$?
held=""
[ "$frc" -ne 0 ] || held=$(git -C "$wt" for-each-ref --count=1 --contains "$head" --format='%(refname)' "$ns/" 2>/dev/null)
if [ -n "$held" ]; then
  [ "$dry" != 1 ] || verdict WOULD-REMOVE "clean, and HEAD $head is on a branch of $remote"
  why=$(git --git-dir="$cdir" worktree remove "$wt" 2>&1 </dev/null) || kept "git worktree remove failed: $(printf '%s\n' "$why" | head -n 1)"
  verdict REMOVED "HEAD $head is on a branch of $remote"
fi
if [ "$frc" -eq 0 ]; then why="HEAD $head is on no branch of $remote"; else why="cannot ask $remote about HEAD $head (git fetch exit $frc)"; fi
[ "${#regen[@]}" -gt 0 ] || kept "$why"
[ "$dry" != 1 ] || verdict WOULD-TRIM "$why; would remove ${regen[*]}"
for r in "${regen[@]}"; do
  rm -rf -- "${wt:?}/${r:?}" || kept "$why; rm of $r failed partway"
done
verdict TRIMMED "$why; removed ${regen[*]}, kept the worktree"
"""


@dataclass(frozen=True)
class Word:
    """One ``farside`` word of one row, as written, and what the near side read of it."""

    task: str
    text: str
    box: str
    path: str
    held: str  # why the near side keeps it without asking the box; empty when it goes on


def parse_word(cfg: Config, word: str) -> tuple[str, str, str]:
    """(box, path, why): ``why`` is empty for a word of WHAT IT READS (the header)."""
    box, sep, path = word.partition(":")
    if not sep or not box or not path:
        return box, path, "not <box>:<path>"
    if box not in cfg.boxes.split() and not is_local(cfg, box):
        return box, path, f"{shlex.quote(box)} is no box of this fleet"
    parts = path.split("/")
    if not path.startswith("/") or not path.strip("/") or "." in parts or ".." in parts:
        return box, path, "not an absolute path to a directory, with no . or .. component"
    return box, path, ""


def rows_of(doc: dict[str, Any]) -> list[tuple[str, dict[str, str]]]:
    """Each row of the board as (task, fields)."""
    tasks: Any = doc.get("tasks")
    rows: list[tuple[str, dict[str, str]]] = []
    for row in cast(list[Any], tasks) if isinstance(tasks, list) else []:
        if not isinstance(row, dict):
            continue
        cell = cast(dict[str, Any], row)
        raw = cell.get("fields")
        fields = {str(k): str(v) for k, v in cast(dict[Any, Any], raw).items()} if isinstance(raw, dict) else {}
        rows.append((str(cell.get("task")), fields))
    return rows


def words_of(fields: dict[str, str]) -> list[str]:
    return [w for w in fields.get("farside", "").split() if w != "none"]


def row_done(fields: dict[str, str]) -> bool:
    """The row's state is a done word: ``state``, or ``status`` on a row from before ludics#810."""
    value = fields.get("state", fields.get("status", ""))
    return state_word(value) in DONE_STATES


def outstanding(records: list[dict[str, Any]], wave: str, fields: dict[str, str], box: str, path: str) -> list[str]:
    """The ids of the records that keep this word (THE GATES). A record refers to it by the row's
    ids, by the row's worker in this wave, or by its own recorded checkout on this box."""
    named = [w for key in ("standing", "requests") for w in fields.get(key, "").split() if w != "none"]
    worker = fields.get("worker")
    root = path.rstrip("/") + "/"
    ids: list[str] = []
    for record in records:
        if record.get("state") == "concluded":
            continue
        rid = jq_text(record.get("request_id"))
        bound = recorded_checkout(record)
        if (rid in named
                or (worker is not None and field(record, "request", "wave") == wave
                    and field(record, "request", "worker") == worker)
                or (field(record, "request", "execution_host") == box and bound
                    and (same_checkout(bound, path) or bound.startswith(root)))):
            ids.append(rid)
    return ids


def plan(cfg: Config, wave: str, rows: list[tuple[str, dict[str, str]]], chosen: list[str],
         records: list[dict[str, Any]]) -> list[Word]:
    """The chosen rows' words, each with what the near side's gates found (THE GATES' first two)."""
    live = {word.rstrip("/") for _, fields in rows if not row_done(fields) for word in words_of(fields)}
    out: list[Word] = []
    for task, fields in rows:
        if chosen and task not in chosen:
            continue
        for word in words_of(fields):
            box, path, why = parse_word(cfg, word)
            if not why and not row_done(fields):
                why = f"the row's state is not a done word ({fields.get('state', fields.get('status', 'none'))})"
            if not why and word.rstrip("/") in live:
                why = "a row that is not done names it too"
            if not why:
                ids = outstanding(records, wave, fields, box, path)
                if ids:
                    why = f"outstanding reservation: {' '.join(ids)}"
            out.append(Word(task, word, box, path, why))
    return out


def close_on_box(cfg: Config, word: Word, remote: str, fetch_timeout: str, dry: bool, regenerable: list[str]) -> tuple[str, str]:
    """(verdict, why) for a word the near side let through: the far side's line, read as an
    allowlist. A far side that said nothing readable removed something or nothing: KEPT says so."""
    args = [word.path, remote, fetch_timeout, "1" if dry else "0", *regenerable]
    done = run_on(cfg, word.box, prelude(cfg, word.box) + CLOSE, args, capture=True)
    if done.unreachable:
        return "UNREACHABLE", f"{word.box} did not answer"
    lines = done.out.strip("\n").split("\n")
    verdict, sep, why = lines[-1].partition("\t")
    if done.rc != 0 or not sep or verdict not in FAR_VERDICTS:
        return "KEPT", f"the far side gave no verdict (exit {done.rc}); see the path on {word.box} before a re-run"
    return verdict, why


def parse(args: list[str]) -> tuple[str, list[str], list[str], str, bool]:
    wave = ""
    tasks: list[str] = []
    regenerable: list[str] = []
    remote = "origin"
    dry = False
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--dry-run":
            dry = True
            i += 1
            continue
        if arg in ("--task", "--regenerable", "--remote"):
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"farside-close: {arg} needs a value ({USAGE})")
            value = args[i + 1]
            i += 2
            if arg == "--task":
                tasks.append(value)
            elif arg == "--remote":
                if not REMOTE.fullmatch(value) or value.startswith("-"):
                    die(f"farside-close: --remote {shlex.quote(value)} is no remote name")
                remote = value
            else:
                if not REGENERABLE.fullmatch(value) or value == ".git":
                    die(f"farside-close: --regenerable {shlex.quote(value)} is not one top-level directory of a worktree")
                regenerable.append(value)
            continue
        if arg.startswith("-") or wave:
            die(f"farside-close: unexpected {shlex.quote(arg)} ({USAGE})")
        wave = arg
        i += 1
    if not wave:
        die(f"farside-close: expected <wave> ({USAGE})")
    return wave, tasks, regenerable, remote, dry


def cmd_farside_close(cfg: Config, args: list[str]) -> int:
    wave, tasks, regenerable, remote, dry = parse(args)
    fetch_timeout = knob(cfg, "FLEET_FETCH_TIMEOUT", "300")
    if not SECONDS.fullmatch(fetch_timeout):
        die(f"FLEET_FETCH_TIMEOUT must be a positive whole number of seconds, not {fetch_timeout!r}")
    if not dry:
        rc = anchor_gate(cfg, "FARSIDE CLOSE", wave, True)
        if rc != 0:
            return rc
    doc = board_document(cfg, wave)
    if isinstance(doc, int):
        return doc
    done = listing(cfg)
    if done.unreachable:
        err(f"FARSIDE CLOSE REFUSED {wave}: the registry on {cfg.anchor} did not answer; nothing removed")
        return 4
    records = records_of(done.out) if done.rc == 0 else None
    if records is None:
        err(f"FARSIDE CLOSE REFUSED {wave}: the registry could not be read; nothing removed")
        return 1
    rows = rows_of(doc)
    unknown = [t for t in tasks if t not in [task for task, _ in rows]]
    if unknown:
        err(f"FARSIDE CLOSE REFUSED {wave}: no task {' '.join(shlex.quote(t) for t in unknown)} on the board; nothing removed")
        return 1
    tally: Counter[str] = Counter()
    for word in plan(cfg, wave, rows, tasks, records):
        verdict, why = ("KEPT", word.held) if word.held else close_on_box(cfg, word, remote, fetch_timeout, dry, regenerable)
        tally[verdict] += 1
        cli.say(f"FARSIDE {verdict} {shlex.quote(word.text)} ({shlex.quote(word.task)}): {why}")
    counts = ", ".join(f"{n} {name.lower()}" for name, n in sorted(tally.items())) or "no far-side worktrees"
    cli.say(f"FARSIDE CLOSE {wave}: {counts}")
    if tally["UNREACHABLE"]:
        return 4
    return 0 if all(name in CLEARED for name in tally) else 3
