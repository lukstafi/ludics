"""``execution``: the anchor's execution registry, and the conclusions read off a run on its box
(fleet-worker.sh's ``cmd_execution``, ``execution_listing``, ``execution_host_of``,
``conclude_from_run``, ``conclude_from_bg_run``, ``endpoint_map``, ``execution_refresh``), and
``conclude --standing-handback``, a standing reservation's conclusion at its worker's hand-back.

The registry itself is ``ludics.fleetworker.registry``: its SOURCE travels to the anchor and runs
there from stdin under a Python >= 3.12 the far side finds (``FIND_PYTHON``), inside the lease
lock for every action but ``list``; its argv is ``root action coordinator token - boxes
[slots map anchor lab]``, the ``-`` saying the JSON payload is on its fd 3, inside the far-side
script, never one argv word (ludics-lite#636; ``transport.shipped_python``). The rules it enforces
are its own header's.

``execution slot`` and ``execution hold`` take no registry lock and run on THIS box: they are
``ludics.fleetworker.slot``.

The far sides of ``conclude --from-run``, ``--from-bg-run`` and ``--standing-handback`` run on the
box that holds the run, and read its record with the tools that wrote it. A test-run.sh record has
one far side for both forms that read it, ``FROM_RUN``, which prints its facts and refuses nothing:
each form's refusals are Python's (ludics-lite#657).

Every commit a payload names is checked before the anchor is asked (ludics-lite#561): what is read,
where, and the outcomes are ``ludics.fleetworker.revision``'s header.

THE CO-TENANT EVIDENCE (ludics-lite#566): a conclusion of a MEASUREMENT, in any of its forms,
gets a summary of the GPU co-tenant record its ``execution hold --request`` left on the execution
host (``cotenants.py``) appended to its evidence, read there by ``GPU_RECORD``. Nothing else is read,
and a ``not-launched`` conclusion, which describes no run, reads nothing.
"""

import json
import os
import re
import time
from datetime import datetime, timedelta
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, assert_never, cast

from ludics import cli
from ludics.fleetworker import cotenants, revision
from ludics.fleetworker.config import Config
from ludics.fleetworker.farside import FLEET_PYTHON
from ludics.fleetworker.identity import check_identity, coordinator_id, die, my_token
from ludics.fleetworker.lease import LEASE_MUTATION
from ludics.fleetworker.preflight import knob, refresh_box
from ludics.fleetworker.transport import (
    PAYLOAD_ON_FD,
    Done,
    emit_var,
    err,
    fleet_name,
    prelude,
    run,
    run_on,
    shipped_python,
    substitution,
)

REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.py")

# The far side's interpreter: the first that reports >= 3.12, in scripts/py's order
# (farside.FLEET_PYTHON, which the preflight's probe of a box shares).
FIND_PYTHON = (
    FLEET_PYTHON
    + 'py=$(fleet_python) || { echo "EXECUTION REFUSED: no Python >= 3.12 on $BOX to run the execution registry'
    + " (scripts/py's probe; install one, or name it in LUDICS_PY_CANDIDATES)\" >&2; exit 1; }\n"
)


def registry_command(source: str, payload: str) -> str:
    """The far side's last lines: the registry's source as the program, its argv after it, and the
    payload on its fd 3 (``transport.shipped_python``; the argv's payload word is PAYLOAD_ON_FD)."""
    return shipped_python(FIND_PYTHON, source, "FLEET_EXECUTION_PY", payload)


def registry_source() -> str:
    """The registry's source, or a usage refusal when the checkout has none."""
    try:
        if os.path.getsize(REGISTRY) > 0:
            with open(REGISTRY, encoding="utf-8") as f:
                return f.read()
    except OSError:
        pass
    die(f"execution: missing helper {REGISTRY}")


def listing(cfg: Config) -> Done:
    """The anchor's whole registry as JSON (captured). ``list`` takes no lease and mutates nothing,
    so a worker with no coordinator identity may read it."""
    script = prelude(cfg, cfg.anchor) + "shift 3\n" + registry_command(registry_source(), "{}")
    args = ["EXECUTION", "x", "x", "list", "x", "x", PAYLOAD_ON_FD, cfg.boxes, cfg.slots]
    return run_on(cfg, cfg.anchor, script, args, capture=True)


def records_of(text: str) -> list[dict[str, Any]] | None:
    """A listing's records, or None when it is not a JSON array of objects."""
    try:
        decoded: Any = json.loads(text)
    except ValueError:
        return None
    if not isinstance(decoded, list):
        return None
    items = cast(list[Any], decoded)
    if not all(isinstance(item, dict) for item in items):
        return None
    return cast(list[dict[str, Any]], items)


def field(record: dict[str, Any], *path: str) -> Any:
    """``.a.b`` with jq's leniency: a missing step is None."""
    value: Any = record
    for key in path:
        if not isinstance(value, dict):
            return None
        value = cast(dict[str, Any], value).get(key)
    return value


def jq_text(value: Any) -> str:
    """How ``jq -r`` prints a value: strings raw, null as ``null``, anything else as JSON."""
    if isinstance(value, str):
        return value
    return json.dumps(value)


def record_of(records: list[dict[str, Any]], request: str) -> dict[str, Any] | None:
    for record in records:
        if record.get("request_id") == request:
            return record
    return None


# --- the conclusions read off a run --------------------------------------------------------------

# Far side of `conclude --from-run` and `conclude --standing-handback --from-run` (ludics-lite#657),
# on the execution box: the FACTS of a test-run.sh record (OCANNL's `tools/test-run.sh`: `exit`,
# `log`, `wt` and `cmd` under the run directory), and it refuses nothing -- each form's refusals are
# its own, in Python (`run_unfinished`, `from_run_refusal`, `standing_run_clause`). Since
# ocannl-staging#808 the record also names the source it ran, as launch-time facts: `head` and
# `dirty`, `dirty` written first, so the writer leaves both or neither (ludics-lite#438).
# Args: run-dir, a commit, the checkout to place that commit in ('' for the record's worktree).
# Prints, one `key=value` line each and in this order:
#   dir      1, or 0 (no such directory: nothing else is read);
#   missing  the first of exit/log/wt/cmd that is no regular file (nothing else is read);
#   exit     the first line of `exit`; wt the first line of `wt`; gone 1 when that is no directory;
#   runner   the exit status of `tools/test-run.sh status <dir>`, the project's authority on
#            "published and no process remains" (0; 3 still running, 1 died), or `none` when the
#            worktree is gone or has no runner; alive the supervisor pid when, with no runner, it
#            is still alive;
#   pair     none, both, head (no dirty), dirty (no head), or irregular (either not a regular file);
#   dirty    the count of lines `dirty` lists; rel same|ancestor|outside, the launch head against
#            the commit, read in the checkout (only for a head of hex digits alone);
#   whead    the worktree's HEAD now; known 1 when the checkout contains the commit;
#   launched LAST, `head`'s whole content as `$(cat)` reads it, newlines and all.
# Every value but `launched` is one line by construction (`head -n1`, a count, a word, an ID).
FROM_RUN = r"""dir="$1" sha="$2" co="$3"
[ -d "$dir" ] || { printf 'dir=0\n'; exit 0; }
printf 'dir=1\n'
for f in exit log wt cmd; do
  [ -f "$dir/$f" ] || { printf 'missing=%s\n' "$f"; exit 0; }
done
code=$(head -n1 "$dir/exit"); wt=$(head -n1 "$dir/wt"); gone=1; [ -d "$wt" ] && gone=0
runner=none alive=
if [ "$gone" = 0 ] && [ -x "$wt/tools/test-run.sh" ]; then
  (cd "$wt" && tools/test-run.sh status "$dir" >/dev/null 2>&1); runner=$?
elif [ -s "$dir/pid" ] && kill -0 "$(head -n1 "$dir/pid")" 2>/dev/null; then
  alive=$(head -n1 "$dir/pid")
fi
[ -n "$co" ] || co=$wt
rhead= n=0 rel=
if [ -e "$dir/head" ] && [ -e "$dir/dirty" ]; then
  pair=both
  if [ -f "$dir/head" ] && [ -f "$dir/dirty" ]; then
    rhead=$(cat "$dir/head")
    [ -s "$dir/dirty" ] && n=$(grep -c '' "$dir/dirty")
    # git reads the head only when it is hex digits alone: never an option, never a revision range.
    case "$rhead" in
      ''|*[!0-9a-f]*) ;;
      "$sha") rel=same ;;
      *) if git -C "$co" merge-base --is-ancestor "$rhead" "$sha" 2>/dev/null; then rel=ancestor; else rel=outside; fi ;;
    esac
  else
    pair=irregular
  fi
elif [ -e "$dir/head" ]; then pair=head
elif [ -e "$dir/dirty" ]; then pair=dirty
else pair=none; fi
whead=; [ "$gone" = 0 ] && whead=$(git -C "$wt" rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null)
known=0; git -C "$co" cat-file -e "$sha^{commit}" 2>/dev/null && known=1
printf 'exit=%s\nwt=%s\ngone=%s\nrunner=%s\nalive=%s\npair=%s\ndirty=%s\nrel=%s\nwhead=%s\nknown=%s\n' \
  "$code" "$wt" "$gone" "$runner" "$alive" "$pair" "$n" "$rel" "$whead" "$known"
printf 'launched=%s\n' "$rhead"
"""

# Far side of `conclude --from-bg-run`, on the box that holds the directory: bg-run.sh's own `wait
# <dir> --within 0` gives the verdict, so the directory contract keeps one reader. The
# coordinator's copy of bg-run.sh travels in this script, so the far box's skills checkout cannot
# read the directory with another version. The one thing read past `wait` is the runner's own exit
# sentinel in `log`, a fail-closed allowlist: a whole line `exit: <status>` or `<name>: exit:
# <status>`, the name [A-Za-z0-9._-]+ and the status 0-255 without leading zeros; the LAST such
# line wins. Prints `status=rc`, `rc=` and `sentinel=` lines; `status=stopped` alone for wait's
# STOPPED (exit 7: `bg-run.sh stop` ended the run and no process of it is left, ludics-lite#638),
# which carries no status to read; or one FROM-BG-RUN REFUSED line.
FROM_BG_RUN_HEAD = r"""dir="$1"
refuse() { echo "FROM-BG-RUN REFUSED: $*"; exit 1; }
[ -d "$dir" ] || refuse "no run directory $dir on $BOX"
tmp=$(mktemp "${TMPDIR:-/tmp}/fw-bg-run.XXXXXX") || refuse "cannot create a scratch file on $BOX"
bash -s -- wait "$dir" --within 0 > "$tmp" 2>&1 <<'FLEET_BG_RUN_SH'
"""
FROM_BG_RUN_TAIL = r"""FLEET_BG_RUN_SH
wrc=$?
said=$(head -n1 "$tmp"); rm -f "$tmp"
case "$wrc" in
  0) ;;
  3) refuse "bg-run.sh wait: RUNNING -- $dir has no rc and its task or command is alive; conclude once it finishes" ;;
  4) refuse "bg-run.sh wait: STARTING -- no task has published a pid in $dir (never started, or not yet)" ;;
  # DIED is never a conclusion: bg-run.sh's header names a window where it is wrong (a wrapper
  # killed alone before its command published `cpid`), and no pause bounds how late the command
  # may still publish and run. The coordinator checks for the run's processes itself.
  5) refuse "bg-run.sh wait: DIED -- the task was killed before the command returned; bg-run cannot rule out a command that outlived it unpublished, so make sure no process of the run remains, then conclude it with a JSON payload (cancelled)" ;;
  # STOPPED is a conclusion: the stop signalled the run's whole group, a command that had not yet
  # published cpid included, and wait reads it only once no member of that group is left. What it
  # cannot see is a process that left the group itself (bg-run.sh's header, on stop).
  7) case "$said" in STOPPED*) printf 'status=stopped\n'; exit 0 ;; esac
     refuse "bg-run.sh wait exit 7 printed '$said', not STOPPED" ;;
  *) refuse "bg-run.sh wait exit $wrc: $said" ;;
esac
code=${said#rc=}
case "$said" in rc=*) ;; *) refuse "bg-run.sh wait printed '$said', not rc=<status>" ;; esac
case "$code" in ''|*[!0-9]*) refuse "$dir/rc holds '$code', not a status" ;; esac
[ -f "$dir/log" ] || refuse "$dir has an rc but no log"
sentinel=$(LC_ALL=C grep -a -E '^([A-Za-z0-9._-]+: )?exit: (0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$' "$dir/log" | tail -n 1)
printf 'status=rc\nrc=%s\nsentinel=%s\n' "$code" "$sentinel"
"""


# Far side of `--observed-from <checkout>`, on the execution host: the checkout's HEAD, the commit a
# conclusion records instead of a SHA copied by hand (ludics-lite#561). Arg: the checkout. Prints one
# `head=` line, or one OBSERVED-FROM REFUSED line.
OBSERVED_FROM = r"""co="$1"
refuse() { echo "OBSERVED-FROM REFUSED: $*"; exit 1; }
[ -d "$co" ] || refuse "no checkout $co on $BOX"
head=$(git -C "$co" rev-parse --verify -q 'HEAD^{commit}') || refuse "cannot read HEAD of $co on $BOX (not a git checkout, or no commit yet)"
printf 'head=%s\n' "$head"
"""


# Far side of THE CO-TENANT EVIDENCE, on the execution host: the measurement's GPU co-tenant record,
# which every `execution hold --request <id>` there appended to (cotenants.py). Args: box, request id.
# Prints `none=<path>`, or `path=<path>`, `size=<bytes>` and the record's last MiB.
GPU_RECORD = r"""f="$SLOT_STATE/$1/measurement.$2.gpu.jsonl"
[ -f "$f" ] || { printf 'none=%s\n' "$f"; exit 0; }
size=$(wc -c < "$f") || exit 1
printf 'path=%s\nsize=%s\n' "$f" "$(printf '%s' "$size" | tr -d ' ')"
tail -c 1048576 "$f"
"""
GPU_RECORD_READ = 1048576  # the newest MiB of the record: a longer one names what it left out


# How a conclusion's evidence names a revision the worker's result line gave.
REPORTED = "as reported by the worker"


@dataclass(frozen=True)
class Payload:
    """A conclusion payload, compact JSON, ready for the registry."""

    json: str


@dataclass(frozen=True)
class Refusal:
    """No payload: the line(s) to print, and the exit status (1 refused, 4 unreachable)."""

    text: str
    rc: int


type Conclusion = Payload | Refusal

SHA40 = revision.SHA40


def facts_of(text: str, key: str) -> str:
    """``sed -n 's/^key=//p'``: every line's value for ``key``, newline-joined."""
    prefix = key + "="
    return "\n".join(line[len(prefix) :] for line in text.split("\n") if line.startswith(prefix))


def basename(path: str) -> str:
    """``basename``: the last component, trailing slashes ignored."""
    stripped = path.rstrip("/")
    return os.path.basename(stripped) if stripped else "/"


def run_verdict(code: str, *, timeout_codes: Sequence[str]) -> str:
    """The verdict an exit status reads as: 0 pass, a cap timeout, a signal cancelled, else fail."""
    if code == "0":
        return "pass"
    if code in timeout_codes:
        return "timeout"
    if code in ("129", "130", "137", "143"):
        return "cancelled"
    return "fail"


def compact(obj: dict[str, str]) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


# How a launch head stands against the commit it is placed against (FROM_RUN's `rel`).
REL = {
    "same": ", observed_sha itself",
    "ancestor": ", an ancestor of observed_sha",
    "outside": ", which is not in observed_sha's history (rewritten by a rebase, or never pushed)",
}
RUN_KEYS = ("exit", "wt", "gone", "runner", "alive", "pair", "dirty", "rel", "whead", "known")
RUN_FILES = ("exit", "log", "wt", "cmd")


def run_facts(text: str) -> dict[str, str] | None:
    """FROM_RUN's facts by key, or None for anything but its own shape, a fail-closed reading: the
    keys it prints, each once and in its order, every value but ``launched`` (the last) one line of
    its own vocabulary."""
    if text == "dir=0":
        return {"dir": "0"}
    lines, cut, launched = text.partition("\nlaunched=")
    rows = lines.split("\n")
    if rows[0] != "dir=1":
        return None
    if not cut:
        missing = rows[1].removeprefix("missing=") if len(rows) == 2 else ""
        return {"dir": "1", "missing": missing} if missing in RUN_FILES else None
    if len(rows) != 1 + len(RUN_KEYS) or not all(row.startswith(key + "=") for key, row in zip(RUN_KEYS, rows[1:])):
        return None
    facts = {key: row[len(key) + 1 :] for key, row in zip(RUN_KEYS, rows[1:])}
    facts.update(dir="1", launched=launched)
    # rel places a launch head of hex digits alone, and nothing else.
    placed = facts["pair"] == "both" and re.fullmatch(r"[0-9a-f]+", launched) is not None
    if not (facts["gone"] in ("0", "1") and re.fullmatch(r"none|[0-9]+", facts["runner"])
            and re.fullmatch(r"[0-9]*", facts["alive"]) and re.fullmatch(r"[0-9]+", facts["dirty"])
            and facts["pair"] in ("none", "both", "head", "dirty", "irregular") and facts["known"] in ("0", "1")
            and (facts["rel"] in REL if placed else facts["rel"] == "")):  # fmt: skip
        return None
    return facts


def read_run(cfg: Config, box: str, run_dir: str, sha: str, checkout: str = "") -> dict[str, str] | Refusal:
    """FROM_RUN's facts of the record ``run_dir`` on ``box``, ``sha`` placed in ``checkout`` (the
    record's worktree when empty); a refusal only when they cannot be read."""
    done = run_on(cfg, box, prelude(cfg, box) + FROM_RUN, [run_dir, sha, checkout], capture=True)
    if done.unreachable:
        return Refusal(f"FROM-RUN UNREACHABLE {box}: nothing concluded", 4)
    text = substitution(done.out)
    facts = run_facts(text) if done.rc == 0 else None
    if facts is None:
        return Refusal(f"FROM-RUN REFUSED: unreadable record facts from {box} (exit {done.rc}): {text}", 1)
    return facts


def run_unfinished(facts: dict[str, str], run_dir: str, box: str) -> Refusal | None:
    """What every form refuses of a test-run.sh record: no verdict to read yet (no directory, a
    record file missing, an exit that is no status, a run still going) or a malformed record."""
    pair, launched = facts.get("pair"), facts.get("launched", "")
    if facts["dir"] == "0":
        why = f"no run directory {run_dir} on {box}"
    elif "missing" in facts:
        why = (f"{run_dir} has no {facts['missing']} (the run is unfinished, died without a verdict, or is not"
               " a test-run.sh record)")
    elif not re.fullmatch(r"[0-9]+", facts["exit"]):
        why = f"{run_dir}/exit holds '{facts['exit']}', not a status"
    elif not facts["wt"]:
        why = f"{run_dir}/wt names no worktree: a malformed record"
    elif facts["runner"] not in ("none", "0"):
        why = f"tools/test-run.sh status {run_dir} exit {facts['runner']}: not a finished run"
    elif facts["alive"]:
        why = f"supervisor pid {facts['alive']} of {run_dir} is still alive"
    elif pair == "irregular":
        why = f"{run_dir}/head or {run_dir}/dirty is not a regular file: a malformed record"
    elif pair == "head":
        why = f"{run_dir} has a head but no dirty: a malformed record (test-run.sh writes dirty first, so both or neither)"
    elif pair == "dirty":
        why = f"{run_dir} has a dirty but no head: a malformed record (test-run.sh writes head after dirty, so both or neither)"
    elif pair == "both" and not revision.OBJECT_ID.fullmatch(launched):
        # One exact object ID, 40 or 64 hex digits: a truncated one would read as a rewritten commit.
        why = f"{run_dir}/head holds '{launched}', not one commit ID: a malformed record"
    else:
        return None
    return Refusal(f"FROM-RUN REFUSED: {why}", 1)


def from_run_refusal(facts: dict[str, str], run_dir: str, box: str, sha: str) -> Refusal | None:
    """``--from-run``'s refusals: a finished record that is no evidence for the one commit ``sha``
    (its worktree gone, launched at another commit or over uncommitted edits, a worktree whose
    HEAD cannot be read or that does not contain ``sha``), after ``run_unfinished``'s."""
    unfinished = run_unfinished(facts, run_dir, box)
    if unfinished is not None:
        return unfinished
    wt, launched, n = facts["wt"], facts["launched"], facts["dirty"]
    if facts["gone"] == "1":
        why = f"recorded worktree {wt} is gone"
    elif facts["pair"] == "both" and launched != sha:
        why = (f"{run_dir}/head records {launched} as the revision launched, but the reported revision is {sha}:"
               f" this run is evidence for {launched}, not {sha}")
    elif facts["pair"] == "both" and n != "0":
        why = (f"{run_dir}/dirty lists {n} uncommitted path(s) at launch: the run tested {sha} plus those edits,"
               f" so it is not evidence for {sha}; conclude it with a JSON payload whose evidence says so")
    elif not facts["whead"]:
        why = f"cannot read HEAD of {wt}"
    elif facts["known"] != "1":
        why = f"{wt} does not contain the reported revision {sha}"
    else:
        return None
    return Refusal(f"FROM-RUN REFUSED: {why}", 1)


def conclude_from_run(cfg: Config, run_dir: str, request: str, box: str, sha: str, evidence: str) -> Conclusion:
    """The conclude payload read off a finished test-run.sh record on the box. The box is the
    reservation's execution host: the payload names it and the registry checks it, so a record
    read on the wrong machine cannot conclude another box's assignment."""
    facts = read_run(cfg, box, run_dir, sha)
    if isinstance(facts, Refusal):
        return facts
    refused = from_run_refusal(facts, run_dir, box, sha)
    if refused is not None:
        return refused
    code, wt, head, record = facts["exit"], facts["wt"], facts["whead"], facts["pair"]
    if not SHA40.fullmatch(head):
        return Refusal(f"FROM-RUN REFUSED: unreadable HEAD {head!r} of {wt} from {box}", 1)
    # test-run.sh's exit vocabulary: 142 the cap, 129/130/137/143 a signal; every other nonzero
    # (dune's own 1, a refused invocation, 126/127 toolchain) is a failed run.
    verdict = run_verdict(code, timeout_codes=("142",))
    if not evidence:
        evidence = f"test-run.sh record {run_dir} on {box}: exit {code} published, no process remains"
    if record == "both":
        evidence += f"; launched at {sha} on a clean tree (the record's head and dirty)"
    else:
        evidence += (
            "; the record has no head or dirty (a run before test-run.sh recorded them, or outside"
            f" a checkout), so the revision is {sha} as reported by the worker"
        )
    if head != sha:
        evidence += f"; checkout head is now {head}"
    return Payload(
        compact(
            {
                "request_id": request,
                "evidence": evidence,
                "observed_sha": sha,
                "remote_checkout": wt,
                "handle": "test-run:" + basename(run_dir),
                "log": run_dir + "/log",
                "verdict": verdict,
                "execution_host": box,
            }
        )
    )


def conclude_from_bg_run(
    cfg: Config,
    run_dir: str,
    request: str,
    box: str,
    host: str,
    sha: str,
    checkout: str,
    evidence: str,
    bgrun: str,
    source: str = REPORTED,
) -> Conclusion:
    """The conclude payload read off a bg-run.sh directory. The verdict mapping:
      - the code is the runner's own sentinel when the log carries one and it is nonzero, else rc --
        so a pass needs BOTH rc 0 and no nonzero sentinel;
      - 0 pass; 124 (timeout(1)) and 142 (test-run.sh's cap) timeout; 129/130/137/143 (a signal)
        cancelled; anything else fail;
      - bg-run's STOPPED (``bg-run.sh stop`` ended the run, and no process of it is left) is
        cancelled: the run was ended on purpose, and the log's sentinel is not read;
      - bg-run's DIED is refused, not mapped, as are RUNNING and STARTING.
    The read box need not be the execution host (a trip driven over ssh leaves its directory on
    the box that drove it), so the payload carries no ``execution_host`` binding, and the log and
    handle name the box read, ``<box>:<path>``."""
    with open(bgrun, encoding="utf-8", errors="surrogateescape") as f:
        bg_source = f.read()
    script = prelude(cfg, box) + FROM_BG_RUN_HEAD + bg_source + FROM_BG_RUN_TAIL
    done = run_on(cfg, box, script, [run_dir], capture=True)
    if done.unreachable:
        return Refusal(f"FROM-BG-RUN UNREACHABLE {box}: nothing concluded", 4)
    facts = substitution(done.out)
    if done.rc != 0:
        return Refusal(facts, 1)
    status = facts_of(facts, "status")
    if status == "stopped" and facts == "status=stopped":
        verdict = "cancelled"
        note = f"bg-run {run_dir} on {box}: STOPPED by bg-run.sh stop before the command returned, no process of it left"
    elif status == "rc":
        code, sentinel = facts_of(facts, "rc"), facts_of(facts, "sentinel")
        if not re.fullmatch(r"[0-9]+", code):
            return Refusal(f"FROM-BG-RUN REFUSED: unreadable run facts from {box}: {facts}", 1)
        note = f"bg-run {run_dir} on {box}: rc={code}"
        if sentinel:
            scode = sentinel.rsplit("exit: ", 1)[-1]
            note += f", runner sentinel '{sentinel}'"
            if scode != "0":
                code = scode
        verdict = run_verdict(code, timeout_codes=("124", "142"))
        note += "; the command returned"
    else:
        return Refusal(f"FROM-BG-RUN REFUSED: unreadable run facts from {box}: {facts}", 1)
    if not evidence:
        evidence = f"{note}; revision {sha} {source}"
    elif source != REPORTED:
        evidence += f"; revision {sha} {source}"
    if box != host:
        evidence += f"; directory read on {box}, which drove the run on {host}"
    return Payload(
        compact(
            {
                "request_id": request,
                "evidence": evidence,
                "observed_sha": sha,
                "remote_checkout": checkout,
                "handle": f"bg-run:{box}:{run_dir}",
                "log": f"{box}:{run_dir}/log",
                "verdict": verdict,
            }
        )
    )


HANDBACK_VERDICTS = ("pass", "fail", "timeout", "cancelled")  # not-launched names no run, so no observed_sha


def standing_run_clause(facts: dict[str, str], run_dir: str, host: str) -> tuple[str, str] | Refusal:
    """A standing hand-back's run record: its verdict, and the evidence clause that records what
    ``from_run_refusal`` would have refused it for. ``run_unfinished``'s refusals stand."""
    unfinished = run_unfinished(facts, run_dir, host)
    if unfinished is not None:
        return unfinished
    code, dirty = facts["exit"], facts["dirty"]
    verdict = run_verdict(code, timeout_codes=("142",))
    clause = f"last batch: test-run.sh record {run_dir} on {host}, exit {code} ({verdict})"
    if facts["pair"] == "both":
        clause += f", launched at {facts['launched']}{REL[facts['rel']]}"
        clause += f" over {dirty} uncommitted path(s) its dirty lists" if dirty != "0" else " on a clean tree"
    else:
        clause += ", its record naming no launch revision (no head or dirty)"
    if facts["gone"] == "1":
        clause += f"; its recorded worktree {facts['wt']} is gone"
    return verdict, clause


def handback_lead(evidence: str, checkout: str, host: str) -> str:
    return f"{evidence}; standing hand-back, observed_sha read as HEAD of {checkout} on {host}"


def handback_handle(request: str, run_dir: str) -> tuple[str, str]:
    """A standing hand-back's handle and log: the run record's, or the hand-back's own."""
    if not run_dir:
        return f"standing-handback:{request}", "none: no run record named (the evidence is the hand-back's)"
    return "test-run:" + basename(run_dir), run_dir + "/log"


def recorded_handback(
    record: dict[str, Any], request: str, checkout: str, host: str, evidence: str, run_dir: str, verdict: str
) -> str | None:
    """THE RETRY RULE for a hand-back: the recorded conclusion, when this call names its request,
    checkout, record (or none), evidence and any --verdict. Re-read, the run record could describe a
    worktree removed or a history rewritten since. None for anything else, which composes afresh."""
    handle, log = handback_handle(request, run_dir)
    fields = {"request_id": request, "handle": handle, "log": log, "remote_checkout": checkout}
    if verdict:
        fields["verdict"] = verdict
    lead = handback_lead(evidence, checkout, host) + "; "
    landed = retried(record, fields, lambda said: said.startswith(lead))
    return None if landed is None else json.dumps(landed, separators=(",", ":"), ensure_ascii=False)


def standing_handback(
    request: str, host: str, checkout: str, head: str, evidence: str, verdict: str, run: tuple[str, str] | None
) -> str:
    """The payload of ``conclude --standing-handback``: ``run`` is the record's directory and
    evidence clause, or None when the hand-back's own verdict stands alone."""
    evidence = handback_lead(evidence, checkout, host)
    handle, log = handback_handle(request, run[0] if run else "")
    if run is None:
        evidence += f"; verdict {verdict} as the worker's hand-back reports it, no run record named"
    else:
        evidence += "; " + run[1]
    data = {"request_id": request, "evidence": evidence, "observed_sha": head, "remote_checkout": checkout,
            "handle": handle, "log": log, "verdict": verdict, "execution_host": host}  # fmt: skip
    return compact(data)


def observed_head(cfg: Config, box: str, checkout: str) -> str | Refusal:
    """``--observed-from``: the checkout's HEAD, read on the box (the request's execution host)."""
    done = run_on(cfg, box, prelude(cfg, box) + OBSERVED_FROM, [checkout], capture=True)
    if done.unreachable:
        return Refusal(f"OBSERVED-FROM UNREACHABLE {box}: nothing concluded", 4)
    facts = substitution(done.out)
    if done.rc != 0:
        return Refusal(facts or f"OBSERVED-FROM REFUSED: exit {done.rc} reading {checkout} on {box}", 1)
    head = facts_of(facts, "head")
    if not revision.OBJECT_ID.fullmatch(head):
        return Refusal(f"OBSERVED-FROM REFUSED: unreadable HEAD of {checkout} from {box}: {facts}", 1)
    return head


def retried(
    record: dict[str, Any], fields: Mapping[str, Any] | None = None, evidence: Callable[[str], bool] | None = None
) -> dict[str, Any] | None:
    """THE RETRY RULE, one implementation for every conclude form (ludics-lite#657): a record already
    concluded is a conclusion's earlier call having landed with its answer lost, so a call that
    MATCHES what landed gets the landed payload back, to compose the registry's identical retry
    however the box, the checkout or the run record have changed since. The call matches when every
    one of ``fields`` equals the landed payload's and, given ``evidence``, the landed evidence is a
    string it accepts; a further check is one more field (or one more predicate here). None when the
    record is not concluded or the call does not match: the caller composes afresh, and the
    registry refuses anything but an identical payload for a concluded record."""
    if record.get("state") != "concluded":
        return None
    history: Any = record.get("history")
    last: Any = cast(list[Any], history)[-1] if isinstance(history, list) and history else None
    data: Any = cast(dict[str, Any], last).get("data") if isinstance(last, dict) else None
    if not isinstance(data, dict):
        return None
    landed = cast(dict[str, Any], data)
    if any(landed.get(key) != value for key, value in (fields or {}).items()):
        return None
    said = landed.get("evidence")
    if evidence is not None and not (isinstance(said, str) and evidence(said)):
        return None
    return landed


def observed_sha_of(cfg: Config, record: dict[str, Any], host: str, checkout: str) -> str | Refusal:
    """``--observed-from``'s SHA. THE RETRY RULE with no further check: the observed_sha the landed
    conclusion names stands, so a retry composes the same payload even once the checkout has moved
    on or been removed, and any other payload meets the registry's "already concluded" refusal."""
    landed = retried(record)
    recorded = None if landed is None else landed.get("observed_sha")
    if isinstance(recorded, str) and recorded:
        return recorded
    return observed_head(cfg, host, checkout)


SKEW = timedelta(minutes=10)  # the clock difference allowed between the anchor and an execution host


def reserved_since(lines: list[dict[str, Any]], created: str) -> tuple[list[dict[str, Any]], int]:
    """The snapshots taken since the reservation was made, and how many older ones were left out:
    a hold run under the id before it was reserved (a typo, an id reused later) is not this
    measurement's. ``SKEW`` is the boundary: an older snapshot within it is kept. A line or a
    record whose time does not parse is kept."""
    try:
        since = datetime.fromisoformat(created) - SKEW
    except ValueError:
        return lines, 0
    kept: list[dict[str, Any]] = []
    for line in lines:
        at = line.get("at")
        try:
            older = isinstance(at, str) and datetime.fromisoformat(at) < since
        except (ValueError, TypeError):
            older = False
        if not older:
            kept.append(line)
    return kept, len(lines) - len(kept)


def gpu_record_evidence(cfg: Config, host: str, request: str, created: str = "") -> str:
    """THE CO-TENANT EVIDENCE: one clause for the conclusion's evidence, read on ``host``; only the
    snapshots taken since the reservation (``created``, its ``created_at``) count."""
    script = prelude(cfg, host) + emit_var("SLOT_STATE", cfg.slot_state) + GPU_RECORD
    done = run_on(cfg, host, script, [host, request], capture=True)
    if done.unreachable:
        return f"GPU co-tenant record unread: {host} did not answer"
    first, _, rest = done.out.partition("\n")
    if done.rc != 0 or not first.startswith(("path=", "none=")):
        return f"GPU co-tenant record unread on {host}: exit {done.rc}, {first[:200]!r}"
    path = first.split("=", 1)[1]
    if first.startswith("none="):
        return (f"no GPU co-tenant record on {host} ({path}): the measurement ran under no"
                f" `execution hold --request {request}` there, or under one older than ludics-lite#566")
    second, _, rest = rest.partition("\n")
    size = second.removeprefix("size=")
    if not (second.startswith("size=") and size.isdecimal() and size.isascii()):
        return f"GPU co-tenant record unread on {host}: {second[:200]!r} is no size"
    cut = ""
    if int(size) > GPU_RECORD_READ:
        # The read starts mid-line: its first line is a fragment, dropped whole.
        rest = rest.partition("\n")[2]
        cut = (f"the record is {size} bytes, of which its last {GPU_RECORD_READ} were read, so the"
               " earliest snapshots are left out; ")
    lines, older = reserved_since(cotenants.read_lines(rest), created)
    if older:
        cut += f"{older} snapshot(s) older than the reservation left out; "
    return f"GPU co-tenants on {host} ({host}:{path}): {cut}{cotenants.summary(lines)}"


def gpu_clause(evidence: str, recorded: str, host: str) -> bool:
    """Whether ``recorded`` is exactly ``evidence`` with THE CO-TENANT EVIDENCE's clause after it:
    the remainder must open with one of the clause's own three openings. The boundary: an
    ``evidence`` whose own text ends in such an opening is not told apart from a shorter one."""
    remainder = recorded.removeprefix(f"{evidence}; ")
    return remainder != recorded and remainder.startswith(
        (f"GPU co-tenants on {host} (", f"no GPU co-tenant record on {host} (", "GPU co-tenant record unread"))


def with_gpu_record(cfg: Config, payload: str) -> str:
    """A conclusion payload with THE CO-TENANT EVIDENCE appended, when it concludes a measurement
    that ran; any other payload unchanged, as is one the registry will refuse on shape anyway (no
    object, no request id, no evidence) and one whose record cannot be read here (the conclusion
    then meets the same anchor). A registry that cannot be read here refuses the conclusion, rather
    than letting it land without its clause. A conclusion's retry reuses the clause it recorded."""
    try:
        decoded: Any = json.loads(payload)
    except ValueError:
        return payload
    if not isinstance(decoded, dict):
        return payload
    data = cast(dict[str, Any], decoded)
    request, evidence = data.get("request_id"), data.get("evidence")
    if not (isinstance(request, str) and request and isinstance(evidence, str) and evidence.strip()):
        return payload
    if data.get("verdict") == "not-launched":
        return payload
    done = listing(cfg)
    if done.unreachable:
        cli.say(f"EXECUTION UNREACHABLE {cfg.anchor}: cannot read request {request}'s record to tell whether"
                " it is a measurement, whose conclusion carries its GPU co-tenant record; nothing concluded")
        raise cli.Exit(4)
    records = records_of(done.out) if done.rc == 0 else None
    if records is None:
        cli.emit(substitution(done.out))
        cli.say("EXECUTION REFUSED: the anchor's registry could not be read; nothing concluded")
        raise cli.Exit(1)
    record = record_of(records, request)
    if record is None or field(record, "request", "kind") != "measurement":
        return payload
    host = jq_text(field(record, "request", "execution_host"))
    # THE RETRY RULE: the clause the landed conclusion recorded stands, so the payload is the
    # registry's identical retry however the box or its record has changed since.
    landed = retried(record, evidence=lambda said: gpu_clause(evidence, said, host))
    if landed is not None:
        data["evidence"] = landed["evidence"]
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    if record.get("state") == "concluded":
        return payload  # any other payload for a concluded record is the registry's to refuse
    data["evidence"] = f"{evidence}; {gpu_record_evidence(cfg, host, request, jq_text(record.get('created_at')))}"
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False)


# --- the endpoint map and the refresh after a dispatch -------------------------------------------


def endpoint_map(cfg: Config) -> str | None:
    """The lab's endpoint map as ``wake-lab.sh endpoint-map`` prints it, read from THIS checkout's
    wake-lab.sh; None when that refuses its own map (the reservation is refused: a map that is
    there and wrong is a defect to fix). No wake-lab.sh degrades loudly to an empty map."""
    wake = os.path.join(cfg.checkout, "scripts", "wake-lab.sh")
    if not os.path.isfile(wake):
        err(
            "EXECUTION WARNING: no endpoint map ("
            + wake
            + " is missing): FLEET_BOXES is not checked for two aliases of one box, and a measurement"
            " is not checked against its box's lab lane lock"
        )
        return ""
    done = run(["bash", wake, "endpoint-map"], capture=True)
    if done.rc != 0:
        err(
            f"EXECUTION REFUSED: {wake} endpoint-map failed (above), so FLEET_BOXES cannot be checked"
            " for two aliases of one box"
        )
        return None
    return substitution(done.out)


@dataclass(frozen=True)
class Unreadable:
    line: str


def refresh_host(record_text: str) -> str | Unreadable:
    """The dispatched record's execution host, or why it cannot be read."""
    try:
        decoded: Any = json.loads(record_text)
    except ValueError as exc:
        return Unreadable(
            f"REFRESH FAILED: cannot read the execution host from the dispatched record ({exc});"
            " run fleet-worker.sh refresh <host> by hand"
        )
    host = field(decoded, "request", "execution_host")
    if host is None or host is False or host == "":
        return Unreadable(
            "REFRESH FAILED: cannot read the execution host from the dispatched record (empty);"
            " run fleet-worker.sh refresh <host> by hand"
        )
    return jq_text(host)


def execution_refresh(cfg: Config, record_text: str) -> None:
    """After a dispatch, refresh the execution host's skills checkout (ludics-lite#362), on stderr,
    so stdout stays the record; the dispatch's status stands whatever the refresh reports, and a
    record that cannot be read is said so rather than skipped. AFTER the dispatch: the registry
    lock is released by then, so a fetch that hangs cannot hold it. A standing reservation queued
    behind a measurement window is not refreshed (ludics-lite#481): the box is measuring."""
    host = refresh_host(record_text)
    match host:
        case Unreadable():
            err(host.line)
        case str():
            record: Any = json.loads(record_text)
            if field(record, "state") == "suspended":
                window = jq_text(field(record, "suspended_by"))
                err(
                    f"REFRESH DEFERRED {host}: measurement window {window} is measuring there;"
                    f" run fleet-worker.sh refresh {host} once it concludes"
                )
                return
            refresh_box(cfg, host, to_stderr=True)
        case _:
            assert_never(host)


# --- the command ---------------------------------------------------------------------------------

LIST_USAGE = "execution list: expected --active, --compact or --host <box>"
USAGE = (
    "execution: list, slot -- <command>, hold -- <command>, leg --request <id> ... -- <runner>,"
    " run|reserve|dispatch|record|reconcile|conclude <json-file>, window [--no-gap] <box> <json-file>,"
    " conclude --from-run|--from-bg-run <run-dir> --request <id>, conclude --standing-handback --request <id> ...,"
    " or tip-run <json-file> [--tip <branch>] --checkout <dir> -- <command>, tip-run --wait <id>"
)
CONCLUDE_USAGE = "execution conclude <json-file> [--observed-from <checkout>]"


def read_payload(action: str, args: list[str]) -> str:
    """``[ "$#" -eq 2 ] && [ -r "$2" ]``, then the file's text, trailing newlines dropped."""
    if len(args) != 2 or not os.access(args[1], os.R_OK):
        die(f"execution {action}: readable JSON file required")
    try:
        with open(args[1], encoding="utf-8", errors="surrogateescape") as f:
            return f.read().rstrip("\n")
    except OSError:
        die("execution: cannot read payload")


def flag_values(args: list[str], names: Sequence[str], usage: str) -> dict[str, str]:
    """``--name <value>`` pairs, each value nonempty; anything else is the usage refusal."""
    values: dict[str, str] = {}
    i = 0
    while i < len(args):
        name = args[i]
        if name in names:
            if i + 1 >= len(args) or not args[i + 1]:
                die(f"execution conclude: expected value for {name}")
            values[name] = args[i + 1]
            i += 2
            continue
        die(usage)
    return values


def run_dir_arg(args: list[str], mode: str, where: str) -> str:
    run_dir = args[2] if len(args) > 2 else ""
    if not run_dir:
        die(f"execution conclude {mode}: <run-dir> required")
    if not run_dir.startswith("/"):
        die(f"execution conclude {mode}: the run directory must be absolute (it is read on {where})")
    return run_dir


def checkout_arg(checkout: str, mode: str) -> str:
    """``--observed-from``'s checkout: absolute on the execution host, POSIX or a drive letter."""
    if not (checkout.startswith("/") or re.match(r"[A-Za-z]:[/\\]", checkout)):
        die(f"execution conclude{mode}: --observed-from <checkout> must be absolute (it is read on the execution host)")
    return checkout


def fail(refusal: tuple[str, int] | Refusal | None) -> None:
    """Print a refusal and exit with its status; nothing for None."""
    match refusal:
        case None:
            return
        case Refusal():
            concluded(refusal)
        case (text, rc):
            cli.say(text)
            raise cli.Exit(rc)
        case _:
            assert_never(refusal)


def record_to_check(cfg: Config, request: str) -> dict[str, Any] | None:
    """The request's record, read to check a revision against its repository; None when the
    registry has no such request (it refuses the payload itself)."""
    done = listing(cfg)
    if done.unreachable:
        cli.say(f"EXECUTION UNREACHABLE {cfg.anchor}: cannot read request {request}'s record to check its revision")
        raise cli.Exit(4)
    records = records_of(done.out) if done.rc == 0 else None
    if records is None:
        cli.emit(substitution(done.out))
        cli.say("EXECUTION REFUSED: the anchor's registry could not be read")
        raise cli.Exit(1)
    return record_of(records, request)


def checked_evidence(cfg: Config, text: str, observed_from: str, action: str) -> str:
    """A dispatch, record, reconcile or conclude payload whose ``observed_sha`` -- named, read off
    ``observed_from`` (conclude only), or inherited from the record by a conclusion naming none --
    is a commit of the request's repository on GitHub. A payload the registry will refuse on shape
    anyway (not an object, no request_id, a SHA of the wrong shape) passes unread, and so does one
    for a concluded record, whose retry is the registry's to judge."""
    try:
        decoded: Any = json.loads(text)
    except ValueError:
        decoded = None
    if not isinstance(decoded, dict):
        if observed_from:
            cli.say("EXECUTION REFUSED: --observed-from needs a JSON object payload")
            raise cli.Exit(1)
        return text
    data = cast(dict[str, Any], decoded)
    sha, request = data.get("observed_sha"), data.get("request_id")
    shaped = isinstance(sha, str) and revision.OBJECT_ID.fullmatch(sha) is not None
    # A conclusion naming no observed_sha inherits the record's (registry.py), which a record
    # written before this check existed may hold mistyped: it becomes immutable here.
    inherits = action == "conclude" and "observed_sha" not in data and data.get("verdict") != "not-launched"
    if not (isinstance(request, str) and request and (shaped or observed_from or inherits)):
        return text
    record = record_to_check(cfg, request)
    if record is None:
        return text
    checking = record.get("state") != "concluded"
    repo = jq_text(field(record, "request", "repository"))
    if observed_from:
        host = jq_text(field(record, "request", "execution_host"))
        head = observed_sha_of(cfg, record, host, observed_from)
        if isinstance(head, Refusal):
            concluded(head)
            return text
        if "observed_sha" in data and sha != head:
            cli.say(
                f"EXECUTION REFUSED: the payload's observed_sha {jq_text(sha)} is not HEAD {head} of"
                f" {observed_from} on {host}; drop it and let --observed-from record the checkout's"
            )
            raise cli.Exit(1)
        # Read off a checkout, the SHA has no typo, but the checkout may be another repository's.
        if checking:
            fail(revision.commit_refusal(repo, "observed_sha", head, gh_timeout(cfg)))
        data["observed_sha"] = head
        data.setdefault("remote_checkout", observed_from)
        if isinstance(data.get("evidence"), str) and data["evidence"].strip():
            data["evidence"] += f"; observed_sha read as HEAD of {observed_from} on {host}"
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    if checking and shaped:
        fail(revision.commit_refusal(repo, "observed_sha", cast(str, sha), gh_timeout(cfg)))
    inherited = record.get("observed_sha")
    if checking and inherits and isinstance(inherited, str) and inherited:
        fail(revision.commit_refusal(repo, "inherited observed_sha", inherited, gh_timeout(cfg)))
    return text


def conclude_payload(cfg: Config, args: list[str]) -> str:
    """``conclude <json-file> [--observed-from <checkout>]``."""
    values = flag_values(args[2:], ("--observed-from",), CONCLUDE_USAGE)
    payload = read_payload("conclude", args[:2])
    observed_from = values.get("--observed-from", "")
    if observed_from:
        checkout_arg(observed_from, "")
    check_identity(cfg)
    return checked_evidence(cfg, payload, observed_from, "conclude")


def gh_timeout(cfg: Config) -> float:
    """FLEET_GH_TIMEOUT, the bound on each GitHub call (the preflight's knob, 30 s)."""
    value = knob(cfg, "FLEET_GH_TIMEOUT", "30")
    if not (value.isdigit() and int(value) > 0):
        die(f"FLEET_GH_TIMEOUT must be a positive whole number of seconds, not {value!r}")
    return int(value)


def checked_request(cfg: Config, payload: str, action: str) -> None:
    """A reserve, run or window request whose requested_revision names only commits that resolve.
    A payload that does not parse is left to the registry, which refuses it."""
    try:
        decoded: Any = json.loads(payload)
    except ValueError:
        return
    if action == "window":
        decoded = cast(dict[str, Any], decoded).get("request") if isinstance(decoded, dict) else None
    fail(revision.request_refusal(decoded, gh_timeout(cfg), lambda request: held(cfg, request, action)))


def with_resolution(cfg: Config, payload: str, action: str) -> tuple[str, str]:
    """A dispatch step (``run``, ``window``, ``dispatch``) of a request that follows a branch
    (``head-of:<branch>``, ludics-lite#558): the payload with the commit the branch names on GitHub
    NOW as ``resolved_revision``, and the line saying so once the registry has accepted it. Any other
    payload is returned as it is, with no line; so is a retry the registry's own rule answers (an id
    it holds that this action cannot newly dispatch), which is never resolved again. A payload that
    does not parse is the registry's to refuse."""
    try:
        decoded: Any = json.loads(payload)
    except ValueError:
        return payload, ""
    if not isinstance(decoded, dict):
        return payload, ""
    data = cast(dict[str, Any], decoded)
    if action == "dispatch":
        request_id = data.get("request_id")
        if not (isinstance(request_id, str) and request_id):
            return payload, ""
        record = record_to_check(cfg, request_id)
        if record is None or record.get("state") != "reserved":
            return payload, ""
        request: Any = record.get("request")
        target = data
    else:
        request = data.get("request") if action == "window" else data
        if not isinstance(request, dict):
            return payload, ""
        target = cast(dict[str, Any], request)
        request_id = target.get("request_id")
    branch = revision.head_of(request)
    if branch is None:
        return payload, ""
    if action != "dispatch" and isinstance(request_id, str) and request_id and held(cfg, request_id, action):
        return payload, ""
    repo = jq_text(cast(dict[str, Any], request).get("repository"))
    sha = revision.branch_head(repo, branch, gh_timeout(cfg))
    if not isinstance(sha, str):
        fail(sha)
        return payload, ""
    target["resolved_revision"] = sha
    line = f"EXECUTION RESOLVED {jq_text(request_id)}: head-of:{branch} is {sha} in {repo}, read at assignment"
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False), line


def held(cfg: Config, request: str, action: str) -> bool:
    """Whether the registry's own retry rule answers this request id: it holds the id, and the
    action cannot newly dispatch it -- `run` dispatches a record still reserved (one taken before
    this check existed, say), so that one is checked."""
    record = record_to_check(cfg, request)
    return record is not None and not (action == "run" and record.get("state") == "reserved")


def from_run_payload(cfg: Config, args: list[str]) -> str:
    run_dir = run_dir_arg(args, "--from-run", "the execution box")
    values = flag_values(
        args[3:],
        ("--request", "--box", "--sha", "--evidence"),
        "execution conclude --from-run <run-dir> --request <id> [--box <box>] [--sha <sha>] [--evidence <text>]",
    )
    request, box, sha = values.get("--request", ""), values.get("--box", ""), values.get("--sha", "")
    if not request:
        die("execution conclude --from-run: --request <id> required")
    if not SHA40.fullmatch(sha):
        die(
            "execution conclude --from-run: --sha <full commit SHA> required (the worker's result line"
            " names it; a record's own head is cross-checked against it)"
        )
    check_identity(cfg)
    if not box:
        done = listing(cfg)
        records = records_of(done.out) if done.rc == 0 else None
        if records is None:
            cli.say(f"EXECUTION UNREACHABLE {cfg.anchor}: cannot resolve the request's execution host")
            raise cli.Exit(4)
        record = record_of(records, request)
        box = "" if record is None else jq_text(field(record, "request", "execution_host"))
        if not box:
            cli.say(f"EXECUTION REFUSED: unknown request_id {request} (no execution host to read the run on)")
            raise cli.Exit(1)
    else:
        record = record_to_check(cfg, request)
    # The run's checkout must contain --sha (the far side's cat-file), but a box can hold several
    # repositories' runs: the SHA must also be a commit of the request's repository.
    if record is not None and record.get("state") != "concluded":
        fail(revision.commit_refusal(jq_text(field(record, "request", "repository")), "--sha", sha, gh_timeout(cfg)))
    return concluded(conclude_from_run(cfg, run_dir, request, box, sha, values.get("--evidence", "")))


def from_bg_run_payload(cfg: Config, args: list[str]) -> str:
    usage = (
        "execution conclude --from-bg-run <run-dir> --request <id> --sha <sha>|--observed-from <checkout>"
        " [--box <box>] [--checkout <text>] [--evidence <text>]"
    )
    run_dir = run_dir_arg(args, "--from-bg-run", "the box that holds it")
    values = flag_values(
        args[3:], ("--request", "--box", "--sha", "--evidence", "--checkout", "--observed-from"), usage
    )
    request, sha = values.get("--request", ""), values.get("--sha", "")
    observed_from = values.get("--observed-from", "")
    if not request:
        die("execution conclude --from-bg-run: --request <id> required")
    if observed_from:
        checkout_arg(observed_from, " --from-bg-run")
    if not (SHA40.fullmatch(sha) or (observed_from and not sha)):
        die(
            "execution conclude --from-bg-run: --sha <full commit SHA> required, or --observed-from <checkout>"
            " (a bg-run directory records none; the worker's result line names it)"
        )
    bgrun = os.path.join(cfg.here, "bg-run.sh")
    if not (_nonempty(bgrun) and os.access(bgrun, os.R_OK)):
        die(f"execution conclude --from-bg-run: missing {bgrun}")
    check_identity(cfg)
    done = listing(cfg)
    if done.unreachable:
        cli.say(f"EXECUTION UNREACHABLE {cfg.anchor}: cannot resolve the request's execution host")
        raise cli.Exit(4)
    if done.rc != 0:
        cli.say(substitution(done.out))
        cli.say("EXECUTION REFUSED: the anchor's registry could not be read")
        raise cli.Exit(1)
    record = record_of(records_of(done.out) or [], request)
    host = "" if record is None else jq_text(field(record, "request", "execution_host"))
    if not host or record is None:
        cli.say(f"EXECUTION REFUSED: unknown request_id {request} (no execution host to read the run for)")
        raise cli.Exit(1)
    # The revision: read off the checkout on the execution host, where the run ran, or the one
    # named; either must be a commit of the request's repository (ludics-lite#561).
    source, what = REPORTED, "--sha"
    if observed_from:
        head = observed_sha_of(cfg, record, host, observed_from)
        if isinstance(head, Refusal):
            return concluded(head)
        if sha and sha != head:
            cli.say(f"EXECUTION REFUSED: --sha {sha} is not HEAD {head} of {observed_from} on {host}; give one of them")
            raise cli.Exit(1)
        sha, source, what = head, f"read as HEAD of {observed_from} on {host}", "observed_sha"
    if record.get("state") != "concluded":
        fail(revision.commit_refusal(jq_text(field(record, "request", "repository")), what, sha, gh_timeout(cfg)))
    # Without --checkout the record's own checkout is restated, or the placeholder when it has none
    # -- always spelled out in the payload, so a retry of a conclusion whose answer was lost
    # composes the same payload and meets the registry's identical-retry rule.
    checkout = values.get("--checkout", "") or observed_from
    if not checkout:
        recorded = record.get("remote_checkout")
        checkout = "" if recorded is None or recorded is False else jq_text(recorded)
    if not checkout:
        checkout = "not recorded (bg-run keeps no checkout; the log names what ran)"
    box = values.get("--box", "") or host
    return concluded(
        conclude_from_bg_run(
            cfg, run_dir, request, box, host, sha, checkout, values.get("--evidence", ""), bgrun, source
        )
    )


HANDBACK_USAGE = (
    "execution conclude --standing-handback --request <id> --observed-from <checkout> --evidence <text>"
    " [--from-run <run-dir>] [--verdict pass|fail|timeout|cancelled]"
)
PLAIN_FORMS = (
    "conclude --from-run <run-dir> --request <id> --sha <sha>, conclude --from-bg-run <run-dir> --request <id>"
    " --sha <sha>|--observed-from <checkout>, or conclude <json-file> [--observed-from <checkout>]"
)


def standing_handback_payload(cfg: Config, args: list[str]) -> str:
    """``conclude --standing-handback`` (ludics-lite#605 item 3): a standing reservation concluded at
    its worker's hand-back. A standing record is the ownership record of a worker's whole life, not
    a verdict source, so its last batch's record is evidence, with whatever makes it no evidence for
    one commit (``from_run_refusal``'s: a dirty tree, a launch head that is not observed_sha, the
    worktree gone) recorded rather than refused. observed_sha is read off --observed-from and checked
    on GitHub as any conclusion's is; it is not bound to requested_revision (#634 keeps standing
    records exempt). The verdict is the run record's with --from-run, else --verdict, never a default;
    both given must agree."""
    values = flag_values(
        args[2:], ("--request", "--observed-from", "--evidence", "--from-run", "--verdict"), HANDBACK_USAGE
    )
    request, observed_from = values.get("--request", ""), values.get("--observed-from", "")
    evidence, run_dir, verdict = values.get("--evidence", ""), values.get("--from-run", ""), values.get("--verdict", "")
    for name, value in (("--request <id>", request), ("--observed-from <checkout>", observed_from),
                        ("--evidence <text>", evidence)):  # fmt: skip
        if not value.strip():
            die(f"execution conclude --standing-handback: {name} required ({HANDBACK_USAGE})")
    checkout_arg(observed_from, " --standing-handback")
    if run_dir and not run_dir.startswith("/"):
        die("execution conclude --standing-handback: --from-run <run-dir> must be absolute (it is read on the execution host)")
    if verdict and verdict not in HANDBACK_VERDICTS:
        die(f"execution conclude --standing-handback: --verdict must be one of {'|'.join(HANDBACK_VERDICTS)}, not {verdict!r}")
    if not (run_dir or verdict):
        die(
            "execution conclude --standing-handback: --verdict pass|fail|timeout|cancelled required without"
            " --from-run (the worker's hand-back says which; there is no default)"
        )
    check_identity(cfg)
    record = record_to_check(cfg, request)
    if record is None:
        cli.say(f"EXECUTION REFUSED: unknown request_id {request}; nothing concluded")
        raise cli.Exit(1)
    if field(record, "request", "standing") is not True:
        cli.say(
            f"EXECUTION REFUSED: {request} is not a standing reservation (its request has no \"standing\": true),"
            f" so a hand-back does not conclude it; use {PLAIN_FORMS}; nothing concluded"
        )
        raise cli.Exit(1)
    host = jq_text(field(record, "request", "execution_host"))
    head = observed_sha_of(cfg, record, host, observed_from)
    if isinstance(head, Refusal):
        return concluded(head)
    if record.get("state") != "concluded":
        fail(revision.commit_refusal(jq_text(field(record, "request", "repository")), "observed_sha", head, gh_timeout(cfg)))
    again = recorded_handback(record, request, observed_from, host, evidence, run_dir, verdict)
    if again is not None:
        return again
    run: tuple[str, str] | None = None
    if run_dir:
        facts = read_run(cfg, host, run_dir, head, observed_from)
        if isinstance(facts, Refusal):
            return concluded(facts)
        read = standing_run_clause(facts, run_dir, host)
        if isinstance(read, Refusal):
            return concluded(read)
        if verdict and verdict != read[0]:
            cli.say(
                f"EXECUTION REFUSED: --verdict {verdict}, but {run_dir} reads {read[0]} ({read[1]});"
                " give one of them; nothing concluded"
            )
            raise cli.Exit(1)
        verdict, run = read[0], (run_dir, read[1])
    return standing_handback(request, host, observed_from, head, evidence, verdict, run)


def concluded(conclusion: Conclusion) -> str:
    match conclusion:
        case Payload():
            return conclusion.json
        case Refusal():
            cli.say(conclusion.text)
            raise cli.Exit(conclusion.rc)
        case _:
            assert_never(conclusion)


def _nonempty(path: str) -> bool:
    try:
        return os.path.getsize(path) > 0
    except OSError:
        return False


WINDOW_USAGE = "execution window [--no-gap] <box> <measurement reserve.json>"
WINDOW_GAP = 60  # FLEET_WINDOW_GAP's default, in seconds (ludics-lite#667)


def window_gap(cfg: Config, args: list[str]) -> tuple[list[str], int]:
    """THE GAP (ludics-lite#667, the registry's header): the window's words without ``--no-gap``,
    which may only come right after ``window``, and the gap the payload asks for -- 0 with
    ``--no-gap``, else FLEET_WINDOW_GAP (a whole number of seconds; 60 when unset or empty)."""
    if len(args) > 1 and args[1] == "--no-gap":
        return [args[0], *args[2:]], 0
    text = knob(cfg, "FLEET_WINDOW_GAP", str(WINDOW_GAP))
    if not re.fullmatch(r"[0-9]+", text):
        die(f"execution window: FLEET_WINDOW_GAP must be a whole number of seconds, not {text!r}")
    return args, int(text)


def gap_wait(done: Done) -> int | None:
    """The seconds the registry's gap answer (exit 3, ``{"gap": {..., "wait": <n>}}``) says to wait,
    or None for any other outcome, which is said and returned as it stands."""
    if done.rc != 3 or done.unreachable:
        return None
    try:
        decoded: Any = json.loads(done.out)
    except ValueError:
        return None
    wait = field(cast(dict[str, Any], decoded), "gap", "wait") if isinstance(decoded, dict) else None
    return wait if type(wait) is int and wait > 0 else None


def window_payload(args: list[str], gap: int = 0) -> str:
    return with_gap(window_lines(args), gap)


def with_gap(lines: list[dict[str, Any]], gap: int) -> str:
    """The registry's payload: one JSON line per wrapped value, each carrying ``gap`` when it is not 0."""
    return "\n".join(json.dumps({**line, "gap": gap} if gap else line, separators=(",", ":"), ensure_ascii=False)
                     for line in lines)


def window_lines(args: list[str]) -> list[dict[str, Any]]:
    if len(args) != 3 or not args[1] or not os.access(args[2], os.R_OK):
        die(f"{WINDOW_USAGE}: a box and a readable JSON file required")
    try:
        with open(args[2], encoding="utf-8", errors="surrogateescape") as f:
            text = f.read()
    except OSError:
        die(f"execution window: {args[2]} is not a JSON reservation")
    # jq's reading: a stream of JSON values, one wrapped line each. No value prints nothing, and
    # several print several lines; the registry refuses either payload (exit 1). Only text that
    # does not parse is the usage refusal (exit 2).
    decoder = json.JSONDecoder()
    lines: list[dict[str, Any]] = []
    position = 0
    while True:
        while position < len(text) and text[position] in " \t\n\r":  # JSON's whitespace
            position += 1
        if position == len(text):
            break
        try:
            request, position = decoder.raw_decode(text, position)
        except ValueError:
            die(f"execution window: {args[2]} is not a JSON reservation")
        lines.append({"box": args[1], "request": request})
    return lines


def cmd_execution(cfg: Config, args: list[str]) -> int:
    action = args[0] if args else ""
    payload = "{}"
    resolution = ""
    gap = 0  # a window's gap, and its wrapped requests (THE GAP below)
    requests: list[dict[str, Any]] = []
    match action:
        case "list":
            options: dict[str, bool | str] = {"active": False, "compact": False}
            rest = args[1:]
            while rest:
                arg, rest = rest[0], rest[1:]
                if arg == "--active":
                    options["active"] = True
                elif arg == "--compact":
                    options["compact"] = True
                elif arg == "--host":
                    # One box's records (ludics-lite#557), an alias selecting its roster entry's:
                    # the registry reads what is one box off the endpoint map passed below.
                    if not rest or not rest[0]:
                        die("execution list: expected a box for --host")
                    options["host"], rest = rest[0], rest[1:]
                else:
                    die(LIST_USAGE)
            payload = json.dumps(options, separators=(",", ":"))
        case "slot":
            from ludics.fleetworker import slot

            return slot.cmd_slot(cfg, args[1:])
        case "hold":
            from ludics.fleetworker import slot

            return slot.cmd_hold(cfg, args[1:])
        case "tip-run":
            # A loop run reserved, prepared and started in one call (ludics-lite#615): the
            # registry steps are this verb's own, invoked as fleet-worker.sh invokes them.
            from ludics.fleetworker import tiprun

            return tiprun.cmd_tip_run(cfg, args[1:])
        case "leg":
            from ludics.fleetworker import leg

            return leg.cmd_leg(cfg, args[1:])
        case "conclude":
            mode = args[1] if len(args) > 1 else ""
            if mode == "--from-run":
                payload = from_run_payload(cfg, args)
            elif mode == "--from-bg-run":
                payload = from_bg_run_payload(cfg, args)
            elif mode == "--standing-handback":
                payload = standing_handback_payload(cfg, args)
            else:
                payload = conclude_payload(cfg, args)
            payload = with_gpu_record(cfg, payload)
        case "reserve" | "run" | "dispatch" | "record" | "reconcile":
            payload = read_payload(action, args)
            check_identity(cfg)
            if action in ("dispatch", "record", "reconcile"):
                payload = checked_evidence(cfg, payload, "", action)
            else:
                checked_request(cfg, payload, action)
            if action in ("run", "dispatch"):
                payload, resolution = with_resolution(cfg, payload, action)
        case "window":
            # THE MEASUREMENT WINDOW (ludics-lite#481): the box is named apart from the payload so
            # the call says which box's standing reservations it suspends, and the registry refuses
            # a payload measuring on any other. THE GAP (ludics-lite#667): see the loop below.
            args, gap = window_gap(cfg, args)
            requests = window_lines(args)
            payload = with_gap(requests, gap)
            check_identity(cfg)
            checked_request(cfg, payload, action)
            payload, resolution = with_resolution(cfg, payload, action)
        case _:
            die(USAGE)
    source = registry_source()
    map_spec = ""
    if action in ("reserve", "run", "dispatch", "window") or (action == "list" and "--host" in args):
        found = endpoint_map(cfg)
        if found is None:
            return 1
        map_spec = found
    token = my_token(cfg)
    script = (
        prelude(cfg, cfg.anchor)
        + (LEASE_MUTATION if action != "list" else "shift 3\n")
        + registry_command(source, payload)
    )
    argv = [
        "EXECUTION", token, cfg.lock_wait, action, coordinator_id(cfg), token, PAYLOAD_ON_FD,
        cfg.boxes, cfg.slots, map_spec, fleet_name(cfg, cfg.anchor), fleet_name(cfg, cfg.lab_host),
    ]  # fmt: skip
    done = run_on(cfg, cfg.anchor, script, argv, capture=True)
    left = gap
    while action == "window" and left > 0 and (wait := gap_wait(done)) is not None:
        # THE GAP (ludics-lite#667): the registry wrote nothing and said why on stderr. Waited here,
        # no lock held, then asked again with the gap less what was waited, so the whole wait is
        # the gap at most and a gap of 0 is never answered with another -- a head-of request
        # resolved afresh, as at any dispatch.
        wait = min(wait, left)
        err(f"EXECUTION WINDOW {args[1]}: waiting {wait}s, then opening the window (FLEET_WINDOW_GAP={gap};"
            " --no-gap opens it at once)")
        time.sleep(wait)
        left -= wait
        payload, resolution = with_resolution(cfg, with_gap(requests, left), action)
        argv[6] = payload
        done = run_on(cfg, cfg.anchor, script, argv, capture=True)
    out = substitution(done.out)
    cli.emit(out)
    if done.unreachable:
        cli.say(f"EXECUTION UNREACHABLE {cfg.anchor}: outcome unknown; reconcile before retrying dispatch")
        return 4
    if done.rc == 0 and resolution:
        err(resolution)
    if done.rc == 0 and action in ("run", "dispatch", "window"):
        execution_refresh(cfg, out)
    return done.rc

